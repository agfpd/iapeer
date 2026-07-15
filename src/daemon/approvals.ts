// Approval broker — the in-daemon queue that is the SINGLE SOURCE OF TRUTH for
// human-approval requests (docs/17). Every channel (the runtime hook that ASKS, and
// the CLI / tray / telegram / web-console faces that ANSWER) is an interface to THIS one queue: a
// decision from any face resolves the request everywhere (the owner's invariant).
//
// Flow: a gated peer's PreToolUse hook blocks and POSTs /fleet/v1/approvals → the fleet
// handler calls broker.request(...) and awaits the returned promise (long-poll) → the
// broker enqueues, emits `approval-request` (approvals.log → SSE), and holds the promise
// → a face calls broker.resolve(id, …) (via POST /fleet/v1/approvals/<id>/approve|deny)
// → the promise resolves, the fleet handler writes the runtime hook JSON back, the tool
// proceeds or is blocked with the reason. A per-request timeout resolves default-DENY so
// a peer never hangs. Every failure direction is deny (fail-safe): timeout, requester
// disconnect, unknown id.
//
// In-memory + ephemeral: pending requests do NOT survive a daemon restart (the blocking
// hook connection breaks on restart → the hook fails safe to deny). The durable
// approvals.log is the audit/observability trace, not a recovery store.

import { appendApprovalEvent } from './approvalslog.ts'

/** v1 taxonomy of intercepted blocking requests (docs/17 §2). Free-form-tolerant. */
export type ApprovalKind = 'tool' | 'plan' | 'question' | 'circuit-breaker'

export interface ApprovalRequestInput {
  personality: string
  runtime: string
  /** Taxonomy tag (tool | plan | question | circuit-breaker | …). */
  kind: ApprovalKind | string
  /** The specific tool / breaker name, e.g. `Bash`, `Edit`, `dangerous-rm`. */
  tool: string
  /** FULL human-readable content of the action — the command, the diff, the plan text,
   *  the circuit-breaker prompt. Shown to the human in every channel (criterion #7). */
  content: string
  /** One-line summary for the SSE event / badge (default: the first line of content). */
  summary?: string
  /** Short title, e.g. "boris · Bash" (default: "<personality> · <tool>"). */
  title?: string
  /** nature-peers who may answer (informational in v1 — same-uid faces are trusted). */
  approvers?: string[]
}

export interface PendingApproval extends ApprovalRequestInput {
  id: string
  summary: string
  title: string
  approvers: string[]
  createdMs: number
  expiresMs: number
}

export interface ApprovalDecision {
  decision: 'allow' | 'deny'
  reason?: string
}

export interface ResolveMeta {
  /** The approver who answered (a nature-peer personality). */
  by?: string
  /** The surface that answered: cli | tray | telegram | web | timeout | disconnect.
   *  Self-declared by the answering face (free-form-tolerant); absent when the face
   *  did not self-identify — the audit line then omits `via` rather than guessing. */
  via?: string
}

interface Entry {
  item: PendingApproval
  resolve: (d: ApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ApprovalBrokerOptions {
  /** cfg.eventLogDir — approvals.log lives here (falsy → no durable log, hermetic). */
  logDir?: string
  env?: NodeJS.ProcessEnv
  /** Per-request default-deny timeout. Default IAPEER_APPROVAL_TIMEOUT_MS or 300 s.
   *  MUST stay below the runtime hook's own timeout (claude/codex default 600 s) so the
   *  broker's default-deny wins before the runtime kills the hook (fail-safe ordering). */
  timeoutMs?: number
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number
}

const DEFAULT_TIMEOUT_MS = 300_000

function envPosInt(raw: string | undefined, dflt: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

function firstLine(s: string): string {
  const nl = s.indexOf('\n')
  return (nl >= 0 ? s.slice(0, nl) : s).trim()
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Entry>()
  private counter = 0
  private readonly logDir?: string
  private readonly env: NodeJS.ProcessEnv
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(opts: ApprovalBrokerOptions = {}) {
    this.logDir = opts.logDir
    this.env = opts.env ?? process.env
    this.timeoutMs = opts.timeoutMs ?? envPosInt(this.env.IAPEER_APPROVAL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
    this.now = opts.now ?? Date.now
  }

  /** Enqueue a request and return its id + a promise that resolves when a face answers
   *  or the timeout fires (default-deny). The caller (fleet handler) awaits `decision`
   *  and MUST call `cancel(id)` if its transport dies before the promise settles. */
  request(input: ApprovalRequestInput): { id: string; decision: Promise<ApprovalDecision> } {
    const id = `a${++this.counter}`
    const createdMs = this.now()
    const expiresMs = createdMs + this.timeoutMs
    const summary = (input.summary?.trim() || firstLine(input.content) || input.tool).slice(0, 240)
    const title = input.title?.trim() || `${input.personality} · ${input.tool}`
    const approvers = input.approvers ?? []
    const item: PendingApproval = { ...input, id, summary, title, approvers, createdMs, expiresMs }
    let resolve!: (d: ApprovalDecision) => void
    const decision = new Promise<ApprovalDecision>(res => {
      resolve = res
    })
    const timer = setTimeout(
      () => this.settle(id, { decision: 'deny', reason: 'approval timed out (default-deny)' }, { via: 'timeout' }),
      this.timeoutMs,
    )
    ;(timer as { unref?: () => void }).unref?.()
    this.pending.set(id, { item, resolve, timer })
    appendApprovalEvent(
      this.logDir,
      {
        ev: 'approval-request',
        id,
        personality: input.personality,
        runtime: input.runtime,
        kind: input.kind,
        tool: input.tool,
        summary,
        created: createdMs,
        expires: expiresMs,
        approvers: approvers.join(',') || undefined,
      },
      { env: this.env, nowMs: createdMs },
    )
    return { id, decision }
  }

  /** All pending requests, oldest first (GET /fleet/v1/approvals + `iapeer approvals`). */
  list(): PendingApproval[] {
    return [...this.pending.values()].map(e => e.item).sort((a, b) => a.createdMs - b.createdMs)
  }

  /** One pending request by id (GET /fleet/v1/approvals/<id> — full content). */
  get(id: string): PendingApproval | undefined {
    return this.pending.get(id)?.item
  }

  /** Answer a request from a face. Returns false iff the id is unknown (already resolved,
   *  expired, or never existed) — the caller reports 404. */
  resolve(id: string, decision: ApprovalDecision, meta: ResolveMeta = {}): boolean {
    if (!this.pending.has(id)) return false
    this.settle(id, decision, meta)
    return true
  }

  /** Requester transport died before an answer — settle default-deny + drop from the
   *  queue so it does not linger (the asking hook is gone; the tool call is aborted). */
  cancel(id: string, reason = 'requester disconnected'): boolean {
    if (!this.pending.has(id)) return false
    this.settle(id, { decision: 'deny', reason }, { via: 'disconnect' })
    return true
  }

  /** Pending count (badge/metrics). */
  size(): number {
    return this.pending.size
  }

  private settle(id: string, decision: ApprovalDecision, meta: ResolveMeta): void {
    const entry = this.pending.get(id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(id)
    const nowMs = this.now()
    appendApprovalEvent(
      this.logDir,
      {
        ev: 'approval-resolved',
        id,
        personality: entry.item.personality,
        runtime: entry.item.runtime,
        decision: decision.decision,
        reason: decision.reason,
        by: meta.by,
        via: meta.via,
        latencyMs: nowMs - entry.item.createdMs,
      },
      { env: this.env, nowMs },
    )
    entry.resolve(decision)
  }
}
