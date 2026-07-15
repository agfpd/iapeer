// launchctlBootstrap — the AUTO-load primitive guards. The happy `loaded` path is
// proven LIVE (it calls real launchctl); the unit tests cover the three guards that
// must hold WITHOUT touching launchd: foreign-plist refusal, sandbox skip, and the
// foundation-owned gate. (The test script sets IAPEER_TEST_SANDBOX=1, so the skip
// branch is the default; the foreign-refusal branch is checked first regardless.)

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchctlBootstrap, installAlwaysOnPlist } from './index.ts'

const dirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-boot-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('launchctlBootstrap guards', () => {
  test('refuses a NON-foundation plist (no ownership sentinel) — fleet guard, checked first', () => {
    const dir = mkTmp()
    const foreign = join(dir, 'com.iapeer.boris.plist')
    writeFileSync(foreign, '<?xml version="1.0"?><plist><dict></dict></plist>')
    // refused-foreign wins even with IAPEER_TEST_SANDBOX=1 (the guard is checked before sandbox)
    const r = launchctlBootstrap('boris', foreign, { IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv)
    expect(r.state).toBe('refused-foreign')
    expect(r.label).toBe('com.iapeer.boris')
  })

  test('a foundation-owned plist under IAPEER_TEST_SANDBOX=1 → skipped-sandbox (no launchctl)', () => {
    const root = mkTmp()
    const bindir = mkTmp()
    const bin = join(bindir, 'notifier-runtime')
    writeFileSync(bin, '#!/bin/sh\nexec sleep 1\n', { mode: 0o755 })
    const env = {
      IAPEER_LAUNCHAGENTS_DIR: join(root, 'LA'),
      HOME: root,
      PATH: bindir,
      IAPEER_TEST_SANDBOX: '1',
    } as NodeJS.ProcessEnv
    const cwd = join(root, 'timer')
    const plist = installAlwaysOnPlist({ personality: 'timer', runtime: 'notifier', cwd, runtimeBin: bin, env })
    const r = launchctlBootstrap('timer', plist, env)
    expect(r.state).toBe('skipped-sandbox')
    // multi-infra: a fresh personality installs the per-runtime plist, and the
    // bootstrap label is derived from the plist basename (label = file stem)
    expect(r.label).toBe('com.iapeer.timer.notifier')
  })

  test('absent/unreadable plist → refused-foreign (not provably ours)', () => {
    const r = launchctlBootstrap('ghost', join(mkTmp(), 'nope.plist'), { IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv)
    expect(r.state).toBe('refused-foreign')
  })
})
