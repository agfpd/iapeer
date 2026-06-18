// peersHomeDir / defaultPeerCwd + ensureGlobalIapScaffold creating peers/ — the
// foundation-owned default home for `iapeer create`.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { defaultPeerCwd, ensureGlobalIapScaffold, peersHomeDir } from './index.ts'

const dirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-ph-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('peers home', () => {
  test('peersHomeDir / defaultPeerCwd resolve under IAPEER_ROOT', () => {
    const root = mkTmp()
    const env = { IAPEER_ROOT: join(root, 'iapeer'), HOME: root } as NodeJS.ProcessEnv
    expect(peersHomeDir({ env })).toBe(join(root, 'iapeer', 'peers'))
    expect(defaultPeerCwd('worker', { env })).toBe(join(root, 'iapeer', 'peers', 'worker'))
  })

  test('ensureGlobalIapScaffold creates ~/.iapeer/peers/', () => {
    const root = mkTmp()
    const env = { IAPEER_ROOT: join(root, 'iapeer'), HOME: root } as NodeJS.ProcessEnv
    ensureGlobalIapScaffold({ env })
    expect(existsSync(peersHomeDir({ env }))).toBe(true)
  })
})
