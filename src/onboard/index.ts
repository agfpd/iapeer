// onboard — the host-phase (contract Установка §2 ONBOARD). The linking step
// between install (the binary) and init (per-peer): register OUR marketplace in
// claude AND codex so peers can install agfpd capability plugins. Infra-runtime
// install (telegram/notifier self-installable npx) is the operator-choice follow-up.
//
// FLEET SAFETY: a host already configured for the legacy fleet MUST NOT be mutated by
// onboard. So onboard is strictly IDEMPOTENT — it DETECTS whether the marketplace is
// already registered (the runtime's own `plugin marketplace list`) and SKIPS when it
// is. On a configured host every step is a no-op; only a fresh host is written. A
// dry-run reports the would-be actions without touching anything.

import { spawnSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { accessSync, constants as FS, existsSync, readFileSync } from 'fs'

/** OUR marketplace — GitHub owner/repo, the source both runtimes' `marketplace add`
 *  takes; and the registered NAME both runtimes' `marketplace list` shows. */
export const MARKETPLACE_REF = 'agfpd/agfpd-marketplace'
export const MARKETPLACE_NAME = 'agfpd'

export type OnboardRuntime = 'claude' | 'codex'

export type MarketplaceState =
  | 'already-registered' // present → no-op (fleet-safe)
  | 'registered' // was absent → added now
  | 'would-register' // dry-run: absent, would add
  | 'runtime-missing' // the runtime binary is not installed
  | 'failed' // the add command failed

export interface OnboardRuntimeResult {
  runtime: OnboardRuntime
  state: MarketplaceState
  detail?: string
}

export interface OnboardResult {
  marketplaces: OnboardRuntimeResult[]
  /** True when nothing was mutated (every runtime already-registered / dry-run / missing). */
  noop: boolean
}

export interface OnboardOptions {
  /** Report the would-be actions without running any `marketplace add`. */
  dryRun?: boolean
  /** Restrict to these runtimes (default both). */
  runtimes?: OnboardRuntime[]
  env?: NodeJS.ProcessEnv
  /** Injectable (tests). Default registerMarketplace. */
  register?: (runtime: OnboardRuntime, env: NodeJS.ProcessEnv) => { ok: boolean; detail?: string }
  /** Injectable (tests). Default isMarketplaceRegistered. */
  isRegistered?: (runtime: OnboardRuntime, env: NodeJS.ProcessEnv) => boolean
  /** Injectable (tests). Default Bun.sleepSync — the pause before the one transient retry. */
  sleep?: (ms: number) => void
  /** Delay (ms) before the single non-timeout retry. Default 2000. */
  retryDelayMs?: number
}

// ─────────────────────────────────────────────────────────────────────────────

function runtimeBin(runtime: OnboardRuntime, env: NodeJS.ProcessEnv): string {
  if (runtime === 'claude') {
    const override = env.IAPEER_CLAUDE_BIN?.trim()
    if (override) return override
    // Prefer the native installer location (~/.local/bin/claude), but fall back to the bare,
    // PATH-resolved name so an npm/Homebrew claude installed elsewhere on PATH is not read as
    // runtime-missing (symmetric with codex, which defaults to the bare name).
    const native = join(env.HOME?.trim() || homedir(), '.local', 'bin', 'claude')
    return isExecutable(native, env) ? native : 'claude'
  }
  return env.IAPEER_CODEX_BIN?.trim() || 'codex'
}

function isExecutable(binOrName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (binOrName.includes('/')) {
    try {
      accessSync(binOrName, FS.X_OK)
      return true
    } catch {
      return false
    }
  }
  // bare name → PRESENCE probe over PATH (`command -v` semantics), NO spawn.
  // History: the original `--version` ANSWER probe hung forever (stray probes sat
  // 25+ min); the 10 s timeout that replaced it then DEGRADED a live-looking codex
  // to 'runtime-missing'. ROOT CAUSE: macOS held the cask-updated codex on a GUI
  // launch-approval dialog — EVERY invocation parked before main (observed as a
  // dyld hang) until the owner confirmed the dialog. NOT a non-tty class, not a
  // broken binary. The presence probe stays right regardless: the skip question is
  // "is the runtime installed", and presence answers it without executing a
  // possibly-wedged binary at all.
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue
    try {
      accessSync(join(dir, binOrName), FS.X_OK)
      return true
    } catch {
      /* not in this PATH segment */
    }
  }
  return false
}

/**
 * Is OUR marketplace already registered for this runtime? Reads the runtime's own
 * `plugin marketplace list` and matches the agfpd source-ref OR a standalone agfpd
 * name entry (both runtimes render the name; claude also shows the GitHub ref). A
 * word-boundary-ish match so a different agfpd-* string never false-positives.
 */
