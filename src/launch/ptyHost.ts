// Launch-side hosted-session orchestration (cutover Block 2 spawn-flip, Ф0a) — the supervisor-HOST
// equivalent of the tmux bring-up half of launch(): start the session under the supervisor, wait for
// readiness off its pane-log model (the supervisor's own boot-driver dismisses startup dialogs), and
// deliver the first message over its socket. Flag-gated per-peer (.pty-host); when the flag is off
// this module is never reached and launch is byte-identical (golden).
//
// @xterm STAYS OUT of the launch process by construction:
//   - startSupervisorDaemon is dynamic-imported and @xterm-free (daemon.ts is deferred to the detached
//     'daemon' subprocess) — it only SPAWNS the daemon, @xterm runs there;
//   - the deliver client is a pure-protocol leaf (no @xterm);
//   - sessionAlive comes from client.ts (no @xterm);
//   - readiness reuses paneLogViewport, whose @xterm import is dynamic and only loads flag-on.
import { existsSync, readFileSync } from 'node:fs'
import { deliverToHost, type DeliverResult } from '../supervisor/deliver.ts'
import { attachedPath, defaultRunDir, pidPath, readGeometry } from '../supervisor/paths.ts'
import { sessionAlive as hostDaemonAlive } from '../supervisor/client.ts'
import { killSession as killSupervisorSession, listSessions as listSupervisorSessions } from '../supervisor/index.ts'
import { parseSessionName } from '../core/socket.ts'
import type { TmuxRuntime } from '../core/constants.ts'
import { paneLogViewport } from './readyGateModel.ts'
import type { LaunchInvocation } from './invocation.ts'
import type { RuntimeAdapter } from './types.ts'

/** Match the tmux launch geometry (index.ts new-session -x 220 -y 50) so the served child + the
 *  pane-log model render at the same size launch reads readiness at. */
export const HOST_COLS = 220
export const HOST_ROWS = 50


/** The supervisor's run dir (session sockets/pids/serve-specs). Env-isolatable via IAPEER_ROOT. */
export function hostRunDir(): string {
  return defaultRunDir()
}

/**
 * Is there a LIVE supervisor session for this identity? This is the RUNTIME-STATE host detector the
 * warm surfaces (liveness / deliver / reap / attach / observer) route on — NOT the `.pty-host` marker.
 * The marker is spawn-INTENT (read by launch at spawn); deriving warm routing from the live session
 * means rolling the marker back (rm) on a STILL-RUNNING hosted session never tears it (rm affects only
 * the NEXT spawn). Rollback of a RUNNING hosted session is therefore kill-then-rm, NOT rm-alone.
 */
export function hostSessionAlive(identity: string): boolean {
  return hostDaemonAlive(hostRunDir(), identity)
}

/** Reap a hosted session: SIGTERM the supervisor daemon (its shutdown SIGKILLs the child + cleans up). */
export function killPtyHost(identity: string): void {
  killSupervisorSession(hostRunDir(), identity)
}

/**
 * Is a HUMAN operator attached to this hosted session right now? (spawn-flip Ф0b-3 slice 3c). The
 * supervisor daemon maintains a `.attached` marker present iff ≥1 client is connected (synced on every
 * client add/detach incl. abnormal close/error/drain, and cleared on daemon start so a crashed
 * predecessor's stale marker never lies). The warm-deliver busy-composer hold gates on THIS: hold for
 * a human's unfinished composer input, but NEVER for the AI's own composer output when no one is
 * attached. The host equivalent of `hasAttachedTmuxClient`.
 */
export function hasAttachedSupervisorClient(identity: string): boolean {
  return existsSync(attachedPath(hostRunDir(), identity))
}

/** Current child pty geometry of a hosted session, from the supervisor's `<session>.geometry.json`
 *  sidecar, or HOST defaults when absent/unreadable. Warm-deliver occupancy / ready-gate readers use THIS
 *  rather than assuming the fixed HOST geometry, because a DETACHED session keeps its last client geometry
 *  (the child is no longer reverted to serve on detach — that revert caused the reattach-duplicate bug).
 *  Reading the actual geometry keeps the pane-log composer-occupancy model aligned with the real pty size. */
export function hostGeometry(identity: string): { cols: number; rows: number } {
  return readGeometry(hostRunDir(), identity) ?? { cols: HOST_COLS, rows: HOST_ROWS }
}

