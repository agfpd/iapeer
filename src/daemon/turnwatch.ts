// Turn-watch — per-runtime TURN ACTIVITY for the fleet surface (docs/15 §Activity).
//
// WHY THIS EXISTS. The snapshot answered exactly one question about a session: is the process
// alive (`status: live | asleep | stopped`). That is LIVENESS, and it is not the operator's
// question. A peer sitting idle with an unfinished job and a peer grinding through a turn are
// both `live` — indistinguishable. The owner spotted a stalled peer before the PM twice
// because the surface could not tell "working" from "merely alive".
//
// ACTIVITY IS NOT LIVENESS, AND THEY STAY SEPARATE. `status` keeps its exact meaning; the new
// `activity` field is additive and rides ALONGSIDE it on the same per-runtime object. A client
// that ignores `activity` is unaffected. Activity is reported ONLY for a `live` runtime — for
// an asleep/stopped session there is no turn to be in, and the field is OMITTED rather than
// filled with a fake `idle`: absent means "no claim", which a dead session deserves.
//
// THE EVIDENCE IS THE RUNTIME'S OWN TURN MARKER — mechanical, never a CPU/mtime reconstruction:
//
//   • codex → the rollout's `event_msg` payloads `task_started` / `task_complete`. Explicit
//     turn boundaries; the last one wins. Measured across 3 days of real rollouts: 156 started
//     / 147 complete — the 9-line gap is precisely the dangling-turn risk the stale bound below
//     exists for. Codex emits `task_complete` even for a turn that ended on an error (measured:
//     the 16.07 goal-blocking turn ends token_count → task_complete, no error event), so the
//     terminal error path needs no separate marker.
//
//   • claude → the transcript's assistant `stop_reason`. `tool_use` means the turn CONTINUES;
//     every other terminal reason means it ended. Measured over every transcript this peer has:
//     tool_use 18317, end_turn 663, stop_sequence 16, null 4. So the rule is deliberately
//     ASYMMETRIC — only `tool_use` reads as working, and anything else (end_turn, stop_sequence,
//     max_tokens, refusal, an unknown future value, null) reads as IDLE. An unknown reason must
//     never invent work; the polarity always fails toward idle.
//
// THE THREE FALSE-WORKING TRAPS, each measured on real transcripts rather than assumed:
//
//   1. **A `user` line means working** (the model is about to answer, or a tool_result just
//      landed) — but claude writes NON-model user lines too. A compaction summary is
//      `type:"user"` with `isCompactSummary:true` (12 found here), and a `/compact` run while
//      IDLE would leave one as the last line → a permanent phantom "working". Excluded. The
//      `compact_boundary` line is `type:"system"` and never qualifies anyway. Excluding the
//      summary is also CORRECT for mid-turn compaction: the prior assistant `tool_use` line
//      then decides, and the turn is genuinely still running.
//   2. **Sub-agent lines.** A Task sidechain writes assistant/user lines into the SAME
//      transcript with `isSidechain:true`. They belong to a different chain and must not decide
//      the peer's turn state. Excluded.
//   3. **Injected meta lines** (`isMeta:true`, 13 found here) are not the model being asked
//      anything. Excluded.
//
// THE STALE BOUND. A `working` claim rests on evidence that stops being written the moment a
// session hangs mid-turn — the transcript simply goes quiet. Liveness already removes the dead
// session (activity is live-only), so what remains is a LIVE session whose last recorded act
// was starting work and which has since written nothing. Past TURN_STALE_MS the claim decays to
// `unknown` rather than standing as `working` forever: unknown is the honest word for "we saw
// it start and never saw it finish". `idle` never decays — a session that ended its turn stays
// idle until something pokes it, and age proves nothing against that.
//
// Deliberately NOT the pane-log mtime, which looks like a freshness clock and is not: measured
// live 16.07, an IDLE claude pane-log advances every second (the statusline repaints) while an
// IDLE codex pane-log freezes (39s→46s). The signal means opposite things per runtime; one
// clock that lies differently on each runtime is worse than no clock.

import { existsSync, openSync, closeSync, fstatSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LifecycleConfig } from '../lifecycle/index.ts'
import { appendTurnEvent } from './turnslog.ts'

