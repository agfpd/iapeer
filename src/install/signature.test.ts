import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureExecutableSignature, type SignatureRunner } from './signature.ts'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })
function artifact(magic = 0xcffaedfe): string {
  const root = mkdtempSync(join(tmpdir(), 'iapeer-sig-'))
  roots.push(root)
  const path = join(root, 'staged')
  const bytes = Buffer.alloc(32)
  bytes.writeUInt32BE(magic)
  writeFileSync(path, bytes)
  return path
}
function harness(statuses: (number | null)[]) {
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  const run: SignatureRunner = (command, args, env) => {
    calls.push({ command, args, env })
    if (!statuses.length) throw new Error('unexpected command')
    return { status: statuses.shift()!, stderr: 'signature diagnostic' }
  }
  return { calls, run }
}
const env = { IAPEER_TEST_SANDBOX: '1', PATH: '/untrusted/path' }

describe('ensureExecutableSignature (pre-activation)', () => {
  test('valid signatures stay unchanged; system codesign, strict flags, explicit env', () => {
    const path = artifact()
    const before = readFileSync(path)
    const h = harness([0])
    expect(ensureExecutableSignature(path, { run: h.run, platform: 'darwin', env }).state).toBe('verified')
    expect(h.calls).toEqual([{ command: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', path], env }])
    expect(readFileSync(path)).toEqual(before)
  })
  test('invalid/unsigned artifact → sign → strict reverify, not just sign exit 0', () => {
    const path = artifact()
    const h = harness([1, 0, 0])
    expect(ensureExecutableSignature(path, { run: h.run, platform: 'darwin' }).state).toBe('repaired')
    expect(h.calls.map(c => c.args)).toEqual([
      ['--verify', '--deep', '--strict', path], ['--force', '--sign', '-', path], ['--verify', '--deep', '--strict', path],
    ])
  })
  test('verify-only rejects invalid installed code without signing it', () => {
    const h = harness([1])
    expect(() => ensureExecutableSignature(artifact(), { run: h.run, platform: 'darwin', repair: false })).toThrow(/verification failed.*signature diagnostic/)
    expect(h.calls).toHaveLength(1)
  })
  test('verification tool timeout/spawn error/signal is hard failure, not permission to sign', () => {
    const h = harness([null])
    expect(() => ensureExecutableSignature(artifact(), { run: h.run, platform: 'darwin' })).toThrow(/verification failed/)
    expect(h.calls).toHaveLength(1)
  })
  for (const status of [1, null]) test(`repair failure (${status}) throws, no final verify`, () => {
    const h = harness([1, status])
    expect(() => ensureExecutableSignature(artifact(), { run: h.run, platform: 'darwin' })).toThrow(/repair failed/)
    expect(h.calls).toHaveLength(2)
  })
  for (const status of [1, null]) test(`post-repair verification failure (${status}) throws`, () => {
    const h = harness([1, 0, status])
    expect(() => ensureExecutableSignature(artifact(), { run: h.run, platform: 'darwin' })).toThrow(/verification after repair failed/)
    expect(h.calls).toHaveLength(3)
  })
  test('runner exceptions propagate without repair', () => {
    const h = harness([])
    expect(() => ensureExecutableSignature(artifact(), { run: h.run, platform: 'darwin' })).toThrow('unexpected command')
    expect(h.calls).toHaveLength(1)
  })
  test('non-Mach-O launchers bypass codesign', () => {
    const path = artifact()
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    const h = harness([])
    expect(ensureExecutableSignature(path, { run: h.run, platform: 'darwin' }).state).toBe('skipped-non-macho')
    expect(h.calls).toHaveLength(0)
  })
  test('truncated header/garbage is rejected, not treated as a script launcher', () => {
    const path = artifact()
    for (const bytes of [Buffer.from([0xcf, 0xfa]), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from('garbage'), Buffer.alloc(0)]) {
      writeFileSync(path, bytes)
      expect(() => ensureExecutableSignature(path, { run: harness([]).run, platform: 'darwin' })).toThrow(/not a Mach-O/)
    }
  })
  for (const magic of [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]) {
    test(`recognizes Mach-O magic ${magic.toString(16)}`, () => {
      expect(ensureExecutableSignature(artifact(magic), { run: harness([0]).run, platform: 'darwin' }).state).toBe('verified')
    })
  }
  test('missing artifact fails closed', () => {
    expect(() => ensureExecutableSignature(`${artifact()}.missing`, { run: harness([]).run, platform: 'darwin' })).toThrow()
  })
  test('non-macOS skips without reading an artifact or running codesign', () => {
    expect(ensureExecutableSignature('/missing', { run: harness([]).run, platform: 'linux' }).state).toBe('skipped-platform')
  })
  test('real codesign is skipped under sandbox, including a sparse passed env', () => {
    expect(ensureExecutableSignature('/missing', { env, platform: 'darwin' }).state).toBe('skipped-sandbox')
    expect(process.env.IAPEER_TEST_SANDBOX).toBe('1')
    expect(ensureExecutableSignature('/missing', { env: {}, platform: 'darwin' }).state).toBe('skipped-sandbox')
  })
})
