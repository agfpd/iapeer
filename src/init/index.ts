// init — the per-peer onboarding verb (`iapeer init`, contract Примитивы §init +
// Установка §INIT). DETERMINISTIC, non-interactive. Builds on provisionPeer (identity
// + registry + infra plist) and adds the per-peer ECOSYSTEM wiring a peer needs to
// talk: the HTTP-MCP transport config + the local doctrine template.
//
// THE BIG SIMPLIFICATION (install-gate, proven live): a peer gets send_to_peer
// purely from a project-scope `.mcp.json` pointing at the host-wide HTTP-MCP daemon —
// NO plugin install, NO /reload-plugins, NO GC version-snapshots (the whole legacy
// persistent-peer install-gate class is gone). Verified: a cold-start claude session
// (--dangerously-skip-permissions, as the launch primitive runs it) auto-enables the
// `.mcp.json` http server and send_to_peer is callable on its FIRST turn, no approve.
//
// claude side here. codex side (`[mcp_servers.<name>]` in ~/.codex/config.toml +
// default_tools_approval_mode="approve") lands with its own live codex check.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { CODEX_BEARER_ENV_VAR, CODEX_DUMMY_BEARER, IAPEER_DIR, isInfraRuntime, type Runtime } from '../core/constants.ts'
import { IapError } from '../core/errors.ts'
import {
  ensureLocalIapScaffold,
  pluginStateDir,
  writeFileAtomic,
  type StorageOptions,
} from '../storage/index.ts'
import { provisionPeer, type ProvisionResult } from '../provision/index.ts'
import { launchctlBootstrap, launchdPlistPath, type BootstrapResult } from '../launch/launchd.ts'
import { runtimeSelfConfig, type SelfConfigResult } from '../runtime/index.ts'
import type { Intelligence } from '../core/constants.ts'

/** The MCP-server name the peer's `.mcp.json` uses for the foundation daemon. */
export const IAPEER_MCP_SERVER_NAME = 'iapeer'

/** Fallback HTTP-MCP daemon port when no router.json is published yet (the daemon
 *  binds this stable loopback port by default; init before daemon-start uses it). */
export const DEFAULT_DAEMON_MCP_PORT = 8765

const IAPEER_DOCTRINE_FILE = 'IAPEER.md'

// ─────────────────────────────────────────────────────────────────────────────
// Daemon URL resolution (router.json published by the daemon, else the default)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the daemon HTTP-MCP URL to write into a peer's `.mcp.json`. Primary: the
 * `tcp` field of the daemon's discovery file `~/.iapeer/state/iapeer/router.json`
 * (published live by the daemon). Fallback: the well-known default loopback URL —
 * so `iapeer init` works even before the daemon is started (the daemon binds the
 * same stable port; IAPEER_PORT overrides it at the daemon, not here).
 */
export function resolveDaemonMcpUrl(options: StorageOptions = {}): string {
  const routerJson = join(pluginStateDir('iapeer', options), 'router.json')
  try {
    const parsed = JSON.parse(readFileSync(routerJson, 'utf8')) as { tcp?: unknown }
    if (typeof parsed.tcp === 'string' && parsed.tcp) return parsed.tcp
  } catch {
    /* no router.json (daemon not started) → the well-known default below */
  }
  const env = options.env ?? process.env
  const port = env.IAPEER_PORT?.trim() || String(DEFAULT_DAEMON_MCP_PORT)
  return `http://127.0.0.1:${port}/mcp`
}

// ─────────────────────────────────────────────────────────────────────────────
// claude `.mcp.json` wiring (project-scope; auto-enables on cold-start)
// ─────────────────────────────────────────────────────────────────────────────

interface McpHttpServer {
  type: 'http'
  url: string
  headers: Record<string, string>
}

