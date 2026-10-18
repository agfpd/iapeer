// Inflight ledger — the core's record of CONFIRMED deliveries a receiving session has not yet
// PROCESSED (docs/20 OC07; invariant: an inbound the core acknowledged is either processed by a later
// session or its sender is told explicitly it was not). A runtime's own input queue lives in its
// process: a session that dies (crash, SIGKILL, operator kill) before answering a queued message
// takes it along, and a fresh next session never sees it. The ledger survives that death.
//
// Lifecycle of an entry: written at delivery (transport → noteInflight) → pruned once the session
// answered it (transport.deliveryProcessed) → when the receiving session is gone (or replaced) while
// the entry is unprocessed, moved to the identity's ORPHANS → the daemon redelivers orphans through
// the normal route, or notifies the sender when that fails.
//
// Files under cfg.stateDir: `<identity>.inflight.jsonl` (append) and `<identity>.orphans.jsonl`.
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface InflightEntry {
  id: string
  /** Epoch ms of the confirmed delivery. */
  ts: number
  /** Wire sentAt of the original envelope (shown on redelivery). */
  sentAt: string
  /** Receiving endpoint. */
  identity: string
  personality: string
  runtime: string
  cwd: string
  /** Hosting session token at delivery (supervisor pid) — a different/absent token = that session is gone. */
  sessionToken: string | null
  caller: { personality: string; runtime: string }
  message: string
  topic?: string
  attachments?: string[]
  /** The presented envelope (what the model sees) — the processed-check needle source. */
  rendered: string
  /** The live confirm window ran out at delivery: whether it LANDED is still unknown. */
  unconfirmed?: true
}

/** How long an unconfirmed delivery may stay unlanded in a live session before the ledger treats the
 *  paste as swallowed and redelivers it (once). Generous: a busy receiver records a queued message late. */
export const UNLANDED_AFTER_MS = 120_000

const inflightPath = (stateDir: string, identity: string) => join(stateDir, `${identity}.inflight.jsonl`)
const orphansPath = (stateDir: string, identity: string) => join(stateDir, `${identity}.orphans.jsonl`)
const interruptedPath = (stateDir: string, identity: string) => join(stateDir, `${identity}.interrupted.jsonl`)

function readJsonl(path: string): InflightEntry[] {
  if (!existsSync(path)) return []
  const out: InflightEntry[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as InflightEntry)
    } catch {
      /* a torn line is skipped, never fatal */
    }
  }
  return out
}

function writeJsonl(path: string, entries: InflightEntry[]): void {
  if (entries.length === 0) {
    rmSync(path, { force: true })
    return
  }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, entries.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function recordInflight(stateDir: string, entry: InflightEntry): void {
  appendFileSync(inflightPath(stateDir, entry.identity), JSON.stringify(entry) + '\n', { mode: 0o600 })
}

export function listInflightIdentities(stateDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(stateDir)
  } catch {
    return []
  }
  return names.filter(n => n.endsWith('.inflight.jsonl')).map(n => n.slice(0, -'.inflight.jsonl'.length))
}

export function readInflight(stateDir: string, identity: string): InflightEntry[] {
  return readJsonl(inflightPath(stateDir, identity))
}

export interface InflightSweepDeps {
  /** Current hosting token of the identity's session (null = no live session). */
  sessionToken: (identity: string) => string | null
  /** Did the receiving session answer this entry? */
  processed: (entry: InflightEntry) => boolean
  /** Did the turn this entry started FINISH? Absent → processed counts as finished (legacy). */
  completed?: (entry: InflightEntry) => boolean
  /** Did the entry land in the session at all? Only consulted for `unconfirmed` entries. */
  landed?: (entry: InflightEntry) => boolean
  now?: number
}

/**
 * One pass over an identity's ledger: drop processed entries; entries whose receiving session is
 * gone or was replaced (token differs) and that are still unprocessed move to ORPHANS. Entries of the
 * still-live session that are unprocessed stay. Returns the number orphaned.
 */
