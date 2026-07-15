// Notice board — the in-daemon store of OWNER-FACING notices (docs/19). The daemon
// noticed something the owner must know about a peer, and no one else can tell him: the
// canonical case is a peer left MUTE by a structural API error (rate limit, overload,
// expired auth) — such a peer cannot report its own failure, and an Implementer peer has
// no telegram face of its own. So the notice travels the daemon's OWN surface, exactly as
// an approval request does.
//
// DELIBERATELY NOT AN APPROVAL. An approval is request → decision → unblock: a caller
// long-polls and something is BLOCKED until a human answers. A notice is one-way: nobody
// waits, nothing unblocks, there is no decision to make. Reusing the approval broker here
// would drag a promise/timeout/fail-safe-deny machine into a problem that has none of
// those. What IS shared is the SURFACE: a durable log tailed into the fleet SSE stream, an
// additive snapshot field, and a GET endpoint for the verbatim content.
//
// TTL + DEDUP, and the two are ONE mechanism. A mute peer re-emits its error on EVERY
// attempted turn — a naive board would raise a card per attempt and bury the owner. So a
// notice carries a `dedupKey` (peer + runtime + kind + errorType + model): while a notice
// with that key is LIVE, a repeat detection only bumps `count`/`lastMs` — no new id, no new
// log line, no new SSE event. The owner sees one card that says "×7", not seven cards.
// When it expires (TTL) and the peer is STILL broken, the next detection raises a fresh
// notice — a deliberate periodic reminder rather than one card that scrolls away forever.
//
// In-memory + ephemeral: notices do NOT survive a daemon restart (a restart re-detects
// within one watch tick — the transcript evidence is on disk and is re-read). The durable
// notices.log is the audit/observability trace, not a recovery store.

import { appendNoticeEvent } from './noticeslog.ts'

/** v1 taxonomy of notices. `peer-mute` = a structural API error left the peer unable to
 *  answer. Free-form-tolerant — new kinds ride the same surface without a client change. */
export type NoticeKind = 'peer-mute' | string

export interface NoticeInput {
  personality: string
  runtime: string
  /** Taxonomy tag (peer-mute | …). */
  kind: NoticeKind
  /** The runtime's OWN error taxonomy value — `rate_limit`, `overloaded`, … Never
   *  invented by us: it is the structural field the runtime wrote (docs/19 §2). */
  errorType: string
  /** The model that hit the wall, when the runtime says which (claude names it only in
   *  prose; codex does not name it at all). ABSENT rather than guessed. */
  model?: string
  /** When the limit lifts, epoch-ms — ONLY when the runtime states it. Claude does not
   *  for a per-model bucket ("try again later"), so this is absent there: an honest
   *  omission, never an extrapolation from the 5h/7d buckets (a DIFFERENT limit). */
  resetsAtMs?: number
  /** One-line summary for the SSE event / badge. */
  summary?: string
  /** The runtime's VERBATIM message — shown to the human in every face. */
  content: string
  /** The session that hit it (correlation with the transcript on disk). */
  sessionId?: string
  /** When the underlying runtime event happened (the transcript line's own timestamp) —
   *  NOT when we swept. This is what makes `count` mean OCCURRENCES rather than sweeps:
   *  the sweep window deliberately overlaps, so the same line is re-read across passes.
   *  Absent → every raise counts (the caller has no event clock to dedup against). */
  eventAtMs?: number
}

export interface Notice extends NoticeInput {
  id: string
  summary: string
  dedupKey: string
  /** First occurrence. */
  createdMs: number
  /** Latest OCCURRENCE (not the latest sweep that re-read it). */
  lastMs: number
  expiresMs: number
  /** Distinct occurrences folded into this notice (≥1) — how many times the peer actually
   *  hit the wall, which is what "×N" claims to the owner. */
  count: number
  /** The newest event timestamp already counted — the overlap discriminator. */
  lastEventMs?: number
}

export interface NoticeBoardOptions {
  /** cfg.eventLogDir — notices.log lives here (falsy → no durable log, hermetic). */
  logDir?: string
  env?: NodeJS.ProcessEnv
  /** How long a notice stays live, and therefore how long the same condition is deduped.
   *  Default IAPEER_NOTICE_TTL_MS or 1 h. */
  ttlMs?: number
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number
}

const DEFAULT_TTL_MS = 3_600_000

function envPosInt(raw: string | undefined, dflt: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n')
  return (nl >= 0 ? s.slice(0, nl) : s).trim()
}

