// runtime contract — manifest read/write, the per-peer self-config hook (env
// passthrough + fail states), and deployRuntime (declared-set provisioning). All under
// IAPEER_ROOT / IAPEER_LAUNCHAGENTS_DIR temp dirs; IAPEER_TEST_SANDBOX skips the real
// launchctl, so deploy provisions (folder + registry + plist) without loading a job.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readRuntimeManifest, runtimeSelfConfig, writeRuntimeManifest, type RuntimeManifest } from './index.ts'
import {
  deployRuntime,
  installRuntimePackage,
  onboardRuntime,
  resolveRuntimePackage,
  RUNTIME_PACKAGES,
} from './deploy.ts'
import { findPeer, readPeersIndex } from '../registry/index.ts'
import { launchdPlistPath } from '../launch/index.ts'

const roots: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-rtm-'))
  roots.push(d)
  return d
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function envFor(root: string, path?: string): NodeJS.ProcessEnv {
  return {
    IAPEER_ROOT: join(root, 'iapeer'),
    IAPEER_LAUNCHAGENTS_DIR: join(root, 'LA'),
    IAPEER_TEST_SANDBOX: '1',
    HOME: root,
    ...(path ? { PATH: path } : {}),
  } as NodeJS.ProcessEnv
}

/** A stub runtime launcher (so provision's resolveExecutable succeeds) + a stub
 *  self-config hook that records the per-peer env it was handed. */
function stubBins(): { dir: string; launcher: string; hook: string; marker: (p: string) => string } {
  const dir = mkTmp()
  const launcher = join(dir, 'notifier-runtime')
  writeFileSync(launcher, '#!/bin/sh\nexec sleep 1\n', { mode: 0o755 })
  const hook = join(dir, 'self-config.sh')
  // record IAPEER_PEER_* to a marker file named by personality → proves env passthrough
  writeFileSync(
    hook,
    '#!/bin/sh\nprintf "%s|%s|%s" "$IAPEER_PEER_PERSONALITY" "$IAPEER_PEER_RUNTIME" "$IAPEER_PEER_INTELLIGENCE" > "$IAPEER_ROOT/sc-$IAPEER_PEER_PERSONALITY"\nexit 0\n',
    { mode: 0o755 },
  )
  return { dir, launcher, hook, marker: p => join(dir, p) }
}

describe('runtime manifest', () => {
  test('write → read round-trip preserves runtime / selfConfig / peers', () => {
    const env = envFor(mkTmp())
    writeRuntimeManifest(
      { runtime: 'notifier', selfConfig: { command: 'notifier-runtime', args: ['self-config'] }, peers: [{ personality: 'timer', intelligence: 'absent' }] },
      { env },
    )
    const m = readRuntimeManifest('notifier', { env })!
    expect(m.runtime).toBe('notifier')
    expect(m.selfConfig).toEqual({ command: 'notifier-runtime', args: ['self-config'] })
    expect(m.peers?.[0].personality).toBe('timer')
  })

  test('absent manifest → null; runtime mismatch → throws', () => {
    const env = envFor(mkTmp())
    expect(readRuntimeManifest('notifier', { env })).toBeNull()
    // hand-write a manifest whose runtime field disagrees with its folder
    const path = join(env.IAPEER_ROOT as string, 'runtimes', 'notifier')
    writeFileSync(join(mkTmp(), 'ignore'), '') // keep tmp tracking happy
    rmSync(path, { recursive: true, force: true })
    writeRuntimeManifest({ runtime: 'notifier' }, { env })
    // corrupt the on-disk runtime field
    const file = join(path, 'runtime.json')
    writeFileSync(file, JSON.stringify({ runtime: 'telegram' }))
    expect(() => readRuntimeManifest('notifier', { env })).toThrow(/mismatch/)
  })
})

describe('runtimeSelfConfig (per-peer hook)', () => {
  test('absent when no manifest declares a hook', () => {
    const env = envFor(mkTmp())
    const r = runtimeSelfConfig({ personality: 'timer', cwd: mkTmp(), runtime: 'notifier', intelligence: 'absent' }, { env })
    expect(r.state).toBe('absent')
  })

  test('configured: hook runs with IAPEER_PEER_* env (NOT bare PEER_*)', () => {
    const root = mkTmp()
    const env = envFor(root)
    const { hook } = stubBins()
    writeRuntimeManifest({ runtime: 'notifier', selfConfig: hook }, { env })
    const cwd = mkTmp()
    const r = runtimeSelfConfig({ personality: 'timer', cwd, runtime: 'notifier', intelligence: 'absent' }, { env })
    expect(r.state).toBe('configured')
    // the hook wrote the per-peer env it received
    const recorded = readFileSync(join(env.IAPEER_ROOT as string, 'sc-timer'), 'utf8')
    expect(recorded).toBe('timer|notifier|absent')
  })

  test('failed: a non-zero hook is reported (caller decides fail-closed)', () => {
    const root = mkTmp()
    const env = envFor(root)
    const dir = mkTmp()
    const hook = join(dir, 'bad.sh')
    writeFileSync(hook, '#!/bin/sh\necho boom >&2\nexit 3\n', { mode: 0o755 })
    writeRuntimeManifest({ runtime: 'notifier', selfConfig: hook }, { env })
    const r = runtimeSelfConfig({ personality: 'timer', cwd: mkTmp(), runtime: 'notifier', intelligence: 'absent' }, { env })
    expect(r.state).toBe('failed')
    expect(r.detail).toContain('boom')
  })
})

