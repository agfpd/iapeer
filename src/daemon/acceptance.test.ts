import { expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { codexReceiptBaseline } from '../launch/codexDelivery.ts'
import { writeAcceptance, readAcceptance, type AcceptanceRecord } from '../launch/acceptanceStore.ts'
import { processAcceptance } from './acceptance.ts'
import { ok } from '../core/errors.ts'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'iap-acceptance-test-')))
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
test('dead native receiver with readable empty evidence escalates uncertainty, never task fallback', async () => {
  const x = fixture()
  try {
    await processAcceptance({ ...x.opts, now: 10_000, processAlive: () => false })
    expect(x.read().status).toBe('pending')
    await processAcceptance({ ...x.opts, now: 16_000, processAlive: () => false })
    expect(x.read().status).toBe('unresolved')
    expect(x.sent.map(r => r.personality)).toEqual(['sender', 'operator'])
    expect(JSON.parse(x.sent[1].message).originalEnvelope).toBe(x.r.message)
    await processAcceptance({ ...x.opts, now: 20_000, processAlive: () => false })
    expect(x.sent.length).toBe(2)
    expect(readFileSync(join(x.root, 'delivery.log'), 'utf8')).toContain('outcome=unresolved')
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
test('dead drain must be continuous across persisted ticks', async () => {
  const x = fixture()
  try {
    await processAcceptance({ ...x.opts, now: 10_000, processAlive: () => false })
    await processAcceptance({ ...x.opts, now: 14_000, processAlive: () => true })
    expect(x.read().deadSince).toBeUndefined()
    await processAcceptance({ ...x.opts, now: 16_000, processAlive: () => false })
    expect(x.read().status).toBe('pending')
    await processAcceptance({ ...x.opts, now: 22_000, processAlive: () => false })
    expect(x.read().status).toBe('unresolved')
  } finally { rmSync(x.root, { recursive: true, force: true }) }
})
for (const damaged of ['rotated-rollout', 'rotated-history', 'partial-rollout', 'partial-history', 'over-budget', 'shared-native']) {
  test(`absence never proves refusal with ${damaged} evidence`, async () => {
    const x = fixture()
    try {
      const path = damaged.includes('history') ? join(x.r.home, 'history.jsonl') : x.p
      if (damaged.startsWith('rotated')) { renameSync(path, path + '.old'); writeFileSync(path, readFileSync(path + '.old')) }
      if (damaged.startsWith('partial')) appendFileSync(path, '{"type":')
      if (damaged === 'over-budget') appendFileSync(path, ' '.repeat(2 * 1024 * 1024 + 1))
      if (damaged === 'shared-native') { x.r.embeddedNative = false; writeAcceptance(x.opts.runDir, x.r) }
      await processAcceptance({ ...x.opts, now: 10_000, processAlive: () => false })
      await processAcceptance({ ...x.opts, now: 130_000, processAlive: () => false })
      expect(x.read().status).toBe('unresolved')
      expect(x.sent.every(r => JSON.parse(r.message).outcome === 'unresolved')).toBe(true)
    } finally { rmSync(x.root, { recursive: true, force: true }) }
  })
}
test('Claude missing receipt escalates without replay; late native queue receipt resolves after restart', async () => {
  const x = fixture()
  try {
    x.r.identity = 'claude-receiver'
    x.r.embeddedNative = false
    writeAcceptance(x.opts.runDir, x.r)
    const dir = join(x.r.home, '.claude/projects', x.r.cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    await processAcceptance({ ...x.opts, now: 130_000, processAlive: () => false })
    expect(x.read().status).toBe('unresolved')
    expect(x.sent.map(r => r.personality)).toEqual(['sender', 'operator'])
    writeFileSync(join(dir, 'native.jsonl'), JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: x.r.message, timestamp: new Date().toISOString() }) + '\n')
    await processAcceptance({ ...x.opts, now: 140_000, processAlive: () => false })
    expect(x.read().status).toBe('delivered')
    expect(x.sent.map(r => r.personality)).toEqual(['sender', 'operator', 'sender'])
  } finally { rmSync(x.root, { recursive: true, force: true }) }
})
for (const writerAlive of [false, true]) {
  test(`sending-boundary crash/hang becomes unresolved even when writer alive=${writerAlive}`, async () => {
    const x = fixture()
    try {
      x.r.status = 'sending'; writeAcceptance(x.opts.runDir, x.r)
      await processAcceptance({ ...x.opts, now: 130_000, processAlive: () => writerAlive })
      expect(x.read().status).toBe('unresolved')
      expect(x.sent.map(r => r.personality)).toEqual(['sender', 'operator'])
      await processAcceptance({ ...x.opts, now: 140_000, processAlive: () => writerAlive })
      expect(x.sent).toHaveLength(2)
    } finally { rmSync(x.root, { recursive: true, force: true }) }
  })
}
test('ambiguous notification claim survives restart without blindly duplicating the event', async () => {
  const x = fixture()
  try {
    const uncertainSend = async () => { throw new Error('connection lost after send') }
    await processAcceptance({ ...x.opts, send: uncertainSend, now: 130_000, processAlive: () => true })
    expect(x.read().callerNotice).toBe('sending')
    expect(x.read().operatorNotice).toBe('sending')
    const raised: any[] = []
    await processAcceptance({ ...x.opts, now: 2_000_000, processAlive: () => true, board: { raise: (n: any) => raised.push(n) } as never })
    expect(x.sent).toHaveLength(0)
    expect(raised.some(n => n.errorType.includes('notification-uncertain'))).toBe(true)
  } finally { rmSync(x.root, { recursive: true, force: true }) }
})
test('oversized unresolved event uses durable attachment rather than an undeliverable body', async () => {
  const x = fixture()
  try {
    x.r.message = x.r.message.replace('do once', 'x'.repeat(16000)); writeAcceptance(x.opts.runDir, x.r)
    await processAcceptance({ ...x.opts, now: 130_000, processAlive: () => true })
    expect(x.sent).toHaveLength(2)
    expect(x.sent[1].message.length).toBeLessThan(16000)
    expect(x.sent[1].attachments).toHaveLength(1)
    expect(JSON.parse(x.sent[1].message).originalEnvelopeFile).toBe(x.sent[1].attachments[0])
  } finally { rmSync(x.root, { recursive: true, force: true }) }
})
