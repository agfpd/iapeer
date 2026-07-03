// update-runtime (§(г)) — version-gate / forced re-install / idempotent re-provision /
// peer restart. Sandboxed (IAPEER_ROOT temp dirs, IAPEER_TEST_SANDBOX), injected
// npx + npm-version + restart.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { updateAllRuntimes, updateRuntime, type RestartedPeer } from './update.ts'
import { installRuntimePackage } from './deploy.ts'
import { readRuntimeManifest, writeRuntimeManifest, type RuntimeManifest } from './index.ts'
import { upsertPeer } from '../registry/index.ts'

const roots: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-rtup-'))
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

function stubBins(): { dir: string; hook: string } {
  const dir = mkTmp()
  writeFileSync(join(dir, 'notifier-runtime'), '#!/bin/sh\nexec sleep 1\n', { mode: 0o755 })
  const hook = join(dir, 'sc.sh')
  writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { dir, hook }
}

const restartOk =
  (log: string[]) =>
  (personality: string): RestartedPeer => {
    log.push(personality)
    return { personality, state: 'restarted' }
  }

describe('updateRuntime (§(г): gate → re-install → re-provision → restart)', () => {
  test('full update: re-npx forced, declared set re-provisioned, peers restarted', async () => {
    const root = mkTmp()
    const { dir, hook } = stubBins()
    const env = envFor(root, dir)
    writeRuntimeManifest(
      { runtime: 'notifier', version: '0.1.0', selfConfig: hook, peers: [{ personality: 'timer', intelligence: 'absent' }] },
      { env },
    )
    // the live-host layout: the declared peer already sits in its DEFAULT location
    // (re-provision must be a no-clobber pass over it, not an identity conflict)
    await upsertPeer(
      { personality: 'timer', runtime: 'notifier', cwd: join(root, 'iapeer', 'peers', 'timer'), intelligence: 'absent' },
      { env },
    )
    let npxRan = false
    const restarts: string[] = []
    const r = await updateRuntime({
      runtime: 'notifier',
      env,
      runNpx: (_pkg, e) => {
        npxRan = true
        // the package self-deploys the NEW manifest with the new version stamp
        const m: RuntimeManifest = { runtime: 'notifier', version: '0.2.0', selfConfig: hook, peers: [{ personality: 'timer', intelligence: 'absent' }] }
        writeRuntimeManifest(m, { env: e })
        return { ok: true }
      },
      npmVersion: () => '0.2.0',
      restartPeer: restartOk(restarts),
    })
    expect(r.state).toBe('updated')
    expect(npxRan).toBe(true) // FORCED re-npx despite the present manifest
    expect(r.from).toBe('0.1.0')
    expect(r.to).toBe('0.2.0')
    expect(r.peers.map(p => p.personality)).toEqual(['timer']) // re-provisioned
    expect(restarts).toEqual(['timer']) // restarted via the injected stop/start
    expect(readRuntimeManifest('notifier', { env })?.version).toBe('0.2.0')
  })

  test('version-gate: manifest stamp equals npm latest → already-latest, NOTHING runs', async () => {
    const env = envFor(mkTmp())
    writeRuntimeManifest({ runtime: 'notifier', version: '0.2.0' }, { env })
    let npxRan = false
    const r = await updateRuntime({ runtime: 'notifier', env, runNpx: () => ((npxRan = true), { ok: true }), npmVersion: () => '0.2.0' })
    expect(r.state).toBe('already-latest')
    expect(npxRan).toBe(false)
  })

  test('--force overrides the gate', async () => {
    const root = mkTmp()
    const { dir, hook } = stubBins()
    const env = envFor(root, dir)
    writeRuntimeManifest({ runtime: 'notifier', version: '0.2.0', selfConfig: hook }, { env })
    let npxRan = false
    const r = await updateRuntime({
      runtime: 'notifier',
      env,
      force: true,
      runNpx: () => ((npxRan = true), { ok: true }),
      npmVersion: () => '0.2.0',
      restartPeer: restartOk([]),
    })
    expect(r.state).toBe('updated')
    expect(npxRan).toBe(true)
  })

  test('no version stamp → gate skipped, idempotent re-install with an honest detail', async () => {
    const root = mkTmp()
    const { dir, hook } = stubBins()
    const env = envFor(root, dir)
    writeRuntimeManifest({ runtime: 'notifier', selfConfig: hook }, { env }) // owners have not stamped yet
    const r = await updateRuntime({
      runtime: 'notifier',
      env,
      runNpx: () => ({ ok: true }),
      npmVersion: () => '0.2.0',
      restartPeer: restartOk([]),
    })
    expect(r.state).toBe('updated')
    expect(r.detail).toContain('no version stamp')
  })

  test('not installed → not-installed with the install-runtime recipe; npm unreachable → loud', async () => {
    const env = envFor(mkTmp())
    const r = await updateRuntime({ runtime: 'notifier', env, npmVersion: () => '0.2.0' })
    expect(r.state).toBe('not-installed')
    expect(r.detail).toContain('install-runtime notifier')
    writeRuntimeManifest({ runtime: 'notifier', version: '0.1.0' }, { env })
    const r2 = await updateRuntime({ runtime: 'notifier', env, npmVersion: () => null })
    expect(r2.state).toBe('npm-unreachable')
  })

  test('failed re-npx → install-failed, no deploy, no restarts', async () => {
    const env = envFor(mkTmp())
    writeRuntimeManifest({ runtime: 'notifier', version: '0.1.0' }, { env })
    const restarts: string[] = []
    const r = await updateRuntime({
      runtime: 'notifier',
      env,
      runNpx: () => ({ ok: false, detail: 'network down' }),
      npmVersion: () => '0.2.0',
      restartPeer: restartOk(restarts),
    })
    expect(r.state).toBe('install-failed')
    expect(restarts).toEqual([])
  })

  test('mode-b runtime (telegram, no declared peers): empty re-provision, registered router restarted', async () => {
    const root = mkTmp()
    const env = envFor(root)
    writeRuntimeManifest({ runtime: 'telegram', version: '0.10.0' }, { env })
    await upsertPeer({ personality: 'nova', runtime: 'telegram', cwd: '/tmp/nova', intelligence: 'natural' }, { env })
    const restarts: string[] = []
    const r = await updateRuntime({
      runtime: 'telegram',
      env,
      runNpx: (_pkg, e) => {
        writeRuntimeManifest({ runtime: 'telegram', version: '0.10.3' }, { env: e })
        return { ok: true }
      },
      npmVersion: () => '0.10.3',
      restartPeer: restartOk(restarts),
    })
    expect(r.state).toBe('updated')
    expect(r.peers).toEqual([]) // operator-add runtime: nothing declared to re-provision
    expect(restarts).toEqual(['nova']) // the router still restarts onto the new code
  })
})

