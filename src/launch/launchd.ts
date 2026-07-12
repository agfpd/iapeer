// launchd — always-on plist generation for INFRA runtimes (notifier, telegram).
// The foundation DEPLOYS the launchd LaunchAgent that holds an infra peer live
// (KeepAlive) AND reads it back for the H4 sweep-guard (lifecycle.isLaunchdManaged).
// Both sides MUST agree on the label + dir scheme, so those are the SINGLE shared
// helpers here (lifecycle imports them) — there is no second place that spells
// `com.iapeer.<personality>.plist`, so the generator and the detector cannot drift.
//
// The plist runs the always-on entrypoint (launchdRun.ts): it brings the peer up
// in a tmux session (launch alwaysOn → a live pane/socket for the daemon's
// deliverViaTmux to paste send_to_peer envelopes into) and blocks until the session
// dies → KeepAlive respawns. ThrottleInterval PINS launchd's respawn floor EXPLICITLY
// (launchd's own default is also 10s, so this restates rather than widens it — set
// here so the crashloop bound is visible and tunable, not an implicit default; raise
// throttleIntervalSecs for a wider window). RunAtLoad+KeepAlive = always-on.

import { accessSync, constants as FS, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { iapeerBinPath } from '../install/index.ts'
import {
  DAEMON_PLIST_LABEL,
  IAPEER_DIR,
  INFRA_RUNTIME_BIN_ENV,
  INFRA_RUNTIME_DEFAULT_BIN,
  LAUNCHD_LABEL_PREFIX,
  isInfraRuntime,
  type Runtime,
} from '../core/constants.ts'
import { buildProcessAddress } from '../core/socket.ts'
import { peerLogsDir } from '../storage/index.ts'
import { IapError } from '../core/errors.ts'

const DEFAULT_THROTTLE_SECS = 10

/**
 * OWNERSHIP SENTINEL — an inert top-level plist key the foundation renderer ALWAYS
 * embeds, marking a plist as foundation-managed. The launchd Label is keyed on
 * personality (`com.iapeer.<p>`) and SHARED with the live persistent-peer fleet, so
 * the label alone CANNOT tell a foundation plist from a PP-managed one. This key
 * can: the proof of ownership travels WITH the artifact (no side ownership registry
 * to drift), so the install guard refuses to clobber any com.iapeer.* plist that
 * lacks it. launchd ignores keys it does not recognize, so the marker is inert at
 * load time (and never reaches the runtime process, unlike an env var would).
 * NOT a Label: a Label value renders inside `<string>`, this only ever appears as
 * `<key>…</key>`, so the detection substring can never collide with a peer named
 * "managed". Bumping this string is a breaking change (older plists read as foreign).
 */
export const IAPEER_PLIST_OWNER_KEY = 'com.iapeer.managed'

/**
 * True iff the plist file at `path` was rendered by the foundation (carries the
 * ownership sentinel). A foreign / persistent-peer plist at the same com.iapeer.*
 * label lacks it → false. An absent or unreadable file → false (not provably ours,
 * so the guard treats it as foreign and refuses). Substring match is reliable
 * because renderLaunchdPlist emits the sentinel verbatim as a `<key>` node.
 */
export function isFoundationOwnedPlist(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(`<key>${IAPEER_PLIST_OWNER_KEY}</key>`)
  } catch {
    return false
  }
}

/** Read one EnvironmentVariables value from an already-written plist. Used to
 *  PRESERVE a host-specific env var across a plist regeneration (install-runtime
 *  rewrites the plist from scratch, which would otherwise drop it). Returns
 *  undefined when the file / key is absent or unreadable. The key is a literal
 *  env-var name (no regex metachars) and the values we preserve are constrained
 *  identifiers (no XML entities), so a direct `<key>…</key><string>…</string>`
 *  match is sufficient. */
