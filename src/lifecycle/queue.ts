// Ephemeral serial queue (wake_policy:"ephemeral" M3) — per-peer disk FIFO of
// pending tasks for a stateless worker. Deliveries to an ephemeral target are
// NEVER injected into a live session (one task = one clean context window =
// the whole point of the policy); they are ALWAYS enqueued here, and the drain
// (drainEphemeralQueue in index.ts) feeds the worker one task per fresh session.
//
// Layout: `<stateDir>/<identity>.queue/<seq>` — one JSON file per task
// ({ task, topic? }), zero-padded numeric names so lexicographic order IS the
// FIFO order. Durable by construction: the queue survives a daemon restart and
// is drained by the supervise tick (the same scan that retries a failed wake).
//
// Concurrency: the daemon is the main writer, but a direct CLI `iap send`
// (daemon down) can race it from another process. Enqueue is therefore
// EXCLUSIVE-CREATE: write a temp file, then linkSync it to the next seq —
// linkSync fails with EEXIST on a taken name (atomic on POSIX), so two
// concurrent enqueues can never share a seq; the loser just advances. Content
// is complete before the link lands (no partial reads).
//
// Retry semantics: the consumer PEEKS (reads without
// removing), wakes the worker, and removes the item ONLY on READY — a failed
// wake leaves the task at the head for the next supervise-tick drain. See
// drainEphemeralQueue.

import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { LifecycleConfig } from './index.ts'

/** One queued task for an ephemeral worker. */
export interface EphemeralQueueItem {
  /** The routed envelope — becomes the boot first-message of the fresh session. */
  task: string
  /** Optional topic (threading; recorded by the wake as the session topic). */
  topic?: string
}

/** A peeked item: the queue position (for the later remove) plus the payload. */
export interface PeekedQueueItem extends EphemeralQueueItem {
  seq: string
}

export function ephemeralQueueDir(cfg: LifecycleConfig, identity: string): string {
  return join(cfg.stateDir, `${identity}.queue`)
}

const SEQ_PAD = 6

function listSeqs(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return [] // no dir yet → empty queue
  }
  // Only the numbered items — temp files (.tmp-*) and strays are not queue entries.
  return entries.filter(name => /^\d+$/.test(name)).sort()
}

/** Queue depth (pending tasks). 0 for a missing dir. */
export function ephemeralQueueDepth(cfg: LifecycleConfig, identity: string): number {
  return listSeqs(ephemeralQueueDir(cfg, identity)).length
}

/**
 * Append a task to the identity's FIFO. Returns the depth AFTER the append
 * (≥1 — usable as the "qd" observability field). Exclusive-create: safe against
 * a concurrent enqueue from another process. Throws only on a real FS failure
 * (the caller surfaces it as a delivery error — an un-enqueued task must NOT be
 * reported queued).
 */
export function enqueueEphemeralTask(
  cfg: LifecycleConfig,
  identity: string,
  item: EphemeralQueueItem,
): number {
  const dir = ephemeralQueueDir(cfg, identity)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  writeFileSync(tmp, JSON.stringify({ task: item.task, ...(item.topic ? { topic: item.topic } : {}) }), {
    mode: 0o600,
  })
  try {
    // Next seq = max existing + 1; on an EEXIST race, advance and retry.
    let seq = (() => {
      const seqs = listSeqs(dir)
      return seqs.length ? parseInt(seqs[seqs.length - 1]!, 10) + 1 : 1
    })()
    // Bounded retry: a competitor can win a name at most once per its own enqueue.
    for (let attempt = 0; attempt < 1000; attempt++, seq++) {
      const target = join(dir, String(seq).padStart(SEQ_PAD, '0'))
      try {
        linkSync(tmp, target) // atomic exclusive-create (EEXIST when taken)
        return listSeqs(dir).length
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
    }
    throw new Error(`ephemeral queue enqueue: could not claim a seq for ${identity} after 1000 attempts`)
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* already gone */
    }
  }
}

/**
 * Read the HEAD of the FIFO without removing it (retry semantics: the item is
 * removed only after the wake went READY — removeEphemeralTask). null on empty.
 * A corrupt head (unparseable JSON) is dropped with its slot — a poison task
 * must not wedge the whole queue — and the next item (if any) is returned.
 */
export function peekEphemeralTask(cfg: LifecycleConfig, identity: string): PeekedQueueItem | null {
  const dir = ephemeralQueueDir(cfg, identity)
  for (const seq of listSeqs(dir)) {
    const path = join(dir, seq)
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      if (typeof raw.task === 'string' && raw.task.length > 0) {
        return { seq, task: raw.task, topic: typeof raw.topic === 'string' ? raw.topic : undefined }
      }
    } catch {
      /* unreadable/corrupt → drop the slot below */
    }
    try {
      rmSync(path, { force: true }) // poison/corrupt item: drop, do not wedge the queue
    } catch {
      return null // cannot even drop it — give up this round, retry next tick
    }
  }
  return null
}

/** Remove a consumed item (after its wake went READY). Idempotent. */
export function removeEphemeralTask(cfg: LifecycleConfig, identity: string, seq: string): void {
  try {
    rmSync(join(ephemeralQueueDir(cfg, identity), seq), { force: true })
  } catch {
    /* already gone */
  }
}

/** Identities with a non-empty queue (the supervise-tick drain scan; also the
 *  drain-on-start surface — the queue is durable across daemon restarts). */
export function listQueuedIdentities(cfg: LifecycleConfig): string[] {
  let entries: string[]
  try {
    entries = readdirSync(cfg.stateDir)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of entries) {
    if (!name.endsWith('.queue')) continue
    const identity = name.slice(0, -'.queue'.length)
    if (listSeqs(join(cfg.stateDir, name)).length > 0) out.push(identity)
  }
  return out.sort()
}
