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
  /** Class tag — 'dangerous-rm' | 'command-approval'. Sent as the broker `tool` + `summary`. */
  taxonomy: string
  /** Best-effort one-line command/target trace parsed off the pane. Sent as the broker `content`. */
  detail: string
  /** Keys to inject on ALLOW — the position-robust affirmative ('1'+Enter). */
  approveBytes: Buffer
  /** Keys to inject on DENY — the taxonomy-specific decline (2.No | 3.No). */
  denyBytes: Buffer
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
  let decision: ApprovalDecision
  try {
    decision = await requestApproval(
      resolveFleetBase(deps.env),
      {
        personality: deps.personality,
        runtime: deps.runtime,
        kind: 'circuit-breaker',
        tool: input.taxonomy,
        content: input.detail,
        summary: input.taxonomy,
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
