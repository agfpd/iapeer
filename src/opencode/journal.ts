// Core-side reader/writer of the OpenCode observability ABI (docs/20 §Observability ABI).
// The in-process plugin (iapeer-plugin.mjs) is the producer while the process lives; the core
// writes ONLY when the process is gone (supervisor death record) — so the journal stays
// single-writer at every instant. seq continues from the journal tail.
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'

export type OpencodeStatus = 'starting' | 'idle' | 'busy' | 'approval' | 'error' | 'stopped'

export interface OpencodeState {
  schema: 1
  identity: string
  cwd: string
  sessionID: string | null
  launchID: string
  startedAt: number
  lastEventSeq: number
  lastActivityMs: number
  status: OpencodeStatus
  error?: string
  /** Actual `provider/model` of the last assistant turn (plugin-reported). */
  model?: string
  /** Launch self-check findings (missing/failed plugin, MCP not connected) — docs/20 OC04. */
  warnings?: string[]
}

export interface OpencodeJournalLine {
  schema: 1
  seq: number
  time: number
  identity: string
  launchID: string
  sessionID: string | null
  type: string
  properties: unknown
  nativeID: string | null
}

export function readOpencodeState(path: string): OpencodeState | null {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as OpencodeState
    return s && typeof s === 'object' && typeof s.launchID === 'string' ? s : null
  } catch {
    return null
  }
}

function writeStateAtomic(path: string, state: OpencodeState): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

/** Parsed journal lines appended at or after byte `offset` (a partial trailing line is skipped). */
export function readJournalFrom(path: string, offset: number): { lines: OpencodeJournalLine[]; end: number } {
  if (!existsSync(path)) return { lines: [], end: 0 }
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size <= offset) return { lines: [], end: size }
    const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset)
    const text = buf.toString('utf8')
    const lastNl = text.lastIndexOf('\n')
    if (lastNl < 0) return { lines: [], end: offset }
    const lines: OpencodeJournalLine[] = []
    for (const raw of text.slice(0, lastNl).split('\n')) {
      if (!raw) continue
      try {
        lines.push(JSON.parse(raw) as OpencodeJournalLine)
      } catch {
        /* a malformed line is not ours to repair; consumers dedup by seq */
      }
    }
    return { lines, end: offset + Buffer.byteLength(text.slice(0, lastNl + 1)) }
  } finally {
    closeSync(fd)
  }
}

/**
 * Journal ROTATION (docs/20 §Observability ABI, since 0.4.169). The producer renames
 * `events.jsonl` → `events.jsonl.1` (older generations shift up to `.<KEEP>`, the oldest is
 * dropped) BEFORE an append that would push the live file past the rotate size, so the newest line
 * is always in the live file and every rename happens under the single writer. The live file plus
 * `.1` together never exceed 2 × rotate size — one bounded read covers the recent evidence.
 * Incident 12.11: an unrotated opencode-doc journal reached 284 MB.
 */
export const OPENCODE_JOURNAL_ROTATE_BYTES = 8 * 1024 * 1024
export const OPENCODE_JOURNAL_KEEP = 4

/** Rotate `path` if appending `incoming` bytes would push a non-empty live file past `rotateBytes`. */
export function rotateJournalIfNeeded(path: string, incoming: number, rotateBytes = OPENCODE_JOURNAL_ROTATE_BYTES, keep = OPENCODE_JOURNAL_KEEP): boolean {
  let size: number
  try { size = statSync(path).size } catch { return false }
  if (size === 0 || size + incoming <= rotateBytes) return false
  for (let g = keep - 1; g >= 1; g--) {
    try { renameSync(`${path}.${g}`, `${path}.${g + 1}`) } catch { /* generation absent */ }
  }
  renameSync(path, `${path}.1`)
  return true
}

