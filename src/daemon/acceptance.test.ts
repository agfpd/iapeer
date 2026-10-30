import { expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { codexReceiptBaseline } from '../launch/codexDelivery.ts'
import { writeAcceptance, readAcceptance, type AcceptanceRecord } from '../launch/acceptanceStore.ts'
import { processAcceptance } from './acceptance.ts'
import { ok } from '../core/errors.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'iap-acceptance-test-'))
  const home = join(root, 'home'), cwd = join(root, 'peer'), runDir = join(root, 'run')
  mkdirSync(join(home, 'sessions'), { recursive: true }); mkdirSync(cwd)
  const p = join(home, 'sessions/rollout-native.jsonl')
  writeFileSync(p, JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n')
  writeFileSync(join(home, 'history.jsonl'), '{}\n')
  writeFileSync(join(root, 'alerts.json'), JSON.stringify({ peer: 'operator' }))
  const message = '<iap from="sender" runtime="notifier" ts="12:00:00" topic="task">\n<msg>do once</msg>\n</iap>'
  const r: AcceptanceRecord = { id: randomUUID(), identity: 'codex-receiver', token: '1 token', home, cwd, message,
    snapshot: codexReceiptBaseline(home, cwd, message).snapshot, status: 'pending', createdAt: 0, updatedAt: 0,
    writerPid: 2, writerToken: 'writer', nativeProcesses: [{ pid: 3, token: 'native' }], embeddedNative: true, managed: true }
  writeAcceptance(runDir, r)
  const sent: any[] = []
  const send = async (_: any, args: any) => { sent.push(args); return ok({ ok: true as const, delivered_to: { personality: args.personality, runtime: 'notifier' }, woke: false, ts: 'now' }) }
  const opts = { runDir, logDir: root, env: { IAPEER_ROOT: root }, routeDeps: {}, send }
  return { root, p, r, sent, opts, read: () => readAcceptance(runDir, r.id)! }
}
test('delayed native input resolves durable pending after restart with no second paste', async () => {
  const x = fixture()
  try {
    appendFileSync(x.p, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: x.r.message }] } }) + '\n')
    await processAcceptance({ ...x.opts, now: 10_000, processAlive: () => true })
    expect(x.read().status).toBe('delivered')
    expect(x.sent.map(r => r.personality)).toEqual(['sender'])
    expect(JSON.parse(x.sent[0].message).deliveryId).toBe(x.r.id)
    await processAcceptance({ ...x.opts, now: 20_000, processAlive: () => true })
    expect(x.sent.length).toBe(1)
  } finally { rmSync(x.root, { recursive: true, force: true }) }
})
test('dead native receiver with readable non-submission evidence reaches operator fallback automatically', async () => {
  const x = fixture()
  try {
    await processAcceptance({ ...x.opts, now: 10_000, processAlive: () => false })
    expect(x.read().status).toBe('pending')
    await processAcceptance({ ...x.opts, now: 16_000, processAlive: () => false })
    expect(x.read().status).toBe('failed')
    expect(x.sent.map(r => r.personality)).toEqual(['sender', 'operator'])
    expect(JSON.parse(x.sent[1].message).originalEnvelope).toBe(x.r.message)
    await processAcceptance({ ...x.opts, now: 20_000, processAlive: () => false })
    expect(x.sent.length).toBe(2)
    expect(readFileSync(join(x.root, 'delivery.log'), 'utf8')).toContain('outcome=failed')
  } finally { rmSync(x.root, { recursive: true, force: true }) }
})
test('live or unreadable receiver becomes visible unresolved, not failed or replayed; late input still settles', async () => {
  const x = fixture()
  try {
    await processAcceptance({ ...x.opts, now: 130_000, processAlive: () => true })
    expect(x.read().status).toBe('unresolved')
    expect(JSON.parse(x.sent[1].message).outcome).toBe('unresolved')
    appendFileSync(x.p, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: x.r.message }] } }) + '\n')
    await processAcceptance({ ...x.opts, now: 140_000, processAlive: () => true })
    expect(x.read().status).toBe('delivered')
  } finally { rmSync(x.root, { recursive: true, force: true }) }
})
