// onboard — the fleet-critical detector (isAgfpdInList): is OUR marketplace already
// registered? A false negative would RE-register on an already-configured host (the
// exact fleet-mutation onboard must avoid). Tested against REAL claude/codex
// `plugin marketplace list` output shapes.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeAuthReady, codexAuthReady, isAgfpdInList, onboardHost, runtimeAuthNote, tccFullDiskAccessNote } from './index.ts'
import type { OnboardRuntime } from './index.ts'

describe('tccFullDiskAccessNote (macOS TCC advisory — PROBE-driven, not memory-gated)', () => {
  test('fda NOT granted → the Full Disk Access instruction with the injected bin path', () => {
    const note = tccFullDiskAccessNote({ fda: false, binPath: '/Users/x/.local/bin/iapeer' })
    expect(note).not.toBeNull()
    expect(note!).toContain('Full Disk Access')
    expect(note!).toContain('System Settings → Privacy & Security')
    expect(note!).toContain('EPERM') // silent-failure framing (not a hang)
    expect(note!).toContain('/Users/x/.local/bin/iapeer') // exact grant target, injected
  })
  test('fda granted → null (nothing to nag)', () => {
    expect(tccFullDiskAccessNote({ fda: true, binPath: '/x' })).toBeNull()
  })
  test('fda undeterminable / non-macOS (null) → null', () => {
    expect(tccFullDiskAccessNote({ fda: null, binPath: '/x' })).toBeNull()
  })
})

