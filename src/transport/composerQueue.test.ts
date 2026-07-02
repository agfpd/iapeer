import { describe, expect, test } from 'bun:test'
import { ok } from '../core/errors.ts'
import { getAdapter } from '../launch/index.ts'
import type { PeerRecord } from '../registry/index.ts'
import type { ResolvedCaller } from '../identity/index.ts'
import {
  createComposerDeliveryQueue,
  type ComposerQueueTryEnqueueArgs,
  type DeliveryTarget,
} from './index.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const callerRecord = {
  personality: 'sender',
  runtime: 'codex',
  runtimes: ['codex'],
  description: '',
  intelligence: 'artificial',
  cwd: '/tmp/sender',
} as unknown as PeerRecord
const caller: ResolvedCaller = {
  personality: 'sender',
  runtime: 'codex',
  address: 'codex-sender',
  description: '',
  intelligence: 'artificial',
  cwd: '/tmp/sender',
  record: callerRecord,
}
const peer = {
  personality: 'target',
  runtime: 'codex',
  runtimes: ['codex'],
  description: '',
  intelligence: 'artificial',
  cwd: '/tmp/target',
} as unknown as PeerRecord
const target: DeliveryTarget = {
  personality: 'target',
  runtime: 'codex',
  address: 'codex-target',
  socketPath: '/tmp/no-such-sock',
}
function args(envelope = '<iap>hello</iap>'): ComposerQueueTryEnqueueArgs {
  return { caller, peer, target, envelope, topic: 'q-test' }
}

