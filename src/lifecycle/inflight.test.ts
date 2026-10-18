import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listInterruptedIdentities, listOrphanIdentities, readInflight, recordInflight, sweepInflight, takeInterrupted, takeOrphans, type InflightEntry } from './inflight.ts'
import { deliveryCompleted, deliveryLanded, deliveryProcessed } from '../transport/index.ts'
import { processInflight, redeliveryMessage } from '../daemon/main.ts'
import { ok, err } from '../core/errors.ts'
import { upsertPeer } from '../registry/index.ts'

let root: string
let state: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'inflight-')))
  state = join(root, 'state')
  mkdirSync(state, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const ENV_BODY = '<iap from="alice" runtime="claude" ts="03:00:00">\nReply via send_to_peer.\n<msg>DO THE THING 77</msg>\n</iap>'
function entry(over: Partial<InflightEntry> = {}): InflightEntry {
  return {
    id: Math.random().toString(36).slice(2),
    ts: Date.now() - 1000,
    sentAt: '03:00:00',
    identity: 'claude-bob',
    personality: 'bob',
    runtime: 'claude',
    cwd: join(root, 'bob'),
    sessionToken: 'host:1',
    caller: { personality: 'alice', runtime: 'claude' },
    message: 'DO THE THING 77',
    rendered: ENV_BODY,
    ...over,
  }
}

describe('inflight ledger (OC07)', () => {
  test('sweep: processed leaves; unprocessed stays on the same live session; gone/replaced session → orphan', () => {
    recordInflight(state, entry({ id: 'done' }))
    recordInflight(state, entry({ id: 'pending' }))
    recordInflight(state, entry({ id: 'old', sessionToken: 'host:0' }))
    const n = sweepInflight(state, 'claude-bob', { sessionToken: () => 'host:1', processed: e => e.id === 'done' })
    expect(n).toBe(1)
    expect(readInflight(state, 'claude-bob').map(e => e.id)).toEqual(['pending'])
    expect(sweepInflight(state, 'claude-bob', { sessionToken: () => null, processed: () => false })).toBe(1)
    expect(readInflight(state, 'claude-bob')).toEqual([])
    expect(listOrphanIdentities(state)).toEqual(['claude-bob'])
    expect(takeOrphans(state, 'claude-bob').map(e => e.id).sort()).toEqual(['old', 'pending'])
    expect(listOrphanIdentities(state)).toEqual([])
  })
})

describe('interrupted turns (OC07 extension) — processed but unfinished: never redelivered, the sender is told', () => {
  test('gone session: unprocessed → orphan, processed-unfinished → interrupted, finished → dropped; a later finished turn covers earlier entries', () => {
    recordInflight(state, entry({ id: 'early', ts: 1 }))
    recordInflight(state, entry({ id: 'fin', ts: 2 }))
    recordInflight(state, entry({ id: 'mid', ts: 3 }))
    recordInflight(state, entry({ id: 'fresh', ts: 4 }))
    const n = sweepInflight(state, 'claude-bob', {
      sessionToken: () => null,
      processed: e => e.id === 'mid' || e.id === 'fin' || e.id === 'early',
      completed: e => e.id === 'fin',
    })
    expect(n).toBe(2)
    expect(takeInterrupted(state, 'claude-bob').map(e => e.id)).toEqual(['mid']) // 'early' is covered by the later finished 'fin'
    expect(takeOrphans(state, 'claude-bob').map(e => e.id)).toEqual(['fresh'])
  })
  test('REGRESSION (linus 0.4.122): a turn finished in a NEW session never covers a dead session — A → interrupted, B → orphan', () => {
    recordInflight(state, entry({ id: 'A', ts: 1, sessionToken: 'host:old' })) // started, then SIGKILL
    recordInflight(state, entry({ id: 'B', ts: 2, sessionToken: 'host:old' })) // queued, never answered
    recordInflight(state, entry({ id: 'C', ts: 3, sessionToken: 'host:new' })) // woke a fresh session, finished
    const n = sweepInflight(state, 'claude-bob', {
      sessionToken: () => 'host:new',
      processed: e => e.id === 'A' || e.id === 'C',
      completed: e => e.id === 'C',
    })
    expect(n).toBe(2)
    expect(takeInterrupted(state, 'claude-bob').map(e => e.id)).toEqual(['A'])
    expect(takeOrphans(state, 'claude-bob').map(e => e.id)).toEqual(['B'])
    expect(readInflight(state, 'claude-bob')).toEqual([])
  })

  test('live session: a processed-unfinished turn is still working → kept', () => {
    recordInflight(state, entry({ id: 'working' }))
    expect(sweepInflight(state, 'claude-bob', { sessionToken: () => 'host:1', processed: () => true, completed: () => false })).toBe(0)
    expect(readInflight(state, 'claude-bob').map(e => e.id)).toEqual(['working'])
  })
  test('deliveryCompleted (claude): assistant tool_use is not finished; end_turn is', () => {
    const env = { HOME: root }
    const cwd = join(root, 'bob')
    mkdirSync(cwd, { recursive: true })
    const dir = join(root, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 's.jsonl')
    const probe = { runtime: 'claude', personality: 'bob', cwd, ts: Date.now() - 1000, rendered: ENV_BODY }
    writeFileSync(f, JSON.stringify({ type: 'user', message: { content: ENV_BODY } }) + '\n')
    appendFileSync(f, JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use' } }) + '\n')
    expect(deliveryProcessed(probe, env)).toBe(true)
    expect(deliveryCompleted(probe, env)).toBe(false)
    appendFileSync(f, JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn' } }) + '\n')
    expect(deliveryCompleted(probe, env)).toBe(true)
  })
  test('deliveryCompleted: an operator interrupt ENDS the turn (claude marker line, codex turn_aborted) — no false INTERRUPTED later', () => {
    const env = { HOME: root }
    const cwd = join(root, 'bob')
    mkdirSync(cwd, { recursive: true })
    const dir = join(root, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 's.jsonl')
    const probe = { runtime: 'claude', personality: 'bob', cwd, ts: Date.now() - 1000, rendered: ENV_BODY }
    writeFileSync(f, JSON.stringify({ type: 'user', message: { content: ENV_BODY } }) + '\n')
    appendFileSync(f, JSON.stringify({ type: 'assistant', message: { stop_reason: 'tool_use' } }) + '\n')
    expect(deliveryCompleted(probe, env)).toBe(false)
    appendFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }) + '\n')
    expect(deliveryCompleted(probe, env)).toBe(true)
  })
  test('self-fresh: started entries of the session that ENDED ITSELF are settled, not interrupted; other sessions unaffected', () => {
    recordInflight(state, entry({ id: 'self', sessionToken: 'host:1' }))
    recordInflight(state, entry({ id: 'other', sessionToken: 'host:0' }))
    sweepInflight(state, 'claude-bob', { sessionToken: () => null, processed: () => true, completed: () => false, selfEndedToken: 'host:1' })
    expect(readInflight(state, 'claude-bob')).toEqual([])
    expect(takeInterrupted(state, 'claude-bob').map(e => e.id)).toEqual(['other'])
  })
})