/** The dedup identity of a condition: the same peer hitting the same wall on the same
 *  runtime with the same model. Model is part of the key on purpose — a peer that falls
 *  back from one model to another and hits ITS limit too is a NEW fact for the owner. */
export function noticeDedupKey(input: Pick<NoticeInput, 'personality' | 'runtime' | 'kind' | 'errorType' | 'model'>): string {
  return [input.personality, input.runtime, input.kind, input.errorType, input.model ?? ''].join('|')
}

export class NoticeBoard {
  private readonly live = new Map<string, Notice>()
  private counter = 0
  private readonly logDir?: string
  private readonly env: NodeJS.ProcessEnv
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(opts: NoticeBoardOptions = {}) {
    this.logDir = opts.logDir
    this.env = opts.env ?? process.env
    this.ttlMs = opts.ttlMs ?? envPosInt(this.env.IAPEER_NOTICE_TTL_MS, DEFAULT_TTL_MS)
    this.now = opts.now ?? Date.now
  }

  /**
   * Raise a notice, or fold it into the live one with the same dedupKey.
   * Returns the notice and whether this call DEDUPED (folded) rather than raised. A
   * folded call is deliberately silent: no id, no log line, no SSE event — only
   * `count`/`lastMs` move (see the dedup note in the module header).
   */
  raise(input: NoticeInput): { notice: Notice; deduped: boolean } {
    const nowMs = this.now()
    this.prune(nowMs)
    const dedupKey = noticeDedupKey(input)
    const existing = this.live.get(dedupKey)
    if (existing) {
      // Same condition. Is this a NEW occurrence, or the same runtime event re-read by an
      // overlapping sweep? Counting the latter would inflate "×N" into a claim the owner
      // cannot check — 2 real refusals rendering as ×3. Only a strictly newer event counts.
      const at = input.eventAtMs
      const isNewOccurrence = at === undefined || existing.lastEventMs === undefined || at > existing.lastEventMs
      if (isNewOccurrence) {
        existing.count += 1
        existing.lastMs = nowMs
        if (at !== undefined) existing.lastEventMs = at
      }
      return { notice: existing, deduped: true }
    }
    const id = `n${++this.counter}`
    const summary = (input.summary?.trim() || firstLine(input.content) || input.errorType).slice(0, 240)
    const notice: Notice = {
      ...input,
      id,
      summary,
      dedupKey,
      createdMs: nowMs,
      lastMs: nowMs,
      expiresMs: nowMs + this.ttlMs,
      count: 1,
      lastEventMs: input.eventAtMs,
    }
    this.live.set(dedupKey, notice)
    appendNoticeEvent(
      this.logDir,
      {
        ev: 'notice-raised',
        id,
        personality: input.personality,
        runtime: input.runtime,
        kind: input.kind,
        error_type: input.errorType,
        model: input.model,
        // Emit the reset as BOTH epoch-ms and a readable stamp, or omit entirely.
        // A reader must never have to guess whether "unknown" means "no limit" or
        // "we didn't look" — an absent field means the runtime did not state it.
        resets_at: input.resetsAtMs,
        resets_at_iso: input.resetsAtMs ? new Date(input.resetsAtMs).toISOString() : undefined,
        session: input.sessionId,
        summary,
        created: nowMs,
        expires: notice.expiresMs,
      },
      { env: this.env, nowMs },
    )
    return { notice, deduped: false }
  }

  /** All live notices, oldest first (GET /fleet/v1/notices + the snapshot field). */
  list(nowMs: number = this.now()): Notice[] {
    this.prune(nowMs)
    return [...this.live.values()].sort((a, b) => a.createdMs - b.createdMs)
  }

  /** One live notice by id (GET /fleet/v1/notices/<id> — full verbatim content). */
  get(id: string, nowMs: number = this.now()): Notice | undefined {
    this.prune(nowMs)
    return [...this.live.values()].find(n => n.id === id)
  }

  /** Live count (badge/metrics). */
  size(nowMs: number = this.now()): number {
    this.prune(nowMs)
    return this.live.size
  }

  /** Drop expired notices. Silent by design: an expiry is not news — either the peer
   *  recovered (nothing to say) or it is still broken and the next detection re-raises. */
  prune(nowMs: number = this.now()): void {
    for (const [key, n] of this.live) if (n.expiresMs <= nowMs) this.live.delete(key)
  }
}
