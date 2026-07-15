// Mute-watch — the daemon's detector for the ONE class of failure that is invisible to
// every health signal it has: a structural API error left a peer unable to answer (docs/19).
//
// WHY THIS EXISTS. When a model's limit is exhausted the peer's session does NOT die. Proven
// live (15.07.2026, exhausted fable bucket): the banner paints, the composer paints, the
// ready-gate would flip READY, the delivered turn is CONSUMED, the runtime paints its refusal,
// and the session returns to the composer and lives on. The process is alive, there is no exit
// code, and the statusline keeps re-rendering — which advances the pane-log mtime, so the
// activity proxy reports the delivery CONFIRMED. Every daemon health signal is green and the
// peer is mute. The owner writes and gets silence, with nothing anywhere saying why.
// The exit code is no help either: `-p` (headless) exits 1 on a limit, but live peers are
// never launched that way — an interactive session just sits there.
//
// WHERE THE TRUTH IS. Not the pane: the refusal is prose that line-wraps, and matching wrapped
// ANSI is a losing game. Both runtimes write the fact STRUCTURALLY to their own session JSONL:
//
//   • claude → the transcript (~/.claude/projects/<slug>/<sessionId>.jsonl):
//       isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429,
//       message.model: "<synthetic>" (a fabricated message, not a model reply).
//     `error` is a locale-stable enum and the WHOLE CLASS rides it — rate_limit is one value;
//     overloaded / expired auth arrive on the same field, which is why this detector keys on
//     isApiErrorMessage and reports `error` verbatim instead of hunting one string.
//     Claude does NOT state when a per-model bucket lifts ("Please try again later") → the
//     notice omits the reset rather than extrapolating from the 5h/7d buckets (a DIFFERENT
//     limit: measured live at 5h 11% / 7d 66% while fable was fully exhausted).
//
//   • codex → the rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl): an `event_msg` /
//     `token_count` payload carries RateLimitSnapshot.rate_limit_reached_type — null while
//     healthy, non-null once a wall is hit. We key on NON-NULL, never on the variant strings
//     (`rate_limit_reached`, `workspace_owner_usage_limit_reached`, … — read out of the 0.144.1
//     binary but never observed live here), so an unknown future variant still detects.
//     Codex DOES carry resets_at per window → its notice states the reset time.
//
// PATHS ARE NEVER DERIVED FROM cwd. The obvious route — slugify the peer's registry cwd into
// ~/.claude/projects/<slug> — is a trap: the slug mirrors the cwd STRING as the process was
// launched, not the real path. This host carries BOTH `-Users-macmini-Projects-IAPeer` and
// `-Users-macmini-Projects-iapeer` for ONE case-insensitive directory. So we go the other way:
// scan the session files that CHANGED, read the cwd each file states about ITSELF (claude: the
// `cwd` field on every line; codex: session_meta.payload.cwd), and match that against the
// registry. A file whose cwd is no peer's is ignored — a human's own session never notifies.

import { existsSync, openSync, closeSync, fstatSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LifecycleConfig } from '../lifecycle/index.ts'
import type { NoticeBoard } from './notices.ts'

/** How much of a session file's tail is parsed. The evidence is always at the end. */
const TAIL_BYTES = 256 * 1024
/** Overlap added to the since-boundary so an event landing between two sweeps is never
 *  missed. Re-detections are free: the board's dedup folds them into the live notice. */
const SCAN_OVERLAP_MS = 15_000
/** Walk depth for the codex YYYY/MM/DD tree (3 levels + the file). */
const CODEX_WALK_DEPTH = 3

export interface MuteDetection {
  personality: string
  runtime: 'claude' | 'codex'
  /** The runtime's OWN taxonomy value — claude's `error`, codex's rate_limit_reached_type. */
  errorType: string
  model?: string
  resetsAtMs?: number
  /** Claude: the runtime's VERBATIM refusal. Codex: a line rendered from its typed fields
   *  (the rollout carries no prose). Either way, never our interpretation of the cause. */
  content: string
  sessionId?: string
  atMs: number
  cwd: string
}

type RawDetection = Omit<MuteDetection, 'personality' | 'runtime'>

// ─────────────────────────────────────────────────────────────────────────────
// Pure parsers — string in, detection out (fs-free: tests need no temp tree)
// ─────────────────────────────────────────────────────────────────────────────