describe('createComposerDeliveryQueue', () => {
  test('queued ack is immediate; drain waits until composer clears, then delivers silently', async () => {
    let held = true
    const delivered: string[] = []
    const failed: string[] = []
    const q = createComposerDeliveryQueue({
      pollMs: 5,
      forceTimeoutMs: 1000,
      shouldQueue: () => true,
      hasHumanInput: () => held,
      sessionToken: () => 'session-1:pane-1',
      sessionAlive: () => true,
      deliver: (_target, envelope) => {
        delivered.push(envelope)
        return ok(undefined)
      },
      notifyFailed: (_job, reason) => { failed.push(reason) },
    })

    const accepted = await q.tryEnqueue(args('first'))
    expect(accepted?.ok).toBe(true)
    if (!accepted?.ok) return
    expect(accepted.value).toMatchObject({ queued: true, queuedBy: 'composer', queueDepth: 1 })
    await sleep(20)
    expect(delivered).toEqual([])
    held = false
    await sleep(30)
    expect(delivered).toEqual(['first'])
    expect(failed).toEqual([])
  })

  test('120s ceiling (env-tunable in tests) force-delivers instead of waiting forever', async () => {
    const delivered: string[] = []
    const failed: string[] = []
    const q = createComposerDeliveryQueue({
      pollMs: 5,
      forceTimeoutMs: 20,
      shouldQueue: () => true,
      hasHumanInput: () => true,
      sessionToken: () => 'session-1:pane-1',
      sessionAlive: () => true,
      deliver: (_target, envelope) => {
        delivered.push(envelope)
        return ok(undefined)
      },
      notifyFailed: (_job, reason) => { failed.push(reason) },
    })

    await q.tryEnqueue(args('force-me'))
    await sleep(70)
    expect(delivered).toEqual(['force-me'])
    expect(failed).toEqual([])
  })

  test('target death/session replacement fails the queued sender instead of delivering to a corpse/new session', async () => {
    let alive = true
    const delivered: string[] = []
    const failed: string[] = []
    const q = createComposerDeliveryQueue({
      pollMs: 5,
      forceTimeoutMs: 1000,
      shouldQueue: () => true,
      hasHumanInput: () => true,
      sessionToken: () => 'session-1:pane-1',
      sessionAlive: () => alive,
      deliver: (_target, envelope) => {
        delivered.push(envelope)
        return ok(undefined)
      },
      notifyFailed: (_job, reason) => { failed.push(reason) },
    })

    await q.tryEnqueue(args('must-fail'))
    alive = false
    await sleep(30)
    expect(delivered).toEqual([])
    expect(failed.join('\n')).toMatch(/vanished|replaced/)
  })

  test('async-correctness: concurrent enqueue with ASYNC predicates → each delivered exactly once, no dup/loss (Ф0b-3 3c-2)', async () => {
    // The host-aware refactor makes shouldQueue/hasHumanInput/deliver awaitable. Inject ASYNC seams
    // (a real yield window) and fire concurrent enqueues — the FIFO + per-identity drain guard must
    // still deliver each envelope EXACTLY once (no race-doubled, no race-lost).
    let held = true
    const delivered: string[] = []
    const q = createComposerDeliveryQueue({
      pollMs: 5,
      forceTimeoutMs: 2000,
      shouldQueue: async () => { await sleep(4); return true },
      hasHumanInput: async () => { await sleep(2); return held },
      sessionToken: () => 'session-1:pane-1',
      sessionAlive: () => true,
      deliver: async (_target, envelope) => { await sleep(1); delivered.push(envelope); return ok(undefined) },
      notifyFailed: () => { /* */ },
    })

    const acks = await Promise.all([
      q.tryEnqueue(args('msg-A')),
      q.tryEnqueue(args('msg-B')),
      q.tryEnqueue(args('msg-C')),
    ])
    expect(acks.every(a => a?.ok)).toBe(true)
    await sleep(40)
    expect(delivered).toEqual([]) // all three held while busy
    held = false
    await sleep(80)
    expect(delivered.slice().sort()).toEqual(['msg-A', 'msg-B', 'msg-C']) // each ONCE — no dup, no loss
  })

  test('daemon close/restart failAll re-fails every queued-but-undelivered envelope', async () => {
    const delivered: string[] = []
    const failed: string[] = []
    const q = createComposerDeliveryQueue({
      pollMs: 50,
      forceTimeoutMs: 1000,
      shouldQueue: () => true,
      hasHumanInput: () => true,
      sessionToken: () => 'session-1:pane-1',
      sessionAlive: () => true,
      deliver: (_target, envelope) => {
        delivered.push(envelope)
        return ok(undefined)
      },
      notifyFailed: (_job, reason) => { failed.push(reason) },
    })

    await q.tryEnqueue(args('queued-a'))
    await q.tryEnqueue(args('queued-b'))
    await q.failAll?.('daemon shutting down/restarting before queued delivery completed')
    await sleep(10)
    expect(delivered).toEqual([])
    expect(failed).toEqual([
      'daemon shutting down/restarting before queued delivery completed',
      'daemon shutting down/restarting before queued delivery completed',
    ])
  })

  test('В8: failAll during an IN-FLIGHT deliver does NOT double-handle (no deliver+fail dup)', async () => {
    const delivered: string[] = []
    const failed: string[] = []
    let releaseDeliver!: () => void
    const gate = new Promise<void>(r => { releaseDeliver = r })
    const q = createComposerDeliveryQueue({
      pollMs: 5,
      forceTimeoutMs: 1000,
      shouldQueue: () => true,
      hasHumanInput: () => false, // composer clear → drain goes straight to deliver
      sessionToken: () => 'session-1:pane-1',
      sessionAlive: () => true,
      deliver: async (_t, envelope) => {
        await gate // hold the job IN-FLIGHT while failAll runs
        delivered.push(envelope)
        return ok(undefined)
      },
      notifyFailed: (_job, reason) => { failed.push(reason) },
    })

    await q.tryEnqueue(args('in-flight'))
    await sleep(20) // drain has shifted the head out and is awaiting deliver
    const failAllP = q.failAll?.('daemon shutting down') // snapshot must NOT include the in-flight job
    releaseDeliver() // deliver now completes
    await failAllP
    await sleep(20)
    expect(delivered).toEqual(['in-flight']) // delivered exactly ONCE
    expect(failed).toEqual([]) // and NOT also failed — no dup, no false failure
  })

  test('В9: back-to-back enqueues all drain — no job stranded by the kick/drain teardown window', async () => {
    const delivered: string[] = []
    const q = createComposerDeliveryQueue({
      pollMs: 5,
      forceTimeoutMs: 1000,
      shouldQueue: () => true,
      hasHumanInput: () => false, // each drains immediately, emptying the queue between enqueues
      sessionToken: () => 'session-1:pane-1',
      sessionAlive: () => true,
      deliver: async (_t, envelope) => {
        delivered.push(envelope)
        return ok(undefined)
      },
      notifyFailed: () => {},
    })

    // enqueue with tiny gaps so some land in the drain-return→finally window (kick would no-op there
    // without the re-kick); every one must still be delivered.
    for (let i = 0; i < 6; i++) {
      await q.tryEnqueue(args(`m${i}`))
      await sleep(1)
    }
    await sleep(60)
    expect([...delivered].sort()).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5'])
  })
})
