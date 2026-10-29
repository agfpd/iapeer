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
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deliverToHost, sendControlToHost, type DeliverResult } from '../supervisor/deliver.ts'
import { attachedPath, defaultRunDir, pidPath, readGeometry } from '../supervisor/paths.ts'
import { sessionAlive as hostDaemonAlive } from '../supervisor/client.ts'
import { killSession as killSupervisorSession, listSessions as listSupervisorSessions, type TerminationContext } from '../supervisor/index.ts'
import { parseSessionName } from '../core/socket.ts'
import type { TmuxRuntime } from '../core/constants.ts'
import { paneLogViewport } from './readyGateModel.ts'
import type { LaunchInvocation } from './invocation.ts'
import type { ApprovalMode, RuntimeAdapter } from './types.ts'

/** Match the tmux launch geometry (index.ts new-session -x 220 -y 50) so the served child + the
 *  pane-log model render at the same size launch reads readiness at. */
export const HOST_COLS = 220
export const HOST_ROWS = 50


/** The supervisor's run dir (session sockets/pids/serve-specs). Resolved from the INJECTED env so a
 *  sandboxed caller (cfg.env) never touches the real ~/.iapeer/state/supervisor — the isolation
 *  invariant. Defaults to process.env for the prod daemon (env === process.env). */
export function hostRunDir(env: NodeJS.ProcessEnv = process.env): string {
  return defaultRunDir(env)
}

/**
 * Is there a LIVE supervisor session for this identity? This is the RUNTIME-STATE host detector the
 * warm surfaces (liveness / deliver / reap / attach / observer) route on — NOT the `.pty-host` marker.
 * The marker is spawn-INTENT (read by launch at spawn); deriving warm routing from the live session
 * means rolling the marker back (rm) on a STILL-RUNNING hosted session never tears it (rm affects only
 * the NEXT spawn). Rollback of a RUNNING hosted session is therefore kill-then-rm, NOT rm-alone.
 */
export function hostSessionAlive(identity: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return hostDaemonAlive(hostRunDir(env), identity)
}

// ─── Runtime READINESS (incident 18.10) ──────────────────────────────────────
// «Alive» (the supervisor daemon's pid) is not «the runtime is up». A codex process hung before main
// (dyld, after a cask update) lived under a healthy supervisor for 35 min: `list` showed ●, a send
// went «live» and was confirmed ok (the cooked tty echoed the paste into the pane-log), and the ledger
// held the message as in-progress. The invariant: a session that never reached its runtime's ready
// surface is NOT live for delivery/list. Operator controls still address the hung process.
// The launch writes this marker (the hosting token) the moment its ready-gate passes; a marker from
// another hosting (a replaced session) does not count.

function readyPath(identity: string, env: NodeJS.ProcessEnv): string {
  return join(hostRunDir(env), `${identity}.ready`)
}

/** Record that THIS hosting of the identity reached its runtime's ready surface. */
export function markHostReady(identity: string, env: NodeJS.ProcessEnv = process.env, token = hostSessionToken(identity, env)): void {
  if (!token || token !== hostSessionToken(identity, env)) throw new Error(`hosting changed before ready: ${identity}`)
  writeFileSync(readyPath(identity, env), `${token}\n`, { mode: 0o600 })
}

export function clearHostReady(identity: string, env: NodeJS.ProcessEnv = process.env, runDir = hostRunDir(env)): void {
  rmSync(join(runDir, `${identity}.ready`), { force: true })
}

/** When this hosting started (its supervisor pid-file mtime), or null. */
export function hostStartedMs(identity: string, env: NodeJS.ProcessEnv = process.env, runDir = hostRunDir(env)): number | null {
  try {
    return statSync(pidPath(runDir, identity)).mtimeMs
  } catch {
    return null
  }
}

/** Alive AND this very hosting reached ready. */
export function hostSessionReady(identity: string, env: NodeJS.ProcessEnv = process.env, runDir = hostRunDir(env)): boolean {
  if (!hostDaemonAlive(runDir, identity)) return false
  const token = hostSessionToken(identity, env, runDir)
  try {
    return !!token && readFileSync(join(runDir, `${identity}.ready`), 'utf8').trim() === token
  } catch {
    return false
  }
}

