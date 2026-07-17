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
//   • codex → the rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). TWO detections:
//
//     (a) `rate_limit_reached_type` non-null in a token_count's RateLimitSnapshot. Kept for
//         forward-compat, but REFUTED as the primary signal by the real incident of
//         17.07.2026: with the account's codex quota genuinely exhausted (both codex peers
//         mute, turns dying on delivery), every snapshot in every rollout still said
//         `rate_limit_reached_type: null` — the field simply does not fire on this class.
//         The 15.07 acceptance replayed real bytes but SYNTHESIZED this field (docs/19 §7
//         said so); the synthesis diverged from reality and the detector missed the real
//         incident. We still key on NON-NULL (never the variant strings) in case a future
//         codex starts populating it.
//
//     (b) The REAL fingerprint of a limit-death, read out of the incident's own bytes
//         (doc, linus, zapret2-oneclick and a minimal `codex exec` probe, 17.07.2026 —
//         fixtures in docs/internals/forensics/model-limit-2026-07-17/): the rollout has NO
//         error event at all; the refused API call instead emits a token_count whose
//         rate_limits snapshot has BOTH windows null (healthy snapshots carry a windowed
//         primary), and whose `info` recorded no new usage (null in a fresh session, or
//         cumulative totals identical to the previous token_count — the call consumed
//         nothing because it was refused), immediately followed by `task_complete` with
//         `last_agent_message: null` (the turn died). All three conjuncts are required:
//           – a lone null-window snapshot happens transiently and the turn SURVIVES
//             (observed 10.07.2026: null windows but totals advanced, turn continued);
//           – `task_complete{last_agent_message:null}` alone is an absence, not a signal
//             (docs/19 §8 rejected it deliberately — legitimate no-message turns exist).
//         The event time is `completed_at` (epoch seconds), NOT the line timestamp: a
//         resumed session REPLAYS history with fresh line timestamps but keeps the original
//         completed_at, so a replayed old death does not re-raise after recovery.
//         errorType is `usage_limit_exceeded` — codex's own error-code vocabulary (read out
//         of the 0.144.1 binary) — when the tail holds an exhausted window (used_percent
//         ≥ 100, the evidence this is the usage-limit class); `api-refusal` (our fallback,
//         mirroring claude's `api-error`) when it does not. resets_at comes from that
//         exhausted window — the refusal snapshot itself carries none. The model comes from
//         the dead turn's own turn_context (real bytes name it, e.g. `gpt-5.6-sol`).
//
// PATHS ARE NOT DERIVED FROM cwd — but NOT for the reason first claimed here. The original note
// said this host carries BOTH `-Users-macmini-Projects-IAPeer` and `-Users-macmini-Projects-iapeer`
// as two directories. That was FALSE, and measured to be false on 15.07: readdir lists exactly one
// (`…-IAPeer`), and both spellings stat to the SAME inode — the filesystem is case-insensitive, so
// a slug whose case differs from the on-disk name resolves fine. (The claim came from a grep -c of
// 2, whose second hit was `…-Projects-iapeer-memory`. The count was read instead of the entries.)
//
// The real reason stands on its own: the slug mirrors the cwd STRING as the process was launched,
// which is a claude-specific naming convention we do not own, and codex has no cwd in its path at
// all (YYYY/MM/DD/rollout-*). One attribution rule that works for both runtimes beats two derivation
// schemes: scan the session files that CHANGED, read the cwd each file states about ITSELF (claude:
// the `cwd` field on every line; codex: session_meta.payload.cwd), and match that against the
// registry. A file whose cwd is no peer's is ignored — a human's own session never notifies.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LifecycleConfig } from '../lifecycle/index.ts'
import type { NoticeBoard } from './notices.ts'
import { readSessionSlices } from './sessionfiles.ts'

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

/** A window object out of a rate_limits snapshot, or null when absent/malformed. */
function asWindow(w: unknown): CodexWindow | null {
  return w && typeof w === 'object' ? (w as CodexWindow) : null
}

