import { describe, expect, test } from 'bun:test'
import { codexAdapter } from '../launch/adapters/codex.ts'
import { claudeAdapter } from '../launch/adapters/claude.ts'
import { newStuckGate, nextBootAction, nextNagAction, paneIsStuck, type BootAction, type NagAction } from './boot.ts'

// Fed the REAL runtime adapters (codexAdapter/claudeAdapter) — not fakes — so the test proves the
// supervisor answers the exact dialogs the launch primitive answers, with byte-correct keys.
const bytesOf = (a: BootAction): Buffer => (a.kind === 'dialog' ? a.bytes : Buffer.alloc(0))
const nagBytesOf = (a: NagAction): Buffer => (a.kind === 'dismiss' || a.kind === 'approve' ? a.bytes : Buffer.alloc(0))
const nagDenyBytesOf = (a: NagAction): Buffer => (a.kind === 'approve' ? a.denyBytes : Buffer.alloc(0))

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

  test('hooks-review → a single "2" (В41: select-by-number commits immediately — live capture 0.139.0)', () => {
    // fixture = the REAL modal as captured live (isolated CODEX_HOME, 03.07): numbered
    // options, `›` selector on option 1. A bare digit selects AND commits — one key,
    // nothing to swallow between two (the old blind ['Down','Enter'] burst class).
    const pane = [
      '  Hooks need review',
      '  1 hook is new or changed.',
      '  Hooks can run outside the sandbox after you trust them.',
      '',
      '› 1. Review hooks',
      '  2. Trust all and continue',
      "  3. Continue without trusting (hooks won't run)",
      '',
      '  Press enter to confirm or esc to go back',
    ].join('\n')
    expect(bytesOf(nextBootAction(codexAdapter, pane))).toEqual(Buffer.from('2'))
    // digit bytes are mode-independent (no cursor keys involved anymore)
    expect(bytesOf(nextBootAction(codexAdapter, pane, { appCursorKeys: true }))).toEqual(Buffer.from('2'))
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

describe('nextNagAction — dangerous-rm circuit-breaker auto-confirmed (owner: press YES + log)', () => {
  // The EXACT live pane (claude 2.1.201 pty capture): the breaker sits ABOVE bypass, default cursor on
  // "1. Yes". Needles split-literal so THIS test file / a peer reviewing it stays inert (В40 discipline).
  const rmPrompt = [
    '❯ Use the Bash tool to run exactly this and nothing else: rm -rf', // composer ECHO (must NOT be taken as the cmd)
    '  /tmp/iapeer-rmrepro-cwd-XY',
    '',
    ' Bash command',
    '',
    '   rm -rf /tmp/iapeer-rmrepro-cwd-XY', // the ACTUAL command line (Bash-command block)
    '   Delete the temp directory (current working directory)',
    '',
    ' Dangerous r' + 'm operation on working directory or its ' + 'ancestor:',
    ' /tmp/iapeer-rmrepro-cwd-XY',
    '',
    ' Do you want to ' + 'proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\n')

  test('dangerous-rm confirm → kind approve, literal "1" then Enter (YES), never a bare guess', () => {
    const a = nextNagAction(claudeAdapter, rmPrompt)
    expect(a.kind).toBe('approve')
    expect(nagBytesOf(a)).toEqual(Buffer.from('1\r')) // presses YES so a headless peer never hangs
  })

  test('approve carries the audit trace (taxonomy + parsed command/target)', () => {
    const a = nextNagAction(claudeAdapter, rmPrompt)
    if (a.kind !== 'approve') throw new Error('expected approve')
    expect(a.taxonomy).toBe('dangerous-rm')
    expect(a.detail).toContain('cmd="rm -rf /tmp/iapeer-rmrepro-cwd-XY"') // the ACTUAL command, not the composer echo
    expect(a.detail).not.toContain('Use the Bash tool') // the echoed prompt line is never mistaken for the command
    expect(a.detail).toContain('target="/tmp/iapeer-rmrepro-cwd-XY"') // the guarded target path
  })

  test('affirmative bytes are cursor-mode INDEPENDENT (no arrow key)', () => {
    expect(nagBytesOf(nextNagAction(claudeAdapter, rmPrompt, { appCursorKeys: true }))).toEqual(Buffer.from('1\r'))
  })

  test('gated DECLINE keys = "2" then Enter (2-option layout: 1.Yes / 2.No)', () => {
    const a = nextNagAction(claudeAdapter, rmPrompt)
    if (a.kind !== 'approve') throw new Error('expected approve')
    expect(a.denyKeys).toEqual(['2', 'Enter']) // dangerous-rm is 2-option → No is "2"
    expect(nagDenyBytesOf(a)).toEqual(Buffer.from('2\r')) // cursor-mode independent (literal digit)
  })

  test('a mere QUOTE of the breaker (ready composer ❯ below, not on "1. Yes") → none', () => {
    const quote = [
      'the peer explained the guard:',
      ' Dangerous r' + 'm operation on working directory or its ' + 'ancestor: /x',
      ' Do you want to ' + 'proceed? 1. Yes 2. No',
      '❯ ', // the ready composer is the bottom-most ❯ row — a quote, not a live select
      '  bypass permissions on',
    ].join('\n')
    expect(nextNagAction(claudeAdapter, quote).kind).toBe('none')
  })

  test('rmdir variant matches the same signature (breaker phrase shared)', () => {
    const rmdir = rmPrompt.replace('rm -rf /tmp', 'rmdir /tmp').replace('Dangerous r' + 'm operation', 'Dangerous r' + 'mdir operation')
    expect(nextNagAction(claudeAdapter, rmdir).kind).toBe('approve')
  })

  test('codex has no circuit-breaker confirm → none', () => {
    expect(nextNagAction(codexAdapter, rmPrompt).kind).toBe('none')
  })
})

describe('nextNagAction — command-approval circuit-breaker (standard 3-option prompt, auto-YES + log)', () => {
  // The EXACT live render (claude 2.1.201, captured via a nested pty in default mode — the SAME prompt a
  // yolo peer sees when the runtime disables its bypass mid-session, or a gated peer whose hook missed).
  // A THREE-option select ("1. Yes / 2. Yes,… / 3. No") under "Do you want to proceed?" — distinct from
  // the dangerous-rm breaker's TWO-option "1. Yes / 2. No". Prose needles split-literal (В40).
  const cmdApprovalPrompt = [
    '❯ Yes, run it now. Just invoke the Bash tool with: env | grep -c PATH', // composer ECHO (❯ ABOVE the live select)
    '',
    '⏺ Bash(env | grep -c PATH)',
    '  ⎿  Waiting…',
    '',
    ' Bash command',
    '',
    '   env | grep -c PATH', // the ACTUAL command line (Bash-command block)
    '   Count env vars containing PATH',
    '',
    ' This command requires appr' + 'oval',
    '',
    ' Do you want to ' + 'proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don' + "'t ask again for: env",
    '   3. No',
    '',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\n')

  test('command-approval → kind approve, literal "1" then Enter (YES) so a headless peer never hangs', () => {
    const a = nextNagAction(claudeAdapter, cmdApprovalPrompt)
    expect(a.kind).toBe('approve')
    expect(nagBytesOf(a)).toEqual(Buffer.from('1\r'))
  })

  test('approve carries a DISTINCT taxonomy + the parsed command (not the composer echo)', () => {
    const a = nextNagAction(claudeAdapter, cmdApprovalPrompt)
    if (a.kind !== 'approve') throw new Error('expected approve')
    expect(a.taxonomy).toBe('command-approval') // NOT dangerous-rm — the broker/audit tells them apart
    expect(a.detail).toContain('cmd="env | grep -c PATH"')
    expect(a.detail).not.toContain('Just invoke the Bash tool') // the echoed prompt is never the command
  })

  test('affirmative bytes are cursor-mode INDEPENDENT (no arrow key)', () => {
    expect(nagBytesOf(nextNagAction(claudeAdapter, cmdApprovalPrompt, { appCursorKeys: true }))).toEqual(Buffer.from('1\r'))
  })

  test('gated DECLINE keys = "3" then Enter (3-option layout: 1.Yes / 2.Yes,… / 3.No)', () => {
    const a = nextNagAction(claudeAdapter, cmdApprovalPrompt)
    if (a.kind !== 'approve') throw new Error('expected approve')
    expect(a.denyKeys).toEqual(['3', 'Enter']) // command-approval is 3-option → No is "3" (NOT "2", which is "Yes, and…")
    expect(nagDenyBytesOf(a)).toEqual(Buffer.from('3\r'))
  })

  test('file-access variant ("2. Yes, and always allow access …") matches the same signature', () => {
    const fileApprovalPrompt = [
      ' Bash command',
      '',
      '   touch /tmp/nagrepro/probe && ls -la /tmp/nagrepro',
      '   Create probe file and list directory',
      '',
      ' Do you want to ' + 'proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and always allow access to nagrepro/ from this project',
      '   3. No',
      '',
      ' Esc to cancel · Tab to amend · ctrl+e to explain',
    ].join('\n')
    const a = nextNagAction(claudeAdapter, fileApprovalPrompt)
    expect(a.kind).toBe('approve')
    if (a.kind !== 'approve') throw new Error('expected approve')
    expect(a.taxonomy).toBe('command-approval')
  })

  // BORIS HARD CRITERION: an org-policy prompt ("Your organization requires approval for this tool", an
  // MCP restriction) MUST NOT be auto-pressed — the owner's org rule is human-only. docs/17 yolo-
  // robustness: it is now a RECOGNIZED-but-ALWAYS-HUMAN class (alwaysHuman:true) — routed to the broker
  // under BOTH modes, never auto-Yes, with its own taxonomy + the precise 3-option keys.
  const orgPolicyPrompt = [
    ' some_mcp__server__tool',
    '',
    ' Your ' + 'organization requires ' + 'approval' + ' for this tool',
    '',
    ' Do you want to ' + 'proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don' + "'t ask again",
    '   3. No',
    '',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\n')
  test('org-policy prompt → approve+alwaysHuman (never auto-Yes), taxonomy org-policy, precise 1/3 keys', () => {
    const a = nextNagAction(claudeAdapter, orgPolicyPrompt)
    expect(a.kind).toBe('approve')
    if (a.kind !== 'approve') throw new Error('expected approve')
    expect(a.taxonomy).toBe('org-policy')
    expect(a.alwaysHuman).toBe(true) // routed to the human even on a YOLO peer (owner rule: never auto)
    expect(a.brokerKind).toBe('circuit-breaker')
    expect(a.keys).toEqual(['1', 'Enter']) // Allow = 1.Yes
    expect(a.denyKeys).toEqual(['3', 'Enter']) // Deny = 3.No (3-option layout)
  })
  test('org-policy is NOT reclassified as the generic unknown-modal (recognized → precise keys)', () => {
    const a = nextNagAction(claudeAdapter, orgPolicyPrompt)
    if (a.kind !== 'approve') throw new Error('expected approve')
    expect(a.taxonomy).not.toBe('unknown-modal')
  })

  test('a mere QUOTE of the prompt (ready composer ❯ below, not on "1. Yes") → none', () => {
    const quote = [
      'the peer pasted the approval prompt into chat:',
      ' Do you want to ' + 'proceed?',
      '   1. Yes   2. Yes, and always allow   3. No',
      '❯ ', // the ready composer is the bottom-most ❯ row — a quote, not a live select
      '  bypass permissions on',
    ].join('\n')
    expect(nextNagAction(claudeAdapter, quote).kind).toBe('none')
  })

  test('REGRESSION: the dangerous-rm breaker still classifies as dangerous-rm, not command-approval', () => {
    // the rm breaker's 2-option pane must be owned by its own taxonomy (it fails the 3-option test anyway)
    const rmPrompt = [
      ' Bash command',
      '   rm -rf /tmp/iapeer-rmrepro-cwd-XY',
      ' Dangerous r' + 'm operation on working directory or its ' + 'ancestor:',
      ' /tmp/iapeer-rmrepro-cwd-XY',
      ' Do you want to ' + 'proceed?',
      ' ❯ 1. Yes',
      '   2. No',
    ].join('\n')
    const a = nextNagAction(claudeAdapter, rmPrompt)
    expect(a.kind).toBe('approve')
    if (a.kind !== 'approve') throw new Error('expected approve')
    expect(a.taxonomy).toBe('dangerous-rm')
  })

  test('codex has no command-approval circuit-breaker → none', () => {
    expect(nextNagAction(codexAdapter, cmdApprovalPrompt).kind).toBe('none')
  })
})

// docs/17 yolo-robustness — the GENERIC unknown-modal detector: a numbered-SELECT modal matching NONE of
// the known signatures (a new modal Anthropic/OpenAI shipped). Detected structurally (bottom-most glyph
// row is a numbered option + ≥2 options), routed ALWAYS to the human with fixed option-1-or-cancel keys.
describe('nextNagAction — generic unknown blocking modal (docs/17 yolo-robustness)', () => {
  // A REAL claude modal we do NOT have a needle for — e.g. an AskUserQuestion-style select. Its text
  // matches no known signature, but structurally it IS a live numbered select that replaced the composer.
  const unknownModal = [
    'How should I handle the migration?',
    '',
    '❯ 1. Rewrite the schema in place',
    '  2. Create a new versioned table',
    '  3. Ask me again later',
    '',
    'Enter to confirm · Esc to cancel',
  ].join('\n')

  test('unknown numbered select → approve, taxonomy unknown-modal, alwaysHuman, Allow=1/Enter Deny=Escape', () => {
    const a = nextNagAction(claudeAdapter, unknownModal)
    expect(a.kind).toBe('approve')
    if (a.kind !== 'approve') throw new Error('expected approve')
    expect(a.taxonomy).toBe('unknown-modal')
    expect(a.alwaysHuman).toBe(true) // to the human in BOTH modes
    expect(a.brokerKind).toBe('unknown-modal')
    expect(a.keys).toEqual(['1', 'Enter']) // Allow presses option 1
    expect(a.denyKeys).toEqual(['Escape']) // Deny cancels the modal (universal Esc)
    expect(nagBytesOf(a)).toEqual(Buffer.from('1\r'))
    expect(nagDenyBytesOf(a)).toEqual(Buffer.from('\x1b')) // Escape byte
  })

  test('carries the verbatim block + option-1 label (for explicit human button semantics)', () => {
    const a = nextNagAction(claudeAdapter, unknownModal)
    if (a.kind !== 'approve') throw new Error('expected approve')
    expect(a.option1).toBe('Rewrite the schema in place') // what an Allow will press — shown to the human
    expect(a.detail).toContain('How should I handle the migration?') // verbatim question
    expect(a.detail).toContain('2. Create a new versioned table') // verbatim options
  })

  test('Deny bytes are cursor-mode INDEPENDENT (Escape is a plain \\x1b either way)', () => {
    expect(nagDenyBytesOf(nextNagAction(claudeAdapter, unknownModal, { appCursorKeys: true }))).toEqual(Buffer.from('\x1b'))
  })

  test('a lone numbered line (only "1.") is NOT a select → none (needs ≥2 options)', () => {
    const lone = ['Here is step one:', '❯ 1. do the thing', '', '❯ '].join('\n')
    expect(nextNagAction(claudeAdapter, lone).kind).toBe('none')
  })

  test('a QUOTE of a modal (ready composer ❯ is the bottom-most row) → none', () => {
    const quote = [
      'the peer pasted a menu into chat:',
      '  1. Option A',
      '  2. Option B',
      '❯ ', // ready composer below the quote — bottom-most ❯ is not a numbered option
      '  bypass permissions on',
    ].join('\n')
    expect(nextNagAction(claudeAdapter, quote).kind).toBe('none')
  })

  test('an idle composer / boot dialog is never seen as an unknown modal → none', () => {
    expect(nextNagAction(claudeAdapter, '❯ \n  bypass permissions on').kind).toBe('none')
    // a boot dialog (owned by the boot-driver) is excluded even though it is a numbered select
    expect(nextNagAction(claudeAdapter, 'Resume from summary\n❯ 1. Resume from summary\n  2. Resume full session').kind).toBe('none')
  })

  test('a KNOWN signature still wins its precise taxonomy (unknown detector is the last resort)', () => {
    // the command-approval pane must classify as command-approval, NOT unknown-modal
    const cmd = [' Bash command', '   ls', ' Do you want to ' + 'proceed?', ' ❯ 1. Yes', '   2. Yes, and always allow', '   3. No'].join('\n')
    const a = nextNagAction(claudeAdapter, cmd)
    if (a.kind !== 'approve') throw new Error('expected approve')
    expect(a.taxonomy).toBe('command-approval')
  })

  test('codex — a "›"-glyph numbered select is caught too (non-hookable modal → human)', () => {
    const codexModal = [
      'Allow the MCP server to read this file?',
      '',
      '› 1. Yes, allow once',
      '  2. No, deny',
      '',
      'Press enter to confirm or esc to go back',
    ].join('\n')
    const a = nextNagAction(codexAdapter, codexModal)
    expect(a.kind).toBe('approve')
    if (a.kind !== 'approve') throw new Error('expected approve')
    expect(a.taxonomy).toBe('unknown-modal')
    expect(a.option1).toBe('Yes, allow once')
  })

  test('codex — a known boot dialog (hooks-review) is NOT re-routed as unknown (boot-driver owns it)', () => {
    const hooks = ['Hooks need review', '', '› 1. Review hooks', '  2. Trust all and continue'].join('\n')
    expect(nextNagAction(codexAdapter, hooks).kind).toBe('none')
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
