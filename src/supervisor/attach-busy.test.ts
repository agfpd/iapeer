// Attach-dup regression (live incident, Артур 03.07): attaching to a BUSY, actively-rendering
// session at a DIFFERENT geometry stacked duplicates on the client screen ("Composing…" spinner
// rows piling up). Root: firstAttach resized the child AFTER the snapshot, so the child's
// SIGWINCH redraw arrived as LIVE bytes on top of the already-sent snapshot with relative
// cursor-ups that no longer matched — and a bare stability check returned in the quiet gap
// between busy ticks, BEFORE the redraw wave arrived. The fix resizes model+child BEFORE the
// snapshot and waits for the redraw wave (seq bump, then bounded stability), so the redraw is
// INGESTED by the model and serialized once.
//
// This test drives the REAL detached supervisor with a claude-like busy child (relative
// cursor-up full redraw on SIGWINCH + a live in-place spinner) and a raw framed client at a
// mismatched geometry, then asserts the client VIEWPORT carries exactly ONE live spinner row.
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

const BUSY_CHILD = `
const LINES = 12
function block(cols) {
  const out = []
  for (let i = 0; i < LINES; i++) out.push(('• message line ' + i + ' ').padEnd(cols - 1, '='))
  return out
}
let n = 0
let painted = false
function fullPaint() {
  const cols = process.stdout.columns || 80
  let s = ''
  if (painted) s += '\\x1b[' + LINES + 'A' // cursor-up to the block top (cursor sits ON the spinner row)
  for (const l of block(cols)) s += '\\r\\x1b[K' + l + '\\n'
  s += '\\r\\x1b[KComposing… (' + n + 's)'
  painted = true
  process.stdout.write(s)
}
fullPaint()
setInterval(() => { n++; process.stdout.write('\\r\\x1b[KComposing… (' + n + 's)') }, 200)
process.on('SIGWINCH', () => fullPaint())
setTimeout(() => process.exit(0), 60000)
`

d('attach to a BUSY session at a mismatched geometry (dup regression)', () => {
  let runDir: string
  beforeAll(() => {
    runDir = mkdtempSync(join(tmpdir(), 'iapeer-attach-busy-'))
    writeFileSync(join(runDir, 'busy-child.ts'), BUSY_CHILD)
  })
  afterAll(() => {
    killSession(runDir, 'claude-busydup')
    rmSync(runDir, { recursive: true, force: true })
  })

  test('client viewport carries exactly ONE live spinner row; live ticks continue in place', async () => {
    const r = await startSupervisorDaemon({
      session: 'claude-busydup',
      runtime: 'claude',
      runDir,
      serve: {
        argv: [process.execPath, join(runDir, 'busy-child.ts')],
        env: { PATH: process.env.PATH ?? '/bin:/usr/bin' },
        cwd: runDir,
        cols: 220,
        rows: 50,
      },
    })
    expect(r.state).toBe('started')
    await sleep(1500) // child busy-rendering at 220x50

    const CC = 132
    const CR = 61
    const term = new Terminal({ cols: CC, rows: CR, allowProposedApi: true, scrollback: 3000 })
    const sock = connect(join(runDir, 'claude-busydup.sock'))
    const framer = makeFramer((t, p) => {
      if (t === FRAME_DATA) term.write(p)
    })
    sock.on('data', dch => framer(dch))
    await new Promise<void>(res => sock.once('connect', () => res()))
    sock.write(frame(FRAME_RESIZE, sizePayload(CC, CR))) // firstAttach: resize → redraw-wave → snapshot
    await sleep(2500) // busy stream keeps flowing after the attach
    sock.destroy()

    const b = term.buffer.active
    const viewport: string[] = []
    for (let y = b.baseY; y < b.baseY + CR; y++) viewport.push(b.getLine(y)?.translateToString(true) ?? '')
    const spinners = viewport.filter(l => l.includes('Composing…'))
    // the dup bug: a frozen old spinner row + the live one below it (2+); clean attach: exactly 1
    expect(spinners.length).toBe(1)
    // and it is the LIVE one (ticks continued in place after the snapshot): >= ticks before attach
    const secs = Number(/\((\d+)s\)/.exec(spinners[0]!)?.[1] ?? -1)
    expect(secs).toBeGreaterThanOrEqual(10)
  }, 20_000)
})
