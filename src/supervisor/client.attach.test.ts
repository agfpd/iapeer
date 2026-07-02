import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killSession, sessionAlive, startSupervisorDaemon } from './index.ts'

// SURFACE-5 regression — the interactive attach-and-stay loop. The other supervisor tests attach a
// RAW socket; none drives the real `runSupervisorClient` under a TTY, so the canary's first live
// `iapeer attach` exposed a bug invisible to them: runSupervisorClient resolved its Promise the
// instant Bun.connect returned (setup done), the CLI caller ran `await runSupervisorClient(); return
// 0` → runCli's `.then(process.exit)`, and the just-attached client was torn down within
// milliseconds (handshake-then-exit). The fix makes the client BLOCK (never-resolve) after setup so
// process.exit from a terminal path owns termination — exactly the detached `daemon` case's guard.
//
// This is the headless verifier of that fix AND the missing surface-5 automation: allocate a REAL
// Bun-native pty, run the actual client CLI in it, assert it STAYS attached + renders live frames +
// Ctrl-] detaches cleanly while the session keeps running. Nova's live attach is the final human
// seal; this test makes every iteration of the fix verifiable WITHOUT pulling him in.
// Gated on Bun-native PTY (≥1.3.5) so a runner without it skips rather than reds.
const [maj, min, pat] = (Bun.version || '0.0.0').split('.').map(Number) as [number, number, number]
const bunPty = maj > 1 || (maj === 1 && (min > 3 || (min === 3 && pat >= 5)))
const d = bunPty ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeoutMs = 4000, step = 50): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(step)
  }
  return false
}

// Spawn the real attach client under a real pty (its stdin/stdout is a TTY → raw-mode path runs).
interface PtyClient {
  out(): string
  exited(): boolean
  sendKey(byte: number): void
}
function spawnAttachClient(runDir: string, session: string): PtyClient {
  let buf = ''
  let done = false
  const proc = Bun.spawn(['bun', 'src/supervisor/index.ts', 'attach', session, '--run-dir', runDir], {
    cwd: process.cwd(),
    env: { ...process.env },
    // a real Bun-native pty pair: the client sees a TTY on stdin (isTTY → setRawMode runs).
    terminal: {
      cols: 80,
      rows: 24,
      name: 'xterm-256color',
      data(_t: unknown, data: Uint8Array | string) {
        buf += Buffer.from(data as Uint8Array).toString('latin1')
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bun pty spawn opts not yet in @types
  } as any)
  proc.exited.then(() => {
    done = true
  })
  return {
    out: () => buf,
    exited: () => done,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- proc.terminal is the pty master writer
    sendKey: (byte: number) => void (proc as any).terminal.write(Buffer.from([byte])),
  }
}

d('runSupervisorClient interactive attach (surface-5, Bun-native pty)', () => {
  let runDir: string
  const session = 'ptsattach'

  beforeAll(async () => {
    runDir = mkdtempSync(join(tmpdir(), 'iapeer-attach-'))
    await startSupervisorDaemon({ session, runtime: 'tick', runDir })
  })
  afterAll(() => {
    try {
      killSession(runDir, session)
    } catch {
      /* */
    }
    rmSync(runDir, { recursive: true, force: true })
  })

  test('the client STAYS attached after the handshake and keeps rendering live frames', async () => {
    expect(sessionAlive(runDir, session)).toBe(true)
    const c = spawnAttachClient(runDir, session)

    // handshake: live child output reaches the client (connect + attach + terminal-setup + the daemon's
    // snapshot/live forwarding all succeeded). There is deliberately NO attach banner now — any pre-snapshot
    // stdout would pollute the fresh terminal's scrollback — so first live frames ARE the handshake signal.
    expect(await waitFor(() => /STREAMTICK_\d+/.test(c.out()))).toBe(true)

    // THE BUG was a handshake-then-exit within ~ms. Assert the client is STILL attached well past
    // that window AND that live child output (STREAMTICK from the tick runtime) is reaching it —
    // proving the attach-and-stay loop holds, not just that the process happens to linger.
    await sleep(2000)
    expect(c.exited()).toBe(false) // RED on the pre-fix early-resolve (exited ~ms after handshake)
    expect(/STREAMTICK_\d+/.test(c.out())).toBe(true) // live frames flow through the held attach

    // Ctrl-] (0x1d) detaches: the client exits cleanly, prints the DETACH message (not the
    // misleading "session ended"), and the session keeps running.
    c.sendKey(0x1d)
    expect(await waitFor(() => c.exited())).toBe(true)
    expect(/detached/.test(c.out())).toBe(true)
    expect(/session ended/.test(c.out())).toBe(false) // detach must not claim the session ended
    expect(sessionAlive(runDir, session)).toBe(true) // detach kept the daemon alive
  })
})
