import { describe, expect, test } from 'bun:test'
import { Terminal } from '@xterm/headless'
import { composerOccupancyFromModel, modelToPlainText } from './index.ts'

// The observer's pty-side verdicts are pure functions of the @xterm model — hermetic, no tmux.
// These mirror the verdicts validated 0-divergence vs the prod tmux verdicts in the migration
// fidelity shadows (occupancy: getCell dim/ghost; ready-gate: isInputReady on plain text).
const build = (frame: string, cols = 80, rows = 24): Promise<Terminal> =>
  new Promise(res => { const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 200 }); t.write(frame, () => res(t)) })

describe('composerOccupancyFromModel (pty occupancy verdict)', () => {
  test('human non-dim text after the prompt glyph → TRUE', async () => {
    const t = await build(`\x1b[24;1H❯ the quick brown fox`)
    expect(composerOccupancyFromModel(t, 80, 24, 'claude')).toBe(true)
  })
  test('dim/ghost placeholder after the glyph → FALSE (the critical discriminator)', async () => {
    const t = await build(`\x1b[24;1H❯ \x1b[2m\x1b[38;5;246mTry "fix typecheck errors"\x1b[0m`)
    expect(composerOccupancyFromModel(t, 80, 24, 'claude')).toBe(false)
  })
  test('empty composer (glyph alone) → FALSE', async () => {
    const t = await build(`\x1b[24;1H❯ `)
    expect(composerOccupancyFromModel(t, 80, 24, 'claude')).toBe(false)
  })
  test('codex glyph › with human text → TRUE', async () => {
    const t = await build(`\x1b[24;1H› reviewer note`)
    expect(composerOccupancyFromModel(t, 80, 24, 'codex')).toBe(true)
  })
  test('no prompt glyph at all → FALSE', async () => {
    const t = await build(`\x1b[24;1Hjust some output line`)
    expect(composerOccupancyFromModel(t, 80, 24, 'claude')).toBe(false)
  })
})

describe('modelToPlainText (feeds isInputReady)', () => {
  test('renders the viewport as plain text (no SGR), trailing-trimmed', async () => {
    const t = await build(`\x1b[1;1Hhello\x1b[2;1H\x1b[1mbold\x1b[0m world`)
    const plain = modelToPlainText(t, 80, 24)
    expect(plain.split('\n')[0]).toBe('hello')
    expect(plain).toContain('bold world')
    expect(plain).not.toContain('\x1b')
  })
})
