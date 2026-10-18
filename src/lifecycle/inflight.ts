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
}

const inflightPath = (stateDir: string, identity: string) => join(stateDir, `${identity}.inflight.jsonl`)
const orphansPath = (stateDir: string, identity: string) => join(stateDir, `${identity}.orphans.jsonl`)

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
  for (const e of entries) {
    let done = false
    try {
      done = deps.processed(e)
    } catch {
      done = false
    }
    if (done) continue
    if (current !== null && current === e.sessionToken) keep.push(e)
    else orphaned.push(e)
  }
  writeJsonl(inflightPath(stateDir, identity), keep)
  if (orphaned.length) for (const o of orphaned) appendFileSync(orphansPath(stateDir, identity), JSON.stringify(o) + '\n', { mode: 0o600 })
  return orphaned.length
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

/** Remove an identity's ledger + orphans (peer removal). */
export function purgeInflight(stateDir: string, identity: string): void {
  rmSync(inflightPath(stateDir, identity), { force: true })
  rmSync(orphansPath(stateDir, identity), { force: true })
}
