// Supervisor circuit-breaker → human-approval routing (Unit 4, docs/17). The GATED half of the
// nag-watcher's 'approve' branch: instead of auto-pressing YES (the yolo status-quo), POST the breaker
// to the daemon approval broker, block on a human's allow/deny, and inject the decided keys into the
// pty — the AFFIRMATIVE keys on allow, the taxonomy-specific DECLINE keys on deny.
//
// FAIL-SAFE by construction: ANY broker failure (daemon unreachable, abort/timeout, non-200) resolves
// to DENY (inject the decline keys), NEVER auto-Yes — this is the engineering basis of gated=fail-safe
// (a gated peer under a supervision fault falls back to the safe answer, not the permissive one). The
// breaker still sits ABOVE the permission layer, so this is the ONLY interceptor for the prompts the
// runtime hook cannot see (dangerous-rm; an rm from a subprocess/script).
//
// IO is injected (fetch, the pty-write, the log, the clock), so the routing + fail-safe + key selection
// are unit-testable without a live daemon or a real pty.

import { requestApproval, resolveFleetBase, type ApprovalDecision } from '../approval/brokerClient.ts'

export interface BreakerApprovalInput {
  /** Class tag — 'dangerous-rm' | 'command-approval' | 'org-policy' | 'unknown-modal'. Sent as the
   *  broker `tool`. */
  taxonomy: string
  /** Broker taxonomy `kind` (docs/17): 'circuit-breaker' for the known breakers + org-policy, or
   *  'unknown-modal' for the generic residue. Default 'circuit-breaker'. */
  brokerKind?: string
  /** Known breakers: a one-line command/target trace. unknown-modal: the VERBATIM modal block. */
  detail: string
  /** unknown-modal only: the verbatim label of option 1 — what an ALLOW presses. Powers the explicit
   *  button semantics the human sees (owner's "new I must SEE and confirm — предметно"). */
  option1?: string
  /** Keys to inject on ALLOW — the position-robust affirmative ('1'+Enter). */
  approveBytes: Buffer
  /** Keys to inject on DENY — known: the taxonomy decline (2.No | 3.No); unknown-modal: Escape (cancel). */
  denyBytes: Buffer
}

/**
 * Compose the human-facing broker `content` + `summary`. KNOWN breakers (dangerous-rm / command-approval)
 * keep the Ф1 format verbatim (content = the parsed trace) — no regression. The new always-human classes
 * get an EXPLICIT button-semantics header so a human answering Allow/Deny knows precisely what each does
 * (boris's mandatory refinement): for an unknown modal, Allow presses option 1 (whose verbatim text is
 * shown) and Deny cancels via Esc; for org-policy, the known 1.Yes / 3.No mapping is stated. Pure —
 * unit-testable.
 */
export function composeApprovalContent(input: BreakerApprovalInput): { content: string; summary: string } {
  const kind = input.brokerKind ?? 'circuit-breaker'
  if (kind === 'unknown-modal') {
    const opt1 = input.option1?.trim() || '(option 1)'
    const content = [
      '⚠ Unrecognized blocking modal — iapeer could not classify it, so it is asking you.',
      `Allow → presses option 1: ${JSON.stringify(opt1)}`,
      "Deny  → cancels the modal (Esc); the peer's action is declined and it continues.",
      '',
      '─── modal (verbatim) ───',
      input.detail,
    ].join('\n')
    return { content, summary: `unrecognized blocking modal — Allow presses option 1: ${opt1}`.slice(0, 240) }
  }
  if (input.taxonomy === 'org-policy') {
    const content = [
      '⚠ Organization policy requires approval for this action (a barrier above the peer).',
      'Allow → presses "1. Yes" (proceed).',
      'Deny  → presses "3. No" (refuse); the reason goes to the model.',
      '',
      input.detail,
    ].join('\n')
    return { content, summary: `org-policy approval required — ${input.detail}`.slice(0, 240) }
  }
  // Known circuit-breaker (dangerous-rm / command-approval) — Ф1 format, unchanged.
  return { content: input.detail, summary: input.taxonomy }
}

export interface BreakerRouteDeps {
  personality: string
  runtime: string
  env: NodeJS.ProcessEnv
  /** Inject keys into the pty (child.terminal.write). */
  write: (bytes: Buffer) => void
  /** Injectable fetch (tests). */
  fetch?: typeof fetch
  /** Injectable client timeout (tests). */
  timeoutMs?: number
  /** Post-hoc audit line (console.warn in prod; a spy in tests). */
  log?: (line: string) => void
  /** Injectable clock (tests). Default Date.now. */
  now?: () => number
}

/**
 * POST the circuit-breaker to the human-approval broker, await the decision, and inject the decided
 * keys into the pty. Returns the decision for the caller's cooldown/in-flight bookkeeping. NEVER
 * throws — a broker failure fails safe to deny (decline keys injected). Every path leaves one audit
 * line: BREAKER-ALLOW / BREAKER-DENY with the taxonomy, the parsed detail, and (on deny) the reason.
 */
export async function routeCircuitBreaker(input: BreakerApprovalInput, deps: BreakerRouteDeps): Promise<ApprovalDecision> {
  const now = deps.now ?? Date.now
  const { content, summary } = composeApprovalContent(input)
  let decision: ApprovalDecision
  try {
    decision = await requestApproval(
      resolveFleetBase(deps.env),
      {
        personality: deps.personality,
        runtime: deps.runtime,
        kind: input.brokerKind ?? 'circuit-breaker',
        tool: input.taxonomy,
        content,
        summary,
      },
      { env: deps.env, fetch: deps.fetch, timeoutMs: deps.timeoutMs },
    )
  } catch (e) {
    // Broker unreachable / abort / non-200 → DENY (never auto-Yes). gated = fail-safe.
    decision = { decision: 'deny', reason: `iapeer approval unavailable (${e instanceof Error ? e.message : String(e)}) — denied fail-safe` }
  }
  deps.write(decision.decision === 'allow' ? input.approveBytes : input.denyBytes)
  deps.log?.(
    `[supervisor] BREAKER-${decision.decision.toUpperCase()} ${input.taxonomy} ts=${new Date(now()).toISOString()} ${input.detail}` +
      (decision.reason ? ` reason=${JSON.stringify(decision.reason)}` : ''),
  )
  return decision
}
