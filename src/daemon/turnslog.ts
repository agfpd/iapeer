// Turn-activity durable log — the daemon's DURABLE trace of every per-runtime turn boundary
// it observes (docs/15 §Activity). Sibling to lifecycle.log / delivery.log / exits.log /
// approvals.log / notices.log under cfg.eventLogDir; tailed by the fleet-API SSE stream
// (fleetEventFiles), so `turn-started` / `turn-ended` reach every operator client with
// at-least-once semantics — the same "the log IS the push mechanism" trick notices.log uses.
//
// Volume is bounded by DESIGN, not by luck: turnWatchTick writes only on a real state CHANGE,
// never once per sweep. The watch polls every ~3 s; without that guard it would emit a line per
// peer per pass and drown the very log meant to make turn history readable. Two lines per turn
// per runtime is the ceiling.
//
// Same rotation class as its siblings: written by OUR code → self-rotates via the shared
// storage/rotatelog primitive. The dir is passed IN by the composition point, never re-resolved
// from env — a falsy dir → no-op (library/test daemons stay hermetic).

import { join } from 'path'
import { DEFAULT_LOG_KEEP, DEFAULT_LOG_MAX_BYTES, appendRotatedEvent } from '../storage/rotatelog.ts'

/** The turn-activity log inside `logDir` (sibling to notices.log). */
export function turnsLogPath(logDir: string): string {
  return join(logDir, 'turns.log')
}

function envPosInt(raw: string | undefined, dflt: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

export interface AppendTurnOptions {
  /** Reads the rotation knobs IAPEER_TURNS_LOG_MAX_BYTES / _KEEP. */
  env?: NodeJS.ProcessEnv
  /** Stamp the line with this epoch-ms. Default Date.now(). */
  nowMs?: number
}

/**
 * Append one turn event line into `logDir`/turns.log. A falsy `logDir` is a no-op. Fully
 * best-effort — never throws; logging must never fail a detection sweep.
 */
export function appendTurnEvent(
  logDir: string | undefined,
  fields: Record<string, string | number | undefined>,
  opts: AppendTurnOptions = {},
): void {
  if (!logDir) return
  const env = opts.env ?? process.env
  appendRotatedEvent(turnsLogPath(logDir), fields, {
    nowMs: opts.nowMs,
    maxBytes: envPosInt(env.IAPEER_TURNS_LOG_MAX_BYTES, DEFAULT_LOG_MAX_BYTES),
    keep: envPosInt(env.IAPEER_TURNS_LOG_KEEP, DEFAULT_LOG_KEEP),
  })
}
