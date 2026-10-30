import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LIMIT_MAX_HOLD_MS,
  LIMIT_RESUME_GRACE_MS,
  LIMIT_RESOLVE_WINDOW_MS,
  clearLimitPark,
  claudeProgressedSince,
  codexProgressedSince,
  limitHoldActive,
  listLimitParks,
  readLimitPark,
  recordLimitPark,
  type LimitPark,
} from './limitpark.ts'
import { loadLifecycleConfig, superviseTick, hasIdleReaped, resolveWakeMode, setIdleReaped, setNewEager, addTopic, type LifecycleConfig } from './index.ts'
import { limitResumeMessage, processLimitResumes } from '../daemon/limitresume.ts'
import { claudeResetsAtMs, parseClaudeTranscript } from '../daemon/mutewatch.ts'
import { ok, err } from '../core/errors.ts'
import { SYSTEM_PERSONALITY } from '../core/constants.ts'
import { upsertPeer } from '../registry/index.ts'
import { noteHostingGeneration } from './workOrigin.ts'

let root: string
let laDir: string
let env: NodeJS.ProcessEnv
let cfg: LifecycleConfig
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-limitpark-'))
  laDir = mkdtempSync(join(tmpdir(), 'iapeer-limitpark-la-'))
  env = { ...process.env, IAPEER_ROOT: root, IAPEER_LAUNCHAGENTS_DIR: laDir, IAPEER_SOCK_DIR: join(root, 'socks') }
  cfg = loadLifecycleConfig(env)
  mkdirSync(cfg.stateDir, { recursive: true })
  await upsertPeer({ personality: 'iapeer', runtime: 'claude', runtimes: ['claude', 'codex'], cwd: root, intelligence: 'artificial' }, { env })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(laDir, { recursive: true, force: true })
})

const T0 = Date.parse('2026-10-18T01:55:43.704Z') // the real incident's event time
const RESET = 1792301400 * 1000 // its stated resetsAt (08:30 MSK)
const park = (over: Partial<LimitPark> = {}): LimitPark => ({
  identity: 'claude-iapeer',
  personality: 'iapeer',
  runtime: 'claude',
  resetsAtMs: RESET,
  eventAtMs: T0,
  errorType: 'rate_limit',
  ...over,
})

/** The real 18.10.2026 refusal line, trimmed to the fields that matter. */
const REAL_LINE = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-10-18T01:55:43.704Z',
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 8:30am (Europe/Moscow)" }] },
  apiError: 'usage_limit_reached',
  apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: 1792301400, rateLimitType: 'five_hour' } },
  quotaLimits: { status: 'rejected', resetsAt: 1792301400, rateLimitType: 'five_hour' },
  error: 'rate_limit',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  cwd: '/Users/macmini/Projects/iapeer',
  sessionId: '4736d754-182b-4fb1-ad21-e48f581f63d0',
})

describe('claude states its reset structurally (real bytes 18.10.2026)', () => {
  test('resetsAt is read from quotaLimits / apiErrorParams (epoch s → ms)', () => {
    expect(claudeResetsAtMs(JSON.parse(REAL_LINE))).toBe(RESET)
    expect(claudeResetsAtMs({ apiErrorParams: { rate_limit_info: { resetsAt: 1792301400 } } })).toBe(RESET)
    expect(claudeResetsAtMs({ error: 'rate_limit' })).toBeUndefined() // per-model bucket: none stated → none invented
  })
  test('the detection carries resetsAtMs', () => {
    const d = parseClaudeTranscript(REAL_LINE, 0)
    expect(d?.resetsAtMs).toBe(RESET)
    expect(d?.errorType).toBe('rate_limit')
  })
})