export function isMarketplaceRegistered(runtime: OnboardRuntime, env: NodeJS.ProcessEnv = process.env): boolean {
  const bin = runtimeBin(runtime, env)
  // HARD TIMEOUT — a runtime CLI can wedge before main on ANY invocation (e.g.
  // macOS launch-approval pending after a cask update parked codex — first
  // `--version`, then this very `plugin marketplace list` after the presence
  // probe let the binary through). Timeout → status null → "not registered" →
  // the add (also time-bounded) decides; never a wedge.
  const r = spawnSync(bin, ['plugin', 'marketplace', 'list'], { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) return false
  return isAgfpdInList(`${r.stdout ?? ''}`)
}

/**
 * Pure detector over a `plugin marketplace list` output: is a marketplace present?
 * Matches the GitHub source-ref (claude renders it) OR a standalone name entry
 * (both runtimes render the name). The name match is anchored to a line start
 * (optionally after the `❯` selection glyph) and followed by whitespace/EOL, so a
 * different `<name>-<something>` token never false-positives. Pure → unit-testable
 * against real claude/codex samples (the fleet-guard hinges on it).
 */
export function isMarketplaceInList(listOutput: string, name: string, ref?: string): boolean {
  if (ref && new RegExp(ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).test(listOutput)) return true
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return new RegExp(`(^|\\n)\\s*(❯\\s*)?${esc}(\\s|$)`).test(listOutput)
}

/** The OUR-marketplace specialization (the original onboard detector). */
export function isAgfpdInList(listOutput: string): boolean {
  return isMarketplaceInList(listOutput, MARKETPLACE_NAME, MARKETPLACE_REF)
}

/** Register a marketplace for this runtime (`<runtime> plugin marketplace add <ref>`).
 *  Exported for the generic capability-enable path (a third-party marketplaceRef
 *  must self-register on a fresh host). */
export function registerMarketplace(
  runtime: OnboardRuntime,
  env: NodeJS.ProcessEnv,
  ref: string = MARKETPLACE_REF,
): { ok: boolean; detail?: string } {
  const bin = runtimeBin(runtime, env)
  // Same hard timeout as the list probe (the pre-main wedge class — a known
  // representative: macOS launch-approval pending after a cask update) — a wedged
  // add degrades to a loud 'failed' line instead of freezing the host phase.
  const r = spawnSync(bin, ['plugin', 'marketplace', 'add', ref], { encoding: 'utf8', timeout: 120_000 })
  return r.status === 0
    ? { ok: true }
    : { ok: false, detail: (r.stderr ?? '').trim() || (r.status === null ? 'timed out (wedged runtime CLI?)' : `exit ${r.status}`) }
}

/** Is a marketplace (by name/ref) registered for this runtime? Generalized form of
 *  isMarketplaceRegistered for the generic capability-enable path. */
export function isMarketplaceRegisteredAs(
  runtime: OnboardRuntime,
  name: string,
  ref: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const bin = runtimeBin(runtime, env)
  const r = spawnSync(bin, ['plugin', 'marketplace', 'list'], { encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) return false
  return isMarketplaceInList(`${r.stdout ?? ''}`, name, ref)
}

/**
 * Refresh a runtime's local marketplace SNAPSHOT (контракт §Плагин провайдера):
 * a plugin registered in the marketplace AFTER the host's last pull reads as
 * «unknown plugin» until the snapshot updates. Verb names: claude `plugin
 * marketplace update <name>`, codex `plugin marketplace upgrade <name>`.
 */
export function refreshMarketplace(
  runtime: OnboardRuntime,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: boolean; detail?: string } {
  const bin = runtimeBin(runtime, env)
  const verb = runtime === 'claude' ? 'update' : 'upgrade'
  const r = spawnSync(bin, ['plugin', 'marketplace', verb, name], { encoding: 'utf8', timeout: 120_000 })
  return r.status === 0
    ? { ok: true }
    : { ok: false, detail: (r.stderr ?? '').trim() || (r.status === null ? 'timed out (wedged runtime CLI?)' : `exit ${r.status}`) }
}

/**
 * Onboard the host: ensure OUR marketplace is registered in each runtime — IDEMPOTENT
 * (detect → skip when present). On an already-configured host every runtime is
 * 'already-registered' and NOTHING is mutated (fleet-safe). dryRun reports 'would-
 * register' for any absent one without running the add. A missing runtime binary is
 * 'runtime-missing' (skipped, not an error). Infra-runtime install is a separate
 * operator-choice step (not done here).
 */
export function onboardHost(opts: OnboardOptions = {}): OnboardResult {
  const env = opts.env ?? process.env
  const runtimes = opts.runtimes ?? (['claude', 'codex'] as OnboardRuntime[])
  const isRegistered = opts.isRegistered ?? isMarketplaceRegistered
  const register = opts.register ?? registerMarketplace
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleepSync(ms))
  const retryDelayMs = opts.retryDelayMs ?? 2000
  const marketplaces: OnboardRuntimeResult[] = []
  for (const runtime of runtimes) {
    if (!isExecutable(runtimeBin(runtime, env), env)) {
      marketplaces.push({ runtime, state: 'runtime-missing' })
      continue
    }
    if (isRegistered(runtime, env)) {
      marketplaces.push({ runtime, state: 'already-registered' })
      continue
    }
    if (opts.dryRun) {
      marketplaces.push({ runtime, state: 'would-register' })
      continue
    }
    marketplaces.push(resolveMarketplaceAdd(runtime, env, register, isRegistered, sleep, retryDelayMs))
  }
  const noop = marketplaces.every(m => m.state !== 'registered')
  return { marketplaces, noop }
}

/**
 * One `marketplace add` with first-run-transient resilience (Arthur's fresh-run found a
 * scary red "failed" on a step that actually self-heals — the failure is transient, the
 * marketplace ends up registered). Layered:
 *   (a) SELF-HEAL: if the add reports failure but a re-check shows the marketplace IS
 *       present (it landed despite a non-zero tail / a race), report `registered`.
 *   (c) ONE retry after a short delay — only for a NON-timeout transient (a network/git
 *       blip on the GitHub clone). NEVER on a timeout: a wedged / macOS-launch-approval-
 *       parked binary would just re-wedge, doubling the wait.
 *   (b) on a timeout signature, report `failed` with the macOS-approval advisory; on any
 *       other persistent failure, a transient-retry hint. The marketplace is OPTIONAL for
 *       core function, so a clear actionable line beats a bare "failed".
 */
function resolveMarketplaceAdd(
  runtime: OnboardRuntime,
  env: NodeJS.ProcessEnv,
  register: (r: OnboardRuntime, e: NodeJS.ProcessEnv) => { ok: boolean; detail?: string },
  isRegistered: (r: OnboardRuntime, e: NodeJS.ProcessEnv) => boolean,
  sleep: (ms: number) => void,
  retryDelayMs: number,
): OnboardRuntimeResult {
  const first = register(runtime, env)
  if (first.ok) return { runtime, state: 'registered' }
  // (a) self-heal — present despite the reported error?
  if (isRegistered(runtime, env)) {
    return { runtime, state: 'registered', detail: 'add reported an error, but the marketplace is present' }
  }
  const timedOut = /timed out/i.test(first.detail ?? '')
  if (!timedOut) {
    // (c) one retry for a non-timeout transient.
    sleep(retryDelayMs)
    const second = register(runtime, env)
    if (second.ok || isRegistered(runtime, env)) return { runtime, state: 'registered', detail: 'succeeded on retry' }
    return {
      runtime,
      state: 'failed',
      detail: `${second.detail ?? first.detail} — transient (network/git)? re-run \`iapeer onboard\`; the marketplace is optional for core function`,
    }
  }
  // (b) timeout signature → the known macOS launch-approval park.
  return {
    runtime,
    state: 'failed',
    detail: `${first.detail} — macOS may be verifying the runtime binary; approve it in System Settings → Privacy & Security, then re-run \`iapeer onboard\``,
  }
}

/**
 * macOS Full Disk Access (TCC) advisory printed at the END of onboard. The runtime permission layer
 * (`--add-dir` / `additionalDirectories` for claude, the sandbox flags for codex) governs what the
 * RUNTIME allows; macOS TCC is a SEPARATE OS layer that NO flag, settings key, config, env var or
 * script can grant — it is user-granted in System Settings, by design (the TCC db is SIP-protected).
 *
 * PROBE-DRIVEN, not memory-gated (was: gated on a memory provider). The advisory now fires off the
 * REAL FDA state (`fda` from probeFullDiskAccess), because a missing grant is a latent fault no proxy
 * captures: the DEFAULT memory vault is an iCloud Obsidian dir AND a peer work dir can itself sit in a
 * protected location (Documents/Desktop/Downloads) with NO memory provider at all. So: grant present
 * → silent; grant ABSENT on macOS → warn, every time.
 *
 * Failure mode is SILENT, not a hang: per Apple (DTS/Quinn, devforums 678819) a launchd-spawned CLI
 * with no GUI front gets NO TCC dialog — the access is denied with EPERM. A peer therefore does NOT
 * block; its file I/O on a protected path just silently fails. `~/.iapeer` (under $HOME) is NOT
 * TCC-protected and needs nothing.
 *
 * Returns null when granted / undeterminable / non-macOS (`fda` true or null). Pure (no I/O) —
 * the FDA probe and binPath are injected by the caller, so this stays unit-testable.
 */
export function tccFullDiskAccessNote(opts: { fda: boolean | null; binPath: string }): string | null {
  if (opts.fda !== false) return null // granted, non-macOS, or undeterminable → nothing to nag
  return (
    [
      'macOS Full Disk Access NOT granted (manual — TCC cannot be set by any flag, settings key or script):',
      '  Without it, file I/O on TCC-protected paths SILENTLY FAILS with EPERM (no prompt, no hang) —',
      '  a peer reading/writing an iCloud Obsidian vault (iCloud Drive / Desktop / Documents / Downloads)',
      '  just gets denied. `~/.iapeer` itself is under $HOME and needs nothing.',
      `  Grant it to ${opts.binPath} (and to Terminal too, if you attach) in:`,
      '    System Settings → Privacy & Security → Full Disk Access',
    ].join('\n') + '\n'
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime auth readiness — the one CLEAN-HOST modal a launcher CANNOT auto-clear
// ─────────────────────────────────────────────────────────────────────────────
//
// A headless peer runs the runtime's INTERACTIVE TUI (a pty), not `-p`. On a clean
// host the first-run flow blocks on modals; the launcher auto-answers the ones it
// recognizes (theme picker, folder-trust, …) — but the LOGIN screen cannot be
// auto-answered (selecting subscription opens a browser OAuth flow no headless peer
// can complete). So login is a PREREQUISITE: the host must be authenticated BEFORE
// the first peer launches, or that peer's wake fails loud at the boot deadline.
//
// These probes are CONSERVATIVE: they return ready ONLY on positive evidence, so a
// missing signal nags (one harmless advisory line) rather than letting an
// unauthenticated host silently ship a peer that will fail to wake.

/** Resolve claude's config dir (CLAUDE_CONFIG_DIR override, else ~/.claude). */
function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  if (override) return override
  return join(env.HOME?.trim() || homedir(), '.claude')
}

/**
 * True when claude is authenticated for a headless launch (won't block on the login
 * picker). Positive evidence, in order: an auth env var; a completed onboarding +
 * account in `~/.claude.json` (the subscription `claude login` path); or an
 * `apiKeyHelper` in settings.json. Anything else → not ready (nag). Reads are
 * env-rooted (HOME/CLAUDE_CONFIG_DIR) so a hermetic test isolates them.
 */
export function claudeAuthReady(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim() || env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    return true
  }
  // `~/.claude.json` lives at HOME root (not inside the config dir) in the default
  // layout the fleet uses; hasCompletedOnboarding + an account/key marker proves the
  // first-run flow (theme + login) is done.
  const statePath = join(env.HOME?.trim() || homedir(), '.claude.json')
  try {
    const j = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
    if (j.hasCompletedOnboarding === true && (j.oauthAccount != null || j.customApiKeyResponses != null)) return true
  } catch {
    /* absent/unreadable → fall through to settings */
  }
  try {
    const s = JSON.parse(readFileSync(join(claudeConfigDir(env), 'settings.json'), 'utf8')) as Record<string, unknown>
    if (typeof s.apiKeyHelper === 'string' && s.apiKeyHelper.trim()) return true
  } catch {
    /* no settings / no helper */
  }
  return false
}

/**
 * True when codex is authenticated (won't block / error at startup). Positive
 * evidence: `OPENAI_API_KEY` env, or an `auth.json` under $CODEX_HOME/~/.codex.
 * Env-rooted for hermetic tests.
 */
export function codexAuthReady(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OPENAI_API_KEY?.trim()) return true
  const codexHome = env.CODEX_HOME?.trim()
  const authPath = codexHome
    ? join(codexHome, 'auth.json')
    : join(env.HOME?.trim() || homedir(), '.codex', 'auth.json')
  return existsSync(authPath)
}

/**
 * Advisory line for a runtime that is NOT authenticated (so the operator fixes it
 * BEFORE launching peers). Returns null when the runtime is ready. Pure dispatch
 * over the per-runtime probes above.
 */
export function runtimeAuthNote(runtime: OnboardRuntime, env: NodeJS.ProcessEnv = process.env): string | null {
  if (runtime === 'claude') {
    if (claudeAuthReady(env)) return null
    return (
      'claude: NOT authenticated — the first peer would block on the login screen (a launcher cannot\n' +
      '  complete the browser OAuth flow). Before launching peers, either run `claude` once in your\n' +
      '  terminal to sign in (subscription), or set ANTHROPIC_API_KEY in the daemon environment.'
    )
  }
  if (codexAuthReady(env)) return null
  return (
    'codex: NOT authenticated — the first codex peer cannot reach the model. Before launching codex\n' +
    '  peers, run `codex login` once (or set OPENAI_API_KEY in the daemon environment).'
  )
}
