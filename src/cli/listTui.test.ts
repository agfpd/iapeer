// list TUI — the PURE render + key state-machine (the raw-mode loop is live-verified).

import { describe, expect, test } from 'bun:test'
import { filterRows, handleListKey, renderListPanel, type TuiState } from './listTui.ts'
import type { PeerListing } from './index.ts'

function row(over: Partial<PeerListing>): PeerListing {
  return {
    personality: 'p',
    default_runtime: 'claude',
    intelligence: 'artificial',
    description: '',
    cwd: '/tmp/p',
    runtimes: [{ runtime: 'claude', status: 'asleep' }],
    ...over,
  }
}
const ROWS: PeerListing[] = [
  row({ personality: 'nova', default_runtime: 'telegram', description: 'owner' }),
  row({ personality: 'boris', runtimes: [{ runtime: 'claude', status: 'live' }], last_active_runtime: 'claude' }),
  row({ personality: 'doc' }),
]
const S0: TuiState = { cursor: 0, filter: '', filterMode: false }

describe('filterRows', () => {
  test('case-insensitive substring over personality + description', () => {
    expect(filterRows(ROWS, 'BOR').map(r => r.personality)).toEqual(['boris'])
    expect(filterRows(ROWS, 'owner').map(r => r.personality)).toEqual(['nova']) // description match
    expect(filterRows(ROWS, '').length).toBe(3) // empty → all
  })
})

describe('renderListPanel', () => {
  test('selected row carries the ❯ caret + reverse-video; others do not', () => {
    const frame = renderListPanel(ROWS, { ...S0, cursor: 1 })
    expect(frame).toContain('\x1b[7m❯ boris') // reverse + caret on the cursor row
    expect(frame).toContain('nova') // other rows present, no caret
    expect(frame).not.toContain('❯ nova')
    expect(frame).toContain('● claude') // boris live glyph
  })
  test('filter narrows the rendered rows', () => {
    const frame = renderListPanel(ROWS, { ...S0, filter: 'doc' })
    expect(frame).toContain('doc')
    expect(frame).not.toContain('nova')
  })
})

describe('handleListKey', () => {
  const visible = ROWS
  test('↓/↑ move the cursor, clamped to bounds', () => {
    expect(handleListKey('\x1b[B', S0, visible).state.cursor).toBe(1) // down
    expect(handleListKey('\x1b[A', S0, visible).state.cursor).toBe(0) // up clamped at 0
    expect(handleListKey('\x1b[B', { ...S0, cursor: 2 }, visible).state.cursor).toBe(2) // down clamped at last
  })
  test('Enter → attach action with the selected peer', () => {
    const r = handleListKey('\r', { ...S0, cursor: 1 }, visible)
    expect(r.action).toEqual({ type: 'attach', personality: 'boris' })
  })
  test('q / Ctrl-C → quit', () => {
    expect(handleListKey('q', S0, visible).action).toEqual({ type: 'quit' })
    expect(handleListKey('\x03', S0, visible).action).toEqual({ type: 'quit' })
  })
  test('/ enters filter mode; typing edits the filter; Enter leaves it', () => {
    const f = handleListKey('/', S0, visible)
    expect(f.state.filterMode).toBe(true)
    const typed = handleListKey('b', f.state, visible)
    expect(typed.state.filter).toBe('b')
    const left = handleListKey('\r', typed.state, visible)
    expect(left.state.filterMode).toBe(false)
  })
})
