// Goal-watch — the daemon's detector for a codex peer whose OBJECTIVE died while the peer
// itself stayed perfectly healthy (docs/19). Sibling of mutewatch.ts: same class of failure
// (peer alive, every health signal green, nothing anywhere saying why), different evidence.
//
// WHAT CODEX'S GOAL HARNESS IS. Codex 0.144.x ships a "thread goal": an objective pinned to a
// thread (`create_goal`), after which codex AUTOMATICALLY continues working it — when the
// thread goes idle the TUI injects a synthetic `<codex_internal_context source="goal">` user
// message and runs another turn. That loop is the harness's own; iapeer owns NO part of it and
// this module WRITES nothing — it only reads what codex already wrote about itself.
//
// THE FAILURE. `ext/goal/src/extension.rs::on_turn_error` maps EVERY terminal turn error that
// is not a usage limit to `ActiveGoalStopReason::TurnError`, and `runtime.rs` turns that into
// status `blocked`. Upstream calls this deliberate ("Block the goal to prevent automatic
// continuation from looping and consuming tokens, as can happen with compaction errors"), and
// it is the ONLY path that writes `blocked` without the model calling `update_goal`. Once the
// status leaves `active`, `clear_active_goal()` runs and automatic continuation STOPS FOREVER.
// The objective is abandoned. Nothing dies, nothing errors, no exit code, no IAP message —
// the peer just never works the objective again. Measured live on this host 16.07.2026
// (zapret2-oneclick, thread 019f6709…, goal c25d2378…): status `blocked` at 09:54:32 with no
// `update_goal` call anywhere in the rollout, while the peer went on running unrelated turns
// for another 17 minutes with its goal counters FROZEN at the block instant.
//
// WHY SQLITE AND NOT THE ROLLOUT. mutewatch reads the rollout because the rate-limit fact is
// written there. The block is NOT: the same live capture shows exactly ONE `thread_goal_updated`
// event in 1971 rollout lines (the `active` one at resume) and NONE for the transition to
// `blocked`. The transition is written ONLY to codex's goals DB. Read the state or miss it.
//
// WHY TWO DATABASES. The goals DB keys on thread_id and carries no cwd, so a goal row alone
// cannot be attributed to a peer. Codex's state DB (`threads`) carries `id` + `cwd`. Joining
// the two yields cwd, and cwd → personality is the SAME attribution rule mutewatch already
// uses: a thread whose cwd is no peer's (a human's own codex) is ignored, never notified.
//
// WHY THE FILENAMES ARE GLOBBED. These are codex's private files and their names carry a
// schema generation (`goals_1.sqlite`, `state_5.sqlite` — the 5 says it has rolled before).
// Pinning the literal name would silently read a stale DB the day codex rolls it, so the
// highest generation present wins. Absent/unreadable/renamed → the detector no-ops. Reading
// another product's internal store is a real coupling; it is accepted for the same reason
// mutewatch parses codex's rollout — there is no other place the fact exists — and it is
// confined to this module, guarded, and READ-ONLY.
//
// ONE-SHOT, WITHOUT A STATE FILE. A blocked goal's row is never touched again (its accounting
// is ActiveOnly — proven live: counters frozen through 17 minutes of later turns), so its
// `updated_at_ms` is a STABLE transition clock. Filtering on `updated_at_ms > sinceMs` there-
// fore fires exactly once per transition and then falls behind the boundary forever — no
// repeat, no TTL re-raise, no persisted "already told him" set. A goal blocked while the
// daemon was down is missed, exactly as mutewatch misses an error it was not up for; the
// boundary is the contour's existing honesty, not a new compromise.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LifecycleConfig } from '../lifecycle/index.ts'
import type { NoticeBoard } from './notices.ts'

/** Overlap on the since-boundary so a transition landing between two sweeps is never missed.
 *  Re-reads are free: the board folds them by `eventAtMs` (see notices.ts). */
const SCAN_OVERLAP_MS = 15_000
/** Objective text is user-authored and unbounded — bound it before it reaches a notice. */
const OBJECTIVE_MAX = 300

/**
 * The goal statuses that mean "this objective is not being worked and will not resume on its
 * own". CODEX'S OWN taxonomy values, never our invention (docs/19 §2).
 *
 * Deliberately excluded:
 *   • `active`    — working; the healthy case.
 *   • `complete`  — the model proved the objective done. Success is not news.
 *   • `paused`    — a human's own choice. Notifying him of his own click is noise.
 * `usage_limited` / `budget_limited` ride along because they are the same shape: continuation
 * stopped, objective unfinished, nobody told. They are NOT the same CAUSE as `blocked`, which
 * is why the status travels verbatim as the notice's errorType instead of being flattened.
 */