function toMs(ts: unknown): number | null {
  if (typeof ts !== 'string') return null
  const ms = Date.parse(ts)
  return Number.isFinite(ms) ? ms : null
}

/** The model out of the runtime's own prose ("You've reached your Fable 5 limit"). Used ONLY
 *  when the transcript carries no real model reply to read it from — a session that hits the
 *  wall on its FIRST turn has no such line. Bounded and anchored; a miss → undefined (omit). */
export function modelFromClaudeText(text: string): string | undefined {
  const m = /reached your\s+(.{1,40}?)\s+limit/i.exec(text)
  return m?.[1]?.trim() || undefined
}

/**
 * The NEWEST structural API-error line in a claude transcript newer than `sinceMs`, or null.
 * Keys on `isApiErrorMessage` — the class, not the `rate_limit` instance.
 */
export function parseClaudeTranscript(text: string, sinceMs: number): RawDetection | null {
  let lastRealModel: string | undefined
  let found: RawDetection | null = null
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue // a partial first line from the tail cut — skip
    let d: Record<string, unknown>
    try {
      d = JSON.parse(s) as Record<string, unknown>
    } catch {
      continue // truncated/garbled line — never fail the sweep over one bad line
    }
    const msg = d.message as { model?: unknown; content?: unknown } | undefined
    // Track the last REAL model reply: the error line itself is "<synthetic>" and names no model.
    if (msg && typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>') lastRealModel = msg.model
    if (d.isApiErrorMessage !== true) continue
    const atMs = toMs(d.timestamp)
    if (atMs === null || atMs <= sinceMs) continue
    const cwd = typeof d.cwd === 'string' ? d.cwd : ''
    if (!cwd) continue // no cwd → unattributable to a peer; ignore rather than guess
    const errorType = typeof d.error === 'string' && d.error.trim() ? d.error.trim() : 'api-error'
    let content = ''
    if (Array.isArray(msg?.content)) {
      content = (msg.content as Array<{ type?: string; text?: string }>)
        .filter(c => c?.type === 'text' && typeof c.text === 'string')
        .map(c => c.text as string)
        .join('\n')
        .trim()
    }
    if (!content) content = `${errorType} (api error ${String(d.apiErrorStatus ?? '')})`.trim()
    found = {
      errorType,
      model: lastRealModel ?? modelFromClaudeText(content),
      content,
      sessionId: typeof d.sessionId === 'string' ? d.sessionId : undefined,
      atMs,
      cwd,
      // Claude states no reset for a per-model bucket → resetsAtMs deliberately absent.
    }
  }
  return found
}

interface CodexWindow {
  used_percent?: unknown
  window_minutes?: unknown
  resets_at?: unknown
}

/** Describe a codex window for the human-readable content line. */
function describeWindow(name: string, w: CodexWindow): string | null {
  if (!w || typeof w.used_percent !== 'number') return null
  const win = typeof w.window_minutes === 'number' ? `${w.window_minutes}m window` : 'window'
  const reset =
    typeof w.resets_at === 'number' ? `, resets ${new Date(w.resets_at * 1000).toISOString()}` : ''
  return `${name} ${w.used_percent}% (${win}${reset})`
}

/**
 * The codex rollout's newest limit-reached snapshot newer than `sinceMs`, or null.
 * Keys on `rate_limit_reached_type` being NON-NULL — never on its variant strings.
 * `cwd` comes from session_meta, which is the file's FIRST line — pass the file HEAD in
 * `head` when the tail alone may have cut it away.
 */