describe('unconfirmed deliveries — the ledger, not the sender, decides', () => {
  test('unconfirmed + not landed: kept inside the window, orphaned after it; landed → a normal pending entry', () => {
    recordInflight(state, entry({ id: 'u1', unconfirmed: true, ts: 1_000_000 }))
    const base = { sessionToken: () => 'host:1', processed: () => false }
    expect(sweepInflight(state, 'claude-bob', { ...base, landed: () => false, now: 1_000_000 + 60_000 })).toBe(0)
    expect(sweepInflight(state, 'claude-bob', { ...base, landed: () => true, now: 1_000_000 + 60_000 })).toBe(0)
    expect(readInflight(state, 'claude-bob')[0]!.unconfirmed).toBeUndefined() // landed → flag cleared
    recordInflight(state, entry({ id: 'u2', unconfirmed: true, ts: 1_000_000 }))
    expect(sweepInflight(state, 'claude-bob', { ...base, landed: () => false, now: 1_000_000 + 121_000 })).toBe(1)
    expect(takeOrphans(state, 'claude-bob').map(e => e.id)).toEqual(['u2'])
  })

  test('deliveryLanded: a claude queue-operation carrying the envelope counts as landed (busy receiver)', () => {
    const env = { HOME: root }
    const cwd = join(root, 'bob')
    mkdirSync(cwd, { recursive: true })
    const dir = join(root, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    const probe = { runtime: 'claude', personality: 'bob', cwd, ts: Date.now() - 1000, rendered: ENV_BODY }
    writeFileSync(join(dir, 's.jsonl'), JSON.stringify({ type: 'assistant', message: { content: 'x' } }) + '\n')
    expect(deliveryLanded(probe, env)).toBe(false)
    appendFileSync(join(dir, 's.jsonl'), JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: ENV_BODY }) + '\n')
    expect(deliveryLanded(probe, env)).toBe(true)
  })
})

