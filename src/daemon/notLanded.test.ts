import { expect, test } from 'bun:test'
import { claudeNotLanded, type NotLandedDeps } from './notLanded.ts'
import type { AcceptanceRecord } from '../launch/acceptanceStore.ts'

const message = '<iap from="boris" runtime="claude" intelligence="artificial" ts="20:40:52" topic="t">\nReply via send_to_peer.\n<msg>hi</msg>\n</iap>'
const r: AcceptanceRecord = { id: 'id', identity: 'claude-coach', token: 'host:51308 Thu Nov 12 20:32:56 2026', home: '/h', cwd: '/c', message,
  snapshot: { offsets: [], historyOffset: 0 }, status: 'unresolved', createdAt: 0, updatedAt: 0, writerPid: 1, writerToken: null, managed: true }
const terminal = JSON.stringify({ type: 'assistant', timestamp: '2026-11-12T17:42:00Z', message: { stop_reason: 'end_turn' } }) + '\n'
const deps = (o: Partial<NotLandedDeps> = {}): NotLandedDeps => ({
  hostToken: () => '51308 Thu Nov 12 20:32:56 2026',
  children: () => [51309],
  nativeSession: () => ({ status: 'idle', cwd: '/c', sessionId: 's' }),
  transcriptTail: () => terminal,
  screen: async () => ({ text: '⏺ done\n❯ \n', composerOccupied: false }),
  ...o,
})

test('idle after a terminal turn + empty composer + nothing on screen → positive not-landed', async () => {
  expect(await claudeNotLanded(r, '/run', deps())).toMatch(/^not-landed: .*safe to resend/)
})
test.each([
  ['hosting replaced', { hostToken: () => '777 other' }],
  ['hosting gone', { hostToken: () => null }],
  ['native session busy', { nativeSession: () => ({ status: 'busy', cwd: '/c', sessionId: 's' }) }],
  ['native session unknown', { nativeSession: () => null }],
  ['turn not terminal', { transcriptTail: () => JSON.stringify({ type: 'assistant', timestamp: '2026-11-12T17:42:00Z', message: { stop_reason: 'tool_use' } }) + '\n' }],
  ['composer occupied', { screen: async () => ({ text: '❯ typing', composerOccupied: true }) }],
  ['paste placeholder visible', { screen: async () => ({ text: '❯ [Pasted text #7 +12 lines]', composerOccupied: false }) }],
  ['payload header visible (wrapped)', { screen: async () => ({ text: '<iap from="boris" runtime="claude" intelligence="artif\nicial" ts="20:40:52" topic="t">', composerOccupied: false }) }],
  ['screen unavailable', { screen: async () => null }],
  ['codex receiver', {}, { identity: 'codex-coach' }],
] as Array<[string, Partial<NotLandedDeps>, Partial<AcceptanceRecord>?]>)('%s → not proven (stays unresolved)', async (_n, o, rec) => {
  expect(await claudeNotLanded({ ...r, ...rec }, '/run', deps(o))).toBeNull()
})
test('session going busy during the screen capture → not proven', async () => {
  let calls = 0
  expect(await claudeNotLanded(r, '/run', deps({ nativeSession: () => ({ status: calls++ === 0 ? 'idle' : 'busy', cwd: '/c', sessionId: 's' }) }))).toBeNull()
})