function readPlistEnvVar(path: string, key: string): string | undefined {
  try {
    const m = readFileSync(path, 'utf8').match(
      new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
    )
    return m ? m[1] : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve an executable to an ABSOLUTE path against `env.PATH` (the RICH
 * provisioning PATH), so the result can be baked into a launchd plist whose own
 * PATH is minimal. A name containing '/' is treated as a path and returned iff it
 * is an executable file. Returns undefined when nothing executable is found.
 * Pure PATH scan (no `which` dependency) — deterministic and testable.
 */
export function resolveExecutable(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const isExec = (p: string): boolean => {
    try {
      accessSync(p, FS.X_OK)
      return true
    } catch {
      return false
    }
  }
  if (bin.includes('/')) return isExec(bin) ? bin : undefined
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue
    const p = join(dir, bin)
    if (isExec(p)) return p
  }
  return undefined
}

/** `com.iapeer.<personality>` — the launchd Label AND the plist basename stem.
 *  The single source for the scheme; isLaunchdManaged reads the same. */
export function launchdLabel(personality: string): string {
  return `${LAUNCHD_LABEL_PREFIX}${personality}`
}

/** The LaunchAgents dir: IAPEER_LAUNCHAGENTS_DIR override (tests/sandbox) else
 *  ~/Library/LaunchAgents. Shared with isLaunchdManaged. */
export function launchAgentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.IAPEER_LAUNCHAGENTS_DIR?.trim() || join(env.HOME?.trim() || homedir(), 'Library', 'LaunchAgents')
}

export function launchdPlistPath(personality: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(launchAgentsDir(env), `${launchdLabel(personality)}.plist`)
}

// XML-escape a plist <string> text node. cwd / personality / PATH can carry '&',
// '<', '>' (or unicode) — a literal '&' or '<' would corrupt the XML, so escape the
// three significant characters. Also DROP XML-1.0-illegal control characters (NUL +
// the C0 set except tab/LF/CR): they are not representable in XML 1.0 text and `plutil`
// only leniently tolerates them. Inputs here are NAME_RE-clean personalities and real
// filesystem paths, so this is belt-and-suspenders, never lossy in practice.
function xmlEscape(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export interface LaunchdPlistSpec {
  label: string
  programArguments: string[]
  workingDirectory: string
  environment: Record<string, string>
  stdoutPath: string
  stderrPath: string
  /** Seconds launchd waits before respawning a fast-exiting job (crashloop
   *  circuit). Default 10 — explicit, so a broken infra peer cannot respawn-storm. */
  throttleIntervalSecs?: number
}

/** Render a launchd LaunchAgent plist (RunAtLoad + KeepAlive = always-on). PURE
 *  and deterministic — golden/lint-testable. */
export function renderLaunchdPlist(spec: LaunchdPlistSpec): string {
  const throttle = spec.throttleIntervalSecs ?? DEFAULT_THROTTLE_SECS
  const args = spec.programArguments.map(a => `        <string>${xmlEscape(a)}</string>`).join('\n')
  const envEntries = Object.entries(spec.environment)
    .map(([k, v]) => `        <key>${xmlEscape(k)}</key>\n        <string>${xmlEscape(v)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(spec.label)}</string>
    <key>${IAPEER_PLIST_OWNER_KEY}</key>
    <true/>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(spec.workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${throttle}</integer>
    <key>StandardOutPath</key>
    <string>${xmlEscape(spec.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(spec.stderrPath)}</string>
</dict>
</plist>
`
}

/** Default ProgramArguments prefix (Ф-F): the INSTALLED `iapeer` binary running the
 *  always-on infra entrypoint (`iapeer run-infra`), NOT `bun launchdRun.ts` — prod is
 *  decoupled from the src tree. The personality + runtime positionals are appended by
 *  install. (The pre-Ф-F `[bun, launchdRun.ts]` is overridable via entrypointArgv for
 *  tests / a tree-run dev layout.) */
function defaultEntrypointArgv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [iapeerBinPath(env), 'run-infra']
}

// ─────────────────────────────────────────────────────────────────────────────
// launchctl bootstrap — AUTO-load a freshly-provisioned foundation plist
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve the current gui-domain uid for `launchctl bootstrap gui/<uid>`. NEVER
 *  falls back to 0 (that would aim the ROOT gui domain); a non-numeric
 *  `id -u` result throws. */
function currentUid(): string {
  const r = spawnSync('id', ['-u'], { encoding: 'utf8' })
  const u = (r.stdout ?? '').trim()
  if (!/^\d+$/.test(u)) {
    throw new IapError('cannot resolve the current uid (id -u failed) — refusing to target launchctl at an unknown domain')
  }
  return u
}

export type BootstrapState =
  | 'loaded' // bootstrapped now (was not loaded)
  | 'already-loaded' // service already in the gui domain → no-op (idempotent)
  | 'skipped-sandbox' // IAPEER_TEST_SANDBOX=1 → never touch the real launchd
  | 'refused-foreign' // the plist is not foundation-owned → never load someone else's
  | 'failed' // launchctl bootstrap exited non-zero

export interface BootstrapResult {
  state: BootstrapState
  label: string
  detail?: string
}

/** Is `com.iapeer.<personality>` already loaded in the gui domain? (`launchctl print`
 *  exits 0 when the service exists.) Used to make bootstrap idempotent. */
function isLaunchdLoaded(label: string, uid: string): boolean {
  return spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { stdio: 'ignore' }).status === 0
}