export function sweepInflight(stateDir: string, identity: string, deps: InflightSweepDeps): number {
  const entries = readInflight(stateDir, identity)
  if (entries.length === 0) return 0
  const current = deps.sessionToken(identity)
  const keep: InflightEntry[] = []
  const orphaned: InflightEntry[] = []
  const interrupted: InflightEntry[] = []
  const safe = (f: ((e: InflightEntry) => boolean) | undefined, e: InflightEntry, dflt: boolean): boolean => {
    if (!f) return dflt
    try {
      return f(e)
    } catch {
      return false
    }
  }
  // A session works its input in order: a FINISHED turn for a later message means every earlier one
  // OF THE SAME SESSION was handled too (bounds the ledger when a turn-end record is missed). Strictly
  // per session token: a turn finished in a NEW session says nothing about a dead session's queue —
  // that cross-session shortcut silently dropped A and B in 0.4.122 (linus OC07 regression).
  const finishedUpTo = new Map<string, number>()
  const finished = new Set<string>()
  const sessionKey = (e: InflightEntry) => e.sessionToken ?? '∅'
  for (const e of entries) {
    if (safe(deps.completed, e, false) || (!deps.completed && safe(deps.processed, e, false))) {
      finished.add(e.id)
      finishedUpTo.set(sessionKey(e), Math.max(finishedUpTo.get(sessionKey(e)) ?? -Infinity, e.ts))
    }
  }
  for (const e of entries) {
    if (finished.has(e.id) || e.ts < (finishedUpTo.get(sessionKey(e)) ?? -Infinity)) continue
    const done = safe(deps.processed, e, false)
    if (done) {
      // Answered but its turn did not finish: live → still working; gone → INTERRUPTED (side effects
      // may have happened — never redelivered, the sender is told).
      if (current !== null && current === e.sessionToken) keep.push(e)
      else interrupted.push(e)
      continue
    }
    if (current !== null && current === e.sessionToken) {
      // Unknown landing (confirm window ran out): once seen in the session it is a normal pending entry;
      // still unseen after UNLANDED_AFTER_MS → the paste was swallowed → orphan (redeliver once).
      if (e.unconfirmed && deps.landed) {
        let landed = false
        try {
          landed = deps.landed(e)
        } catch {
          landed = false
        }
        if (landed) keep.push({ ...e, unconfirmed: undefined })
        else if ((deps.now ?? Date.now()) - e.ts > UNLANDED_AFTER_MS) orphaned.push(e)
        else keep.push(e)
        continue
      }
      keep.push(e)
    } else orphaned.push(e)
  }
  writeJsonl(inflightPath(stateDir, identity), keep)
  if (orphaned.length) for (const o of orphaned) appendFileSync(orphansPath(stateDir, identity), JSON.stringify(o) + '\n', { mode: 0o600 })
  if (interrupted.length) for (const o of interrupted) appendFileSync(interruptedPath(stateDir, identity), JSON.stringify(o) + '\n', { mode: 0o600 })
  return orphaned.length + interrupted.length
}

export function listOrphanIdentities(stateDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(stateDir)
  } catch {
    return []
  }
  return names.filter(n => n.endsWith('.orphans.jsonl')).map(n => n.slice(0, -'.orphans.jsonl'.length))
}

/** Take (and remove) an identity's orphans — the caller owns redelivery-or-notify for each. */
export function takeOrphans(stateDir: string, identity: string): InflightEntry[] {
  const path = orphansPath(stateDir, identity)
  const entries = readJsonl(path)
  rmSync(path, { force: true })
  return entries
}

export function listInterruptedIdentities(stateDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(stateDir)
  } catch {
    return []
  }
  return names.filter(n => n.endsWith('.interrupted.jsonl')).map(n => n.slice(0, -'.interrupted.jsonl'.length))
}

/** Take (and remove) an identity's interrupted entries — the caller notifies each sender. */
export function takeInterrupted(stateDir: string, identity: string): InflightEntry[] {
  const path = interruptedPath(stateDir, identity)
  const entries = readJsonl(path)
  rmSync(path, { force: true })
  return entries
}

/** Remove an identity's ledger + orphans (peer removal). */
export function purgeInflight(stateDir: string, identity: string): void {
  rmSync(inflightPath(stateDir, identity), { force: true })
  rmSync(orphansPath(stateDir, identity), { force: true })
  rmSync(interruptedPath(stateDir, identity), { force: true })
}