export function parseCodexRollout(text: string, sinceMs: number, head = ''): RawDetection | null {
  let cwd = ''
  let sessionId: string | undefined
  const scanMeta = (src: string): void => {
    for (const line of src.split('\n')) {
      const s = line.trim()
      if (!s.startsWith('{') || !s.includes('session_meta')) continue
      try {
        const d = JSON.parse(s) as { type?: string; payload?: { cwd?: unknown; session_id?: unknown } }
        if (d.type !== 'session_meta' || !d.payload) continue
        if (typeof d.payload.cwd === 'string') cwd = d.payload.cwd
        if (typeof d.payload.session_id === 'string') sessionId = d.payload.session_id
      } catch {
        /* ignore */
      }
    }
  }
  scanMeta(head)
  if (!cwd) scanMeta(text)
  if (!cwd) return null // unattributable to a peer

  let found: RawDetection | null = null
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{') || !s.includes('rate_limits')) continue
    let d: { timestamp?: unknown; type?: unknown; payload?: { type?: unknown; rate_limits?: Record<string, unknown> } }
    try {
      d = JSON.parse(s)
    } catch {
      continue
    }
    const rl = d.payload?.rate_limits
    if (!rl) continue
    const reached = rl.rate_limit_reached_type
    // NON-NULL is the signal. An unknown future variant must still detect, so we never
    // compare against the variant strings read out of the binary.
    if (reached === null || reached === undefined || reached === '') continue
    const atMs = toMs(d.timestamp)
    if (atMs === null || atMs <= sinceMs) continue
    const primary = (rl.primary ?? {}) as CodexWindow
    const secondary = (rl.secondary ?? {}) as CodexWindow
    // Which window is blocking? Codex does not say — reported for the FULLEST one, the
    // only defensible read. This mapping is a HEURISTIC: it could not be verified against
    // a real reached-snapshot (the quota never ran out on this host). Both windows ride in
    // `content`, so the human sees the raw fact even if the heuristic picked wrong.
    const pu = typeof primary.used_percent === 'number' ? primary.used_percent : -1
    const su = typeof secondary.used_percent === 'number' ? secondary.used_percent : -1
    const blocking = su > pu ? secondary : primary
    const resetsAtMs = typeof blocking.resets_at === 'number' ? blocking.resets_at * 1000 : undefined
    const parts = [describeWindow('primary', primary), describeWindow('secondary', secondary)].filter(Boolean)
    const plan = typeof rl.plan_type === 'string' ? ` plan=${rl.plan_type}` : ''
    found = {
      errorType: String(reached),
      content: `Codex usage limit reached (${String(reached)})${plan}${parts.length ? ` — ${parts.join('; ')}` : ''}`,
      resetsAtMs,
      sessionId,
      atMs,
      cwd,
      // Codex names no model in the snapshot → model omitted rather than guessed.
    }
  }
  return found
}

// ─────────────────────────────────────────────────────────────────────────────
// The sweep — find changed session files, attribute them, raise notices
// ─────────────────────────────────────────────────────────────────────────────

function readTail(path: string, maxBytes = TAIL_BYTES): { tail: string; head: string } | null {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      if (size <= 0) return null
      const off = Math.max(0, size - maxBytes)
      const buf = Buffer.alloc(size - off)
      readSync(fd, buf, 0, buf.length, off)
      let head = ''
      if (off > 0) {
        // The tail cut away the file's start — read a HEAD slice too (codex session_meta
        // is line 1, and a long session pushes it far out of the tail).
        const hb = Buffer.alloc(Math.min(64 * 1024, off))
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

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/** *.jsonl files under `root` (depth-bounded) whose mtime is at/after `sinceMs`. */
function changedJsonl(root: string, sinceMs: number, depth: number): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string, left: number): void => {
    for (const name of safeReaddir(dir)) {
      const p = join(dir, name)
      if (name.endsWith('.jsonl')) {
        const m = mtimeMs(p)
        if (m !== null && m >= sinceMs) out.push(p)
        continue
      }
      if (left <= 0 || name.startsWith('.')) continue
      let isDir = false
      try {
        isDir = statSync(p).isDirectory()
      } catch {
        continue
      }
      if (isDir) walk(p, left - 1)
    }
  }
  walk(root, depth)
  return out
}

export interface MuteWatchPaths {
  /** ~/.claude/projects — INJECTED, never re-resolved from env inside the sweep. */
  claudeProjectsDir: string
  /** ~/.codex/sessions — same rule. */
  codexSessionsDir: string
}

export interface ScanDeps extends MuteWatchPaths {
  /** personality ← cwd. Built from the registry by the composition point. */
  peerByCwd: (cwd: string) => string | undefined
}

/**
 * The runtime session-file roots. These are the RUNTIMES' own trees, not iapeer's, so they
 * are not LifecycleConfig fields; the composition point resolves them ONCE and injects them
 * (a sweep never re-resolves a path mid-run). The env overrides exist so a test points the
 * sweep at a temp tree instead of the real ~/.claude — the sweep is READ-ONLY, and its only
 * write (notices.log) goes through cfg.eventLogDir like every other daemon log.
 */
