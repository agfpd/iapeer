// codexHooksTrust — deterministic pre-seed of the codex hooks trust state.
//
// codex gates EVERY hook (plugin-form AND file-form alike) behind a one-time
// interactive "Hooks need review" modal; trust is recorded per hook COMMAND in
// the codex GLOBAL config as
//
//   [hooks.state."<source>:<event_snake>:<group>:<handler>"]
//   trusted_hash = "sha256:<hex>"
//
// where <source> is the absolute (resolved) path of the hooks.json the hook
// came from. In headless `codex exec` the modal never shows — an untrusted
// hook is SILENTLY skipped. Writing the state entry BEFORE the first session
// makes the hook trusted deterministically: no modal, no TUI auto-responder.
//
// The hash algorithm is reverse-engineered from openai/codex
// (`hooks/src/engine/discovery.rs::command_hook_hash` +
// `config/src/fingerprint.rs::version_for_toml`) and verified against two
// live-granted hashes (smoke 11.06, isolated CODEX_HOME — the golden values
// live in the test file):
//
//   trusted_hash = "sha256:" + sha256(compactJson(sortKeysDeep(identity)))
//   identity     = { event_name: "<snake>", matcher?: "<verbatim>",
//                    hooks: [{ type: "command", command, timeout, async: false,
//                              statusMessage? }] }
//
// Normalization (mirrors upstream discovery before hashing):
//   - timeout   = given.max(1), default 600 (commandWindows is dropped: the
//     None fields vanish in the TOML round-trip upstream hashes through)
//   - matcher   = group's matcher verbatim, EXCEPT UserPromptSubmit/Stop where
//     codex forces it to None (matcher_pattern_for_event)
//   - async hooks, non-"command" handlers and empty commands are SKIPPED by
//     codex before hashing — they get no state entry, but they DO consume
//     their positional index.
//
// FRAGILITY PIN: verified on codex-cli 0.138.0. Upstream carries a TODO to
// replace the positional key suffix with a durable hook id — when that lands,
// `--check` (checkCodexHooksTrust) is the detector: it compares the state
// against a re-computation, so a format drift reads as missing/drift instead
// of silently lying. A future backend may instead ask codex itself
// (app-server `hooks/list` returns `current_hash`) without changing callers.
//
// Single ecosystem writer: ALL iapeer writes to the host ~/.codex/config.toml
// live in this repo (preTrustCodexCwd / removeCodexCwdTrust / here) — codex
// itself also writes the file, so every mutation is a section-scoped
// read-modify-write + atomic rename, never a rewrite.

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs'
import { createHash } from 'crypto'
import { dirname } from 'path'
import { writeFileAtomic } from '../storage/index.ts'
import { codexGlobalConfigPath } from './nativeMemory.ts'
import { assertTomlSafeKey } from './tomlKey.ts'

/** hooks.json event names → the snake_case labels codex keys state with
 *  (upstream `hook_event_key_label`). */
const EVENT_LABELS: Record<string, string> = {
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Stop: 'stop',
}

/** Events where codex force-drops the matcher (upstream matcher_pattern_for_event). */
const MATCHERLESS_EVENTS = new Set(['UserPromptSubmit', 'Stop'])

export interface HookTrustEntry {
  /** Full state key: `<source path>:<event_snake>:<group>:<handler>`. */
  key: string
  /** `sha256:<hex>` of the normalized hook identity. */
  hash: string
  event: string
  command: string
}

export type HookTrustCheckStatus = 'trusted' | 'missing' | 'drift'

export interface HookTrustCheck extends HookTrustEntry {
  status: HookTrustCheckStatus
  /** The hash currently in the state (when present and different). */
  found?: string
}

export interface HooksTrustOutcome {
  path: string // the codex global config written/read
  source: string // the resolved hooks.json path used as the key source
  state: 'written' | 'already' | 'failed'
  entries: HookTrustEntry[]
  detail?: string
}

// ─── hashing ─────────────────────────────────────────────────────────────────

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) sorted[k] = sortKeysDeep(src[k])
    return sorted
  }
  return value
}

/** Hash ONE normalized command hook the way codex does (see module header). */
export function commandHookHash(
  eventLabel: string,
  matcher: string | undefined,
  handler: { command: string; timeout?: number; statusMessage?: string },
): string {
  const normalized: Record<string, unknown> = {
    type: 'command',
    command: handler.command,
    timeout: Math.max(1, Math.trunc(handler.timeout ?? 600)),
    async: false,
    ...(handler.statusMessage !== undefined ? { statusMessage: handler.statusMessage } : {}),
  }
  const identity: Record<string, unknown> = {
    event_name: eventLabel,
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [normalized],
  }
  const json = JSON.stringify(sortKeysDeep(identity))
  return `sha256:${createHash('sha256').update(json, 'utf8').digest('hex')}`
}