describe('park store', () => {
  test('the same event re-read by the overlapping sweep does not reset the park; a newer one supersedes', () => {
    expect(recordLimitPark(cfg, park())).toBe(true)
    expect(recordLimitPark(cfg, park())).toBe(false)
    expect(recordLimitPark(cfg, park({ eventAtMs: T0 + 1000, resetsAtMs: RESET + 60_000 }))).toBe(true)
    expect(readLimitPark(cfg, 'claude-iapeer')?.resetsAtMs).toBe(RESET + 60_000)
    expect(listLimitParks(cfg)).toHaveLength(1)
  })
  test('hold: live THROUGH the nudge (until the park resolves), bounded by the retry window and the max-hold bound', () => {
    recordLimitPark(cfg, park())
    expect(limitHoldActive(cfg, 'claude-iapeer', T0 + 60_000)).not.toBeNull()
    // The nudge becomes due at reset + grace: the hold must still stand then (incident 18.10).
    expect(limitHoldActive(cfg, 'claude-iapeer', RESET + LIMIT_RESUME_GRACE_MS)).not.toBeNull()
    expect(limitHoldActive(cfg, 'claude-iapeer', RESET + LIMIT_RESOLVE_WINDOW_MS)).toBeNull() // nobody resolved it
    clearLimitPark(cfg, 'claude-iapeer')
    expect(limitHoldActive(cfg, 'claude-iapeer', RESET + LIMIT_RESUME_GRACE_MS)).toBeNull() // resolved → normal idle
    recordLimitPark(cfg, park({ identity: 'claude-w', eventAtMs: T0, resetsAtMs: T0 + LIMIT_MAX_HOLD_MS + 1 })) // a weekly wall
    expect(limitHoldActive(cfg, 'claude-w', T0 + 60_000)).toBeNull()
  })
})

describe('progress probes', () => {
  test('claude: only a REAL assistant reply after the event is progress — a new refusal is not', () => {
    const real = JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 5000).toISOString(), message: { model: 'claude-opus-5-5' } })
    const before = JSON.stringify({ type: 'assistant', timestamp: new Date(T0 - 5000).toISOString(), message: { model: 'claude-opus-5-5' } })
    const refusal = JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 5000).toISOString(), isApiErrorMessage: true, message: { model: '<synthetic>' } })
    expect(claudeProgressedSince([before, REAL_LINE, refusal].join('\n'), T0)).toBe(false)
    expect(claudeProgressedSince([REAL_LINE, real].join('\n'), T0)).toBe(true)
  })
  test('codex: a task_complete WITH a message whose completed_at is after the event', () => {
    const done = (msg: string | null, atS: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: msg, completed_at: atS } })
    expect(codexProgressedSince(done(null, T0 / 1000 + 10), T0)).toBe(false)
    expect(codexProgressedSince(done('ok', T0 / 1000 - 10), T0)).toBe(false) // replayed history
    expect(codexProgressedSince(done('ok', T0 / 1000 + 10), T0)).toBe(true)
  })
})

