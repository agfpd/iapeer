// Rotated logfmt append — the GENERIC durable-log primitive, promoted out of
// lifecycle/eventlog.ts (its header anticipated exactly this: "the rotate-append
// primitive is path-parameterized, so the adjacent 'log rotation' phase can
// promote it to storage/ and point other log producers at it"). Producers today:
//   • lifecycle.log  (lifecycle/eventlog.ts — daemon lifecycle decisions)
//   • delivery.log   (daemon/deliverylog.ts — per-delivery outcomes, Ф-#8a)
//
// Design (carried verbatim from eventlog):
//   • One line per event, logfmt (`key=value`, values quoted iff they contain
//     whitespace/quotes/`=`). Human-greppable AND machine-parseable.
//   • Append-only, app-managed SIZE rotation (base → .1 … .keep). This is the
//     "встроенная ротация" class (Фаза — Ротация логов iapeer): a log OUR code
//     writes rotates itself in the writer; external rotation is only for logs
//     written by processes we don't control.
//   • The target PATH is passed IN by the caller (who routes it through cfg),
//     never re-resolved from env here — so a sandboxed caller cfg sandboxes the
//     log too (no leak to the real ~/.iapeer).
//   • Best-effort throughout: a write/rotate failure is swallowed. Observability
//     must never take down the daemon or fail a wake/reap/delivery.

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { dirname } from 'path'

/** Default cap per log file before it rotates to <path>.1. */
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024 // 5 MiB
/** Default number of rotated backups kept (<path>.1 … .KEEP). */
export const DEFAULT_LOG_KEEP = 5

/** logfmt value: bare token, or double-quoted with `"`/`\` escaped, when it
 *  contains whitespace, `=` or `"`. Empty string → `""`. */
export function fmtValue(v: string | number): string {
  const s = String(v)
  if (s === '') return '""'
  if (/[\s"=]/.test(s)) return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return s
}

/** Render one logfmt line (ts first, then fields in insertion order; undefined
 *  fields are skipped). No trailing newline. Pure — unit-testable. */
export function formatEventLine(nowMs: number, fields: Record<string, string | number | undefined>): string {
  const parts = [`ts=${new Date(nowMs).toISOString()}`]
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    parts.push(`${k}=${fmtValue(v)}`)
  }
  return parts.join(' ')
}

/** Size-rotate `path` (and its .1 … .keep backups) when the next line would push
 *  it over `maxBytes`. Drops the oldest, shifts each backup up by one, base→.1.
 *  Best-effort: any fs hiccup leaves the chain as-is (we then just append). */
function rotateIfNeeded(path: string, lineLen: number, maxBytes: number, keep: number): void {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return // no file yet → nothing to rotate
  }
  if (size + lineLen <= maxBytes) return
  try {
    rmSync(`${path}.${keep}`, { force: true })
  } catch {
    /* best-effort */
  }
  for (let i = keep - 1; i >= 1; i--) {
    try {
      renameSync(`${path}.${i}`, `${path}.${i + 1}`)
    } catch {
      /* that backup may not exist yet */
    }
  }
  try {
    renameSync(path, `${path}.1`)
  } catch {
    /* best-effort */
  }
}

export interface AppendRotatedOptions {
  /** Stamp the line with this epoch-ms (a caller may pass its own tick clock so the
   *  log timestamp agrees with its accounting). Default Date.now(). */
  nowMs?: number
  /** Rotation cap per file (default DEFAULT_LOG_MAX_BYTES). */
  maxBytes?: number
  /** Rotated backups kept (default DEFAULT_LOG_KEEP). */
  keep?: number
}

/**
 * Append one logfmt event line to the rotated log at `path` (full file path,
 * routed through the caller's cfg). Creates the parent dir (0700) and the file
 * (0600) as needed. Fully best-effort — never throws.
 */
export function appendRotatedEvent(
  path: string,
  fields: Record<string, string | number | undefined>,
  opts: AppendRotatedOptions = {},
): void {
  const line = `${formatEventLine(opts.nowMs ?? Date.now(), fields)}\n`
  const maxBytes = opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES
  const keep = opts.keep ?? DEFAULT_LOG_KEEP
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    rotateIfNeeded(path, line.length, maxBytes, keep)
    appendFileSync(path, line, { mode: 0o600 })
  } catch {
    /* observability is best-effort — a log failure must never break the caller */
  }
}
