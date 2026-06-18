// Code-managed install / teardown / update-recycle for the read-only tmux→pty fidelity
// BURN-IN job (`iapeer shadow`). The OBSERVER itself is src/shadow/index.ts (it loads
// @xterm/headless); THIS module is PURE launchd plumbing — it imports NO @xterm — so the
// deploy path (update/rollback) and the CLI can install/recycle the job without pulling the
// terminal emulator into their import graph (the daemon hot path stays @xterm-free).
//
// The job is a foundation-OWNED, always-on launchd LaunchAgent (com.iapeer.shadow-fidelity)
// running the INSTALLED binary `iapeer shadow`. It is NOT a registry peer — it receives no
// IAP and has no peer profile — so recycleFoundationOwnedInfraJobs' registry SCAN cannot see
// it; cycleShadowJob recycles it by LABEL instead. It carries the same ownership sentinel as
// every foundation plist, so the collision guard (install) and the recycle guard both
// recognize it as ours. KeepAlive owns its lifecycle; stop it with `iapeer shadow-uninstall`
// (bootout + rm), NEVER the STOP sentinel file (KeepAlive would just respawn straight past it).

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { IAPEER_DIR } from '../core/constants.ts'
import { IapError } from '../core/errors.ts'
import { iapeerBinPath } from '../install/index.ts'
import { pluginLogsDir } from '../storage/index.ts'
import {
  cycleLaunchdJob,
  isFoundationOwnedPlist,
  launchAgentsDir,
  launchctlBootstrap,
  launchdLabel,
  renderLaunchdPlist,
  type LaunchdJobCycleResult,
  type LaunchdPlistSpec,
} from '../launch/launchd.ts'

/** The burn-in job's personality stem → label com.iapeer.shadow-fidelity (the running job). */
export const SHADOW_PERSONALITY = 'shadow-fidelity'
/** com.iapeer.shadow-fidelity — keyed through launchdLabel so the scheme has ONE source. */
export const SHADOW_PLIST_LABEL = launchdLabel(SHADOW_PERSONALITY)

export function shadowPlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(launchAgentsDir(env), `${SHADOW_PLIST_LABEL}.plist`)
}

/** The STOP sentinel the observer polls (under <eventLogDir>=~/.iapeer/logs/iapeer). Under
 *  KeepAlive a STALE one would respawn the observer straight into an immediate exit → a
 *  throttle-storm, so installShadowJob clears it before (re)loading. */
function shadowStopFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(pluginLogsDir('iapeer', { env }), 'shadow-fidelity.STOP')
}

function inSandbox(env: NodeJS.ProcessEnv): boolean {
  return env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1'
}

/** Resolve the gui-domain uid, or null when `id -u` is non-numeric (never assume 0). */
function uidOrNull(): string | null {
  const u = (spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout ?? '').trim()
  return /^\d+$/.test(u) ? u : null
}

/** Is com.iapeer.shadow-fidelity currently loaded in the gui domain? */
function isShadowLoaded(): boolean {
  const uid = uidOrNull()
  if (!uid) return false
  return spawnSync('launchctl', ['print', `gui/${uid}/${SHADOW_PLIST_LABEL}`], { stdio: 'ignore' }).status === 0
}

/**
 * Build the burn-in job's launchd plist spec (PURE — render/lint-testable). Runs the
 * INSTALLED `iapeer shadow` (prod decoupled from the src tree). The launchd-minimal PATH
 * MUST include /opt/homebrew/bin: the observer shells READ-ONLY tmux (capture-pane /
 * has-session / display), and tmux lives there — a bare PATH would make every tmux probe
 * fail (no peers enumerated). Deterministic (curated PATH, not env.PATH) so the rendered
 * plist is byte-stable across deploys → installShadowPlist's write-if-changed stays a no-op
 * when nothing actually changed (no Background Task Management notification spam).
 */
