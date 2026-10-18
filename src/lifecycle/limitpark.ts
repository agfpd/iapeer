// Limit-park — a peer whose turn was stopped by an exhausted model limit must CONTINUE on its own
// once the limit lifts (docs/19 §9). Incident 18.10.2026: the fleet hit the claude five-hour limit
// at 04:55; claude painted «resets 8:30am» in the pane, the daemon idle-reaped the sessions an hour
// later, nothing woke them after the reset, and every peer stood still until a human pinged it.
//
// TWO HALVES, one record per endpoint (identity = <runtime>-<personality>):
//   • HOLD — while a park is live (now < resetsAt + grace) superviseTick does NOT idle-reap the
//     session. The context stays warm and a runtime that resumes by itself (claude's own «Continuing
//     automatically») gets the chance to. Bounded by MAX_HOLD_MS: a weekly wall is not worth a
//     process held for days — beyond it the session is reaped normally and the nudge resumes it.
//   • NUDGE — after resetsAt + grace, if the session made NO progress since the limit event, the
//     daemon delivers a continuation message (daemon/limitresume.ts). Wake-on-miss resumes a reaped
//     session (an idle reap is resume-eligible), so the nudge works whether the hold applied or not.
//
// The record is written by the mute-watch on a structural limit event that STATES a reset time —
// never extrapolated: no resetsAt, no park (the notice still tells the owner). A newer limit event
// for the same endpoint replaces the record (each event earns exactly one nudge).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { LifecycleConfig } from './index.ts'
import { writeFileAtomic } from '../storage/index.ts'
import { readSessionSlices } from '../daemon/sessionfiles.ts'

/** Wait this long past the stated reset before nudging: the runtime's own continuation (and a clock
 *  skew between the provider and this host) gets to win first. */
export const LIMIT_RESUME_GRACE_MS = 3 * 60_000
/** The hold never keeps a session alive longer than this past the limit event. */
export const LIMIT_MAX_HOLD_MS = 6 * 60 * 60_000
/** A failed nudge is retried at most this many times (then the park is dropped, logged). */
export const LIMIT_MAX_NUDGE_ATTEMPTS = 3

export interface LimitPark {
  identity: string
  personality: string
  runtime: string
  /** The runtime's own stated reset instant. */
  resetsAtMs: number
  /** The limit event's own time (transcript timestamp / codex completed_at). */
  eventAtMs: number
  /** The session file the event was read from — the progress probe re-reads it. */
  file?: string
  sessionId?: string
  errorType?: string
  attempts?: number
  lastAttemptMs?: number
}

const DIR = 'limit-parks'

function parkPath(cfg: LifecycleConfig, identity: string): string {
  return join(cfg.stateDir, DIR, `${identity}.json`)
}

export function readLimitPark(cfg: LifecycleConfig, identity: string): LimitPark | null {
  try {
    const p = JSON.parse(readFileSync(parkPath(cfg, identity), 'utf8')) as LimitPark
    return typeof p.resetsAtMs === 'number' && typeof p.eventAtMs === 'number' ? p : null
  } catch {
    return null
  }
}

/** Record (or supersede) a park. Returns false when an equal-or-newer event is already recorded —
 *  the overlapping mute-watch window re-reads the same line every sweep. */
export function recordLimitPark(cfg: LifecycleConfig, park: LimitPark): boolean {
  const cur = readLimitPark(cfg, park.identity)
  if (cur && cur.eventAtMs >= park.eventAtMs) return false
  mkdirSync(join(cfg.stateDir, DIR), { recursive: true, mode: 0o700 })
  writeFileAtomic(parkPath(cfg, park.identity), `${JSON.stringify({ ...park, attempts: 0 })}\n`)
  return true
}

export function updateLimitPark(cfg: LifecycleConfig, park: LimitPark): void {
  mkdirSync(join(cfg.stateDir, DIR), { recursive: true, mode: 0o700 })
  writeFileAtomic(parkPath(cfg, park.identity), `${JSON.stringify(park)}\n`)
}

export function clearLimitPark(cfg: LifecycleConfig, identity: string): void {
  try {
    rmSync(parkPath(cfg, identity), { force: true })
  } catch {
    /* already gone */
  }
}

export function listLimitParks(cfg: LifecycleConfig): LimitPark[] {
  const dir = join(cfg.stateDir, DIR)
  if (!existsSync(dir)) return []
  const out: LimitPark[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const p = readLimitPark(cfg, name.slice(0, -'.json'.length))
    if (p) out.push(p)
  }
  return out
}

/** True while superviseTick must NOT idle-reap this identity: a live park whose reset (plus grace)
 *  has not arrived yet and whose hold is within the bound. */
export function limitHoldActive(cfg: LifecycleConfig, identity: string, nowMs: number): LimitPark | null {
  const p = readLimitPark(cfg, identity)
  if (!p) return null
  if (nowMs >= p.resetsAtMs + LIMIT_RESUME_GRACE_MS) return null
  if (p.resetsAtMs - p.eventAtMs > LIMIT_MAX_HOLD_MS) return null
  return p
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress probe — did the session do real work AFTER the limit event?
// ─────────────────────────────────────────────────────────────────────────────

/** Claude: a REAL assistant reply (model ≠ "<synthetic>", which is the refusal itself) stamped after
 *  the event. A new limit refusal is not progress — it supersedes the park instead. */
export function claudeProgressedSince(text: string, eventAtMs: number): boolean {
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{') || !s.includes('"assistant"')) continue
    let d: { type?: unknown; timestamp?: unknown; isApiErrorMessage?: unknown; message?: { model?: unknown } }
    try {
      d = JSON.parse(s)
    } catch {
      continue
    }
    if (d.type !== 'assistant' || d.isApiErrorMessage === true) continue
    const model = d.message?.model
    if (typeof model !== 'string' || !model || model === '<synthetic>') continue
    const at = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN
    if (Number.isFinite(at) && at > eventAtMs) return true
  }
  return false
}

/** Codex: a turn that COMPLETED with a message after the event. Keyed on completed_at (replay-safe:
 *  a resumed rollout re-stamps line timestamps but keeps completed_at — see mutewatch.ts). */
export function codexProgressedSince(text: string, eventAtMs: number): boolean {
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{') || !s.includes('task_complete')) continue
    let d: { payload?: { type?: unknown; last_agent_message?: unknown; completed_at?: unknown } }
    try {
      d = JSON.parse(s)
    } catch {
      continue
    }
    const p = d.payload
    if (!p || p.type !== 'task_complete') continue
    if (typeof p.last_agent_message !== 'string' || !p.last_agent_message) continue
    if (typeof p.completed_at === 'number' && p.completed_at * 1000 > eventAtMs) return true
  }
  return false
}

/** Did the parked session progress since its limit event? Unknown (no file / unreadable) → false:
 *  the nudge is cheap and a missed continuation is exactly the defect this exists for. */
export function parkProgressed(park: LimitPark): boolean {
  if (!park.file) return false
  const t = readSessionSlices(park.file, 512 * 1024)
  if (!t) return false
  if (park.runtime === 'claude') return claudeProgressedSince(t.tail, park.eventAtMs)
  if (park.runtime === 'codex') return codexProgressedSince(t.tail, park.eventAtMs)
  return false
}
