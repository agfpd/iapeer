// enable — per-peer capability install (contract Установка §3 + Per-рантайм
// install-асимметрия; verb `enable <capability> [peer]`). The init→enable
// capability story: a peer gains a capability FROM our marketplace. iapeer
// ORCHESTRATES — install + enable + call `setup` ONLY if the plugin declares it
// — and deliberately does NOT resolve the plugin's dep-graph (`requires`/`setup`
// internals are the plugin's job, → Стандарт iapeer плагина).
//
// Per-рантайм install-асимметрия (contract table):
//   claude → `plugin install <p>@agfpd --scope project` run IN the peer's cwd; the
//            project-scope entry is keyed by projectPath, so it is ISOLATED per peer
//            (a test-peer install never touches a live peer's entry). enable = that
//            install (project-scope is the cold-start MCP enabler) + plugin enable.
//   codex  → `plugin add <p>@agfpd` GLOBAL (host-wide, once); enable is per-peer via
//            config. codex has no project scope (a global mutation), so it is NOT run
//            against the real host under fleet-guard without an isolated CODEX_HOME.
//
// SIMPLE vs СЛОЖНЫЙ plugin (contract): a plugin MAY ship `iapeer.json` at its root
// declaring `setup` (a multi-step installer) and `requires`. SIMPLE (no
// iapeer.json/no setup): install + enable → works. СЛОЖНЫЙ (a multi-step
// capability plugin): install + enable → call `setup`. iapeer reads the manifest
// and calls setup ONLY if declared.

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { MARKETPLACE_NAME, isMarketplaceRegisteredAs, refreshMarketplace, registerMarketplace } from '../onboard/index.ts'
import { findPeer, readPeersIndex } from '../registry/index.ts'
import { IapError } from '../core/errors.ts'
import { normalizeNameCandidate } from '../core/normalize.ts'

export type CapabilityRuntime = 'claude' | 'codex'

// ─────────────────────────────────────────────────────────────────────────────
// Installed-plugins parse + per-peer match (PURE — the fleet-guard hinges on it)
// ─────────────────────────────────────────────────────────────────────────────

/** One entry of `claude plugin list --json`. Project-scope entries carry projectPath
 *  (the per-peer key); user/local scope do not. */
export interface InstalledEntry {
  id: string // `<plugin>@<marketplace>`
  scope: string // 'project' | 'user' | 'local'
  enabled: boolean
  projectPath?: string
  installPath?: string
}

/** Parse `claude plugin list --json` (a flat array) into typed entries; tolerant of
 *  unknown extra fields and non-array payloads (→ []). */
export function parseInstalledPlugins(json: string): InstalledEntry[] {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  return data.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return []
    const o = raw as Record<string, unknown>
    if (typeof o.id !== 'string') return []
    return [
      {
        id: o.id,
        scope: typeof o.scope === 'string' ? o.scope : 'unknown',
        enabled: o.enabled === true,
        projectPath: typeof o.projectPath === 'string' ? o.projectPath : undefined,
        installPath: typeof o.installPath === 'string' ? o.installPath : undefined,
      },
    ]
  })
}

/** realpath-normalize a path for comparison (/tmp→/private/tmp on macOS); falls back
 *  to the raw path when it does not resolve. Mirrors the legacy install-gate match. */
function canonPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Find the project-scope entry for `<plugin>@agfpd` installed for THIS peer cwd
 * (realpath-matched projectPath). Returns the entry (so the caller sees enabled +
 * installPath) or null. This is what makes enable idempotent AND fleet-safe: it keys
 * on the peer's OWN projectPath, never another peer's.
 */
