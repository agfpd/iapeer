// createPeer — cwd-independent peer creation: resolve a location (default
// ~/.iapeer/peers/<p> or --path), scaffold the folder (no-clobber), init it. All
// writes go under IAPEER_ROOT / IAPEER_LAUNCHAGENTS_DIR temp dirs; IAPEER_TEST_SANDBOX
// (set by the test script) makes launchctlBootstrap a no-op (skipped-sandbox), so the
// suite never loads a real launchd job.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createPeer } from './index.ts'
import { defaultPeerCwd, peerProfilePath } from '../storage/index.ts'
import { readPeerProfile, writePeerProfileAtomic } from '../identity/index.ts'
import { findPeer, readPeersIndex } from '../registry/index.ts'
import { isFoundationOwnedPlist, launchdPlistPath } from '../launch/index.ts'

const roots: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-create-'))
  roots.push(d)
  return d
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function fakeBin(name: string): { dir: string; bin: string } {
  const dir = mkTmp()
  const bin = join(dir, name)
  writeFileSync(bin, '#!/bin/sh\nexec sleep 1\n', { mode: 0o755 })
  return { dir, bin }
}
function envFor(root: string, path?: string): NodeJS.ProcessEnv {
  return {
    IAPEER_ROOT: join(root, 'iapeer'),
    IAPEER_LAUNCHAGENTS_DIR: join(root, 'LA'),
    IAPEER_TEST_SANDBOX: '1', // never load a real launchd job from the suite
    HOME: root,
    ...(path ? { PATH: path } : {}),
  } as NodeJS.ProcessEnv
}

describe('createPeer — default location', () => {
  test('claude peer lands at ~/.iapeer/peers/<p>, scaffolds folder + profile + registry + .mcp.json', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const r = await createPeer({ personality: 'worker', runtime: 'claude', env })

    expect(r.location).toBe(defaultPeerCwd('worker', { env }))
    expect(r.createdFolder).toBe(true)
    expect(r.runtime).toBe('claude')
    // folder + profile
    expect(existsSync(peerProfilePath(r.location))).toBe(true)
    expect(readPeerProfile(r.location)!.personality).toBe('worker')
    // registry
    expect(findPeer(readPeersIndex({ env }), 'worker')?.cwd).toBe(r.location)
    // claude transport wiring
    expect(r.mcpConfigPaths.length).toBe(1)
    expect(existsSync(join(r.location, '.mcp.json'))).toBe(true)
    // agentic → no plist, no bootstrap
    expect(r.plistPath).toBeUndefined()
    expect(r.bootstrapped).toBeUndefined()
  })

  test('personality is normalized; default home derives from the normalized name', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const r = await createPeer({ personality: 'Maria', runtime: 'claude', env })
    expect(r.personality).toBe('maria')
    expect(r.location).toBe(defaultPeerCwd('maria', { env }))
  })
})

describe('createPeer — infra (telegram human / notifier function): plist + auto-bootstrap', () => {
  test('telegram peer: natural intelligence, foundation-owned plist, bootstrap skipped under sandbox', async () => {
    const root = mkTmp()
    const { dir: bindir, bin } = fakeBin('telegram-runtime')
    const env = envFor(root, bindir)

    const r = await createPeer({ personality: 'maria', runtime: 'telegram', env })

    expect(r.runtime).toBe('telegram')
    expect(r.intelligence).toBe('natural') // telegram zone default (human)
    const plist = launchdPlistPath('maria', env)
    expect(existsSync(plist)).toBe(true)
    expect(isFoundationOwnedPlist(plist)).toBe(true)
    expect(readFileSync(plist, 'utf8')).toContain(`<string>${bin}</string>`)
    // AUTO-bootstrap attempted, but the sandbox guard makes it a no-op
    expect(r.bootstrapped?.state).toBe('skipped-sandbox')
    // router runtime → no MCP client config
    expect(r.mcpConfigPaths.length).toBe(0)
    expect(r.codexMcpConfigPath).toBeUndefined()
  })

  test('two telegram humans → two distinct plists (1 always-on peer = 1 plist)', async () => {
    const root = mkTmp()
    const { dir: bindir } = fakeBin('telegram-runtime')
    const env = envFor(root, bindir)

    await createPeer({ personality: 'maria', runtime: 'telegram', env })
    await createPeer({ personality: 'pavel', runtime: 'telegram', env })

    expect(existsSync(launchdPlistPath('maria', env))).toBe(true)
    expect(existsSync(launchdPlistPath('pavel', env))).toBe(true)
    expect(findPeer(readPeersIndex({ env }), 'maria')).not.toBeNull()
    expect(findPeer(readPeersIndex({ env }), 'pavel')).not.toBeNull()
  })

  test('re-create of the same infra peer is idempotent (no duplicate, no clobber)', async () => {
    const root = mkTmp()
    const { dir: bindir } = fakeBin('telegram-runtime')
    const env = envFor(root, bindir)

    await createPeer({ personality: 'maria', runtime: 'telegram', env })
    const r2 = await createPeer({ personality: 'maria', runtime: 'telegram', env })

    expect(r2.createdFolder).toBe(false)
    expect(readPeersIndex({ env }).peers.filter(p => p.personality === 'maria').length).toBe(1)
  })
})

describe('createPeer — location resolution + no-clobber', () => {
  test('--path overrides the default home', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const custom = join(mkTmp(), 'worker') // --path basename MUST equal personality (1:1 invariant)
    const r = await createPeer({ personality: 'worker', runtime: 'claude', path: custom, env })
    expect(r.location).toBe(custom)
    expect(existsSync(peerProfilePath(custom))).toBe(true)
  })

  test('refuses to create into a folder already holding a DIFFERENT peer', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const dir = join(mkTmp(), 'occupied')
    // Seed a different peer's profile in the target.
    writePeerProfileAtomic(dir, { personality: 'boris', runtime: 'claude', runtimes: ['claude'] })

    await expect(createPeer({ personality: 'maria', runtime: 'claude', path: dir, env })).rejects.toThrow(
      /already holds peer "boris"/,
    )
  })
})
