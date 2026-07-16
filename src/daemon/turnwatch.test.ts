import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ActivityBoard,
  parseClaudeTurn,
  parseCodexTurn,
  resolveTurnWatchPaths,
  scanTurnStates,
  turnWatchTick,
  TURN_STALE_MS,
} from './turnwatch.ts'
import { turnsLogPath } from './turnslog.ts'

const CWD = '/Users/x/Projects/thing'
const T = '2026-07-16T07:00:00.000Z'
const TMS = Date.parse(T)

// ── claude fixtures: the real line shapes, as measured on this host ──────────
function claudeAssistant(stopReason: string | null, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    cwd: CWD,
    timestamp: T,
    message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: stopReason },
    ...over,
  })
}
function claudeUser(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    cwd: CWD,
    timestamp: T,
    message: { role: 'user', content: 'hi' },
    ...over,
  })
}

describe('parseClaudeTurn', () => {
  test('tool_use is the ONLY stop_reason that continues a turn', () => {
    expect(parseClaudeTurn(claudeAssistant('tool_use'))).toMatchObject({ state: 'working', atMs: TMS, cwd: CWD })
  })

  // Measured over every transcript on this host: tool_use / end_turn / stop_sequence / null.
  // The polarity is deliberately asymmetric — anything that is not tool_use ended the turn.
  test.each(['end_turn', 'stop_sequence', 'max_tokens', 'refusal', 'some_future_reason'])(
    'stop_reason %s reads idle',
    reason => {
      expect(parseClaudeTurn(claudeAssistant(reason))?.state).toBe('idle')
    },
  )

  test('a null stop_reason never invents work', () => {
    expect(parseClaudeTurn(claudeAssistant(null))?.state).toBe('idle')
  })

  test('a real user line means working — the model is on the hook', () => {
    expect(parseClaudeTurn(claudeUser())?.state).toBe('working')
  })

  test('the LAST qualifying line wins', () => {
    const text = [claudeAssistant('tool_use'), claudeUser(), claudeAssistant('end_turn')].join('\n')
    expect(parseClaudeTurn(text)?.state).toBe('idle')
  })

  // ── the three measured false-working traps ────────────────────────────────
  test('TRAP 1: a compaction summary is type:user and must NOT read as working', () => {
    // /compact while idle: the summary would otherwise be the last line → phantom working.
    const text = [claudeAssistant('end_turn'), claudeUser({ isCompactSummary: true })].join('\n')
    expect(parseClaudeTurn(text)?.state).toBe('idle')
  })

  test('TRAP 1b: excluding the summary is also correct MID-turn', () => {
    // Compaction fired inside a running turn → the prior tool_use still decides.
    const text = [claudeAssistant('tool_use'), claudeUser({ isCompactSummary: true })].join('\n')
    expect(parseClaudeTurn(text)?.state).toBe('working')
  })

  test('TRAP 2: a sub-agent sidechain never decides the peer turn state', () => {
    const text = [claudeAssistant('end_turn'), claudeAssistant('tool_use', { isSidechain: true })].join('\n')
    expect(parseClaudeTurn(text)?.state).toBe('idle')
  })

  test('TRAP 3: an injected meta line is not the model being asked anything', () => {
    const text = [claudeAssistant('end_turn'), claudeUser({ isMeta: true })].join('\n')
    expect(parseClaudeTurn(text)?.state).toBe('idle')
  })

  test('a compact_boundary system line never qualifies', () => {
    const text = [claudeAssistant('end_turn'), JSON.stringify({ type: 'system', subtype: 'compact_boundary', cwd: CWD, timestamp: T })].join('\n')
    expect(parseClaudeTurn(text)?.state).toBe('idle')
  })

  test('no cwd → unattributable → null rather than a guess', () => {
    expect(parseClaudeTurn(JSON.stringify({ type: 'assistant', timestamp: T, message: { stop_reason: 'tool_use' } }))).toBeNull()
  })

  test('a garbled line never fails the parse', () => {
    expect(parseClaudeTurn(['{not json', claudeAssistant('tool_use')].join('\n'))?.state).toBe('working')
  })

  test('nothing usable → null', () => {
    expect(parseClaudeTurn('')).toBeNull()
    expect(parseClaudeTurn('{"type":"summary"}')).toBeNull()
  })
})

