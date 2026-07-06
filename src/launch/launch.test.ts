import { describe, expect, test } from 'bun:test'
import { exitLogPath, getAdapter, launch } from './index.ts'
import { claudeAdapter } from './adapters/claude.ts'
import { codexAdapter } from './adapters/codex.ts'
import { telegramAdapter } from './adapters/telegram.ts'
import { notifierAdapter } from './adapters/notifier.ts'
import { voicetalkAdapter } from './adapters/voicetalk.ts'
import { defaultIntelligenceForRuntime, INFRA_RUNTIME_BIN_ENV, INFRA_RUNTIME_DEFAULT_BIN, isInfraRuntime } from '../core/constants.ts'
import type { LaunchAdapterConfig, LaunchConfig, LaunchSpec } from './types.ts'

const cfg: LaunchAdapterConfig = { claudeBin: '/bin/claude', codexBin: 'codex' }
// Full LaunchConfig for the gate tests — the intelligence gate returns FAILED at
// step 0, BEFORE any tmux/FS work, so these values are never exercised.
const launchCfg: LaunchConfig = {
  claudeBin: '/bin/claude',
  codexBin: 'codex',
  sockDir: '/tmp',
  bootDeadlineSecs: 1,
  readyGateSecs: 1,
  logDir: '/tmp/iapeer-test-logs',
}
function spec(over: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    personality: 'p',
    runtime: 'claude',
    cwd: '/tmp/p',
    identity: 'claude-p',
    socketPath: '/tmp/tmux-iap-claude-p.sock',
    ...over,
  }
}

describe('getAdapter', () => {
  test('dispatches each runtime to its adapter', () => {
    expect(getAdapter('claude')).toBe(claudeAdapter)
    expect(getAdapter('codex')).toBe(codexAdapter)
    expect(getAdapter('telegram')).toBe(telegramAdapter)
    expect(getAdapter('notifier')).toBe(notifierAdapter)
    expect(getAdapter('voicetalk')).toBe(voicetalkAdapter)
  })
  test('codex is tui+doctrine, telegram is router+no-doctrine', () => {
    expect(codexAdapter.kind).toBe('tui')
    expect(codexAdapter.usesDoctrine).toBe(true)
    expect(telegramAdapter.kind).toBe('router')
    expect(telegramAdapter.usesDoctrine).toBe(false)
  })
  test('unknown runtime throws', () => {
    expect(() => getAdapter('webhook')).toThrow()
  })
})

