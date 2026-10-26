import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pidPath } from '../supervisor/paths.ts'
import {
  closeVoice,
  deriveVoiceStatus,
  descendants,
  openVoice,
  parseRolloutVoice,
  readIntent,
  shouldIdleClose,
  voiceStatus,
  voiceSweep,
  type ProcRow,
  type VoiceDeps,
  type VoiceObservation,
} from './index.ts'

const T0 = Date.parse('2026-10-26T15:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const line = (atMs: number, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: iso(atMs), type, payload })
const started = (at: number, id: string) => line(at, 'realtime_item', { id, type: 'realtime_session_started' })
const closed = (at: number, id: string, outcome = 'ended') => line(at, 'realtime_item', { id, type: 'realtime_session_closed', outcome })
const seg = (at: number, role: string) => line(at, 'realtime_item', { id: 'seg', type: 'transcript_segment', role, text: 'x' })
const task = (at: number, type: 'task_started' | 'task_complete') => line(at, 'event_msg', { type })

describe('parseRolloutVoice', () => {
  test('receipts, activity and running turn from real-shaped lines', () => {
    const r = parseRolloutVoice([
      line(T0 - 9000, 'session_meta', { id: 'thread-1' }),
      started(T0, 's1'),
      seg(T0 + 1000, 'user'),
      task(T0 + 2000, 'task_started'),
      seg(T0 + 3000, 'assistant'),
      '{"torn',
    ].join('\n'))
    expect(r.threadId).toBe('thread-1')
    expect(r.started).toEqual({ id: 's1', atMs: T0 })
    expect(r.closed).toBeUndefined()
    expect(r.lastActivityMs).toBe(T0 + 3000)
    expect(r.turnRunning).toBe(true)
  })
  test('close after start; completed turn', () => {
    const r = parseRolloutVoice([started(T0, 's1'), task(T0 + 1, 'task_started'), task(T0 + 2, 'task_complete'), closed(T0 + 5, 'c1')].join('\n'))
    expect(r.closed).toEqual({ id: 'c1', atMs: T0 + 5, outcome: 'ended' })
    expect(r.turnRunning).toBe(false)
  })
})

describe('deriveVoiceStatus', () => {
  const obs = (hosts: number, lines: string[]): VoiceObservation => ({ live: true, hosts: Array.from({ length: hosts }, (_, i) => 100 + i), rollout: parseRolloutVoice(lines.join('\n')) })
  test('helper + started → open with idle', () => {
    const s = deriveVoiceStatus(obs(1, [started(T0, 's1'), seg(T0 + 1000, 'user')]), { op: 'open', atMs: T0 - 500 }, T0 + 31_000)
    expect(s).toMatchObject({ state: 'open', session: 's1', hosts: 1, idleMs: 30_000, turnRunning: false })
  })
  test('helper but backend not started yet → opening', () => {
    expect(deriveVoiceStatus(obs(1, []), { op: 'open', atMs: T0 }, T0 + 1000).state).toBe('opening')
  })
  test('a started item from a PREVIOUS session does not satisfy a new open', () => {
    const s = deriveVoiceStatus(obs(1, [started(T0 - 60_000, 'old')]), { op: 'open', atMs: T0 }, T0 + 1000)
    expect(s.state).toBe('opening')
  })
  test('no helper inside the open grace → opening (a SIGKILLed caller cannot fake closed)', () => {
    expect(deriveVoiceStatus(obs(0, []), { op: 'open', atMs: T0 }, T0 + 2000).state).toBe('opening')
  })
  test('no helper after the grace → closed', () => {
    expect(deriveVoiceStatus(obs(0, []), { op: 'open', atMs: T0 }, T0 + 60_000).state).toBe('closed')
  })
  test('close intent with helper still up → closing', () => {
    expect(deriveVoiceStatus(obs(1, [started(T0, 's1')]), { op: 'close', atMs: T0 + 5 }, T0 + 6).state).toBe('closing')
  })
  test('rollout says open but helper gone → closed (audio is the ground truth)', () => {
    expect(deriveVoiceStatus(obs(0, [started(T0, 's1')]), null, T0 + 1).state).toBe('closed')
  })
  test('idle decision: running turn is never idle', () => {
    const open = deriveVoiceStatus(obs(1, [started(T0, 's1'), task(T0 + 1, 'task_started')]), { op: 'open', atMs: T0 }, T0 + 600_000)
    expect(shouldIdleClose(open, 90)).toBe(false)
    const idle = deriveVoiceStatus(obs(1, [started(T0, 's1'), seg(T0 + 1, 'assistant')]), { op: 'open', atMs: T0 }, T0 + 91_000)
    expect(shouldIdleClose(idle, 90)).toBe(true)
    expect(shouldIdleClose({ ...idle, idleMs: 89_000 }, 90)).toBe(false)
  })
})

test('descendants walks the supervised tree only', () => {
  const rows: ProcRow[] = [
    { pid: 10, ppid: 1, comm: 'iapeer' },
    { pid: 11, ppid: 10, comm: 'codex' },
    { pid: 12, ppid: 11, comm: '/x/codex-voice-host' },
    { pid: 20, ppid: 1, comm: '/x/codex-voice-host' },
  ]
  expect(descendants(rows, 10).map(r => r.pid).sort()).toEqual([11, 12])
})

// ─── Flows against a simulated codex TUI ─────────────────────────────────────

interface World {
  hosts: number
  lines: string[]
  now: number
  typed: string[][]
  /** How the fake TUI reacts to `/voice` (open) — mimics codex's toggle. */
  onOpen: 'start' | 'hang' | 'none'
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function world(init: Partial<World> = {}): { w: World; d: VoiceDeps } {
  const root = mkdtempSync(join(tmpdir(), 'iapeer-voice-'))
  dirs.push(root)
  const runDir = join(root, 'run')
  require('node:fs').mkdirSync(runDir)
  writeFileSync(pidPath(runDir, 'codex-p'), '500')
  const w: World = { hosts: 0, lines: [], now: T0, typed: [], onOpen: 'start', ...init }
  let seq = 0
  const d: VoiceDeps = {
    env: {},
    stateDir: join(root, 'voice'),
    runDir,
    procTable: () => [
      { pid: 500, ppid: 1, comm: 'iapeer' },
      { pid: 501, ppid: 500, comm: 'codex' },
      ...Array.from({ length: w.hosts }, (_, i) => ({ pid: 600 + i, ppid: 501, comm: '/opt/codex-resources/voice/bin/codex-voice-host' })),
    ],
    openRollout: () => '/fake/rollout.jsonl',
    readTail: () => w.lines.join('\n'),
    now: () => w.now,
    sleep: async ms => {
      w.now += ms
    },
    control: async args => {
      w.typed.push(args)
      if (args[0] === 'open') {
        // Toggle semantics: an open session would be CLOSED by a second /voice.
        if (w.hosts > 0) {
          w.hosts = 0
          w.lines.push(closed(w.now, `c${++seq}`))
        } else if (w.onOpen === 'start') {
          w.hosts = 1
          w.lines.push(started(w.now + 1, `s${++seq}`))
        } else if (w.onOpen === 'hang') {
          w.hosts = 1 // helper up, backend never starts
        }
      }
      if (args[0] === 'stop' && w.hosts > 0) {
        w.hosts = 0
        w.lines.push(closed(w.now, `c${++seq}`))
      }
      return { ok: true }
    },
  }
  return { w, d }
}

describe('openVoice / closeVoice', () => {
  test('open → exactly one session; second open is idempotent and types nothing', async () => {
    const { w, d } = world()
    const a = await openVoice(d, 'codex-p')
    expect(a).toMatchObject({ ok: true, state: 'open', already: false, hosts: 1 })
    const b = await openVoice(d, 'codex-p')
    expect(b).toMatchObject({ ok: true, state: 'open', already: true, session: a.session })
    expect(w.typed).toEqual([['open']])
    expect(w.hosts).toBe(1)
  })
  test('close → receipt only after the helper is gone; repeat close is already', async () => {
    const { w, d } = world()
    await openVoice(d, 'codex-p')
    const c = await closeVoice(d, 'codex-p')
    expect(c).toMatchObject({ ok: true, state: 'closed', reason: 'requested', hosts: 0 })
    expect(w.hosts).toBe(0)
    expect(voiceStatus(d, 'codex-p')).toMatchObject({ state: 'closed', reason: 'requested' })
    expect(await closeVoice(d, 'codex-p')).toMatchObject({ ok: true, state: 'closed', already: true })
  })
  test('a poll during the close confirm window never reports the PREVIOUS session/reason', async () => {
    const { w, d } = world()
    await openVoice(d, 'codex-p')
    await closeVoice(d, 'codex-p')
    const second = await openVoice(d, 'codex-p')
    let seen: ReturnType<typeof voiceStatus> | undefined
    const ctl = d.control
    d.control = async args => {
      const r = await ctl(args)
      if (args[0] === 'stop') seen = voiceStatus(d, 'codex-p') // helper gone, final write not yet done
      return r
    }
    await closeVoice(d, 'codex-p', 'idle')
    expect(seen).toMatchObject({ state: 'closed', session: second.session, reason: 'idle' })
    expect(w.hosts).toBe(0)
  })
  test('hung open → cleanup via /voice stop, receipt closed (timeout is never reported as closed by itself)', async () => {
    const { w, d } = world({ onOpen: 'hang' })
    const r = await openVoice(d, 'codex-p')
    expect(r.ok).toBe(false)
    expect(r.state).toBe('closed')
    expect(w.typed).toEqual([['open'], ['stop']])
    expect(w.hosts).toBe(0)
  })
  test('helper that will not die → closing, not closed', async () => {
    const { w, d } = world({ onOpen: 'hang' })
    d.control = async args => {
      w.typed.push(args)
      if (args[0] === 'open') w.hosts = 1
      return { ok: true }
    }
    const r = await openVoice(d, 'codex-p')
    expect(r).toMatchObject({ ok: false, state: 'closing' })
    expect(voiceStatus(d, 'codex-p').state).toBe('closing')
  })
  test('a held lock from a live process blocks instead of typing a second toggle', async () => {
    const { w, d } = world()
    require('node:fs').mkdirSync(d.stateDir, { recursive: true })
    writeFileSync(join(d.stateDir, 'codex-p.lock'), String(process.ppid))
    const r = await openVoice(d, 'codex-p')
    expect(r.ok).toBe(false)
    expect(w.typed).toEqual([])
  })
  test('a lock left by a dead process is stolen', async () => {
    const { d } = world()
    require('node:fs').mkdirSync(d.stateDir, { recursive: true })
    writeFileSync(join(d.stateDir, 'codex-p.lock'), '999999')
    expect((await openVoice(d, 'codex-p')).ok).toBe(true)
  })
  test('not live → refused, nothing typed', async () => {
    const { w, d } = world()
    d.procTable = () => []
    expect(await openVoice(d, 'codex-p')).toMatchObject({ ok: false, state: 'closed' })
    expect(w.typed).toEqual([])
  })
})

describe('voiceSweep', () => {
  test('idle after the conversation → closes with reason idle', async () => {
    const { w, d } = world()
    d.idleSecs = 90
    await openVoice(d, 'codex-p')
    w.lines.push(seg(w.now, 'user'), seg(w.now + 1000, 'assistant'))
    w.now += 30_000
    expect(await voiceSweep(d, ['codex-p'])).toEqual([])
    w.now += 61_500
    expect(await voiceSweep(d, ['codex-p'])).toEqual([{ identity: 'codex-p', action: 'idle-closed' }])
    expect(w.hosts).toBe(0)
    expect(voiceStatus(d, 'codex-p')).toMatchObject({ state: 'closed', reason: 'idle' })
  })
  test('waiting for requested work is not idle', async () => {
    const { w, d } = world()
    d.idleSecs = 90
    await openVoice(d, 'codex-p')
    w.lines.push(task(w.now, 'task_started'))
    w.now += 600_000
    expect(await voiceSweep(d, ['codex-p'])).toEqual([])
    expect(w.hosts).toBe(1)
  })
  test('a close that happened outside iapeer is recorded (user), sessions we did not open are ignored', async () => {
    const { w, d } = world()
    await openVoice(d, 'codex-p')
    w.now += 1000
    w.hosts = 0
    w.lines.push(closed(w.now, 'cx'))
    expect(await voiceSweep(d, ['codex-p', 'codex-other'])).toEqual([{ identity: 'codex-p', action: 'recorded-user' }])
    expect(readIntent(d, 'codex-p')?.lastClose?.reason).toBe('user')
  })
})
