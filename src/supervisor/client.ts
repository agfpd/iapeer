// Supervisor CLIENT — attaches a terminal to a running daemon over the unix socket (cutover
// Block 2, ported from PoC pts.mjs). Detach key Ctrl-] (session keeps running). The two reattach
// port-deps live here + in protocol.ts: #1 TERM_RESET on EVERY exit path (incl. SIGHUP window-close,
// via writeSync which works inside a signal handler), and #2 backpressure is the daemon's side.
import { existsSync, readFileSync, writeSync } from 'node:fs'
import { FRAME_DATA, FRAME_RESIZE, TERM_RESET, frame, makeFramer, sizePayload } from './protocol.ts'
import { pidPath, sockPath } from './paths.ts'

const DETACH = 0x1d // Ctrl-]

const pidAlive = (p: number): boolean => {
  try {
    process.kill(p, 0)
    return true
  } catch {
    return false
  }
}
export function sessionAlive(runDir: string, session: string): boolean {
  const pf = pidPath(runDir, session)
  return existsSync(pf) && pidAlive(Number(readFileSync(pf, 'utf8')))
}

/** Attach an interactive terminal client to a live daemon session. Resolves when the client
 *  detaches / the session ends (it calls process.exit on every terminal path). */
export async function runSupervisorClient(runDir: string, session: string): Promise<void> {
  if (!sessionAlive(runDir, session)) {
    console.error(`no live session "${session}". start it: supervisor start ${session} <runtime>`)
    process.exit(1)
  }
  let restored = false
  // Set the instant a deliberate Ctrl-] detach begins. `sock.end()` can re-enter the socket close()
  // handler synchronously, so close() must NOT claim "session ended" on an operator-initiated detach
  // (the session keeps running) — it stays silent and lets the detach path own the message + exit.
  let detaching = false
  // writeSync(1, …) works inside a signal handler (no event-loop dependency) — so a
  // SIGHUP/window-close client still resets the terminal before it dies (port-dep #1).
  const restore = (): void => {
    if (restored) return
    restored = true
    try {
      writeSync(1, TERM_RESET)
    } catch {
      /* */
    }
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
    } catch {
      /* */
    }
    try {
      process.stdin.pause()
    } catch {
      /* */
    }
  }

  const framer = makeFramer((type, payload) => {
    if (type === FRAME_DATA) process.stdout.write(Buffer.from(payload))
  })
  // Ready the terminal BEFORE connecting, so the repaint snapshot renders the instant it arrives.
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()

  const curSize = (): Buffer => sizePayload(process.stdout.columns || 80, process.stdout.rows || 24)
  const sock = await Bun.connect({
    unix: sockPath(runDir, session),
    socket: {
      open(s) {
        s.write(frame(FRAME_RESIZE, curSize())) // tell the daemon our size → repaint at our size
      },
      data(_s, d) {
        framer(d)
      },
      close() {
        restore()
        if (detaching) process.exit(0) // operator detached; the detach path already wrote its message
        process.stdout.write('\r\n[supervisor] session ended.\r\n')
        process.exit(0)
      },
      error() {
        restore()
        process.exit(1)
      },
    },
  })

  process.stdin.on('data', b => {
    if (b.includes(DETACH)) {
      detaching = true
      restore()
      // Write the detach message BEFORE sock.end() — sock.end() can re-enter close() synchronously,
      // and close() now exits silently while `detaching`, so the message must already be out.
      process.stdout.write(`\r\n[supervisor] detached — session still running. reattach: supervisor attach ${session}\r\n`)
      try {
        sock.end()
      } catch {
        /* */
      }
      process.exit(0)
    }
    sock.write(frame(FRAME_DATA, b))
  })
  process.on('SIGWINCH', () => {
    try {
      sock.write(frame(FRAME_RESIZE, curSize()))
    } catch {
      /* */
    }
  })
  // Window-close (SIGHUP) / kill (SIGTERM) of the CLIENT: detach cleanly (session keeps running)
  // and reset the terminal — the prior gap leaked the child's app-modes and broke the next reattach.
  for (const sig of ['SIGHUP', 'SIGTERM'] as const) {
    process.on(sig, () => {
      restore()
      try {
        sock.end()
      } catch {
        /* */
      }
      process.exit(0)
    })
  }
  process.on('exit', () => restore()) // last-resort sync net
  // NO pre-repaint attach banner: any stdout (even stderr — same tty device) printed before the daemon's
  // snapshot lands pollutes the fresh terminal's scrollback, defeating native-history reconstruction. The
  // detach key (Ctrl-]) is documented in CLI help / the attach verb, not emitted as a scrollback line.
  // STAY ATTACHED. The client lives on its handles (raw stdin + the socket); EVERY terminal path
  // (detach Ctrl-], session-end close(), SIGHUP/SIGTERM, socket error) calls process.exit ITSELF.
  // This promise INTENTIONALLY never resolves: returning here would resolve runSupervisorClient the
  // instant the handshake completed, and the CLI caller (`await runSupervisorClient(); return 0` →
  // runCli's `.then(process.exit)`) would tear the just-attached client down in milliseconds — the
  // surface-5 interactive-attach bug. The detached `daemon` case guards itself the same way.
  await new Promise<never>(() => {})
}
