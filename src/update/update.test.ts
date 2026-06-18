// updateIapeer — the version-gated, cloud-only deploy. The three side-effects
// (resolve latest / install / restart) are injected, so the gate logic is tested
// with NO network and NO launchctl. The sandbox guard on the REAL installer is
// exercised too (a test must never npx-install over the prod binary).

import { describe, expect, test } from 'bun:test'
import { IAPEER_VERSION, recycleFoundationOwnedInfraJobs, updateIapeer, waitForDaemonHealthy } from '../index.ts'
import type { DaemonRestartResult } from '../launch/launchd.ts'

const restarted = (): DaemonRestartResult => ({ state: 'restarted' })

/** A deps bundle with call-tracking spies. `latest` is what the resolver returns for
 *  the spec (latest OR a pinned `target`); null simulates "not found / unreachable". */
function harness(opts: {
  current: string
  latest: string | null
  target?: string
  installOk?: boolean
  restart?: DaemonRestartResult
  recycle?: ReturnType<typeof recycleFoundationOwnedInfraJobs>
  force?: boolean
}) {
  const calls = { install: [] as string[], restart: 0, recycle: 0, resolved: [] as string[] }
  const result = updateIapeer({
    env: { IAPEER_TEST_SANDBOX: '1' },
    force: opts.force,
    currentVersion: opts.current,
    targetVersion: opts.target,
    resolveVersion: spec => {
      calls.resolved.push(spec)
      return opts.latest
    },
    runInstall: v => {
      calls.install.push(v)
      return opts.installOk ?? true
    },
    restartDaemon: () => {
      calls.restart++
      return opts.restart ?? restarted()
    },
    recycleInfraJobs: () => {
      calls.recycle++
      return opts.recycle ?? []
    },
  })
  return { result, calls }
}

describe('updateIapeer — version gate', () => {
  test('already at latest → no install, no restart', () => {
    const { result, calls } = harness({ current: '0.2.2', latest: '0.2.2' })
    expect(result.status).toBe('already-latest')
    expect(result.from).toBe('0.2.2')
    expect(result.latest).toBe('0.2.2')
    expect(calls.install).toEqual([])
    expect(calls.restart).toBe(0)
    expect(calls.recycle).toBe(0)
  })

  test('--force reinstalls + restarts even when already latest', () => {
    const { result, calls } = harness({ current: '0.2.2', latest: '0.2.2', force: true })
    expect(result.status).toBe('updated')
    expect(result.to).toBe('0.2.2')
    expect(calls.install).toEqual(['0.2.2'])
    expect(calls.restart).toBe(1)
  })

  test('newer published version → installs THAT version + restarts', () => {
    const { result, calls } = harness({ current: '0.2.2', latest: '0.3.0' })
    expect(result.status).toBe('updated')
    expect(result.from).toBe('0.2.2')
    expect(result.to).toBe('0.3.0')
    expect(result.daemon).toBe('restarted')
    expect(result.infra).toEqual([])
    expect(calls.install).toEqual(['0.3.0']) // installs latest, not current
    expect(calls.restart).toBe(1)
    expect(calls.recycle).toBe(1)
  })

  test('after binary install, loaded foundation-owned infra jobs are recycled too', () => {
    const recycle = [{ personality: 'timer', runtime: 'notifier', label: 'com.iapeer.timer', state: 'restarted' as const }]
    const { result, calls } = harness({ current: '0.2.2', latest: '0.3.0', recycle })
    expect(result.status).toBe('updated')
    expect(result.infra).toEqual(recycle)
    expect(calls.recycle).toBe(1)
  })

  test('no target → resolves the "latest" spec', () => {
    const { calls } = harness({ current: '0.2.2', latest: '0.3.0' })
    expect(calls.resolved).toEqual(['latest'])
  })
})

describe('updateIapeer — pinned version (one-shot target)', () => {
  test('pin to an exact version → resolves THAT spec and installs it', () => {
    const { result, calls } = harness({ current: '0.2.4', target: '0.2.2', latest: '0.2.2' })
    expect(calls.resolved).toEqual(['0.2.2']) // resolves the pinned spec, not "latest"
    expect(result.status).toBe('updated')
    expect(result.from).toBe('0.2.4')
    expect(result.to).toBe('0.2.2') // a DOWNGRADE — deeper recovery than the single .prev
    expect(calls.install).toEqual(['0.2.2'])
  })

  test('pinned version already installed → already-at, no install', () => {
    const { result, calls } = harness({ current: '0.2.2', target: '0.2.2', latest: '0.2.2' })
    expect(result.status).toBe('already-latest')
    expect(calls.install).toEqual([])
  })

  test('pinned version not found on npm → failed (not an npx error)', () => {
    const { result, calls } = harness({ current: '0.2.4', target: '9.9.9', latest: null })
    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/"9\.9\.9" not found on npm/i)
    expect(calls.install).toEqual([])
    expect(calls.restart).toBe(0)
  })
})

