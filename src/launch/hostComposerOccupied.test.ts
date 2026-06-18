// Spawn-flip cutover Block 2, Ф0b-2 slice 2 — hosted composer-occupancy DETECTION.
//
// paneLogComposerOccupied reads a supervisor-HOSTED session's pane-log model and runs the burn-in-
// validated composerOccupancyFromModel (REUSED from the leaf, not reimplemented). These suites are
// boris's slice-2 acceptance: the guard FIRES on a busy-composer model-state and stays cold on an
// empty / dim-ghost composer — proven by injecting real rendered frames into a pane-log. The end-to-
// end hold (attached human + warm-deliver respects the guard) is validated with the attach client in
// Ф0b-3; here we bind the DETECTOR. Bun-native @xterm is loaded dynamically by the function under test.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paneLogComposerOccupied } from './readyGateModel.ts'

const COLS = 80
const ROWS = 24

let dir: string | null = null
function paneLogWith(frame: string): string {
  dir = mkdtempSync(join(tmpdir(), 'iapeer-occ-'))
  const log = join(dir, 'pane.log')
  writeFileSync(log, Buffer.from(frame, 'utf8')) // raw bytes — preserve the multibyte ❯ / › glyphs
  return log
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('paneLogComposerOccupied — guard FIRES on a busy hosted composer (slice-2 acceptance)', () => {
  test('claude ❯ with human text → BUSY (true)', async () => {
    const log = paneLogWith('\x1b[24;1H❯ the quick brown fox')
    expect(await paneLogComposerOccupied(log, COLS, ROWS, 'claude')).toBe(true)
  })

  test('codex › with human text → BUSY (true)', async () => {
    const log = paneLogWith('\x1b[24;1H› reviewer note')
    expect(await paneLogComposerOccupied(log, COLS, ROWS, 'codex')).toBe(true)
  })
})

describe('paneLogComposerOccupied — guard stays COLD on a free composer', () => {
  test('claude ❯ empty → free (false)', async () => {
    const log = paneLogWith('\x1b[24;1H❯ ')
    expect(await paneLogComposerOccupied(log, COLS, ROWS, 'claude')).toBe(false)
  })

  test('dim-ghost placeholder (grey246 + dim) → NOT human → free (false)', async () => {
    const log = paneLogWith('\x1b[24;1H❯ \x1b[2m\x1b[38;5;246mTry "fix typecheck errors"\x1b[0m')
    expect(await paneLogComposerOccupied(log, COLS, ROWS, 'claude')).toBe(false)
  })

  test('no prompt glyph rendered → free (false)', async () => {
    const log = paneLogWith('\x1b[24;1Hjust some output, no composer')
    expect(await paneLogComposerOccupied(log, COLS, ROWS, 'claude')).toBe(false)
  })

  // codex regression: its composer chrome after › is NOT claude's dim/palette-246 ghost. The detector must
  // ghost it anyway (occupied ⟺ DEFAULT-fg AND non-dim). The old check fired BUSY on the truecolor status →
  // spurious "queuedBy: composer" while a human was attached to a codex session.
  test('codex › with TRUECOLOR status hint (model · effort · cwd) → NOT human → free (false)', async () => {
    const log = paneLogWith('\x1b[24;1H› \x1b[38;2;246;226;183mgpt-5.5 xhigh · ~/Projects/iapeer\x1b[0m')
    expect(await paneLogComposerOccupied(log, COLS, ROWS, 'codex')).toBe(false)
  })

  test('codex › with DIM default-fg suggestion (varies) → NOT human → free (false)', async () => {
    const log = paneLogWith('\x1b[24;1H› \x1b[2mFind and fix a bug in @filename\x1b[0m')
    expect(await paneLogComposerOccupied(log, COLS, ROWS, 'codex')).toBe(false)
  })
})

describe('paneLogComposerOccupied — uncertainty is conservative (BUSY)', () => {
  test('missing pane-log → BUSY (true): never paste into a maybe-occupied composer', async () => {
    expect(await paneLogComposerOccupied(join(tmpdir(), 'iapeer-occ-nonexistent.log'), COLS, ROWS, 'claude')).toBe(true)
  })
})
