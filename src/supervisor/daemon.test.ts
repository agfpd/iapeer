import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FRAME_DATA, FRAME_RESIZE, frame, makeFramer, sizePayload } from './protocol.ts'
import { killSession, listSessions, sessionAlive, sockPath, startSupervisorDaemon } from './index.ts'
import { readGeometry } from './paths.ts'

// Integration: a REAL Bun-native pty daemon over a real unix socket, driven by the deterministic
// `tick` runtime (no claude/codex needed) — hermetic (temp run dir, throwaway session). Proves
// boris's Block-2 acceptance points: spawn + responder-served boot + attach repaint + live
// forward + detach-survival + REATTACH FRESHNESS (the heavy-reattach bug the port-deps fixed).
// Gated on Bun-native PTY (≥1.3.5) so a runner without it skips rather than reds.
const [maj, min, pat] = (Bun.version || '0.0.0').split('.').map(Number) as [number, number, number]
const bunPty = maj > 1 || (maj === 1 && (min > 3 || (min === 3 && pat >= 5)))
const d = bunPty ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeoutMs = 5000, step = 50): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(step)
  }
  return false
}
const maxTick = (s: string): number => {
  let m = -1
  for (const x of s.matchAll(/STREAMTICK_(\d+)/g)) m = Math.max(m, Number(x[1]))
  return m
}

interface Client {
  text(): string
  close(): void
}
async function attach(runDir: string, session: string, cols = 80, rows = 24): Promise<Client> {
  const frames: Buffer[] = []
  const framer = makeFramer((t, p) => {
    if (t === FRAME_DATA) frames.push(Buffer.from(p))
  })
  const sock = await Bun.connect({
    unix: sockPath(runDir, session),
    socket: {
      open(s) {
        s.write(frame(FRAME_RESIZE, sizePayload(cols, rows)))
      },
      data(_s, dd) {
        framer(dd)
      },
    },
  })
  return {
    text: () => Buffer.concat(frames).toString('latin1'),
    close: () => {
      try {
        sock.end()
      } catch {
        /* */
      }
    },
  }
}