describe('deliveryProcessed — recorded is NOT processed', () => {
  test('claude: user record alone (the SIGKILL-mid-request case) → false; an assistant record after it → true; queue-operation never counts', () => {
    const env = { HOME: root }
    const cwd = join(root, 'bob')
    mkdirSync(cwd, { recursive: true })
    const dir = join(root, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 's.jsonl')
    writeFileSync(f, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: ENV_BODY }) + '\n')
    appendFileSync(f, JSON.stringify({ type: 'assistant', message: { content: 'busy with something else' } }) + '\n')
    const probe = { runtime: 'claude', personality: 'bob', cwd, ts: Date.now() - 1000, rendered: ENV_BODY }
    expect(deliveryProcessed(probe, env)).toBe(false) // enqueue + an unrelated assistant record
    appendFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: ENV_BODY } }) + '\n')
    expect(deliveryProcessed(probe, env)).toBe(false) // recorded, not answered
    appendFileSync(f, JSON.stringify({ type: 'assistant', message: { content: 'on it' } }) + '\n')
    expect(deliveryProcessed(probe, env)).toBe(true)
  })

  test('opencode: user text part carrying the envelope → processed only once an assistant answers that message', () => {
    const env = { HOME: root, IAPEER_ROOT: join(root, 'iapeer') }
    const dir = join(root, 'iapeer', 'state', 'opencode', 'bob')
    mkdirSync(dir, { recursive: true })
    const j = join(dir, 'events.jsonl')
    writeFileSync(j, JSON.stringify({ type: 'message.part.updated', properties: { part: { type: 'text', text: ENV_BODY, messageID: 'msg_u' } } }) + '\n')
    const probe = { runtime: 'opencode', personality: 'bob', cwd: root, ts: Date.now(), rendered: ENV_BODY }
    expect(deliveryProcessed(probe, env)).toBe(false)
    appendFileSync(j, JSON.stringify({ type: 'message.updated', properties: { info: { role: 'assistant', parentID: 'msg_other' } } }) + '\n')
    expect(deliveryProcessed(probe, env)).toBe(false)
    appendFileSync(j, JSON.stringify({ type: 'message.updated', properties: { info: { role: 'assistant', parentID: 'msg_u' } } }) + '\n')
    expect(deliveryProcessed(probe, env)).toBe(true)
  })
})

