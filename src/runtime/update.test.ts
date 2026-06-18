// update-runtime (§(г)) — version-gate / forced re-install / idempotent re-provision /
// peer restart. Sandboxed (IAPEER_ROOT temp dirs, IAPEER_TEST_SANDBOX), injected
// npx + npm-version + restart.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { updateAllRuntimes, updateRuntime, type RestartedPeer } from './update.ts'
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
})
