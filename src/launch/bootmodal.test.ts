import { describe, expect, test } from 'bun:test'
import { genericBootPrompt, waitHostReady } from './ptyHost.ts'
import { claudeAdapter } from './adapters/claude.ts'
import { codexAdapter } from './adapters/codex.ts'
import { bootModalAlertText, makeBootModalAlert } from '../daemon/bootalert.ts'

// An invented modal no adapter knows (layout mirrors the 2.1.30x resume-confirm that hung walt-trader:
// unnumbered rows + a footer verb outside cancel/go-back).
const UNKNOWN = [
  '  Something new from the runtime?',
  '  Choose how to continue this session.',
  '  ❯ Keep going',
  '    Do something else',
  '',
  '  Enter to confirm · Esc to skip',
].join('\n')

function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0
  return { now: () => t, sleep: async ms => { t += ms } }
}

describe('boot fail-fast on an unrecognized modal', () => {
  test('genericBootPrompt: select footer + cursor row → modal; a booting composer is not', () => {
    expect(genericBootPrompt(UNKNOWN)?.option1).toBe('Keep going')
    expect(genericBootPrompt('✻ Resuming… (esc to interrupt)\n❯ Try "edit <file>"')).toBeNull()
    expect(genericBootPrompt('Enter to confirm')).toBeNull() // no cursor row
  })

  test('claude: an unknown modal stable for modalStableSecs fails FAST with bootModal, long before bootDeadline', async () => {
    const c = clock()
    const r = await waitHostReady(
      { identity: 'claude-x', logDir: '/nonexistent', adapter: claudeAdapter, bootDeadlineSecs: 240, modalStableSecs: 20 },
      c.sleep, c.now, { alive: () => true, viewport: async () => UNKNOWN },
    )
    expect(r.ready).toBe(false)
    expect(r.ready === false && r.bootModal?.option1).toBe('Keep going')
    expect(c.now()).toBeLessThanOrEqual(24_000) // first sighting at 2 s + 20 s stable (+1 tick)
  })

  test('codex adapter gets the same fail-fast (numbered select — codex renders its modals numbered)', async () => {
    const CODEX = '  Something new from the runtime?\n  › 1. Keep going\n    2. Do something else\n\n  Press enter to confirm or esc to go back'
    const c = clock()
    const r = await waitHostReady(
      { identity: 'codex-x', logDir: '/nonexistent', adapter: codexAdapter, bootDeadlineSecs: 240, modalStableSecs: 20 },
      c.sleep, c.now, { alive: () => true, viewport: async () => CODEX },
    )
    expect(r.ready === false && r.bootModal !== undefined).toBe(true)
    expect(c.now()).toBeLessThanOrEqual(24_000)
  })

  test('a CHANGING screen (still booting) never trips it; a KNOWN dialog is left to the boot-driver', async () => {
    let n = 0
    const c = clock()
    const r = await waitHostReady(
      { identity: 'claude-x', logDir: '/nonexistent', adapter: claudeAdapter, bootDeadlineSecs: 60, modalStableSecs: 20 },
      c.sleep, c.now, { alive: () => true, viewport: async () => UNKNOWN.replace('Choose', `Choose ${n++}`) },
    )
    expect(r).toEqual({ ready: false }) // ran to the deadline, no bootModal
    const known = 'Resume this ' + 'conversation?\n  ❯ 1. Resume\n    2. Start a new ' + 'conversation\n  Enter to confirm · Esc to resume'
    const c2 = clock()
    const r2 = await waitHostReady(
      { identity: 'claude-x', logDir: '/nonexistent', adapter: claudeAdapter, bootDeadlineSecs: 60, modalStableSecs: 20 },
      c2.sleep, c2.now, { alive: () => true, viewport: async () => known },
    )
    expect(r2).toEqual({ ready: false })
  })

  test('ready wins immediately', async () => {
    const c = clock()
    const r = await waitHostReady(
      { identity: 'claude-x', logDir: '/nonexistent', adapter: claudeAdapter, bootDeadlineSecs: 60 },
      c.sleep, c.now, { alive: () => true, viewport: async () => '❯ \n  ⏵⏵ bypass permissions on' },
    )
    expect(r).toEqual({ ready: true })
  })
})

describe('boot-modal alert outlet', () => {
  const info = { personality: 'p', runtime: 'claude', identity: 'claude-p', content: UNKNOWN, option1: 'Keep going', reason: 'unknown-boot-modal' }

  test('sends ONE alert to the configured target per dedup window; none without a target', async () => {
    const sent: Array<{ to: string; topic?: string; msg: string }> = []
    let t = 0
    const alert = makeBootModalAlert(
      { eventLogDir: '', env: {} },
      {
        now: () => t,
        target: () => ({ peer: 'ops' }),
        send: (async (_c: unknown, input: { personality: string; topic?: string; message: string }) => {
          sent.push({ to: input.personality, topic: input.topic, msg: input.message })
          return { ok: true, value: {} }
        }) as never,
      },
    )
    alert(info)
    alert(info)
    await new Promise(r => setTimeout(r, 0))
    expect(sent.length).toBe(1)
    expect(sent[0].to).toBe('ops')
    expect(sent[0].topic).toBe('boot-modal')
    expect(sent[0].msg).toContain('Keep going')
    t += 31 * 60_000
    alert(info)
    await new Promise(r => setTimeout(r, 0))
    expect(sent.length).toBe(2)

    const none: unknown[] = []
    makeBootModalAlert({ eventLogDir: '', env: {} }, { target: () => null, send: (async () => { none.push(1); return { ok: true, value: {} } }) as never })(info)
    await new Promise(r => setTimeout(r, 0))
    expect(none.length).toBe(0)
  })

  test('alert text names the peer, the option and the screen', () => {
    const t = bootModalAlertText(info)
    expect(t).toContain('p (claude)')
    expect(t).toContain('Something new from the runtime?')
  })
})