describe('runtime auth readiness (clean-host login prerequisite)', () => {
  test('claude: ANTHROPIC_API_KEY env → ready, no note', () => {
    const env = { HOME: '/nonexistent-home', ANTHROPIC_API_KEY: 'sk-x' } as NodeJS.ProcessEnv
    expect(claudeAuthReady(env)).toBe(true)
    expect(runtimeAuthNote('claude', env)).toBeNull()
  })
  test('claude: CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN env → ready', () => {
    expect(claudeAuthReady({ HOME: '/nonexistent', CLAUDE_CODE_OAUTH_TOKEN: 't' } as NodeJS.ProcessEnv)).toBe(true)
    expect(claudeAuthReady({ HOME: '/nonexistent', ANTHROPIC_AUTH_TOKEN: 't' } as NodeJS.ProcessEnv)).toBe(true)
  })
  test('claude: completed onboarding + account in ~/.claude.json → ready', () => {
    const home = mkdtempSync(join(tmpdir(), 'iapeer-auth-'))
    try {
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { id: 'a' } }))
      expect(claudeAuthReady({ HOME: home } as NodeJS.ProcessEnv)).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  test('claude: onboarding done but NO account/key marker → NOT ready (nags)', () => {
    const home = mkdtempSync(join(tmpdir(), 'iapeer-auth-'))
    try {
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
      expect(claudeAuthReady({ HOME: home } as NodeJS.ProcessEnv)).toBe(false)
      const note = runtimeAuthNote('claude', { HOME: home } as NodeJS.ProcessEnv)
      expect(note).not.toBeNull()
      expect(note!).toContain('claude: NOT authenticated')
      expect(note!).toContain('ANTHROPIC_API_KEY')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
  test('claude: clean host (no env, no files) → NOT ready (nags)', () => {
    expect(claudeAuthReady({ HOME: '/nonexistent-clean-home' } as NodeJS.ProcessEnv)).toBe(false)
  })
  test('codex: OPENAI_API_KEY env → ready', () => {
    expect(codexAuthReady({ HOME: '/nonexistent', OPENAI_API_KEY: 'k' } as NodeJS.ProcessEnv)).toBe(true)
  })
  test('codex: auth.json present → ready; absent → nags', () => {
    const home = mkdtempSync(join(tmpdir(), 'iapeer-auth-'))
    try {
      const env = { HOME: home, CODEX_HOME: home } as NodeJS.ProcessEnv
      expect(codexAuthReady(env)).toBe(false)
      const note = runtimeAuthNote('codex', env)
      expect(note).not.toBeNull()
      expect(note!).toContain('codex: NOT authenticated')
      writeFileSync(join(home, 'auth.json'), '{}')
      expect(codexAuthReady(env)).toBe(true)
      expect(runtimeAuthNote('codex', env)).toBeNull()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('isAgfpdInList (marketplace-registered detector)', () => {
  test('claude list shape (❯ name + GitHub source ref) → true', () => {
    const claudeOut = `Configured marketplaces:

  ❯ claude-plugins-official
    Source: GitHub (anthropics/claude-plugins-official)

  ❯ agfpd
    Source: GitHub (agfpd/agfpd-marketplace)
`
    expect(isAgfpdInList(claudeOut)).toBe(true)
  })

  test('codex list shape (name + root path columns) → true', () => {
    const codexOut = `MARKETPLACE              ROOT
agfpd                    /Users/x/.codex/.tmp/marketplaces/agfpd
claude-plugins-official  /Users/x/.codex/.tmp/marketplaces/claude-plugins-official
`
    expect(isAgfpdInList(codexOut)).toBe(true)
  })

  test('NOT registered (only other marketplaces) → false', () => {
    expect(isAgfpdInList('Configured marketplaces:\n\n  ❯ claude-plugins-official\n    Source: GitHub (anthropics/claude-plugins-official)\n')).toBe(false)
    expect(isAgfpdInList('')).toBe(false)
  })

  test('a different agfpd-* token (e.g. a plugin name) does NOT false-positive', () => {
    // a line that mentions agfpd-prompt-architect but the agfpd marketplace is NOT listed
    expect(isAgfpdInList('plugins:\n  agfpd-prompt-architect@somewhere (installed)\n')).toBe(false)
  })
})

describe('onboardHost marketplace resilience (Arthur fresh-run: no bare red "failed")', () => {
  // process.execPath is always an executable file → runtimeBin('claude') passes the
  // isExecutable gate, so the (injected) register path is reached deterministically.
  const env = { IAPEER_CLAUDE_BIN: process.execPath } as NodeJS.ProcessEnv
  const seqRegister = (
    results: Array<{ ok: boolean; detail?: string }>,
  ): ((r: OnboardRuntime, e: NodeJS.ProcessEnv) => { ok: boolean; detail?: string }) & { calls: { n: number } } => {
    let i = 0
    const calls = { n: 0 }
    const fn = (): { ok: boolean; detail?: string } => {
      calls.n++
      return results[Math.min(i++, results.length - 1)]!
    }
    return Object.assign(fn, { calls })
  }
  const seqIsReg = (vals: boolean[]): ((r: OnboardRuntime, e: NodeJS.ProcessEnv) => boolean) => {
    let i = 0
    return () => vals[Math.min(i++, vals.length - 1)]!
  }

  test('self-heal: add reports failure but a recheck shows present → registered (no retry)', () => {
    const register = seqRegister([{ ok: false, detail: 'exit 1' }])
    const r = onboardHost({ runtimes: ['claude'], env, register, isRegistered: seqIsReg([false, true]), sleep: () => {} })
    expect(r.marketplaces[0]!.state).toBe('registered')
    expect(register.calls.n).toBe(1)
  })

  test('non-timeout transient: ONE retry succeeds → registered', () => {
    const register = seqRegister([{ ok: false, detail: 'exit 1' }, { ok: true }])
    const r = onboardHost({ runtimes: ['claude'], env, register, isRegistered: seqIsReg([false, false, false]), sleep: () => {} })
    expect(r.marketplaces[0]!.state).toBe('registered')
    expect(r.marketplaces[0]!.detail).toMatch(/retry/)
    expect(register.calls.n).toBe(2)
  })

  test('non-timeout persistent: failed with an actionable transient hint (not a bare "failed")', () => {
    const register = seqRegister([{ ok: false, detail: 'exit 1' }, { ok: false, detail: 'exit 1' }])
    const r = onboardHost({ runtimes: ['claude'], env, register, isRegistered: seqIsReg([false]), sleep: () => {} })
    expect(r.marketplaces[0]!.state).toBe('failed')
    expect(r.marketplaces[0]!.detail).toMatch(/re-run|optional/)
  })

  test('timeout: NO retry (would re-wedge) + macOS-approval advisory', () => {
    const register = seqRegister([{ ok: false, detail: 'timed out (wedged runtime CLI?)' }])
    const r = onboardHost({
      runtimes: ['claude'],
      env,
      register,
      isRegistered: seqIsReg([false]),
      sleep: () => {
        throw new Error('must NOT sleep/retry on a timeout')
      },
    })
    expect(r.marketplaces[0]!.state).toBe('failed')
    expect(r.marketplaces[0]!.detail).toMatch(/System Settings|Privacy/)
    expect(register.calls.n).toBe(1)
  })

  test('already-registered upfront → no add attempted', () => {
    const register = seqRegister([{ ok: false }])
    const r = onboardHost({ runtimes: ['claude'], env, register, isRegistered: seqIsReg([true]), sleep: () => {} })
    expect(r.marketplaces[0]!.state).toBe('already-registered')
    expect(register.calls.n).toBe(0)
  })
})