// ── codex fixtures ──────────────────────────────────────────────────────────
const codexMeta = JSON.stringify({ type: 'session_meta', payload: { cwd: CWD, session_id: 's1' } })
function codexEvent(type: string, ts = T): string {
  return JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type } })
}

describe('parseCodexTurn', () => {
  test('task_started → working, task_complete → idle, last wins', () => {
    expect(parseCodexTurn([codexMeta, codexEvent('task_started')].join('\n'))).toMatchObject({ state: 'working', cwd: CWD })
    expect(parseCodexTurn([codexMeta, codexEvent('task_started'), codexEvent('task_complete', '2026-07-16T07:00:05.000Z')].join('\n'))?.state).toBe('idle')
  })

  test('cwd is read from the HEAD when the tail cut session_meta away', () => {
    expect(parseCodexTurn(codexEvent('task_started'), codexMeta)).toMatchObject({ state: 'working', cwd: CWD })
  })

  test('no session_meta anywhere → unattributable → null', () => {
    expect(parseCodexTurn(codexEvent('task_started'))).toBeNull()
  })

  test('unrelated event types are ignored', () => {
    expect(parseCodexTurn([codexMeta, codexEvent('token_count')].join('\n'))).toBeNull()
  })
})

describe('ActivityBoard', () => {
  test('a fresh working claim is working', () => {
    const b = new ActivityBoard()
    b.set('p', 'codex', { state: 'working', atMs: TMS, cwd: CWD })
    expect(b.get('p', 'codex', TMS + 1000)).toBe('working')
  })

  // The stale bound: live, saw it start, never saw it finish → honest "no claim".
  test('a working claim past TURN_STALE_MS decays to unknown, never a phantom working', () => {
    const b = new ActivityBoard()
    b.set('p', 'codex', { state: 'working', atMs: TMS, cwd: CWD })
    expect(b.get('p', 'codex', TMS + TURN_STALE_MS - 1)).toBe('working')
    expect(b.get('p', 'codex', TMS + TURN_STALE_MS + 1)).toBe('unknown')
  })

  test('idle NEVER decays — age proves nothing against it', () => {
    const b = new ActivityBoard()
    b.set('p', 'codex', { state: 'idle', atMs: TMS, cwd: CWD })
    expect(b.get('p', 'codex', TMS + TURN_STALE_MS * 100)).toBe('idle')
  })

  test('no evidence → undefined (the field is simply not emitted)', () => {
    expect(new ActivityBoard().get('nobody', 'codex', TMS)).toBeUndefined()
  })

  test('state is per (personality, runtime), not per peer', () => {
    const b = new ActivityBoard()
    b.set('p', 'codex', { state: 'working', atMs: TMS, cwd: CWD })
    b.set('p', 'claude', { state: 'idle', atMs: TMS, cwd: CWD })
    expect(b.get('p', 'codex', TMS)).toBe('working')
    expect(b.get('p', 'claude', TMS)).toBe('idle')
  })

  test('older evidence never rewinds a newer state', () => {
    const b = new ActivityBoard()
    b.set('p', 'codex', { state: 'idle', atMs: TMS + 5000, cwd: CWD })
    b.set('p', 'codex', { state: 'working', atMs: TMS, cwd: CWD }) // a stale re-read
    expect(b.get('p', 'codex', TMS + 5000)).toBe('idle')
  })
})

// ── the sweep over a real (temp) session tree ───────────────────────────────
function makeTree(): { root: string; claudeDir: string; codexDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'iapeer-turnwatch-'))
  const claudeDir = join(root, 'projects')
  const codexDir = join(root, 'sessions')
  mkdirSync(join(claudeDir, '-Users-x-Projects-thing'), { recursive: true })
  mkdirSync(join(codexDir, '2026', '07', '16'), { recursive: true })
  return { root, claudeDir, codexDir }
}

const peerByCwd = (c: string): string | undefined => (c === CWD ? 'thing' : undefined)

