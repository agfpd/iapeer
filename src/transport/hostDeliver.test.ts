// Spawn-flip cutover Block 2, Ф0b-2 — host-aware warm delivery (`deliverWarm`).
//
// The warm-deliver path is host-aware: a supervisor-HOSTED target is delivered over its socket
// (Ф0a leaf) and CONFIRMED by a landed-proxy advance, NOT the socket-ack. The landed-confirm accepts
// EITHER of two proxies: the transcript/session-jsonl mtime (the strong "model wrote a turn" signal)
// OR the PANE-LOG (TUI render-stream) mtime (ticks ~1s as the session renders the working state on
// submit). The second proxy gives CODEX delivery parity: codex writes its session jsonl only at
// model-turn-start (~4-6s, past the grace), so the transcript-ONLY confirm structurally false-FAILED
// every codex delivery; the pane-log catches it in ~1s.
//
// Hermetic: both proxies are injected seams (no live supervisor, no host fs). Routers (no transcript
// proxy) confirm by the socket-ack.
import { describe, expect, test } from 'bun:test'
import { deliverWarm, resolveLiveRuntime, type DeliveryTarget, type WarmDeliverSeam } from './index.ts'

const hostedTarget: DeliveryTarget = {
  runtime: 'codex',
  personality: 'ptyx',
  address: 'codex-ptyx',
  socketPath: '/tmp/nonexistent-iap-test.sock',
}

describe('deliverWarm — hosted target confirms by EITHER transcript OR pane-log advance', () => {
  test('socket deliver ok AND transcript advances → ok', async () => {
    let mtime = 100
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => {
        mtime = 200 // the session took our message and started a model turn → transcript moved
        return { ok: true }
      },
      newestActivityMtime: () => mtime,
      paneLogMtime: () => 100, // pane-log flat — the transcript advance alone confirms
    }
    const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
    expect(r.ok).toBe(true)
  })

  test('CODEX PARITY: transcript NEVER advances but the pane-log DOES → ok (the codex fix)', async () => {
    // The exact codex shape: the session jsonl does not advance within the grace (model-turn-start
    // latency), but the pane-log ticks ~1s as codex renders the working state on submit.
    let pane = 100
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => {
        pane = 200 // codex rendered the working state in response to our bytes
        return { ok: true }
      },
      newestActivityMtime: () => 100, // session jsonl flat within the grace (codex TTFT > grace)
      paneLogMtime: () => pane,
    }
    const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
    expect(r.ok).toBe(true)
  })

  test('NEITHER proxy advances → loud fail (live but unresponsive); message NOT delivered', async () => {
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => ({ ok: true }), // CR flushed — but the session never reacted
      newestActivityMtime: () => 100, // constant
      paneLogMtime: () => 100, // constant — neither advances past baseline
    }
    // grace via the seam-driven loop: with both proxies flat the loop runs to the grace deadline.
    const prev = process.env.IAP_HOST_LIVENESS_GRACE_MS
    process.env.IAP_HOST_LIVENESS_GRACE_MS = '0' // expire immediately — deterministic fail
    try {
      const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.message).toContain('no transcript or pane-log advance')
    } finally {
      if (prev === undefined) delete process.env.IAP_HOST_LIVENESS_GRACE_MS
      else process.env.IAP_HOST_LIVENESS_GRACE_MS = prev
    }
  })

  test('socket deliver fails (socket dead/stalled) → loud fail, no false ok', async () => {
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => ({ ok: false, error: 'socket dead during submit' }),
      newestActivityMtime: () => 100,
      paneLogMtime: () => 100,
    }
    const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toContain('deliver failed')
      expect(r.error.message).toContain('socket dead')
    }
  })

  test('no cwd (direct caller, no activity proxy) → confirmed-only (socket-ack), no transcript probe', async () => {
    let mtimeProbes = 0
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => ({ ok: true }),
      newestActivityMtime: () => {
        mtimeProbes++
        return 100
      },
      paneLogMtime: () => 100,
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

describe('deliverWarm — hosted ROUTER confirms by socket-ack (no transcript/pane-log proxy)', () => {
  test('router deliver ok → ok EVEN THOUGH neither proxy advances (the exact scenario a TUI fails on)', async () => {
    const prev = process.env.IAP_HOST_LIVENESS_GRACE_MS
    process.env.IAP_HOST_LIVENESS_GRACE_MS = '0' // a proxy-gated path would fail at once here
    try {
      const seam: WarmDeliverSeam = {
        deliverHosted: async () => ({ ok: true }),
        newestActivityMtime: () => 100, // constant — a router writes no transcript
        paneLogMtime: () => 100, // constant — irrelevant for a router (socket-ack confirms)
      }
      const r = await deliverWarm(routerTarget, '<iap>x</iap>', '/peer/cwd', seam)
      expect(r.ok).toBe(true) // socket-ack IS the confirm for a router; non-advancing proxies irrelevant
    } finally {
      if (prev === undefined) delete process.env.IAP_HOST_LIVENESS_GRACE_MS
      else process.env.IAP_HOST_LIVENESS_GRACE_MS = prev
    }
  })

  test('router socket deliver fails (dead/stalled) → loud fail, no false ok', async () => {
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => ({ ok: false, error: 'socket dead during paste' }),
    }
    const r = await deliverWarm(routerTarget, '<iap>x</iap>', '/peer/cwd', seam)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('deliver failed')
  })
})

// resolveLiveRuntime — the AUTHORITATIVE current live runtime (freshest pane-log among the
// PID-alive supervisor sessions), the signal external packages (telegram-runtime typing)
// must use instead of default_runtime / a lingering .session. Deps injected for hermeticity.
describe('resolveLiveRuntime — freshest pane-log among pid-alive sessions', () => {
  test('no alive session → null', () => {
    expect(resolveLiveRuntime('p', { aliveRuntimes: () => [] })).toBeNull()
  })

  test('exactly one alive → that runtime (pane-log not even consulted)', () => {
    let probes = 0
    const rt = resolveLiveRuntime('p', { aliveRuntimes: () => ['codex'], paneLogMtime: () => (probes++, 1) })
    expect(rt).toBe('codex')
    expect(probes).toBe(0)
  })

  test('multiple alive (a /codex flip left both) → the freshest pane-log = the active surface', () => {
    const mt: Record<string, number> = { 'claude-p': 100, 'codex-p': 200 }
    expect(resolveLiveRuntime('p', { aliveRuntimes: () => ['claude', 'codex'], paneLogMtime: a => mt[a] ?? 0 })).toBe('codex')
    // freshness flips → the resolver follows the active surface
    mt['claude-p'] = 300
    expect(resolveLiveRuntime('p', { aliveRuntimes: () => ['claude', 'codex'], paneLogMtime: a => mt[a] ?? 0 })).toBe('claude')
  })

  test('a dead runtime is EXCLUDED even if its pane-log is freshest (the flip-race fix)', () => {
    // codex just died (not in the alive set) but its pane-log is the freshest (lingers);
    // claude is the only ALIVE one → resolver returns claude, NOT the stale-fresh codex.
    const mt: Record<string, number> = { 'claude-p': 100, 'codex-p': 999 }
    expect(resolveLiveRuntime('p', { aliveRuntimes: () => ['claude'], paneLogMtime: a => mt[a] ?? 0 })).toBe('claude')
  })
})
