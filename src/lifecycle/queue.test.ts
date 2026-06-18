// Ephemeral serial queue (M3) — FIFO primitives + the drain consumer.
// Retry semantics (boris acceptance (b)) are pinned here: a FAILED wake leaves
// the item at the head and the NEXT drain call retries the SAME task; only a
// READY wake consumes it. Strict FIFO order is asserted across drains.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import {
  drainAllEphemeralQueues,
  drainEphemeralQueue,
  enqueueEphemeralTask,
  ephemeralQueueDepth,
  ephemeralQueueDir,
  listQueuedIdentities,
  peekEphemeralTask,
  removeEphemeralTask,
  type LifecycleConfig,
  type WakeArgs,
  type WakeResult,
} from './index.ts'

const dirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-equeue-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function mkCfg(): LifecycleConfig {
  const root = mkTmp()
  return {
    stateDir: join(root, 'state'),
    sockDir: join(root, 'socks'),
    eventLogDir: join(root, 'logs'),
  } as LifecycleConfig
}

describe('ephemeral queue primitives (FIFO)', () => {
  test('enqueue returns depth; peek is non-destructive; remove consumes; strict FIFO', () => {
    const cfg = mkCfg()
    expect(ephemeralQueueDepth(cfg, 'claude-w')).toBe(0)
    expect(peekEphemeralTask(cfg, 'claude-w')).toBeNull()

    expect(enqueueEphemeralTask(cfg, 'claude-w', { task: 'first', topic: 't1' })).toBe(1)
    expect(enqueueEphemeralTask(cfg, 'claude-w', { task: 'second' })).toBe(2)
    expect(enqueueEphemeralTask(cfg, 'claude-w', { task: 'third', topic: 't3' })).toBe(3)

    const head = peekEphemeralTask(cfg, 'claude-w')
    expect(head?.task).toBe('first')
    expect(head?.topic).toBe('t1')
    expect(ephemeralQueueDepth(cfg, 'claude-w')).toBe(3) // peek did not consume

    removeEphemeralTask(cfg, 'claude-w', head!.seq)
    removeEphemeralTask(cfg, 'claude-w', head!.seq) // idempotent
    expect(ephemeralQueueDepth(cfg, 'claude-w')).toBe(2)
    expect(peekEphemeralTask(cfg, 'claude-w')?.task).toBe('second')
    expect(peekEphemeralTask(cfg, 'claude-w')?.topic).toBeUndefined()
  })

  test('enqueue skips taken seq names (exclusive-create) — no overwrite of a pending task', () => {
    const cfg = mkCfg()
    enqueueEphemeralTask(cfg, 'claude-w', { task: 'one' })
    // simulate a competitor that already claimed the next seq
    writeFileSync(join(ephemeralQueueDir(cfg, 'claude-w'), '000002'), JSON.stringify({ task: 'competitor' }))
    expect(enqueueEphemeralTask(cfg, 'claude-w', { task: 'three' })).toBe(3)
    // all three distinct tasks live side-by-side
    const dir = ephemeralQueueDir(cfg, 'claude-w')
    expect(JSON.parse(readFileSync(join(dir, '000002'), 'utf8')).task).toBe('competitor')
    expect(JSON.parse(readFileSync(join(dir, '000003'), 'utf8')).task).toBe('three')
  })

  test('a poison head (corrupt JSON) is dropped, not wedging the queue', () => {
    const cfg = mkCfg()
    mkdirSync(ephemeralQueueDir(cfg, 'claude-w'), { recursive: true })
    writeFileSync(join(ephemeralQueueDir(cfg, 'claude-w'), '000001'), 'NOT JSON {{{')
    enqueueEphemeralTask(cfg, 'claude-w', { task: 'good' })
    const head = peekEphemeralTask(cfg, 'claude-w')
    expect(head?.task).toBe('good')
    expect(ephemeralQueueDepth(cfg, 'claude-w')).toBe(1) // poison slot dropped
  })

  test('listQueuedIdentities: only non-empty queues, sorted', () => {
    const cfg = mkCfg()
    enqueueEphemeralTask(cfg, 'claude-b', { task: 'x' })
    enqueueEphemeralTask(cfg, 'claude-a', { task: 'y' })
    mkdirSync(ephemeralQueueDir(cfg, 'claude-empty'), { recursive: true }) // empty dir → excluded
    expect(listQueuedIdentities(cfg)).toEqual(['claude-a', 'claude-b'])
  })
})

