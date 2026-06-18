// Spawn-flip cutover Block 2, Ф0b-2 — host-aware warm delivery (`deliverWarm`).
//
// The warm-deliver path becomes host-aware: a supervisor-HOSTED target is delivered over its socket
// (Ф0a leaf) and CONFIRMED by the SAME final arbiter as the tmux busy path — a transcript-mtime
// advance, NOT the socket-ack. These suites cover the host branch hermetically (injected seams: a
// fake host-detect + host-deliver + a transcript-mtime proxy) so no live supervisor daemon is needed.
// The flag-off (tmux) routing is asserted by the host seam staying UNTOUCHED — the byte-identical
// guarantee that lets this ship dark.
import { afterEach, describe, expect, test } from 'bun:test'
import { deliverWarm, type DeliveryTarget, type WarmDeliverSeam } from './index.ts'

const hostedTarget: DeliveryTarget = {
  runtime: 'codex',
  personality: 'ptyx',
  address: 'codex-ptyx',
  socketPath: '/tmp/nonexistent-iap-test.sock',
}

const savedGrace = process.env.IAP_HOST_LIVENESS_GRACE_MS
afterEach(() => {
  if (savedGrace === undefined) delete process.env.IAP_HOST_LIVENESS_GRACE_MS
  else process.env.IAP_HOST_LIVENESS_GRACE_MS = savedGrace
})

describe('deliverWarm — flag-off (no live supervisor session) keeps the tmux path', () => {
  test('hostAlive=false → the host-deliver seam is NEVER touched (routes to deliverViaTmux)', async () => {
    let hostedCalls = 0
    const seam: WarmDeliverSeam = {
      hostAlive: () => false,
      deliverHosted: async () => {
        hostedCalls++
        return { ok: true }
      },
    }
    // The tmux path will fail against a bogus socket — but that is incidental; the contract under
    // test is that flag-off NEVER reaches the host branch. We assert the host seam stayed cold.
    await deliverWarm(hostedTarget, 'hi', '/tmp', seam)
    expect(hostedCalls).toBe(0)
  })
})

describe('deliverWarm — hosted target delivers over the socket + confirms by transcript advance', () => {
  test('socket deliver ok AND transcript advances → ok', async () => {
    let mtime = 100
    const seam: WarmDeliverSeam = {
      hostAlive: () => true,
      deliverHosted: async () => {
        mtime = 200 // the session took our message and started a model turn → transcript moved
        return { ok: true }
      },
      newestActivityMtime: () => mtime,
    }
    const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
    expect(r.ok).toBe(true)
  })

  test('socket-ack is NOT landed: deliver ok but NO transcript advance → loud fail (live but unresponsive)', async () => {
    process.env.IAP_HOST_LIVENESS_GRACE_MS = '0' // expire the HOST grace immediately — deterministic fail
    let hostedCalls = 0
    const seam: WarmDeliverSeam = {
      hostAlive: () => true,
      deliverHosted: async () => {
        hostedCalls++
        return { ok: true } // CR flushed to the socket — but the session never advanced
      },
      newestActivityMtime: () => 100, // constant → never advances past baseline
    }
    const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
    expect(hostedCalls).toBe(1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('no transcript advance')
  })

  test('socket deliver fails (socket dead/stalled) → loud fail, no false ok', async () => {
    const seam: WarmDeliverSeam = {
      hostAlive: () => true,
      deliverHosted: async () => ({ ok: false, error: 'socket dead during submit' }),
      newestActivityMtime: () => 100,
    }
    const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toContain('deliver failed')
      expect(r.error.message).toContain('socket dead')
    }
  })

  test('no cwd (direct caller, no activity proxy) → confirmed-only (socket-ack), no mtime probe', async () => {
    let mtimeProbes = 0
    const seam: WarmDeliverSeam = {
      hostAlive: () => true,
      deliverHosted: async () => ({ ok: true }),
      newestActivityMtime: () => {
        mtimeProbes++
        return 100
      },
    }
    const r = await deliverWarm(hostedTarget, 'task', undefined, seam)
    expect(r.ok).toBe(true)
    expect(mtimeProbes).toBe(0) // no cwd → the transcript proxy is never consulted
  })
})

// Cutover infra-track — a hosted ROUTER (telegram/notifier) has NO transcript proxy
// (adapter.newestActivityMtime=null), so the mtime-advance confirm a TUI uses can never be satisfied
// and would false-FAIL every router delivery. The host path confirms a router by the socket-ack —
// PARITY with deliverViaTmux's router C-j path (delivery-level confirm; router liveness is structural
// via launchd, not a model turn). These cases pin that behavior.
const routerTarget: DeliveryTarget = {
  runtime: 'notifier', // notifierAdapter.kind === 'router'
  personality: 'timer',
  address: 'notifier-timer',
  socketPath: '/tmp/nonexistent-iap-test.sock',
}

describe('deliverWarm — hosted ROUTER confirms by socket-ack (no transcript proxy)', () => {
  test('router deliver ok → ok EVEN THOUGH mtime never advances (the exact scenario a TUI fails on)', async () => {
    process.env.IAP_HOST_LIVENESS_GRACE_MS = '0' // a mtime-gated path would fail at once here
    const seam: WarmDeliverSeam = {
      hostAlive: () => true,
      deliverHosted: async () => ({ ok: true }),
      newestActivityMtime: () => 100, // constant — a router writes no transcript; a TUI here → loud fail
    }
    const r = await deliverWarm(routerTarget, '<iap>x</iap>', '/peer/cwd', seam)
    expect(r.ok).toBe(true) // socket-ack IS the confirm for a router; the non-advancing transcript is irrelevant
  })

  test('router socket deliver fails (dead/stalled) → loud fail, no false ok', async () => {
    const seam: WarmDeliverSeam = {
      hostAlive: () => true,
      deliverHosted: async () => ({ ok: false, error: 'socket dead during paste' }),
    }
    const r = await deliverWarm(routerTarget, '<iap>x</iap>', '/peer/cwd', seam)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('deliver failed')
  })
})