export function resolveMuteWatchPaths(env: NodeJS.ProcessEnv): MuteWatchPaths {
  const home = env.HOME?.trim() || ''
  return {
    claudeProjectsDir: env.IAPEER_CLAUDE_PROJECTS_DIR?.trim() || join(home, '.claude', 'projects'),
    codexSessionsDir: env.IAPEER_CODEX_SESSIONS_DIR?.trim() || join(home, '.codex', 'sessions'),
  }
}

/** One sweep: every peer-attributable structural API error newer than `sinceMs`. */
export function scanMuteEvents(deps: ScanDeps, sinceMs: number): MuteDetection[] {
  const floor = sinceMs - SCAN_OVERLAP_MS
  const out: MuteDetection[] = []
  const push = (raw: RawDetection | null, runtime: 'claude' | 'codex'): void => {
    if (!raw) return
    const personality = deps.peerByCwd(raw.cwd)
    if (!personality) return // not a peer's session (a human's own shell) — never notify
    out.push({ ...raw, personality, runtime })
  }
  // claude: ~/.claude/projects/<slug>/<sessionId>.jsonl — one level of slug dirs.
  for (const file of changedJsonl(deps.claudeProjectsDir, floor, 1)) {
    const t = readTail(file)
    if (t) push(parseClaudeTranscript(t.tail, floor), 'claude')
  }
  // codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  for (const file of changedJsonl(deps.codexSessionsDir, floor, CODEX_WALK_DEPTH)) {
    const t = readTail(file)
    if (t) push(parseCodexRollout(t.tail, floor, t.head), 'codex')
  }
  return out
}

export interface MuteWatchDeps extends ScanDeps {
  board: NoticeBoard
  now?: () => number
  /** Reported, never thrown — a detector must never take the daemon down. */
  onError?: (err: unknown) => void
}

/**
 * Run one watch tick: sweep, raise. Returns the notices actually RAISED (deduped repeats
 * are folded by the board and not returned) plus the new since-boundary.
 */
export function muteWatchTick(deps: MuteWatchDeps, sinceMs: number): { raised: number; sinceMs: number } {
  const now = deps.now ?? Date.now
  const startedMs = now()
  let raised = 0
  try {
    for (const d of scanMuteEvents(deps, sinceMs)) {
      const { deduped } = deps.board.raise({
        personality: d.personality,
        runtime: d.runtime,
        kind: 'peer-mute',
        errorType: d.errorType,
        model: d.model,
        resetsAtMs: d.resetsAtMs,
        content: d.content,
        sessionId: d.sessionId,
        summary: `${d.personality} · ${d.runtime} — ${d.errorType}${d.model ? ` (${d.model})` : ''}`,
      })
      if (!deduped) raised += 1
    }
  } catch (e) {
    deps.onError?.(e)
  }
  return { raised, sinceMs: startedMs }
}

export interface StartMuteWatchOptions {
  env?: NodeJS.ProcessEnv
  intervalMs?: number
  /** Override the runtime session roots (tests). Default: resolveMuteWatchPaths(env). */
  paths?: MuteWatchPaths
  /** Override the registry read (tests). Default: a lazy import of the CLI's listPeers. */
  listPeers?: () => Array<{ personality: string; cwd: string }>
  now?: () => number
  onError?: (err: unknown) => void
}

/**
 * Start the mute-watch timer. Returns its stop function — the caller OWNS teardown.
 *
 * The registry is re-read every sweep (a peer created since daemon start must be watched
 * without a restart), and `listPeers` is imported LAZILY at first use, mirroring fleet.ts:
 * daemon → cli is not a load-time dependency in this codebase.
 */
export function startMuteWatch(cfg: LifecycleConfig, board: NoticeBoard, opts: StartMuteWatchOptions = {}): () => void {
  const env = opts.env ?? process.env
  const paths = opts.paths ?? resolveMuteWatchPaths(env)
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
      // cwd → personality. Compared case-insensitively: macOS paths are case-insensitive and
      // the runtimes record the cwd STRING as launched, which is not always the registry's
      // capitalization (the same trap that rules out deriving the transcript dir from cwd).
      const byCwd = new Map<string, string>()
      for (const r of rows) if (r.cwd) byCwd.set(r.cwd.replace(/\/+$/, '').toLowerCase(), r.personality)
      const deps: MuteWatchDeps = {
        ...paths,
        board,
        now,
        onError: opts.onError,
        peerByCwd: (cwd: string) => byCwd.get(cwd.replace(/\/+$/, '').toLowerCase()),
      }
      since = muteWatchTick(deps, since).sinceMs
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
