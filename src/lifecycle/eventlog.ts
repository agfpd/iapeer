// Lifecycle event log — the daemon's DURABLE, ROTATED trace of every lifecycle
// DECISION it makes. This closes an observability gap: a peer could wake fresh
// with NO record of when/how its prior session ended,
// nor of the daemon's fresh-vs-resume reasoning, because superviseTick's outcomes
// were dropped and the daemon never wrote a decision line anywhere.
//
// Design:
//   • One line per decision, logfmt (`key=value`, values quoted iff they contain
//     whitespace/quotes/`=`). Human-greppable AND machine-parseable. The state
//     markers (.idle-reaped / .deaths) are CONSUMED on the next wake — this log is
//     the part that survives, so a postmortem can reconstruct the death even after
//     the marker is gone.
//   • Append-only, app-managed SIZE rotation (NOT launchd's stdout/stderr, which
//     are unbounded and truncated on restart). lifecycle.log → .1 … .N.
//   • The target directory is passed IN (cfg.eventLogDir), NOT re-resolved from
//     env — so it is isolated by the SAME cfg the rest of lifecycle routes through
//     (a test that sandboxes cfg.stateDir also sandboxes this log; no leak to the
//     real ~/.iapeer). A falsy dir → no-op (a partial test cfg never writes).
//   • Best-effort throughout: a write/rotate failure is swallowed. Observability
//     must never take down the daemon or fail a wake/reap.
//
// The rotate-append primitive was PROMOTED to storage/rotatelog.ts (as this header
// anticipated) when the daemon's per-delivery log became the second producer
// (Ф-#8a). This module keeps its public API (appendLifecycleEvent + the logfmt
// helpers, re-exported) so its call sites and tests are untouched; only the
// implementation now lives in storage.

import { join } from 'path'
import {
  DEFAULT_LOG_KEEP,
  DEFAULT_LOG_MAX_BYTES,
  appendRotatedEvent,
} from '../storage/rotatelog.ts'

// Re-export the logfmt helpers — historical home of these (consumers import them
// from eventlog; the implementation moved to storage/rotatelog.ts).
export { fmtValue, formatEventLine } from '../storage/rotatelog.ts'

/** The durable lifecycle decision log inside `logDir` (cfg.eventLogDir). */
export function lifecycleLogPath(logDir: string): string {
  return join(logDir, 'lifecycle.log')
}

function envPosInt(raw: string | undefined, dflt: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/** Whether to also log the steady-state non-decisions (alive / skipped-launchd).
 *  Off by default — they fire every tick per live/launchd peer and would bury the
 *  actual decisions (reap / wake) under heartbeat noise. */
export function superviseLogVerbose(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.IAPEER_SUPERVISE_LOG_VERBOSE?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export interface AppendEventOptions {
  /** Reads the rotation knobs IAPEER_LIFECYCLE_LOG_MAX_BYTES / _KEEP. */
  env?: NodeJS.ProcessEnv
  /** Stamp the line with this epoch-ms (superviseTick passes its own tick clock so
   *  the log timestamp agrees with the death/idle accounting). Default Date.now(). */
  nowMs?: number
}

/**
 * Append one lifecycle decision line into `logDir`/lifecycle.log. A falsy `logDir`
 * is a no-op (a partial test cfg without eventLogDir never writes — and never
 * resolves a real path). Fully best-effort — never throws.
 */
export function appendLifecycleEvent(
  logDir: string | undefined,
  fields: Record<string, string | number | undefined>,
  opts: AppendEventOptions = {},
): void {
  if (!logDir) return
  const env = opts.env ?? process.env
  appendRotatedEvent(lifecycleLogPath(logDir), fields, {
    nowMs: opts.nowMs,
    maxBytes: envPosInt(env.IAPEER_LIFECYCLE_LOG_MAX_BYTES, DEFAULT_LOG_MAX_BYTES),
    keep: envPosInt(env.IAPEER_LIFECYCLE_LOG_KEEP, DEFAULT_LOG_KEEP),
  })
}