/**
 * One-time compatibility for sessions that were already running when the readiness marker was
 * introduced. Prove readiness in each current host, without trusting historical pane-log frames.
 */
export async function backfillHostReady(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const out: string[] = []
  for (const h of listHostedPeers(env)) {
    const id = `${h.runtime}-${h.personality}`
    if (existsSync(readyPath(id, env))) continue
    const token = hostSessionToken(id, env)
    // Migration must prove readiness too: blindly stamping legacy pids re-labels a dyld hang as live.
    const { getAdapter } = await import('./index.ts')
    const adapter = getAdapter(h.runtime)
    if (h.runtime === 'opencode') {
      const { opencodeControl } = await import('../opencode/control.ts')
      const { opencodePaths } = await import('../opencode/config.ts')
      const ping = await opencodeControl(join(opencodePaths(h.personality, { env }).dir, 'control.sock'), { op: 'ping' }, 1000)
      if (!ping.ok) continue
    } else if (adapter.kind !== 'router') {
      const { captureHostViewport } = await import('../supervisor/capture.ts')
      const view = await captureHostViewport(hostRunDir(env), id)
      if (!view || !adapter.isInputReady(view, 'gated')) continue
    }
    markHostReady(id, env, token)
    out.push(id)
  }
  return out
}

/** Reap a hosted session: SIGTERM the supervisor daemon (hard-kills its PTY-owned tree + cleans up).
 *  env sandboxes the run-dir: a test with an injected root must NEVER SIGTERM a real fleet peer. */
export function killPtyHost(identity: string, env: NodeJS.ProcessEnv = process.env, context: TerminationContext = {}, runDir = hostRunDir(env)): void {
  killSupervisorSession(runDir, identity, { ...context, sandbox: context.sandbox || env.IAPEER_TEST_SANDBOX === '1',
    caller: context.caller ?? env.PEER_IDENTITY ?? (env.PEER_PERSONALITY ? `${env.PEER_RUNTIME ?? 'unknown'}-${env.PEER_PERSONALITY}` : undefined) })
}

/**
 * Is a HUMAN operator attached to this hosted session right now? (spawn-flip Ф0b-3 slice 3c). The
 * supervisor daemon maintains a `.attached` marker present iff ≥1 client is connected (synced on every
 * client add/detach incl. abnormal close/error/drain, and cleared on daemon start so a crashed
 * predecessor's stale marker never lies). The warm-deliver busy-composer hold gates on THIS: hold for
 * a human's unfinished composer input, but NEVER for the AI's own composer output when no one is
 * attached. The host equivalent of `hasAttachedTmuxClient`.
 */
export function hasAttachedSupervisorClient(identity: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(attachedPath(hostRunDir(env), identity))
}

/** Current child pty geometry of a hosted session, from the supervisor's `<session>.geometry.json`
 *  sidecar, or HOST defaults when absent/unreadable. Warm-deliver occupancy / ready-gate readers use THIS
 *  rather than assuming the fixed HOST geometry, because a DETACHED session keeps its last client geometry
 *  (the child is no longer reverted to serve on detach — that revert caused the reattach-duplicate bug).
 *  Reading the actual geometry keeps the pane-log composer-occupancy model aligned with the real pty size. */
export function hostGeometry(identity: string, env: NodeJS.ProcessEnv = process.env): { cols: number; rows: number } {
  return readGeometry(hostRunDir(env), identity) ?? { cols: HOST_COLS, rows: HOST_ROWS }
}

/**
 * A session-REPLACEMENT token for a hosted session (spawn-flip Ф0b-3 slice 3c): the supervisor
 * daemon's pid. A `/new` or restart spawns a NEW daemon (new pid), so a message queued against the old
 * session FAILS rather than landing in a fresh same-named session — the host equivalent of the tmux
 * `session_id:pane_id` token. null when no daemon pid is readable.
 */