describe('updateAllRuntimes (--all)', () => {
  test('updates installed runtimes, reports the rest not-installed (never an error)', async () => {
    const root = mkTmp()
    const env = envFor(root)
    writeRuntimeManifest({ runtime: 'telegram', version: '1.0.0' }, { env })
    const results = await updateAllRuntimes({
      env,
      runNpx: () => ({ ok: true }),
      npmVersion: () => '1.0.0',
      restartPeer: restartOk([]),
    })
    const byRt = Object.fromEntries(results.map(r => [r.runtime, r.state]))
    expect(byRt.telegram).toBe('already-latest')
    expect(byRt.notifier).toBe('not-installed')
  })

  test('В52 — a runtime OUTSIDE the built-in registry but installed on disk IS in the cascade', async () => {
    const root = mkTmp()
    const env = envFor(root)
    // `claude` has no built-in package mapping — only the manifest's package stamp
    // (the custom `--package` install) makes it updatable. The frozen-map iteration
    // used to drop it from the cascade entirely.
    writeRuntimeManifest({ runtime: 'claude', version: '1.0.0', package: '@custom/claude-runtime' } as RuntimeManifest, { env })
    const asked: string[] = []
    const results = await updateAllRuntimes({
      env,
      runNpx: () => ({ ok: true }),
      npmVersion: pkg => {
        asked.push(pkg)
        return '1.0.0'
      },
      restartPeer: restartOk([]),
    })
    const custom = results.find(r => r.runtime === 'claude')
    expect(custom?.state).toBe('already-latest')
    expect(asked).toContain('@custom/claude-runtime') // resolved from the manifest stamp
  })
})

