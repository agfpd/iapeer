// The shared atomic-write core (B1: durability — fsync-before-rename + looped writeSync).
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileAtomicRaw } from './atomicWrite.ts'

const tmps: string[] = []
afterEach(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
  tmps.length = 0
})
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iap-atomic-'))
  tmps.push(d)
  return d
}

describe('writeFileAtomicRaw', () => {
  test('writes the exact bytes and creates the parent dir', () => {
    const path = join(mkTmp(), 'deep', 'nested', 'f.json')
    writeFileAtomicRaw(path, '{"a":1}\n', 0o600)
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n')
  })
  test('multibyte payload round-trips byte-for-byte (looped writeSync over a Buffer)', () => {
    const path = join(mkTmp(), 'u.txt')
    const payload = 'привет мир — ' + '😀'.repeat(1000) + '\n'
    writeFileAtomicRaw(path, payload, 0o600)
    expect(readFileSync(path, 'utf8')).toBe(payload)
  })
  test('a large payload is written in full (no truncation)', () => {
    const path = join(mkTmp(), 'big.txt')
    const payload = 'x'.repeat(2_000_000) + '\n'
    writeFileAtomicRaw(path, payload, 0o600)
    expect(readFileSync(path, 'utf8').length).toBe(payload.length)
  })
  test('leaves NO tmp file behind on success', () => {
    const dir = mkTmp()
    writeFileAtomicRaw(join(dir, 'f.txt'), 'hi', 0o600)
    expect(readdirSync(dir).filter(n => n.startsWith('.') && n.endsWith('.tmp'))).toHaveLength(0)
  })
  test('custom tmpDir is honored and cleaned up (registry uses paths.tmpDir)', () => {
    const root = mkTmp()
    const tmpDir = join(root, 'tmp')
    mkdirSync(tmpDir, { recursive: true })
    const target = join(root, 'peers-profiles.json')
    writeFileAtomicRaw(target, '{}\n', 0o600, tmpDir)
    expect(readFileSync(target, 'utf8')).toBe('{}\n')
    expect(readdirSync(tmpDir).filter(n => n.endsWith('.tmp'))).toHaveLength(0)
  })
  test('cleans up the tmp file when the rename target dir is not writable (failure path)', () => {
    const root = mkTmp()
    // target under a path component that is a FILE, not a dir → rename fails
    const blocker = join(root, 'blocker')
    writeFileAtomicRaw(blocker, 'x', 0o600)
    const bad = join(blocker, 'child.txt') // blocker is a file → mkdir/rename throws
    expect(() => writeFileAtomicRaw(bad, 'y', 0o600)).toThrow()
    expect(readdirSync(root).some(n => n.endsWith('.tmp'))).toBe(false)
    expect(existsSync(bad)).toBe(false)
  })
})
