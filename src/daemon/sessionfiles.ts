// Session-file reading — the ONE place that knows how to get evidence out of a runtime's own
// session JSONL (claude transcript / codex rollout). Shared by every cwd-attributed detector:
// mutewatch (docs/19), turnwatch (docs/15 §Activity).
//
// WHY THIS MODULE EXISTS — a bug, measured on real bytes 16.07.2026.
//
// Both detectors need two slices of a session file: the TAIL (where the evidence is) and, for
// codex, the HEAD (where `session_meta` states the cwd that attributes the file to a peer). The
// head was read as a FIXED 64 KB slice. That is wrong, and it failed silently:
//
//   `session_meta` is ONE line, and it carries the session's composed doctrine — so its size
//   scales with the peer's own instructions. Measured on this host: 45 KB for one peer, 65 KB
//   for another, and **79 KB** for another. A 64 KB slice cuts that line mid-JSON, the parse
//   throws, no cwd is ever found, and the file is treated as unattributable — i.e. as a human's
//   own session. The peer VANISHES from the detector entirely.
//
// The failure mode is the nastiest kind: no error, no log, no partial result — a real peer that
// simply never appears, and the bigger its doctrine the more certainly it disappears. It was
// invisible in tests because fixtures have small metas; it surfaced only against the live tree,
// where the peer with the largest doctrine was the one silently missing.
//
// THE RULE: never slice a line at a fixed size to parse it. Read the LINE. `readFirstLine`
// scans forward until the first newline (bounded), so it is correct at any doctrine size and
// costs one extra chunk read only for the files that need it.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/** Chunk size for the forward scan. One read covers the common case. */
const HEAD_CHUNK_BYTES = 64 * 1024

/**
 * Upper bound on the first line. Generous on purpose — a doctrine can grow, and the cost of
 * being wrong is a peer disappearing, while the cost of a larger bound is one read of a file
 * we are already reading. A line longer than this yields '' (unattributable) rather than a
 * truncated parse that would lie.
 */
export const MAX_FIRST_LINE_BYTES = 4 * 1024 * 1024

/**
 * The file's FIRST LINE (without the trailing newline), read forward in bounded chunks.
 * Returns '' if the bound is hit before a newline — the honest "cannot read it" rather than a
 * fragment. Never throws.
 */
export function readFirstLine(path: string, maxBytes = MAX_FIRST_LINE_BYTES): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    if (size <= 0) return ''
    const limit = Math.min(size, maxBytes)
    let acc = ''
    let off = 0
    while (off < limit) {
      const want = Math.min(HEAD_CHUNK_BYTES, limit - off)
      const buf = Buffer.alloc(want)
      const got = readSync(fd, buf, 0, want, off)
      if (got <= 0) break
      const chunk = buf.subarray(0, got).toString('utf8')
      const nl = chunk.indexOf('\n')
      if (nl >= 0) return acc + chunk.slice(0, nl)
      acc += chunk
      off += got
    }
    // Reached EOF within the bound with no newline: the whole file IS one line — return it.
    // (`off < limit` above only exits early when we hit the bound BEFORE EOF; a file smaller
    // than the bound falls through to here with its complete single line in `acc`.)
    if (off >= size) return acc
    return '' // hit the bound before EOF → refuse to hand back a fragment of a longer line
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* best-effort */
      }
    }
  }
}

export interface SessionSlices {
  /** The last `tailBytes` of the file — where every detector's evidence lives. */
  tail: string
  /** The file's first line, when the tail did not already contain the file start. Empty
   *  otherwise (the tail already has it) or when it could not be read. */
  head: string
}

/**
 * Read a session file's tail plus, when the tail cut the start away, its first line.
 * Returns null for an empty/unreadable file. Never throws — a detector sweep must survive any
 * file on disk.
 */
export function readSessionSlices(path: string, tailBytes: number): SessionSlices | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    if (size <= 0) return null
    const off = Math.max(0, size - tailBytes)
    const buf = Buffer.alloc(size - off)
    readSync(fd, buf, 0, buf.length, off)
    const tail = buf.toString('utf8')
    closeSync(fd)
    fd = null
    // Only when the tail cut the start away does the first line need its own read.
    const head = off > 0 ? readFirstLine(path) : ''
    return { tail, head }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* best-effort */
      }
    }
  }
}
