// Orphan-scrollback regression (Артур welcome-attach corruption, 04.07 — live repro).
// Attaching to a session hosted at the WIDE HOST geometry (220x50) from a NARROWER real terminal
// (110x20) reflows the model: wide lines rewrap TALLER and, with fewer rows, the TOP of the
// pre-resize viewport SPILLS into scrollback. A relative-cursor TUI child repaints only the
// VIEWPORT on SIGWINCH — it can't reach scrollback — so those spilled rows lingered as stale,
// reflow-wrapped ORPHANS above the clean repaint ("two frames overlaid + left-clipped" screenshot).
//
// The child below has NO committed history (preBaseY===0): its whole screen is one dynamic box it
// fully repaints on SIGWINCH. firstAttach therefore erases the provably-redundant orphan scrollback,
// so the client snapshot is a CLEAN viewport: box top border appears exactly ONCE, baseY===0.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Terminal } from '@xterm/headless'
import { connect } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killSession, startSupervisorDaemon } from './index.ts'
import { frame, makeFramer, sizePayload, FRAME_DATA, FRAME_RESIZE } from './protocol.ts'

const [maj, min, pat] = (Bun.version || '0.0.0').split('.').map(Number) as [number, number, number]
const bunPty = maj > 1 || (maj === 1 && (min > 3 || (min === 3 && pat >= 5)))
const d = bunPty ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

// A welcome-screen-like child: one WIDE dynamic box (no committed history), full VIEWPORT repaint on
// SIGWINCH (\x1b[H home + \x1b[J erase-below — viewport-only, never touches scrollback, exactly like a
// classic-renderer TUI). The box is drawn at the CURRENT cols so it always fills the width and, at the
// wide host size, rewraps taller than a narrow client → the spill that used to orphan.
const BOX_CHILD = `
const ROWS = 14
function draw() {
  const c = process.stdout.columns || 80
  let s = '\\x1b[H\\x1b[J' // home + erase-below: repaint the VIEWPORT only (cannot reach scrollback)
  s += '╭BOXTOP' + '─'.repeat(Math.max(0, c - 8)) + '╮\\r\\n'
  for (let i = 0; i < ROWS; i++) s += '│ row ' + (i < 10 ? '0' : '') + i + ' ' + '·'.repeat(Math.max(0, c - 12)) + '│\\r\\n'
  s += '╰' + '─'.repeat(Math.max(0, c - 2)) + '╯'
  process.stdout.write(s)
}
draw()
process.on('SIGWINCH', () => draw())
setTimeout(() => process.exit(0), 60000)
`

d('attach to a wide-hosted session from a narrow terminal (orphan-scrollback regression)', () => {
  let runDir: string
  beforeAll(() => {
    runDir = mkdtempSync(join(tmpdir(), 'iapeer-attach-orphan-'))
    writeFileSync(join(runDir, 'box-child.ts'), BOX_CHILD)
  })
  afterAll(() => {
    killSession(runDir, 'claude-orphan')
    rmSync(runDir, { recursive: true, force: true })
  })

  test('client snapshot has NO orphan scrollback: box top border appears exactly once, baseY===0', async () => {
    const r = await startSupervisorDaemon({
      session: 'claude-orphan',
      runtime: 'claude',
      runDir,
      serve: {
        argv: [process.execPath, join(runDir, 'box-child.ts')],
        env: { PATH: process.env.PATH ?? '/bin:/usr/bin' },
        cwd: runDir,
        cols: 220, // wide HOST geometry
        rows: 50,
      },
    })
    expect(r.state).toBe('started')
    await sleep(1200) // box painted at 220x50, no committed history (baseY=0 in the model)

    const CC = 110 // NARROW client — forces the reflow that used to orphan
    const CR = 20
    const term = new Terminal({ cols: CC, rows: CR, allowProposedApi: true, scrollback: 5000 })
    const sock = connect(join(runDir, 'claude-orphan.sock'))
    const framer = makeFramer((t, p) => {
      if (t === FRAME_DATA) term.write(p)
    })
    sock.on('data', dch => framer(dch))
    await new Promise<void>(res => sock.once('connect', () => res()))
    sock.write(frame(FRAME_RESIZE, sizePayload(CC, CR))) // firstAttach: resize 220→110 → redraw wave → snapshot
    await sleep(1800)
    await new Promise<void>(res => term.write('', () => res())) // drain the client model
    sock.destroy()

    const b = term.buffer.active
    // Count the box top border across the ENTIRE client buffer (scrollback + viewport). The orphan bug
    // duplicated it: a spilled reflow-wrapped copy in scrollback + the clean viewport repaint. Fixed = 1.
    let topBorders = 0
    for (let y = 0; y < b.baseY + CR; y++) {
      if ((b.getLine(y)?.translateToString(true) ?? '').includes('BOXTOP')) topBorders++
    }
    expect(topBorders).toBe(1) // no orphan duplicate
    expect(b.baseY).toBe(0) // no spilled scrollback at all — clean viewport snapshot
  }, 20_000)
})
