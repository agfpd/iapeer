// approval CLI — the operator faces of the approval broker (docs/17 §5), all thin clients
// of the daemon fleet-API (the queue lives in the daemon; these reach it over HTTP, like the
// tray). `approval-hook` is the runtime-installed bridge; `approvals`/`approve`/`deny` are the
// host answer channel; `approval-mode` is the per-peer gated/yolo toggle.

import { resolveFleetBase } from './brokerClient.ts'
import { setApprovalMode } from './install.ts'
import { readPeersIndex } from '../registry/index.ts'
import { readPeerProfile, approvalModeOf, type ApprovalMode } from '../identity/index.ts'

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const bearer = env.IAPEER_BEARER_TOKEN?.trim()
  return { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }
}

interface PendingApprovalRow {
  id: string
  personality: string
  runtime: string
  kind: string
  tool: string
  summary: string
  content: string
  createdMs: number
  expiresMs: number
}

function ageStr(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - ms) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
}

/** `iapeer approvals [--json]` — the pending queue. Each row carries the VERBATIM action
 *  content (a Bash command shown in full — boris's CLI acceptance criterion). */
export async function approvalsList(json: boolean, env: NodeJS.ProcessEnv): Promise<{ text: string; code: number }> {
  const base = resolveFleetBase(env)
  let rows: PendingApprovalRow[]
  try {
    const resp = await fetch(`${base}/fleet/v1/approvals`, { headers: authHeaders(env) })
    if (!resp.ok) return { text: `approvals: daemon returned ${resp.status}\n`, code: 1 }
    rows = ((await resp.json()) as { approvals: PendingApprovalRow[] }).approvals
  } catch (e) {
    return { text: `approvals: cannot reach daemon (${e instanceof Error ? e.message : String(e)})\n`, code: 1 }
  }
  if (json) return { text: `${JSON.stringify(rows, null, 2)}\n`, code: 0 }
  if (rows.length === 0) return { text: 'no pending approvals\n', code: 0 }
  const now = Date.now()
  const lines = [`${rows.length} pending approval(s):`]
  for (const r of rows) {
    lines.push(`  ${r.id}  ${r.personality}/${r.runtime}  [${r.kind}:${r.tool}]  ${ageStr(r.createdMs, now)} ago`)
    lines.push(`      ${r.summary}`) // verbatim command / file / plan-line
  }
  lines.push('', 'approve: iapeer approve <id>   ·   deny: iapeer deny <id> [reason]')
  return { text: `${lines.join('\n')}\n`, code: 0 }
}

/** `iapeer approve <id>` / `iapeer deny <id> [reason]` — resolve a pending request. The
 *  decision propagates to whichever channel is waiting (the blocking hook) and clears it
 *  everywhere. `approver` (default: the single natural peer) records who answered. */
export async function resolveApproval(
  id: string,
  action: 'approve' | 'deny',
  opts: { reason?: string; approver?: string },
  env: NodeJS.ProcessEnv,
): Promise<{ text: string; code: number }> {
  const base = resolveFleetBase(env)
  const approver = opts.approver ?? defaultApprover(env)
  const body: Record<string, unknown> = { via: 'cli', ...(approver ? { approver } : {}), ...(opts.reason ? { reason: opts.reason } : {}) }
  try {
    const resp = await fetch(`${base}/fleet/v1/approvals/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: authHeaders(env),
      body: JSON.stringify(body),
    })
    if (resp.status === 404) return { text: `no pending approval "${id}" (already resolved, expired, or unknown)\n`, code: 1 }
    if (!resp.ok) return { text: `${action}: daemon returned ${resp.status}\n`, code: 1 }
    return { text: `${action === 'approve' ? 'approved' : 'denied'} ${id}${opts.reason ? ` (${opts.reason})` : ''}\n`, code: 0 }
  } catch (e) {
    return { text: `${action}: cannot reach daemon (${e instanceof Error ? e.message : String(e)})\n`, code: 1 }
  }
}

/** The default approver: the registry's single natural-intelligence peer (the owner). null
 *  when zero/several — then the answer is recorded without a `by`. */
function defaultApprover(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const natural = readPeersIndex({ env }).peers.filter(p => p.intelligence === 'natural')
    return natural.length === 1 ? natural[0]!.personality : undefined
  } catch {
    return undefined
  }
}

/** `iapeer approval-mode <peer> [gated|yolo]` — read (no mode) or flip the toggle. Flipping
 *  persists the field + brings the runtime surfaces to the mode; a live session keeps its
 *  launched mode until a fresh session (the application moment). */
export function approvalModeCli(peer: string, mode: ApprovalMode | undefined, env: NodeJS.ProcessEnv): { text: string; code: number } {
  const rec = readPeersIndex({ env }).peers.find(p => p.personality === peer)
  if (!rec) return { text: `unknown peer "${peer}"\n`, code: 1 }
  if (!mode) {
    let current: ApprovalMode = 'yolo'
    try {
      current = approvalModeOf(readPeerProfile(rec.cwd))
    } catch {
      /* unreadable → yolo */
    }
    return { text: `${peer}: approval_mode=${current}\n`, code: 0 }
  }
  let result
  try {
    result = setApprovalMode(rec.cwd, mode, env)
  } catch (e) {
    return { text: `approval-mode: ${e instanceof Error ? e.message : String(e)}\n`, code: 1 }
  }
  const lines = [`${peer} → approval_mode=${mode}`, ...result.surfaces.map(s => `  · ${s}`)]
  lines.push('', 'applies on the peer\'s NEXT fresh session — run `iapeer new ' + peer + '` to apply now.')
  return { text: `${lines.join('\n')}\n`, code: 0 }
}
