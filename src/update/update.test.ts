// updateIapeer — the version-gated, cloud-only deploy. The three side-effects
// (resolve latest / install / restart) are injected, so the gate logic is tested
// with NO network and NO launchctl. The sandbox guard on the REAL installer is
// exercised too (a test must never npx-install over the prod binary).

import { describe, expect, test } from 'bun:test'
import { IAPEER_VERSION, recycleFoundationOwnedInfraJobs, updateIapeer, waitForDaemonHealthy } from '../index.ts'
import { cascadeTail } from './index.ts'
import type { DaemonRestartResult } from '../launch/launchd.ts'

const restarted = (): DaemonRestartResult => ({ state: 'restarted' })

/** A deps bundle with call-tracking spies. `latest` is what the resolver returns for
 *  the spec (latest OR a pinned `target`); null simulates "not found / unreachable". */
async function harness(opts: {
  current: string
  latest: string | null
  target?: string
  installOk?: boolean
  restart?: DaemonRestartResult
  recycle?: ReturnType<typeof recycleFoundationOwnedInfraJobs>
  force?: boolean
  /** В53 — what the live daemon reports (default: matches `current`, i.e. consistent). */
  liveVersion?: string | null
  /** В54 — post-restart health verdict (default: healthy). */
  healthy?: boolean
}) {
  const calls = { install: [] as string[], restart: 0, recycle: 0, resolved: [] as string[], stamped: 0, healthChecks: 0 }
  const result = await updateIapeer({
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
    liveDaemonVersion: () => (opts.liveVersion === undefined ? opts.current : opts.liveVersion),
    waitHealthy: () => {
      calls.healthChecks++
      return Promise.resolve(opts.healthy === false ? { healthy: false, detail: 'probe refused' } : { healthy: true })
    },
    stampHealthy: () => {
      calls.stamped++
      return true
    },
  })
  return { result, calls }
}

describe('updateIapeer — version gate', () => {
  test('already at latest → no install, no restart', async () => {
    const { result, calls } = await harness({ current: '0.2.2', latest: '0.2.2' })
    expect(result.status).toBe('already-latest')
    expect(result.from).toBe('0.2.2')
    expect(result.latest).toBe('0.2.2')
    expect(calls.install).toEqual([])
    expect(calls.restart).toBe(0)
    expect(calls.recycle).toBe(0)
  })

  test('--force reinstalls + restarts even when already latest', async () => {
    const { result, calls } = await harness({ current: '0.2.2', latest: '0.2.2', force: true })
    expect(result.status).toBe('updated')
    expect(result.to).toBe('0.2.2')
    expect(calls.install).toEqual(['0.2.2'])
    expect(calls.restart).toBe(1)
  })

  test('newer published version → installs THAT version + restarts', async () => {
    const { result, calls } = await harness({ current: '0.2.2', latest: '0.3.0' })
    expect(result.status).toBe('updated')
    expect(result.from).toBe('0.2.2')
    expect(result.to).toBe('0.3.0')
    expect(result.daemon).toBe('restarted')
    expect(result.infra).toEqual([])
    expect(calls.install).toEqual(['0.3.0']) // installs latest, not current
    expect(calls.restart).toBe(1)
    expect(calls.recycle).toBe(1)
  })

  test('after binary install, loaded foundation-owned infra jobs are recycled too', async () => {
    const recycle = [{ personality: 'timer', runtime: 'notifier', label: 'com.iapeer.timer', state: 'restarted' as const }]
    const { result, calls } = await harness({ current: '0.2.2', latest: '0.3.0', recycle })
    expect(result.status).toBe('updated')
    expect(result.infra).toEqual(recycle)
    expect(calls.recycle).toBe(1)
  })

  test('В54 — infra recycles ONLY after the daemon proved healthy; stamp follows health', async () => {
    const { result, calls } = await harness({ current: '0.2.2', latest: '0.3.0' })
    expect(result.healthy).toBe(true)
    expect(calls.healthChecks).toBe(1)
    expect(calls.recycle).toBe(1)
    expect(calls.stamped).toBe(1) // В50 — known-good stamp on the healthy binary
  })

  test('В54 — unhealthy restart → NO infra recycle, NO stamp, loud reason', async () => {
    const { result, calls } = await harness({ current: '0.2.2', latest: '0.3.0', healthy: false })
    expect(result.status).toBe('updated')
    expect(result.healthy).toBe(false)
    expect(result.infra).toEqual([])
    expect(result.reason).toMatch(/NOT healthy/i)
    expect(calls.recycle).toBe(0) // never widen the blast radius onto telegram/notifier
    expect(calls.stamped).toBe(0) // a broken binary is never stamped known-good
  })
})

