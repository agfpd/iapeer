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
// Pure helpers (parseHookInput / actionContent / formatHookDecision) are unit-tested;
// runApprovalHook is the thin IO orchestration over the shared broker transport (brokerClient).

import { type ApprovalDecision, requestApproval, resolveFleetBase } from './brokerClient.ts'

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

/** The two hook events we intercept. `PermissionRequest` (claude, and codex) fires ONLY when
 *  the runtime's permission config DECIDED to prompt — the primary, matcher-free interceptor
 *  (verified live 2.1.201: fires + suppresses the prompt + returns a decision, policy stays
 *  100% at the runtime). `PreToolUse` fires on every matched tool (codex structural path). */
export type HookEvent = 'PermissionRequest' | 'PreToolUse'

export interface HookInput {
  event: HookEvent
  toolName: string
  toolInput: Record<string, unknown> | undefined
}

/** Parse the runtime's hook stdin JSON. Throws on non-JSON / unknown event / missing tool_name
 *  (the caller turns a throw into a fail-safe exit-2 deny, which both events honor). */
export function parseHookInput(stdin: string): HookInput {
  const raw = JSON.parse(stdin) as Record<string, unknown>
  const evName = raw.hook_event_name
  const event: HookEvent =
    evName === 'PermissionRequest' ? 'PermissionRequest' : evName === 'PreToolUse' ? 'PreToolUse' : throwEvent(evName)
  const toolName = raw.tool_name
  if (typeof toolName !== 'string' || !toolName) throw new Error('hook stdin has no tool_name')
  const toolInput =
    raw.tool_input && typeof raw.tool_input === 'object' && !Array.isArray(raw.tool_input)
      ? (raw.tool_input as Record<string, unknown>)
      : undefined
  return { event, toolName, toolInput }
}
function throwEvent(v: unknown): never {
  throw new Error(`hook stdin has an unexpected hook_event_name "${String(v)}"`)
}

/**
 * The decision JSON in the shape the given event (and runtime) accepts. A deny carries the
 * reason to the model. PermissionRequest uses `decision.behavior` (+ `message`); PreToolUse
 * uses `permissionDecision` (+ `permissionDecisionReason`).
 *
 * codex vs claude on the PreToolUse **allow** path (VERIFIED LIVE, codex-cli 0.142.5): codex
 * honors ONLY `permissionDecision:"deny"` — emitting `permissionDecision:"allow"` marks the
 * hook **Failed** (fail-open, the "PreToolUse Failed"/"unsupported permissionDecision:allow"
 * the operator saw). The clean allow on codex is to **abstain**: emit NOTHING (exit 0) → codex
 * marks the hook **Completed** and the tool proceeds under the gated bypass base (approval is a
 * DENY-or-abstain gate on codex, not a two-sided allow/deny one). claude's PreToolUse DOES honor
 * `permissionDecision:"allow"`, so it keeps the affirmative form. Deny is identical on both.
 */
export function formatHookDecision(d: ApprovalDecision, event: HookEvent, runtime = 'claude'): string {
  if (event === 'PermissionRequest') {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: d.decision, ...(d.decision === 'deny' && d.reason ? { message: d.reason } : {}) },
      },
    })
  }
  // PreToolUse
  if (d.decision === 'allow') {
    // codex: abstain (empty output) — an affirmative "allow" fails the hook (verified live 0.142.5).
    if (runtime === 'codex') return ''
    // claude: affirmative allow is honored.
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })
  }
  // deny (+ reason) — honored identically on claude and codex.
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      ...(d.reason ? { permissionDecisionReason: d.reason } : {}),
    },
  })
}

export interface RunHookDeps {
  env?: NodeJS.ProcessEnv
  /** Injectable fetch (tests). Default global fetch. */
  fetch?: typeof fetch
  /** Injectable client timeout (tests). */
  timeoutMs?: number
}

export interface HookRunResult {
  /** Decision JSON for the runtime (empty on the exit-2 hard fail-safe). */
  stdout: string
  /** Reason fed to the model on the exit-2 path (empty otherwise). */
  stderr: string
  /** 0 = decision expressed in stdout JSON; 2 = hard fail-safe deny (both events honor it). */
  exitCode: number
}

/**
 * Full hook run: stdin JSON → broker → decision JSON in the shape the event accepts. Never
 * throws. Two fail-safe layers: once the event is known, any downstream failure (no identity,
 * daemon down, timeout, broker deny) returns an event-appropriate DENY JSON (exit 0, reason to
 * the model); a stdin we cannot even parse (unknown event) returns exit 2 + stderr, which
 * DENIES under BOTH PermissionRequest and PreToolUse — so a gated peer is never allowed
 * unapproved and never hangs, even on a malformed hook payload.
 */
export async function runApprovalHook(stdin: string, deps: RunHookDeps = {}): Promise<HookRunResult> {
  const env = deps.env ?? process.env
  const doFetch = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs
  // Runtime resolved up front so BOTH the success and the fail-safe-deny paths format for the
  // right runtime (codex's allow-shape differs from claude's — see formatHookDecision).
  const runtime = env.PEER_RUNTIME?.trim() || 'claude'
  let event: HookEvent
  let toolName: string
  let toolInput: Record<string, unknown> | undefined
  try {
    ;({ event, toolName, toolInput } = parseHookInput(stdin))
  } catch (e) {
    // Cannot determine the event → exit 2 denies in BOTH events (stderr → model).
    return { stdout: '', stderr: `iapeer approval-hook: ${e instanceof Error ? e.message : String(e)} — denied fail-safe`, exitCode: 2 }
  }
  try {
    const personality = env.PEER_PERSONALITY?.trim()
    if (!personality) throw new Error('no PEER_PERSONALITY in the hook environment')
    const { kind, content, summary } = actionContent(toolName, toolInput)
    const decision = await requestApproval(
      resolveFleetBase(env),
      { personality, runtime, kind, tool: toolName, content, summary },
      { env, fetch: doFetch, timeoutMs },
    )
    return { stdout: formatHookDecision(decision, event, runtime), stderr: '', exitCode: 0 }
  } catch (e) {
    // Event known → event-appropriate DENY JSON (never allow-by-accident, never hang).
    return {
      stdout: formatHookDecision({ decision: 'deny', reason: `iapeer approval unavailable (${e instanceof Error ? e.message : String(e)}) — denied fail-safe` }, event, runtime),
      stderr: '',
      exitCode: 0,
    }
  }
}