// ─────────────────────────────────────────────────────────────────────────────
// UNDEAD-JOB-SAFE bootstrap core: after `launchctl bootout` launchd dismantles
// the job ASYNCHRONOUSLY — an immediate `bootstrap` hits the still-listed
// "undead" job and fails with exit 5 "Input/output error" (the known
// persistent-peer race class). On the connect flow this left the WHOLE fleet's
// telegram router down. This core makes every restart-shaped flow
// (stop→start, connect router restart, update-runtime) survive the race:
//   (1) WAIT-FOR-GONE: while the job is still listed, poll `print` up to
//       goneTimeoutMs. Vanished → proceed to bootstrap. STILL listed at the
//       deadline → it is a genuinely LIVE job (KeepAlive running), not an undead
//       one → 'already-loaded' (the idempotent no-op, same meaning as before).
//   (2) BOOTSTRAP WITH BACKOFF: attempts with [0, 2 s, 5 s, 15 s] pauses
//       (~22 s budget — covers the observed "manual retry succeeded after ~30 s"
//       window), re-checking gone before each retry. All attempts failed →
//       'failed' with the attempt count and the last stderr, so the caller can
//       print the manual rescue recipe LOUD instead of leaving the job down
//       silently.
// Pure DI core (run/sleep injected) — unit-testable without launchctl and
// without tripping the test-sandbox guard that wraps the public function.
// ─────────────────────────────────────────────────────────────────────────────

export interface LaunchctlRunner {
  (args: string[]): { status: number | null; stderr: string }
}

export interface BootstrapCoreDeps {
  run: LaunchctlRunner
  sleepMs: (ms: number) => void
  /** Budget for the undead job to vanish after a bootout (default 10 000 ms). */
  goneTimeoutMs?: number
  /** Pauses BEFORE each bootstrap attempt (default [0, 2000, 5000, 15000]). */
  backoffMs?: number[]
}

export interface BootstrapCoreResult {
  state: 'loaded' | 'already-loaded' | 'failed'
  attempts: number
  detail?: string
}

export function bootstrapJobCore(
  uid: string,
  label: string,
  plistPath: string,
  deps: BootstrapCoreDeps,
): BootstrapCoreResult {
  const goneTimeout = deps.goneTimeoutMs ?? 10_000
  const backoffs = deps.backoffMs ?? [0, 2_000, 5_000, 15_000]
  const listed = () => deps.run(['print', `gui/${uid}/${label}`]).status === 0

  // (1) wait-for-gone (an undead job vanishes within seconds; a LIVE KeepAlive
  //     job stays listed → idempotent no-op, exactly the old 'already-loaded').
  if (listed()) {
    const pollStep = 500
    let waited = 0
    while (waited < goneTimeout) {
      deps.sleepMs(pollStep)
      waited += pollStep
      if (!listed()) break
    }
    if (listed()) return { state: 'already-loaded', attempts: 0 }
  }

  // (2) bootstrap with backoff; re-verify gone before each retry.
  let last = ''
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (backoffs[attempt]! > 0) deps.sleepMs(backoffs[attempt]!)
    if (attempt > 0 && listed()) {
      // the failed attempt may have half-loaded it, or a race loaded it — success
      return { state: 'already-loaded', attempts: attempt }
    }
    const r = deps.run(['bootstrap', `gui/${uid}`, plistPath])
    if (r.status === 0) return { state: 'loaded', attempts: attempt + 1 }
    last = r.stderr.trim() || `exit ${r.status}`
  }
  return {
    state: 'failed',
    attempts: backoffs.length,
    detail: `${backoffs.length} bootstrap attempts failed (last: ${last})`,
  }
}

export type LaunchdJobCycleState =
  | 'restarted' // bootout + bootstrap succeeded → the job runs with the currently-referenced binaries
  | 'not-loaded' // the label is not in the gui domain → nothing to restart (next start will use the current plist/binaries)
  | 'skipped-sandbox' // IAPEER_TEST_SANDBOX=1 → never touch the real launchd
  | 'failed' // bootout/bootstrap failed — the result carries the manual rescue recipe