describe('updateIapeer — В53 stale live daemon (interrupted prior update)', () => {
  test('binary at latest but live daemon on an OLDER version → heal with a restart', async () => {
    const { result, calls } = await harness({ current: '0.3.0', latest: '0.3.0', liveVersion: '0.2.9' })
    expect(result.status).toBe('updated')
    expect(result.healedStaleDaemon).toBe('0.2.9')
    expect(result.from).toBe('0.2.9')
    expect(result.to).toBe('0.3.0')
    expect(calls.install).toEqual([]) // the binary is already correct — no re-install
    expect(calls.restart).toBe(1)
    expect(calls.recycle).toBe(1) // after health
    expect(calls.stamped).toBe(1)
  })

  test('no live daemon (router.json absent) → plain already-latest, nothing touched', async () => {
    const { result, calls } = await harness({ current: '0.3.0', latest: '0.3.0', liveVersion: null })
    expect(result.status).toBe('already-latest')
    expect(calls.restart).toBe(0)
  })

  test('live daemon matches the binary → plain already-latest', async () => {
    const { result, calls } = await harness({ current: '0.3.0', latest: '0.3.0', liveVersion: '0.3.0' })
    expect(result.status).toBe('already-latest')
    expect(calls.restart).toBe(0)
  })

  test('no target → resolves the "latest" spec', async () => {
    const { calls } = await harness({ current: '0.2.2', latest: '0.3.0' })
    expect(calls.resolved).toEqual(['latest'])
  })
})

describe('updateIapeer — pinned version (one-shot target)', () => {
  test('pin to an exact version → resolves THAT spec and installs it', async () => {
    const { result, calls } = await harness({ current: '0.2.4', target: '0.2.2', latest: '0.2.2' })
    expect(calls.resolved).toEqual(['0.2.2']) // resolves the pinned spec, not "latest"
    expect(result.status).toBe('updated')
    expect(result.from).toBe('0.2.4')
    expect(result.to).toBe('0.2.2') // a DOWNGRADE — deeper recovery than the single .prev
    expect(calls.install).toEqual(['0.2.2'])
  })

  test('pinned version already installed → already-at, no install', async () => {
    const { result, calls } = await harness({ current: '0.2.2', target: '0.2.2', latest: '0.2.2' })
    expect(result.status).toBe('already-latest')
    expect(calls.install).toEqual([])
  })

  test('pinned version not found on npm → failed (not an npx error)', async () => {
    const { result, calls } = await harness({ current: '0.2.4', target: '9.9.9', latest: null })
    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/"9\.9\.9" not found on npm/i)
    expect(calls.install).toEqual([])
    expect(calls.restart).toBe(0)
  })
})