/**
 * A session-REPLACEMENT token for a hosted session (spawn-flip Ф0b-3 slice 3c): the supervisor
 * daemon's pid. A `/new` or restart spawns a NEW daemon (new pid), so a message queued against the old
 * session FAILS rather than landing in a fresh same-named session — the host equivalent of the tmux
 * `session_id:pane_id` token. null when no daemon pid is readable.
 */
export function hostSessionToken(identity: string): string | null {
  try {
    const pid = readFileSync(pidPath(hostRunDir(), identity), 'utf8').trim()
    return pid ? `host:${pid}` : null
  } catch {
    return null
  }
}

/**
 * Online supervisor-HOSTED peers (spawn-flip Ф0b-3): live sessions in the supervisor run-dir. A hosted
 * peer has NO tmux socket, so the tmux-based listOnlinePeers scan can't see it — this lets the online
 * scan (and the no-runtime delivery resolve) include hosted peers. Empty + cheap when flag-off (the
 * run-dir is empty).
 */
export function listHostedPeers(): Array<{ runtime: TmuxRuntime; personality: string }> {
  const out: Array<{ runtime: TmuxRuntime; personality: string }> = []
  for (const s of listSupervisorSessions(hostRunDir())) {
    if (!s.alive) continue
    const p = parseSessionName(s.session)
    if (p) out.push({ runtime: p.runtime, personality: p.personality })
  }
  return out
}

export interface HostStartResult {
  ok: boolean
  error?: string
}

/**
 * Bring up the hosted session: start a detached supervisor daemon serving the composed invocation
 * (argv+env from buildLaunchInvocation), writing the pane-log at `paneLogPath`. Returns ok/fail so
 * launch can fall back to `tmux new-session` on failure (the unconditional spawn-fallback — a flipped
 * peer is never worse than tmux ON SPAWN).
 */
export async function startPtyHost(b: {
  identity: string
  runtime: string
  cwd: string
  paneLogPath: string
  exitLogPath?: string
  invocation: LaunchInvocation
}): Promise<HostStartResult> {
  try {
    const { startSupervisorDaemon } = await import('../supervisor/index.ts')
    const r = await startSupervisorDaemon({
      session: b.identity,
      runtime: b.runtime,
      runDir: hostRunDir(),
      serve: {
        argv: b.invocation.argv,
        env: b.invocation.env as Record<string, string>,
        cwd: b.cwd,
        paneLogPath: b.paneLogPath,
        exitLogPath: b.exitLogPath,
        cols: HOST_COLS,
        rows: HOST_ROWS,
      },
    })
    return r.state === 'failed' ? { ok: false, error: r.detail ?? 'supervisor host failed to come up' } : { ok: true }
  } catch (e) {
    return { ok: false, error: `pty-host bringup threw: ${(e as Error).message}` }
  }
}

/**
 * Wait for the hosted input surface to be ready: poll the pane-log model and run the adapter's
 * isInputReady (the supervisor's boot-driver answers dialogs internally, so launch does NOT drive
 * them). Returns true when ready, false on deadline / session death. Mirrors the tmux boot loop's
 * 2 s cadence + bootDeadline.
 */
export async function waitHostReady(
  b: { identity: string; logDir: string; adapter: RuntimeAdapter; bootDeadlineSecs: number; paneLogStartByte?: number },
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const log = `${b.logDir}/${b.identity}.log`
  const iters = Math.max(1, Math.ceil(b.bootDeadlineSecs / 2))
  // paneLogStartByte = the pane-log size at THIS session's spawn (captured by launch before the
  // supervisor opens the shared append-only log). Passing it to the model render confines readiness to
  // bytes THIS session wrote — without it a prior session's trailing `❯ ready` frame in the shared log
  // satisfies isInputReady before the fresh runtime paints, causing a premature deliver into a booting
  // session (the first message is then lost). See readyGateModel.loadPaneLogModel.
  for (let i = 0; i < iters; i++) {
    await sleep(2000)
    if (!hostSessionAlive(b.identity)) return false
    const view = await paneLogViewport(log, HOST_COLS, HOST_ROWS, b.paneLogStartByte ?? 0)
    if (view && b.adapter.isInputReady(view)) return true
  }
  return false
}

/** Deliver the first/next message to the hosted session over its supervisor socket. */
export function deliverHosted(identity: string, message: string): Promise<DeliverResult> {
  return deliverToHost(hostRunDir(), identity, message)
}