describe('HOLD — superviseTick does not idle-reap a session waiting for its limit to reset', () => {
  function liveSession(personality: string, wokeAt: number): void {
    const cwd = join(root, 'peers', personality)
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(join(cwd, '.iapeer', 'peer-profile.json'), JSON.stringify({ personality, default_runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial' }))
    writeFileSync(join(cfg.stateDir, `claude-${personality}.session`), JSON.stringify({ identity: `claude-${personality}`, runtime: 'claude', personality, cwd, wokeAt }))
  }
  test('parked → alive (limit-hold) past idleSecs; still held when the nudge is due; reaped normally once resolved', () => {
    liveSession('p', T0 - 7_200_000)
    recordLimitPark(cfg, park({ identity: 'claude-p', personality: 'p' }))
    const during = T0 + 2 * 3_600_000 // 05:55 — when the real fleet was reaped
    const a = superviseTick(cfg, { env, nowMs: during, sessionAlive: () => true, lastTurnMtime: () => T0, killSession: () => {} })
    expect(a.find(x => x.identity === 'claude-p')?.action).toBe('alive')
    expect(hasIdleReaped(cfg, 'claude-p')).toBe(false)
    const due = RESET + LIMIT_RESUME_GRACE_MS + 1
    const b = superviseTick(cfg, { env, nowMs: due, sessionAlive: () => true, lastTurnMtime: () => T0, killSession: () => {} })
    expect(b.find(x => x.identity === 'claude-p')?.action).toBe('alive') // no reap racing the nudge
    clearLimitPark(cfg, 'claude-p') // the nudge resolved the park
    const c = superviseTick(cfg, { env, nowMs: due + 1, sessionAlive: () => true, lastTurnMtime: () => T0, killSession: () => {} })
    expect(c.find(x => x.identity === 'claude-p')?.action).toBe('reaped-idle')
  })
})

describe('NUDGE — after the reset the core continues the stopped turn, no human', () => {
  type Sent = { from: string; to: string; runtime?: string; topic?: string; message: string }
  const depsSeen: Array<{ wakeContinueWork?: boolean }> = []
  const spy = (sent: Sent[], result: 'ok' | 'fail' | 'stopped' = 'ok') =>
    (async (caller: { personality: string }, input: { personality: string; runtime?: string; topic?: string; message: string }, deps: { wakeContinueWork?: boolean }) => {
      depsSeen.push(deps)
      sent.push({ from: caller.personality, to: input.personality, runtime: input.runtime, topic: input.topic, message: input.message })
      if (result === 'fail') return err('peer "iapeer" offline and wake failed: boom')
      if (result === 'stopped') return err('peer "iapeer" is stopped and not accepting messages')
      return ok({ ok: true, delivered_to: { personality: input.personality, runtime: 'claude' }, woke: true, ts: 'x' })
    }) as never

  test('THE CRITERION: limit with resetsAt in N → before N nothing; after N the peer gets ONE continuation, from the system identity (target may be `iapeer` itself)', async () => {
    recordLimitPark(cfg, park())
    const sent: Sent[] = []
    await processLimitResumes(cfg, env, {}, { send: spy(sent), progressed: () => false, now: () => RESET - 1000 })
    expect(sent).toHaveLength(0)
    await processLimitResumes(cfg, env, {}, { send: spy(sent), progressed: () => false, now: () => RESET + LIMIT_RESUME_GRACE_MS })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ from: SYSTEM_PERSONALITY, to: 'iapeer', runtime: 'claude', topic: 'limit-resume' })
    expect(sent[0]!.message).toBe(limitResumeMessage(park()))
    expect(depsSeen[0]?.wakeContinueWork).toBe(true) // the wake it may trigger RESUMES (live run 18.10: without it → fresh, context lost)
    expect(listLimitParks(cfg)).toHaveLength(0) // one nudge per limit event
    await processLimitResumes(cfg, env, {}, { send: spy(sent), progressed: () => false, now: () => RESET + LIMIT_RESUME_GRACE_MS * 10 })
    expect(sent).toHaveLength(1)
  })
  test('a session reaped by the SAME tick is not nudged into its dying socket; the next tick nudges it (no attempt burned)', async () => {
    recordLimitPark(cfg, park())
    const sent: Sent[] = []
    const t = RESET + LIMIT_RESUME_GRACE_MS
    await processLimitResumes(cfg, env, {}, { send: spy(sent), progressed: () => false, now: () => t, justReaped: new Set(['claude-iapeer']) })
    expect(sent).toHaveLength(0)
    expect(listLimitParks(cfg)[0]?.attempts ?? 0).toBe(0)
    await processLimitResumes(cfg, env, {}, { send: spy(sent), progressed: () => false, now: () => t + 60_000 })
    expect(sent).toHaveLength(1)
  })
  test('the runtime continued on its own → no nudge (no duplicate turn)', async () => {
    recordLimitPark(cfg, park())
    const sent: Sent[] = []
    await processLimitResumes(cfg, env, {}, { send: spy(sent), progressed: () => true, now: () => RESET + LIMIT_RESUME_GRACE_MS })
    expect(sent).toHaveLength(0)
    expect(listLimitParks(cfg)).toHaveLength(0)
  })
  test('a failed nudge is retried with backoff, bounded; an operator stop is never fought', async () => {
    recordLimitPark(cfg, park())
    const sent: Sent[] = []
    const t = RESET + LIMIT_RESUME_GRACE_MS
    await processLimitResumes(cfg, env, {}, { send: spy(sent, 'fail'), progressed: () => false, now: () => t })
    await processLimitResumes(cfg, env, {}, { send: spy(sent, 'fail'), progressed: () => false, now: () => t + 1000 }) // inside backoff
    expect(sent).toHaveLength(1)
    expect(readLimitPark(cfg, 'claude-iapeer')?.attempts).toBe(1)
    recordLimitPark(cfg, park({ identity: 'claude-s', personality: 's' }))
    await processLimitResumes(cfg, env, {}, { send: spy(sent, 'stopped'), progressed: () => false, now: () => t + 10 * 60_000 })
    expect(readLimitPark(cfg, 'claude-s')).toBeNull()
  })
  test('legacy/non-default park never nudges its endpoint, even when already live; status follows default', async () => {
    recordLimitPark(cfg, park({ identity: 'codex-iapeer', runtime: 'codex' }))
    const sent: Sent[] = []
    await processLimitResumes(cfg, env, {}, { send: spy(sent), progressed: () => false, now: () => RESET + LIMIT_RESUME_GRACE_MS })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ runtime: undefined, topic: 'limit-resume-skipped' })
    expect(listLimitParks(cfg)).toHaveLength(0)
  })
  test('unfinished explicit non-default work resumes on its addressed endpoint, not the default', async () => {
    noteHostingGeneration(cfg, 'codex-iapeer', 'limited-host')
    recordLimitPark(cfg, park({ identity: 'codex-iapeer', runtime: 'codex', workOrigin: { sessionToken: 'limited-host', deliveredAtMs: T0 - 1000, caller: { personality: 'pm', runtime: 'claude' } } }))
    const sent: Sent[] = []
    await processLimitResumes(cfg, env, {}, { send: spy(sent), progressed: () => false, now: () => RESET + LIMIT_RESUME_GRACE_MS })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ runtime: 'codex', topic: 'limit-resume' })
  })
  test('a failed skipped-work status is retried, never replaced by a secondary continuation', async () => {
    recordLimitPark(cfg, park({ identity: 'codex-iapeer', runtime: 'codex' }))
    const sent: Sent[] = [], t = RESET + LIMIT_RESUME_GRACE_MS
    await processLimitResumes(cfg, env, {}, { send: spy(sent, 'fail'), progressed: () => false, now: () => t })
    expect(listLimitParks(cfg)).toHaveLength(1)
    await processLimitResumes(cfg, env, {}, { send: spy(sent), progressed: () => false, now: () => t + 6 * 60_000 })
    expect(listLimitParks(cfg)).toHaveLength(0)
    expect(sent.every(s => s.runtime === undefined)).toBe(true)
  })
})