/**
 * Idempotently wire the foundation HTTP-MCP server into the peer's project-scope
 * `<cwd>/.mcp.json` (claude-specific). MERGE, not clobber: existing mcpServers are
 * preserved; only the `iapeer` entry is (re)written. The X-IAPeer-Identity header
 * carries `${PEER_IDENTITY:-claude-<personality>}`: claude expands it from the session
 * env PEER_IDENTITY (set by the launch — invocation.ts), so the caller identity follows
 * the SESSION, not the cwd file. This closes a cross-identity bug — a peer that `cd`s into
 * ANOTHER peer's project dir + reloads used to pick up THAT dir's `.mcp.json` identity
 * literal and assume its identity (the daemon trusts the header). With env-expansion the
 * value resolves from the reader's own session env regardless of which `.mcp.json` is read.
 * The `:-claude-<personality>` fallback keeps a manually-launched session (no PEER_IDENTITY
 * env) from failing config parse — it resolves to this peer's own literal, correct in its
 * OWN dir. The daemon resolves the caller per request from this header.
 * Returns the written path. Re-running init is a no-op-equivalent (same bytes).
 */
export function writeClaudeMcpConfig(cwd: string, personality: string, daemonUrl: string): string {
  const path = join(cwd, '.mcp.json')
  let doc: { mcpServers?: Record<string, unknown> } = {}
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed
    } catch {
      // Malformed existing .mcp.json. Starting fresh would SILENTLY discard the
      // operator's other mcpServers (audit #15/#22 — data loss). Back the original
      // up VERBATIM first so re-init never loses foreign config; then proceed.
      try {
        copyFileSync(path, `${path}.corrupt.bak`)
      } catch {
        /* best-effort backup */
      }
    }
  }
  const server: McpHttpServer = {
    type: 'http',
    url: daemonUrl,
    headers: { 'X-IAPeer-Identity': `\${PEER_IDENTITY:-claude-${personality}}` },
  }
  doc.mcpServers = { ...(doc.mcpServers ?? {}), [IAPEER_MCP_SERVER_NAME]: server }
  writeFileAtomic(path, `${JSON.stringify(doc, null, 2)}\n`, 0o644)
  return path
}

// ─────────────────────────────────────────────────────────────────────────────
// codex MCP config (~/.codex/config.toml — HOST-WIDE; the token-free recipe)
// ─────────────────────────────────────────────────────────────────────────────
//
// codex's CLI does NOT import tools from an OPEN streamable-HTTP MCP server — it marks
// it authStatus=unsupported (and BLOCKS on startup) unless an auth scheme is configured
// (codex bug #21532 / #4707). The token-free fix (PROVEN LIVE, codex 0.136; a real
// host-wide bearer was rejected as a localhost crutch): set a
// FIXED, NON-SECRET bearer (CODEX_DUMMY_BEARER). Setting `bearer_token_env_var` flips
// authStatus to `bearer_token` purely from the config FACT — codex does NOT require the
// server to validate the token. The daemon stays OPEN: it ignores `Authorization` and
// resolves the caller from the X-IAPeer-Identity header (the SAME loopback same-uid +
// per-peer-identity auth as the claude side). So NEITHER the daemon NOR the claude side
// changes; only codex's config + the launch env do. The launch sets CODEX_BEARER_ENV_VAR
// (=CODEX_DUMMY_BEARER) and PEER_IDENTITY; env_http_headers carries the latter per-peer.

export { CODEX_BEARER_ENV_VAR } from '../core/constants.ts'

/** `~/.codex/config.toml` (or $CODEX_HOME/config.toml). codex's config is HOST-WIDE,
 *  not per-peer/project-scope like claude's `.mcp.json`. */
export function codexConfigPath(options: StorageOptions = {}): string {
  const env = options.env ?? process.env
  const home = env.CODEX_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.codex')
  return join(home, 'config.toml')
}

/**
 * Idempotently add the token-free `[mcp_servers.iapeer]` block to codex's host-wide
 * config.toml (append-if-absent — never duplicates, never rewrites an existing block,
 * never touches other servers/sections). The block (PROVEN LIVE — codex imports +
 * calls send_to_peer with this exact shape):
 *   - url = the daemon HTTP-MCP endpoint.
 *   - default_tools_approval_mode = "approve" (no per-tool approval dialog; verified live).
 *   - bearer_token_env_var = "IAPEER_BEARER" — codex reads its bearer from this env var
 *     (the launch sets it to the NON-SECRET CODEX_DUMMY_BEARER). Its mere presence flips
 *     authStatus unsupported→bearer_token, so codex imports the tools; the OPEN daemon
 *     ignores the bearer (it authenticates by the identity header below).
 *   - env_http_headers."X-IAPeer-Identity" = "PEER_IDENTITY" — the PER-PEER caller
 *     identity, read from the PEER_IDENTITY env the launch sets, so ONE host-wide config
 *     serves every codex peer with its own identity (env_http_headers, verified live).
 * Returns {path, added} (added=false when the block already existed).
 */
