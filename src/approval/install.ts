// approval install — the RUNTIME-CONFIG surfaces the gated toggle brings up/down (docs/17
// §1). The PreToolUse interceptor + the coarse tool-class matcher live on the runtime's OWN
// hook config (claude: <cwd>/.claude/settings.json hooks.PreToolUse[].matcher; codex:
// <cwd>/.codex/hooks.json matcher) — so the user tunes WHICH classes are gated as ordinary
// runtime config; iapeer only SEEDS the default on flip-to-gated (seed-if-absent) and REMOVES
// its whole block on flip-to-yolo. Idempotent both ways: a gated→yolo→gated round-trip is
// byte-identical (no accumulation, no half-states) — the toggle invariant.
//
// Also installed for gated claude: an allow-rule for the peer's OWN MCP tool
// (mcp__iapeer__send_to_peer) so a gated peer's IAP channel is never itself gated (a
// no-bypass session would otherwise prompt on it and hang).

import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { writeFileAtomic } from '../storage/index.ts'
import { claudeSettingsPath } from '../launch/nativeMemory.ts'
import { iapeerBinPath } from '../install/index.ts'
import { readPeerProfile, writePeerProfileAtomic, type ApprovalMode } from '../identity/index.ts'
import { preSeedCodexHooksTrust, removeCodexHooksTrustUnder, type HooksTrustOutcome } from '../launch/codexHooksTrust.ts'

/** The default coarse matcher iapeer seeds — the mutation/plan tool classes (reads are
 *  auto-allowed in default mode, so they never prompt). User-editable on the runtime surface. */
export const CLAUDE_APPROVAL_MATCHER = 'Bash|Edit|Write|MultiEdit|NotebookEdit|ExitPlanMode'
/** codex tool-name regex. NB the exact codex tool names are a live-verify item (codex may
 *  name its shell tool differently) — the user can widen/narrow this on the runtime surface. */
export const CODEX_APPROVAL_MATCHER = '^(Bash|Shell|shell|local_shell|exec|apply_patch|ApplyPatch)$'
/** The peer's own IAP tool — allow-listed so a gated peer's send_to_peer is not itself gated. */
export const IAPEER_MCP_ALLOW = 'mcp__iapeer__send_to_peer'
/** Runtime hook timeout (seconds): ABOVE the broker default-deny (300) + the hook client fetch
 *  ceiling (600) so the broker/human answers before the runtime kills the hook. */
const HOOK_TIMEOUT_SECS = 900

/** The `command` string the runtime runs per matched tool call (the installed binary). */
export function approvalHookCommand(env: NodeJS.ProcessEnv = process.env): string {
  return `${iapeerBinPath(env)} approval-hook`
}

function isIapeerGroup(group: unknown): boolean {
  const hooks = (group as { hooks?: unknown })?.hooks
  return (
    Array.isArray(hooks) &&
    hooks.some(h => typeof (h as { command?: unknown })?.command === 'string' && (h as { command: string }).command.includes('approval-hook'))
  )
}

function iapeerClaudeGroup(env: NodeJS.ProcessEnv): Record<string, unknown> {
  return { matcher: CLAUDE_APPROVAL_MATCHER, hooks: [{ type: 'command', command: approvalHookCommand(env), timeout: HOOK_TIMEOUT_SECS }] }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null // refuse to clobber a non-object
    return raw as Record<string, unknown>
  } catch {
    return null
  }
}

// ── claude (project settings.json) ───────────────────────────────────────────

/** Seed the gated PreToolUse hook + MCP allow-rule into <cwd>/.claude/settings.json
 *  (seed-if-absent, no-clobber merge). Returns the path, or null on a refusal/error. */
export function installClaudeApproval(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = claudeSettingsPath(cwd)
  const obj = readJsonObject(path)
  if (obj === null) return null
  // hooks.PreToolUse — push OUR group iff absent (respect a user-tuned existing one).
  const hooks = (obj.hooks && typeof obj.hooks === 'object' && !Array.isArray(obj.hooks) ? obj.hooks : {}) as Record<string, unknown>
  const pre = (Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []) as unknown[]
  if (!pre.some(isIapeerGroup)) pre.push(iapeerClaudeGroup(env))
  hooks.PreToolUse = pre
  obj.hooks = hooks
  // permissions.allow — allow-list the peer's own MCP tool (idempotent).
  const perms = (obj.permissions && typeof obj.permissions === 'object' && !Array.isArray(obj.permissions) ? obj.permissions : {}) as Record<string, unknown>
  const allow = (Array.isArray(perms.allow) ? perms.allow : []) as unknown[]
  if (!allow.includes(IAPEER_MCP_ALLOW)) allow.push(IAPEER_MCP_ALLOW)
  perms.allow = allow
  obj.permissions = perms
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomic(path, `${JSON.stringify(obj, null, 2)}\n`, 0o644)
  return path
}

/** Remove OUR gated hook + MCP allow-rule, cleaning up any structures we emptied so a
 *  gated→yolo flip restores the pre-install bytes (foreign hooks/rules preserved). */