describe('continue-work wake intent — the nudge resumes the stopped context', () => {
  const peerCwd = () => {
    const c = join(root, 'peers', 'p')
    mkdirSync(join(c, '.iapeer'), { recursive: true })
    writeFileSync(join(c, '.iapeer', 'peer-profile.json'), JSON.stringify({ personality: 'p', default_runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial' }))
    return c
  }
  const has = () => ({ ok: true, ref: 'uuid-1' })
  test('idle-reaped + a topic the lineage never saw → still RESUME under continueWork (fresh without it)', () => {
    const c = peerCwd()
    setIdleReaped(cfg, 'claude-p')
    addTopic(cfg, 'claude-p', 'old-thread')
    expect(resolveWakeMode(cfg, 'claude-p', c, undefined, has, 'limit-resume', f => f(), false).cause).toBe('idle-reaped-new-topic')
    setIdleReaped(cfg, 'claude-p')
    expect(resolveWakeMode(cfg, 'claude-p', c, undefined, has, 'limit-resume', f => f(), true)).toEqual({ resume: true, resumeRef: 'uuid-1', cause: 'idle-reaped-continue' })
  })
  test('never outranks an owner /new', () => {
    const c = peerCwd()
    setIdleReaped(cfg, 'claude-p')
    setNewEager(cfg, 'claude-p')
    expect(resolveWakeMode(cfg, 'claude-p', c, undefined, has, undefined, f => f(), true).cause).toBe('self-fresh-eager')
  })
})

describe('mute-watch attribution — a peer that cd-ed into a subdirectory is still itself', () => {
  test('nearest registered ancestor wins; a non-peer path stays unattributed', async () => {
    const { peerByCwdPrefix } = await import('../daemon/mutewatch.ts')
    const m = new Map([['/users/x/peers/a', 'a'], ['/users/x/peers/a/nested', 'n']])
    expect(peerByCwdPrefix(m, '/Users/x/peers/a/.iapeer')).toBe('a')
    expect(peerByCwdPrefix(m, '/Users/x/peers/a/nested/src/')).toBe('n')
    expect(peerByCwdPrefix(m, '/Users/x/peers/a')).toBe('a')
    expect(peerByCwdPrefix(m, '/Users/x/elsewhere')).toBeUndefined()
    expect(peerByCwdPrefix(m, '/')).toBeUndefined()
    const home = new Map([['/users/x', 'h']])
    expect(peerByCwdPrefix(home, '/Users/x')).toBe('h') // exact still attributes
    expect(peerByCwdPrefix(home, '/Users/x/Projects/other')).toBeUndefined() // a $HOME peer never swallows the host
  })
})
