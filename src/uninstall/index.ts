// uninstall — symmetric removal of THIS foundation install (the install.sh / `iapeer
// install` / onboard artifacts). NAMESPACE-SAFE: it never touches a foreign
// persistent-peer fleet. A peer plist at the shared `com.iapeer.*` namespace WITHOUT
// the ownership sentinel is foreign; if ANY is present we REFUSE (option-1) — removing
// ~/.iapeer would nuke the fleet's own state, which H4 forbids. The operator removes
// their peers first (`iapeer remove <p>`), then uninstalls.
//
// Removed: ~/.local/bin/iapeer (+ .prev) · the daemon plist (com.agfpd.iapeer,
// bootout→rm) · foundation-OWNED infra jobs (sentinel-marked com.iapeer.*, bootout→rm)
// · the ~/.iapeer scaffold · the installer's PATH lines in the shell profile.
// CONSERVATIVE (kept by default): the shared agfpd-stack codesign identity (removed
// only with removeCodesignIdentity) and bun (the user's). Plan is read-only — `--dry-run`
// renders it without touching anything. Fail-closed in the test sandbox: a real
// ~/.iapeer / ~/.local/bin path under IAPEER_TEST_SANDBOX=1 throws (tests must inject
// temp roots), so a hermetic test can never delete the real install.

import { spawnSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { buildProcessAddress, DAEMON_PLIST_LABEL, IapError } from '../core/index.ts'
import { iapeerBinPath, iapeerHealthyStampPath } from '../install/index.ts'
import { SIGNING_IDENTITY_CN } from '../install/signing.ts'
import { daemonPlistPath } from '../daemon/main.ts'
import { hostSessionAlive, killPtyHost, listHostedPeers } from '../launch/ptyHost.ts'
import { isFoundationOwnedPlist, launchAgentsDir } from '../launch/launchd.ts'
import { resolveGlobalRoot } from '../storage/index.ts'

/** The marker comment install.sh writes above its PATH line (strip both lines). */
const INSTALLER_PROFILE_MARKER = '# Added by the iapeer installer'

export type UninstallActionKind =
  | 'remove-file'
  | 'remove-dir'
  | 'bootout-remove-plist'
  | 'stop-pty-sessions'
  | 'strip-profile-lines'
  | 'remove-keychain-identity'

export interface UninstallItem {
  what: string
  action: UninstallActionKind
  path?: string
  /** True when the artifact exists / there is something to do (dry-run shows all;
   *  absent ones render as "already gone"). */
  present: boolean
  detail?: string
}

export interface UninstallPlan {
  items: UninstallItem[]
  /** Set when a FOREIGN persistent-peer fleet is present → the whole uninstall is
   *  refused (option-1, H4-safe). The caller prints the guidance and aborts. */
  refused?: { reason: string; foreignLabels: string[] }
}

/** Injected launchctl/security runner (tests). Default: real spawnSync. */
export type SysRunner = (cmd: string, args: string[]) => { status: number | null; stderr: string }

export interface UninstallOptions {
  env?: NodeJS.ProcessEnv
  /** --remove-codesign-identity: also delete the SHARED agfpd-stack signing identity. */
  removeCodesignIdentity?: boolean
  /** Injected sys runner (launchctl / security) for hermetic tests. */
  run?: SysRunner
  /** В56 — how long to wait for a booted-out launchd job to actually unload before
   *  declaring it stuck (default 10 s; tests inject a short value). */
  launchdWaitMs?: number
  /** В55 — how long to wait for SIGTERM'd pty sessions to die (default 8 s). */
  sessionWaitMs?: number
}

const defaultRun: SysRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return { status: r.status, stderr: (r.stderr ?? '').trim() }
}

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir()
}

/** Shell-profile files the installer may have edited (per its $SHELL branch). */
function profileFiles(env: NodeJS.ProcessEnv): string[] {
  const h = home(env)
  return [join(h, '.zshrc'), join(h, '.bash_profile'), join(h, '.profile')]
}

/** All com.iapeer.*.plist in LaunchAgents, split into foundation-owned (sentinel)
 *  vs foreign (the persistent-peer fleet). */
function scanInfraPlists(env: NodeJS.ProcessEnv): { owned: string[]; foreign: string[] } {
  const dir = launchAgentsDir(env)
  const owned: string[] = []
  const foreign: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return { owned, foreign }
  }
  for (const e of entries) {
    if (!e.startsWith('com.iapeer.') || !e.endsWith('.plist')) continue
    const p = join(dir, e)
    ;(isFoundationOwnedPlist(p) ? owned : foreign).push(p)
  }
  return { owned, foreign }
}

/** Fail-closed: under the test sandbox, refuse to operate on the REAL install paths
 *  (a hermetic test MUST inject temp roots). Mirrors installIapeer's guard. */
