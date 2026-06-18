// Per-delivery outcome log — the daemon's DURABLE trace of EVERY send_to_peer it
// routes (Ф-#8a transport hardening). This closes the observability gap the
// 09.06 long-message investigation hit: a sender held an `ok:true` while the
// recipient never saw the message, and there was NO daemon-side record of what
// routeSend actually decided (hit/miss, woke, error) to reconstruct the path.
// With this log, the NEXT suspected loss is answerable from disk: one logfmt
// line per delivery attempt — who sent, to whom, how it resolved, how long it
// took — delivery.log, sibling to lifecycle.log / exits.log (where the
// investigator already looks).
//
// What is logged: routing METADATA only (caller, target, outcome, sizes, topic)
// — never the message body (peer traffic stays out of the foundation's logs;
// length is enough to correlate with the sender's account).
//
// Same class as lifecycle.log ("встроенная ротация", Фаза — Ротация логов
// iapeer): written by OUR code → rotates itself in the writer, via the shared
// storage/rotatelog primitive. The dir is passed IN by the composition point
// (daemon/main.ts routes cfg.eventLogDir), NEVER re-resolved from env here — a
// falsy dir → no-op, so library/test callers of startDaemon stay hermetic by
// default (same opt-in pattern as the discovery file).

import { join } from 'path'
import {
  DEFAULT_LOG_KEEP,
  DEFAULT_LOG_MAX_BYTES,
  appendRotatedEvent,
} from '../storage/rotatelog.ts'

/** The per-delivery outcome log inside `logDir` (sibling to lifecycle.log). */
export function deliveryLogPath(logDir: string): string {
  return join(logDir, 'delivery.log')
}

function envPosInt(raw: string | undefined, dflt: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

export interface AppendDeliveryOptions {
  /** Reads the rotation knobs IAPEER_DELIVERY_LOG_MAX_BYTES / _KEEP. */
  env?: NodeJS.ProcessEnv
  /** Stamp the line with this epoch-ms. Default Date.now(). */
  nowMs?: number
}

/**
 * Append one delivery outcome line into `logDir`/delivery.log. A falsy `logDir`
 * is a no-op (the default for library/test daemons — production main passes the
 * cfg-resolved dir). Fully best-effort — never throws; logging must never fail
 * a delivery.
 */
export function appendDeliveryEvent(
  logDir: string | undefined,
  fields: Record<string, string | number | undefined>,
  opts: AppendDeliveryOptions = {},
): void {
  if (!logDir) return
  const env = opts.env ?? process.env
  appendRotatedEvent(deliveryLogPath(logDir), fields, {
    nowMs: opts.nowMs,
    maxBytes: envPosInt(env.IAPEER_DELIVERY_LOG_MAX_BYTES, DEFAULT_LOG_MAX_BYTES),
    keep: envPosInt(env.IAPEER_DELIVERY_LOG_KEEP, DEFAULT_LOG_KEEP),
  })
}
