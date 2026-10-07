import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { type SignatureRunner } from '../install/signature.ts'
import { installRuntimePackage, onboardRuntime, deployRuntime } from './deploy.ts'
import { updateRuntime } from './update.ts'
import { runtimeManifestPath, writeRuntimeManifest } from './index.ts'
import { verifyRuntimeSignatures } from './signature.ts'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'iapeer-runtime-sig-'))
  roots.push(root)
  const env = { HOME: root, IAPEER_ROOT: join(root, 'root'), IAPEER_LAUNCHAGENTS_DIR: join(root, 'LA'), IAPEER_TEST_SANDBOX: '1', PATH: root }
  const launcher = join(root, 'notifier-runtime')
  const bytes = Buffer.alloc(32)
  bytes.writeUInt32BE(0xcffaedfe)
  writeFileSync(launcher, bytes, { mode: 0o755 })
  writeRuntimeManifest({ runtime: 'notifier', version: '1.0.0', selfConfig: { command: launcher }, peers: [{ personality: 'timer' }] }, { env })
  return { root, env, launcher }
}
const reject = () => { throw new Error('invalid runtime signature') }

describe('runtime signature secondary gate', () => {
  test('verifies actual default launcher + absolute hook, deduplicated; never repairs', () => {
    const { env, launcher } = setup()
    const calls: string[][] = []
    const run: SignatureRunner = (command, args, passedEnv) => {
      expect(command).toBe('/usr/bin/codesign')
      expect(passedEnv).toBe(env)
      calls.push(args)
      return { status: 0 }
    }
    verifyRuntimeSignatures('notifier', env, undefined, { platform: 'darwin', run })
    expect(calls).toEqual([['--verify', '--deep', '--strict', launcher]])
    expect(() => verifyRuntimeSignatures('notifier', env, undefined, { platform: 'darwin', run: () => ({ status: 1 }) })).toThrow(/verification failed/)
  })
  test('explicit peer runtimeBin and supplied manifest override are verified', () => {
    const { env, launcher } = setup()
    const explicit = `${launcher}-explicit`
    writeFileSync(explicit, readFileSync(launcher), { mode: 0o755 })
    const paths: string[] = []
    verifyRuntimeSignatures('notifier', env, { runtime: 'notifier', peers: [{ personality: 'timer', runtimeBin: explicit }] }, {
      platform: 'darwin', run: (_cmd, args) => { paths.push(args.at(-1)!); return { status: 0 } },
    })
    expect(paths).toEqual([explicit])
  })
  test('missing launcher fails, never borrows a real host PATH', () => {
    const { env } = setup()
    expect(() => verifyRuntimeSignatures('notifier', { ...env, PATH: '/missing' }, undefined, { platform: 'darwin', run: () => ({ status: 0 }) })).toThrow(/not found/)
  })
  test('script runtime launchers are compatible; no codesign invocation', () => {
    const { env, launcher } = setup()
    writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    verifyRuntimeSignatures('notifier', env, undefined, { platform: 'darwin', run: () => { throw new Error('unexpected codesign') } })
  })
  test('real commands disabled under sandbox even if passed env omits the flag', () => {
    verifyRuntimeSignatures('notifier', { PATH: '/missing' })
  })
  test('already installed is checked and reported failed, without npx', () => {
    const { env } = setup()
    const r = installRuntimePackage({ runtime: 'notifier', env, verifySignatures: reject, runNpx: () => { throw new Error('unexpected npx') } })
    expect(r.state).toBe('failed')
    expect(r.detail).toBe('invalid runtime signature')
  })
  test('post-install verification precedes package-stamp writes and deploy', async () => {
    const { env, root } = setup()
    const path = runtimeManifestPath('notifier', { env })
    const before = readFileSync(path, 'utf8')
    const order: string[] = []
    await expect(onboardRuntime({
      runtime: 'notifier', env, npx: true, package: '@example/custom',
      runNpx: () => { order.push('npx'); return { ok: true } },
      verifySignatures: () => { order.push('verify'); reject() },
    })).rejects.toThrow('invalid runtime signature')
    expect(order).toEqual(['npx', 'verify'])
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(existsSync(join(root, 'LA'))).toBe(false)
  })
  test('direct deploy checks signatures before creating peers/plists', async () => {
    const { env, root } = setup()
    await expect(deployRuntime({ runtime: 'notifier', env, verifySignatures: reject })).rejects.toThrow('invalid runtime signature')
    expect(existsSync(join(root, 'LA'))).toBe(false)
    expect(existsSync(join(root, 'root', 'peers', 'timer'))).toBe(false)
  })
  for (const latest of ['1.0.0', '1.0.1']) test(`update target ${latest}: signature failure blocks provision and restart`, async () => {
    const { env, root } = setup()
    let installed = false
    const r = await updateRuntime({
      runtime: 'notifier', env, npmVersion: () => latest, verifySignatures: reject,
      runNpx: () => { installed = true; return { ok: true } },
      restartPeer: () => { throw new Error('unexpected restart') },
    })
    expect(r.state).toBe('install-failed')
    expect(r.detail).toBe('invalid runtime signature')
    expect(installed).toBe(latest !== '1.0.0')
    expect(r.peers).toEqual([])
    expect(r.restarted).toEqual([])
    expect(existsSync(join(root, 'LA'))).toBe(false)
  })
})