describe('drainEphemeralQueue (peek → wake → rm-on-READY)', () => {
  function fakeWake(
    script: Array<'READY' | 'FAILED'>,
    calls: WakeArgs[],
  ): (args: WakeArgs) => Promise<WakeResult> {
    return async args => {
      calls.push(args)
      const status = script[Math.min(calls.length - 1, script.length - 1)]!
      return { status, woke: status === 'READY', runtime: 'claude' }
    }
  }

  test('empty queue → null, wake NOT called', async () => {
    const cfg = mkCfg()
    const calls: WakeArgs[] = []
    expect(await drainEphemeralQueue(cfg, 'w', 'claude', { wakeFn: fakeWake(['READY'], calls) })).toBeNull()
    expect(calls).toEqual([])
  })

  test('READY consumes the head; successive drains feed tasks in STRICT FIFO order', async () => {
    const cfg = mkCfg()
    enqueueEphemeralTask(cfg, 'claude-w', { task: 'task-A', topic: 'ta' })
    enqueueEphemeralTask(cfg, 'claude-w', { task: 'task-B' })
    const calls: WakeArgs[] = []
    const deps = { wakeFn: fakeWake(['READY'], calls) }

    expect((await drainEphemeralQueue(cfg, 'w', 'claude', deps))?.status).toBe('READY')
    expect(calls[0]).toMatchObject({ personality: 'w', runtime: 'claude', task: 'task-A', topic: 'ta' })
    expect(ephemeralQueueDepth(cfg, 'claude-w')).toBe(1) // A consumed

    expect((await drainEphemeralQueue(cfg, 'w', 'claude', deps))?.status).toBe('READY')
    expect(calls[1]).toMatchObject({ task: 'task-B' }) // FIFO: B strictly after A
    expect(ephemeralQueueDepth(cfg, 'claude-w')).toBe(0)
    expect(await drainEphemeralQueue(cfg, 'w', 'claude', deps)).toBeNull() // drained dry

    // durable drain trace (acceptance (a)): ev=ephemeral-drain with depth
    const logged = readFileSync(join(cfg.eventLogDir, 'lifecycle.log'), 'utf8')
    expect(logged).toContain('ev=ephemeral-drain')
    expect(logged).toContain('identity=claude-w')
    expect(logged).toContain('depth=2')
  })

  test('FAILED wake LEAVES the item at the head — the next drain RETRIES the same task (acceptance (b))', async () => {
    const cfg = mkCfg()
    enqueueEphemeralTask(cfg, 'claude-w', { task: 'flaky-task' })
    const calls: WakeArgs[] = []
    const deps = { wakeFn: fakeWake(['FAILED', 'READY'], calls) }

    expect((await drainEphemeralQueue(cfg, 'w', 'claude', deps))?.status).toBe('FAILED')
    expect(ephemeralQueueDepth(cfg, 'claude-w')).toBe(1) // NOT consumed on failure

    expect((await drainEphemeralQueue(cfg, 'w', 'claude', deps))?.status).toBe('READY')
    expect(calls.length).toBe(2)
    expect(calls[1]?.task).toBe('flaky-task') // the SAME task, retried
    expect(ephemeralQueueDepth(cfg, 'claude-w')).toBe(0)
  })

  const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0
  test.if(tmuxAvailable)('a LIVE session blocks the drain (one task per session invariant)', async () => {
    const cfg = mkCfg()
    mkdirSync(cfg.sockDir, { recursive: true })
    const sock = join(cfg.sockDir, 'tmux-iap-claude-w.sock')
    enqueueEphemeralTask(cfg, 'claude-w', { task: 'queued-while-busy' })
    const calls: WakeArgs[] = []
    try {
      spawnSync('tmux', ['-S', sock, 'new-session', '-d', '-s', 'claude-w', 'sleep', '60'])
      expect(await drainEphemeralQueue(cfg, 'w', 'claude', { wakeFn: fakeWake(['READY'], calls) })).toBeNull()
      expect(calls).toEqual([]) // no wake while the session lives
      expect(ephemeralQueueDepth(cfg, 'claude-w')).toBe(1) // task waits for the reap
    } finally {
      spawnSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' })
    }
  })

  test('drainAllEphemeralQueues: scans every queued identity, H4-skips launchd-managed', async () => {
    const cfg = mkCfg()
    const laDir = mkTmp()
    const env = { ...process.env, IAPEER_LAUNCHAGENTS_DIR: laDir } as NodeJS.ProcessEnv
    enqueueEphemeralTask(cfg, 'claude-free', { task: 'x' })
    enqueueEphemeralTask(cfg, 'claude-held', { task: 'y' })
    writeFileSync(join(laDir, 'com.iapeer.held.plist'), '') // 'held' is launchd-managed
    const calls: WakeArgs[] = []
    const results = await drainAllEphemeralQueues(cfg, { env, wakeFn: fakeWake(['READY'], calls) })
    expect(results.length).toBe(1)
    expect(calls.map(c => c.personality)).toEqual(['free']) // held NEVER woken (H4)
    expect(ephemeralQueueDepth(cfg, 'claude-free')).toBe(0)
    expect(ephemeralQueueDepth(cfg, 'claude-held')).toBe(1) // untouched
  })
})
