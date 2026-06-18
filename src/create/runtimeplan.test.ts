// FU5 — `create`'s default-runtime decision. Pure policy, no host access: covers
// the bug (silent claude when both runtimes are installed) and the model (`--runtime`
// picks the default; `runtimes` = all installed agentic runtimes).

import { describe, expect, test } from 'bun:test'
import { planCreateRuntimes, secondaryRuntimes } from './index.ts'
import type { Runtime } from '../core/constants.ts'

const BOTH: Runtime[] = ['claude', 'codex']

describe('planCreateRuntimes', () => {
  test('both installed, no --runtime → AMBIGUOUS (prompt), deterministic fallback, NOT silent', () => {
    const p = planCreateRuntimes(undefined, BOTH)
    expect(p.ambiguous).toBe(true)
    expect(p.fallbackDefault).toBe('claude') // off-TTY fallback, surfaced with a loud note
    expect(p.resolvedDefault).toBeUndefined() // never silently resolved
    expect(p.installedAgentic).toEqual(BOTH)
  })

  test('explicit --runtime wins as the DEFAULT (no prompt), even with both installed', () => {
    const p = planCreateRuntimes('codex', BOTH)
    expect(p.ambiguous).toBe(false)
    expect(p.resolvedDefault).toBe('codex')
  })

  test('exactly one installed → that one, unambiguously', () => {
    const p = planCreateRuntimes(undefined, ['codex'])
    expect(p.ambiguous).toBe(false)
    expect(p.resolvedDefault).toBe('codex')
  })

  test('none installed → unresolved (createPeer surfaces the clear error)', () => {
    const p = planCreateRuntimes(undefined, [])
    expect(p.ambiguous).toBe(false)
    expect(p.resolvedDefault).toBeUndefined()
  })
})

describe('secondaryRuntimes', () => {
  test('chosen default → the OTHER installed agentic runtimes are wired (runtimes truthful)', () => {
    expect(secondaryRuntimes('claude', BOTH)).toEqual(['codex'])
    expect(secondaryRuntimes('codex', BOTH)).toEqual(['claude'])
  })

  test('single installed → no secondaries', () => {
    expect(secondaryRuntimes('claude', ['claude'])).toEqual([])
  })

  test('undefined chosen (none installed / infra) → no secondaries', () => {
    expect(secondaryRuntimes(undefined, BOTH)).toEqual([])
  })
})