describe('codexAdapter.buildArgv', () => {
  test('bare (no resume, no doctrine): --no-alt-screen -C cwd --dangerously-bypass', () => {
    expect(codexAdapter.buildArgv(spec({ runtime: 'codex', cwd: '/w' }), cfg)).toEqual([
      'codex',
      '--no-alt-screen',
      '-C',
      '/w',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
  })
  test('with resume + model_instructions_file (exact order)', () => {
    expect(
      codexAdapter.buildArgv(spec({ runtime: 'codex', cwd: '/w', resume: true, systemPromptFile: '/sp.md' }), cfg),
    ).toEqual([
      'codex',
      'resume',
      '--last',
      '--no-alt-screen',
      '-C',
      '/w',
      '-c',
      'model_instructions_file=/sp.md',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
  })
})

describe('approval-mode toggle — buildArgv + ready gate (docs/17)', () => {
  test('claude yolo (default): --dangerously-skip-permissions, NO --permission-mode', () => {
    const argv = claudeAdapter.buildArgv(spec({ runtime: 'claude', cwd: '/w' }), cfg)
    expect(argv).toContain('--dangerously-skip-permissions')
    expect(argv).not.toContain('--permission-mode')
  })
  test('claude gated: NO bypass, explicit --permission-mode default', () => {
    const argv = claudeAdapter.buildArgv(spec({ runtime: 'claude', cwd: '/w', approvalMode: 'gated' }), cfg)
    expect(argv).not.toContain('--dangerously-skip-permissions')
    expect(argv.join(' ')).toContain('--permission-mode default')
    // still headless-safe: AskUserQuestion stays disallowed in BOTH modes (owner policy)
    expect(argv.join(' ')).toContain('--disallowedTools AskUserQuestion')
  })
  test('codex yolo (default): the YOLO bypass flag', () => {
    const argv = codexAdapter.buildArgv(spec({ runtime: 'codex', cwd: '/w' }), cfg)
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(argv.join(' ')).not.toContain('approval_policy')
  })
  test('codex gated: NO bypass, approvals on + sandbox off (danger-full-access)', () => {
    const argv = codexAdapter.buildArgv(spec({ runtime: 'codex', cwd: '/w', approvalMode: 'gated' }), cfg)
    expect(argv).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(argv.join(' ')).toContain('approval_policy=on-request')
    expect(argv.join(' ')).toContain('sandbox_mode=danger-full-access')
  })
  test('claude isInputReady is mode-aware: gated ready pane has NO bypass banner', () => {
    const gatedReady = 'some output\n❯ Try "edit <filepath> to..."\n' // no "bypass permissions on"
    const yoloReady = 'some output\n❯ \nbypass permissions on'
    // yolo (default): needs the banner
    expect(claudeAdapter.isInputReady(gatedReady)).toBe(false)
    expect(claudeAdapter.isInputReady(yoloReady)).toBe(true)
    // gated: the composer '❯' with boot dialogs cleared is enough (no banner)
    expect(claudeAdapter.isInputReady(gatedReady, 'gated')).toBe(true)
    expect(claudeAdapter.isInputReady(yoloReady, 'gated')).toBe(true)
    // a boot dialog up → NOT ready, in either mode
    const trustDialog = '❯ 1. Yes, I trust this folder\n  2. No, exit\ntrust this folder'
    expect(claudeAdapter.isInputReady(trustDialog, 'gated')).toBe(false)
    // no composer glyph at all → not ready
    expect(claudeAdapter.isInputReady('booting, no prompt yet', 'gated')).toBe(false)
  })
})

describe('codexAdapter.isInputReady', () => {
  test('fresh boot: splash + composer → true', () => {
    const pane = [
      '╭───────────────────────────────╮',
      '│ >_ OpenAI Codex (v0.138.0)    │',
      '╰───────────────────────────────╯',
      '› Explain this codebase',
      'gpt-5.5 xhigh · ~/Peers/p',
    ].join('\n')
    expect(codexAdapter.isInputReady(pane)).toBe(true)
  })

  test('resume replay scrolled the splash off — composer alone is READY (12.06 incident)', () => {
    // The live zombie pane shape: history tail + MCP noise + composer, NO
    // 'OpenAI Codex' anywhere in the visible capture. The old predicate required
    // the splash and spun false for the whole 240 s boot deadline.
    const pane = [
      '  <message><![CDATA[Компакт прошел?]]></message>',
      '  </iap>',
      '• Принял. Ответ пиру не слал: он явно написал, что больше ничего не нужно.',
      '⚠ MCP startup incomplete (failed: iap)',
      '› Explain this codebase',
      'gpt-5.5 xhigh · ~/Peers/p',
    ].join('\n')
    expect(pane.includes('OpenAI Codex')).toBe(false) // fixture honesty
    expect(codexAdapter.isInputReady(pane)).toBe(true)
  })

  test('update screen up → false even with a composer-looking line', () => {
    const pane = ['Update available!', 'Press enter to continue', '› something'].join('\n')
    expect(codexAdapter.isInputReady(pane)).toBe(false)
  })

  test('no composer row yet (box only, model loading) → false', () => {
    const pane = ['│ >_ OpenAI Codex (v0.138.0) │', '│ model: loading │'].join('\n')
    expect(codexAdapter.isInputReady(pane)).toBe(false)
  })

  test('bare › without trailing space (a stray glyph) → false', () => {
    expect(codexAdapter.isInputReady('›\nnothing else')).toBe(false)
  })
})


describe('Б8 claude boot-predicate tightening (В39 mcp-approval / В40 fullscreen-nag position)', () => {
  const READY = ['some transcript output', '❯ ', 'bypass permissions on'].join('\n')
  test('В39: isInputReady is NOT gated by a conversational mention of the mcp-approval topic', () => {
    // a resumed session replays a tail that MENTIONS the topic phrase (agents discuss MCP servers) →
    // must stay ready; only the real dialog ("… found in this project") gates.
    const mention = READY + '\nwe should add a new MCP server for X'
    expect(claudeAdapter.isInputReady(mention)).toBe(true)
    const realDialog = '2 new MCP servers found in this project\n[✔] fooServer\n❯ 1. Yes'
    expect(claudeAdapter.isInputReady(realDialog)).toBe(false)
    expect(claudeAdapter.bootDialogKeys(realDialog)).toEqual(['Enter'])
    expect(claudeAdapter.bootDialogKeys(READY + '\nnew MCP server idea')).toBeNull() // mention → no key
  })

  // The fullscreen-nag needles are BUILT from fragments so this test file never carries the verbatim
  // modal text (which would self-trigger a nag-watcher reading it — the live incident this fixes).
  const T = 'Try the new fullscreen render' + 'er?'
  const YES = 'Yes, ' + 'try it'
  const NOTNOW = '2. Not ' + 'now'
  test('В40: fires ONLY when the modal is the LIVE bottom surface (cursor on its option)', () => {
    // live modal: composer is REPLACED, the bottom-most cursor row is the modal option
    const live = [T, '· Flicker-free output', '❯ 1. ' + YES, '  ' + NOTNOW, 'Enter to confirm · Esc to cancel'].join('\n')
    expect(claudeAdapter.nagDismissKeys!(live)).toEqual(['2', 'Enter'])
    // a QUOTE of the modal with the ready composer BELOW it (peer editing/reviewing, or a forwarded
    // message) → the bottom-most cursor is the empty composer, NOT the option → must NOT fire
    const quoted = [T, '❯ 1. ' + YES, '  ' + NOTNOW, 'Enter to confirm', 'discussing the incident…', '❯ '].join('\n')
    expect(claudeAdapter.nagDismissKeys!(quoted)).toBeNull()
    // no modal at all → null
    expect(claudeAdapter.nagDismissKeys!(READY)).toBeNull()
  })
})

describe('В58 claudeAdapter.childActivityMtime (idle-proxy sees a running workflow)', () => {
  // NB the real-file scan cannot be exercised hermetically here: transcriptDir resolves the home via
  // os.homedir() (which ignores $HOME on POSIX), so a temp-HOME slug is unreachable. The scan is
  // runtime-verified (returns a real subagent mtime for a repo cwd, null for a nonexistent one), and the
  // idle-proxy FOLD is unit-tested via the childActivityMtime seam in lifecycle.test.ts.
  test('a cwd with no transcript slug dir → null (the null path is safe)', () => {
    expect(claudeAdapter.childActivityMtime!('/tmp/iapeer-no-such-cwd-xyz')).toBeNull()
  })
})

describe('telegramAdapter (router — no TUI surface)', () => {
  test('router predicates are trivial', () => {
    expect(telegramAdapter.bootDialogKeys('anything')).toBeNull()
    expect(telegramAdapter.isInputReady('anything')).toBe(true)
    expect(telegramAdapter.newestActivityMtime('/w')).toBeNull()
  })
})

describe('voicetalkAdapter (router — presence-runtime, human voice channel)', () => {
  test('kind:router, no doctrine, allows natural|absent (channel: human or faceless service bot)', () => {
    expect(voicetalkAdapter.runtime).toBe('voicetalk')
    expect(voicetalkAdapter.kind).toBe('router')
    expect(voicetalkAdapter.usesDoctrine).toBe(false)
    expect(voicetalkAdapter.allowedIntelligences).toEqual(['natural', 'absent']) // human OR faceless service; never an LLM agent
  })
  test('buildArgv = voicetalk-runtime run [+extra], default + pinned bin', () => {
    expect(voicetalkAdapter.buildArgv(spec({ runtime: 'voicetalk' }), cfg)).toEqual(['voicetalk-runtime', 'run'])
    expect(
      voicetalkAdapter.buildArgv(spec({ runtime: 'voicetalk', extraArgs: ['--foo'] }), { ...cfg, voicetalkBin: '/v/bin' }),
    ).toEqual(['/v/bin', 'run', '--foo'])
  })
  test('router predicates are trivial', () => {
    expect(voicetalkAdapter.bootDialogKeys('anything')).toBeNull()
    expect(voicetalkAdapter.isInputReady('anything')).toBe(true)
    expect(voicetalkAdapter.newestActivityMtime('/w')).toBeNull()
    expect(voicetalkAdapter.resolveResume('/w').ok).toBe(true)
    expect(voicetalkAdapter.executeControl({ kind: 'interrupt' } as never)).toBeNull()
  })
})

describe('voicetalk runtime classification (constants)', () => {
  test('voicetalk is infra (launchd always-on) + natural + has bin mappings', () => {
    expect(isInfraRuntime('voicetalk')).toBe(true)
    expect(defaultIntelligenceForRuntime('voicetalk')).toBe('natural')
    expect(INFRA_RUNTIME_DEFAULT_BIN.voicetalk).toBe('voicetalk-runtime')
    expect(INFRA_RUNTIME_BIN_ENV.voicetalk).toBe('VOICETALK_RUNTIME_BIN')
  })
})

describe('notifierAdapter (router — infra/always-on)', () => {
  test('kind:router, no doctrine', () => {
    expect(notifierAdapter.runtime).toBe('notifier')
    expect(notifierAdapter.kind).toBe('router')
    expect(notifierAdapter.usesDoctrine).toBe(false)
  })
  test('buildArgv = notifier-runtime run [+extra], default bin', () => {
    expect(notifierAdapter.buildArgv(spec({ runtime: 'notifier' }), cfg)).toEqual(['notifier-runtime', 'run'])
    expect(
      notifierAdapter.buildArgv(spec({ runtime: 'notifier', extraArgs: ['--foo'] }), { ...cfg, notifierBin: '/n/bin' }),
    ).toEqual(['/n/bin', 'run', '--foo'])
  })
  test('router predicates are trivial (no TUI surface)', () => {
    expect(notifierAdapter.bootDialogKeys('anything')).toBeNull()
    expect(notifierAdapter.isInputReady('anything')).toBe(true)
    expect(notifierAdapter.newestActivityMtime('/w')).toBeNull()
    expect(notifierAdapter.resolveResume('/w')).toEqual({ ok: true })
  })
})

describe('claudeAdapter', () => {
  test('kind/usesDoctrine', () => {
    expect(claudeAdapter.kind).toBe('tui')
    expect(claudeAdapter.usesDoctrine).toBe(true)
  })

  test('buildArgv bare (no system-prompt, no resume)', () => {
    expect(claudeAdapter.buildArgv(spec(), cfg)).toEqual([
      '/bin/claude',
      '--dangerously-skip-permissions',
      '--disallowedTools',
      'AskUserQuestion',
      '--add-dir',
      '/',
    ])
  })

  test('buildArgv with system-prompt-file + resume + extras → --continue (NOT --resume <uuid>)', () => {
    // resume uses `--continue` (continue the cwd's most-recent session), NOT
    // `--resume <uuid>` — in claude 2.1.169 `--resume <arg>` is a search query, not a
    // session-id. resumeRef is set by the daemon but no longer consumed by the launch.
    const argv = claudeAdapter.buildArgv(
      spec({ systemPromptFile: '/tmp/sp.md', resume: true, resumeRef: 'uuid-1', extraArgs: ['--foo'] }),
      cfg,
    )
    expect(argv).toEqual([
      '/bin/claude',
      '--dangerously-skip-permissions',
      '--disallowedTools',
      'AskUserQuestion',
      '--add-dir',
      '/',
      '--system-prompt-file',
      '/tmp/sp.md',
      '--continue',
      '--foo',
    ])
    expect(argv).not.toContain('--resume')
    expect(argv).not.toContain('uuid-1')
  })

  test('buildArgv: resume FALSE (fresh) → no --continue / --resume', () => {
    const argv = claudeAdapter.buildArgv(spec({ resume: false, resumeRef: 'uuid-1' }), cfg)
    expect(argv).not.toContain('--continue')
    expect(argv).not.toContain('--resume')
  })

  test('buildArgv carries NO currency (no marketplace/plugin tokens)', () => {
    const flat = claudeAdapter.buildArgv(spec({ systemPromptFile: '/x' }), cfg).join(' ')
    expect(flat).not.toMatch(/marketplace|plugin (install|update|marketplace)/)
  })

  test('isInputReady: ❯ + bypass banner, dialogs gone → true', () => {
    expect(claudeAdapter.isInputReady('… ❯ …\nbypass permissions on')).toBe(true)
  })
  test('isInputReady: a boot dialog present → false even with ❯', () => {
    expect(claudeAdapter.isInputReady('trust this folder\n❯ bypass permissions on')).toBe(false)
  })
  test('isInputReady: no bypass banner → false', () => {
    expect(claudeAdapter.isInputReady('❯ just a prompt')).toBe(false)
  })

  test('bootDialogKeys: proceed-modals → [Enter]; clean/load pane → null', () => {
    expect(claudeAdapter.bootDialogKeys('I am using this for local development')).toEqual(['Enter'])
    expect(claudeAdapter.bootDialogKeys('trust this folder')).toEqual(['Enter'])
    expect(claudeAdapter.bootDialogKeys('Allow external CLAUDE.md file imports?')).toEqual(['Enter'])
    // the post-select "Resuming…" load state is NOT a modal to Enter — just wait.
    expect(claudeAdapter.bootDialogKeys('Resuming the full session')).toBeNull()
    expect(claudeAdapter.bootDialogKeys('❯ ready')).toBeNull()
  })

  test('bootDialogKeys + isInputReady: clean-host theme picker is a boot dialog cleared by Enter', () => {
    // Verified live (claude 2.1.181, pty): a fresh-config host shows
    // "Let's get started. Choose the text style…" BEFORE the input prompt. Any theme
    // is fine for a headless peer → Enter accepts the default; until then NOT ready.
    const themePicker =
      "Let's get started.\n Choose the text style that looks best with your terminal\n   1. Auto (match terminal)\n ❯ 2. Dark mode ✔"
    expect(claudeAdapter.bootDialogKeys(themePicker)).toEqual(['Enter'])
    // even with the ready glyphs co-present, the picker keeps the gate shut
    expect(claudeAdapter.isInputReady('Choose the text style\n❯ bypass permissions on')).toBe(false)
  })

  test('bootDialogKeys: resume compact-picker is CURSOR-VERIFIED — Enter ONLY after ❯ is seen on "2. full"', () => {
    // Regression (boris 10.06, 313k resume): the blind ['Down','Enter'] burst lost the
    // Down in one pty chunk and Enter confirmed the DEFAULT "1. Resume from summary"
    // → silent /compact. Owner's invariant: NO compact on resume. One key per boot
    // iteration; confirm only on a PROVEN cursor position.
    const cursorOn1 = '❯ 1. Resume from summary (recommended)\n  2. Resume full session as-is'
    const cursorOn2 = '  1. Resume from summary (recommended)\n❯ 2. Resume full session as-is'
    // cursor on the compacting default → step down, do NOT confirm
    expect(claudeAdapter.bootDialogKeys(cursorOn1)).toEqual(['Down'])
    // a swallowed Down self-heals: the unchanged pane just gets another Down
    expect(claudeAdapter.bootDialogKeys(cursorOn1)).toEqual(['Down'])
    // cursor PROVEN on "2. Resume full session" → now (and only now) confirm
    expect(claudeAdapter.bootDialogKeys(cursorOn2)).toEqual(['Enter'])
    // Enter can never reach the compacting default: option-1 cursor never maps to Enter
    expect(claudeAdapter.bootDialogKeys(cursorOn1)).not.toContain('Enter')
    // the 2.1.170 live layout (3rd item present) behaves the same
    const live170 =
      "This session is 7h 3m old and 314.2k tokens.\n❯ 1. Resume from summary (recommended)\n  2. Resume full session as-is\n  3. Don't ask me again\nEnter to confirm · Esc to cancel"
    expect(claudeAdapter.bootDialogKeys(live170)).toEqual(['Down'])
  })

  test('bootDialogKeys: bypass-permissions ACCEPT is CURSOR-VERIFIED — Down to "2. Yes", Enter ONLY when proven', () => {
    // Virgin-config gate (verified live, claude 2.1.183 tmux): the FIRST time
    // --dangerously-skip-permissions runs, claude shows "WARNING: Claude Code running
    // in Bypass Permissions mode" with the DEFAULT cursor on "1. No, exit" (a bare
    // Enter EXITS = the peer dies). bootDialogKeys must step to "2. Yes, I accept" and
    // confirm only on a PROVEN cursor — the same hazard/shape as the resume picker.
    const cursorOn1 =
      'WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n  2. Yes, I accept\nEnter to confirm · Esc to cancel'
    const cursorOn2 =
      'WARNING: Claude Code running in Bypass Permissions mode\n  1. No, exit\n❯ 2. Yes, I accept\nEnter to confirm · Esc to cancel'
    // default cursor on "1. No, exit" → step down, NEVER confirm the exit
    expect(claudeAdapter.bootDialogKeys(cursorOn1)).toEqual(['Down'])
    // a swallowed Down self-heals — another Down, still no Enter
    expect(claudeAdapter.bootDialogKeys(cursorOn1)).toEqual(['Down'])
    // Enter is impossible while the cursor sits on the peer-killing default
    expect(claudeAdapter.bootDialogKeys(cursorOn1)).not.toContain('Enter')
    // cursor PROVEN on "2. Yes, I accept" → now (and only now) confirm
    expect(claudeAdapter.bootDialogKeys(cursorOn2)).toEqual(['Enter'])
    // the dialog gates readiness while it is up...
    expect(claudeAdapter.isInputReady(`${cursorOn1}\n❯ x`)).toBe(false)
    // ...but the post-accept ready banner ('bypass permissions on', lowercase) is a
    // DISTINCT string from the dialog marker, so it does NOT trap isInputReady.
    expect(claudeAdapter.isInputReady('❯ ready\nbypass permissions on (shift+tab to cycle)')).toBe(true)
  })

  test('bootDialogKeys: project MCP-server approval (pre-checked) → [Enter] backstop, gates readiness', () => {
    // Shown when cwd carries a .mcp.json the config has not approved (verified live,
    // claude 2.1.183). Servers are pre-checked [✔]; Enter confirms (Esc rejects all).
    // enableAllProjectMcpServers normally suppresses it — this Enter is the backstop.
    const mcpDialog =
      '2 new MCP servers found in this project\nSelect any you wish to enable.\n❯ [✔] iapeer\n  [✔] iapeer-memory\nSpace to select · Enter to confirm · Esc to reject all'
    expect(claudeAdapter.bootDialogKeys(mcpDialog)).toEqual(['Enter'])
    // singular phrasing ("1 new MCP server found") matches the same backstop
    expect(claudeAdapter.bootDialogKeys('1 new MCP server found in this project\n❯ [✔] iapeer')).toEqual(['Enter'])
    // and it holds the readiness gate shut until cleared
    expect(claudeAdapter.isInputReady(`${mcpDialog}\n❯ x\nbypass permissions on`)).toBe(false)
  })


  test('nagDismissKeys: codex declares no mid-session nags (optional predicate absent)', () => {
    expect(codexAdapter.nagDismissKeys).toBeUndefined()
  })
})

// ─── exit-cause observability: the pane-died hook builder (pure string) ──────
describe('exitLogPath', () => {
  test('exitLogPath → exits.log sibling to lifecycle.log', () => {
    expect(exitLogPath('/r/logs/iapeer')).toBe('/r/logs/iapeer/exits.log')
  })
})

// ─── Ф-A #2: deliveryMarkers OWNED by the adapter (07.06 refactor) ───────────
describe('deliveryMarkers (adapter-owned, was transport PROMPT_GLYPHS)', () => {
  test('claude: ❯ glyph + paste patterns', () => {
    expect(claudeAdapter.deliveryMarkers.promptGlyphs).toEqual(['❯'])
    expect(claudeAdapter.deliveryMarkers.pastePatterns?.some(re => re.test('[Pasted text +5 lines]'))).toBe(true)
    expect(claudeAdapter.deliveryMarkers.ghostTextSgr).toEqual(['2', '38;5;246'])
  })
  test('codex: › glyph (not ❯) — per-runtime, no false cross-match', () => {
    expect(codexAdapter.deliveryMarkers.promptGlyphs).toEqual(['›'])
    expect(codexAdapter.deliveryMarkers.promptGlyphs).not.toContain('❯')
    expect(codexAdapter.deliveryMarkers.ghostTextSgr).toEqual(['2', '38;5;246'])
  })
  test('routers have no submit surface → empty glyphs', () => {
    expect(telegramAdapter.deliveryMarkers.promptGlyphs).toEqual([])
    expect(notifierAdapter.deliveryMarkers.promptGlyphs).toEqual([])
  })
})

// ─── Ф-A #3 / A1: intelligence gate (channel runtime allows natural|absent) ────
describe('launch intelligence gate (adapter.allowedIntelligences)', () => {
  test('telegram allows natural|absent (human OR faceless service bot); tui runtimes/notifier declare none', () => {
    expect(telegramAdapter.allowedIntelligences).toEqual(['natural', 'absent'])
    expect(claudeAdapter.allowedIntelligences).toBeUndefined()
    expect(codexAdapter.allowedIntelligences).toBeUndefined()
    expect(notifierAdapter.allowedIntelligences).toBeUndefined()
  })

  test('launch REFUSES an ARTIFICIAL (LLM-agent) peer on telegram (fail-loud, before any bring-up)', async () => {
    const r = await launch(
      spec({ runtime: 'telegram', identity: 'telegram-bot', socketPath: '/tmp/tmux-iap-telegram-bot.sock', intelligence: 'artificial' }),
      telegramAdapter,
      'first',
      launchCfg,
    )
    expect(r.status).toBe('FAILED')
    expect(r.reason).toMatch(/requires intelligence ∈ \{natural, absent\}/)
  })

  test('launch REFUSES when intelligence is unknown (cannot confirm)', async () => {
    const r = await launch(
      spec({ runtime: 'telegram', identity: 'telegram-bot', socketPath: '/tmp/tmux-iap-telegram-bot.sock' }),
      telegramAdapter,
      'first',
      launchCfg,
    )
    expect(r.status).toBe('FAILED')
    expect(r.reason).toMatch(/unknown/)
  })

  test('A1: launch does NOT refuse an ABSENT (faceless service) peer on telegram — the gate passes', async () => {
    const r = await launch(
      spec({ runtime: 'telegram', identity: 'telegram-approval', socketPath: '/tmp/tmux-iap-telegram-approval.sock', intelligence: 'absent' }),
      telegramAdapter,
      'first',
      launchCfg,
    )
    // It may still FAIL downstream (no real telegram bin in the test), but NEVER with the
    // intelligence-gate reason — absent is now a legitimate nature for a channel runtime.
    expect(r.reason ?? '').not.toMatch(/requires intelligence/)
  })
})

// ─── Ф-E #control: executeControl (adapter-owned in-session control mapping) ──
describe('executeControl (Ф-E control commands)', () => {
  test('claude: interrupt → [Escape]; compact → type /compact then Enter', () => {
    expect(claudeAdapter.executeControl({ name: 'interrupt' })).toEqual({ sequence: [['Escape']] })
    expect(claudeAdapter.executeControl({ name: 'compact' })).toEqual({ sequence: [['-l', '/compact'], ['Enter']], stepDelayMs: 300 })
    expect(claudeAdapter.executeControl({ name: 'bogus' })).toBeNull()
  })
  test('codex: interrupt → [Escape] (×1, snapped live); compact → /compact + Enter (snapped live 12.06, codex-cli 0.138)', () => {
    expect(codexAdapter.executeControl({ name: 'interrupt' })).toEqual({ sequence: [['Escape']] })
    expect(codexAdapter.executeControl({ name: 'compact' })).toEqual({ sequence: [['-l', '/compact'], ['Enter']], stepDelayMs: 300 })
    expect(codexAdapter.executeControl({ name: 'bogus' })).toBeNull()
  })
  test('routers (telegram/notifier) refuse all control (no TUI turn)', () => {
    expect(telegramAdapter.executeControl({ name: 'interrupt' })).toBeNull()
    expect(notifierAdapter.executeControl({ name: 'interrupt' })).toBeNull()
    expect(telegramAdapter.executeControl({ name: 'compact' })).toBeNull()
  })
})