function assertSandboxSafe(env: NodeJS.ProcessEnv): void {
  if (env.IAPEER_TEST_SANDBOX !== '1' && process.env.IAPEER_TEST_SANDBOX !== '1') return
  const root = resolveGlobalRoot(env)
  const realRoot = join(homedir(), '.iapeer')
  const bin = iapeerBinPath(env)
  const realBin = join(homedir(), '.local', 'bin', 'iapeer')
  if (root === realRoot || bin === realBin) {
    throw new IapError(
      'refusing to uninstall the REAL install under IAPEER_TEST_SANDBOX=1 — inject IAPEER_ROOT / IAPEER_BIN_DIR temp paths',
    )
  }
}

/** Read-only: compute what an uninstall would remove + the foreign-fleet refusal. */
export function planUninstall(opts: UninstallOptions = {}): UninstallPlan {
  const env = opts.env ?? process.env
  const { owned, foreign } = scanInfraPlists(env)

  if (foreign.length > 0) {
    const foreignLabels = foreign.map(p => p.replace(/\.plist$/, '').split('/').pop() ?? p)
    return {
      items: [],
      refused: {
        foreignLabels,
        reason:
          `persistent-peer fleet present (${foreignLabels.join(', ')}). Removing ~/.iapeer would ` +
          `destroy their state. Remove those peers first (\`iapeer remove <peer>\`), then re-run uninstall.`,
      },
    }
  }

  const bin = iapeerBinPath(env)
  const prev = `${bin}.prev`
  const dPlist = daemonPlistPath(env)
  const root = resolveGlobalRoot(env)
  const items: UninstallItem[] = []

  // launchd: daemon first, then foundation-owned infra jobs (bootout → rm).
  items.push({
    what: `daemon job ${DAEMON_PLIST_LABEL}`,
    action: 'bootout-remove-plist',
    path: dPlist,
    present: existsSync(dPlist),
  })
  for (const p of owned) {
    items.push({
      what: `infra job ${p.replace(/\.plist$/, '').split('/').pop()}`,
      action: 'bootout-remove-plist',
      path: p,
      present: true,
    })
  }

  // В55 — live warm-on-demand pty sessions (detached supervisors, NO plist: the
  // launchd guard above cannot see them). Their run-dir/state live INSIDE ~/.iapeer —
  // removing the tree under ~30 running agent processes leaves an orphaned live
  // fleet working out of deleted directories. Stop them FIRST (before remove-dir).
  const hosted = listHostedPeers(env).map(h => buildProcessAddress(h.runtime, h.personality))
  items.push({
    what: `live pty sessions (${hosted.length ? hosted.join(', ') : 'none'})`,
    action: 'stop-pty-sessions',
    present: hosted.length > 0,
    detail: hosted.length ? 'will be stopped before ~/.iapeer is removed' : undefined,
  })

  items.push({ what: 'binary ~/.local/bin/iapeer', action: 'remove-file', path: bin, present: existsSync(bin) })
  items.push({ what: 'previous binary (.prev)', action: 'remove-file', path: prev, present: existsSync(prev) })
  items.push({
    what: 'healthy-stamp (.healthy)',
    action: 'remove-file',
    path: iapeerHealthyStampPath(env),
    present: existsSync(iapeerHealthyStampPath(env)),
  })
  items.push({ what: 'state + config ~/.iapeer', action: 'remove-dir', path: root, present: existsSync(root) })

  for (const pf of profileFiles(env)) {
    const has = existsSync(pf) && readFileSync(pf, 'utf8').includes(INSTALLER_PROFILE_MARKER)
    if (has) items.push({ what: `PATH line in ${pf}`, action: 'strip-profile-lines', path: pf, present: true })
  }

  items.push({
    what: `codesign identity "${SIGNING_IDENTITY_CN}"`,
    action: 'remove-keychain-identity',
    present: opts.removeCodesignIdentity === true,
    detail: opts.removeCodesignIdentity
      ? 'will remove (shared agfpd-stack identity — other agfpd products re-prompt on next update)'
      : 'KEPT (shared agfpd-stack identity) — pass --remove-codesign-identity to remove',
  })

  return { items }
}

export interface UninstallResult {
  removed: string[]
  skipped: string[]
  failed: { what: string; detail: string }[]
  refused?: { reason: string; foreignLabels: string[] }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** В56 — poll `launchctl print gui/<uid>/<label>` until the job is GONE (print exits
 *  non-zero) or the deadline passes. bootout is ASYNC in launchd: firing rm/rmdir the
 *  moment it returns races the dying daemon's shutdown writes (recreated fragments)
 *  and, on a bootout failure, leaves an orphaned KeepAlive job holding the port while
 *  the item reads "removed". Same wait-for-gone contract the update cycle uses. */
async function waitJobGone(run: SysRunner, uid: number, label: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (run('launchctl', ['print', `gui/${uid}/${label}`]).status !== 0) return true // not loaded → gone
    if (Date.now() >= deadline) return false
    await sleep(250)
  }
}

