// Supervisor DELIVER client (cutover Block 2 spawn-flip, Ф0a) — hands a message to a supervisor-
// HOSTED session over its unix socket: the host equivalent of tmux load-buffer → paste-buffer -p →
// send-keys Enter. @xterm-FREE BY CONSTRUCTION — imports ONLY protocol.ts (pure frames + the proven
// BackpressureWriter) + paths.ts (no @xterm) — so launch can deliver to a hosted session WITHOUT
// pulling the @xterm daemon into the hot path. Bracketed-paste wraps the message (same intent as
// tmux paste-buffer -p: the TUI takes it as one atomic paste, not retyped keystrokes), then a CR
// submits — the SAME two-step the cold/warm tmux delivery uses. Backpressure-safe: a multi-KB
// envelope past the socket buffer is queued + flushed on drain, never truncated (the same failure
// mode that staled heavy reattach — protocol.ts port-dep #2).
import { BackpressureWriter, FRAME_DATA, frame } from './protocol.ts'
import { sockPath } from './paths.ts'
import { existsSync } from 'node:fs'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export interface DeliverResult {
  ok: boolean
  error?: string
}

/** Deliver `message` to a hosted session over its supervisor socket: connect → bracketed-paste →
 *  (settle) → CR → close. submitDelayMs mirrors the tmux boot delivery's 300 ms paste→Enter settle. */
export async function deliverToHost(
  runDir: string,
  session: string,
  message: string,
  opts: { submitDelayMs?: number } = {},
): Promise<DeliverResult> {
  const sock = sockPath(runDir, session)
  if (!existsSync(sock)) return { ok: false, error: `no supervisor socket for "${session}"` }
  let conn: Awaited<ReturnType<typeof Bun.connect>> | undefined
  let writer: BackpressureWriter | undefined
  try {
    conn = await Bun.connect({
      unix: sock,
      socket: {
        drain() {
          writer?.flush()
        },
        data() {
          /* the daemon forwards screen output; the deliver client ignores it */
        },
        error() {
          /* surfaced via the writer's dead state */
        },
        close() {
          /* */
        },
      },
    })
    const c = conn
    writer = new BackpressureWriter(b => c.write(b))
    const paste = `\x1b[200~${message}\x1b[201~` // bracketed paste — atomic, like paste-buffer -p
    if (!writer.send(frame(FRAME_DATA, Buffer.from(paste, 'utf8')))) return { ok: false, error: 'socket dead during paste' }
    if (!(await drainFully(writer))) return { ok: false, error: 'paste not fully flushed (socket stalled)' }
    await sleep(opts.submitDelayMs ?? 300)
    if (!writer.send(frame(FRAME_DATA, Buffer.from('\r', 'utf8')))) return { ok: false, error: 'socket dead during submit' }
    if (!(await drainFully(writer))) return { ok: false, error: 'submit not fully flushed (socket stalled)' }
    await sleep(50) // let the CR land before we close the connection
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `deliver to host failed: ${(e as Error).message}` }
  } finally {
    try {
      conn?.end()
    } catch {
      /* */
    }
  }
}

/** Wait until the writer's queued tail has flushed (drain-driven), or time out. */
async function drainFully(writer: BackpressureWriter, timeoutMs = 4000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (writer.queuedBytes > 0 && !writer.isDead && Date.now() < end) await sleep(20)
  return writer.queuedBytes === 0 && !writer.isDead
}

/**
 * Send raw CONTROL bytes to a hosted session over its supervisor socket — the host equivalent of
 * `tmux send-keys` for the control channel (interrupt / compact). Each chunk is ALREADY the exact
 * keystrokes (translated from the send-keys vocabulary by keysToBytes upstream), sent as a FRAME_DATA
 * write — NOT bracketed-pasted and NOT auto-submitted: an Escape must arrive as a bare ESC, never a
 * pasted literal. `stepDelayMs` paces a multi-step plan after each step, mirroring executeControl's
 * tmux loop (e.g. compact's '/compact' then a 300 ms settle then Enter). Backpressure-safe per step.
 */
export async function sendControlToHost(
  runDir: string,
  session: string,
  chunks: Buffer[],
  opts: { stepDelayMs?: number } = {},
): Promise<DeliverResult> {
  const sock = sockPath(runDir, session)
  if (!existsSync(sock)) return { ok: false, error: `no supervisor socket for "${session}"` }
  let conn: Awaited<ReturnType<typeof Bun.connect>> | undefined
  let writer: BackpressureWriter | undefined
  try {
    conn = await Bun.connect({
      unix: sock,
      socket: { drain() { writer?.flush() }, data() { /* */ }, error() { /* */ }, close() { /* */ } },
    })
    const c = conn
    writer = new BackpressureWriter(b => c.write(b))
    for (const chunk of chunks) {
      if (!writer.send(frame(FRAME_DATA, chunk))) return { ok: false, error: 'socket dead during control send' }
      if (!(await drainFully(writer))) return { ok: false, error: 'control not fully flushed (socket stalled)' }
      if (opts.stepDelayMs) await sleep(opts.stepDelayMs)
    }
    await sleep(50) // let the last chunk land before we close the connection
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `control to host failed: ${(e as Error).message}` }
  } finally {
    try {
      conn?.end()
    } catch {
      /* */
    }
  }
}
