// Dashboard MODEL — the pure logic of the management dashboard (Фаза 3 «TUI-редизайн
// management»): row filtering, activity-age formatting, event-log line parsing and
// per-peer log assembly. NO Ink, NO I/O — unit-testable in isolation (the same
// pure-core discipline as listTui.ts / the onboard wizard state machine).
//
// The VIEW (app.tsx) renders this; the DATA layer (data.ts) feeds it; run.tsx owns
// the terminal. Keeping the model pure is what lets the dashboard stay testable
// under `bun test` with zero terminal plumbing.

import type { PeerListing } from '../../cli/index.ts'
import { eventConcernsPeer as concernsPeer, parseEventLine as parseLogfmtLine } from '../../storage/rotatelog.ts'

// ─── row filtering ───────────────────────────────────────────────────────────

/** Rows matching the filter (case-insensitive substring over personality/description). */
export function filterRows(rows: PeerListing[], filter: string): PeerListing[] {
  const f = filter.trim().toLowerCase()
  if (!f) return rows
  return rows.filter(r => r.personality.toLowerCase().includes(f) || r.description.toLowerCase().includes(f))
}

/** Clamp the cursor into the filtered row set (rows shrink under a live filter). */
export function clampCursor(cursor: number, visibleCount: number): number {
  if (visibleCount <= 0) return 0
  return Math.min(Math.max(0, cursor), visibleCount - 1)
}

/** The scroll window [start, end) of `height` rows keeping `cursor` visible. */
export function scrollWindow(cursor: number, total: number, height: number): { start: number; end: number } {
  if (total <= height) return { start: 0, end: total }
  const start = Math.min(Math.max(0, cursor - Math.floor(height / 2)), total - height)
  return { start, end: start + height }
}

// ─── activity age ────────────────────────────────────────────────────────────

/** Compact k9s/CC-style age: 12s · 4m · 3h · 2d; '—' when unknown. */
export function formatAge(mtimeMs: number | undefined, nowMs: number): string {
  if (mtimeMs === undefined || mtimeMs <= 0) return '—'
  const s = Math.max(0, Math.floor((nowMs - mtimeMs) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

// ─── event-log parsing (ts=… ev=… k=v lines from delivery.log / lifecycle.log) ──

export interface LogEvent {
  tsMs: number
  /** HH:MM:SS local time for display. */
  time: string
  ev: string
  fields: Record<string, string>
}

/** Parse one `ts=<iso> ev=<kind> k=v …` line; null for anything else (corrupt tail).
 *  Delegates to the storage-layer QUOTE-AWARE parser (the writer's symmetric read
 *  half) and adds the display time — the earlier display-only tokenizer split quoted
 *  multi-word values (reason="idle 3700s") mid-value. */
export function parseEventLine(line: string): LogEvent | null {
  const p = parseLogfmtLine(line)
  if (!p) return null
  const d = new Date(p.tsMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return { tsMs: p.tsMs, time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, ev: p.ev, fields: p.fields }
}

/** Does this event concern the peer? Matches bare personality and any `<rt>-<personality>`
 *  identity in the fields the two logs actually carry (to/caller/via/personality/identity).
 *  Re-exported from the storage layer (the fleet peer-detail endpoint shares it). */
export const eventConcernsPeer: (e: LogEvent, personality: string) => boolean = concernsPeer

/** One display line per event — compact, the interesting fields only. */
export function formatEvent(e: LogEvent): { text: string; tone: 'ok' | 'fail' | 'info' } {
  const f = e.fields
  if (e.ev === 'delivery') {
    const ok = f.ok === 'true'
    return {
      text: `${e.time} delivery ${f.caller ?? '?'} → ${f.to ?? '?'} ${ok ? 'ok' : 'FAIL'}${f.ms ? ` ${f.ms}ms` : ''}${f.woke === 'true' ? ' (woke)' : ''}`,
      tone: ok ? 'ok' : 'fail',
    }
  }
  const rest = Object.entries(f)
    .filter(([k]) => k !== 'ts' && k !== 'ev')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  return { text: `${e.time} ${e.ev} ${rest}`.trimEnd(), tone: e.ev.includes('error') || e.ev.includes('fail') ? 'fail' : 'info' }
}

/** Assemble the per-peer log panel: parse both raw tails, filter to the peer, merge
 *  by timestamp, keep the newest `limit`. */
export function assemblePeerLog(rawTails: string[], personality: string, limit: number): Array<{ text: string; tone: 'ok' | 'fail' | 'info' }> {
  const events: LogEvent[] = []
  for (const raw of rawTails) {
    for (const line of raw.split('\n')) {
      const e = parseEventLine(line)
      if (e && eventConcernsPeer(e, personality)) events.push(e)
    }
  }
  events.sort((a, b) => a.tsMs - b.tsMs)
  return events.slice(-limit).map(formatEvent)
}

// ─── ellipsis ────────────────────────────────────────────────────────────────

/** Truncate to `width` code points with a … tail (multi-byte-safe via the spread). */
export function ellipsize(s: string, width: number): string {
  if (width <= 0) return ''
  const chars = [...s]
  return chars.length <= width ? s : chars.slice(0, Math.max(0, width - 1)).join('') + '…'
}

// ─── attach-child failure surfacing ─────────────────────────────────────────

/** Why a spawned `iapeer attach <peer>` run needs the operator's attention, or null when it
 *  ended fine. PURE: a spawn error AND a non-zero/signal exit both surface — a failed child
 *  silently remounted over reads as "Enter does nothing" to the operator (live incident 03.07). */
export function attachFailureMessage(r: { error?: Error; status: number | null }): string | null {
  if (r.error) return r.error.message
  if ((r.status ?? 1) !== 0) return `iapeer attach exited with ${r.status ?? 'a signal'}`
  return null
}