/** В55 — stop every live warm-on-demand pty session (SIGTERM the supervisor daemon,
 *  wait for its pidfile-liveness to drop). Best-effort per session; reports laggards. */
async function stopHostedSessions(env: NodeJS.ProcessEnv, timeoutMs = 8000): Promise<{ stopped: string[]; stuck: string[] }> {
  const identities = listHostedPeers(env).map(h => buildProcessAddress(h.runtime, h.personality))
  for (const id of identities) {
    try {
      killPtyHost(id, env)
    } catch {
      /* verified-dead / permission — the wait below reports it */
    }
  }
  const deadline = Date.now() + timeoutMs
  let pending = identities
  while (pending.length > 0 && Date.now() < deadline) {
    await sleep(250)
    pending = pending.filter(id => hostSessionAlive(id, env))
  }
  return { stopped: identities.filter(id => !pending.includes(id)), stuck: pending }
}

/** Remove a foundation install per the plan. Refuses if a foreign fleet is present.
 *  Ordering contract: live pty sessions are stopped and launchd jobs are FULLY
 *  unloaded (wait-for-gone) BEFORE ~/.iapeer is removed — a failed unload FAILS the
 *  remove-dir step (never delete the tree out from under a still-running daemon). */
export async function executeUninstall(opts: UninstallOptions = {}): Promise<UninstallResult> {
  const env = opts.env ?? process.env
  assertSandboxSafe(env)
  const run = opts.run ?? defaultRun
  const plan = planUninstall(opts)
  const res: UninstallResult = { removed: [], skipped: [], failed: [] }
  if (plan.refused) {
    res.refused = plan.refused
    return res
  }

  const uid = process.getuid?.() ?? 0
  // Set when a launchd job survived bootout (В56) — ~/.iapeer must NOT be removed
  // from under a job launchd may respawn (KeepAlive) into the deleted tree.
  let jobStillLoaded: string | undefined
  for (const item of plan.items) {
    if (!item.present) {
      res.skipped.push(item.what)
      continue
    }
    try {
      switch (item.action) {
        case 'bootout-remove-plist': {
          const label = (item.path ?? '').replace(/\.plist$/, '').split('/').pop() ?? ''
          run('launchctl', ['bootout', `gui/${uid}/${label}`]) // not-loaded → non-zero, benign (wait-for-gone verifies)
          if (!(await waitJobGone(run, uid, label, opts.launchdWaitMs))) {
            jobStillLoaded = label
            res.failed.push({ what: item.what, detail: `job ${label} still loaded after bootout (wait-for-gone timeout)` })
            continue // plist kept — the operator can bootout manually and re-run
          }
          if (item.path) rmSync(item.path, { force: true })
          break
        }
        case 'stop-pty-sessions': {
          const r = await stopHostedSessions(env, opts.sessionWaitMs)
          if (r.stuck.length > 0) {
            res.failed.push({ what: item.what, detail: `still alive after SIGTERM+wait: ${r.stuck.join(', ')}` })
            continue
          }
          break
        }
        case 'remove-file':
          if (item.path) rmSync(item.path, { force: true })
          break
        case 'remove-dir': {
          if (jobStillLoaded) {
            res.failed.push({
              what: item.what,
              detail: `NOT removed — launchd job ${jobStillLoaded} is still loaded (KeepAlive would respawn into a deleted tree); bootout it manually, then re-run uninstall`,
            })
            continue
          }
          if (item.path) rmSync(item.path, { recursive: true, force: true })
          break
        }
        case 'strip-profile-lines':
          if (item.path) stripInstallerLines(item.path)
          break
        case 'remove-keychain-identity':
          run('security', ['delete-identity', '-c', SIGNING_IDENTITY_CN])
          break
      }
      res.removed.push(item.what)
    } catch (e) {
      res.failed.push({ what: item.what, detail: e instanceof Error ? e.message : String(e) })
    }
  }
  return res
}

/** Remove the installer's marker comment + the export PATH line it precedes. */
function stripInstallerLines(profile: string): void {
  const lines = readFileSync(profile, 'utf8').split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() === INSTALLER_PROFILE_MARKER) {
      // skip the marker AND the following export PATH line the installer wrote
      if (lines[i + 1]?.includes('.local/bin')) i++
      continue
    }
    out.push(lines[i]!)
  }
  writeFileSync(profile, out.join('\n'), { mode: 0o644 })
}
