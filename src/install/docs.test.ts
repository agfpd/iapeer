// FU6 — hermetic tests for scaffoldHostDocs (the per-package on-host docs convention
// ~/.iapeer/docs/<pkg>/). Everything runs against an injected temp root (IAPEER_ROOT)
// under IAPEER_TEST_SANDBOX=1; no real ~/.iapeer is ever touched.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { scaffoldHostDocs } from './index.ts'

let base: string
let docsSrc: string
let env: NodeJS.ProcessEnv

function writeDocsFixture(): void {
  docsSrc = join(base, 'pkg', 'docs')
  mkdirSync(join(docsSrc, 'ru'), { recursive: true })
  mkdirSync(join(docsSrc, 'internals'), { recursive: true })
  writeFileSync(join(docsSrc, 'README.md'), '# contract')
  writeFileSync(join(docsSrc, '03-peers.md'), 'peers')
  writeFileSync(join(docsSrc, 'ru', '03.md'), 'пиры')
  writeFileSync(join(docsSrc, 'internals', 'secret.md'), 'internal-only')
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'iapeer-docs-'))
  env = { HOME: base, IAPEER_ROOT: join(base, '.iapeer'), IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv
  writeDocsFixture()
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('scaffoldHostDocs', () => {
  test('copies docs to the per-package path ~/.iapeer/docs/<pkg>/, EXCLUDING internals', () => {
    const r = scaffoldHostDocs('iapeer', docsSrc, env)
    expect(r.copied).toBe(true)
    expect(r.dest).toBe(join(base, '.iapeer', 'docs', 'iapeer'))
    expect(readFileSync(join(r.dest, 'README.md'), 'utf8')).toBe('# contract')
    expect(existsSync(join(r.dest, 'ru', '03.md'))).toBe(true)
    expect(existsSync(join(r.dest, 'internals'))).toBe(false) // internals subtree skipped
    expect(existsSync(`${r.dest}.tmp-${process.pid}`)).toBe(false) // no temp leftover
  })

  test('per-package layout: a second package lands in its OWN subdir, siblings kept', () => {
    scaffoldHostDocs('iapeer', docsSrc, env)
    scaffoldHostDocs('iapeer-memory', docsSrc, env)
    expect(existsSync(join(base, '.iapeer', 'docs', 'iapeer', 'README.md'))).toBe(true)
    expect(existsSync(join(base, '.iapeer', 'docs', 'iapeer-memory', 'README.md'))).toBe(true)
  })

  test('refresh: re-running replaces the package docs cleanly (stale files pruned)', () => {
    scaffoldHostDocs('iapeer', docsSrc, env)
    const dest = join(base, '.iapeer', 'docs', 'iapeer')
    writeFileSync(join(dest, 'STALE.md'), 'old') // simulate a removed-in-newer-version doc
    rmSync(join(docsSrc, '03-peers.md')) // source changed
    const r = scaffoldHostDocs('iapeer', docsSrc, env)
    expect(r.copied).toBe(true)
    expect(existsSync(join(dest, 'STALE.md'))).toBe(false) // atomic swap drops the old tree
    expect(existsSync(join(dest, '03-peers.md'))).toBe(false)
    expect(existsSync(join(dest, 'README.md'))).toBe(true)
  })

  test('missing source → soft skip (never fails the install)', () => {
    const r = scaffoldHostDocs('iapeer', join(base, 'nope'), env)
    expect(r.copied).toBe(false)
    expect(r.reason).toMatch(/not found/)
  })

  test('sandbox guard: refuses the REAL ~/.iapeer/docs under IAPEER_TEST_SANDBOX=1', () => {
    // Real HOME + no IAPEER_ROOT → resolves to the real ~/.iapeer/docs → must throw.
    expect(() =>
      scaffoldHostDocs('iapeer', docsSrc, { HOME: homedir(), IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv),
    ).toThrow(/refusing to scaffold docs into the REAL/)
  })
})
