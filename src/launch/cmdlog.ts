// Pane-log volume ROTATION — bound the per-identity pane-logs (<logDir>/<identity>.log),
// the RAW child pty byte stream the supervisor appends for a session's whole life. Unlike
// the daemon lifecycle/delivery/approvals logs (their own size+copies rotation under
// logs/iapeer via storage/rotatelog.ts), the pane-log had NO bound and grew to tens of MB
// per warm peer AND per always-on router on this host; the supervise tick rotates it here.
//
// MECHANISM — COPYTRUNCATE, not rename. The pane-log is written by a LONG-LIVED supervisor
// holding a persistent O_APPEND fd (a different process from this daemon-side janitor), and
// it is READ live by load-bearing consumers: telegram-runtime's occupancy signal keys on
// the file's MTIME at its fixed path (canon: the pane-log occupancy contract), the boot
// ready-gate seeds a headless xterm from the tail, doc's monitor tail -c's it. A rename
// would move the writer's fd onto the rotated inode and briefly vanish the base path —
// breaking mtime-occupancy. So rotation keeps the base INODE and PATH: it copies the base's
// last maxBytes out to <path>.1 (shifting older copies up), then TRUNCATES the base in place
// to its last tailBytes. Same inode ⇒ the supervisor's O_APPEND fd resumes at the new EOF
// (proven by the live truncation test), mtime stays fresh, and the В19 heal never sees an
// inode change (no spurious reopen). Readers keep reading the same path; the rotated copies
// (<path>.1..N) are history nobody reads live.
//
// Best-effort BY CONSTRUCTION: rotation must never fail a supervise tick — every FS op
// swallows errors. The dropped head of an already-oversized legacy file is redraw noise; the
// last maxBytes is snapshotted, older bytes are discarded (never a giant copy of the bloat).

import { openSync, closeSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync, fstatSync, renameSync } from 'fs'
import { join } from 'path'

/** Rotate threshold (env IAPEER_PANELOG_MAX_BYTES) — a base pane-log over this is rotated.
 *  Default 16 MiB (owner direction 12.07: order 10–20 MiB × 2–3 copies). */
export const PANELOG_MAX_BYTES = 16 * 1024 * 1024
/** Number of rotated copies kept (env IAPEER_PANELOG_KEEP) — <path>.1 (newest) … .N. Default 2. */
export const PANELOG_COPIES = 2
/** Base TAIL kept in place after a rotation. INVARIANT: ≥ the pane-log reader's seed window
 *  (readyGateModel SEED_BYTES = 4 MiB, the tail fed into the headless xterm for
 *  composer-occupancy / viewport). 8 MiB = 2× the seed. This is the reader-floor the base is
 *  truncated to — NOT the copy count (that is IAPEER_PANELOG_KEEP). Internal invariant, not
 *  env-tunable: capping the base below the seed would starve occupancy/ready-gate detection. */
export const PANELOG_TAIL_BYTES = 8 * 1024 * 1024

/** Parse a positive integer env value, else the default (mirror of the daemon-log config helpers). */
function envPosInt(raw: string | undefined, dflt: number): number {
  const n = raw !== undefined ? Number(raw) : NaN
  return Number.isInteger(n) && n > 0 ? n : dflt
}

/** Resolve the pane-log rotation knobs from env (defaults above). maxBytes is floored just
 *  above the reader-tail so the base can always drop below the threshold after a rotation
 *  (else rotation would fire every tick). */
export function paneLogRotateConfig(env: NodeJS.ProcessEnv = process.env): { maxBytes: number; copies: number } {
  const maxBytes = Math.max(envPosInt(env.IAPEER_PANELOG_MAX_BYTES, PANELOG_MAX_BYTES), PANELOG_TAIL_BYTES + 1024 * 1024)
  return { maxBytes, copies: envPosInt(env.IAPEER_PANELOG_KEEP, PANELOG_COPIES) }
}

/** Read the last wantBytes of a file into a Buffer (or null on error / absent). */
function readTail(path: string, wantBytes: number): Buffer | null {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - wantBytes)
      const buf = Buffer.alloc(Math.min(wantBytes, size))
      if (buf.length > 0) readSync(fd, buf, 0, buf.length, start)
      return buf
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Rotate ONE pane-log file if it exceeds maxBytes (copytruncate — see file header):
 *   1. snapshot the base's last maxBytes (bounded — never a giant copy of legacy bloat)
 *   2. shift .（k）→.（k+1）, dropping the oldest beyond `copies`; write the snapshot to .1
 *   3. truncate the base IN PLACE to its last tailBytes (same inode: writer fd + mtime +
 *      reader seed all survive; no В19 reopen)
 *  Returns true iff rotated. Best-effort: swallows FS errors. */
function rotateFile(path: string, maxBytes: number, copies: number, tailBytes: number): boolean {
  try {
    if (statSync(path).size <= maxBytes) return false
    // 1 — snapshot the tail we promote to .1, taken BEFORE any truncate (copytruncate race:
    //     bytes appended between here and the truncate are lost — accepted mid-life noise,
    //     same as the pre-rotation tail-keep).
    const rotBuf = readTail(path, maxBytes)
    if (rotBuf === null || rotBuf.length === 0) return false
    // 2 — shift existing copies up, dropping the oldest; also sweep one orphan beyond the
    //     current copy count (handles a just-lowered IAPEER_PANELOG_KEEP).
    try {
      unlinkSync(`${path}.${copies + 1}`)
    } catch {
      /* absent → fine */
    }
    for (let k = copies - 1; k >= 1; k--) {
      try {
        renameSync(`${path}.${k}`, `${path}.${k + 1}`)
      } catch {
        /* absent → skip */
      }
    }
    if (copies >= 1) writeFileSync(`${path}.1`, rotBuf, { mode: 0o600 })
    // 3 — tail-keep the base in place (last tailBytes of the snapshot; same inode).
    const tail = tailBytes >= rotBuf.length ? rotBuf : rotBuf.subarray(rotBuf.length - tailBytes)
    writeFileSync(path, tail, { mode: 0o600 })
    return true
  } catch {
    return false // per-file best-effort — a rotation never fails a supervise tick
  }
}

/**
 * Rotate the per-identity PANE-LOGS in logDir (logs/lifecycle). Scans top-level `*.log`
 * only — the rotated copies are `<identity>.log.1..N` (do NOT end in `.log`), so they are
 * never re-processed, and no other log lives here. Called each supervise tick (NOT H4-gated:
 * log janitoring is orthogonal to lifecycle ownership, so launchd-managed routers' pane-logs
 * are rotated too). maxBytes/copies come from paneLogRotateConfig(env). Best-effort by
 * construction. Returns the rotated paths.
 */
export function capPaneLogs(
  logDir: string,
  maxBytes: number = PANELOG_MAX_BYTES,
  copies: number = PANELOG_COPIES,
  tailBytes: number = PANELOG_TAIL_BYTES,
): string[] {
  const cap = Math.max(maxBytes, tailBytes + 1024 * 1024) // base(tail) must be able to drop below cap
  const rotated: string[] = []
  let names: string[]
  try {
    names = readdirSync(logDir)
  } catch {
    return rotated
  }
  for (const name of names) {
    if (!name.endsWith('.log')) continue // skips the rotated <identity>.log.1/.2
    const path = join(logDir, name)
    if (rotateFile(path, cap, copies, tailBytes)) rotated.push(path)
  }
  return rotated
}