export function writeCodexMcpConfig(daemonUrl: string, options: StorageOptions = {}): { path: string; added: boolean } {
  const path = codexConfigPath(options)
  let existing = ''
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    /* no config yet → create it */
  }
  if (/\[mcp_servers\.iapeer\]/.test(existing)) return { path, added: false } // idempotent
  const block =
    `\n[mcp_servers.${IAPEER_MCP_SERVER_NAME}]\n` +
    `url = ${JSON.stringify(daemonUrl)}\n` +
    `default_tools_approval_mode = "approve"\n` +
    `bearer_token_env_var = "${CODEX_BEARER_ENV_VAR}"\n` +
    `\n[mcp_servers.${IAPEER_MCP_SERVER_NAME}.env_http_headers]\n` +
    `"X-IAPeer-Identity" = "PEER_IDENTITY"\n`
  // Atomic write of the host-wide SHARED ~/.codex/config.toml (audit #12/#14): a torn
  // writeFileSync could corrupt the operator's whole codex config. writeFileAtomic
  // does tmp+fsync+rename and creates the dir.
  writeFileAtomic(path, existing.replace(/\n*$/, '\n') + block, 0o644)
  return { path, added: true }
}

/**
 * Idempotently ensure codex's startup update-check DIALOG is disabled host-wide:
 * `check_for_update_on_startup = false` as a TOP-LEVEL key in config.toml.
 *
 * Why: the interactive "✨ Update available! … Press enter to continue" dialog is
 * a BOOT GATE — a daemon-woken codex session sits on it until a human attaches.
 * Observed: the wake never became ready after 4+ minutes and a notifier alert of
 * the EMERGENCY contour was lost; the session came alive only from a manual
 * attach. Warm-on-demand peers
 * must reach ready hands-free — codex updates stay operator-driven (`codex
 * update` / brew), never a boot-time question to a headless session.
 *
 * Mechanics: the key is a documented top-level config.toml option (present in
 * the binary's own config schema; suppression PROVEN LIVE on codex 0.138
 * with the 0.139 update pending — control boot showed the dialog, the keyed
 * boot went straight past it). A TOML top-level key must precede the first
 * table header, so the key is PREPENDED — appending would land it inside the
 * last [section]. An EXISTING `check_for_update_on_startup` of either value is
 * respected (never override an explicit operator choice).
 */
