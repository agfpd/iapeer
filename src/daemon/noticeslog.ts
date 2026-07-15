// Notice-board durable log — the daemon's DURABLE trace of every owner-facing notice it
// raises (docs/19). Sibling to lifecycle.log / delivery.log / exits.log / approvals.log
// under cfg.eventLogDir; tailed by the fleet-API SSE stream (fleetEventFiles), so the
// `notice-raised` event reaches every operator client (tray, telegram, web) with
// at-least-once semantics — and a postmortem can reconstruct which peer went mute, why,
// and when, after the in-memory board is gone.
//
// What is logged: notice METADATA + a one-line `summary` — NOT the full verbatim runtime
// message (`content`), which can be multi-line. The full content lives in the in-memory
// board and is served by GET /fleet/v1/notices/<id>; the log carries enough to correlate
// + render a badge/line.
//
// Same rotation class as its siblings: written by OUR code → self-rotates via the shared
// storage/rotatelog primitive. The dir is passed IN by the composition point, never
// re-resolved from env — a falsy dir → no-op (library/test daemons stay hermetic).

import { join } from 'path'
import { DEFAULT_LOG_KEEP, DEFAULT_LOG_MAX_BYTES, appendRotatedEvent } from '../storage/rotatelog.ts'

/** The notice-board log inside `logDir` (sibling to approvals.log). */
export function noticesLogPath(logDir: string): string {
  return join(logDir, 'notices.log')
}

function envPosInt(raw: string | undefined, dflt: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

export interface AppendNoticeOptions {
  /** Reads the rotation knobs IAPEER_NOTICES_LOG_MAX_BYTES / _KEEP. */
  env?: NodeJS.ProcessEnv
  /** Stamp the line with this epoch-ms. Default Date.now(). */
  nowMs?: number
}

/**
 * Append one notice event line into `logDir`/notices.log. A falsy `logDir` is a no-op
 * (the default for library/test daemons). Fully best-effort — never throws; logging must
 * never fail a detection sweep.
 */
export function appendNoticeEvent(
  logDir: string | undefined,
  fields: Record<string, string | number | undefined>,
  opts: AppendNoticeOptions = {},
): void {
  if (!logDir) return
  const env = opts.env ?? process.env
  appendRotatedEvent(noticesLogPath(logDir), fields, {
    nowMs: opts.nowMs,
    maxBytes: envPosInt(env.IAPEER_NOTICES_LOG_MAX_BYTES, DEFAULT_LOG_MAX_BYTES),
    keep: envPosInt(env.IAPEER_NOTICES_LOG_KEEP, DEFAULT_LOG_KEEP),
  })
}
