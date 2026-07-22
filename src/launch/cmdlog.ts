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

// VOLUME RETENTION (gcPaneLogs, below) is the SECOND half of the bound. Per-file rotation caps one
// identity (16 MiB base + N×16 MiB copies), but the DIRECTORY total is then a product of the fleet
// size — it only ever grows with peers × runtimes, and nothing ever reclaimed the artifacts of a peer
// that died or was removed months ago. The janitor therefore also enforces an age retention and a
// hard directory BUDGET each tick, so the ceiling is a fixed number instead of a per-peer multiple.

import {
  openSync,
  closeSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  fstatSync,
  renameSync,
  utimesSync,
} from 'fs'
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

/** Directory BUDGET (env IAPEER_PANELOG_DIR_BUDGET) — the observable ceiling on the WHOLE
 *  pane-log dir, enforced every tick by gcPaneLogs. Default 512 MiB. Sized off the live shape of
 *  this host: the artifacts that are load-bearing are the bases of CONCURRENTLY warm sessions
 *  (~12 × ≤16 MiB here), everything else is history. See gcPaneLogs for the honest boundary. */
export const PANELOG_DIR_BUDGET_BYTES = 512 * 1024 * 1024
/** Age retention (env IAPEER_PANELOG_STALE_DAYS) — any pane-log artifact untouched for longer is
 *  reclaimed. Default 14 d: FAR beyond any live signal (idle-reap kills a warm session in minutes,
 *  the ready-gate seed and the mtime-occupancy contract only ever read a CURRENT session's base),
 *  so a base this cold belongs to a peer that is dead, removed, or renamed. A wake recreates it. */
export const PANELOG_STALE_MS = 14 * 24 * 60 * 60 * 1000

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

// ─────────────────────────── volume retention (dir budget) ───────────────────────────

/** Resolve the retention knobs from env (defaults above). */
export function paneLogGcConfig(env: NodeJS.ProcessEnv = process.env): { budgetBytes: number; staleMs: number } {
  const days = env.IAPEER_PANELOG_STALE_DAYS
  const staleDays = days !== undefined && Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 14
  return {
    budgetBytes: envPosInt(env.IAPEER_PANELOG_DIR_BUDGET, PANELOG_DIR_BUDGET_BYTES),
    staleMs: Math.round(staleDays * 24 * 60 * 60 * 1000),
  }
}

/** One pane-log artifact on disk. `base` = `<identity>.log` (live-readable), else a rotated copy. */
type PaneLogArtifact = { path: string; size: number; mtimeMs: number; base: boolean }

/** Snapshot the dir's artifacts (bases + rotated copies). Unreadable entries are skipped. */
function scanPaneLogs(logDir: string): PaneLogArtifact[] {
  let names: string[]
  try {
    names = readdirSync(logDir)
  } catch {
    return []
  }
  const out: PaneLogArtifact[] = []
  for (const name of names) {
    const base = name.endsWith('.log')
    if (!base && !/\.log\.\d+$/.test(name)) continue // only OUR artifacts — never a foreign file
    const path = join(logDir, name)
    try {
      const st = statSync(path)
      if (st.isFile()) out.push({ path, size: st.size, mtimeMs: st.mtimeMs, base })
    } catch {
      /* vanished mid-scan → fine */
    }
  }
  return out
}

/** Truncate a base IN PLACE to its last tailBytes, PRESERVING its mtime. Same inode (writer's
 *  O_APPEND fd + В19 heal survive, exactly as rotateFile step 3), and the mtime restore keeps the
 *  pane-log OCCUPANCY contract honest: a janitor write must never masquerade as peer activity.
 *  Returns the bytes reclaimed (0 on no-op/error). */
function shrinkBase(path: string, tailBytes: number): number {
  try {
    const st = statSync(path)
    if (st.size <= tailBytes) return 0
    const tail = readTail(path, tailBytes)
    if (tail === null) return 0
    writeFileSync(path, tail, { mode: 0o600 })
    try {
      utimesSync(path, st.atime, st.mtime) // janitor ≠ activity
    } catch {
      /* best-effort */
    }
    return st.size - tail.length
  } catch {
    return 0
  }
}

