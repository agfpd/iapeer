// approval-hook — the blocking bridge from a runtime's PreToolUse hook to the daemon
// approval broker (docs/17). Installed (gated peers only) as the `command` of a claude /
// codex PreToolUse hook. On each matched tool call it: reads the runtime's hook JSON on
// stdin, builds a human-readable approval request, POSTs it to the daemon (long-poll,
// blocking until a human answers or the broker's default-deny timeout), and prints the
// runtime hook decision JSON on stdout. claude and codex share the PreToolUse output
// shape (`hookSpecificOutput.permissionDecision`), so ONE format serves both.
//
// FAIL-SAFE by construction: ANY failure (no PEER identity, daemon unreachable, malformed
// response, client timeout) prints a DENY with a reason — a gated peer is never allowed to
// act unapproved, and never hangs (the client timeout sits above the broker's).
//
// Pure helpers (parseHookInput / actionContent / formatHookDecision / resolveFleetBase)
// are unit-tested; runApprovalHook is the thin IO orchestration.

import { readFileSync } from 'fs'
import { join } from 'path'
import { pluginStateDir } from '../storage/index.ts'

export interface ApprovalDecision {
  decision: 'allow' | 'deny'
  reason?: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v)
}
function firstLine(s: string): string {
  const nl = s.indexOf('\n')
  return (nl >= 0 ? s.slice(0, nl) : s).trim()
}
function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[+${s.length - max} chars]` : s
}

export interface ActionContent {
  kind: 'tool' | 'plan'
  content: string
  summary: string
}

/** Turn a PreToolUse (tool_name, tool_input) into the human-readable content + summary the
 *  broker shows in every channel. Covers the v1 nomenclature (docs/17 §2); an unknown tool
 *  falls back to a pretty-printed tool_input so nothing is opaque. */
export function actionContent(toolName: string, toolInput: Record<string, unknown> | undefined): ActionContent {
  const ti = toolInput ?? {}
  switch (toolName) {
    case 'Bash': {
      const cmd = str(ti.command)
      const desc = str(ti.description)
      return { kind: 'tool', content: desc ? `${cmd}\n\n# ${desc}` : cmd, summary: cmd || 'Bash' }
    }
    case 'Write': {
      const fp = str(ti.file_path)
      return { kind: 'tool', content: `Write ${fp}\n\n${clip(str(ti.content), 8000)}`, summary: `Write ${fp}` }
    }
    case 'Edit': {
      const fp = str(ti.file_path)
      return {
        kind: 'tool',
        content: `Edit ${fp}\n\n--- old\n${clip(str(ti.old_string), 3000)}\n+++ new\n${clip(str(ti.new_string), 3000)}`,
        summary: `Edit ${fp}`,
      }
    }
    case 'MultiEdit': {
      const fp = str(ti.file_path)
      const edits = Array.isArray(ti.edits) ? ti.edits : []
      return { kind: 'tool', content: `MultiEdit ${fp} (${edits.length} edits)\n\n${clip(JSON.stringify(edits, null, 2), 6000)}`, summary: `MultiEdit ${fp} (${edits.length})` }
    }
    case 'NotebookEdit': {
      const fp = str(ti.notebook_path)
      return { kind: 'tool', content: `NotebookEdit ${fp}\n\n${clip(str(ti.new_source), 6000)}`, summary: `NotebookEdit ${fp}` }
    }
    case 'ExitPlanMode': {
      const plan = str(ti.plan)
      return { kind: 'plan', content: plan, summary: firstLine(plan) || 'plan' }
    }
    // codex patch application (tool_input carries the patch text)
    case 'apply_patch':
    case 'ApplyPatch': {
      const patch = str(ti.input ?? ti.patch ?? ti)
      return { kind: 'tool', content: clip(patch, 8000), summary: `apply_patch (${firstLine(patch) || 'diff'})` }
    }
    default: {
      const body = clip(JSON.stringify(ti, null, 2), 6000)
      return { kind: 'tool', content: `${toolName}\n\n${body}`, summary: toolName }
    }
  }
}

