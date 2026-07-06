// Approval-broker durable log — the daemon's DURABLE trace of every human-approval
// request it brokers (docs/17). Sibling to lifecycle.log / delivery.log / exits.log
// under cfg.eventLogDir; tailed by the fleet-API SSE stream (fleetEventFiles), so the
// `approval-request` / `approval-resolved` events reach every operator client (CLI,
// tray, telegram) with at-least-once semantics — and a postmortem can reconstruct who
// asked, what, and how it resolved after the in-memory queue is gone.
//
// What is logged: approval METADATA + a one-line `summary` of the action — NOT the full
// multi-line content (a Write's whole body / a long diff would bloat the log). The full
// human-readable content lives in the in-memory queue and is served by GET
// /fleet/v1/approvals/<id>; the log carries enough to correlate + render a badge/line.
//
// Same rotation class as its siblings: written by OUR code → self-rotates via the shared
// storage/rotatelog primitive. The dir is passed IN by the composition point, never
// re-resolved from env — a falsy dir → no-op (library/test daemons stay hermetic).

import { join } from 'path'
import { DEFAULT_LOG_KEEP, DEFAULT_LOG_MAX_BYTES, appendRotatedEvent } from '../storage/rotatelog.ts'

/** The approval-broker log inside `logDir` (sibling to lifecycle.log). */
export function approvalsLogPath(logDir: string): string {
  return join(logDir, 'approvals.log')
}

function envPosInt(raw: string | undefined, dflt: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

export interface AppendApprovalOptions {
  /** Reads the rotation knobs IAPEER_APPROVALS_LOG_MAX_BYTES / _KEEP. */
  env?: NodeJS.ProcessEnv
  /** Stamp the line with this epoch-ms. Default Date.now(). */
  nowMs?: number
}

/**
 * Append one approval event line into `logDir`/approvals.log. A falsy `logDir` is a
 * no-op (the default for library/test daemons). Fully best-effort — never throws;
 * logging must never fail an approval round-trip.
 */
export function appendApprovalEvent(
  logDir: string | undefined,
  fields: Record<string, string | number | undefined>,
  opts: AppendApprovalOptions = {},
): void {
  if (!logDir) return
  const env = opts.env ?? process.env
  appendRotatedEvent(approvalsLogPath(logDir), fields, {
    nowMs: opts.nowMs,
    maxBytes: envPosInt(env.IAPEER_APPROVALS_LOG_MAX_BYTES, DEFAULT_LOG_MAX_BYTES),
    keep: envPosInt(env.IAPEER_APPROVALS_LOG_KEEP, DEFAULT_LOG_KEEP),
  })
}
