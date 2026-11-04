import { readFileSync, statSync } from 'node:fs'
import type { FailoverTask, ProviderFailure } from '../lifecycle/failover.ts'
import { confirmNeedles } from '../transport/index.ts'
import { readSessionSlices } from './sessionfiles.ts'
import { parseClaudeTranscript, parseCodexRollout, parseOpencodeJournal } from './mutewatch.ts'
const strings = (v: unknown): string[] => typeof v === 'string' ? [v.replace(/\r/g, '')] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
function codexInput(r: any): unknown {
  if (r.type !== 'event_msg') return
  if (r.payload?.type === 'user_message') return r.payload.message
  if (r.payload?.type === 'item_completed' && r.payload.item?.type === 'UserMessage') return r.payload.item.content
}

/** A sweep reports only the newest refusal. Several messages can have failed
 * between sweeps; recover EACH input's own native refusal, never overwrite its
 * custody with another turn's later error. */
export function failureForTask(task: FailoverTask, newest: ProviderFailure): ProviderFailure | undefined {
  if (task.ts > newest.atMs || !newest.file) return
  if (failureContainsTask(task, newest)) return newest
  const slices = readSessionSlices(newest.file, 16 * 1024 * 1024)
  if (!slices?.tail.endsWith('\n')) return
  let text = slices.tail
  if (slices.head) text = text.slice(text.indexOf('\n') + 1)
  let rows: any[]
  try { rows = text.trim().split('\n').map(l => JSON.parse(l)) } catch { return }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const at = task.runtime === 'opencode' ? r.time
      : typeof r.payload?.completed_at === 'number' ? r.payload.completed_at * 1000 : Date.parse(r.timestamp)
    if (!(at >= task.ts && at <= newest.atMs)) continue
    const raw = task.runtime === 'claude' && r.isApiErrorMessage === true ? parseClaudeTranscript(JSON.stringify(r), task.ts - 1)
      : task.runtime === 'codex' && r.type === 'event_msg' && r.payload?.type === 'task_complete'
        ? parseCodexRollout(rows.slice(0, i + 1).map(r => JSON.stringify(r)).join('\n'), task.ts - 1, slices.head)
        : task.runtime === 'opencode' && r.type === 'session.error' ? parseOpencodeJournal(JSON.stringify(r), task.ts - 1) : null
    if (!raw || raw.atMs !== at) continue
    const candidate = { ...newest, ...raw, sessionId: raw.sessionId ?? newest.sessionId, personality: task.personality, runtime: newest.runtime, file: newest.file }
    if (failureContainsTask(task, candidate)) return candidate
  }
}

export function failureContainsTask(task: FailoverTask, failure: ProviderFailure): boolean {
  if (!failure.file || failure.runtime !== task.runtime || failure.personality !== task.personality) return false
  try {
    const oversized = statSync(failure.file).size > 16 * 1024 * 1024
    const needles = confirmNeedles(task.rendered)
    const slice = oversized ? readSessionSlices(failure.file, 16 * 1024 * 1024)?.tail ?? '' : readFileSync(failure.file, 'utf8')
    // A tail can prove that this refusal belongs to this input, but cannot prove
    // absence of work. That distinction permits review of a long session without
    // ever treating a truncated read as permission to replay its original task.
    const text = oversized ? slice.slice(slice.indexOf('\n') + 1) : slice
    if (!text.endsWith('\n')) return false
    const rows = text.trim().split('\n').map(l => JSON.parse(l))
    if (task.runtime === 'opencode') {
      const input = opencodeInput(rows, needles, failure.sessionId)
      if (!input) return false
      const error = rows.findIndex(r => r.sessionID === failure.sessionId && r.type === 'session.error' && r.time === failure.atMs)
      if (error < input.index) return false
      const before = rows.slice(input.index + 1, error)
      if (before.some(r => r.sessionID === failure.sessionId && r.type === 'message.updated' &&
        (r.properties?.info?.role === 'user' && r.properties.info.id !== input.id ||
         r.properties?.info?.parentID === input.id && r.properties.info.finish && r.properties.info.finish !== 'tool-calls' && !r.properties.info.error))) return false
      return true
    }
    for (let index = 0; index < rows.length; index++) {
      const r = rows[index]
      const value = task.runtime === 'claude' && r.type === 'user' ? r.message?.content
        : task.runtime === 'claude' && r.type === 'attachment' && r.attachment?.type === 'queued_command' ? r.attachment.prompt
        : task.runtime === 'codex' ? codexInput(r) : undefined
      const content = r.type === 'user' && Array.isArray(value) ? value.filter(p => p?.type === 'text').map(p => p.text).join('\n') : strings(value).join('\n')
      if (!content || !needles.every(n => content.includes(n))) continue
      const error = rows.findIndex(e => task.runtime === 'claude'
        ? e.isApiErrorMessage === true && Date.parse(e.timestamp) === failure.atMs
        : e.type === 'event_msg' && e.payload?.type === 'task_complete' && (typeof e.payload.completed_at === 'number' ? e.payload.completed_at * 1000 : Date.parse(e.timestamp)) === failure.atMs)
      if (error < 0) return false
      if (task.runtime === 'codex') return error > index && !rows.slice(index + 1, error).some(e => e.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(e.payload?.type))
      // A native session is one long UUID chain. A later error must not steal an
      // earlier, already-finished request just because its text is still in history.
      const byID = new Map(rows.filter(e => e.uuid).map(e => [e.uuid, e]))
      let parent = rows[error].parentUuid
      const seen = new Set<string>()
      while (parent && !seen.has(parent)) {
        if (parent === r.uuid) return true
        seen.add(parent)
        const e = byID.get(parent)
        if (!e) return false
        if (e.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(e.message?.stop_reason) && e.isApiErrorMessage !== true) return false
        if (e.type === 'user' && (typeof e.message?.content === 'string' || e.message?.content?.some?.((p: any) => p.type === 'text'))) return false
        parent = e.parentUuid
      }
      return false
    }
    return false
  } catch { return false }
}