describe('updateIapeer — failure paths', () => {
  test('latest unresolved (offline / registry error) → failed, no install', async () => {
    const { result, calls } = await harness({ current: '0.2.2', latest: null })
    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/latest.*version.*npm|offline|registry/i)
    expect(calls.install).toEqual([])
    expect(calls.restart).toBe(0)
  })

  test('install fails → failed, daemon NOT restarted', async () => {
    const { result, calls } = await harness({ current: '0.2.2', latest: '0.3.0', installOk: false })
    expect(result.status).toBe('failed')
    expect(result.latest).toBe('0.3.0')
    expect(result.reason).toMatch(/install.*failed/i)
    expect(calls.restart).toBe(0)
  })

  test('daemon not loaded → updated, daemon=not-loaded (no error)', async () => {
    const { result } = await harness({ current: '0.2.2', latest: '0.3.0', restart: { state: 'not-loaded' } })
    expect(result.status).toBe('updated')
    expect(result.daemon).toBe('not-loaded')
    expect(result.reason).toBeUndefined()
  })

  test('binary updated but restart failed → updated with a warning reason', async () => {
    const { result, calls } = await harness({
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
  test('default runInstall refuses a real install under IAPEER_TEST_SANDBOX', async () => {
    // fetchLatest injected (newer) so the gate proceeds to the DEFAULT installer,
    // which must refuse rather than fetch+build over the prod ~/.local/bin/iapeer.
    await expect(
      updateIapeer({
        env: { IAPEER_TEST_SANDBOX: '1' },
        currentVersion: '0.2.2',
        resolveVersion: () => '0.3.0',
        // runInstall NOT injected → exercises the real defaultRunInstall guard.
        restartDaemon: restarted,
      }),
    ).rejects.toThrow(/IAPEER_TEST_SANDBOX/)
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

describe('cascadeTail (FU12 — runtimes + memory + voice legs, best-effort)', () => {
  const cap = (): { out: (s: string) => void; text: () => string } => {
    const lines: string[] = []
    return { out: (s: string) => void lines.push(s), text: () => lines.join('') }
  }

  test('all green → not failed; renders per-component X→Y', async () => {
    const c = cap()
    const res = await cascadeTail({
      out: c.out,
      runtimes: async () => [
        { runtime: 'telegram', state: 'updated', from: '0.17.0', to: '0.18.0', peers: [], restarted: [{ personality: 'arthur', state: 'restarted' }] },
        { runtime: 'notifier', state: 'already-latest', from: '0.3.0', to: '0.3.0', peers: [], restarted: [] },
      ],
      memory: () => ({ state: 'updated', package: '@agfpd/iapeer-memory', from: '0.4.0', to: '0.4.1' }),
      voice: () => ({ state: 'updated', package: '@agfpd/voice-connect', from: '0.1.10', to: '0.1.11' }),
    })
    expect(res.failed).toBe(false)
    expect(c.text()).toContain('telegram: updated 0.17.0 → 0.18.0')
    expect(c.text()).toContain('memory: updated')
    expect(c.text()).toContain('voice: updated (@agfpd/voice-connect 0.1.10 → 0.1.11)')
  })

  test('a runtime install-failed → failed (still best-effort rendered, not aborted)', async () => {
    const res = await cascadeTail({
      out: () => {},
      runtimes: async () => [{ runtime: 'telegram', state: 'install-failed', peers: [], restarted: [] }],
      memory: () => ({ state: 'no-slot' }),
      voice: () => ({ state: 'no-slot' }),
    })
    expect(res.failed).toBe(true)
  })

  test('a restarted peer failed → failed', async () => {
    const res = await cascadeTail({
      out: () => {},
      runtimes: async () => [{ runtime: 'notifier', state: 'updated', peers: [], restarted: [{ personality: 'timer', state: 'failed' }] }],
      memory: () => ({ state: 'already-latest' }),
      voice: () => ({ state: 'already-latest' }),
    })
    expect(res.failed).toBe(true)
  })

  test('memory failed → failed; zero runtimes renders "(none installed)"', async () => {
    const c = cap()
    const res = await cascadeTail({ out: c.out, runtimes: async () => [], memory: () => ({ state: 'failed', detail: 'exited 1' }), voice: () => ({ state: 'no-slot' }) })
    expect(res.failed).toBe(true)
    expect(c.text()).toContain('(none installed)')
  })

  test('memory skipped-unavailable / no-slot are SOFT → not failed', async () => {
    const res = await cascadeTail({ out: () => {}, runtimes: async () => [], memory: () => ({ state: 'skipped-unavailable' }), voice: () => ({ state: 'no-slot' }) })
    expect(res.failed).toBe(false)
  })

  test('voice failed → failed (best-effort, rendered, never aborts the rest)', async () => {
    const c = cap()
    const res = await cascadeTail({ out: c.out, runtimes: async () => [], memory: () => ({ state: 'no-slot' }), voice: () => ({ state: 'failed', package: '@agfpd/voice-connect', from: '0.1.11', detail: 'exited 1' }) })
    expect(res.failed).toBe(true)
    expect(c.text()).toContain('voice: failed')
  })

  test('voice skipped-unavailable / no-slot are SOFT → not failed', async () => {
    expect((await cascadeTail({ out: () => {}, runtimes: async () => [], memory: () => ({ state: 'no-slot' }), voice: () => ({ state: 'skipped-unavailable' }) })).failed).toBe(false)
    expect((await cascadeTail({ out: () => {}, runtimes: async () => [], memory: () => ({ state: 'no-slot' }), voice: () => ({ state: 'no-slot' }) })).failed).toBe(false)
  })
})
