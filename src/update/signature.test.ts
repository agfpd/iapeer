import { describe, expect, test } from 'bun:test'
import { updateIapeer } from './index.ts'

describe('foundation update installed signature gate', () => {
  for (const live of [null, '1.0.0', '0.9.0']) {
    test(`same-version update rejects invalid on-disk binary (live=${live}) before lifecycle`, async () => {
      const unexpected = () => { throw new Error('unexpected activation') }
      let verified = 0
      const result = await updateIapeer({
        env: { IAPEER_TEST_SANDBOX: '1' }, currentVersion: '1.0.0',
        resolveVersion: () => '1.0.0', liveDaemonVersion: () => live,
        verifyInstalledSignature: () => { verified++; throw new Error('strict verify invalid') },
        runInstall: unexpected, restartDaemon: unexpected,
        recycleInfraJobs: unexpected, stampHealthy: unexpected, waitHealthy: unexpected,
      })
      expect(verified).toBe(1)
      expect(result.status).toBe('failed')
      expect(result.reason).toContain('strict verify invalid')
    })
  }
  test('successful external install is rechecked before daemon activation', async () => {
    const order: string[] = []
    const unexpected = () => { throw new Error('unexpected activation') }
    const result = await updateIapeer({
      env: { IAPEER_TEST_SANDBOX: '1' }, currentVersion: '1.0.0', resolveVersion: () => '1.0.1',
      runInstall: () => { order.push('install'); return true },
      verifyInstalledSignature: () => { order.push('verify'); throw new Error('invalid installed signature') },
      restartDaemon: unexpected, recycleInfraJobs: unexpected, stampHealthy: unexpected,
    })
    expect(order).toEqual(['install', 'verify'])
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('no restart attempted')
  })
  test('valid same-version binary can heal stale daemon, verification before restart', async () => {
    const order: string[] = []
    const result = await updateIapeer({
      env: { IAPEER_TEST_SANDBOX: '1' }, currentVersion: '1.0.0', resolveVersion: () => '1.0.0',
      liveDaemonVersion: () => '0.9.0',
      verifyInstalledSignature: () => { order.push('verify') },
      restartDaemon: () => { order.push('restart'); return { state: 'restarted' } },
      waitHealthy: async () => ({ healthy: true }), recycleInfraJobs: () => [], stampHealthy: () => true,
    })
    expect(order).toEqual(['verify', 'restart'])
    expect(result.status).toBe('updated')
    expect(result.healedStaleDaemon).toBe('0.9.0')
  })
})
