// A destructive-action gate, deliberately stricter than the operator-facing ActivityBoard.
// Evidence is bound to the hosted CHILD, not the newest cwd transcript (several peers may share it).
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { transcriptSlug } from '../launch/adapters/claude.ts'
import { readSessionSlices } from '../daemon/sessionfiles.ts'
import { readFirstLine } from '../launch/adapters/transcriptTail.ts'
import type { ReloadReply } from './reload.ts'
const canonical = (p: string): string => { try { return realpathSync(p) } catch { return p } }

export function strictClaudeIdle(text: string): { idle: boolean; at: number; userAt: number } {
  let at = 0, idle = false, userAt = 0
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line)
      if (!['assistant', 'user'].includes(r.type) || r.isSidechain || r.isMeta || r.isCompactSummary) continue
      const time = Date.parse(r.timestamp)
      if (r.type === 'user' && (typeof r.message?.content === 'string' || r.message?.content?.some?.((c: { type?: string }) => c.type === 'text'))) userAt = Math.max(userAt, Number.isFinite(time) ? time : 0)
      if (!Number.isFinite(time) || time < at) continue
      const terminal = r.type === 'assistant' && ['end_turn', 'stop_sequence', 'max_tokens', 'refusal'].includes(r.message?.stop_reason)
      // Equal timestamps are ambiguous without ancestry: fail closed. A later native idle status
      // alone cannot make a partial/unknown assistant record a safe terminal record.
      if (time === at) idle = idle && terminal
      else { at = time; idle = terminal }
    } catch { /* torn tail is not evidence */ }
  }
  return { idle, at, userAt }
}

export function strictCodexIdle(text: string): { idle: boolean; at: number; userAt: number } {
  let at = 0, idle = false, userAt = 0
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line)
      const nativeUser = r.payload?.type === 'user_message' || (r.payload?.type === 'item_completed' && r.payload.item?.type === 'UserMessage')
      if (r.type === 'event_msg' && nativeUser && Number.isFinite(Date.parse(r.timestamp))) userAt = Math.max(userAt, Date.parse(r.timestamp))
      if (r.type !== 'event_msg' || !['task_started', 'task_complete', 'turn_aborted'].includes(r.payload?.type)) continue
      const time = Date.parse(r.timestamp)
      if (!Number.isFinite(time) || time < at) continue
      at = time; idle = r.payload.type !== 'task_started'
    } catch { /* no evidence */ }
  }
  return { idle, at, userAt }
}

export function nativeIdle(args: { runtime: string; childPid: number; cwd: string; env: NodeJS.ProcessEnv; lastInputAt: number }): ReloadReply {
  const { runtime, childPid, cwd, env, lastInputAt } = args
  const pending = (error: string): ReloadReply => ({ ok: false, pending: true, error })
  try {
    if (runtime === 'claude') {
      const base = env.CLAUDE_CONFIG_DIR || join(env.HOME!, '.claude')
      const s = JSON.parse(readFileSync(join(base, 'sessions', `${childPid}.json`), 'utf8'))
      if (s.pid !== childPid || typeof s.cwd !== 'string' || canonical(s.cwd) !== canonical(cwd) || typeof s.sessionId !== 'string') return pending('native session identity is unknown')
      if (s.status !== 'idle' || !(s.statusUpdatedAt >= lastInputAt)) return pending('native Claude session is busy or has unrecorded input')
      const slice = readSessionSlices(join(base, 'projects', transcriptSlug(cwd), `${s.sessionId}.jsonl`), 1024 * 1024)
      const turn = strictClaudeIdle(slice?.tail ?? '')
      if (!turn.idle || turn.at < lastInputAt || turn.userAt < lastInputAt) return pending('waiting for an explicit terminal Claude turn and consumed input')
      return { ok: true, resumeRef: s.sessionId }
    }
    if (runtime === 'codex') {
      const base = canonical(env.CODEX_HOME || join(env.HOME!, '.codex'))
      // The runtime holds its own rollout open. Neither APFS iteration order nor mtime identifies
      // that rollout safely. No open rollout / several rollouts -> no destructive action.
      const r = spawnSync('/usr/sbin/lsof', ['-Fn', '-a', '-p', String(childPid)], { encoding: 'utf8', timeout: 1000 })
      const files = [...new Set((r.stdout ?? '').split('\n').filter(l => l.startsWith(`n${join(base, 'sessions')}/`) && l.endsWith('.jsonl')).map(l => l.slice(1)))]
      if (files.length !== 1) return pending('current Codex rollout is not uniquely identifiable')
      const meta = JSON.parse(readFirstLine(files[0]!) ?? '{}')
      if (meta.type !== 'session_meta' || typeof meta.payload?.cwd !== 'string' || canonical(meta.payload.cwd) !== canonical(cwd) || typeof meta.payload?.id !== 'string') return pending('Codex rollout identity is unknown')
      const slice = readSessionSlices(files[0]!, 1024 * 1024)
      const turn = strictCodexIdle(slice?.tail ?? '')
      if (!turn.idle || turn.at < lastInputAt || turn.userAt < lastInputAt) return pending('native Codex turn is busy or has unrecorded input')
      return { ok: true, resumeRef: meta.payload.id }
    }
    return pending(`no native idle gate for ${runtime}`)
  } catch { return pending('native idle evidence is unavailable') }
}
