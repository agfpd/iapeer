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
 * file's TAIL (cheap — only the last `tailBytes` are read). Metadata records without a `timestamp`
 * (claude `mode` / `ai-title` / `bridge-session`) are skipped. Returns null when the file is
 * unreadable or no timestamped entry sits in the tail (the caller then floors at wokeAt). A partial
 * FIRST line in the tail buffer is harmless: we scan from the END and return on the first complete
 * timestamped entry, so a truncated leading line is only ever reached (and skipped) when nothing
 * matched.
 */
export function lastTimestampedEntryMs(path: string, tailBytes = 65536): number | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - tailBytes)
    const len = size - start
    if (len <= 0) return null
    const buf = Buffer.allocUnsafe(len)
    let read = 0
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read)
      if (n <= 0) break
      read += n
    }
    const lines = buf.subarray(0, read).toString('utf8').split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        continue // partial leading line / non-json → skip
      }
      const ts = (obj as { timestamp?: unknown })?.timestamp
      if (typeof ts === 'string') {
        const ms = Date.parse(ts)
        if (!Number.isNaN(ms)) return ms
      } else if (typeof ts === 'number' && Number.isFinite(ts)) {
        return ts
      }
    }
    return null
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}
