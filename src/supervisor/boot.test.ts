import { describe, expect, test } from 'bun:test'
import { codexAdapter } from '../launch/adapters/codex.ts'
import { claudeAdapter } from '../launch/adapters/claude.ts'
import { nextBootAction, type BootAction } from './boot.ts'

// Fed the REAL runtime adapters (codexAdapter/claudeAdapter) — not fakes — so the test proves the
// supervisor answers the exact dialogs the launch primitive answers, with byte-correct keys.
const bytesOf = (a: BootAction): Buffer => (a.kind === 'dialog' ? a.bytes : Buffer.alloc(0))

describe('nextBootAction — codex startup dialogs answered off the model', () => {
  test('dir-trust → Enter (CR)', () => {
    const a = nextBootAction(codexAdapter, 'Do you trust the contents of this directory?\n  1. Yes, continue')
    expect(a.kind).toBe('dialog')
    expect(bytesOf(a)).toEqual(Buffer.from('\r'))
  })

  test('update offer → decline [2,Enter], and NOT ready while "Press enter to continue" is up', () => {
    const pane = 'Update available! 9.9.9\nPress enter to continue'
    const a = nextBootAction(codexAdapter, pane)
    expect(a.kind).toBe('dialog')
    expect(bytesOf(a)).toEqual(Buffer.from('2\r'))
  })

  test('hooks-review → [Down,Enter]; the cursor byte follows the model cursor mode', () => {
    const pane = 'Hooks need review\n  1. Review  2. Trust all and continue'
    expect(bytesOf(nextBootAction(codexAdapter, pane))).toEqual(Buffer.from('\x1b[B\r')) // normal
    expect(bytesOf(nextBootAction(codexAdapter, pane, { appCursorKeys: true }))).toEqual(Buffer.from('\x1bOB\r')) // DECCKM
  })

  test('composer rendered, no startup screen → ready', () => {
    expect(nextBootAction(codexAdapter, 'a rotating tip line\n› ').kind).toBe('ready')
  })

  test('splash up, composer not yet rendered → wait', () => {
    expect(nextBootAction(codexAdapter, 'OpenAI Codex\n(loading session)').kind).toBe('wait')
  })
})

describe('nextBootAction — claude startup dialogs answered off the model', () => {
  test('folder-trust → Enter (CR)', () => {
    const a = nextBootAction(claudeAdapter, 'Do you trust this folder?\n  1. Yes')
    expect(a.kind).toBe('dialog')
    expect(bytesOf(a)).toEqual(Buffer.from('\r'))
  })

  test('resume-picker before the cursor reaches option 2 → Down (mode-correct cursor byte)', () => {
    const pane = 'Resume from summary\n  ❯ 1. Start fresh\n    2. Resume full session'
    const a = nextBootAction(claudeAdapter, pane)
    expect(a.kind).toBe('dialog')
    expect(bytesOf(a)).toEqual(Buffer.from('\x1b[B')) // normal cursor mode
    expect(bytesOf(nextBootAction(claudeAdapter, pane, { appCursorKeys: true }))).toEqual(Buffer.from('\x1bOB'))
  })

  test('resume-picker once the cursor IS on option 2 → Enter (never re-Downs past the proceed row)', () => {
    const pane = 'Resume from summary\n    1. Start fresh\n  ❯ 2. Resume full session'
    expect(bytesOf(nextBootAction(claudeAdapter, pane))).toEqual(Buffer.from('\r'))
  })

  test('input row + bypass banner → ready', () => {
    expect(nextBootAction(claudeAdapter, '❯ \n  bypass permissions on').kind).toBe('ready')
  })

  test('splash up, input row not yet rendered → wait', () => {
    expect(nextBootAction(claudeAdapter, 'Welcome to Claude Code\n  (starting)').kind).toBe('wait')
  })
})