/** What one GC pass did — observability for the supervise-tick trace. */
export type PaneLogGcResult = {
  bytesBefore: number
  bytesAfter: number
  /** Artifacts deleted by the AGE retention (dead/removed peers, ancient rotations). */
  reapedStale: number
  /** Rotated copies deleted by the BUDGET, oldest first. */
  droppedCopies: number
  /** Live bases shrunk to the reader-floor as the budget backstop. */
  shrunkBases: number
  /** True when even the backstop could not reach the budget — see the honest boundary below. */
  overBudget: boolean
}

/**
 * RETENTION pass over the pane-log dir — turns the per-file rotation bound into a DIRECTORY bound.
 * Runs right after capPaneLogs on every supervise tick (idempotent, best-effort, no manual step),
 * reclaiming in cheapest-loss-first order:
 *
 *   1. AGE — every artifact (base OR copy) untouched for > staleMs is deleted. This is what finally
 *      reclaims peers that died, were removed, or renamed: nothing live reads a base that cold, and
 *      the supervisor recreates it on the next wake.
 *   2. BUDGET / copies — while the dir exceeds budgetBytes, delete rotated copies OLDEST FIRST.
 *      Copies are history nobody reads live, so they are the correct first casualty.
 *   3. BUDGET / backstop — if copies ran out and the dir is STILL over, shrink the largest bases to
 *      the reader-floor (tailBytes, ≥ the ready-gate seed window) with mtime preserved.
 *
 * HONEST BOUNDARY: the floor of step 3 is `live-identities × tailBytes` (8 MiB each). The budget is
 * therefore authoritative up to ~`budgetBytes / tailBytes` concurrently warm identities (~64 at the
 * defaults); beyond that the reader-floor wins, `overBudget` comes back true, and the budget must be
 * raised via IAPEER_PANELOG_DIR_BUDGET. Truncating below the seed window would starve
 * occupancy/ready-gate detection, so the floor deliberately outranks the budget.
 */
export function gcPaneLogs(
  logDir: string,
  opts: { budgetBytes?: number; staleMs?: number; tailBytes?: number; nowMs?: number } = {},
): PaneLogGcResult {
  const budgetBytes = opts.budgetBytes ?? PANELOG_DIR_BUDGET_BYTES
  const staleMs = opts.staleMs ?? PANELOG_STALE_MS
  const tailBytes = opts.tailBytes ?? PANELOG_TAIL_BYTES
  const nowMs = opts.nowMs ?? Date.now()

  let live = scanPaneLogs(logDir)
  const bytesBefore = live.reduce((s, a) => s + a.size, 0)
  const res: PaneLogGcResult = {
    bytesBefore,
    bytesAfter: bytesBefore,
    reapedStale: 0,
    droppedCopies: 0,
    shrunkBases: 0,
    overBudget: false,
  }
  if (live.length === 0) return res

  let total = bytesBefore
  const drop = (a: PaneLogArtifact): boolean => {
    try {
      unlinkSync(a.path)
      total -= a.size
      return true
    } catch {
      return false // per-file best-effort — retention never fails a supervise tick
    }
  }

  // 1 — AGE retention.
  const staleCutoff = nowMs - staleMs
  const kept: PaneLogArtifact[] = []
  for (const a of live) {
    if (a.mtimeMs < staleCutoff && drop(a)) res.reapedStale++
    else kept.push(a)
  }
  live = kept

  // 2 — BUDGET: rotated copies, oldest first.
  if (total > budgetBytes) {
    const copies = live.filter((a) => !a.base).sort((x, y) => x.mtimeMs - y.mtimeMs)
    for (const a of copies) {
      if (total <= budgetBytes) break
      if (drop(a)) res.droppedCopies++
    }
  }

  // 3 — BUDGET backstop: shrink the largest bases to the reader-floor.
  if (total > budgetBytes) {
    const bases = live.filter((a) => a.base && a.size > tailBytes).sort((x, y) => y.size - x.size)
    for (const a of bases) {
      if (total <= budgetBytes) break
      const freed = shrinkBase(a.path, tailBytes)
      if (freed > 0) {
        total -= freed
        res.shrunkBases++
      }
    }
  }

  res.bytesAfter = total
  res.overBudget = total > budgetBytes
  return res
}
