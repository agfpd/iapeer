import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainEphemeralQueue, loadLifecycleConfig, resolveWakeMode, setStopped, type LifecycleConfig } from '../lifecycle/index.ts'
import { enqueueEphemeralTask, peekEphemeralTask } from '../lifecycle/queue.ts'
import { buildEnvelope } from '../codec/index.ts'
import { deliveryCompleted } from '../transport/index.ts'
import { listFailoverTasks, providerFailure, quarantineSession, recordFailoverTask, recordProviderFailure, selectFailoverRuntime, sessionQuarantined, type FailoverTask, type ProviderFailure } from '../lifecycle/failover.ts'
import { findPeer, readPeersIndex, upsertPeer, type PeerRecord } from '../registry/index.ts'
import { readPeerProfile, writePeerProfileAtomic } from '../identity/index.ts'
import { processFailovers, type FailoverSeam } from './failover.ts'
import { failureContainsTask, failureForTask, refusedBeforeWork, refusedBeforeWorkInText, refusalReviewReason, refusalReviewReasonInText } from './failoverProof.ts'
import { readInflight, recordInflight } from '../lifecycle/inflight.ts'
import { processLimitResumes } from './limitresume.ts'
import { listLimitParks, recordLimitPark } from '../lifecycle/limitpark.ts'
import { ok } from '../core/errors.ts'
import { parseCodexRollout } from './mutewatch.ts'

let root: string, cfg: LifecycleConfig, env: NodeJS.ProcessEnv, peer: PeerRecord, at: number
const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
const rendered = '<iap from="alice" runtime="claude">unique task 42</iap>\n[iapeer taskId=unique-42]'
let task: FailoverTask, failure: ProviderFailure
const codexRows = () => [
  { type: 'session_meta', payload: { id: 'native-1', cwd: root } },
  { type: 'event_msg', timestamp: new Date(at - 200).toISOString(), payload: { type: 'task_started' } },
  { type: 'event_msg', timestamp: new Date(at - 100).toISOString(), payload: { type: 'user_message', message: rendered } },
  { type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'task_complete', last_agent_message: null, completed_at: at / 1000, error: { codex_error_info: 'unauthorized' } } },
]
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-failover-'))
  env = { ...process.env, IAPEER_ROOT: join(root, 'root'), IAPEER_LAUNCHAGENTS_DIR: join(root, 'launchagents'), IAPEER_SOCK_DIR: join(root, 'sock') }
  cfg = loadLifecycleConfig(env)
  mkdirSync(cfg.stateDir, { recursive: true })
  mkdirSync(join(root, 'launchagents'))
  await upsertPeer({ personality: 'p', runtime: 'codex', runtimes: ['codex', 'claude', 'opencode'], cwd: root, intelligence: 'artificial' }, { env })
  peer = findPeer(readPeersIndex({ env }), 'p')!
  at = Date.now() - 1000
  task = { id: 'test', state: 'watching', ts: at - 100, acceptedAtMs: at - 100, sentAt: new Date(at - 100).toISOString(),
    identity: 'codex-p', personality: 'p', runtime: 'codex', cwd: root, sessionToken: 'host:42', caller: { personality: 'alice', runtime: 'claude' },
    message: 'unique task 42', rendered, failoverEligible: true, failoverTaskId: 'unique-42', failoverVisited: ['codex'] }
  failure = { personality: 'p', runtime: 'codex', cwd: root, atMs: at, errorType: 'unauthorized', content: '401', sessionId: 'native-1', file: join(root, 'native.jsonl'), retryAtMs: at + 300_000 }
  writeFileSync(failure.file!, jsonl(codexRows()))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('provider selection and durable configuration', () => {
  test('default first; refusal skips to declared order; stopped runtimes are never selected', () => {
    expect(selectFailoverRuntime(cfg, peer)).toEqual(ok({ runtime: 'codex', eligible: true }))
    recordProviderFailure(cfg, failure)
    expect(selectFailoverRuntime(cfg, peer)).toEqual(ok({ runtime: 'claude', eligible: true }))
    setStopped(cfg, 'claude-p')
    expect(selectFailoverRuntime(cfg, peer)).toEqual(ok({ runtime: 'opencode', eligible: true }))
    setStopped(cfg, 'opencode-p')
    expect(selectFailoverRuntime(cfg, peer).ok).toBe(false)
    // walt policy: only codex remains eligible after provider recovery.
    expect(selectFailoverRuntime(cfg, peer, undefined, failure.retryAtMs + 1)).toEqual(ok({ runtime: 'codex', eligible: true }))
  })
  test('opt-out survives profile writes/reloads and does not bypass operator stop', () => {
    writePeerProfileAtomic(root, { personality: 'p', runtime: 'codex', runtimes: peer.runtimes, failover: false })
    expect(readPeerProfile(root)?.failover).toBe(false)
    writePeerProfileAtomic(root, { personality: 'p', runtime: 'codex', runtimes: peer.runtimes })
    expect(readPeerProfile(root)?.failover).toBe(false)
    recordProviderFailure(cfg, failure)
    expect(selectFailoverRuntime(cfg, peer)).toEqual(ok({ runtime: 'codex', eligible: false }))
    setStopped(cfg, 'codex-p')
    expect(selectFailoverRuntime(cfg, peer).ok).toBe(false)
  })
  test('explicit non-default threads stay pinned; older evidence cannot extend health block', () => {
    recordProviderFailure(cfg, failure)
    recordProviderFailure(cfg, { ...failure, atMs: at - 1, resetsAtMs: at + 10_000_000 })
    expect(providerFailure(cfg, 'codex-p')?.atMs).toBe(at)
    expect(selectFailoverRuntime(cfg, peer, 'opencode')).toEqual(ok({ runtime: 'opencode', eligible: false }))
    setStopped(cfg, 'opencode-p')
    expect(selectFailoverRuntime(cfg, peer, 'opencode').ok).toBe(false)
  })
  test('quarantine survives store reload, exact references remain excluded', () => {
    quarantineSession(cfg, 'codex-p', 'native-1')
    expect(sessionQuarantined({ stateDir: cfg.stateDir } as LifecycleConfig, 'codex-p', 'native-1')).toBe(true)
    expect(sessionQuarantined(cfg, 'codex-p', 'new-native')).toBe(false)
  })
})