/** Tail parsed per session file. The turn marker is always at the very end. */
const TAIL_BYTES = 128 * 1024
/** Head slice for codex's `session_meta` (line 1 — a long rollout pushes it out of the tail). */
const HEAD_BYTES = 64 * 1024
/** Walk depth for the codex YYYY/MM/DD tree. */
const CODEX_WALK_DEPTH = 3
/** How far back the FIRST sweep looks, to seed state for sessions already running when the
 *  daemon started. Bounded on purpose: a full-history pass would read every transcript ever.
 *  Measured cost of a 48h seed on this host: ~2 ms of walk, 97 files. */
const SEED_LOOKBACK_MS = 48 * 3_600_000
/** Overlap on the since-boundary so a write landing between sweeps is never missed. */
const SCAN_OVERLAP_MS = 2_000

/**
 * How long a `working` claim outlives its last evidence before decaying to `unknown`.
 * Generous on purpose: a turn legitimately writes NOTHING while one long tool runs (a deploy
 * here takes minutes), and a false `unknown` on a genuinely working peer is a worse lie than a
 * late one. Ten minutes is far past any tool this fleet runs and still bounds the phantom.
 */
export const TURN_STALE_MS = 10 * 60_000

/** The operator-facing verdict. `unknown` = live, but the evidence cannot support a claim. */
export type TurnActivity = 'working' | 'idle' | 'unknown'

export interface TurnState {
  state: 'working' | 'idle'
  /** The EVIDENCE's own timestamp (the transcript line's), never our sweep clock. */
  atMs: number
  cwd: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure parsers — text in, state out (fs-free: tests need no session tree)
// ─────────────────────────────────────────────────────────────────────────────

function toMs(ts: unknown): number | null {
  if (typeof ts !== 'string') return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

/**
 * The claude transcript's turn state, or null if the file states nothing usable.
 *
 * Only `tool_use` continues a turn; every other stop_reason ends it (see the header on why the
 * polarity is asymmetric). Compaction summaries, sidechain lines and meta lines are excluded —
 * each is a measured false-working vector.
 */
export function parseClaudeTurn(text: string): TurnState | null {
  let found: TurnState | null = null
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue // a partial first line from the tail cut
    let d: Record<string, unknown>
    try {
      d = JSON.parse(s) as Record<string, unknown>
    } catch {
      continue // never fail a sweep over one garbled line
    }
    const type = d.type
    if (type !== 'assistant' && type !== 'user') continue
    if (d.isSidechain === true) continue // a sub-agent's chain, not the peer's turn
    if (d.isCompactSummary === true) continue // compaction artifact, not the model being asked
    if (d.isMeta === true) continue // injected, not a real prompt
    const atMs = toMs(d.timestamp)
    if (atMs === null) continue
    const cwd = typeof d.cwd === 'string' ? d.cwd : ''
    if (!cwd) continue // unattributable to a peer → ignore rather than guess
    let state: 'working' | 'idle'
    if (type === 'assistant') {
      const msg = d.message as { stop_reason?: unknown } | undefined
      // ONLY tool_use continues. end_turn / stop_sequence / max_tokens / refusal / an unknown
      // future value / null all mean the assistant stopped.
      state = msg?.stop_reason === 'tool_use' ? 'working' : 'idle'
    } else {
      // A real user line: a prompt to answer or a tool_result to consume — either way the
      // model is on the hook. (The non-model user lines were filtered above.)
      state = 'working'
    }
    found = { state, atMs, cwd }
  }
  return found
}

/**
 * The codex rollout's turn state, or null. `task_started` / `task_complete` are explicit
 * boundaries — the last one wins. `cwd` comes from `session_meta` (line 1), so pass the file
 * HEAD when the tail may have cut it away.
 */
export function parseCodexTurn(text: string, head = ''): TurnState | null {
  let cwd = ''
  const scanMeta = (src: string): void => {
    for (const line of src.split('\n')) {
      const s = line.trim()
      if (!s.startsWith('{') || !s.includes('session_meta')) continue
      try {
        const d = JSON.parse(s) as { type?: string; payload?: { cwd?: unknown } }
        if (d.type !== 'session_meta' || !d.payload) continue
        if (typeof d.payload.cwd === 'string') cwd = d.payload.cwd
      } catch {
        /* ignore */
      }
    }
  }
  scanMeta(head)
  if (!cwd) scanMeta(text)
  if (!cwd) return null // unattributable to a peer

  let found: TurnState | null = null
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{') || !s.includes('task_')) continue
    let d: { timestamp?: unknown; type?: unknown; payload?: { type?: unknown } }
    try {
      d = JSON.parse(s)
    } catch {
      continue
    }
    if (d.type !== 'event_msg') continue
    const p = d.payload?.type
    if (p !== 'task_started' && p !== 'task_complete') continue
    const atMs = toMs(d.timestamp)
    if (atMs === null) continue
    found = { state: p === 'task_started' ? 'working' : 'idle', atMs, cwd }
  }
  return found
}

// ─────────────────────────────────────────────────────────────────────────────
// The board — in-memory (personality, runtime) → last known turn state
// ─────────────────────────────────────────────────────────────────────────────

function key(personality: string, runtime: string): string {
  return `${runtime}-${personality}` // the identity scheme (docs/03)
}

/**
 * Last known turn state per (personality, runtime). In-memory and ephemeral, exactly like the
 * notice board: a restart re-seeds from the session files, which are the durable truth.
 */
export class ActivityBoard {
  private readonly states = new Map<string, TurnState>()