export function ensureCodexUpdateCheckDisabled(
  options: StorageOptions = {},
): { path: string; changed: boolean } {
  const path = codexConfigPath(options)
  let existing = ''
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    /* no config yet → create it */
  }
  if (/^\s*check_for_update_on_startup\s*=/m.test(existing)) return { path, changed: false }
  writeFileAtomic(path, `check_for_update_on_startup = false\n${existing}`, 0o644)
  return { path, changed: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Local doctrine template (<cwd>/.iapeer/IAPEER.md — personality/role; human fills)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the local doctrine template `<cwd>/.iapeer/IAPEER.md` if absent (contract:
 * "шаблон .iapeer/IAPEER.md — пустой, человек заполняет"). It is the file that marks
 * "this is a configured peer" (the launch primitive's bare-session gate keys on it)
 * and where the peer's role/personality lives (merged into the system prompt, Канал
 * A). NEVER overwrites an existing doctrine. Returns {path, created}.
 */
export function ensureDoctrineTemplate(cwd: string): { path: string; created: boolean } {
  const path = join(cwd, IAPEER_DIR, IAPEER_DOCTRINE_FILE)
  if (existsSync(path)) return { path, created: false }
  ensureLocalIapScaffold(cwd)
  writeFileSync(
    path,
    [
      '# Peer doctrine',
      '',
      '<!-- This is the local doctrine for this peer — its role, personality, and mandate.',
      '     It is merged into the system prompt at launch (Канал A). Replace this with',
      '     who this peer is and what it does. An empty doctrine launches a bare peer. -->',
      '',
    ].join('\n'),
    { mode: 0o644 },
  )
  return { path, created: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// initPeer — orchestrate: provision (identity + registry + infra plist) + per-peer
// ecosystem wiring (MCP transport per agentic runtime + doctrine template)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the PRIMARY runtime for a peer cwd, runtime-aware and CONSISTENT with the
 * contract (Примитивы §init): an explicit runtime wins; otherwise the runtime markers
 * IN the cwd decide — `.claude` → claude, `.codex`-only → codex, both → claude primary
 * (the agentic default order). No marker at all → claude (the default). This removes
 * the old inconsistency where a `.codex`-only folder defaulted to claude as primary
 * yet got a codex config — now the primary matches the markers, deterministically.
 */
/**
 * Is an AGENTIC runtime installed on this host? Checks (any hit ⇒ installed): env
 * override (IAPEER_<RT>_BIN), the native installer location (~/.local/bin/claude), the
 * bare name on PATH, and the runtime's global config dir (~/.claude / ~/.codex — a
 * runtime that has ever run leaves one). SANDBOX: under IAPEER_TEST_SANDBOX it reports
 * `true` (never probes the real host) — mirror of the install-side guards; a hermetic
 * test that wants the real branches injects its own predicate into resolvePrimaryRuntime.
 */
export function isRuntimeInstalled(runtime: Runtime, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1') return true
  const override = runtime === 'claude' ? env.IAPEER_CLAUDE_BIN : runtime === 'codex' ? env.IAPEER_CODEX_BIN : undefined
  if (override?.trim()) return true
  const home = env.HOME?.trim() || homedir()
  if (runtime === 'claude' && existsSync(join(home, '.local', 'bin', 'claude'))) return true
  if (Bun.which(runtime)) return true
  if (runtime === 'claude' && existsSync(join(home, '.claude'))) return true
  if (runtime === 'codex' && existsSync(join(home, '.codex'))) return true
  return false
}

const AGENTIC_RUNTIMES: Runtime[] = ['claude', 'codex']

/**
 * Resolve a peer's primary AGENTIC runtime — install-aware:
 *   1. explicit (`--runtime`) → use it, but VALIDATE it is installed (clear error instead
 *      of a silent launch failure later on an uninstalled runtime).
 *   2. else a cwd runtime MARKER (.claude / .codex) → that runtime. The folder's already-
 *      established config takes PRECEDENCE over install-presence (a folder configured for
 *      X stays X even if Y is also installed; markers are not re-validated).
 *   3. else from what is INSTALLED: exactly one → it; none → clear error (don't silently
 *      default to claude on a host without it); both → claude (deterministic default —
 *      resolution runs in non-interactive paths, so no prompt; `--runtime` picks codex).
 * `isInstalled` is injectable for hermetic tests.
 */
export function resolvePrimaryRuntime(
  cwd: string,
  explicit?: Runtime,
  isInstalled: (rt: Runtime) => boolean = rt => isRuntimeInstalled(rt),
): Runtime {
  if (explicit) {
    // Infra runtimes (notifier/telegram) are NOT agentic binaries — their presence is
    // the npx runtime package + the launchd plist, not a claude/codex install. The
    // install-check below is agentic-only, so an explicit infra runtime must pass
    // straight through; otherwise re-deploying an infra peer (install-runtime /
    // update-runtime → createPeer → initPeer) wrongly fails "not installed".
    if (isInfraRuntime(explicit)) return explicit
    if (!isInstalled(explicit)) {
      throw new IapError(
        `runtime "${explicit}" is not installed on this host — install it (Claude Code / Codex CLI) or choose an installed runtime`,
      )
    }
    return explicit
  }
  if (existsSync(join(cwd, '.claude'))) return 'claude'
  if (existsSync(join(cwd, '.codex'))) return 'codex'
  const installed = AGENTIC_RUNTIMES.filter(isInstalled)
  if (installed.length === 1) return installed[0]!
  if (installed.length === 0) {
    throw new IapError(
      `no agentic runtime installed (Claude Code or Codex CLI) — install one, then create/init the peer`,
    )
  }
  return 'claude' // both installed → deterministic default; pass --runtime codex to pick codex
}

export interface InitPeerOptions {
  cwd: string
  /** Primary runtime. Default: resolved from the cwd's runtime markers
   *  (resolvePrimaryRuntime) — `.claude` → claude, `.codex`-only → codex, else claude.
   *  Agentic peers init claude/codex; an infra peer (telegram/notifier) is provisioned
   *  but has no `.mcp.json` (it is a router, not an MCP client). */
  runtime?: Runtime
  personality?: string
  description?: string
  intelligence?: Intelligence
  /** For an INFRA runtime: absolute path / PATH name of the runtime launcher, baked
   *  into the always-on plist (so launchd's minimal PATH resolves it). */
  runtimeBin?: string
  /** AUTO-bootstrap a freshly-installed INFRA plist (launchctl bootstrap) instead of
   *  write-and-wait (contract Фаза §5). Default true; only acts for an infra runtime
   *  whose plist is foundation-owned. Sandbox/foreign cases are guarded inside
   *  launchctlBootstrap. No-op for an agentic (warm-on-demand) runtime. */
  bootstrap?: boolean
  env?: NodeJS.ProcessEnv
  warn?: (message: string) => void
}

export interface InitPeerResult extends ProvisionResult {
  /** `.mcp.json` paths written (claude project-scope transport configs). */
  mcpConfigPaths: string[]
  /** codex config.toml path written with the token-free `[mcp_servers.iapeer]` block
   *  (dummy bearer + env_http_headers identity), or undefined when the peer is not
   *  codex. send_to_peer works immediately — see writeCodexMcpConfig. */
  codexMcpConfigPath?: string
  doctrinePath: string
  doctrineCreated: boolean
  daemonUrl: string
  /** For an INFRA runtime: the per-peer self-config hook outcome (configured / failed /
   *  absent when no runtime package declares one). Undefined for an agentic peer. */
  selfConfig?: SelfConfigResult
  /** For an INFRA runtime with bootstrap enabled: the launchctl bootstrap outcome
   *  (loaded / already-loaded / skipped-sandbox / refused-foreign / failed). Undefined
   *  for an agentic peer, when bootstrap was disabled, or when self-config failed (a
   *  misconfigured always-on session is never loaded). */
  bootstrapped?: BootstrapResult
}

/**
 * Initialise a peer in one call: provision (identity + registry + infra plist) then
 * the per-peer ecosystem wiring. For each AGENTIC runtime the peer declares, write
 * the HTTP-MCP transport config (claude → project `.mcp.json`; codex → follow-up) so
 * the peer has send_to_peer on cold-start. Always lay down the local doctrine
 * template. Idempotent: re-running rewrites the same `.mcp.json` and never clobbers
 * an existing doctrine.
 */
export async function initPeer(opts: InitPeerOptions): Promise<InitPeerResult> {
  const env = opts.env ?? process.env
  // Runtime-aware + CONSISTENT: an explicit runtime wins; else the cwd's markers
  // decide the primary (resolvePrimaryRuntime), so the primary always matches the
  // config that gets written (no `.codex`-only-but-primary-claude mismatch).
  const runtime = resolvePrimaryRuntime(opts.cwd, opts.runtime, rt => isRuntimeInstalled(rt, env))
  const provisioned = await provisionPeer({
    cwd: opts.cwd,
    runtime,
    personality: opts.personality,
    description: opts.description,
    intelligence: opts.intelligence,
    runtimeBin: opts.runtimeBin,
    env,
    warn: opts.warn,
  })

  const daemonUrl = resolveDaemonMcpUrl({ env })
  const mcpConfigPaths: string[] = []
  // Wire claude when the peer is a claude peer — primary runtime claude OR a `.claude`
  // marker in the cwd (a multi-runtime peer). codex (config.toml) is a separate
  // follow-up (its own live approval-mode check); an infra runtime is a router (no
  // MCP client), so it gets no `.mcp.json`.
  if (provisioned.runtime === 'claude' || hasClaudeMarker(provisioned.cwd)) {
    mcpConfigPaths.push(writeClaudeMcpConfig(provisioned.cwd, provisioned.personality, daemonUrl))
  }
  // codex: write the token-free host-wide config.toml block (dummy bearer flips codex's
  // auth gate; the OPEN daemon authenticates by the identity header). send_to_peer works
  // immediately. An infra runtime is a router → no MCP client → nothing written.
  let codexMcpConfigPath: string | undefined
  if (provisioned.runtime === 'codex' || hasCodexMarker(provisioned.cwd)) {
    codexMcpConfigPath = writeCodexMcpConfig(daemonUrl, { env }).path
    // Boot-gate hygiene: a codex peer must never sit on the
    // interactive update dialog at wake — disable the startup check host-wide.
    ensureCodexUpdateCheckDisabled({ env })
  }

  const doctrine = ensureDoctrineTemplate(provisioned.cwd)

  // INFRA peer: per-peer runtime self-config, THEN auto-bootstrap. For an agentic
  // (warm-on-demand) runtime neither applies — it is daemon-woken, never launchd-held,
  // and gets its MCP wiring above instead.
  let selfConfig: SelfConfigResult | undefined
  let bootstrapped: BootstrapResult | undefined
  if (isInfraRuntime(provisioned.runtime)) {
    // (1) PER-PEER self-config (the shared contract both provision modes call): ask the
    //     runtime package to "configure runtime state for this peer". A no-op when no
    //     runtime package declares a hook (selfConfig.state='absent').
    selfConfig = runtimeSelfConfig(
      {
        personality: provisioned.personality,
        cwd: provisioned.cwd,
        runtime: provisioned.runtime,
        intelligence: provisioned.intelligence,
      },
      { env },
    )
    if (selfConfig.state === 'failed') {
      // FAIL-CLOSED: never load an always-on session whose runtime state is not
      // configured (it would crash-loop). The plist is written (idempotent re-run
      // after a fix will bootstrap); we just do not load it now.
      opts.warn?.(`runtime self-config failed for ${provisioned.personality}: ${selfConfig.detail ?? ''} — NOT bootstrapping`)
    } else if (opts.bootstrap !== false) {
      // (2) AUTO-bootstrap (contract Фаза §5): load the plist NOW instead of
      //     write-and-wait. Fleet-safe / idempotent / sandbox-skipped inside.
      bootstrapped = launchctlBootstrap(provisioned.personality, launchdPlistPath(provisioned.personality, env), env)
      if (bootstrapped.state === 'failed' || bootstrapped.state === 'refused-foreign') {
        opts.warn?.(`bootstrap ${bootstrapped.state}: ${bootstrapped.detail ?? ''}`)
      }
    }
  }

  return {
    ...provisioned,
    mcpConfigPaths,
    codexMcpConfigPath,
    doctrinePath: doctrine.path,
    doctrineCreated: doctrine.created,
    daemonUrl,
    selfConfig,
    bootstrapped,
  }
}

/** A cwd is a claude/codex peer when it carries the runtime's marker dir (init scans
 *  the same markers as discoverPeerRuntimes). */
function hasClaudeMarker(cwd: string): boolean {
  return existsSync(join(cwd, '.claude'))
}
function hasCodexMarker(cwd: string): boolean {
  return existsSync(join(cwd, '.codex'))
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — `iapeer init` (run from the peer cwd) / `bun src/init/index.ts [cwd]`
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flags: Record<string, string> = {}
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i] ?? ''
    else positionals.push(args[i])
  }
  const cwd = positionals[0] ?? process.cwd()
  initPeer({
    cwd,
    runtime: (flags.runtime as Runtime) || undefined,
    personality: flags.personality,
    description: flags.description,
    intelligence: flags.intelligence as Intelligence | undefined,
    runtimeBin: flags.bin || undefined,
    bootstrap: 'no-bootstrap' in flags ? false : undefined,
    warn: m => process.stderr.write(`warn: ${m}\n`),
  })
    .then(r => {
      process.stdout.write(
        `initialized peer "${r.personality}" (${r.runtime}, ${r.intelligence})\n` +
          `  profile:  ${r.profilePath}\n` +
          `  registry: peers-profiles.json updated\n` +
          (r.mcpConfigPaths.length
            ? `  mcp:      ${r.mcpConfigPaths.join(', ')} → ${r.daemonUrl}\n`
            : r.codexMcpConfigPath
              ? `  mcp:      ${r.codexMcpConfigPath} (codex, token-free dummy-bearer — send_to_peer ready)\n`
              : '  mcp:      (none — infra/router runtime)\n') +
          `  doctrine: ${r.doctrinePath}${r.doctrineCreated ? ' (template created — fill it in)' : ' (kept)'}\n` +
          (r.plistPath ? `  plist:    ${r.plistPath}\n` : '') +
          `\nNext: fill in ${r.doctrinePath} and the peer's description, then launch with \`iapeer ${r.runtime}\`.\n`,
      )
      process.exit(0)
    })
    .catch(e => {
      process.stderr.write(`init failed: ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    })
}
