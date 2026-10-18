// Operator STOP = the peer stops in EVERY live runtime (Artur 18.10). Hermetic: the live-endpoint
// listing and the per-endpoint control are seams; the real Escape/abort per runtime is covered by
// hostControl.test.ts and proven live.
import { describe, expect, test } from 'bun:test'
import { interruptAllLive } from './index.ts'
import { ok, err } from '../core/errors.ts'

const live = () => [
  { personality: 'p', runtime: 'claude' },
  { personality: 'p', runtime: 'opencode' },
  { personality: 'other', runtime: 'claude' },
]

describe('interrupt without a runtime — every live endpoint, in parallel', () => {
  test('both live runtimes are interrupted; another peer is untouched; the calls overlap (parallel)', async () => {
    const hit: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const r = await interruptAllLive('p', { name: 'interrupt' }, {
      live,
      exec: (async (t: { address: string }) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(res => setTimeout(res, 20))
        hit.push(t.address)
        inFlight--
        return ok(undefined)
      }) as never,
    })
    expect(r.ok).toBe(true)
    expect(hit.sort()).toEqual(['claude-p', 'opencode-p'])
    expect(maxInFlight).toBe(2)
    if (r.ok) expect(r.value.controlledAll?.map(c => c.runtime)).toEqual(['claude', 'opencode'])
  })
  test('partial failure: the others are still interrupted and the failure is reported', async () => {
    const r = await interruptAllLive('p', { name: 'interrupt' }, {
      live,
      exec: (async (t: { runtime: string }) => (t.runtime === 'opencode' ? err('abort failed') : ok(undefined))) as never,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.controlledAll?.map(c => c.runtime)).toEqual(['claude'])
      expect(r.value.failed).toEqual([{ runtime: 'opencode', error: 'abort failed' }])
    }
  })
  test('nothing live → the usual offline error (telegram-runtime keys on /offline/)', async () => {
    const r = await interruptAllLive('nobody', { name: 'interrupt' }, { live, exec: (async () => ok(undefined)) as never })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/offline/)
  })
})