export interface LaunchdJobCycleResult {
  state: LaunchdJobCycleState
  detail?: string
}

export type DaemonRestartState = LaunchdJobCycleState
export interface DaemonRestartResult extends LaunchdJobCycleResult {}

/**
 * DI core of cycleLaunchdJob (unit-testable without launchctl): bootout → wait-for-gone
 * → bootstrap, composed on bootstrapJobCore's undead-job-safe wait/backoff.
 * Disambiguation of bootstrapJobCore's 'already-loaded': at attempts=0 it means the
 * job NEVER unloaded after our bootout (undead beyond budget) → FAIL loud with the
 * manual recipe; at attempts>0 it means a retry found the job loaded (our previous
 * attempt half-succeeded or KeepAlive raced us in) → the job IS up → success.
 */
export function cycleLaunchdJobCore(
  uid: string,
  label: string,
  plistPath: string,
  deps: BootstrapCoreDeps,
): LaunchdJobCycleResult {
  const listed = () => deps.run(['print', `gui/${uid}/${label}`]).status === 0
  if (!listed()) return { state: 'not-loaded' }
  const bo = deps.run(['bootout', `gui/${uid}/${label}`])
  if (bo.status !== 0) {
    return { state: 'failed', detail: `launchctl bootout failed: ${bo.stderr.trim() || `exit ${bo.status}`}` }
  }
  const core = bootstrapJobCore(uid, label, plistPath, deps)
  if (core.state === 'loaded' || (core.state === 'already-loaded' && core.attempts > 0)) {
    return { state: 'restarted' }
  }
  if (core.state === 'already-loaded') {
    return {
      state: 'failed',
      detail:
        `job never unloaded after bootout (undead beyond budget) — manual rescue: ` +
        `launchctl bootout gui/${uid}/${label} && launchctl bootstrap gui/${uid} ${plistPath}`,
    }
  }
  return {
    state: 'failed',
    detail: `${core.detail ?? 'bootstrap failed'} — manual rescue: launchctl bootstrap gui/${uid} ${plistPath}`,
  }
}

/** Back-compat wrapper for the foundation daemon's label. */
export function cycleDaemonCore(
  uid: string,
  plistPath: string,
  deps: BootstrapCoreDeps,
): DaemonRestartResult {
  return cycleLaunchdJobCore(uid, DAEMON_PLIST_LABEL, plistPath, deps)
}

/**
 * Restart the foundation daemon (`com.agfpd.iapeer`) onto the binary currently on
 * disk — `launchctl bootout` + `bootstrap`, DELIBERATELY NOT `kickstart -k`.
 *
 * LWCR (launch constraints, the deploy bomb — PROVEN LIVE twice): after a
 * binary replacement, launchd's managed Launch Constraint for the REGISTERED job
 * can still pin the OLD binary's signature — a kickstart then respawns into an
 * EX_CONFIG(78) crash-loop (`state = spawn scheduled`, exit 78 from launchd
 * itself; the binary runs fine by hand). Reproduced on a com.iapeer.* infra job
 * (a telegram-runtime deploy, bridge down 6 min) AND on com.agfpd.iapeer
 * itself (a daemon deploy — daemon down until the manual cure). The ONLY cure
 * is a full re-registration: bootout drops the job (and its constraint),
 * bootstrap registers it against the binary now on disk. kickstart is
 * structurally insufficient for this class.
 *
 * Composed on bootstrapJobCore (undead-job-safe wait-for-gone + backoff). Only
 * cycles when the service is actually loaded — a not-loaded daemon needs no
 * restart (the new binary is taken on its next start). The plist itself is
 * version-stable (write-if-changed) and is NOT rewritten here. Sandbox-safe.
 */
export function cycleDaemon(env: NodeJS.ProcessEnv = process.env): DaemonRestartResult {
  return cycleLaunchdJob(DAEMON_PLIST_LABEL, join(launchAgentsDir(env), `${DAEMON_PLIST_LABEL}.plist`), env)
}