// ─── hooks.json → trust entries ──────────────────────────────────────────────

interface RawHandler {
  type?: unknown
  command?: unknown
  timeout?: unknown
  statusMessage?: unknown
  async?: unknown
}
interface RawGroup {
  matcher?: unknown
  hooks?: unknown
}

/**
 * Parse a hooks.json (Claude-compatible shape codex reads) and compute the
 * trust entries codex would record for it. `keySource` is the path codex will
 * see the file at — pass the RESOLVED path (codex keys by realpath).
 */
export function computeHooksTrustEntries(hooksJsonText: string, keySource: string): HookTrustEntry[] {
  let raw: unknown
  try {
    raw = JSON.parse(hooksJsonText)
  } catch (e) {
    throw new Error(`hooks.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('hooks.json root must be an object')
  const events = (raw as Record<string, unknown>).hooks
  if (!events || typeof events !== 'object' || Array.isArray(events)) {
    throw new Error('hooks.json must carry a "hooks" object ({"hooks": {"<Event>": [...]}})')
  }
  const entries: HookTrustEntry[] = []
  for (const [eventName, groups] of Object.entries(events as Record<string, unknown>)) {
    const label = EVENT_LABELS[eventName]
    if (!label) throw new Error(`unknown hook event "${eventName}" (known: ${Object.keys(EVENT_LABELS).join(', ')})`)
    if (!Array.isArray(groups)) throw new Error(`event "${eventName}" must hold an array of matcher groups`)
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g] as RawGroup
      if (!group || typeof group !== 'object') continue
      const matcher =
        !MATCHERLESS_EVENTS.has(eventName) && typeof group.matcher === 'string' ? group.matcher : undefined
      const handlers = Array.isArray(group.hooks) ? group.hooks : []
      for (let h = 0; h < handlers.length; h++) {
        const handler = handlers[h] as RawHandler
        // Mirror upstream skips — each skip still CONSUMES its index (h):
        if (!handler || typeof handler !== 'object') continue
        if (handler.type !== 'command') continue // prompt/agent: unsupported upstream
        if (handler.async === true) continue // async: skipped before hashing
        if (typeof handler.command !== 'string' || handler.command.trim() === '') continue
        entries.push({
          key: `${keySource}:${label}:${g}:${h}`,
          hash: commandHookHash(label, matcher, {
            command: handler.command,
            timeout: typeof handler.timeout === 'number' ? handler.timeout : undefined,
            statusMessage: typeof handler.statusMessage === 'string' ? handler.statusMessage : undefined,
          }),
          event: eventName,
          command: handler.command,
        })
      }
    }
  }
  return entries
}

// ─── global-config section surgery ───────────────────────────────────────────

/** Locate the body bounds of `[hooks.state."<key>"]`: header line index and
 *  [start, end) of the body (up to the next `[` header / EOF). null = absent. */
function stateSectionBounds(lines: string[], key: string): { header: number; start: number; end: number } | null {
  const wanted = `[hooks.state."${key}"]`
  const header = lines.findIndex(l => l.trim() === wanted)
  if (header < 0) return null
  let end = lines.length
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i
      break
    }
  }
  return { header, start: header + 1, end }
}

function readTrustedHash(lines: string[], bounds: { start: number; end: number }): string | undefined {
  for (let i = bounds.start; i < bounds.end; i++) {
    const m = lines[i]!.match(/^\s*trusted_hash\s*=\s*"([^"]+)"\s*$/)
    if (m) return m[1]
  }
  return undefined
}

function resolveHooksSource(hooksJsonPath: string): string {
  // codex keys trust state on the RESOLVED path (same lesson as cwd trust:
  // /tmp → /private/tmp made a literal entry miss). The file must exist —
  // we parse it anyway.
  return realpathSync(hooksJsonPath)
}

/**
 * Pre-seed the codex hooks trust state for every command hook in the given
 * hooks.json — the deterministic, headless replacement for the "Hooks need
 * review → Trust all" modal. Idempotent: unchanged entries are left alone;
 * changed hashes are updated in place; missing sections are appended.
 */
export function preSeedCodexHooksTrust(
  hooksJsonPath: string,
  env: NodeJS.ProcessEnv = process.env,
): HooksTrustOutcome {
  const path = codexGlobalConfigPath(env)
  try {
    const source = resolveHooksSource(hooksJsonPath)
    assertTomlSafeKey(source)
    const entries = computeHooksTrustEntries(readFileSync(source, 'utf8'), source)
    if (entries.length === 0) {
      return { path, source, state: 'already', entries, detail: 'no command hooks to trust' }
    }
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const lines = text.length ? text.split('\n') : []
    let changed = false
    for (const entry of entries) {
      const bounds = stateSectionBounds(lines, entry.key)
      if (bounds) {
        if (readTrustedHash(lines, bounds) === entry.hash) continue
        // replace (or insert) the trusted_hash line inside the existing section
        let replaced = false
        for (let i = bounds.start; i < bounds.end; i++) {
          if (/^\s*trusted_hash\s*=/.test(lines[i]!)) {
            lines[i] = `trusted_hash = "${entry.hash}"`
            replaced = true
            break
          }
        }
        if (!replaced) lines.splice(bounds.start, 0, `trusted_hash = "${entry.hash}"`)
        changed = true
      } else {
        if (lines.length && lines[lines.length - 1]!.trim() !== '') lines.push('')
        lines.push(`[hooks.state."${entry.key}"]`, `trusted_hash = "${entry.hash}"`)
        changed = true
      }
    }
    if (!changed) return { path, source, state: 'already', entries }
    mkdirSync(dirname(path), { recursive: true })
    const outText = lines.join('\n')
    writeFileAtomic(path, outText.endsWith('\n') ? outText : `${outText}\n`)
    return { path, source, state: 'written', entries }
  } catch (e) {
    return {
      path,
      source: hooksJsonPath,
      state: 'failed',
      entries: [],
      detail: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * Read-only drift check: for every command hook in hooks.json, compare the
 * expected hash against the recorded state. `trusted` = match, `missing` = no
 * state entry, `drift` = entry exists with a DIFFERENT hash (hooks.json edited
 * after seeding, or the upstream algorithm/key format moved). Consumers (the
 * memory provider's verify line) shell this instead of re-implementing the
 * hash — the algorithm lives in ONE place.
 */
export function checkCodexHooksTrust(
  hooksJsonPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; source: string; checks: HookTrustCheck[] } {
  const path = codexGlobalConfigPath(env)
  const source = resolveHooksSource(hooksJsonPath)
  const entries = computeHooksTrustEntries(readFileSync(source, 'utf8'), source)
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  const checks: HookTrustCheck[] = entries.map(entry => {
    const bounds = stateSectionBounds(lines, entry.key)
    if (!bounds) return { ...entry, status: 'missing' }
    const found = readTrustedHash(lines, bounds)
    if (found === entry.hash) return { ...entry, status: 'trusted' }
    return { ...entry, status: 'drift', found }
  })
  return { path, source, checks }
}

/**
 * Reap-side counterpart for `iapeer remove`: drop every `[hooks.state."…"]`
 * section whose key SOURCE path lies under the given cwd (resolved or literal
 * form — a deleted cwd can no longer be resolved). Same class as
 * removeCodexCwdTrust: a removed peer must not leave trust state behind.
 */
export function removeCodexHooksTrustUnder(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; state: 'written' | 'already' | 'failed'; removed: string[]; detail?: string } {
  const path = codexGlobalConfigPath(env)
  try {
    if (!existsSync(path)) return { path, state: 'already', removed: [] }
    let real = cwd
    try {
      real = realpathSync(cwd)
    } catch {
      /* cwd already deleted → only the literal form can match */
    }
    const prefixes = [...new Set([real, cwd])].map(p => (p.endsWith('/') ? p : `${p}/`))
    const lines = readFileSync(path, 'utf8').split('\n')
    const kept: string[] = []
    const removed: string[] = []
    let inDoomed = false
    for (const line of lines) {
      const header = line.match(/^\s*\[hooks\.state\."(.+)"\]\s*$/)
      if (header) {
        const key = header[1]!
        // key = `<source path>:<event>:<group>:<handler>` — strip the 3-part
        // positional suffix to recover the source path.
        const m = key.match(/^(.*):[a-z_]+:\d+:\d+$/)
        const sourcePath = m ? m[1]! : key
        inDoomed = prefixes.some(p => sourcePath.startsWith(p))
        if (inDoomed) {
          removed.push(key)
          continue
        }
      } else if (inDoomed && /^\s*\[/.test(line)) {
        inDoomed = false // next section starts — stop dropping
      }
      if (!inDoomed) kept.push(line)
    }
    if (removed.length === 0) return { path, state: 'already', removed }
    writeFileAtomic(path, kept.join('\n').replace(/\n{3,}/g, '\n\n'))
    return { path, state: 'written', removed }
  } catch (e) {
    return { path, state: 'failed', removed: [], detail: e instanceof Error ? e.message : String(e) }
  }
}