export interface HookInput {
  toolName: string
  toolInput: Record<string, unknown> | undefined
}

/** Parse the runtime's PreToolUse stdin JSON to the fields we need. Throws on non-JSON /
 *  missing tool_name (the caller turns a throw into a fail-safe deny). */
export function parseHookInput(stdin: string): HookInput {
  const raw = JSON.parse(stdin) as Record<string, unknown>
  const toolName = raw.tool_name
  if (typeof toolName !== 'string' || !toolName) throw new Error('hook stdin has no tool_name')
  const toolInput =
    raw.tool_input && typeof raw.tool_input === 'object' && !Array.isArray(raw.tool_input)
      ? (raw.tool_input as Record<string, unknown>)
      : undefined
  return { toolName, toolInput }
}

/** The PreToolUse decision JSON both runtimes accept. A deny carries the reason to the model. */
export function formatHookDecision(d: ApprovalDecision): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.decision,
      ...(d.decision === 'deny' && d.reason ? { permissionDecisionReason: d.reason } : {}),
    },
  })
}

/** Resolve the daemon fleet base URL (origin-form, no path) from router.json's `tcp`
 *  field, else the well-known loopback default. TCP loopback is always served (the daemon
 *  dual-listens), so the hook never needs the unix socket. */
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

/** Client-side hold ceiling — comfortably ABOVE the broker's default-deny timeout (300s)
 *  so the broker's answer always arrives first; if the daemon is dead the fetch aborts and
 *  we fail-safe deny. */
const HOOK_FETCH_TIMEOUT_MS = 600_000

export interface RunHookDeps {
  env?: NodeJS.ProcessEnv
  /** Injectable fetch (tests). Default global fetch. */
  fetch?: typeof fetch
  /** Injectable client timeout (tests). */
  timeoutMs?: number
}

/**
 * Full hook run: stdin JSON → broker → decision JSON. Returns the string to print on
 * stdout (always valid JSON) and an exit code (always 0 — the DENY is expressed in the
 * JSON, not the exit code, so the reason reaches the model). Never throws.
 */
export async function runApprovalHook(stdin: string, deps: RunHookDeps = {}): Promise<{ output: string; exitCode: number }> {
  const env = deps.env ?? process.env
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? HOOK_FETCH_TIMEOUT_MS
  try {
    const { toolName, toolInput } = parseHookInput(stdin)
    const personality = env.PEER_PERSONALITY?.trim()
    if (!personality) throw new Error('no PEER_PERSONALITY in the hook environment')
    const runtime = env.PEER_RUNTIME?.trim() || 'claude'
    const { kind, content, summary } = actionContent(toolName, toolInput)
    const base = resolveFleetBase(env)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      const bearer = env.IAPEER_BEARER_TOKEN?.trim()
      if (bearer) headers.authorization = `Bearer ${bearer}`
      const resp = await doFetch(`${base}/fleet/v1/approvals`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ personality, runtime, kind, tool: toolName, content, summary }),
        signal: controller.signal,
      })
      if (!resp.ok) throw new Error(`daemon returned ${resp.status}`)
      const data = (await resp.json()) as ApprovalDecision
      const decision: ApprovalDecision =
        data.decision === 'allow' ? { decision: 'allow' } : { decision: 'deny', reason: data.reason || 'denied' }
      return { output: formatHookDecision(decision), exitCode: 0 }
    } finally {
      clearTimeout(timer)
    }
  } catch (e) {
    // FAIL-SAFE: deny with a reason (never allow-by-accident, never hang).
    return {
      output: formatHookDecision({ decision: 'deny', reason: `iapeer approval unavailable (${e instanceof Error ? e.message : String(e)}) — denied fail-safe` }),
      exitCode: 0,
    }
  }
}