/**
 * The newest ≤ `maxBytes` of the journal ACROSS rotation (`.1` then the live file), starting at a
 * line boundary. `complete` = nothing older than the returned text exists in `.1`+live (i.e. it
 * starts at the start of `.1`, or of the live file when there is no `.1`) — a reader that needs a
 * complete native record gets the same fail-closed signal it had before rotation existed.
 */
export function readJournalTail(path: string, maxBytes: number): { text: string; complete: boolean } {
  const read = (p: string, bytes: number): { text: string; whole: boolean } => {
    let fd: number | undefined
    try {
      fd = openSync(p, 'r')
      const size = fstatSync(fd).size
      const start = Math.max(0, size - bytes)
      const buf = Buffer.alloc(size - start)
      const n = readSync(fd, buf, 0, buf.length, start)
      let text = buf.subarray(0, n).toString('utf8')
      if (start > 0) text = text.slice(text.indexOf('\n') + 1) // drop the cut first line
      return { text, whole: start === 0 }
    } catch {
      return { text: '', whole: true }
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  const live = read(path, maxBytes)
  const liveBytes = Buffer.byteLength(live.text)
  if (!live.whole || liveBytes >= maxBytes) return { text: live.text, complete: live.whole && !existsSync(`${path}.1`) }
  if (!existsSync(`${path}.1`)) return { text: live.text, complete: true }
  const older = read(`${path}.1`, maxBytes - liveBytes)
  const prefix = older.text && !older.text.endsWith('\n') ? older.text.slice(0, older.text.lastIndexOf('\n') + 1) : older.text
  return { text: prefix + live.text, complete: older.whole }
}

/** Last `seq` in the journal (tail read), falling back to `.1` when the live file was just rotated
 *  and holds no line yet. 0 when absent/empty. */
export function lastJournalSeq(path: string): number {
  const live = lastJournalSeqIn(path)
  return live > 0 ? live : lastJournalSeqIn(`${path}.1`)
}

function lastJournalSeqIn(path: string): number {
  if (!existsSync(path)) return 0
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    let span = 4096
    while (true) {
      const start = Math.max(0, size - span)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      const lines = buf.toString('utf8').split('\n').filter(Boolean)
      for (let i = lines.length - 1; i >= (start === 0 ? 0 : 1); i--) {
        try {
          const seq = (JSON.parse(lines[i]!) as { seq?: unknown }).seq
          if (Number.isInteger(seq)) return seq as number
        } catch {
          /* skip */
        }
      }
      if (start === 0) return 0
      span *= 4
    }
  } finally {
    closeSync(fd)
  }
}

export function fileMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * Supervisor-side death record: the process is gone, so the plugin cannot write `stopped`
 * (dispose does not run on a signal). Appends exactly one `runtime.stopped` for the launch in
 * state.json and flips status → stopped. Idempotent: a launch whose state already says stopped
 * (graceful dispose wrote it) is left untouched. No state file → nothing launched → no record.
 */
export function recordOpencodeStopped(
  paths: { state: string; events: string },
  info: { reason: string; exitCode?: number; signal?: string },
  now: number = Date.now(),
): boolean {
  const state = readOpencodeState(paths.state)
  if (!state || state.status === 'stopped') return false
  const seq = Math.max(lastJournalSeq(paths.events), state.lastEventSeq) + 1
  const properties: Record<string, unknown> = { reason: info.reason }
  if (info.exitCode !== undefined) properties.exitCode = info.exitCode
  if (info.signal !== undefined) properties.signal = info.signal
  const line: OpencodeJournalLine = {
    schema: 1,
    seq,
    time: now,
    identity: state.identity,
    launchID: state.launchID,
    sessionID: state.sessionID,
    type: 'runtime.stopped',
    properties,
    nativeID: null,
  }
  appendFileSync(paths.events, JSON.stringify(line) + '\n', { mode: 0o600 })
  writeStateAtomic(paths.state, { ...state, status: 'stopped', lastEventSeq: seq, lastActivityMs: now })
  return true
}