describe('deployRuntime (declared-set, mode a)', () => {
  test('provisions the whole declared peer-set (folder + registry + plist + self-config)', async () => {
    const root = mkTmp()
    const { dir: bindir, launcher, hook } = stubBins()
    const env = envFor(root, bindir)
    writeRuntimeManifest(
      {
        runtime: 'notifier',
        selfConfig: hook,
        peers: [
          { personality: 'timer', intelligence: 'absent' },
          { personality: 'watcher', intelligence: 'absent' },
        ],
      },
      { env },
    )

    void launcher // resolved by provision via env.PATH (bindir holds notifier-runtime)
    const r = await deployRuntime({ runtime: 'notifier', env })
    expect(r.operatorAddOnly).toBe(false)
    expect(r.peers.map(p => p.personality).sort()).toEqual(['timer', 'watcher'])
    for (const p of r.peers) {
      expect(p.selfConfig).toBe('configured')
      expect(p.bootstrap).toBe('skipped-sandbox') // sandbox: not loaded
      expect(findPeer(readPeersIndex({ env }), p.personality)).not.toBeNull()
      expect(existsSync(launchdPlistPath(p.personality, env))).toBe(true)
    }
  })

  test('a runtime with no declared peers → operatorAddOnly (telegram = mode b)', async () => {
    const root = mkTmp()
    const env = envFor(root)
    writeRuntimeManifest({ runtime: 'telegram', selfConfig: 'telegram-runtime self-config' }, { env })
    const r = await deployRuntime({ runtime: 'telegram', env })
    expect(r.operatorAddOnly).toBe(true)
    expect(r.peers.length).toBe(0)
  })
})

describe('§6 — package registry + npx install + onboardRuntime', () => {
  test('resolveRuntimePackage: built-in registry, --package override', () => {
    expect(resolveRuntimePackage('telegram')).toBe(RUNTIME_PACKAGES.telegram)
    expect(resolveRuntimePackage('notifier')).toBe('@agfpd/notifier-runtime')
    expect(resolveRuntimePackage('telegram', '@me/fork')).toBe('@me/fork') // override wins
    expect(resolveRuntimePackage('web')).toBe('@agfpd/web-runtime')
    expect(resolveRuntimePackage('webhook')).toBeUndefined() // no mapping
  })

  test('installRuntimePackage: skipped when manifest present (idempotent)', () => {
    const env = envFor(mkTmp())
    writeRuntimeManifest({ runtime: 'notifier' }, { env })
    let called = false
    const r = installRuntimePackage({ runtime: 'notifier', env, runNpx: () => ((called = true), { ok: true }) })
    expect(r.state).toBe('skipped')
    expect(called).toBe(false) // never ran npx — package already installed
  })

  test('installRuntimePackage: ran (npx invoked) when no manifest', () => {
    const env = envFor(mkTmp())
    let gotPkg = ''
    const r = installRuntimePackage({
      runtime: 'notifier',
      env,
      runNpx: pkg => ((gotPkg = pkg), { ok: true }),
    })
    expect(r.state).toBe('ran')
    expect(gotPkg).toBe('@agfpd/notifier-runtime') // resolved from the registry
  })

  test('installRuntimePackage: no-package when no mapping + no --package + no manifest', () => {
    const env = envFor(mkTmp())
    const r = installRuntimePackage({ runtime: 'webhook', env, runNpx: () => ({ ok: true }) })
    expect(r.state).toBe('no-package')
  })

  test('onboardRuntime: npx (self-deploy manifest) → deploy declared set', async () => {
    const root = mkTmp()
    const bindir = mkTmp()
    writeFileSync(join(bindir, 'notifier-runtime'), '#!/bin/sh\nexec sleep 1\n', { mode: 0o755 })
    const hook = join(bindir, 'sc.sh')
    writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const env = envFor(root, bindir)

    // simulate the package self-deploying its manifest on npx (bin pre-staged on PATH)
    const runNpx = (_pkg: string, e: NodeJS.ProcessEnv) => {
      const m: RuntimeManifest = {
        runtime: 'notifier',
        selfConfig: hook,
        peers: [{ personality: 'sbxt', intelligence: 'absent' }],
      }
      writeRuntimeManifest(m, { env: e })
      return { ok: true }
    }

    const r = await onboardRuntime({ runtime: 'notifier', env, runNpx })
    expect(r.install.state).toBe('ran')
    expect(r.deploy?.peers.map(p => p.personality)).toEqual(['sbxt'])
    expect(r.deploy?.peers[0].selfConfig).toBe('configured')
    expect(r.deploy?.peers[0].bootstrap).toBe('skipped-sandbox')
    expect(findPeer(readPeersIndex({ env }), 'sbxt')).not.toBeNull()
  })

  test('onboardRuntime: failed npx aborts before deploy (fail-closed)', async () => {
    const env = envFor(mkTmp())
    await expect(
      onboardRuntime({ runtime: 'notifier', env, runNpx: () => ({ ok: false, detail: 'network' }) }),
    ).rejects.toThrow(/npx install.*failed/)
    expect(findPeer(readPeersIndex({ env }), 'sbxt')).toBeNull()
  })
})