describe('В51 — delivered-version verify + pinned npx', () => {
  test('npx serves STALE code (new manifest older than the target) → install-failed, loud', async () => {
    const root = mkTmp()
    const env = envFor(root)
    writeRuntimeManifest({ runtime: 'notifier', version: '0.1.0' }, { env })
    const restarts: string[] = []
    const r = await updateRuntime({
      runtime: 'notifier',
      env,
      runNpx: (_pkg, e) => {
        // the stale cache/CDN delivered 0.1.5 while the gate resolved 0.2.0
        writeRuntimeManifest({ runtime: 'notifier', version: '0.1.5' }, { env: e })
        return { ok: true }
      },
      npmVersion: () => '0.2.0',
      restartPeer: restartOk(restarts),
    })
    expect(r.state).toBe('install-failed')
    expect(r.detail).toMatch(/delivered version 0\.1\.5 ≠ target 0\.2\.0/)
    expect(restarts).toEqual([]) // no restart onto unverified code
  })

  test('the npx spec is PINNED to the gate-resolved version', async () => {
    const root = mkTmp()
    const { dir, hook } = stubBins()
    const env = envFor(root, dir)
    writeRuntimeManifest({ runtime: 'notifier', version: '0.1.0', selfConfig: hook }, { env })
    const specs: string[] = []
    await updateRuntime({
      runtime: 'notifier',
      env,
      runNpx: (pkg, e) => {
        specs.push(pkg)
        writeRuntimeManifest({ runtime: 'notifier', version: '0.2.0', selfConfig: hook }, { env: e })
        return { ok: true }
      },
      npmVersion: () => '0.2.0',
      restartPeer: restartOk([]),
    })
    expect(specs).toEqual(['@agfpd/notifier-runtime@0.2.0'])
  })
})

describe('В52 — package stamp (custom --package survives)', () => {
  test('installRuntimePackage with --package stamps the manifest after a successful run', () => {
    const root = mkTmp()
    const env = envFor(root)
    const r = installRuntimePackage({
      runtime: 'notifier',
      package: '@custom/notifier-fork',
      env,
      runNpx: (_pkg, e) => {
        // the package self-deploys its manifest WITHOUT a package field
        writeRuntimeManifest({ runtime: 'notifier', version: '0.9.0' }, { env: e })
        return { ok: true }
      },
    })
    expect(r.state).toBe('ran')
    expect(readRuntimeManifest('notifier', { env })?.package).toBe('@custom/notifier-fork')
  })

  test('updateRuntime resolves the package from the manifest stamp (no --package repeat)', async () => {
    const root = mkTmp()
    const env = envFor(root)
    writeRuntimeManifest({ runtime: 'notifier', version: '0.9.0', package: '@custom/notifier-fork' } as RuntimeManifest, { env })
    const asked: string[] = []
    const specs: string[] = []
    const r = await updateRuntime({
      runtime: 'notifier',
      env,
      runNpx: (pkg, e) => {
        specs.push(pkg)
        writeRuntimeManifest({ runtime: 'notifier', version: '1.0.0', package: '@custom/notifier-fork' } as RuntimeManifest, { env: e })
        return { ok: true }
      },
      npmVersion: pkg => {
        asked.push(pkg)
        return '1.0.0'
      },
      restartPeer: restartOk([]),
    })
    expect(r.state).toBe('updated')
    expect(asked).toEqual(['@custom/notifier-fork'])
    expect(specs).toEqual(['@custom/notifier-fork@1.0.0'])
  })
})