export function buildShadowPlistSpec(env: NodeJS.ProcessEnv = process.env): LaunchdPlistSpec {
  const home = env.HOME?.trim() || homedir()
  const defaultPath = `${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  const logDir = pluginLogsDir('iapeer', { env })
  const environment: Record<string, string> = { PATH: env.IAPEER_SHADOW_PATH?.trim() || defaultPath }
  // Sandbox/test parity (mirror of installDaemonPlist / installAlwaysOnPlist): bake the
  // non-default root overrides so a SANDBOXED install resolves the SAME isolated tree the
  // observer reads. In production these are unset → nothing baked, real ~/.iapeer + /tmp used.
  for (const key of ['IAPEER_ROOT', 'IAPEER_SOCK_DIR', 'IAPEER_LAUNCHAGENTS_DIR'] as const) {
    if (env[key]?.trim()) environment[key] = env[key]!.trim()
  }
  return {
    label: SHADOW_PLIST_LABEL,
    programArguments: [iapeerBinPath(env), 'shadow'],
    workingDirectory: home, // cwd-agnostic (the observer resolves paths from IAPEER_ROOT/cfg)
    environment,
    stdoutPath: join(logDir, 'shadow-fidelity.launchd-stdout.log'),
    stderrPath: join(logDir, 'shadow-fidelity.launchd-stderr.log'),
  }
}

export interface InstallShadowPlistResult {
  path: string
  /** false when the on-disk plist already matched byte-for-byte → NO write (no BTM spam). */
  changed: boolean
}

/**
 * Write the burn-in plist (file only — does NOT load it). IDEMPOTENT BY CONTENT
 * (write-if-changed, mirror of installDaemonPlist: a byte-identical rewrite trips the owner's
 * Background Task Management notification for zero benefit). Collision guard: refuses to
 * overwrite a com.iapeer.shadow-fidelity.plist that lacks the ownership sentinel (a foreign
 * manager owns it) — the guard fires FIRST, before any mkdir/write, so a refusal leaves the
 * filesystem untouched.
 */
export function installShadowPlist(env: NodeJS.ProcessEnv = process.env): InstallShadowPlistResult {
  const path = shadowPlistPath(env)
  if (existsSync(path) && !isFoundationOwnedPlist(path)) {
    throw new IapError(
      `refusing to overwrite ${path}: ${SHADOW_PLIST_LABEL} exists but is not foundation-managed ` +
        `(no ownership sentinel) — another manager owns it`,
    )
  }
  const rendered = renderLaunchdPlist(buildShadowPlistSpec(env))
  mkdirSync(launchAgentsDir(env), { recursive: true })
  // Never mkdir the REAL ~/.iapeer log dir under a sandbox that forgot IAPEER_ROOT (mirror
  // installAlwaysOnPlist's guard); a real run (no sandbox flag) always makes it.
  const logDir = pluginLogsDir('iapeer', { env })
  const realRoot = join(homedir(), IAPEER_DIR)
  if (!(inSandbox(env) && logDir.startsWith(`${realRoot}/`))) {
    mkdirSync(logDir, { recursive: true, mode: 0o700 })
  }
  let existing: string | null = null
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    existing = null
  }
  if (existing === rendered) return { path, changed: false }
  writeFileSync(path, rendered, { mode: 0o644 })
  return { path, changed: true }
}

export type ShadowJobAction =
  | 'loaded' // bootstrapped now (was not loaded)
  | 'reloaded' // plist changed on an already-loaded job → bootout+bootstrap applied the new one
  | 'already-loaded' // loaded and the plist did not change → left running untouched
  | 'refused-foreign' // a non-foundation plist sits at the label → never loaded
  | 'failed' // launchctl bootstrap/cycle failed (detail carries the rescue recipe)
  | 'skipped-sandbox' // IAPEER_TEST_SANDBOX=1 → never touch real launchd

export interface InstallShadowJobResult extends InstallShadowPlistResult {
  action: ShadowJobAction
  detail?: string
}

/**
 * Install the burn-in plist AND ensure the job is live: write-if-changed, clear a stale STOP
 * sentinel, then load it (or RELOAD via bootout+bootstrap when the plist content changed on
 * an already-loaded job — bootstrap alone is idempotent and would NOT pick up a changed
 * plist). Idempotent: a repeat call on an unchanged, loaded job is a no-op ('already-loaded').
 * Sandbox-safe: under IAPEER_TEST_SANDBOX it writes the (overridden-dir) plist FILE but never
 * calls launchctl ('skipped-sandbox'). This is the code-managed replacement for a hand-written
 * burn-in plist — reproducible, ownership-sentinel-guarded, fleet-deployable.
 */
export function installShadowJob(env: NodeJS.ProcessEnv = process.env): InstallShadowJobResult {
  const { path, changed } = installShadowPlist(env)
  if (inSandbox(env)) return { path, changed, action: 'skipped-sandbox' }
  // Clear a STALE STOP sentinel BEFORE (re)loading — else KeepAlive respawns the observer
  // into an instant exit (it polls the STOP file) → 10s-throttled respawn storm.
  try {
    unlinkSync(shadowStopFile(env))
  } catch {
    /* none present */
  }
  if (isShadowLoaded()) {
    if (!changed) return { path, changed, action: 'already-loaded' }
    const c = cycleLaunchdJob(SHADOW_PLIST_LABEL, path, env)
    return c.state === 'restarted'
      ? { path, changed, action: 'reloaded' }
      : { path, changed, action: 'failed', detail: c.detail }
  }
  const b = launchctlBootstrap(SHADOW_PERSONALITY, path, env)
  const action: ShadowJobAction =
    b.state === 'loaded'
      ? 'loaded'
      : b.state === 'already-loaded'
        ? 'already-loaded'
        : b.state === 'refused-foreign'
          ? 'refused-foreign'
          : b.state === 'skipped-sandbox'
            ? 'skipped-sandbox'
            : 'failed'
  return { path, changed, action, detail: b.detail }
}

/**
 * Recycle the burn-in job by LABEL after a binary swap (deploy path). The plist runs the
 * just-replaced `iapeer shadow` off the same binary, so the SAME LWCR managed-launch-constraint
 * bomb that bit the daemon (EX_CONFIG(78) on a KeepAlive respawn into the stale constraint)
 * applies here too — only a full bootout→bootstrap clears it. It is NOT a registry peer, so
 * recycleFoundationOwnedInfraJobs' registry scan misses it; this cycles it directly. Only
 * touches a LOADED, foundation-owned job: absent / foreign / not-loaded → null (no-op).
 * Sandbox-safe (cycleLaunchdJob returns skipped-sandbox under the test flag).
 */
export function cycleShadowJob(env: NodeJS.ProcessEnv = process.env): LaunchdJobCycleResult | null {
  const path = shadowPlistPath(env)
  if (!existsSync(path) || !isFoundationOwnedPlist(path)) return null
  return cycleLaunchdJob(SHADOW_PLIST_LABEL, path, env)
}

export type ShadowUninstallAction =
  | 'booted-out' // job was loaded → booted out, plist removed
  | 'removed-not-loaded' // plist removed, job was not loaded
  | 'absent' // nothing to do (no plist)
  | 'refused-foreign' // the plist is not foundation-owned → left untouched
  | 'skipped-sandbox'
  | 'failed'

export interface UninstallShadowJobResult {
  path: string
  action: ShadowUninstallAction
  detail?: string
}

/**
 * Stop and remove the burn-in job — the CORRECT way to halt it (the STOP sentinel would be
 * respawned past by KeepAlive): bootout the loaded job, then delete the plist. Refuses a
 * non-foundation plist (ownership guard). Sandbox-safe. Reversibility for the install verb.
 */
export function uninstallShadowJob(env: NodeJS.ProcessEnv = process.env): UninstallShadowJobResult {
  const path = shadowPlistPath(env)
  if (!existsSync(path)) return { path, action: 'absent' }
  if (!isFoundationOwnedPlist(path)) {
    return { path, action: 'refused-foreign', detail: `${path} is not foundation-owned — not booting it out` }
  }
  if (inSandbox(env)) return { path, action: 'skipped-sandbox' }
  let action: ShadowUninstallAction = 'removed-not-loaded'
  if (isShadowLoaded()) {
    const uid = uidOrNull()
    const r = uid
      ? spawnSync('launchctl', ['bootout', `gui/${uid}/${SHADOW_PLIST_LABEL}`], { encoding: 'utf8' })
      : { status: 1, stderr: 'cannot resolve uid' }
    if (r.status !== 0 && isShadowLoaded()) {
      return { path, action: 'failed', detail: `launchctl bootout failed: ${(r.stderr ?? '').trim() || `exit ${r.status}`}` }
    }
    action = 'booted-out'
  }
  // Also clear any STOP sentinel so a later reinstall starts clean.
  try {
    unlinkSync(shadowStopFile(env))
  } catch {
    /* none */
  }
  try {
    rmSync(path)
  } catch {
    /* best-effort */
  }
  return { path, action }
}