export function hostSessionToken(identity: string, env: NodeJS.ProcessEnv = process.env, runDir = hostRunDir(env)): string | null {
  try {
    const pid = readFileSync(pidPath(runDir, identity), 'utf8').trim()
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
export function listHostedPeers(env: NodeJS.ProcessEnv = process.env, runDir = hostRunDir(env)): Array<{ runtime: TmuxRuntime; personality: string }> {
  const out: Array<{ runtime: TmuxRuntime; personality: string }> = []
  for (const s of listSupervisorSessions(runDir)) {
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
  /** Injected env — the run-dir (serve-spec + detached spawn) resolves from THIS, so a sandboxed
   *  launch never writes serve secrets to / spawns a process against the real ~/.iapeer. */
  env?: NodeJS.ProcessEnv
}): Promise<HostStartResult> {
  try {
    const { startSupervisorDaemon } = await import('../supervisor/index.ts')
    const r = await startSupervisorDaemon({
      session: b.identity,
      runtime: b.runtime,
      runDir: hostRunDir(b.env),
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

/** How long an UNRECOGNIZED boot modal must sit unchanged before the bring-up fails fast. Known
 *  dialogs are answered by the supervisor's boot-driver within one or two 2 s iterations, so a modal
 *  that survives this window is one nothing will ever answer. Override: IAPEER_BOOT_MODAL_SECS. */
export const BOOT_MODAL_STABLE_SECS = 20

/** Outcome of waitHostReady. `bootModal` ⇔ the wait was cut short by an unrecognized modal. */
export type HostReadyOutcome =
  | { ready: true }
  | { ready: false; bootModal?: { content: string; option1: string } }

/**
 * Generic boot-time modal fallback for a select the adapter's unknownBlockingModal does not parse
 * (e.g. unnumbered rows, a footer outside its cancel/go-back vocabulary — the 2.1.30x resume-confirm
 * was both). Structural: a bottom-area "Enter/Esc to <verb>" footer with a cursor-glyph row above it and
 * NO ready composer. Only consulted at boot, on a not-ready pane the boot-driver has no keys for.
 */
export function genericBootPrompt(view: string): { content: string; option1: string } | null {
  const lines = view.split(/\r?\n/).map(l => l.replace(/\s+$/, ''))
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const tail = lines.slice(-12)
  // A SELECT footer verb only — never a working-state hint like "esc to interrupt" (a booting composer).
  const footerIdx = tail.findIndex(l => /\b(?:enter|esc)\s+to\s+(?:confirm|select|cancel|go back|resume|dismiss|continue|accept|exit|skip)\b/i.test(l))
  if (footerIdx < 0) return null
  const above = tail.slice(0, footerIdx)
  const cursorRow = [...above].reverse().find(l => /[❯›]\s*\S/.test(l))
  if (!cursorRow) return null
  return { content: tail.join('\n'), option1: cursorRow.replace(/^.*?[❯›]\s*/, '').trim() }
}

/**
 * Wait for the hosted input surface to be ready: poll the pane-log model and run the adapter's
 * isInputReady (the supervisor's boot-driver answers dialogs internally, so launch does NOT drive
 * them). Mirrors the tmux boot loop's 2 s cadence + bootDeadline.
 *
 * FAIL-FAST on an unrecognized modal (22.10 walt-trader): a boot dialog no adapter knows sat on screen
 * while this loop spun to bootDeadline (240 s) HOLDING THE WAKE LOCK — every other sender got
 * wake-lock-held, and the next wake replaced → re-launched into the same dialog. Now: when the pane is
 * not ready, the boot-driver has no keys for it (bootDialogKeys null), and a modal is detected
 * (adapter.unknownBlockingModal, else genericBootPrompt) with the SAME content for modalStableSecs,
 * the wait ends with `bootModal` — the caller tears the host down and fails the wake explicitly.
 */
export async function waitHostReady(
  b: { identity: string; logDir: string; adapter: RuntimeAdapter; bootDeadlineSecs: number; modalStableSecs?: number; paneLogStartByte?: number; approvalMode?: ApprovalMode; env?: NodeJS.ProcessEnv },
  sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now,
  seam: { alive?: () => boolean; viewport?: () => Promise<string | null> } = {},
): Promise<HostReadyOutcome> {
  const log = `${b.logDir}/${b.identity}.log`
  const iters = Math.max(1, Math.ceil(b.bootDeadlineSecs / 2))
  const stableMs = (b.modalStableSecs ?? BOOT_MODAL_STABLE_SECS) * 1000
  let modal: { content: string; option1: string; since: number } | null = null
  // paneLogStartByte = the pane-log size at THIS session's spawn (captured by launch before the
  // supervisor opens the shared append-only log). Passing it to the model render confines readiness to
  // bytes THIS session wrote — without it a prior session's trailing `❯ ready` frame in the shared log
  // satisfies isInputReady before the fresh runtime paints, causing a premature deliver into a booting
  // session (the first message is then lost). See readyGateModel.loadPaneLogModel.
  for (let i = 0; i < iters; i++) {
    await sleep(2000)
    if (!(seam.alive ? seam.alive() : hostSessionAlive(b.identity, b.env))) return { ready: false }
    const view = seam.viewport ? await seam.viewport() : await paneLogViewport(log, HOST_COLS, HOST_ROWS, b.paneLogStartByte ?? 0)
    if (!view) continue
    if (b.adapter.isInputReady(view, b.approvalMode)) return { ready: true }
    const known = b.adapter.bootDialogKeys(view)
    const found = known && known.length ? null : (b.adapter.unknownBlockingModal?.(view) ?? genericBootPrompt(view))
    if (!found) { modal = null; continue }
    if (!modal || modal.content !== found.content) { modal = { ...found, since: now() }; continue }
    if (now() - modal.since >= stableMs) return { ready: false, bootModal: { content: modal.content, option1: modal.option1 } }
  }
  return { ready: false }
}

/** Deliver the first/next message to the hosted session over its supervisor socket. */
export function deliverHosted(identity: string, message: string, env: NodeJS.ProcessEnv = process.env): Promise<DeliverResult> {
  if (identity.startsWith('codex-')) {
    return import('./codexDelivery.ts').then(m => m.deliverCodexToHost(hostRunDir(env), identity, message, env))
  }
  return deliverToHost(hostRunDir(env), identity, message)
}

/**
 * Re-send a BARE CR to a hosted session — the submit-retry behind the landed-confirm grace
 * (transport/index.ts). NOT a delivery: it pastes nothing and carries no payload, it only presses
 * Enter on whatever the composer already holds.
 *
 * WHY THIS EXISTS. deliverToHost is paste → fixed 300 ms settle → CR. Sometimes that CR is EATEN: the
 * composer keeps the envelope and NO turn is ever submitted, so the message is never processed and the
 * landed-confirm has nothing to find. Measured live 16.07.2026 (claude receivers):
 *
 *   • FIRST attachment-bearing delivery into a session → CR eaten. Two independent sessions hung this
 *     way; one sat with a byte-frozen transcript for 180 s with NOTHING else sent, and moved only when
 *     an unrelated later delivery's CR arrived. The payload was never lost — it sat in the composer,
 *     still carrying its own original ts.
 *   • EVERY LATER attachment delivery into that same session → the first CR works (~0.7–1 s, even for
 *     9.3 MB of fresh incompressible PNGs).
 *
 * WHY the first one is different is NOT known, and this code deliberately does not guess. An earlier
 * reading — "hoisting is slow, so the CR lands mid-hoist" — was RETRACTED: it rested on a settle=8000
 * run that looked decisive but was confounded (that session had already taken its first attachment, so
 * any settle would have worked). Do not re-derive a hoist-duration constant from it.
 *
 * That unknown is exactly why the retry is cause-agnostic: it does not model WHY a CR was eaten, it
 * just presses Enter again while nothing has landed. Sent through the CONTROL channel (bare bytes, no
 * bracketed paste) because it must arrive as a keystroke, not a pasted literal.
 */
export function resubmitHosted(identity: string, env: NodeJS.ProcessEnv = process.env): Promise<DeliverResult> {
  return sendControlToHost(hostRunDir(env), identity, [Buffer.from('\r', 'utf8')])
}

/** Run backfillHostReady exactly once per host (sentinel in the run-dir). Every later hosting is a
 *  launch that writes its own marker, so a repeat backfill could only mask a never-ready host. */
export async function backfillHostReadyOnce(env: NodeJS.ProcessEnv = process.env): Promise<string[] | null> {
  const sentinel = join(hostRunDir(env), 'ready-backfill.v1')
  if (existsSync(sentinel)) return null
  const stamped = await backfillHostReady(env)
  try {
    writeFileSync(sentinel, `${new Date().toISOString()} ${stamped.join(',')}\n`, { mode: 0o600 })
  } catch {
    /* best-effort */
  }
  return stamped
}