export const STALLED_GOAL_STATUSES = new Set(['blocked', 'usage_limited', 'budget_limited'])

/** A row of codex's `thread_goals`, as codex wrote it. */
export interface GoalRow {
  threadId: string
  goalId: string
  objective: string
  status: string
  tokensUsed: number
  timeUsedSeconds: number
  updatedAtMs: number
}

export interface GoalDetection {
  personality: string
  runtime: 'codex'
  /** Codex's own status value — `blocked` | `usage_limited` | `budget_limited`. */
  status: string
  goalId: string
  threadId: string
  objective: string
  tokensUsed: number
  timeUsedSeconds: number
  /** The row's `updated_at_ms` — the TRANSITION's own clock, not our sweep's. */
  atMs: number
  cwd: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure selection — rows in, detections out (fs/sqlite-free: tests need no DB)
// ─────────────────────────────────────────────────────────────────────────────

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

/** The human-readable line, rendered from codex's TYPED fields — codex writes no prose for a
 *  goal transition, the same situation as its rate-limit snapshot, and the same answer:
 *  render the facts, never our reading of the cause. */
export function renderGoalContent(d: Omit<GoalDetection, 'personality' | 'runtime'>): string {
  return [
    `Codex goal ${d.status} — automatic goal continuation has stopped; this objective will not`,
    `resume without an explicit resume. Objective: "${d.objective}".`,
    `goal=${d.goalId} thread=${d.threadId} accounted=${d.tokensUsed} tokens / ${d.timeUsedSeconds}s.`,
  ].join(' ')
}

/**
 * Every peer-attributable goal that stalled STRICTLY after `sinceMs`.
 *
 * `cwdByThread` and `peerByCwd` are injected so this stays pure: the whole selection rule is
 * testable without a codex install.
 */
export function selectStalledGoals(
  goals: GoalRow[],
  cwdByThread: Map<string, string>,
  peerByCwd: (cwd: string) => string | undefined,
  sinceMs: number,
  /** cwd → the peer's CURRENT thread (see readCurrentThreadByCwd). A goal on any OTHER thread is
   *  an abandoned session's leftover and is NOT this peer's objective. Omitted → no gate (the
   *  pure-selection tests that predate the gate). */
  currentThreadByCwd?: Map<string, string>,
): GoalDetection[] {
  const out: GoalDetection[] = []
  for (const g of goals) {
    if (!STALLED_GOAL_STATUSES.has(g.status)) continue
    if (!Number.isFinite(g.updatedAtMs) || g.updatedAtMs <= sinceMs) continue
    const cwd = cwdByThread.get(g.threadId)
    if (!cwd) continue // thread not in the state DB → unattributable; ignore rather than guess
    const personality = peerByCwd(cwd)
    if (!personality) continue // a human's own codex thread — never notify
    if (currentThreadByCwd) {
      const current = currentThreadByCwd.get(cwd)
      // A stalled goal on a thread the peer has moved on from is not news — it is a fossil. The
      // peer may well be working the same objective on its current thread right now.
      if (!current || current !== g.threadId) continue
    }
    out.push({
      personality,
      runtime: 'codex',
      status: g.status,
      goalId: g.goalId,
      threadId: g.threadId,
      objective: clip(g.objective, OBJECTIVE_MAX),
      tokensUsed: g.tokensUsed,
      timeUsedSeconds: g.timeUsedSeconds,
      atMs: g.updatedAtMs,
      cwd,
    })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// The codex-state reader — the only part that touches another product's files
// ─────────────────────────────────────────────────────────────────────────────

export interface GoalWatchPaths {
  /** ~/.codex — INJECTED, never re-resolved from env inside a sweep. */
  codexHome: string
}

export function resolveGoalWatchPaths(env: NodeJS.ProcessEnv): GoalWatchPaths {
  const home = env.HOME?.trim() || ''
  return { codexHome: env.IAPEER_CODEX_HOME?.trim() || join(home, '.codex') }
}

/**
 * The highest-generation `<prefix>_<n>.sqlite` in `dir`, or null.
 * Codex rolls the generation when it changes schema; the newest is the live one.
 */
export function findVersionedDb(dir: string, prefix: string): string | null {
  if (!existsSync(dir)) return null
  let best: { n: number; name: string } | null = null
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const re = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`)
  for (const name of names) {
    const m = re.exec(name)
    if (!m) continue
    const n = parseInt(m[1] as string, 10)
    if (!Number.isFinite(n)) continue
    if (!best || n > best.n) best = { n, name }
  }
  return best ? join(dir, best.name) : null
}

/** Open a codex DB READ-ONLY. Never creates, never migrates, never writes. */
async function openReadOnly(path: string): Promise<{ query: (sql: string) => { all: (...a: unknown[]) => unknown[] }; close: () => void } | null> {
  try {
    const { Database } = (await import('bun:sqlite')) as typeof import('bun:sqlite')
    return new Database(path, { readonly: true }) as unknown as {
      query: (sql: string) => { all: (...a: unknown[]) => unknown[] }
      close: () => void
    }
  } catch {
    return null // absent / locked / rolled schema → the detector no-ops, never throws
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Codex's goal rows. Empty on any shape we do not recognise — never a throw. */
export async function readGoalRows(codexHome: string): Promise<GoalRow[]> {
  const path = findVersionedDb(codexHome, 'goals')
  if (!path) return []
  const db = await openReadOnly(path)
  if (!db) return []
  try {
    const rows = db
      .query('SELECT thread_id, goal_id, objective, status, tokens_used, time_used_seconds, updated_at_ms FROM thread_goals')
      .all() as Array<Record<string, unknown>>
    return rows.map(r => ({
      threadId: str(r.thread_id),
      goalId: str(r.goal_id),
      objective: str(r.objective),
      status: str(r.status),
      tokensUsed: num(r.tokens_used),
      timeUsedSeconds: num(r.time_used_seconds),
      updatedAtMs: num(r.updated_at_ms),
    }))
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      /* best-effort */
    }
  }
}

/** thread_id → cwd, for the given threads only. Empty on any unrecognised shape. */
export async function readThreadCwds(codexHome: string, threadIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (threadIds.length === 0) return out
  const path = findVersionedDb(codexHome, 'state')
  if (!path) return out
  const db = await openReadOnly(path)
  if (!db) return out
  try {
    const holes = threadIds.map(() => '?').join(',')
    const rows = db.query(`SELECT id, cwd FROM threads WHERE id IN (${holes})`).all(...threadIds) as Array<Record<string, unknown>>
    for (const r of rows) {
      const id = str(r.id)
      const cwd = str(r.cwd)
      if (id && cwd) out.set(id, cwd)
    }
  } catch {
    /* unrecognised schema → no attribution, no notice */
  } finally {
    try {
      db.close()
    } catch {
      /* best-effort */
    }
  }
  return out
}

/**
 * The CURRENT thread of each cwd — the newest by codex's own recency clock.
 *
 * WHY THIS GATES THE NOTICE. A peer's goal rows outlive its threads: `thread_goals` is keyed by
 * thread_id, so a thread the peer has ABANDONED keeps its last goal row forever. Measured live
 * 16.07.2026: a peer escaped a blocked goal the only way its tools allowed — a fresh session —
 * and ended up with TWO rows, `blocked` on the dead thread and `active` on the live one. Reporting
 * the dead row would tell the owner an objective is stalled while the peer is, in fact, working it
 * on its current thread. That notice would be one-shot and WRONG, which is worse than noisy: the
 * whole contract of this surface is that a card means something真 (docs/19 §2a).
 *
 * So a goal counts only on the cwd's newest thread. `recency_at_ms` is codex's field for exactly
 * this; `updated_at_ms` is the fallback when it is absent.
 */
export async function readCurrentThreadByCwd(codexHome: string, cwds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (cwds.length === 0) return out
  const path = findVersionedDb(codexHome, 'state')
  if (!path) return out
  const db = await openReadOnly(path)
  if (!db) return out
  try {
    const holes = cwds.map(() => '?').join(',')
    const rows = db
      .query(
        `SELECT id, cwd, COALESCE(recency_at_ms, updated_at_ms) AS rank FROM threads
         WHERE cwd IN (${holes}) ORDER BY rank ASC`,
      )
      .all(...cwds) as Array<Record<string, unknown>>
    // ASC + overwrite ⇒ the LAST write per cwd is the newest thread.
    for (const r of rows) {
      const id = str(r.id)
      const cwd = str(r.cwd)
      if (id && cwd) out.set(cwd, id)
    }
  } catch {
    /* unrecognised schema → no gate we can trust → caller falls back to not notifying */
  } finally {
    try {
      db.close()
    } catch {
      /* best-effort */
    }
  }
  return out
}

export interface GoalScanDeps extends GoalWatchPaths {
  /** personality ← cwd. Built from the registry by the composition point. */
  peerByCwd: (cwd: string) => string | undefined
}

/** One sweep: every peer-attributable goal that stalled since `sinceMs`. */
export async function scanStalledGoals(deps: GoalScanDeps, sinceMs: number): Promise<GoalDetection[]> {
  const floor = sinceMs - SCAN_OVERLAP_MS
  const goals = await readGoalRows(deps.codexHome)
  // Only the stalled rows are worth a threads lookup — an active goal is the common case.
  const candidates = goals.filter(g => STALLED_GOAL_STATUSES.has(g.status) && g.updatedAtMs > floor)
  if (candidates.length === 0) return []
  const cwds = await readThreadCwds(
    deps.codexHome,
    candidates.map(g => g.threadId).filter(Boolean),
  )
  // Gate on the cwd's CURRENT thread — a fossil goal on an abandoned session is not this peer's
  // objective (see readCurrentThreadByCwd).
  const current = await readCurrentThreadByCwd(deps.codexHome, [...new Set(cwds.values())])
  return selectStalledGoals(candidates, cwds, deps.peerByCwd, floor, current)
}

// ─────────────────────────────────────────────────────────────────────────────
// The tick
// ─────────────────────────────────────────────────────────────────────────────

export interface GoalWatchDeps extends GoalScanDeps {
  board: NoticeBoard
  now?: () => number
  /** Reported, never thrown — a detector must never take the daemon down. */
  onError?: (err: unknown) => void
}

/** Run one watch tick: sweep, raise. Returns notices actually RAISED + the new boundary. */
export async function goalWatchTick(deps: GoalWatchDeps, sinceMs: number): Promise<{ raised: number; sinceMs: number }> {
  const now = deps.now ?? Date.now
  const startedMs = now()
  let raised = 0
  try {
    for (const d of await scanStalledGoals(deps, sinceMs)) {
      const { deduped } = deps.board.raise({
        personality: d.personality,
        runtime: d.runtime,
        kind: 'peer-goal-stalled',
        // Codex's own status is the taxonomy value — `blocked` and `usage_limited` are
        // different facts for the owner and must not collapse into one dedup identity.
        errorType: d.status,
        content: renderGoalContent(d),
        // The thread IS the session: it correlates the notice with the rollout on disk.
        sessionId: d.threadId,
        // The TRANSITION's own clock — see notices.ts on why this is not the sweep's.
        eventAtMs: d.atMs,
        summary: `${d.personality} · codex — goal ${d.status}: ${clip(d.objective, 80)}`,
      })
      if (!deduped) raised += 1
    }
  } catch (e) {
    deps.onError?.(e)
  }
  return { raised, sinceMs: startedMs }
}

export interface StartGoalWatchOptions {
  env?: NodeJS.ProcessEnv
  intervalMs?: number
  paths?: GoalWatchPaths
  /** Override the registry read (tests). Default: a lazy import of the CLI's listPeers. */
  listPeers?: () => Array<{ personality: string; cwd: string }>
  now?: () => number
  onError?: (err: unknown) => void
}

/**
 * Start the goal-watch timer. Returns its stop function — the caller OWNS teardown.
 * Mirrors startMuteWatch: registry re-read every sweep, `listPeers` imported lazily.
 */
export function startGoalWatch(_cfg: LifecycleConfig, board: NoticeBoard, opts: StartGoalWatchOptions = {}): () => void {
  const env = opts.env ?? process.env
  const paths = opts.paths ?? resolveGoalWatchPaths(env)
  const now = opts.now ?? Date.now
  let listPeers = opts.listPeers
  let since = now()
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
      // Case-insensitive, trailing-slash-tolerant — same rule and same reason as mutewatch:
      // macOS paths are case-insensitive and codex records the cwd STRING as launched.
      const byCwd = new Map<string, string>()
      for (const r of rows) if (r.cwd) byCwd.set(r.cwd.replace(/\/+$/, '').toLowerCase(), r.personality)
      const deps: GoalWatchDeps = {
        ...paths,
        board,
        now,
        onError: opts.onError,
        peerByCwd: (cwd: string) => byCwd.get(cwd.replace(/\/+$/, '').toLowerCase()),
      }
      since = (await goalWatchTick(deps, since)).sinceMs
    } catch (e) {
      opts.onError?.(e)
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void sweep(), opts.intervalMs ?? 20_000)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