/**
 * Ensure the foundation daemon (`com.agfpd.iapeer`) is LOADED in the gui domain — an
 * IDEMPOTENT `launchctl bootstrap` (no-op when already loaded), NOT a restart. This is
 * the "start it now" step `iapeer onboard` runs, so an operator never types raw
 * launchctl. Composed on bootstrapJobCore (undead-job-safe wait-for-gone + backoff).
 * SANDBOX FAIL-SAFE: under IAPEER_TEST_SANDBOX it never calls launchctl (`bootstrap
 * gui/<uid>` is host-global regardless of IAPEER_ROOT), consulting BOTH the passed env
 * and the process env — mirror of launchctlBootstrap's guard.
 */
export function bootstrapDaemon(env: NodeJS.ProcessEnv = process.env): BootstrapResult {
  if (env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1') {
    return { state: 'skipped-sandbox', label: DAEMON_PLIST_LABEL, detail: 'IAPEER_TEST_SANDBOX=1 — not loading a real launchd job' }
  }
  const uid = currentUid()
  const plistPath = join(launchAgentsDir(env), `${DAEMON_PLIST_LABEL}.plist`)
  const core = bootstrapJobCore(uid, DAEMON_PLIST_LABEL, plistPath, {
    run: args => {
      const r = spawnSync('launchctl', args, { encoding: 'utf8' })
      return { status: r.status, stderr: r.stderr ?? '' }
    },
    sleepMs: ms => spawnSync('sleep', [String(ms / 1000)]),
  })
  return core.state === 'failed'
    ? { state: 'failed', label: DAEMON_PLIST_LABEL, detail: core.detail }
    : { state: core.state, label: DAEMON_PLIST_LABEL }
}

/**
 * Restart any launchd job onto the executable(s) currently referenced by its plist:
 * bootout → bootstrap, never kickstart. Used by the daemon update path AND by
 * foundation-owned infra peers (`com.iapeer.*`) whose ProgramArguments also point at
 * the installed `iapeer` binary. The caller owns any fleet/ownership guard; this
 * primitive only cycles the concrete label/plist pair. Sandbox-safe.
 */
export function cycleLaunchdJob(
  label: string,
  plistPath: string,
  env: NodeJS.ProcessEnv = process.env,
): LaunchdJobCycleResult {
  if (env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1') {
    return { state: 'skipped-sandbox' }
  }
  const uid = currentUid()
  return cycleLaunchdJobCore(uid, label, plistPath, {
    run: args => {
      const r = spawnSync('launchctl', args, { encoding: 'utf8' })
      return { status: r.status, stderr: r.stderr ?? '' }
    },
    sleepMs: ms => spawnSync('sleep', [String(ms / 1000)]),
  })
}

/**
 * Idempotently ensure ANY launchd job is LOADED in the gui domain — bootstrap when
 * absent, no-op when already loaded. The generic sibling of `bootstrapDaemon` for a
 * caller-supplied label/plist pair (e.g. the tray SwiftBar-autostart LaunchAgent).
 * The CALLER owns any ownership/fleet guard; this primitive only loads the concrete
 * label/plist. Composed on bootstrapJobCore (undead-job-safe wait-for-gone + backoff).
 * SANDBOX FAIL-SAFE: never calls launchctl under IAPEER_TEST_SANDBOX (`bootstrap
 * gui/<uid>` is host-global regardless of IAPEER_ROOT) — consulting BOTH the passed and
 * the process env, the same fail-closed rule as launchctlBootstrap.
 */
export function bootstrapLaunchdJob(
  label: string,
  plistPath: string,
  env: NodeJS.ProcessEnv = process.env,
): BootstrapResult {
  if (env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1') {
    return { state: 'skipped-sandbox', label, detail: 'IAPEER_TEST_SANDBOX=1 — not loading a real launchd job' }
  }
  const uid = currentUid()
  const core = bootstrapJobCore(uid, label, plistPath, {
    run: args => {
      const r = spawnSync('launchctl', args, { encoding: 'utf8' })
      return { status: r.status, stderr: r.stderr ?? '' }
    },
    sleepMs: ms => spawnSync('sleep', [String(ms / 1000)]),
  })
  return core.state === 'failed' ? { state: 'failed', label, detail: core.detail } : { state: core.state, label }
}

export interface BootoutResult {
  state: 'booted-out' | 'not-loaded' | 'skipped-sandbox' | 'failed'
  detail?: string
}