describe('processInflight — redeliver, or the sender learns', () => {
  const cfg = () => ({ stateDir: state, eventLogDir: join(root, 'logs') }) as never
  beforeEach(async () => {
    for (const p of ['alice', 'bob']) await upsertPeer({ personality: p, runtime: 'claude', cwd: join(root, p), intelligence: 'artificial' }, { rootDir: join(root, 'iapeer') })
  })
  test('orphan → redelivered AS the original sender with a visible prefix', async () => {
    recordInflight(state, entry())
    const sends: Array<{ from: string; to: string; message: string }> = []
    await processInflight(cfg(), { HOME: root, IAPEER_ROOT: join(root, 'iapeer') }, {}, {
      processed: () => false,
      send: (async (caller: { personality: string }, input: { personality: string; message: string }) => {
        sends.push({ from: caller.personality, to: input.personality, message: input.message })
        return ok({ ok: true, delivered_to: { personality: input.personality, runtime: 'claude' }, woke: true, ts: 'x' })
      }) as never,
    })
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ from: 'alice', to: 'bob' })
    expect(sends[0]!.message).toBe(redeliveryMessage(entry()))
    expect(listOrphanIdentities(state)).toEqual([])
  })

  test('interrupted turn → an explicit notice from the core system identity to the sender (no peer named iapeer registered), NO redelivery', async () => {
    recordInflight(state, entry())
    const calls: Array<{ route: string; message: string }> = []
    await processInflight(cfg(), { HOME: root, IAPEER_ROOT: join(root, 'iapeer') }, {}, {
      processed: () => true,
      completed: () => false,
      send: (async (caller: { personality: string }, input: { personality: string; message: string }) => {
        calls.push({ route: `${caller.personality}->${input.personality}`, message: input.message })
        return ok({ ok: true, delivered_to: { personality: input.personality, runtime: 'claude' }, woke: false, ts: 'x' })
      }) as never,
    })
    expect(calls.map(c => c.route)).toEqual(['iapeer-system->alice'])
    expect(calls[0]!.message).toMatch(/INTERRUPTED.*not guaranteed/)
    expect(listInterruptedIdentities(state)).toEqual([])
  })

  test('twenty injections into one unfinished session → ONE summary per sender; subsequent sweep → zero', async () => {
    for (let i = 0; i < 20; i++) recordInflight(state, entry({ message: `message-${i}`, topic: `topic-${i}` }))
    recordInflight(state, entry({ caller: { personality: 'other', runtime: 'codex' } }))
    const calls: Array<{ personality: string; message: string }> = []
    const seam = { processed: () => true, completed: () => false,
      send: (async (_caller: unknown, input: { personality: string; message: string }) => {
        calls.push(input)
        return ok({ ok: true, delivered_to: { personality: input.personality, runtime: 'claude' }, woke: false, ts: 'x' })
      }) as never }
    await processInflight(cfg(), { HOME: root, IAPEER_ROOT: join(root, 'iapeer') }, {}, seam)
    expect(calls.map(c => c.personality)).toEqual(['alice', 'other'])
    expect(calls[0]!.message).toContain('Affected deliveries (20)')
    expect(calls[0]!.message).toContain('message-19')
    await processInflight(cfg(), { HOME: root, IAPEER_ROOT: join(root, 'iapeer') }, {}, seam)
    expect(calls).toHaveLength(2)
  })

  test('ONE redelivery per message: an orphan that was already redelivered goes to the sender as a notice', async () => {
    recordInflight(state, entry({ message: redeliveryMessage(entry()) }))
    const calls: string[] = []
    await processInflight(cfg(), { HOME: root, IAPEER_ROOT: join(root, 'iapeer') }, {}, {
      processed: () => false,
      send: (async (caller: { personality: string }, input: { personality: string }) => {
        calls.push(`${caller.personality}->${input.personality}`)
        return ok({ ok: true, delivered_to: { personality: input.personality, runtime: 'claude' }, woke: false, ts: 'x' })
      }) as never,
    })
    expect(calls).toEqual(['iapeer-system->alice']) // no second redelivery to bob — the sender is told instead
  })

  test('redelivery fails (e.g. crash-loop guard) → orphan consumed and the attempt recorded; never silently kept or dropped', async () => {
    recordInflight(state, entry())
    const calls: Array<{ from: string; to: string; message: string }> = []
    await processInflight(cfg(), { HOME: root, IAPEER_ROOT: join(root, 'iapeer') }, {}, {
      processed: () => false,
      send: (async (caller: { personality: string }, input: { personality: string; message: string }) => {
        calls.push({ from: caller.personality, to: input.personality, message: input.message })
        return input.personality === 'bob' ? err('peer "bob" offline and wake failed: crash-loop guard') : ok({ ok: true, delivered_to: { personality: 'alice', runtime: 'claude' }, woke: false, ts: 'x' })
      }) as never,
    })
    expect(calls.map(c => `${c.from}->${c.to}`)).toEqual(['alice->bob', 'iapeer-system->alice']) // redelivery, then the explicit notice
    expect(calls[1]!.message).toMatch(/acknowledged but NOT processed.*crash-loop guard/)
    expect(listOrphanIdentities(state)).toEqual([])
  })
})

describe('core system identity — the notice sender that exists on every install', () => {
  test('the reserved name cannot be registered as a peer', async () => {
    const { SYSTEM_PERSONALITY } = await import('../core/constants.ts')
    await expect(upsertPeer({ personality: SYSTEM_PERSONALITY, runtime: 'claude', cwd: join(root, 'x'), intelligence: 'artificial' }, { rootDir: join(root, 'iapeer') })).rejects.toThrow(/reserved/)
  })
  test('routeSend accepts it as a caller with NO peer named iapeer registered (reaches the route, not an identity error)', async () => {
    await upsertPeer({ personality: 'alice', runtime: 'claude', cwd: join(root, 'alice'), intelligence: 'artificial' }, { rootDir: join(root, 'iapeer') })
    const { systemCaller } = await import('../identity/index.ts')
    const { routeSend } = await import('../transport/index.ts')
    const r = await routeSend(systemCaller(), { personality: 'alice', message: 'notice' }, { env: { HOME: root, IAPEER_ROOT: join(root, 'iapeer'), IAPEER_SOCK_DIR: join(root, 'socks') } })
    expect(r.ok).toBe(false) // alice has no live session and no wake dep → the explicit offline miss
    if (!r.ok) expect(r.error.message).not.toMatch(/self|unknown caller|not in the iapeer peers index/)
  })
})
