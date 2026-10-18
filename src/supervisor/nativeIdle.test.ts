import { expect, test } from 'bun:test'
import { strictClaudeIdle, strictCodexIdle } from './nativeIdle.ts'
const line = (r: unknown) => JSON.stringify(r) + '\n'
test('Claude destructive gate is timestamp-aware, excludes sidechains and refuses unknown/null stop reasons', () => {
  const user = line({ type: 'user', timestamp: '2026-10-18T12:00:01Z', message: { content: 'input' } })
  const assistant = (reason: unknown) => line({ type: 'assistant', timestamp: '2026-10-18T12:00:02Z', message: { stop_reason: reason } })
  expect(strictClaudeIdle(assistant('end_turn') + user).idle).toBe(true)
  for (const reason of [null, 'future_reason', 'tool_use', undefined]) expect(strictClaudeIdle(assistant(reason) + user).idle).toBe(false)
  expect(strictClaudeIdle(assistant('end_turn') + line({ type: 'user', timestamp: '2026-10-18T12:00:03Z', isSidechain: true })).idle).toBe(true)
  expect(strictClaudeIdle(assistant('end_turn') + user).userAt).toBe(Date.parse('2026-10-18T12:00:01Z'))
})
test('Codex requires an explicit terminal task marker and tracks consumed user input separately', () => {
  const event = (type: string, s: number) => line({ type: 'event_msg', timestamp: `2026-10-18T12:00:0${s}Z`, payload: { type } })
  expect(strictCodexIdle(event('task_complete', 2) + event('task_started', 1)).idle).toBe(true)
  expect(strictCodexIdle(event('user_message', 1) + event('task_started', 2)).idle).toBe(false)
  expect(strictCodexIdle(event('task_started', 1) + event('turn_aborted', 2)).idle).toBe(true)
  const item = line({ type: 'event_msg', timestamp: '2026-10-18T12:00:03Z', payload: { type: 'item_completed', item: { type: 'UserMessage' } } })
  expect(strictCodexIdle(item + event('task_complete', 4)).userAt).toBe(Date.parse('2026-10-18T12:00:03Z'))
})