/**
 * Unload a launchd job from the gui domain (`launchctl bootout gui/<uid>/<label>`) —
 * the teardown primitive (used to remove the tray SwiftBar-autostart LaunchAgent on
 * `tray uninstall`). Idempotent: an un-loaded label is `not-loaded` (no-op). The CALLER
 * removes the plist file (this only unloads the running job). Sandbox-safe: never calls
 * launchctl under IAPEER_TEST_SANDBOX.
 */
export function bootoutLaunchdJob(label: string, env: NodeJS.ProcessEnv = process.env): BootoutResult {
  if (env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1') {
    return { state: 'skipped-sandbox' }
  }
  const uid = currentUid()
  if (!isLaunchdLoaded(label, uid)) return { state: 'not-loaded' }
  const r = spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' })
  return r.status === 0 ? { state: 'booted-out' } : { state: 'failed', detail: (r.stderr ?? '').trim() || `exit ${r.status}` }
}

/**
 * AUTO-bootstrap a freshly-provisioned foundation plist into the gui domain
 * (`launchctl bootstrap gui/<uid> <plist>`) — the "load it now, don't write-and-wait
 * for the operator" step (contract Установка / Фаза §5). Designed to be SAFE on a
 * live host:
 *   - FLEET GUARD: refuses any plist that is not foundation-owned (lacks the
 *     ownership sentinel) — a foreign / persistent-peer plist at the shared
 *     com.iapeer.* label is never loaded by us (`refused-foreign`).
 *   - IDEMPOTENT: a service already in the gui domain is a no-op (`already-loaded`),
 *     so a repeat provision/create never errors on a double bootstrap.
 *   - SANDBOX FAIL-SAFE: under IAPEER_TEST_SANDBOX=1 it NEVER calls launchctl
 *     (`bootstrap gui/<uid>` is host-global regardless of where the plist file lives,
 *     so a test must not load a real launchd job). Returns `skipped-sandbox`.
 * A live e2e proof runs WITHOUT IAPEER_TEST_SANDBOX (isolated IAPEER_ROOT + a
 * non-fleet personality) so this actually loads — additive and reversible (bootout).
 */
export function launchctlBootstrap(
  personality: string,
  plistPath: string,
  env: NodeJS.ProcessEnv = process.env,
): BootstrapResult {
  const label = launchdLabel(personality)
  if (!isFoundationOwnedPlist(plistPath)) {
    return {
      state: 'refused-foreign',
      label,
      detail: `${plistPath} is not foundation-owned (no ${IAPEER_PLIST_OWNER_KEY} sentinel) — refusing to launchctl bootstrap a foreign plist`,
    }
  }
  // SANDBOX FAIL-CLOSED: `launchctl bootstrap gui/<uid>` is HOST-GLOBAL — it loads a
  // real launchd job regardless of where the plist file lives or what IAPEER_ROOT is.
  // So the skip MUST consult BOTH the passed env AND the PROCESS env: a test harness
  // that passes an explicit env (isolated IAPEER_ROOT) but omits the flag would
  // otherwise bypass the guard and load a real job (this exact hole bit once). The
  // process-level flag (set by `bun test`) forces the skip even then — mirror of the
  // registry's fail-closed sandbox lesson. A live e2e proof runs with NEITHER flag set.
  if (env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1') {
    return { state: 'skipped-sandbox', label, detail: 'IAPEER_TEST_SANDBOX=1 — not loading a real launchd job' }
  }
  const uid = currentUid()
  // UNDEAD-JOB-SAFE core: wait for a booted-out
  // job to actually vanish, then bootstrap with backoff. A genuinely LIVE job
  // reads 'already-loaded' (idempotent no-op, same semantics as before); only a
  // job that stays failing through every attempt reads 'failed'.
  const core = bootstrapJobCore(uid, label, plistPath, {
    run: args => {
      const r = spawnSync('launchctl', args, { encoding: 'utf8' })
      return { status: r.status, stderr: r.stderr ?? '' }
    },
    sleepMs: ms => spawnSync('sleep', [String(ms / 1000)]),
  })
  return core.state === 'failed'
    ? { state: 'failed', label, detail: core.detail }
    : { state: core.state, label }
}