describe('positive no-work proof', () => {
  test('steered Codex input requires completed prior response, never usage alone', () => {
    const rows: any[] = codexRows()
    const work = { type: 'response_item', payload: { type: 'reasoning' } }
    rows.splice(2, 0, work)
    expect(refusalReviewReasonInText(jsonl(rows), task, failure)).toBe('model-work-before-queued-input')
    rows.splice(3, 0, { type: 'token_usage_record', payload: { response_id: 'r1', usage: { output_tokens: 1018 } } })
    expect(refusalReviewReasonInText(jsonl(rows), task, failure)).toBe('model-work-before-queued-input')
    rows.splice(4, 0, { type: 'event_msg', payload: { type: 'raw_response_completed', response_id: 'r1' } })
    expect(refusalReviewReasonInText(jsonl(rows), task, failure)).toBeUndefined()
    rows.splice(5, 0, work)
    expect(refusalReviewReasonInText(jsonl(rows), task, failure)).toBe('model-work-before-queued-input')
  })
  test('completed response with an unresolved tool call is not a safe steering boundary', () => {
    const rows: any[] = codexRows()
    rows.splice(2, 0,
      { type: 'response_item', payload: { type: 'function_call', call_id: 'call1' } },
      { type: 'event_msg', payload: { type: 'raw_response_completed', response_id: 'r1' } })
    expect(refusalReviewReasonInText(jsonl(rows), task, failure)).toBe('model-work-before-queued-input')
    rows.splice(4, 0, { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call1', output: 'done' } })
    expect(refusalReviewReasonInText(jsonl(rows), task, failure)).toBeUndefined()
    rows.splice(6, 0, { type: 'response_item', payload: { type: 'reasoning' } })
    expect(refusalReviewReasonInText(jsonl(rows), task, failure)).toBe('model-work-after-input')
  })
  test('review reasons diagnose the original proof, without changing its verdict', () => {
    expect(refusalReviewReason(task, failure)).toBeUndefined()
    const rows = codexRows()
    rows.splice(3, 0, { type: 'event_msg', payload: { type: 'agent_reasoning' } } as any)
    expect(refusalReviewReasonInText(jsonl(rows), task, failure)).toBe('model-work-after-input')
    expect(refusalReviewReasonInText(jsonl(rows).trimEnd(), task, failure)).toBe('incomplete-or-unsupported-evidence')
    expect(refusalReviewReasonInText('not-json\n', task, failure)).toBe('malformed-evidence')
    writeFileSync(failure.file!, ' '.repeat(16 * 1024 * 1024 + 1))
    expect(refusalReviewReason(task, failure)).toBe('oversized-evidence')
  })
  test('real 0.164 API auth shape: tagged HTTP error, native UserMessage and inert developer input', () => {
    const rows: unknown[] = [
      { type: 'session_meta', payload: { id: 'native-1', cwd: root } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'additional_tools', role: 'developer', tools: [] } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [] } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: rendered }] } } },
      { type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'task_complete', last_agent_message: null, completed_at: at / 1000,
        error: { message: 'unexpected status 401 Unauthorized: Incorrect API key', codex_error_info: { http_connection_failed: { http_status_code: 401 } } } } },
    ]
    const text = jsonl(rows), d = parseCodexRollout(text, 0)!
    expect(d.errorType).toBe('http_connection_failed:401'); expect(d.sessionId).toBe('native-1')
    expect(refusedBeforeWorkInText(text, task, d)).toBe(true)
    rows.splice(5, 0, { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', text: 'working' } } })
    expect(refusedBeforeWorkInText(jsonl(rows), task, d)).toBe(false)
  })
  test('Codex native refusal before any model response; no refusal/missing input/mismatched session fail closed', () => {
    expect(refusedBeforeWorkInText(jsonl(codexRows()), task, failure)).toBe(true)
    expect(refusedBeforeWorkInText(jsonl(codexRows().slice(0, -1)), task, failure)).toBe(false)
    expect(refusedBeforeWorkInText(jsonl(codexRows().filter((_, i) => i !== 2)), task, failure)).toBe(false)
    expect(refusedBeforeWorkInText(jsonl(codexRows()), task, { ...failure, sessionId: 'other' })).toBe(false)
    expect(failureContainsTask(task, failure)).toBe(true)
  })
  for (const kind of ['function_call', 'reasoning', 'message']) test(`Codex ${kind} is not safe to replay`, () => {
    const rows: unknown[] = codexRows(); rows.splice(3, 0, { type: 'response_item', payload: { type: kind, role: kind === 'message' ? 'assistant' : undefined } })
    expect(refusedBeforeWorkInText(jsonl(rows), task, failure)).toBe(false)
  })
  test('unstarted batch is safe only without any model output; torn or malformed records fail closed', () => {
    const rows: unknown[] = codexRows(); rows.splice(3, 0, { type: 'event_msg', payload: { type: 'user_message', message: 'other' } })
    expect(refusedBeforeWorkInText(jsonl(rows), task, failure)).toBe(true)
    rows.push({ type: 'response_item', payload: { type: 'function_call' } })
    expect(refusedBeforeWorkInText(jsonl(rows), task, failure)).toBe(false)
    expect(refusedBeforeWorkInText(jsonl(codexRows()).trim(), task, failure)).toBe(false)
    expect(refusedBeforeWorkInText('bad\n' + jsonl(codexRows()), task, failure)).toBe(false)
  })
  test('a later refusal cannot steal an earlier finished task in the same native session', () => {
    const rows = codexRows()
    rows[3] = { ...rows[3], payload: { type: 'task_complete', last_agent_message: 'DONE', completed_at: (at - 10) / 1000 } } as any
    const later = [{ type: 'event_msg', payload: { type: 'task_started' } }, { type: 'event_msg', payload: { type: 'user_message', message: 'another task' } }, codexRows()[3]]
    writeFileSync(failure.file!, jsonl([...rows, ...later]))
    expect(failureContainsTask(task, failure)).toBe(false)
  })
  test('failed native terminal records are completion, but never successful completion', () => {
    const probe = { ...task, file: failure.file }
    expect(deliveryCompleted(probe, env)).toBe(true)
    expect(deliveryCompleted(probe, env, undefined, true)).toBe(false)
  })
  test('a long native session permits bounded input attribution, not a no-effects inference', () => {
    writeFileSync(failure.file!, jsonl([{ type: 'metadata', padding: 'x'.repeat(17 * 1024 * 1024) }, ...codexRows()]))
    expect(failureContainsTask(task, failure)).toBe(true)
    expect(refusedBeforeWork(task, failure)).toBe(false)
  })
  const claudeRows = () => [
    { type: 'user', uuid: 'u1', sessionId: 'native-1', message: { content: [{ type: 'text', text: rendered }] } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: new Date(at).toISOString(), isApiErrorMessage: true, message: { model: '<synthetic>' } },
  ]
  test('Claude synthetic refusal is not model work; re-ordered real assistant is work', () => {
    const t = { ...task, runtime: 'claude' }
    expect(refusedBeforeWorkInText(jsonl(claudeRows()), t, failure)).toBe(true)
    const real = { type: 'assistant', uuid: 'real', parentUuid: 'u1', message: { model: 'real', stop_reason: 'end_turn' } }
    expect(refusedBeforeWorkInText(jsonl([real, ...claudeRows()]), t, failure)).toBe(false)
    expect(refusedBeforeWorkInText(jsonl([...claudeRows(), real]), t, failure)).toBe(false)
  })
  test('real-401 metadata: auto_mode is inert, but a queued command or hook is not absence of work', () => {
    const rows: unknown[] = claudeRows()
    rows.splice(1, 0, { type: 'attachment', attachment: { type: 'auto_mode' } })
    expect(refusedBeforeWorkInText(jsonl(rows), { ...task, runtime: 'claude' }, failure)).toBe(true)
    rows.splice(1, 0, { type: 'attachment', attachment: { type: 'hook_success' } })
    expect(refusedBeforeWorkInText(jsonl(rows), { ...task, runtime: 'claude' }, failure)).toBe(false)
  })
  test('Claude queued_command and input inside a running turn are not replayed', () => {
    const t = { ...task, runtime: 'claude' }
    expect(refusedBeforeWorkInText(jsonl([{ type: 'attachment', attachment: { type: 'queued_command', prompt: rendered } }, claudeRows()[1]]), t, failure)).toBe(false)
    expect(refusedBeforeWorkInText(jsonl([{ type: 'assistant', message: { stop_reason: 'tool_use' } }, ...claudeRows()]), t, failure)).toBe(false)
  })
  test('Claude queued input before any model work retains its own refusal provenance', () => {
    const second = { ...task, runtime: 'claude', rendered: rendered + 'SECOND' }
    const rows = [
      claudeRows()[0],
      { type: 'attachment', uuid: 'u2', parentUuid: 'u1', sessionId: 'native-1', attachment: { type: 'queued_command', prompt: second.rendered } },
      { ...claudeRows()[1], parentUuid: 'u2', cwd: root },
    ]
    const f = { ...failure, runtime: 'claude' as const }
    writeFileSync(f.file!, jsonl(rows))
    expect(failureContainsTask(second, f)).toBe(true)
    expect(refusedBeforeWorkInText(jsonl(rows), second, f)).toBe(true)
    rows.splice(1, 0, { type: 'assistant', message: { model: 'real', stop_reason: 'tool_use' } } as any)
    expect(refusedBeforeWorkInText(jsonl(rows), second, f)).toBe(false)
  })
  test('Claude burst recovers an earlier refusal hidden by the newest sweep result', () => {
    const t = { ...task, runtime: 'claude' }, second = { ...t, rendered: rendered + 'SECOND', ts: at + 100 }
    const firstRows = claudeRows().map(r => ({ ...r, cwd: root }))
    const rows = [...firstRows,
      { ...firstRows[0], uuid: 'u2', parentUuid: 'a1', message: { content: second.rendered } },
      { ...firstRows[1], uuid: 'a2', parentUuid: 'u2', timestamp: new Date(at + 200).toISOString() },
    ]
    writeFileSync(failure.file!, jsonl(rows))
    const newest = { ...failure, runtime: 'claude' as const, atMs: at + 200 }
    const own = failureForTask(t, newest)!
    expect(own.atMs).toBe(at)
    expect(refusedBeforeWorkInText(jsonl(rows), t, own)).toBe(true)
    expect(refusedBeforeWorkInText(jsonl(rows), second, newest)).toBe(true)
  })
  test('OpenCode native session.error is unstarted only with zero output/tool parts', () => {
    const rows: unknown[] = [
      { sessionID: 'native-1', type: 'message.updated', properties: { info: { id: 'u', role: 'user' } } },
      { sessionID: 'native-1', type: 'message.part.updated', properties: { part: { messageID: 'u', type: 'text', text: rendered } } },
      { sessionID: 'native-1', type: 'message.updated', properties: { info: { id: 'a', role: 'assistant', parentID: 'u' } } },
      { sessionID: 'native-1', type: 'session.error', time: at, properties: { error: { name: 'ProviderAuthError' } } },
    ]
    expect(refusedBeforeWorkInText(jsonl(rows), { ...task, runtime: 'opencode' }, failure)).toBe(true)
    rows.splice(3, 0, { sessionID: 'native-1', type: 'message.part.updated', properties: { part: { messageID: 'a', type: 'tool' } } })
    expect(refusedBeforeWorkInText(jsonl(rows), { ...task, runtime: 'opencode' }, failure)).toBe(false)
  })
})

