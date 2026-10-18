// Limit-resume — the NUDGE half of the limit-park contract (lifecycle/limitpark.ts, docs/19 §9).
//
// Invariant: a peer stopped by an exhausted model limit mid-task continues by itself after the
// stated reset — no human. Run after every supervise tick: for each park whose reset + grace has
// passed, either the session already progressed (the runtime's own continuation fired, or a later
// message got a real reply) → the park is dropped; or it did not → the core delivers ONE
// continuation message through the normal route. Wake-on-miss resumes a reaped session (an idle
// reap is resume-eligible), so the same message serves a held-alive and a reaped session.
//
// Sender = the core's system identity (identity/systemCaller): registry-independent, and never the
// target — the target may well be the peer named `iapeer` itself (it was, on 18.10.2026).

import type { LifecycleConfig } from '../lifecycle/index.ts'
import { appendLifecycleEvent } from '../lifecycle/eventlog.ts'
import {
  LIMIT_MAX_NUDGE_ATTEMPTS,
  LIMIT_RESUME_GRACE_MS,
  clearLimitPark,
  listLimitParks,
  parkProgressed,
  updateLimitPark,
  type LimitPark,
} from '../lifecycle/limitpark.ts'
import { systemCaller } from '../identity/index.ts'
import { routeSend, type RouteDeps } from '../transport/index.ts'

/** Between two failed nudge attempts. */
const RETRY_BACKOFF_MS = 5 * 60_000

export function limitResumeMessage(p: LimitPark): string {
  return (
    `[iapeer] Your model limit (${p.errorType ?? 'rate limit'}) has reset — it lifted at ${new Date(p.resetsAtMs).toISOString()}. ` +
    `Your previous turn was stopped by that limit at ${new Date(p.eventAtMs).toISOString()} and nothing has continued it since. ` +
    `Resume the interrupted work from where it stopped (re-check its state first). ` +
    `If that work is already finished, no reply is needed — this notice comes from the iapeer core, not a peer.`
  )
}

export interface LimitResumeSeam {
  send?: typeof routeSend
  progressed?: (p: LimitPark) => boolean
  now?: () => number
}

export async function processLimitResumes(
  cfg: LifecycleConfig,
  env: NodeJS.ProcessEnv,
  routeDeps: RouteDeps,
  seam: LimitResumeSeam = {},
): Promise<void> {
  const now = (seam.now ?? Date.now)()
  const send = seam.send ?? routeSend
  const progressed = seam.progressed ?? parkProgressed
  const log = (fields: Record<string, string | number | undefined>): void => {
    try {
      appendLifecycleEvent(cfg.eventLogDir, { ev: 'limit-resume', ...fields }, { env })
    } catch {
      /* best-effort */
    }
  }
  for (const p of listLimitParks(cfg)) {
    if (now < p.resetsAtMs + LIMIT_RESUME_GRACE_MS) continue
    if (p.lastAttemptMs && now - p.lastAttemptMs < RETRY_BACKOFF_MS) continue
    let moved = false
    try {
      moved = progressed(p)
    } catch {
      moved = false
    }
    if (moved) {
      clearLimitPark(cfg, p.identity)
      log({ identity: p.identity, outcome: 'progressed', resets: new Date(p.resetsAtMs).toISOString() })
      continue
    }
    let reason: string
    try {
      // Topic = the stopped session's own thread (captured at park time), so the topic set still
      // follows the work; the RESUME itself rides the explicit continue-work intent, not the topic.
      const topic = p.topic || 'limit-resume'
      const r = await send(systemCaller(), { personality: p.personality, runtime: p.runtime, message: limitResumeMessage(p), topic }, { ...routeDeps, wakeContinueWork: true })
      if (r.ok) {
        clearLimitPark(cfg, p.identity)
        log({ identity: p.identity, outcome: 'nudged', woke: String(r.value.woke), resets: new Date(p.resetsAtMs).toISOString() })
        continue
      }
      reason = r.error.message
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e)
    }
    const attempts = (p.attempts ?? 0) + 1
    // A deliberate operator halt (stopped) is not a transient — never fight it.
    const permanent = /\bstopped\b|not in the iapeer peers index/.test(reason)
    if (permanent || attempts >= LIMIT_MAX_NUDGE_ATTEMPTS) {
      clearLimitPark(cfg, p.identity)
      log({ identity: p.identity, outcome: permanent ? 'dropped' : 'gave-up', attempts, err: reason.slice(0, 300) })
    } else {
      updateLimitPark(cfg, { ...p, attempts, lastAttemptMs: now })
      log({ identity: p.identity, outcome: 'retry', attempts, err: reason.slice(0, 300) })
    }
  }
}