export interface InstallAlwaysOnPlistOptions {
  personality: string
  runtime: Runtime
  cwd: string
  /** How to invoke the always-on entrypoint, WITHOUT the trailing personality/
   *  runtime (those are appended). Defaults to [bun, launchdRun.ts]. */
  entrypointArgv?: string[]
  /** PATH for the launchd minimal env (default: bun/local/homebrew/usr/bin). */
  path?: string
  /** Absolute path to the infra runtime's launcher binary, baked into the plist
   *  env (NOTIFIER_RUNTIME_BIN / TELEGRAM_RUNTIME_BIN) so the launchd-minimal PATH
   *  can resolve it. When omitted, the default bin is resolved against env.PATH
   *  (best-effort); unresolved → not baked (the bare name + plist PATH remain). */
  runtimeBin?: string
  env?: NodeJS.ProcessEnv
  throttleIntervalSecs?: number
}

/**
 * Generate and install the always-on launchd plist for an INFRA peer, returning
 * the written path. Gated on isInfraRuntime (a warm-on-demand claude/codex peer is
 * daemon-managed, never launchd-held — installing a plist would flip it to H4
 * read-only and break wake). The plist's ProgramArguments run the always-on
 * entrypoint with PEER_* env + WorkingDirectory=cwd; logs land under
 * <cwd>/.iapeer/logs/<runtime>/.
 *
 * COLLISION GUARD (H4 — shared label namespace): the launchd Label is
 * com.iapeer.<personality> — keyed on PERSONALITY, not identity, and SHARED with the
 * already-deployed persistent-peer fleet (~/Library/LaunchAgents/
 * com.iapeer.<persistent-peer>.plist run by start.sh). A personality collision (a
 * notifier peer named like a live PP peer) must NOT silently overwrite that foreign
 * plist — doing so would tear a live PP peer off launchd. So before writing we
 * REFUSE when a plist already sits at the target and is not foundation-owned
 * (isFoundationOwnedPlist: it lacks the sentinel renderLaunchdPlist embeds). The
 * label prefix alone cannot tell ours from theirs (PP is com.iapeer.* too); the
 * sentinel can. Re-installing our OWN plist (sentinel present) is allowed
 * (idempotent re-provision). The guard is checked FIRST, before any mkdir/write, so
 * a refusal leaves the filesystem untouched.
 */
