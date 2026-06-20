// Pane-log volume cap — tail-keep the per-identity pane-logs (<logDir>/<identity>.log), the RAW child
// pty byte stream the supervisor appends for a session's whole life. Unlike the lifecycle/delivery logs
// (their own size-rotation under logs/iapeer), the pane-log had NO bound and grew to hundreds of MB per
// warm peer on an always-on host; the supervise tick caps it here. Best-effort BY CONSTRUCTION: a cap
// must never fail a supervise tick — every export swallows FS errors.

import { openSync, closeSync, readSync, readdirSync, statSync, writeFileSync, fstatSync } from 'fs'
import { join } from 'path'

/** Pane-log tail-keep cap (capPaneLogs): a per-identity pane-log over CAP is cut to
 *  its last KEEP. KEEP_BYTES INVARIANT — must stay ≥ the pane-log reader's seed
 *  window (readyGateModel SEED_BYTES = 4 MiB, the tail fed into the headless xterm
 *  for composer-occupancy / viewport detection); capping below it would starve that
 *  reader of the tail it reconstructs the live screen from. 8 MiB = 2× the seed. */
export const PANELOG_CAP_BYTES = 32 * 1024 * 1024
export const PANELOG_KEEP_BYTES = 8 * 1024 * 1024

/** Tail-keep ONE file: if it exceeds capBytes, rewrite it as its last keepBytes.
 *  Safe against a live O_APPEND writer (the supervisor append-fd):
 *  the next write lands at the new EOF (proven by live truncation test). Lines
 *  appended between the tail-read and the rewrite are lost — acceptable mid-life
 *  noise. Returns true iff the file was capped. Best-effort: swallows FS errors. */
function tailKeepFile(path: string, capBytes: number, keepBytes: number): boolean {
  try {
    if (statSync(path).size <= capBytes) return false
    const fd = openSync(path, 'r')
    let tail: Buffer
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - keepBytes)
      tail = Buffer.alloc(Math.min(keepBytes, size))
      readSync(fd, tail, 0, tail.length, start)
    } finally {
      closeSync(fd)
    }
    writeFileSync(path, tail, { mode: 0o600 })
    return true
  } catch {
    return false // per-file best-effort
  }
}

/** Tail-keep cap over the per-identity PANE-LOGS (<logDir>/<identity>.log) — the RAW
 *  TUI byte stream that pipe-pane (tmux) / the supervisor append for a session's whole
 *  life. Unlike the lifecycle/delivery logs (their own size-rotation under logs/iapeer),
 *  the pane-log had NO bound and grew to hundreds of MB per warm peer on an always-on
 *  host. The supervise tick caps it here with the same tail-keep mechanism as the
 *  cmd-logs. logDir (logs/lifecycle) holds ONLY pane-logs, so only top-level *.log is
 *  touched — never the rotated logs elsewhere. KEEP_BYTES stays ≥ the reader seed
 *  window (see PANELOG_KEEP_BYTES). Best-effort by construction. */
export function capPaneLogs(
  logDir: string,
  capBytes: number = PANELOG_CAP_BYTES,
  keepBytes: number = PANELOG_KEEP_BYTES,
): string[] {
  const capped: string[] = []
  let names: string[]
  try {
    names = readdirSync(logDir)
  } catch {
    return capped
  }
  for (const name of names) {
    if (!name.endsWith('.log')) continue
    const path = join(logDir, name)
    if (tailKeepFile(path, capBytes, keepBytes)) capped.push(path)
  }
  return capped
}