  /** Record an observation. Returns the PREVIOUS state, so the caller can log only real
   *  transitions rather than one line per sweep. */
  set(personality: string, runtime: string, next: TurnState): TurnState | undefined {
    const k = key(personality, runtime)
    const prev = this.states.get(k)
    // Evidence older than what we already hold is a stale re-read — never let it rewind state.
    if (prev && next.atMs < prev.atMs) return prev
    this.states.set(k, next)
    return prev
  }

  /** The operator-facing verdict, with the stale bound applied at READ time (so a claim decays
   *  even while nothing new is swept). `undefined` → we have no evidence at all. */
  get(personality: string, runtime: string, nowMs: number): TurnActivity | undefined {
    const st = this.states.get(key(personality, runtime))
    if (!st) return undefined
    if (st.state === 'idle') return 'idle' // idle never decays — age proves nothing against it
    return nowMs - st.atMs > TURN_STALE_MS ? 'unknown' : 'working'
  }

  /** The raw record (peer-detail / tests). */
  raw(personality: string, runtime: string): TurnState | undefined {
    return this.states.get(key(personality, runtime))
  }

  size(): number {
    return this.states.size
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The sweep
// ─────────────────────────────────────────────────────────────────────────────

function readTail(path: string): { tail: string; head: string } | null {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      if (size <= 0) return null
      const off = Math.max(0, size - TAIL_BYTES)
      const buf = Buffer.alloc(size - off)
      readSync(fd, buf, 0, buf.length, off)
      let head = ''
      if (off > 0) {
        const hb = Buffer.alloc(Math.min(HEAD_BYTES, off))
        readSync(fd, hb, 0, hb.length, 0)
        head = hb.toString('utf8')
      }
      return { tail: buf.toString('utf8'), head }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** *.jsonl under `root` (depth-bounded) whose mtime is at/after `sinceMs`. */
function changedJsonl(root: string, sinceMs: number, depth: number): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string, left: number): void => {
    for (const name of safeReaddir(dir)) {
      const p = join(dir, name)
      if (name.endsWith('.jsonl')) {
        let m: number | null = null
        try {
          m = statSync(p).mtimeMs
        } catch {
          continue
        }
        if (m >= sinceMs) out.push(p)
        continue
      }
      if (left <= 0 || name.startsWith('.')) continue
      try {
        if (statSync(p).isDirectory()) walk(p, left - 1)
      } catch {
        continue
      }
    }
  }
  walk(root, depth)
  return out
}

export interface TurnWatchPaths {
  /** ~/.claude/projects — INJECTED, never re-resolved from env inside a sweep. */
  claudeProjectsDir: string
  /** ~/.codex/sessions — same rule. */
  codexSessionsDir: string
}

export function resolveTurnWatchPaths(env: NodeJS.ProcessEnv): TurnWatchPaths {
  const home = env.HOME?.trim() || ''
  return {
    claudeProjectsDir: env.IAPEER_CLAUDE_PROJECTS_DIR?.trim() || join(home, '.claude', 'projects'),
    codexSessionsDir: env.IAPEER_CODEX_SESSIONS_DIR?.trim() || join(home, '.codex', 'sessions'),
  }
}

export interface TurnScanDeps extends TurnWatchPaths {
  /** personality ← cwd. Built from the registry by the composition point. */
  peerByCwd: (cwd: string) => string | undefined
}

export interface TurnObservation extends TurnState {
  personality: string
  runtime: 'claude' | 'codex'
}

/** One sweep: the turn state of every peer session file touched since `sinceMs`. */
export function scanTurnStates(deps: TurnScanDeps, sinceMs: number): TurnObservation[] {
  const floor = sinceMs - SCAN_OVERLAP_MS
  const out: TurnObservation[] = []
  const push = (st: TurnState | null, runtime: 'claude' | 'codex'): void => {
    if (!st) return
    const personality = deps.peerByCwd(st.cwd)
    if (!personality) return // a human's own session — never reported
    out.push({ ...st, personality, runtime })
  }
  for (const file of changedJsonl(deps.claudeProjectsDir, floor, 1)) {
    const t = readTail(file)
    if (t) push(parseClaudeTurn(t.tail), 'claude')
  }
  for (const file of changedJsonl(deps.codexSessionsDir, floor, CODEX_WALK_DEPTH)) {
    const t = readTail(file)
    if (t) push(parseCodexTurn(t.tail, t.head), 'codex')
  }
  return out
}

export interface TurnWatchDeps extends TurnScanDeps {
  board: ActivityBoard
  /** cfg.eventLogDir — turns.log (falsy → no durable log, hermetic). */
  logDir?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
  onError?: (err: unknown) => void
}

/**
 * Run one watch tick: sweep, fold into the board, log REAL transitions only.
 * Returns how many transitions were logged plus the new since-boundary.
 */
export function turnWatchTick(deps: TurnWatchDeps, sinceMs: number): { transitions: number; sinceMs: number } {
  const now = deps.now ?? Date.now
  const startedMs = now()
  let transitions = 0
  try {
    for (const o of scanTurnStates(deps, sinceMs)) {
      const prev = deps.board.set(o.personality, o.runtime, { state: o.state, atMs: o.atMs, cwd: o.cwd })
      // Only a genuine change is an event. Without this the 3 s sweep would write a line per
      // pass per peer and bury the log it is supposed to make readable.
      if (prev?.state === o.state) continue
      // A rewound observation (older evidence than held) is not a transition either.
      if (prev && o.atMs < prev.atMs) continue
      transitions += 1
      appendTurnEvent(
        deps.logDir,
        {
          ev: o.state === 'working' ? 'turn-started' : 'turn-ended',
          personality: o.personality,
          runtime: o.runtime,
          from: prev?.state,
          at: o.atMs,
          at_iso: new Date(o.atMs).toISOString(),
        },
        { env: deps.env, nowMs: startedMs },
      )
    }
  } catch (e) {
    deps.onError?.(e)
  }
  return { transitions, sinceMs: startedMs }
}

export interface StartTurnWatchOptions {
  env?: NodeJS.ProcessEnv
  intervalMs?: number
  paths?: TurnWatchPaths
  listPeers?: () => Array<{ personality: string; cwd: string }>
  now?: () => number
  onError?: (err: unknown) => void
}

/**
 * Start the turn-watch timer. Returns its stop function — the caller OWNS teardown.
 * The FIRST sweep reaches back SEED_LOOKBACK_MS so sessions already mid-turn when the daemon
 * started are known immediately; every later sweep is incremental (changed files only).
 */
export function startTurnWatch(cfg: LifecycleConfig, board: ActivityBoard, opts: StartTurnWatchOptions = {}): () => void {
  const env = opts.env ?? process.env
  const paths = opts.paths ?? resolveTurnWatchPaths(env)
  const now = opts.now ?? Date.now
  let listPeers = opts.listPeers
  let since = now() - SEED_LOOKBACK_MS
  let running = false

  const sweep = async (): Promise<void> => {
    if (running) return // a slow sweep must never overlap itself into a stampede
    running = true
    try {
      if (!listPeers) {
        const cli = await import('../cli/index.ts')
        listPeers = () => cli.listPeers({ env }).map(p => ({ personality: p.personality, cwd: p.cwd }))
      }
      const rows = listPeers()
      // Case-insensitive, trailing-slash-tolerant — same rule and reason as mutewatch.
      const byCwd = new Map<string, string>()
      for (const r of rows) if (r.cwd) byCwd.set(r.cwd.replace(/\/+$/, '').toLowerCase(), r.personality)
      since = turnWatchTick(
        {
          ...paths,
          board,
          logDir: cfg.eventLogDir,
          env,
          now,
          onError: opts.onError,
          peerByCwd: (cwd: string) => byCwd.get(cwd.replace(/\/+$/, '').toLowerCase()),
        },
        since,
      ).sinceMs
    } catch (e) {
      opts.onError?.(e)
    } finally {
      running = false
    }
  }

  void sweep() // seed immediately — do not make the operator wait one interval for the truth
  const timer = setInterval(() => void sweep(), opts.intervalMs ?? 3_000)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