/**
 * The codex rollout's newest limit-death evidence newer than `sinceMs`, or null. Two paths
 * (see the header): (a) `rate_limit_reached_type` NON-NULL — kept forward-compat, refuted as
 * the primary signal by the 17.07.2026 incident; (b) the real-bytes fingerprint — a refused
 * API call's token_count (both windows null, no new usage) as the dying turn's last snapshot,
 * closed by `task_complete{last_agent_message:null}`.
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
  // Path-(b) rolling state, in file order (= time order):
  /** Latest snapshot that still HAD a window — the exhausted-window/resets evidence. */
  let lastWindowed: { primary: CodexWindow | null; secondary: CodexWindow | null; planType?: string } | null = null
  /** Previous token_count's CUMULATIVE total — the refused-call (no new usage) discriminator. */
  let prevTotal: number | null = null
  /** True while the current turn's last token_count is refusal-shaped. */
  let refusalPending = false
  let lastModel: string | undefined
  const modelByTurn = new Map<string, string>()

  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    if (!s.includes('rate_limits') && !s.includes('turn_context') && !s.includes('task_started') && !s.includes('task_complete')) continue
    let d: {
      timestamp?: unknown
      type?: unknown
      payload?: {
        type?: unknown
        turn_id?: unknown
        model?: unknown
        last_agent_message?: unknown
        completed_at?: unknown
        info?: { total_token_usage?: { total_tokens?: unknown } } | null
        rate_limits?: Record<string, unknown>
      }
    }
    try {
      d = JSON.parse(s)
    } catch {
      continue
    }
    const p = d.payload
    if (!p) continue

    // The dead turn's own turn_context names the model (real bytes: "gpt-5.6-sol").
    if (d.type === 'turn_context') {
      if (typeof p.model === 'string' && p.model) {
        lastModel = p.model
        if (typeof p.turn_id === 'string') modelByTurn.set(p.turn_id, p.model)
      }
      continue
    }

    if (p.type === 'task_started') {
      refusalPending = false // a refusal snapshot never crosses turn boundaries
      continue
    }

    if (p.type === 'task_complete') {
      // `=== null` (strict): the field is PRESENT and null in every real death; a turn that
      // produced a message carries the message. The conjunction with refusalPending is what
      // keeps docs/19 §8 honest — null alone is an absence, not a signal.
      const died = refusalPending && p.last_agent_message === null
      refusalPending = false
      if (!died) continue
      // Event time = completed_at (epoch s), NOT the line timestamp: a resumed session
      // REPLAYS history with fresh line timestamps but keeps the original completed_at —
      // keying on it stops a replayed old death from re-raising after recovery.
      const atMs = typeof p.completed_at === 'number' ? p.completed_at * 1000 : toMs(d.timestamp)
      if (atMs === null || atMs <= sinceMs) continue
      const exhausted = [lastWindowed?.primary, lastWindowed?.secondary].filter(
        (w): w is CodexWindow => !!w && typeof w.used_percent === 'number' && w.used_percent >= 100,
      )
      const resets = exhausted
        .map(w => (typeof w.resets_at === 'number' ? w.resets_at * 1000 : null))
        .filter((n): n is number => n !== null)
      // usage_limit_exceeded = codex's own error-code vocabulary (0.144.1 binary), applied
      // only when an exhausted window evidences the class; else our honest fallback.
      const errorType = exhausted.length ? 'usage_limit_exceeded' : 'api-refusal'
      const parts = lastWindowed
        ? [describeWindow('primary', lastWindowed.primary ?? {}), describeWindow('secondary', lastWindowed.secondary ?? {})].filter(Boolean)
        : []
      const plan = lastWindowed?.planType ? ` plan=${lastWindowed.planType}` : ''
      found = {
        errorType,
        model: (typeof p.turn_id === 'string' ? modelByTurn.get(p.turn_id) : undefined) ?? lastModel,
        content: `Codex turn died on a refused API call (${errorType})${plan}${parts.length ? ` — ${parts.join('; ')}` : ''}`,
        resetsAtMs: resets.length ? Math.max(...resets) : undefined,
        sessionId,
        atMs,
        cwd,
      }
      continue
    }

    const rl = p.rate_limits
    if (!rl) continue
    const primary = asWindow(rl.primary)
    const secondary = asWindow(rl.secondary)
    if (primary || secondary) lastWindowed = { primary, secondary, planType: typeof rl.plan_type === 'string' ? rl.plan_type : undefined }
    // Did this snapshot's call consume anything? info:null (fresh session, refused outright)
    // or cumulative totals identical to the previous token_count = NO — the refused-call
    // discriminator. Unknown previous (tail cut) counts as usage: conservative, no guess.
    const total = typeof p.info?.total_token_usage?.total_tokens === 'number' ? p.info.total_token_usage.total_tokens : null
    const noUsage = p.info === null ? true : prevTotal !== null && total !== null && total === prevTotal
    if (total !== null) prevTotal = total
    const unlimited = (rl.credits as { unlimited?: unknown } | null | undefined)?.unlimited === true
    refusalPending = !primary && !secondary && !unlimited && noUsage

    // Path (a) — forward-compat: NON-NULL reached type, never the variant strings.
    const reached = rl.rate_limit_reached_type
    if (reached === null || reached === undefined || reached === '') continue
    const atMs = toMs(d.timestamp)
    if (atMs === null || atMs <= sinceMs) continue
    const pWin = primary ?? {}
    const sWin = secondary ?? {}
    // Which window is blocking? Codex does not say — reported for the FULLEST one, the
    // only defensible read. Both windows ride in `content`, so the human sees the raw
    // fact even if the heuristic picked wrong.
    const pu = typeof pWin.used_percent === 'number' ? pWin.used_percent : -1
    const su = typeof sWin.used_percent === 'number' ? sWin.used_percent : -1
    const blocking = su > pu ? sWin : pWin
    const resetsAtMs = typeof blocking.resets_at === 'number' ? blocking.resets_at * 1000 : undefined
    const parts = [describeWindow('primary', pWin), describeWindow('secondary', sWin)].filter(Boolean)
    const plan = typeof rl.plan_type === 'string' ? ` plan=${rl.plan_type}` : ''
    found = {
      errorType: String(reached),
      content: `Codex usage limit reached (${String(reached)})${plan}${parts.length ? ` — ${parts.join('; ')}` : ''}`,
      resetsAtMs,
      sessionId,
      atMs,
      cwd,
      model: lastModel,
    }
  }
  return found
}

// ─────────────────────────────────────────────────────────────────────────────
// The sweep — find changed session files, attribute them, raise notices
// ─────────────────────────────────────────────────────────────────────────────

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
    const t = readSessionSlices(file, TAIL_BYTES)
    if (t) push(parseClaudeTranscript(t.tail, floor), 'claude')
  }
  // codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  for (const file of changedJsonl(deps.codexSessionsDir, floor, CODEX_WALK_DEPTH)) {
    const t = readSessionSlices(file, TAIL_BYTES)
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
        // The runtime event's OWN timestamp — lets the board tell a new occurrence from the
        // same line re-read by the deliberately-overlapping sweep window.
        eventAtMs: d.atMs,
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
