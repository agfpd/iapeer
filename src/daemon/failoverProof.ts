import { readFileSync, statSync } from 'node:fs'
import type { FailoverTask, ProviderFailure } from '../lifecycle/failover.ts'
import { confirmNeedles } from '../transport/index.ts'

export function failureContainsTask(task: FailoverTask, failure: ProviderFailure): boolean {
  if (!failure.file || failure.runtime !== task.runtime || failure.personality !== task.personality) return false
  try {
    if (statSync(failure.file).size > 16 * 1024 * 1024) return false
    const needles = confirmNeedles(task.rendered)
    const text = readFileSync(failure.file, 'utf8')
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
        : task.runtime === 'codex' && r.type === 'event_msg' && r.payload?.type === 'user_message' ? r.payload.message : undefined
      const content = typeof value === 'string' ? value : Array.isArray(value) ? value.filter(p => p?.type === 'text').map(p => p.text).join('\n') : ''
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
      if (info?.role === 'user' && info.id !== input.id) return false
      if (r.type === 'message.part.delta') return false // streamed output is model work
      if (r.type === 'message.part.updated' && part?.messageID !== input.id && !['step-start', 'step-finish'].includes(part?.type)) return false
      if (r.type === 'session.error' && r.time === failure.atMs && r.properties?.error) refusal = true
    }
    return refusal
  }
  const texts = (v: unknown): string[] => typeof v === 'string' ? [v.replace(/\r/g, '')] : Array.isArray(v) ? v.flatMap(texts) : v && typeof v === 'object' ? Object.values(v).flatMap(texts) : []
  const carries = (v: unknown) => { const all = texts(v); return needles.every(n => all.some(t => t.includes(n))) }
  const textInput = (v: unknown) => typeof v === 'string' || Array.isArray(v) && v.every(p => p?.type === 'text')
  const input = rows.findIndex(r => task.runtime === 'claude'
    ? r.type === 'user' && !r.isSidechain && textInput(r.message?.content) && carries(r.message.content)
    : r.type === 'event_msg' && r.payload?.type === 'user_message' && carries(r.payload.message))
  if (input < 0) return false
  const nativeID = task.runtime === 'codex' ? rows.find(r => r.type === 'session_meta')?.payload?.id : rows[input].sessionId
  if (!failure.sessionId || nativeID !== failure.sessionId) return false
  if (task.runtime === 'claude') {
    // Native append order is not causal order: also inspect pre-input rows.
    const ids = new Set([rows[input].uuid].filter(Boolean))
    for (let pass = 0; pass < rows.length; pass++) {
      let changed = false
      for (const r of rows) if (r.uuid && r.parentUuid && ids.has(r.parentUuid) && !ids.has(r.uuid)) { ids.add(r.uuid); changed = true }
      if (!changed) break
    }
    if (rows.some(r => r.type === 'assistant' && ids.has(r.uuid) && r.isApiErrorMessage !== true)) return false
    // Refuse an input absorbed into an unfinished prior turn (including tool-result input).
    const prior = rows.slice(0, input).filter(r => ['assistant', 'user'].includes(r.type) && !r.isSidechain).at(-1)
    if (prior && !(prior.type === 'assistant' && ['end_turn', 'stop_sequence'].includes(prior.message?.stop_reason))) return false
    let refusal = false
    for (const r of rows.slice(input + 1)) {
      if (r.isSidechain) continue
      if (r.type === 'user') return false
      if (r.type === 'attachment' && !['environment', 'model', 'deferred_tools_delta', 'agent_listing_delta', 'mcp_instructions_delta', 'skill_listing', 'instructions', 'auto_mode', 'session_context', 'date', 'remote_session_change', 'prompt_snapshot'].includes(r.attachment?.type)) return false
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
    if (r.type === 'response_item' && p?.role !== 'user') return false
    if (r.type !== 'event_msg') continue
    if (p?.type === 'user_message' && i !== input) return false
    if (['task_started', 'agent_message', 'agent_reasoning', 'exec_command_begin', 'mcp_tool_call_begin', 'turn_aborted'].includes(p?.type)) return false
    if (p?.type === 'task_complete') {
      const at = typeof p.completed_at === 'number' ? p.completed_at * 1000 : Date.parse(r.timestamp)
      // A detector can establish refusal from the call's token_count fingerprint too.
      if (at !== failure.atMs || p.last_agent_message !== null) return false
      refusal = true
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
