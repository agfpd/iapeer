// install — the stable binary path + (lightly) the build. iapeerBinPath is the
// decoupling anchor: the launchd plists reference it, not process.execPath / a src
// file. The full `bun build --compile` is exercised LIVE (it writes a ~60M binary —
// too heavy for a unit test); here we pin the path resolution.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { iapeerBinPath, iapeerPrevBinPath, installIapeer, rollbackIapeer } from './index.ts'

describe('iapeerBinPath', () => {
  test('default = <home>/.local/bin/iapeer (stable host-wide path, on $PATH)', () => {
    expect(iapeerBinPath({ HOME: '/Users/x' } as NodeJS.ProcessEnv)).toBe('/Users/x/.local/bin/iapeer')
  })
  test('IAPEER_BIN_DIR override (tests/sandbox — never a real ~/.local/bin)', () => {
    expect(iapeerBinPath({ HOME: '/Users/x', IAPEER_BIN_DIR: '/tmp/sbx/bin' } as NodeJS.ProcessEnv)).toBe(
      join('/tmp/sbx/bin', 'iapeer'),
    )
  })
})

// Audit #25 — fail-closed sandbox guard (symmetric to the registry's). installIapeer
// overwrites the live prod binary ~/.local/bin/iapeer; a sandbox/test that forgets
// IAPEER_BIN_DIR must be REFUSED, never clobber prod. The guard fires BEFORE the build,
// so no `bun build --compile` runs here.
describe('installIapeer fail-closed sandbox guard', () => {
  test('THROWS under IAPEER_TEST_SANDBOX=1 when binPath falls through to the REAL ~/.local/bin/iapeer', () => {
    const env = { IAPEER_TEST_SANDBOX: '1', HOME: '/Users/fake-home' } as NodeJS.ProcessEnv
    expect(iapeerBinPath(env)).toBe('/Users/fake-home/.local/bin/iapeer')
    expect(() => installIapeer('/x/entry.ts', env)).toThrow(/refusing to overwrite the REAL prod binary/)
  })
})

describe('rollbackIapeer', () => {
  let binDir: string
  let env: NodeJS.ProcessEnv
  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'iapeer-rollback-'))
    env = { IAPEER_TEST_SANDBOX: '1', HOME: '/Users/x', IAPEER_BIN_DIR: binDir } as NodeJS.ProcessEnv
  })
  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true })
  })

  test('no .prev → failed (nothing to roll back to), binary untouched', () => {
    writeFileSync(iapeerBinPath(env), 'CURRENT')
    const r = rollbackIapeer(env)
    expect(r.status).toBe('failed')
    expect(r.reason).toMatch(/nothing to roll back/i)
    expect(readFileSync(iapeerBinPath(env), 'utf8')).toBe('CURRENT') // unchanged
  })

  test('restores the .prev bytes over the binary', () => {
    writeFileSync(iapeerBinPath(env), 'NEW-BROKEN')
    writeFileSync(iapeerPrevBinPath(env), 'OLD-GOOD')
    const r = rollbackIapeer(env)
    expect(r.status).toBe('rolled-back')
    expect(readFileSync(iapeerBinPath(env), 'utf8')).toBe('OLD-GOOD')
  })

  test('fail-closed sandbox guard: refuses the REAL prod binary path', () => {
    const realEnv = { IAPEER_TEST_SANDBOX: '1', HOME: '/Users/fake-home' } as NodeJS.ProcessEnv
    expect(() => rollbackIapeer(realEnv)).toThrow(/refusing to overwrite the REAL prod binary/)
  })
})
