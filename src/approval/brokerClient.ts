// brokerClient — the shared client transport for the human-approval broker (docs/17). Both the
// runtime hook (approval/hook.ts, the ASK side of a gated peer's PreToolUse/PermissionRequest) and the
// supervisor circuit-breaker (supervisor/approvalRoute.ts, Unit 4 — the pty-scrape ASK side above the
// permission layer) POST a blocking approval request to the daemon's `/fleet/v1/approvals` and await a
// human decision. Factoring the request/response contract into ONE place (headers, optional H8 bearer,
// abort-timeout, throw-on-non-200) makes the two callers behave IDENTICALLY by construction — the same
// parity-by-one-source discipline as buildLaunchInvocation.
//
// Dependency-light on purpose: fetch + a router.json path resolver (readFileSync + pluginStateDir). The
// supervisor daemon dynamic-imports this into its detached @xterm process, so it must never pull the
// central router / transport graph.

import { readFileSync } from 'fs'
import { join } from 'path'
import { pluginStateDir } from '../storage/index.ts'

export interface ApprovalDecision {
  decision: 'allow' | 'deny'
  reason?: string
}

/** The request body POST /fleet/v1/approvals accepts (broker.request input; docs/17 §2).
 *  `kind` is the taxonomy tag (tool | plan | question | circuit-breaker); the hook sends tool/plan,
 *  the supervisor breaker sends circuit-breaker. */
export interface ApprovalRequestBody {
  personality: string
  runtime: string
  kind: string
  tool: string
  content: string
  summary: string
}

/** Resolve the daemon fleet base URL (origin-form, no path) from router.json's `tcp` field, else the
 *  well-known loopback default. TCP loopback is always served (the daemon dual-listens), so a client
 *  never needs the unix socket. */
export function resolveFleetBase(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const routerJson = join(pluginStateDir('iapeer', { env }), 'router.json')
    const parsed = JSON.parse(readFileSync(routerJson, 'utf8')) as { tcp?: unknown }
    if (typeof parsed.tcp === 'string' && parsed.tcp) return parsed.tcp.replace(/\/mcp\/?$/, '')
  } catch {
    /* no router.json → default below */
  }
  const port = env.IAPEER_PORT?.trim() || '8765'
  return `http://127.0.0.1:${port}`
}

/** Client-side hold ceiling — comfortably ABOVE the broker's default-deny timeout (300 s) so the
 *  broker's answer always arrives first; if the daemon is dead the fetch aborts and the caller fails
 *  safe to deny. */
export const APPROVAL_FETCH_TIMEOUT_MS = 600_000

export interface RequestApprovalDeps {
  env?: NodeJS.ProcessEnv
  /** Injectable fetch (tests). Default global fetch. */
  fetch?: typeof fetch
  /** Injectable client timeout (tests). */
  timeoutMs?: number
  /** External cancel: aborting this signal aborts the long-poll fetch (the daemon sees the requester
   *  transport close and settles the pending request cancel/default-deny, clearing it from every
   *  face). The supervisor uses it to close a request whose modal disappeared before a decision. */
  signal?: AbortSignal
}

/**
 * POST a blocking approval request and await the human's decision. Long-poll: the daemon holds the
 * connection until a face answers or the broker's default-deny timeout fires, then returns
 * `{ id, decision, reason? }`. THROWS on any transport failure (daemon unreachable, abort/timeout,
 * non-200) — the CALLER owns the fail-safe (both the hook and the supervisor deny on a throw). A
 * normalized decision comes back: allow carries no reason; deny always carries one.
 */
export async function requestApproval(base: string, body: ApprovalRequestBody, deps: RequestApprovalDeps = {}): Promise<ApprovalDecision> {
  const env = deps.env ?? process.env
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? APPROVAL_FETCH_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  ;(timer as { unref?: () => void }).unref?.()
  const onExternalAbort = (): void => controller.abort()
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort()
    else deps.signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const bearer = env.IAPEER_BEARER_TOKEN?.trim()
    if (bearer) headers.authorization = `Bearer ${bearer}`
    const resp = await doFetch(`${base}/fleet/v1/approvals`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`daemon returned ${resp.status}`)
    const data = (await resp.json()) as ApprovalDecision
    return data.decision === 'allow' ? { decision: 'allow' } : { decision: 'deny', reason: data.reason || 'denied' }
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', onExternalAbort)
  }
}