describe('updateIapeer — failure paths', () => {
  test('latest unresolved (offline / registry error) → failed, no install', () => {
    const { result, calls } = harness({ current: '0.2.2', latest: null })
    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/latest.*version.*npm|offline|registry/i)
    expect(calls.install).toEqual([])
    expect(calls.restart).toBe(0)
  })

  test('install fails → failed, daemon NOT restarted', () => {
    const { result, calls } = harness({ current: '0.2.2', latest: '0.3.0', installOk: false })
    expect(result.status).toBe('failed')
    expect(result.latest).toBe('0.3.0')
    expect(result.reason).toMatch(/install.*failed/i)
    expect(calls.restart).toBe(0)
  })

  test('daemon not loaded → updated, daemon=not-loaded (no error)', () => {
    const { result } = harness({ current: '0.2.2', latest: '0.3.0', restart: { state: 'not-loaded' } })
    expect(result.status).toBe('updated')
    expect(result.daemon).toBe('not-loaded')
    expect(result.reason).toBeUndefined()
  })

  test('binary updated but restart failed → updated with a warning reason', () => {
    const { result, calls } = harness({
      current: '0.2.2',
      latest: '0.3.0',
      restart: { state: 'failed', detail: 'kickstart exit 1' },
    })
    expect(result.status).toBe('updated')
    expect(result.daemon).toBe('failed')
    expect(result.reason).toMatch(/restart failed.*kickstart exit 1/i)
    expect(calls.recycle).toBe(0)
  })
})

describe('updateIapeer — real-installer sandbox guard', () => {
  test('default runInstall refuses a real install under IAPEER_TEST_SANDBOX', () => {
    // fetchLatest injected (newer) so the gate proceeds to the DEFAULT installer,
    // which must refuse rather than fetch+build over the prod ~/.local/bin/iapeer.
    expect(() =>
      updateIapeer({
        env: { IAPEER_TEST_SANDBOX: '1' },
        currentVersion: '0.2.2',
        resolveVersion: () => '0.3.0',
        // runInstall NOT injected → exercises the real defaultRunInstall guard.
        restartDaemon: restarted,
      }),
    ).toThrow(/IAPEER_TEST_SANDBOX/)
  })
})

describe('IAPEER_VERSION', () => {
  test('is a baked semver string', () => {
    expect(IAPEER_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})

/** A probe returning the given sequence (repeats the last element once exhausted). */
function seqProbe(seq: boolean[]): () => Promise<boolean> {
  let i = 0
  return () => Promise.resolve(seq[Math.min(i++, seq.length - 1)])
}

describe('waitForDaemonHealthy', () => {
  test('two consecutive successes → healthy', async () => {
    const h = await waitForDaemonHealthy({ probe: seqProbe([true, true]), needConsecutive: 2, timeoutMs: 1000, intervalMs: 1 })
    expect(h.healthy).toBe(true)
  })

  test('a single bind-then-crash flap does NOT read as healthy (streak resets)', async () => {
    // true, false, true, true → first success is wiped by the false; only the trailing
    // pair (true,true) satisfies needConsecutive=2.
    const h = await waitForDaemonHealthy({ probe: seqProbe([true, false, true, true]), needConsecutive: 2, timeoutMs: 1000, intervalMs: 1 })
    expect(h.healthy).toBe(true)
  })

  test('never responds within the window → unhealthy with a detail', async () => {
    const h = await waitForDaemonHealthy({ probe: seqProbe([false]), needConsecutive: 2, timeoutMs: 40, intervalMs: 5 })
    expect(h.healthy).toBe(false)
    expect(h.detail).toMatch(/did not become healthy/i)
  })

  test('IAPEER_TEST_SANDBOX with no injected probe → skipped healthy (never hits a real socket)', async () => {
    const h = await waitForDaemonHealthy({ env: { IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv })
    expect(h.healthy).toBe(true)
    expect(h.detail).toBe('skipped-sandbox')
  })
})
