// Onboard security gate — accept channels (flag/env), TTY prompt, non-TTY refusal.
// The gate must NEVER hang a non-interactive run: the flag/env/non-TTY paths must
// resolve WITHOUT touching `ask` (proven by an ask that throws if called).

import { describe, expect, test } from 'bun:test'
import { ONBOARD_SECURITY_WARNING, confirmOnboardRisk } from './risk.ts'

function sinks() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, outFn: (s: string) => out.push(s), errFn: (s: string) => err.push(s) }
}
const askThrows = async (): Promise<string> => {
  throw new Error('ask must not be called on this path (would hang a non-interactive run)')
}

describe('confirmOnboardRisk', () => {
  test('--accept-risk → accepted-flag, NO prompt, NO warning printed', async () => {
    const s = sinks()
    const r = await confirmOnboardRisk({ accept: true, env: {} as NodeJS.ProcessEnv, ask: askThrows, out: s.outFn, errOut: s.errFn })
    expect(r).toBe('accepted-flag')
    expect(s.out.join('')).toBe('')
    expect(s.err.join('')).toBe('')
  })

  test('IAPEER_ACCEPT_RISK env (1/true/yes) → accepted-flag, NO prompt', async () => {
    for (const v of ['1', 'true', 'YES']) {
      const r = await confirmOnboardRisk({ env: { IAPEER_ACCEPT_RISK: v } as NodeJS.ProcessEnv, ask: askThrows })
      expect(r).toBe('accepted-flag')
    }
  })

  test('TTY + y/yes → accepted-prompt, warning shown', async () => {
    for (const ans of ['y', 'yes', 'YES ']) {
      const s = sinks()
      const r = await confirmOnboardRisk({ env: {} as NodeJS.ProcessEnv, isTty: true, ask: async () => ans, out: s.outFn, errOut: s.errFn })
      expect(r).toBe('accepted-prompt')
      expect(s.out.join('')).toContain(ONBOARD_SECURITY_WARNING)
    }
  })

  test('TTY + no/empty → declined with abort message', async () => {
    for (const ans of ['n', 'no', '']) {
      const s = sinks()
      const r = await confirmOnboardRisk({ env: {} as NodeJS.ProcessEnv, isTty: true, ask: async () => ans, out: s.outFn, errOut: s.errFn })
      expect(r).toBe('declined')
      expect(s.out.join('')).toContain('aborted')
    }
  })

  test('non-TTY without the flag → refused-non-tty, warning + how-to on stderr, ask untouched', async () => {
    const s = sinks()
    const r = await confirmOnboardRisk({ env: {} as NodeJS.ProcessEnv, isTty: false, ask: askThrows, out: s.outFn, errOut: s.errFn })
    expect(r).toBe('refused-non-tty')
    const err = s.err.join('')
    expect(err).toContain(ONBOARD_SECURITY_WARNING)
    expect(err).toContain('--accept-risk')
    expect(err).toContain('IAPEER_ACCEPT_RISK=1')
  })

  test('warning text is the verbatim disclaimer (key phrases + the Continue? prompt)', () => {
    expect(ONBOARD_SECURITY_WARNING.startsWith('Security warning — please read.')).toBe(true)
    expect(ONBOARD_SECURITY_WARNING).toContain('iapeer is beta infrastructure for live AI agents on your machine. Expect sharp edges.')
    expect(ONBOARD_SECURITY_WARNING).toContain('iapeer is not a hostile multi-user security boundary.')
    expect(ONBOARD_SECURITY_WARNING).toContain('Telegram bot tokens')
    expect(ONBOARD_SECURITY_WARNING.trimEnd().endsWith('I understand this is powerful and inherently risky. Continue?')).toBe(true)
  })
})