export function removeClaudeApproval(cwd: string): string | null {
  const path = claudeSettingsPath(cwd)
  if (!existsSync(path)) return null
  const obj = readJsonObject(path)
  if (obj === null) return null
  const hooks = obj.hooks as Record<string, unknown> | undefined
  if (hooks && Array.isArray(hooks.PreToolUse)) {
    hooks.PreToolUse = (hooks.PreToolUse as unknown[]).filter(g => !isIapeerGroup(g))
    if ((hooks.PreToolUse as unknown[]).length === 0) delete hooks.PreToolUse
    if (Object.keys(hooks).length === 0) delete obj.hooks
  }
  const perms = obj.permissions as Record<string, unknown> | undefined
  if (perms && Array.isArray(perms.allow)) {
    perms.allow = (perms.allow as unknown[]).filter(r => r !== IAPEER_MCP_ALLOW)
    if ((perms.allow as unknown[]).length === 0) delete perms.allow
    if (Object.keys(perms).length === 0) delete obj.permissions
  }
  writeFileAtomic(path, `${JSON.stringify(obj, null, 2)}\n`, 0o644)
  return path
}

// ── codex (project hooks.json + trust pre-seed) ──────────────────────────────

export function codexHooksJsonPath(cwd: string): string {
  return join(cwd, '.codex', 'hooks.json')
}

/** Write <cwd>/.codex/hooks.json with the gated PreToolUse group (seed-if-absent merge) and
 *  pre-seed its trust in ~/.codex/config.toml (else codex silently SKIPS an untrusted hook). */
export function installCodexApproval(cwd: string, env: NodeJS.ProcessEnv = process.env): { path: string; trust?: HooksTrustOutcome } | null {
  const path = codexHooksJsonPath(cwd)
  const obj = readJsonObject(path)
  if (obj === null) return null
  const hooks = (obj.hooks && typeof obj.hooks === 'object' && !Array.isArray(obj.hooks) ? obj.hooks : {}) as Record<string, unknown>
  const pre = (Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []) as unknown[]
  if (!pre.some(isIapeerGroup)) {
    pre.push({ matcher: CODEX_APPROVAL_MATCHER, hooks: [{ type: 'command', command: approvalHookCommand(env), timeout: HOOK_TIMEOUT_SECS }] })
  }
  hooks.PreToolUse = pre
  obj.hooks = hooks
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomic(path, `${JSON.stringify(obj, null, 2)}\n`, 0o644)
  const trust = preSeedCodexHooksTrust(path, env)
  return { path, trust }
}

/** Remove the codex gated hook (drop OUR group; delete the file if it becomes empty) and its
 *  trust state under this cwd. */
export function removeCodexApproval(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = codexHooksJsonPath(cwd)
  removeCodexHooksTrustUnder(cwd, env)
  if (!existsSync(path)) return null
  const obj = readJsonObject(path)
  if (obj === null) return null
  const hooks = obj.hooks as Record<string, unknown> | undefined
  if (hooks && Array.isArray(hooks.PreToolUse)) {
    hooks.PreToolUse = (hooks.PreToolUse as unknown[]).filter(g => !isIapeerGroup(g))
    if ((hooks.PreToolUse as unknown[]).length === 0) delete hooks.PreToolUse
    if (Object.keys(hooks).length === 0) delete obj.hooks
  }
  // If nothing but our block was there, drop the file entirely (pristine restore).
  if (Object.keys(obj).length === 0) {
    rmSync(path, { force: true })
    return path
  }
  writeFileAtomic(path, `${JSON.stringify(obj, null, 2)}\n`, 0o644)
  return path
}

// ── the toggle: profile field + per-runtime surfaces (docs/17 §1) ─────────────

export interface ApprovalToggleResult {
  mode: ApprovalMode
  surfaces: string[]
}

/**
 * Flip a peer's approval mode: persist the profile field AND bring every PERSISTENT runtime
 * surface to the mode (idempotent). The argv/ready-gate surfaces are NOT touched here — they
 * are computed at launch from the profile field, so a LIVE session keeps its launched mode
 * until the next fresh session (the explicit application moment). Throws if the cwd has no
 * peer profile.
 */
export function setApprovalMode(cwd: string, mode: ApprovalMode, env: NodeJS.ProcessEnv = process.env): ApprovalToggleResult {
  const profile = readPeerProfile(cwd)
  if (!profile) throw new Error(`no peer profile at ${cwd}`)
  writePeerProfileAtomic(cwd, { ...profile, approval_mode: mode })
  const surfaces = [`profile: approval_mode=${mode}`]
  for (const rt of profile.runtimes) {
    if (rt === 'claude') {
      if (mode === 'gated') surfaces.push(`claude: ${installClaudeApproval(cwd, env) ? 'PreToolUse hook + MCP allow-rule installed' : 'settings write SKIPPED (non-object)'}`)
      else surfaces.push(`claude: ${removeClaudeApproval(cwd) ? 'hook + allow-rule removed' : 'nothing to remove'}`)
    } else if (rt === 'codex') {
      if (mode === 'gated') {
        const r = installCodexApproval(cwd, env)
        surfaces.push(`codex: ${r ? `hooks.json installed + trust ${r.trust?.state ?? '?'}` : 'hooks.json write SKIPPED'}`)
      } else {
        surfaces.push(`codex: ${removeCodexApproval(cwd, env) ? 'hooks.json + trust removed' : 'trust cleared (no hooks.json)'}`)
      }
    }
  }
  return { mode, surfaces }
}
