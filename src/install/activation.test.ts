import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { iapeerBinPath, installIapeer, rollbackIapeer } from './index.ts'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'iapeer-activation-'))
  roots.push(root)
  const env = { IAPEER_TEST_SANDBOX: '1', IAPEER_BIN_DIR: root }
  const bin = iapeerBinPath(env)
  writeFileSync(bin, 'old-good')
  writeFileSync(`${bin}.prev`, 'older-good')
  writeFileSync(`${bin}.healthy`, 'old-stamp')
  return { env, bin }
}
function unchanged(bin: string) {
  expect(readFileSync(bin, 'utf8')).toBe('old-good')
  expect(readFileSync(`${bin}.prev`, 'utf8')).toBe('older-good')
  expect(readFileSync(`${bin}.healthy`, 'utf8')).toBe('old-stamp')
  expect(existsSync(`${bin}.tmp`)).toBe(false)
  expect(existsSync(`${bin}.rollback.tmp`)).toBe(false)
}

describe('foundation staged signature activation', () => {
  test('build → stable sign → verify BEFORE binary/.prev/healthy-stamp mutation', () => {
    const { env, bin } = setup()
    const order: string[] = []
    const r = installIapeer('/test/source', env, {
      build: (_entry, tmp) => { order.push('build'); writeFileSync(tmp, 'new-bytes') },
      signStable: path => {
        order.push('stable-sign')
        expect(path).toBe(`${bin}.tmp`)
        expect(readFileSync(bin, 'utf8')).toBe('old-good')
        return { state: 'signed' }
      },
      verifySignature: path => {
        order.push('verify')
        expect(path).toBe(`${bin}.tmp`)
        expect(readFileSync(bin, 'utf8')).toBe('old-good')
        expect(readFileSync(`${bin}.prev`, 'utf8')).toBe('older-good')
        expect(readFileSync(`${bin}.healthy`, 'utf8')).toBe('old-stamp')
        return { state: 'verified' }
      },
    })
    expect(order).toEqual(['build', 'stable-sign', 'verify'])
    expect(r.signing?.state).toBe('signed')
    expect(readFileSync(bin, 'utf8')).toBe('new-bytes')
    expect(existsSync(`${bin}.tmp`)).toBe(false)
    expect(existsSync(`${bin}.healthy`)).toBe(false)
  })
  test('invalid staged binary fails without publishing or damaging rollback/stamp', () => {
    const { env, bin } = setup()
    expect(() => installIapeer('/source', env, {
      build: (_entry, tmp) => writeFileSync(tmp, 'invalid-build'),
      signStable: () => ({ state: 'signed' }),
      verifySignature: () => { throw new Error('strict verify invalid') },
    })).toThrow('strict verify invalid')
    unchanged(bin)
  })
  test('partial build failure cleans staged bytes and leaves installed state intact', () => {
    const { env, bin } = setup()
    expect(() => installIapeer('/source', env, {
      build: (_entry, tmp) => { writeFileSync(tmp, 'partial'); throw new Error('build failed') },
      signStable: () => { throw new Error('must not sign') },
    })).toThrow('build failed')
    unchanged(bin)
  })
  test('stable TCC signing soft-failure still requires executable validity gate', () => {
    const { env, bin } = setup()
    let checked = false
    const r = installIapeer('/source', env, {
      build: (_entry, tmp) => writeFileSync(tmp, 'new-bytes'),
      signStable: () => ({ state: 'failed-soft', detail: 'keychain unavailable' }),
      verifySignature: () => { checked = true; return { state: 'repaired' } },
    })
    expect(checked).toBe(true)
    expect(r.signing?.state).toBe('failed-soft')
    expect(readFileSync(bin, 'utf8')).toBe('new-bytes')
  })
  test('invalid rollback copy is rejected before rename; old binary and .prev retained', () => {
    const { env, bin } = setup()
    const r = rollbackIapeer(env, {
      signStable: () => ({ state: 'signed' }),
      verifySignature: path => {
        expect(path).toBe(`${bin}.rollback.tmp`)
        expect(readFileSync(bin, 'utf8')).toBe('old-good')
        throw new Error('invalid rollback signature')
      },
    })
    expect(r.status).toBe('failed')
    expect(r.reason).toBe('invalid rollback signature')
    unchanged(bin)
  })
})