/** Positive proof only. A bounded read must include the actual input and the native
 * refusal. Any intervening model work or competing input makes replay ambiguous. */
export function refusedBeforeWork(task: FailoverTask, failure: ProviderFailure): boolean {
  if (!failure.file || task.runtime !== failure.runtime || task.personality !== failure.personality || task.ts > failure.atMs) return false
  try {
    if (statSync(failure.file).size > 16 * 1024 * 1024) return false
    return refusedBeforeWorkInText(readFileSync(failure.file, 'utf8'), task, failure)
  } catch { return false }
}
export function refusedBeforeWorkInText(text: string, task: Pick<FailoverTask, 'runtime' | 'rendered'>, failure: Pick<ProviderFailure, 'atMs' | 'sessionId'>): boolean {
  if (!text.endsWith('\n') || !['claude', 'codex', 'opencode'].includes(task.runtime)) return false
  const needles = confirmNeedles(task.rendered)
  if (!needles.length || needles.some(n => !n)) return false
  let rows: any[]
  try { rows = text.trim().split('\n').map(l => JSON.parse(l)) } catch { return false }
  if (task.runtime === 'opencode') {
    const input = opencodeInput(rows, needles, failure.sessionId)
    if (!input) return false
    const userIDs = new Set(rows.filter(r => r.sessionID === failure.sessionId && r.type === 'message.updated' && r.properties?.info?.role === 'user').map(r => r.properties.info.id))
    const assistants = new Set(rows.filter(r => r.sessionID === failure.sessionId && r.type === 'message.updated' && r.properties?.info?.role === 'assistant' && r.properties.info.parentID === input.id).map(r => r.properties.info.id))
    for (const r of rows) {
      if (r.sessionID !== failure.sessionId) continue
      const p = r.properties?.part
      if (r.type === 'message.part.updated' && assistants.has(p?.messageID) && !['step-start', 'step-finish'].includes(p?.type)) return false
      if (r.type === 'message.part.delta' && assistants.has(r.properties?.messageID)) return false
    }
    let refusal = false
    for (const r of rows.slice(input.index + 1)) {
      if (r.sessionID !== failure.sessionId) continue
      const info = r.properties?.info, part = r.properties?.part
      if (r.type === 'message.part.delta') return false // streamed output is model work
      if (r.type === 'message.part.updated' && !(userIDs.has(part?.messageID) && part?.type === 'text') && !['step-start', 'step-finish'].includes(part?.type)) return false
      if (r.type === 'session.error' && r.time === failure.atMs && r.properties?.error) refusal = true
    }
    return refusal
  }
  const carries = (v: unknown) => { const all = strings(v); return needles.every(n => all.some(t => t.includes(n))) }
  const textInput = (v: unknown) => typeof v === 'string' || Array.isArray(v) && v.every(p => p?.type === 'text')
  const input = rows.findIndex(r => task.runtime === 'claude'
    ? !r.isSidechain && (r.type === 'user' && textInput(r.message?.content) && carries(r.message.content)
      || r.type === 'attachment' && r.attachment?.type === 'queued_command' && carries(r.attachment.prompt))
    : carries(codexInput(r)))
  if (input < 0) return false
  const meta = rows.find(r => r.type === 'session_meta')?.payload
  const nativeID = task.runtime === 'codex' ? meta?.session_id ?? meta?.id : rows[input].sessionId
  if (!failure.sessionId || nativeID !== failure.sessionId) return false
  if (task.runtime === 'claude') {
    if (typeof rows[input].uuid !== 'string') return false
    // Native append order is not causal order: also inspect pre-input rows.
    const ids = new Set([rows[input].uuid].filter(Boolean))
    for (let pass = 0; pass < rows.length; pass++) {
      let changed = false
      for (const r of rows) if (r.uuid && r.parentUuid && ids.has(r.parentUuid) && !ids.has(r.uuid)) { ids.add(r.uuid); changed = true }
      if (!changed) break
    }
    if (rows.some(r => r.type === 'assistant' && ids.has(r.uuid) && r.isApiErrorMessage !== true)) return false
    // A batch may contain several consecutive unstarted inputs. Trace back to
    // the last real terminal turn; any partial model work before a queued input
    // still makes the whole interrupted turn ambiguous.
    const boundary = rows.slice(0, input).findLastIndex(r => r.type === 'assistant' && !r.isApiErrorMessage && ['end_turn', 'stop_sequence'].includes(r.message?.stop_reason))
    if (rows.slice(boundary + 1, input).some(r => !r.isSidechain &&
      (r.type === 'assistant' && r.isApiErrorMessage !== true || r.type === 'user' && !textInput(r.message?.content)))) return false
    let refusal = false
    for (const r of rows.slice(input + 1)) {
      if (r.isSidechain) continue
      if (r.type === 'user' && !textInput(r.message?.content)) return false
      if (r.type === 'attachment' && !['queued_command', 'environment', 'model', 'deferred_tools_delta', 'agent_listing_delta', 'mcp_instructions_delta', 'skill_listing', 'instructions', 'auto_mode', 'session_context', 'date', 'remote_session_change', 'prompt_snapshot'].includes(r.attachment?.type)) return false
      if (r.type !== 'assistant') continue
      if (r.isApiErrorMessage !== true || r.message?.model !== '<synthetic>') return false
      if (Date.parse(r.timestamp) === failure.atMs) refusal = true
    }
    return refusal
  }
  const start = rows.slice(0, input).findLastIndex(r => r.type === 'event_msg' && r.payload?.type === 'task_started')
  if (start < 0) return false
  let refusal = false
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i], p = r.payload
    if (r.type === 'response_item' && !(['message', 'additional_tools'].includes(p?.type) && ['user', 'developer', 'system'].includes(p?.role))) return false
    if (r.type !== 'event_msg') continue
    if (['item_started', 'item_completed'].includes(p?.type) && p?.item?.type !== 'UserMessage') return false
    if (['agent_message', 'agent_reasoning', 'exec_command_begin', 'mcp_tool_call_begin', 'turn_aborted'].includes(p?.type)) return false
    if (p?.type === 'task_complete') {
      const at = typeof p.completed_at === 'number' ? p.completed_at * 1000 : Date.parse(r.timestamp)
      // A detector can establish refusal from the call's token_count fingerprint too.
      if (p.last_agent_message !== null) return false
      if (at === failure.atMs) refusal = true
    }
  }
  return refusal
}

function opencodeInput(rows: any[], needles: string[], sessionId?: string): { id: string; index: number } | undefined {
  if (!sessionId) return
  const userIDs = new Set(rows.filter(r => r.sessionID === sessionId && r.type === 'message.updated' && r.properties?.info?.role === 'user').map(r => r.properties.info.id))
  for (let index = 0; index < rows.length; index++) {
    const r = rows[index], part = r.properties?.part
    if (r.sessionID === sessionId && r.type === 'message.part.updated' && part?.type === 'text' && userIDs.has(part.messageID) && typeof part.text === 'string' && needles.every(n => part.text.includes(n))) return { id: part.messageID, index }
  }
}