export function findPeerScopedEntry(
  entries: InstalledEntry[],
  plugin: string,
  marketplace: string,
  peerCwd: string,
): InstalledEntry | null {
  const id = `${plugin}@${marketplace}`
  const want = canonPath(peerCwd)
  return (
    entries.find(
      e => e.id === id && e.scope === 'project' && e.projectPath !== undefined && canonPath(e.projectPath) === want,
    ) ?? null
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest — setup detection (PURE)
// ─────────────────────────────────────────────────────────────────────────────

/** The optional `setup` descriptor in a plugin's `iapeer.json`: a bare command/script
 *  string (resolved relative to the plugin root), or {command,args}. */
export type SetupDescriptor = string | { command: string; args?: string[] }
export interface IapeerManifest {
  setup?: SetupDescriptor
  requires?: unknown
}

/**
 * Read `<installPath>/iapeer.json` and return its `setup` descriptor, or null when
 * the plugin is SIMPLE (no manifest, no `setup`). A malformed manifest is treated as
 * SIMPLE (no setup) rather than failing enable — the manifest is the plugin's contract,
 * not iapeer's; install+enable already succeeded.
 */
export function readSetupDescriptor(installPath: string | undefined): SetupDescriptor | null {
  if (!installPath) return null
  const manifestPath = join(installPath, 'iapeer.json')
  if (!existsSync(manifestPath)) return null
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as IapeerManifest
    if (typeof m.setup === 'string' && m.setup.trim()) return m.setup
    if (m.setup && typeof m.setup === 'object' && typeof m.setup.command === 'string' && m.setup.command.trim()) {
      return { command: m.setup.command, args: Array.isArray(m.setup.args) ? m.setup.args.map(String) : undefined }
    }
    return null
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

export type RuntimeEnableState =
  | 'already-enabled' // present + enabled for this peer → no-op (idempotent, fleet-safe)
  | 'installed' // installed (and enabled) now
  | 'enabled' // was installed-but-disabled → enabled now
  | 'runtime-missing' // the runtime binary is not on the host
  | 'failed' // install/enable command failed

export type SetupState = 'absent' | 'called' | 'failed' | 'skipped'

export interface RuntimeEnableResult {
  runtime: CapabilityRuntime
  state: RuntimeEnableState
  installPath?: string
  detail?: string
}

export interface EnableResult {
  plugin: string
  personality: string
  cwd: string
  runtimes: RuntimeEnableResult[]
  setup: SetupState
  setupDetail?: string
}

export interface EnableOptions {
  plugin: string
  /** Target peer by personality; default = the peer of the current cwd. */
  peer?: string
  /** Restrict to these runtimes (default: the peer's agentic runtimes). */
  runtimes?: CapabilityRuntime[]
  /** Skip the plugin's `setup` even if declared (install+enable only). */
  noSetup?: boolean
  env?: NodeJS.ProcessEnv
  cwd?: string
}

function claudeBin(env: NodeJS.ProcessEnv): string {
  return env.IAPEER_CLAUDE_BIN?.trim() || join(env.HOME?.trim() || homedir(), '.local', 'bin', 'claude')
}
function codexBin(env: NodeJS.ProcessEnv): string {
  return env.IAPEER_CODEX_BIN?.trim() || 'codex'
}

/** Resolve the target peer (cwd + agentic runtimes) from a personality arg or the cwd.
 *  Without an explicit peer, match the registry by THIS cwd first (robust to a
 *  uniqueness-suffixed personality), falling back to normalize(basename(cwd)). */
function resolvePeer(opts: EnableOptions): { personality: string; cwd: string; runtimes: CapabilityRuntime[] } {
  const env = opts.env ?? process.env
  const index = readPeersIndex({ env })
  const cwd = opts.cwd ?? process.cwd()
  let rec = opts.peer
    ? findPeer(index, opts.peer)
    : index.peers.find(p => canonPath(p.cwd) === canonPath(cwd)) ?? findPeer(index, normalizeNameCandidate(basename(cwd)))
  const personality = opts.peer ?? rec?.personality ?? normalizeNameCandidate(basename(cwd))
  if (!rec) {
    throw new IapError(`peer "${personality}" is not registered — run \`iapeer init\` in its folder first`)
  }
  const agentic = rec.runtimes.filter((r): r is CapabilityRuntime => r === 'claude' || r === 'codex')
  if (agentic.length === 0) {
    throw new IapError(`peer "${personality}" has no agentic runtime (claude/codex) — capability plugins need one`)
  }
  return { personality, cwd: rec.cwd, runtimes: agentic }
}

function isExecutable(bin: string, env: NodeJS.ProcessEnv): boolean {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore', env: env as Record<string, string> })
  return r.error === undefined && r.status !== null
}

/** Read the peer-scoped entry for this plugin from a fresh `claude plugin list --json`.
 *  CRITICAL: `enabled` is evaluated relative to the CURRENT cwd's project (verified
 *  live — the same entry lists enabled=false from another dir, true from its own), so
 *  the list MUST run with cwd = the peer cwd to read the authoritative enabled-state.
 *  maxBuffer is raised — a configured host's plugin list exceeds the 1 MB default. */
function claudeEntry(
  bin: string,
  plugin: string,
  marketplace: string,
  peerCwd: string,
  env: NodeJS.ProcessEnv,
): InstalledEntry | null {
  const list = spawnSync(bin, ['plugin', 'list', '--json'], {
    cwd: peerCwd,
    encoding: 'utf8',
    env: env as Record<string, string>,
    maxBuffer: 64 * 1024 * 1024,
  })
  return findPeerScopedEntry(parseInstalledPlugins(list.stdout ?? ''), plugin, marketplace, peerCwd)
}

/**
 * claude: install `<plugin>@agfpd` project-scope IN the peer cwd. A project-scope
 * install also ENABLES it for that project (verified live: enabled=true when listed
 * from the peer cwd). The explicit `plugin enable` runs ONLY for a pre-existing entry
 * that lists disabled — never right after a fresh install (that errors "already
 * enabled"). Idempotent + fleet-safe: the entry is keyed by THIS peer's projectPath
 * (realpath), so it never reads or mutates another peer's install.
 */
function enableClaude(plugin: string, marketplace: string, peerCwd: string, env: NodeJS.ProcessEnv): RuntimeEnableResult {
  const bin = claudeBin(env)
  if (!isExecutable(bin, env)) return { runtime: 'claude', state: 'runtime-missing' }
  const id = `${plugin}@${marketplace}`
  const existing = claudeEntry(bin, plugin, marketplace, peerCwd, env)
  if (existing?.enabled) return { runtime: 'claude', state: 'already-enabled', installPath: existing.installPath }

  if (!existing) {
    const inst = spawnSync(bin, ['plugin', 'install', id, '--scope', 'project'], {
      cwd: peerCwd,
      encoding: 'utf8',
      env: env as Record<string, string>,
    })
    if (inst.status !== 0) {
      return { runtime: 'claude', state: 'failed', detail: (inst.stderr || inst.stdout || `exit ${inst.status}`).trim() }
    }
  }
  // the entry now exists but is DISABLED (fresh install) or was pre-existing-disabled →
  // enable it (and ONLY then; an already-enabled entry would error).
  const after = claudeEntry(bin, plugin, marketplace, peerCwd, env)
  if (after && !after.enabled) {
    const en = spawnSync(bin, ['plugin', 'enable', id, '--scope', 'project'], {
      cwd: peerCwd,
      encoding: 'utf8',
      env: env as Record<string, string>,
    })
    const confirmed = claudeEntry(bin, plugin, marketplace, peerCwd, env)
    if (!confirmed?.enabled) {
      return { runtime: 'claude', state: 'failed', detail: (en.stderr || en.stdout || `exit ${en.status}`).trim() }
    }
    return { runtime: 'claude', state: existing ? 'enabled' : 'installed', installPath: confirmed.installPath }
  }
  if (!after) return { runtime: 'claude', state: 'failed', detail: 'install reported success but no project-scope entry appeared' }
  return { runtime: 'claude', state: existing ? 'enabled' : 'installed', installPath: after.installPath }
}

/** Parse `codex plugin list --json` for one plugin id's status. Shape (codex-cli
 *  0.138, live-verified): `{ installed: [{ pluginId, installed, enabled }, …] }`.
 *  A plugin absent from the array OR with `installed:false` → 'absent'; `enabled:true`
 *  → 'enabled'; installed-but-not-enabled → 'disabled'. Replaces the prior whitespace-
 *  table parse (brittle to column re-alignment / status-string wording) — the codex
 *  counterpart of the claude path's `parseInstalledPlugins`. Malformed/empty input →
 *  'absent' (same fail-safe). PURE → unit-testable. */
export function parseCodexPluginStatus(jsonOutput: string, id: string): 'enabled' | 'disabled' | 'absent' {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonOutput)
  } catch {
    return 'absent'
  }
  const installed = (parsed as { installed?: unknown } | null)?.installed
  if (!Array.isArray(installed)) return 'absent'
  const entry = installed.find(
    (e): e is { pluginId: string; installed?: boolean; enabled?: boolean } =>
      !!e && typeof e === 'object' && (e as { pluginId?: unknown }).pluginId === id,
  )
  if (!entry || entry.installed === false) return 'absent'
  return entry.enabled === true ? 'enabled' : 'disabled'
}

function codexState(bin: string, id: string, env: NodeJS.ProcessEnv): 'enabled' | 'disabled' | 'absent' {
  const r = spawnSync(bin, ['plugin', 'list', '--json'], { encoding: 'utf8', env: env as Record<string, string>, maxBuffer: 64 * 1024 * 1024 })
  return parseCodexPluginStatus(r.stdout ?? '', id)
}

/** codex: add `<plugin>@agfpd` GLOBAL (host-wide; codex has no project scope). The add
 *  ENABLES (verified live: config.toml `[plugins."<id>"] enabled = true`) and is
 *  idempotent (re-add exits 0). Idempotency: skip when already enabled. installPath is
 *  parsed from the add output so setup-detection works for a codex-only peer. */
function enableCodex(plugin: string, marketplace: string, env: NodeJS.ProcessEnv): RuntimeEnableResult {
  const bin = codexBin(env)
  if (!isExecutable(bin, env)) return { runtime: 'codex', state: 'runtime-missing' }
  const id = `${plugin}@${marketplace}`
  const before = codexState(bin, id, env)
  if (before === 'enabled') return { runtime: 'codex', state: 'already-enabled' }
  const add = spawnSync(bin, ['plugin', 'add', id], { encoding: 'utf8', env: env as Record<string, string> })
  if (add.status !== 0) {
    return { runtime: 'codex', state: 'failed', detail: (add.stderr || add.stdout || `exit ${add.status}`).trim() }
  }
  if (codexState(bin, id, env) !== 'enabled') {
    return { runtime: 'codex', state: 'failed', detail: (add.stdout || 'plugin add did not enable the plugin').trim() }
  }
  const m = /Installed plugin root:\s*(\S.*)/.exec(add.stdout ?? '')
  return { runtime: 'codex', state: before === 'disabled' ? 'enabled' : 'installed', installPath: m?.[1]?.trim() }
}

/** Invoke the plugin's `setup` (СЛОЖНЫЙ class), cwd = plugin root, peer context in env
 *  (namespaced IAPEER_PEER_* — NOT the bare PEER_PERSONALITY the identity-gate keys on).
 *  Best-effort: a setup failure is reported, it does NOT unwind the completed install. */
function callSetup(
  setup: SetupDescriptor,
  installPath: string,
  peer: { personality: string; cwd: string },
  env: NodeJS.ProcessEnv,
): { ok: boolean; detail?: string } {
  const [command, ...preArgs] = typeof setup === 'string' ? [setup] : [setup.command, ...(setup.args ?? [])]
  const setupEnv: NodeJS.ProcessEnv = {
    ...env,
    IAPEER_PEER_PERSONALITY: peer.personality,
    IAPEER_PEER_CWD: peer.cwd,
  }
  // a bare string resolved relative to the plugin root when it points at a file there
  const resolved = typeof setup === 'string' && existsSync(join(installPath, command)) ? join(installPath, command) : command
  const r = spawnSync(resolved, preArgs, {
    cwd: installPath,
    encoding: 'utf8',
    env: setupEnv as Record<string, string>,
  })
  if (r.error || (r.status ?? 1) !== 0) {
    return { ok: false, detail: (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim() }
  }
  return { ok: true }
}

/** Registry-free enable input — the cwd-level core (контракт §Плагин провайдера:
 *  birth-time hook runs BEFORE the registry upsert, so it cannot resolve a peer). */
export interface CwdEnableOptions {
  plugin: string
  /** Marketplace NAME the plugin id keys on (default: agfpd). */
  marketplace?: string
  /** Source ref: when given, the path ENSURES the marketplace is registered for the
   *  runtime (add on missing) before installing — the third-party-provider path. */
  marketplaceRef?: string
  cwd: string
  personality: string
  runtimes: CapabilityRuntime[]
  noSetup?: boolean
  env?: NodeJS.ProcessEnv
}

/** One install attempt for one runtime, WITH the stale-snapshot resilience the
 *  contract requires: a failed attempt refreshes the runtime's local marketplace
 *  snapshot (claude `marketplace update` / codex `marketplace upgrade`) and
 *  retries ONCE — a plugin registered in the marketplace after the host's last
 *  pull reads as «unknown plugin» until then. */
function enableRuntimeWithRetry(
  rt: CapabilityRuntime,
  plugin: string,
  marketplace: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): RuntimeEnableResult {
  const attempt = (): RuntimeEnableResult =>
    rt === 'claude' ? enableClaude(plugin, marketplace, cwd, env) : enableCodex(plugin, marketplace, env)
  const first = attempt()
  if (first.state !== 'failed') return first
  const refresh = refreshMarketplace(rt, marketplace, env)
  if (!refresh.ok) {
    return { ...first, detail: `${first.detail ?? 'failed'}; marketplace refresh also failed: ${refresh.detail ?? ''}` }
  }
  const second = attempt()
  return second.state === 'failed'
    ? { ...second, detail: `${second.detail ?? 'failed'} (after marketplace refresh)` }
    : second
}

/**
 * The registry-FREE enable core: install per-runtime (claude project-scope IN cwd /
 * codex global) + enable + `setup` ONLY if declared — with marketplace ensure
 * (marketplaceRef given + not registered → add) and the stale-snapshot retry.
 * Consumer: enableCapability (the peer-resolved generic `iapeer enable` verb) —
 * ONE home of the install forms. (The provider birth-hook and verb consumers were
 * removed — the provider plugin form is retired, ADR-017.)
 */
export function enableCapabilityForCwd(o: CwdEnableOptions): EnableResult {
  const env = o.env ?? process.env
  const marketplace = o.marketplace ?? MARKETPLACE_NAME
  const results: RuntimeEnableResult[] = []
  for (const rt of o.runtimes) {
    // runtime-missing wins FIRST (before any marketplace work): a host without
    // the runtime binary is a clean skip, not a marketplace-add failure.
    if (!isExecutable(rt === 'claude' ? claudeBin(env) : codexBin(env), env)) {
      results.push({ runtime: rt, state: 'runtime-missing' })
      continue
    }
    // Marketplace ensure — only when the caller supplied a source ref (the slot's
    // marketplaceRef); the generic agfpd path is guaranteed by onboard already.
    if (o.marketplaceRef && !isMarketplaceRegisteredAs(rt, marketplace, o.marketplaceRef, env)) {
      const reg = registerMarketplace(rt, env, o.marketplaceRef)
      if (!reg.ok) {
        results.push({ runtime: rt, state: 'failed', detail: `marketplace add ${o.marketplaceRef} failed: ${reg.detail ?? ''}` })
        continue
      }
    }
    results.push(enableRuntimeWithRetry(rt, o.plugin, marketplace, o.cwd, env))
  }

  // setup: read the manifest from whichever runtime gave us an installPath (the source
  // is the same plugin regardless of runtime). Called ONLY if declared.
  const installPath = results.find(r => r.installPath)?.installPath
  let setupState: SetupState = 'absent'
  let setupDetail: string | undefined
  const setup = readSetupDescriptor(installPath)
  const anyOk = results.some(r => r.state === 'installed' || r.state === 'enabled' || r.state === 'already-enabled')
  if (setup && anyOk) {
    if (o.noSetup) {
      setupState = 'skipped'
    } else {
      const s = callSetup(setup, installPath as string, { personality: o.personality, cwd: o.cwd }, env)
      setupState = s.ok ? 'called' : 'failed'
      setupDetail = s.detail
    }
  }

  return {
    plugin: o.plugin,
    personality: o.personality,
    cwd: o.cwd,
    runtimes: results,
    setup: setupState,
    setupDetail,
  }
}

/**
 * Enable a capability plugin on a peer (contract Установка §3): install per-runtime
 * (claude project-scope / codex global) + enable + call `setup` ONLY if the plugin
 * declares it. Idempotent and fleet-safe — a peer already enabled is a no-op; the
 * claude path is keyed by the peer's projectPath so it never touches another peer.
 * Thin peer-resolving wrapper over enableCapabilityForCwd (the ONE forms home).
 */
export function enableCapability(opts: EnableOptions): EnableResult {
  const env = opts.env ?? process.env
  const peer = resolvePeer(opts)
  return enableCapabilityForCwd({
    plugin: opts.plugin,
    cwd: peer.cwd,
    personality: peer.personality,
    runtimes: opts.runtimes ?? peer.runtimes,
    noSetup: opts.noSetup,
    env,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Removal forms — REMOVED with the provider verb (their only caller; ADR-017
// retired the provider plugin form). Historical verb names, for a future generic
// `disable`: claude `plugin uninstall <id> --scope project` (run in the peer
// cwd), codex `plugin remove <id>` (host-global). See git history ≤v0.2.41 for
// the implementations.
// ─────────────────────────────────────────────────────────────────────────────
