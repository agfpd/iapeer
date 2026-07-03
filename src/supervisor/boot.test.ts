import { describe, expect, test } from 'bun:test'
import { codexAdapter } from '../launch/adapters/codex.ts'
import { claudeAdapter } from '../launch/adapters/claude.ts'
import { newStuckGate, nextBootAction, nextNagAction, paneIsStuck, type BootAction, type NagAction } from './boot.ts'

// Fed the REAL runtime adapters (codexAdapter/claudeAdapter) — not fakes — so the test proves the
// supervisor answers the exact dialogs the launch primitive answers, with byte-correct keys.
const bytesOf = (a: BootAction): Buffer => (a.kind === 'dialog' ? a.bytes : Buffer.alloc(0))
const nagBytesOf = (a: NagAction): Buffer => (a.kind === 'dismiss' ? a.bytes : Buffer.alloc(0))

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

describe('nextNagAction — mid-session upsell modals auto-declined off the model', () => {
  // The EXACT live modal (linus ground-truth, cleared on boris+doc). Default cursor on "1. Yes, try it",
  // so a bare Enter would ENABLE fullscreen — the watcher must pick "2. Not now" (literal '2' + Enter).
  const fullscreenModal =
    'Try the new fullscreen render' + 'er?\n' +
    '· Flicker-free output — fixes the flashing you see during long responses\n' +
    '· Mouse support — click to move your cursor or expand results\n' +
    '· Selected text auto-copies to your clipboard\n' +
    '❯ 1. Yes, try it\n' +
    '  2. Not now\n' +
    'Enter to confirm · Esc to cancel'

  test('fullscreen-renderer upsell → literal 2 then Enter ("2\\r"), never a bare Enter', () => {
    const a = nextNagAction(claudeAdapter, fullscreenModal)
    expect(a.kind).toBe('dismiss')
    expect(nagBytesOf(a)).toEqual(Buffer.from('2\r')) // declines (option 2) — never enables fullscreen
  })

  test('decline bytes are cursor-mode INDEPENDENT (no arrow key — arrows mis-fired into fullscreen live)', () => {
    expect(nagBytesOf(nextNagAction(claudeAdapter, fullscreenModal, { appCursorKeys: true }))).toEqual(
      Buffer.from('2\r'),
    )
  })

  test('a transcript merely MENTIONING the renderer is NOT a modal → none (no stray keystroke)', () => {
    // Title words present in prose but the "2. Not now" decision row absent → must not fire.
    expect(nextNagAction(claudeAdapter, 'I switched to the new fullscreen render' + 'er yesterday.').kind).toBe('none')
    expect(nextNagAction(claudeAdapter, 'Try the new fullscreen render' + 'er? (discussing the option)').kind).toBe('none')
  })

  test('clean composer / unrelated dialog → none', () => {
    expect(nextNagAction(claudeAdapter, '❯ \n  bypass permissions on').kind).toBe('none')
    expect(nextNagAction(claudeAdapter, 'Do you trust this folder?\n  1. Yes').kind).toBe('none')
  })

  test('codex has no known mid-session nags → always none', () => {
    expect(nextNagAction(codexAdapter, fullscreenModal).kind).toBe('none')
  })
})

// В60 — the nag-watcher's stuck-gate: a dismiss may fire only when the pane has been COMPLETELY
// static (no pty writes) for the threshold. A live peer rendering the modal text keeps writing →
// the gate never opens; a genuinely blocked modal freezes the pty → it opens after the threshold.
describe('В60 — paneIsStuck (nag-watcher stuck-gate)', () => {
  const T = 10_000

  test('first observation only baselines — never stuck immediately', () => {
    const g = newStuckGate(1000)
    expect(paneIsStuck(g, 42, 1000, T)).toBe(false)
    // even a huge clock jump on the SAME tick sequence counts from the baseline moment
    expect(paneIsStuck(g, 42, 1000 + T, T)).toBe(true)
  })

  test('progressing pane (seq moves) never opens the gate and RE-ARMS it', () => {
    const g = newStuckGate(0)
    expect(paneIsStuck(g, 1, 1000, T)).toBe(false)
    expect(paneIsStuck(g, 2, 9000, T)).toBe(false) // wrote again → re-armed
    expect(paneIsStuck(g, 3, 18_000, T)).toBe(false) // still writing
    // stability restarts from the LAST write, not from the beginning
    expect(paneIsStuck(g, 3, 18_000 + T - 1, T)).toBe(false)
    expect(paneIsStuck(g, 3, 18_000 + T, T)).toBe(true)
  })

  test('static pane under the threshold stays closed; over it — open until progress resumes', () => {
    const g = newStuckGate(0)
    expect(paneIsStuck(g, 7, 0, T)).toBe(false) // baseline
    expect(paneIsStuck(g, 7, T - 1, T)).toBe(false)
    expect(paneIsStuck(g, 7, T, T)).toBe(true)
    expect(paneIsStuck(g, 7, T + 5000, T)).toBe(true) // stays open while still frozen
    expect(paneIsStuck(g, 8, T + 6000, T)).toBe(false) // modal answered → repaint → re-armed
  })

  test('composition: a LIVE peer rendering the modal text does NOT get keys (gate closed), a wedged one does', () => {
    // the exact В40 false-fire pane: modal option row is the bottom-most ❯ row
    const modalPane = ['Try the new fullscreen render' + 'er?', '❯ 1. Yes, ' + 'try it', '  2. No, keep the current renderer'].join('\n')
    const g = newStuckGate(0)
    // peer is actively writing (seq moves): even though the TEXT matches, the caller's gate stays shut
    expect(paneIsStuck(g, 1, 2000, T)).toBe(false)
    expect(paneIsStuck(g, 2, 4000, T)).toBe(false)
    // pty froze on the real modal: gate opens after the threshold → THEN the text/position match fires
    expect(paneIsStuck(g, 2, 4000 + T, T)).toBe(true)
    const a = nextNagAction(claudeAdapter, modalPane)
    expect(a.kind).toBe('dismiss')
    expect(nagBytesOf(a)).toEqual(Buffer.from('2\r'))
  })
})