export function installAlwaysOnPlist(opts: InstallAlwaysOnPlistOptions): string {
  if (!isInfraRuntime(opts.runtime)) {
    throw new IapError(
      `runtime "${opts.runtime}" is not an always-on infra runtime; no launchd plist generated`,
    )
  }
  const env = opts.env ?? process.env
  // Collision guard FIRST — never clobber a plist the foundation does not own.
  const path = launchdPlistPath(opts.personality, env)
  if (existsSync(path) && !isFoundationOwnedPlist(path)) {
    throw new IapError(
      `refusing to overwrite launchd plist ${path}: label ${launchdLabel(opts.personality)} ` +
        `is not foundation-managed (no ${IAPEER_PLIST_OWNER_KEY} sentinel) — a persistent-peer ` +
        `or other manager owns it; rename the peer to avoid the com.iapeer.<personality> collision`,
    )
  }
  // GLOBAL infra logs (Фаза §8): ~/.iapeer/logs/<personality>/, NOT per-peer
  // <cwd>/.iapeer/logs/ — host-service logs live in the global log area.
  const logDir = peerLogsDir(opts.personality, { env })
  // Resolve home the SAME way launchAgentsDir does (env.HOME first) so a test/
  // sandbox overriding HOME keeps the PATH fallback and the plist dir in step.
  const home = env.HOME?.trim() || homedir()
  const defaultPath = `${home}/.bun/bin:${home}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`
  const environment: Record<string, string> = {
    PEER_PERSONALITY: opts.personality,
    PEER_RUNTIME: opts.runtime,
    PEER_IDENTITY: buildProcessAddress(opts.runtime, opts.personality),
    PATH: opts.path ?? env.PATH ?? defaultPath,
  }
  // Propagate the non-default path overrides into the plist env (mirror of the daemon
  // plist): in PRODUCTION these are unset → nothing is baked, the always-on
  // session uses the real ~/.iapeer + /tmp sockets (correct). In a SANDBOX they ARE set
  // → baked, so a sandboxed infra peer's run-infra resolves the SAME isolated root +
  // socket dir the provision used (its tmux endpoint lands in the sandbox, not /tmp).
  // This is what lets a live e2e proof be fully isolated AND leaves prod unchanged.
  for (const key of ['IAPEER_ROOT', 'IAPEER_SOCK_DIR', 'IAPEER_LAUNCHAGENTS_DIR'] as const) {
    if (env[key]?.trim()) environment[key] = env[key]!.trim()
  }
  // Pin the infra runtime's launcher to an ABSOLUTE path so launchd's minimal PATH
  // can find it (a bare name would crash-loop the always-on session). opts.runtimeBin
  // wins; else resolve the runtime's default bin against the rich provisioning
  // env.PATH. Unresolved → leave it out (the bare name + plist PATH still apply).
  const binEnvVar = INFRA_RUNTIME_BIN_ENV[opts.runtime]
  if (binEnvVar) {
    const resolved = opts.runtimeBin ?? resolveExecutable(INFRA_RUNTIME_DEFAULT_BIN[opts.runtime] ?? opts.runtime, env)
    if (resolved) environment[binEnvVar] = resolved
  }
  // Host-specific notifier fallback backstop (NOTIFIER_FALLBACK_TARGET): the final
  // human target the notifier's alarm chain falls back to when every other delivery
  // fails. DELIBERATELY host-resolved at generation time (like NOTIFIER_RUNTIME_BIN
  // above), NEVER a hardcoded literal — a baked peer name would ship in the public
  // package and inject a non-existent target into every foreign install's plist (the
  // exact foreign-install break the notifier package removed from its own default).
  // Source: env when the operator sets it, else PRESERVE the value already baked in
  // THIS host's existing plist so a regeneration (install-runtime rewrites the file)
  // never drops it. Unset on a fresh / foreign host → not baked → the notifier
  // package's own default applies. Notifier-only (the var is notifier-scoped).
  if (opts.runtime === 'notifier') {
    const fallback =
      env.NOTIFIER_FALLBACK_TARGET?.trim() ||
      (existsSync(path) ? readPlistEnvVar(path, 'NOTIFIER_FALLBACK_TARGET') : undefined)
    if (fallback) environment.NOTIFIER_FALLBACK_TARGET = fallback
  }
  const spec: LaunchdPlistSpec = {
    label: launchdLabel(opts.personality),
    programArguments: [...(opts.entrypointArgv ?? defaultEntrypointArgv(env)), opts.personality, opts.runtime],
    workingDirectory: opts.cwd,
    environment,
    stdoutPath: join(logDir, 'launchd-stdout.log'),
    stderrPath: join(logDir, 'launchd-stderr.log'),
    throttleIntervalSecs: opts.throttleIntervalSecs,
  }
  mkdirSync(launchAgentsDir(env), { recursive: true })
  // The global infra log dir now resolves under ~/.iapeer (Фаза §8). Under a sandbox
  // (test) run, NEVER mkdir under the REAL ~/.iapeer — a test that forgot IAPEER_ROOT
  // would otherwise create real ~/.iapeer/logs/<p>. Skip the mkdir then (the plist
  // still carries the path; a real run — no sandbox flag — always makes it). Consult
  // process.env too, since a test passes an explicit env without the flag. Mirror of
  // the registry/install fail-closed sandbox guards.
  const sandbox = env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1'
  const realRoot = join(homedir(), IAPEER_DIR)
  if (!(sandbox && logDir.startsWith(`${realRoot}/`))) {
    mkdirSync(logDir, { recursive: true, mode: 0o700 })
  }
  // В46 — fail-closed sandbox guard on the PLIST WRITE itself (symmetric to the mkdir
  // guard above and the registry/install guards): a sandboxed test that forgot
  // IAPEER_LAUNCHAGENTS_DIR must NEVER write a real ~/Library/LaunchAgents/
  // com.iapeer.<p>.plist — the live daemon reads that file as the H4 launchd-owned
  // marker, so a leaked test plist silently stops the daemon from waking the
  // matching peer (plist present but never loaded → peer reads as dead forever).
  const realAgents = join(homedir(), 'Library', 'LaunchAgents')
  if (sandbox && path.startsWith(`${realAgents}/`)) {
    throw new IapError(
      `refusing to write a REAL LaunchAgents plist (${path}) under IAPEER_TEST_SANDBOX=1 — ` +
        'set IAPEER_LAUNCHAGENTS_DIR to an isolated path',
    )
  }
  // В46 — atomic write (tmp + rename): an interrupted direct write leaves a TRUNCATED
  // plist without the ownership sentinel, which the collision guard above then reads
  // as foreign — the peer becomes permanently un-provisionable ("refused-foreign").
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, renderLaunchdPlist(spec), { mode: 0o644 })
  renameSync(tmp, path)
  return path
}
