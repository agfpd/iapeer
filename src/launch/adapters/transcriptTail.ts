// Shared transcript-tail reader for the idle-accounting signal.
//
// The RELIABLE "last real turn" time is the content-timestamp of the LAST meaningful transcript entry —
// NOT the file mtime (a live claude session RE-SAVES its .jsonl without a new entry, so file-mtime is
// falsely fresh at idle) and NOT the pane-log mtime (a statusline / footer re-render writes pty bytes at
// idle, so the pane-log is falsely fresh too). The transcript ENTRY stream only advances on actual turn
// activity (user/assistant/tool/turn_duration for claude; event_msg/response_item for codex), so the
// last entry that carries a `timestamp` is the true idle signal — immune to both noise sources.

import { openSync, readSync, closeSync, statSync } from 'fs'

/**
 * Content-timestamp (epoch ms) of the LAST jsonl entry carrying a `timestamp` field, read from the
 * file's TAIL. Metadata records without a `timestamp` (claude `mode` / `ai-title` / `bridge-session`)
 * are skipped. Returns null only when the file is unreadable / empty, or genuinely carries NO
 * timestamped entry anywhere (the caller then floors at wokeAt).
 *
 * ADAPTIVE WINDOW (the giant-tail fix). The reader starts at the cheap `tailBytes` window and GROWS it
 * (doubling, capped at file size) until a complete timestamped entry is captured. A single transcript
 * record can dwarf the default window — a browser peer appends base64 screenshots, observed up to
 * 368 KB (5.6× the 64 KB default). When such a record is the tail, a FIXED window holds only a fragment
 * of one line: no complete JSON → the old code returned null, the caller floored at wokeAt, and a LIVE
 * working session was idle-reaped (incident: mrbrowser killed mid-task, last turn 7 s before the reap).
 * Growing guarantees we eventually read the full last record (worst case: the entire file), so a present
 * timestamp is NEVER missed. The default window already covers the common case in one read; growth only
 * kicks in for oversized tail records, and even then is bounded (≈log2(fileSize/tailBytes) reads).
 *
 * A partial LEADING line is never trusted: once the window starts past byte 0, the first split segment
 * may be the truncated tail of an earlier record (which could mis-parse as valid JSON), so we scan only
 * the newline-bounded segments after it. Reaching byte 0 makes every segment complete, including the
 * first — and terminates the growth.
 */
/**
 * The FIRST newline-terminated line of a file, read with an ADAPTIVE growing window — NEVER the whole
 * file. A codex `session_meta` first line carries the full instruction payload (measured 29–73 KB on the
 * live host), so a fixed small chunk would miss the terminating `\n` and return a truncated line; the
 * window doubles (capped at file size) until a `\n` is seen or the whole file is read. Returns null when
 * the file is unreadable/empty. Cheap for the common case (one read covers it), bounded otherwise.
 */
export function readFirstLine(path: string, chunkBytes = 65536): string | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const size = statSync(path).size
    if (size <= 0) return null
    let window = Math.max(chunkBytes, 1)
    for (;;) {
      const len = Math.min(window, size)
      const buf = Buffer.allocUnsafe(len)
      let read = 0
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, read)
        if (n <= 0) break
        read += n
      }
      const text = buf.subarray(0, read).toString('utf8')
      const nl = text.indexOf('\n')
      if (nl >= 0) return text.slice(0, nl).replace(/\r$/, '')
      if (len >= size) return text.replace(/\r$/, '') // whole file, no trailing newline → the single line
      window *= 2
    }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** Memoized path→cwd. session_meta is written ONCE at session start (immutable) and session-file paths
 *  are unique, so caching a DEFINITIVE parse is sound. Only the unreadable/empty case (readFirstLine
 *  null) is NOT cached — that can become readable. */
const codexCwdCache = new Map<string, string | null>()

/**
 * The cwd a codex session was opened in — the `session_meta.payload.cwd` of the FIRST jsonl line — read
 * via the bounded readFirstLine and memoized by path. Replaces the old full-file readFileSync that ran
 * per-file on every hot-path scan (superviseTick, ready-gate, delivery baseline). Returns null when the
 * file is missing/unreadable or carries no session_meta cwd.
 */
export function codexSessionCwd(file: string): string | null {
  const cached = codexCwdCache.get(file)
  if (cached !== undefined) return cached
  const firstLine = readFirstLine(file)
  if (firstLine === null) return null // unreadable/empty — do NOT cache (may become readable)
  let cwd: string | null = null
  try {
    const entry = JSON.parse(firstLine) as { type?: unknown; payload?: { cwd?: unknown } }
    if (entry.type === 'session_meta' && typeof entry.payload?.cwd === 'string') cwd = entry.payload.cwd
  } catch {
    cwd = null
  }
  codexCwdCache.set(file, cwd)
  return cwd
}

export function lastTimestampedEntryMs(path: string, tailBytes = 65536): number | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const size = statSync(path).size
    if (size <= 0) return null
    let window = Math.max(tailBytes, 1)
    for (;;) {
      const start = Math.max(0, size - window)
      const len = size - start
      const buf = Buffer.allocUnsafe(len)
      let read = 0
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, start + read)
        if (n <= 0) break
        read += n
      }
      const atFileStart = start === 0
      const lines = buf.subarray(0, read).toString('utf8').split(/\r?\n/)
      // Segment 0 is a complete record ONLY when the window reaches byte 0; otherwise it is the possibly
      // truncated tail of an earlier record and must not be parsed (`floor` skips it).
      const floor = atFileStart ? 0 : 1
      for (let i = lines.length - 1; i >= floor; i--) {
        const line = lines[i].trim()
        if (!line) continue
        let obj: unknown
        try {
          obj = JSON.parse(line)
        } catch {
          continue // metadata fragment / non-json → skip
        }
        const ts = (obj as { timestamp?: unknown })?.timestamp
        if (typeof ts === 'string') {
          const ms = Date.parse(ts)
          if (!Number.isNaN(ms)) return ms
        } else if (typeof ts === 'number' && Number.isFinite(ts)) {
          return ts
        }
      }
      // No complete timestamped entry in this window. If the whole file is read, there genuinely is none.
      // Otherwise the tail record outgrows the window → grow and retry (terminates: window hits size → start 0).
      if (atFileStart) return null
      window *= 2
    }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}
