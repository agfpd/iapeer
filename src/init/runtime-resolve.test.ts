// resolvePrimaryRuntime — the runtime-aware, CONSISTENT primary-runtime resolution
// for init/create. Pure (filesystem markers only); no registry / launchd touched.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolvePrimaryRuntime } from './index.ts'

const dirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-rt-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('resolvePrimaryRuntime', () => {
  test('explicit runtime wins regardless of markers', () => {
    const cwd = mkTmp()
    mkdirSync(join(cwd, '.codex'))
    expect(resolvePrimaryRuntime(cwd, 'telegram')).toBe('telegram')
  })

  test('no marker → claude (default)', () => {
    expect(resolvePrimaryRuntime(mkTmp())).toBe('claude')
  })

  test('.codex-only folder → codex primary (was the inconsistency: defaulted to claude)', () => {
    const cwd = mkTmp()
    mkdirSync(join(cwd, '.codex'))
    expect(resolvePrimaryRuntime(cwd)).toBe('codex')
  })

  test('.claude folder → claude', () => {
    const cwd = mkTmp()
    mkdirSync(join(cwd, '.claude'))
    expect(resolvePrimaryRuntime(cwd)).toBe('claude')
  })

  test('both markers → claude primary (agentic default order)', () => {
    const cwd = mkTmp()
    mkdirSync(join(cwd, '.claude'))
    mkdirSync(join(cwd, '.codex'))
    expect(resolvePrimaryRuntime(cwd)).toBe('claude')
  })

  // Regression: in production isRuntimeInstalled is agentic-only (claude/codex bins),
  // so an explicit INFRA runtime (notifier/telegram) failed "not installed" and broke
  // infra re-deploy (install-runtime/update-runtime → initPeer). The sandbox masks it
  // (isRuntimeInstalled short-circuits true), so we inject a prod-like false predicate.
  test('explicit INFRA runtime passes the install-check (infra is not an agentic install)', () => {
    const cwd = mkTmp()
    const noneInstalled = () => false
    expect(resolvePrimaryRuntime(cwd, 'notifier', noneInstalled)).toBe('notifier')
    expect(resolvePrimaryRuntime(cwd, 'telegram', noneInstalled)).toBe('telegram')
  })

  test('explicit AGENTIC runtime is still validated against install (the 0.2.81 guard intact)', () => {
    const cwd = mkTmp()
    expect(() => resolvePrimaryRuntime(cwd, 'codex', () => false)).toThrow(/not installed/)
    expect(() => resolvePrimaryRuntime(cwd, 'claude', () => false)).toThrow(/not installed/)
  })
})