describe('scanTurnStates', () => {
  test('attributes both runtimes off their own session files', () => {
    const { root, claudeDir, codexDir } = makeTree()
    try {
      writeFileSync(join(claudeDir, '-Users-x-Projects-thing', 's.jsonl'), claudeAssistant('tool_use'))
      writeFileSync(join(codexDir, '2026', '07', '16', 'rollout-x.jsonl'), [codexMeta, codexEvent('task_complete')].join('\n'))
      const out = scanTurnStates({ claudeProjectsDir: claudeDir, codexSessionsDir: codexDir, peerByCwd }, 0)
      expect(out).toHaveLength(2)
      expect(out.find(o => o.runtime === 'claude')).toMatchObject({ personality: 'thing', state: 'working' })
      expect(out.find(o => o.runtime === 'codex')).toMatchObject({ personality: 'thing', state: 'idle' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a human's own session (cwd is no peer's) is never reported", () => {
    const { root, claudeDir, codexDir } = makeTree()
    try {
      writeFileSync(join(claudeDir, '-Users-x-Projects-thing', 's.jsonl'), claudeAssistant('tool_use'))
      const out = scanTurnStates(
        { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir, peerByCwd: () => undefined },
        0,
      )
      expect(out).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('absent roots → empty, never a throw', () => {
    expect(
      scanTurnStates({ claudeProjectsDir: '/nope/xyz', codexSessionsDir: '/nope/abc', peerByCwd }, 0),
    ).toEqual([])
  })
})

describe('turnWatchTick', () => {
  test('logs a transition ONCE, not once per sweep', () => {
    const { root, claudeDir, codexDir } = makeTree()
    const logDir = join(root, 'logs')
    mkdirSync(logDir, { recursive: true })
    try {
      const f = join(claudeDir, '-Users-x-Projects-thing', 's.jsonl')
      writeFileSync(f, claudeAssistant('tool_use'))
      const board = new ActivityBoard()
      const deps = { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir, peerByCwd, board, logDir, env: {} as NodeJS.ProcessEnv }
      const first = turnWatchTick(deps, 0)
      const second = turnWatchTick(deps, 0) // same file, same state → NOT a new event
      expect(first.transitions).toBe(1)
      expect(second.transitions).toBe(0)
      const log = readFileSync(turnsLogPath(logDir), 'utf8').trim().split('\n')
      expect(log).toHaveLength(1)
      expect(log[0]).toContain('ev=turn-started')
      expect(log[0]).toContain('personality=thing')
      expect(log[0]).toContain('runtime=claude')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a real working→idle change emits turn-ended', () => {
    const { root, claudeDir, codexDir } = makeTree()
    const logDir = join(root, 'logs')
    mkdirSync(logDir, { recursive: true })
    try {
      const f = join(claudeDir, '-Users-x-Projects-thing', 's.jsonl')
      writeFileSync(f, claudeAssistant('tool_use'))
      const board = new ActivityBoard()
      const deps = { claudeProjectsDir: claudeDir, codexSessionsDir: codexDir, peerByCwd, board, logDir, env: {} as NodeJS.ProcessEnv }
      turnWatchTick(deps, 0)
      writeFileSync(f, claudeAssistant('end_turn', { timestamp: '2026-07-16T07:00:10.000Z' }))
      const second = turnWatchTick(deps, 0)
      expect(second.transitions).toBe(1)
      expect(board.get('thing', 'claude', Date.parse('2026-07-16T07:00:10.000Z'))).toBe('idle')
      const log = readFileSync(turnsLogPath(logDir), 'utf8').trim().split('\n')
      expect(log).toHaveLength(2)
      expect(log[1]).toContain('ev=turn-ended')
      expect(log[1]).toContain('from=working')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('a falsy logDir stays hermetic (no file written)', () => {
    const { root, claudeDir, codexDir } = makeTree()
    try {
      writeFileSync(join(claudeDir, '-Users-x-Projects-thing', 's.jsonl'), claudeAssistant('tool_use'))
      const board = new ActivityBoard()
      const r = turnWatchTick({ claudeProjectsDir: claudeDir, codexSessionsDir: codexDir, peerByCwd, board }, 0)
      expect(r.transitions).toBe(1)
      expect(board.get('thing', 'claude', TMS)).toBe('working')
      expect(existsSync(turnsLogPath(root))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('resolveTurnWatchPaths', () => {
  test('honours overrides, else HOME defaults', () => {
    expect(resolveTurnWatchPaths({ IAPEER_CLAUDE_PROJECTS_DIR: '/a', IAPEER_CODEX_SESSIONS_DIR: '/b' })).toEqual({
      claudeProjectsDir: '/a',
      codexSessionsDir: '/b',
    })
    expect(resolveTurnWatchPaths({ HOME: '/Users/x' })).toEqual({
      claudeProjectsDir: '/Users/x/.claude/projects',
      codexSessionsDir: '/Users/x/.codex/sessions',
    })
  })
})