describe('custody transfer', () => {
  let sent: any[], live: boolean, killed: number
  const setup = () => {
    sent = []; live = true; killed = 0
    recordProviderFailure(cfg, failure)
    recordFailoverTask(cfg, task)
    recordInflight(cfg.stateDir, { ...task, id: 'ledger' })
  }
  const seam = (): FailoverSeam => ({ alive: () => live, token: () => 'host:42', kill: () => { killed++; live = false },
    send: async (caller, input, deps) => {
      expect(live).toBe(false)
      expect(sessionQuarantined(cfg, 'codex-p', 'native-1')).toBe(true)
      expect(readInflight(cfg.stateDir, 'codex-p')).toEqual([])
      sent.push({ caller, input, deps })
      return ok({ ok: true, delivered_to: { personality: 'p', runtime: input.runtime! }, woke: true, ts: 'now' })
    } })
  test('unstarted work transfers once, old native session cannot resume; limit-resume drops resurrected old park', async () => {
    setup()
    await upsertPeer({ personality: 'alice', runtime: 'claude', cwd: root, intelligence: 'artificial' }, { env })
    recordLimitPark(cfg, { identity: 'codex-p', personality: 'p', runtime: 'codex', resetsAtMs: at - 999999, eventAtMs: at, sessionId: 'native-1' })
    await processFailovers(cfg, env, {}, undefined, seam())
    expect(killed).toBe(1); expect(sent).toHaveLength(1)
    expect(sent[0].input).toMatchObject({ runtime: 'claude', message: task.message })
    expect(sent[0].caller.personality).toBe('alice')
    expect(listFailoverTasks(cfg, true)[0]?.state).toBe('transferred')
    expect(resolveWakeMode(cfg, 'codex-p', root, true, () => ({ ok: true, ref: 'native-1' })).resume).toBe(false)
    // Even a stale overlapping mute sweep must not revive the retired job.
    recordLimitPark(cfg, { identity: 'codex-p', personality: 'p', runtime: 'codex', resetsAtMs: at - 999999, eventAtMs: at, sessionId: 'native-1' })
    let nudges = 0
    await processLimitResumes(cfg, env, {}, { send: async () => { nudges++; throw new Error('must not nudge') } })
    expect(nudges).toBe(0); expect(listLimitParks(cfg)).toEqual([])
    await processFailovers(cfg, env, {}, undefined, seam())
    expect(sent).toHaveLength(1)
  })
  test('stopped alternatives (walt codex-only) leave current work parked, no kill or replay', async () => {
    setup(); setStopped(cfg, 'claude-p'); setStopped(cfg, 'opencode-p')
    await processFailovers(cfg, env, {}, undefined, seam())
    expect(killed).toBe(0); expect(sent).toEqual([]); expect(listFailoverTasks(cfg, true)[0]?.state).toBe('watching')
  })
  test('a late tool call racing teardown becomes a review, not replay', async () => {
    setup()
    const s = seam()
    s.kill = () => { live = false; appendFileSync(failure.file!, jsonl([{ type: 'response_item', payload: { type: 'function_call' } }])) }
    await processFailovers(cfg, env, {}, undefined, s)
    expect(sent).toHaveLength(1)
    expect(sent[0].caller.runtime).toBe('core')
    expect(sent[0].input.message).toContain('not authorization to replay')
    // The peer must read a limit as a provider-side stop, not as its own fault (natural limit 04.11).
    expect(sent[0].input.message).toContain(`(${failure.errorType}:`)
    expect(sent[0].input.message).not.toContain(task.message)
    expect(listFailoverTasks(cfg, true)[0]?.reviewReason).toBe('model-work-after-input')
  })
  test('unknown dispatch never retries; lost hosting confirmation never transfers', async () => {
    setup(); await upsertPeer({ personality: 'alice', runtime: 'claude', cwd: root, intelligence: 'artificial' }, { env })
    let attempts = 0
    const s = seam(); s.send = async () => { attempts++; throw new Error('lost receipt') }
    await processFailovers(cfg, env, {}, undefined, s)
    await processFailovers(cfg, env, {}, undefined, s)
    expect(attempts).toBe(1); expect(listFailoverTasks(cfg, true)[0]?.state).toBe('review')
    expect(listFailoverTasks(cfg, true)[0]?.reviewReason).toBe('dispatch-uncertain')
  })
  test('replacement hosting and unrelated refusal never authorize killing another session', async () => {
    setup()
    const s = seam(); s.token = () => 'host:other'
    await processFailovers(cfg, env, {}, undefined, s)
    expect(killed).toBe(0); expect(sent).toHaveLength(0)
    expect(listFailoverTasks(cfg, true)[0]?.state).toBe('review')
  })
  test('a runtime stopped during teardown is skipped before actual transfer', async () => {
    setup(); await upsertPeer({ personality: 'alice', runtime: 'claude', cwd: root, intelligence: 'artificial' }, { env })
    const s = seam(); s.kill = () => { live = false; setStopped(cfg, 'claude-p') }
    await processFailovers(cfg, env, {}, undefined, s)
    expect(sent).toHaveLength(1); expect(sent[0].input.runtime).toBe('opencode')
  })
  test('an operator stop of the source during teardown cancels transfer, not operator intent', async () => {
    setup(); const s = seam(); s.kill = () => { live = false; setStopped(cfg, 'codex-p') }
    await processFailovers(cfg, env, {}, undefined, s)
    expect(sent).toHaveLength(0)
  })
  test('two provider refusals between sweeps retain both tasks, each transferred exactly once in receipt order', async () => {
    setup(); await upsertPeer({ personality: 'alice', runtime: 'claude', cwd: root, intelligence: 'artificial' }, { env })
    const second = { ...task, acceptedAtMs: at + 100, ts: at + 100, rendered: rendered + 'SECOND', message: 'second task', failoverTaskId: 'second-id' }
    const rows = codexRows()
    const later = [
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'event_msg', payload: { type: 'user_message', message: second.rendered } },
      { type: 'event_msg', timestamp: new Date(at + 200).toISOString(), payload: { type: 'task_complete', last_agent_message: null, completed_at: (at + 200) / 1000, error: { codex_error_info: 'unauthorized', message: '401' } } },
    ]
    writeFileSync(failure.file!, jsonl([...rows, ...later]))
    const latest = { ...failure, atMs: at + 200 }
    recordProviderFailure(cfg, latest); recordFailoverTask(cfg, second)
    expect(failureForTask(task, latest)?.atMs).toBe(at)
    expect(failureForTask(second, latest)?.atMs).toBe(at + 200)
    await processFailovers(cfg, env, {}, undefined, seam())
    expect(sent.map(s => s.input.message)).toEqual([task.message, second.message])
    expect(killed).toBe(1)
    await processFailovers(cfg, env, {}, undefined, seam())
    expect(sent).toHaveLength(2)
  })
})

test('FIFO rebinding is serialized at the original queue; automatic provenance survives actual drain', async () => {
  recordProviderFailure(cfg, failure)
  const envelope = buildEnvelope({ fromPersonality: 'alice', fromRuntime: 'claude', fromIntelligence: 'artificial', message: task.message, sentAt: task.sentAt })
  enqueueEphemeralTask(cfg, 'codex-p', { task: envelope, failoverEligible: true, failoverTaskId: 'unique-42', failoverVisited: ['codex'] })
  expect(peekEphemeralTask(cfg, 'codex-p')?.failoverEligible).toBe(true)
  const calls: string[] = []
  const wakeFn = async (args: any) => { calls.push(args.runtime); await Bun.sleep(10); return { status: 'READY' as const, woke: true, runtime: args.runtime } }
  await Promise.all([drainEphemeralQueue(cfg, 'p', 'codex', { env, wakeFn }), drainEphemeralQueue(cfg, 'p', 'codex', { env, wakeFn })])
  expect(calls).toEqual(['claude'])
  expect(peekEphemeralTask(cfg, 'codex-p')).toBeNull()
  expect(listFailoverTasks(cfg)[0]?.failoverVisited).toEqual(['codex', 'claude'])
})