d('supervisor daemon (Bun-native pty, tick runtime)', () => {
  let runDir: string
  const session = 'ptstest'

  beforeAll(() => {
    runDir = mkdtempSync(join(tmpdir(), 'iapeer-supervisor-'))
  })
  afterAll(() => {
    try {
      killSession(runDir, session)
    } catch {
      /* */
    }
    rmSync(runDir, { recursive: true, force: true })
  })

  test('spawns a detached daemon that comes up live', () => {
    const r = startSupervisorDaemon({ session, runtime: 'tick', runDir })
    expect(r.state).toBe('started')
    expect(sessionAlive(runDir, session)).toBe(true)
    expect(listSessions(runDir).some(s => s.session === session && s.alive)).toBe(true)
  })

  test('attach forwards live child output (the pty conduit works end-to-end)', async () => {
    const c = await attach(runDir, session)
    const got = await waitFor(() => /STREAMTICK_\d+/.test(c.text()))
    expect(got).toBe(true) // live STREAMTICK_N stream reached the client
    c.close()
  })

  test('detach keeps the daemon alive (detach-persistence)', async () => {
    await sleep(150)
    expect(sessionAlive(runDir, session)).toBe(true)
  })

  test('REATTACH repaints the CURRENT frame, not a stale one (port-dep #2 freshness)', async () => {
    const first = await attach(runDir, session)
    await waitFor(() => maxTick(first.text()) >= 0)
    const base = maxTick(first.text())
    first.close()
    await sleep(800) // the stream advances while detached
    const second = await attach(runDir, session)
    // the reattach snapshot (a snapshot of the CURRENT model) must reflect ticks emitted AFTER the
    // first detach — a stale close-moment frame would show base, not a higher index.
    const fresh = await waitFor(() => maxTick(second.text()) > base, 5000)
    expect(fresh).toBe(true)
    second.close()
  })

  // Bug B (live incident 16.06, Apple Terminal): the attach catch-up sends a SNAPSHOT of the resolved
  // @xterm model (committed scrollback + viewport rows), exactly ONCE per client (first FRAME_RESIZE).
  // It must NOT re-send on a later resize — a second snapshot would stack a duplicate history copy in a
  // terminal that ignores \x1b[3J → smeared/overlapping scroll-up history. Discriminator: a pre-attach
  // tick captured by the snapshot appears EXACTLY ONCE; the live stream never re-emits an old tick, so a
  // re-snapshot would make that old tick appear twice. (The model-snapshot CONTENT correctness — that an
  // in-place rewrite collapses to one line, not a stale frame — is unit-tested in snapshot.test.ts.)
  test('Bug B: catch-up snapshots history ONCE; a later resize does NOT re-snapshot', async () => {
    const frames: Buffer[] = []
    const framer = makeFramer((t, p) => {
      if (t === FRAME_DATA) frames.push(Buffer.from(p))
    })
    const sock = await Bun.connect({
      unix: sockPath(runDir, session),
      socket: {
        open(s) {
          s.write(frame(FRAME_RESIZE, sizePayload(100, 30))) // runClient's connect-time resize
        },
        data(_s, dd) {
          framer(dd)
        },
      },
    })
    const text = (): string => Buffer.concat(frames).toString('latin1')
    const minTick = (s: string): number => {
      let m = Infinity
      for (const x of s.matchAll(/STREAMTICK_(\d+)/g)) m = Math.min(m, Number(x[1]))
      return m
    }
    const countTick = (n: number): number => (text().match(new RegExp(`STREAMTICK_${n}\\r`, 'g')) || []).length
    // catch-up replays the ring (pre-attach ticks) → wait until we've caught up
    expect(await waitFor(() => /STREAMTICK_\d+/.test(text()), 5000)).toBe(true)
    await sleep(200)
    const old = minTick(text()) // oldest replayed tick — the live stream is past it, it won't recur
    expect(countTick(old)).toBe(1) // caught up exactly once
    sock.write(frame(FRAME_RESIZE, sizePayload(90, 28))) // a second resize (e.g. window resize)
    await sleep(500)
    expect(countTick(old)).toBe(1) // NOT re-replayed — the supervisor stays out of the way on resize
    try {
      sock.end()
    } catch {
      /* */
    }
  })

  // Serving seam (slice b): a serve-spec is written before spawn, the detached daemon reads it, and
  // the composed argv + env + cwd reach the child VERBATIM (with the pty-host TERM layered on top and
  // TMUX stripped). A probe child dumps the markers it actually received — proving the supervisor
  // serves a launch-composed invocation faithfully (the parity foundation; the env-identity ABI rides
  // in here at serving time).
  test('serving seam: composed argv + env + cwd reach the child verbatim (slice b)', async () => {
    const servingSession = 'ptsserve'
    const childCwd = realpathSync(mkdtempSync(join(tmpdir(), 'iapeer-serve-cwd-')))
    const out = join(runDir, 'serve-probe.out')
    try {
      const serve = {
        // dump what the child ACTUALLY received: a composed env var, its cwd, TERM, and TMUX-presence
        argv: [
          'sh',
          '-c',
          'printf "%s\\n%s\\n%s\\n%s\\n" "$SERVE_MARKER" "$(pwd -P)" "$TERM" "${TMUX:-no-tmux}" > "$OUTFILE"; exec sleep 30',
        ],
        env: { SERVE_MARKER: 'identity-abi-xyz', OUTFILE: out, PATH: process.env.PATH ?? '', TMUX: 'should-be-stripped' },
        cwd: childCwd,
      }
      const r = startSupervisorDaemon({ session: servingSession, runtime: 'claude', runDir, serve })
      expect(r.state).toBe('started')
      const wrote = await waitFor(() => existsSync(out) && readFileSync(out, 'utf8').trim().split('\n').length >= 4)
      expect(wrote).toBe(true)
      const [marker, pwd, term, tmux] = readFileSync(out, 'utf8').split('\n')
      expect(marker).toBe('identity-abi-xyz') // composed env reached the child verbatim
      expect(pwd).toBe(childCwd) // composed cwd honored
      expect(term).toBe('xterm-256color') // pty-host TERM layered on top of the composed env
      expect(tmux).toBe('no-tmux') // TMUX stripped — a served child never thinks it is inside tmux
    } finally {
      killSession(runDir, servingSession)
      rmSync(childCwd, { recursive: true, force: true })
    }
  })

  // Exit-cause (spawn-flip Ф0b-1 resilience-b): when the hosted child dies, the daemon records a
  // `ev=session-exit … host=supervisor` line in exits.log — the cause the supervise-tick death
  // classification + crash-loop accounting need (mirror of the tmux pane-died hook). Kill the child,
  // assert the line lands.
  test('exit-cause: the daemon records the hosted child death in exits.log (resilience-b)', async () => {
    const exSession = 'ptsexit'
    const exitLog = join(runDir, 'exits.log')
    const childPidFile = join(runDir, 'exit-child.pid')
    try {
      const r = startSupervisorDaemon({
        session: exSession,
        runtime: 'tick',
        runDir,
        serve: { argv: ['sh', '-c', `echo $$ > '${childPidFile}'; exec sleep 30`], env: { PATH: process.env.PATH ?? '' }, cwd: runDir, exitLogPath: exitLog },
      })
      expect(r.state).toBe('started')
      const got = await waitFor(() => existsSync(childPidFile))
      expect(got).toBe(true)
      process.kill(Number(readFileSync(childPidFile, 'utf8').trim()), 'SIGKILL')
      const recorded = await waitFor(() => existsSync(exitLog) && /ev=session-exit identity=ptsexit.*host=supervisor/.test(readFileSync(exitLog, 'utf8')))
      expect(recorded).toBe(true) // the death cause is in exits.log → crash-loop accounting has it
    } finally {
      try {
        killSession(runDir, exSession)
      } catch {
        /* */
      }
    }
  })

  // EMULATOR INVARIANT — detach does NOT resize the child. The supervisor resizes the child pty to a
  // client's size on attach; on LAST detach it must NOT revert to serve geometry. The OLD revert (former
  // FINDING-2) shrank the child into a tiny viewport, making a TUI reflow its live region and scroll
  // DUPLICATE copies into scrollback — the reattach-duplicate bug. tmux/screen likewise never collapse a
  // detached session's size. Drive it with a child that prints its live pty winsize ("ROWS COLS"): attach
  // at a distinct size → pty resizes to it; detach → pty STAYS at that size (no SIGWINCH), and the geometry
  // sidecar reflects it (the warm-deliver / ready-gate readers follow the actual size, not serve).
  test('detach does NOT resize the child (geometry holds at last client size; sidecar reflects it)', async () => {
    const gSession = 'ptsgeo'
    const paneLog = join(runDir, 'geo-pane.log')
    const lastSize = (): string => {
      const t = existsSync(paneLog) ? readFileSync(paneLog, 'utf8') : ''
      const m = [...t.matchAll(/(\d+) (\d+)/g)]
      return m.length ? `${m[m.length - 1][1]}x${m[m.length - 1][2]}` : ''
    }
    try {
      const r = startSupervisorDaemon({
        session: gSession,
        runtime: 'tick',
        runDir,
        // serve geometry 200x50 (distinct from defaults); child reports its live pty winsize as "rows cols"
        serve: { argv: ['sh', '-c', 'while :; do stty size 2>/dev/null; sleep 0.3; done'], env: { PATH: process.env.PATH ?? '' }, cwd: runDir, paneLogPath: paneLog, cols: 200, rows: 50 },
      })
      expect(r.state).toBe('started')
      expect(await waitFor(() => lastSize() === '50x200', 6000)).toBe(true) // at serve geometry
      const c = await attach(runDir, gSession, 90, 30) // attach at a DIFFERENT size → pty resizes to it
      expect(await waitFor(() => lastSize() === '30x90', 6000)).toBe(true) // pty resized to the client size
      c.close() // last client gone
      await sleep(1500) // give a (now-removed) revert time to NOT happen
      expect(lastSize()).toBe('30x90') // detach did NOT resize the child back to serve — geometry HELD
      expect(readGeometry(runDir, gSession)).toEqual({ cols: 90, rows: 30 }) // sidecar reflects the live geometry
    } finally {
      try {
        killSession(runDir, gSession)
      } catch {
        /* */
      }
    }
  })
})
