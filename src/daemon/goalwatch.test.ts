import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoticeBoard } from './notices.ts'
import {
  findVersionedDb,
  goalWatchTick,
  readGoalRows,
  readThreadCwds,
  readCurrentThreadByCwd,
  renderGoalContent,
  resolveGoalWatchPaths,
  scanStalledGoals,
  selectStalledGoals,
  STALLED_GOAL_STATUSES,
  type GoalRow,
} from './goalwatch.ts'

const T0 = 1_700_000_000_000
const THREAD = '019f6709-d41b-7d72-87cc-c2b5c8b027b5'
const CWD = '/Users/x/Projects/zapret2-oneclick'

function row(over: Partial<GoalRow> = {}): GoalRow {
  return {
    threadId: THREAD,
    goalId: 'c25d2378',
    objective: 'close B1-B8',
    status: 'blocked',
    tokensUsed: 182071,
    timeUsedSeconds: 198,
    updatedAtMs: T0 + 1000,
    ...over,
  }
}

const cwdByThread = new Map([[THREAD, CWD]])
const peerByCwd = (c: string): string | undefined => (c === CWD ? 'zapret2-oneclick' : undefined)

describe('selectStalledGoals', () => {
  test('a goal blocked after the boundary is attributed to its peer', () => {
    const out = selectStalledGoals([row()], cwdByThread, peerByCwd, T0)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      personality: 'zapret2-oneclick',
      runtime: 'codex',
      status: 'blocked',
      goalId: 'c25d2378',
      threadId: THREAD,
      atMs: T0 + 1000,
      cwd: CWD,
    })
  })

  test('usage_limited and budget_limited ride the same shape, verbatim', () => {
    for (const status of ['usage_limited', 'budget_limited']) {
      const out = selectStalledGoals([row({ status })], cwdByThread, peerByCwd, T0)
      expect(out).toHaveLength(1)
      // The status travels verbatim — it is codex's taxonomy, not ours, and `blocked` vs
      // `usage_limited` are different facts that must not collapse into one dedup identity.
      expect(out[0]?.status).toBe(status)
    }
  })

  // The acceptance criterion: a normal finished turn with no stalled goal must not notify.
  test.each(['active', 'complete', 'paused'])('status %s never notifies', status => {
    expect(selectStalledGoals([row({ status })], cwdByThread, peerByCwd, T0)).toEqual([])
  })

  test('a transition at or before the boundary is not re-reported', () => {
    expect(selectStalledGoals([row({ updatedAtMs: T0 })], cwdByThread, peerByCwd, T0)).toEqual([])
    expect(selectStalledGoals([row({ updatedAtMs: T0 - 1 })], cwdByThread, peerByCwd, T0)).toEqual([])
  })

  test('a thread absent from the state DB is ignored, not guessed', () => {
    expect(selectStalledGoals([row()], new Map(), peerByCwd, T0)).toEqual([])
  })

  test("a human's own codex thread is never notified", () => {
    const mine = new Map([[THREAD, '/Users/x/scratch']])
    expect(selectStalledGoals([row()], mine, peerByCwd, T0)).toEqual([])
  })

  // ── the fossil gate (16.07.2026) ────────────────────────────────────────────
  // thread_goals is keyed by thread_id, so an ABANDONED thread keeps its last goal row forever.
  // Measured live: a peer escaped a blocked goal the only way its own tools allowed — a fresh
  // session — leaving `blocked` on the dead thread and `active` on the live one. Reporting the
  // dead row would claim an objective is stalled while the peer is working it right now.
  test('a stalled goal on an ABANDONED thread is not reported (the peer moved on)', () => {
    const current = new Map([[CWD, 'newer-thread-id']]) // the peer's current thread is NOT ours
    expect(selectStalledGoals([row()], cwdByThread, peerByCwd, T0, current)).toEqual([])
  })

  test('a stalled goal on the peer CURRENT thread is still reported', () => {
    const current = new Map([[CWD, THREAD]])
    expect(selectStalledGoals([row()], cwdByThread, peerByCwd, T0, current)).toHaveLength(1)
  })

  test('no known current thread for the cwd → nothing claimed', () => {
    expect(selectStalledGoals([row()], cwdByThread, peerByCwd, T0, new Map())).toEqual([])
  })

  test('objective is clipped before it can reach a notice', () => {
    const out = selectStalledGoals([row({ objective: 'x'.repeat(5000) })], cwdByThread, peerByCwd, T0)
    expect(out[0]?.objective.length).toBeLessThanOrEqual(300)
  })
})

describe('renderGoalContent', () => {
  test('states the status, the goal, the thread and the accounting', () => {
    const c = renderGoalContent({
      status: 'blocked',
      goalId: 'c25d2378',
      threadId: THREAD,
      objective: 'close B1-B8',
      tokensUsed: 182071,
      timeUsedSeconds: 198,
      atMs: T0,
      cwd: CWD,
    })
    expect(c).toContain('blocked')
    expect(c).toContain('c25d2378')
    expect(c).toContain(THREAD)
    expect(c).toContain('182071')
    expect(c).toContain('continuation has stopped')
  })
})

describe('findVersionedDb', () => {
  test('picks the HIGHEST generation — codex rolls the suffix on a schema change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iapeer-goalwatch-'))
    try {
      for (const n of [1, 2, 10]) new Database(join(dir, `goals_${n}.sqlite`)).close()
      new Database(join(dir, 'goals.sqlite')).close() // unversioned → not a candidate
      expect(findVersionedDb(dir, 'goals')).toBe(join(dir, 'goals_10.sqlite'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('absent dir / no match → null (detector no-ops rather than throwing)', () => {
    expect(findVersionedDb(join(tmpdir(), 'iapeer-does-not-exist-xyz'), 'goals')).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'iapeer-goalwatch-'))
    try {
      expect(findVersionedDb(dir, 'goals')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('resolveGoalWatchPaths', () => {
  test('honours the injected override, else HOME/.codex', () => {
    expect(resolveGoalWatchPaths({ IAPEER_CODEX_HOME: '/tmp/cx' }).codexHome).toBe('/tmp/cx')
    expect(resolveGoalWatchPaths({ HOME: '/Users/x' }).codexHome).toBe('/Users/x/.codex')
  })
})

// A real (temp) codex-shaped store: proves the SQL, the join and the guards — not just the
// pure selector. Hermetic: it builds its own DBs and never touches the live ~/.codex.
function makeCodexHome(opts: { status?: string; updatedAtMs?: number; cwd?: string; newerThread?: boolean } = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'iapeer-codexhome-'))
  const g = new Database(join(home, 'goals_1.sqlite'))
  g.run(`CREATE TABLE thread_goals (
    thread_id TEXT PRIMARY KEY NOT NULL, goal_id TEXT NOT NULL, objective TEXT NOT NULL,
    status TEXT NOT NULL, token_budget INTEGER, tokens_used INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL)`)
  g.run('INSERT INTO thread_goals VALUES (?,?,?,?,?,?,?,?,?)', [
    THREAD, 'c25d2378', 'close B1-B8', opts.status ?? 'blocked', null, 182071, 198, T0, opts.updatedAtMs ?? T0 + 1000,
  ])
  g.close()
  const s = new Database(join(home, 'state_5.sqlite'))
  s.run('CREATE TABLE threads (id TEXT PRIMARY KEY NOT NULL, cwd TEXT, recency_at_ms INTEGER, updated_at_ms INTEGER)')
  s.run('INSERT INTO threads VALUES (?,?,?,?)', [THREAD, opts.cwd ?? CWD, T0, T0])
  // The fossil shape: the peer abandoned THREAD and moved to a NEWER thread on the same cwd.
  if (opts.newerThread) s.run('INSERT INTO threads VALUES (?,?,?,?)', ['newer-thread', opts.cwd ?? CWD, T0 + 60_000, T0 + 60_000])
  s.close()
  return home
}

describe('reading codex state', () => {
  test('reads goal rows and joins threads → cwd', async () => {
    const home = makeCodexHome()
    try {
      const rows = await readGoalRows(home)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ threadId: THREAD, status: 'blocked', tokensUsed: 182071, updatedAtMs: T0 + 1000 })
      const cwds = await readThreadCwds(home, [THREAD])
      expect(cwds.get(THREAD)).toBe(CWD)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a codex home with no DBs yields nothing and does not throw', async () => {
    const home = mkdtempSync(join(tmpdir(), 'iapeer-codexhome-'))
    try {
      expect(await readGoalRows(home)).toEqual([])
      expect((await readThreadCwds(home, [THREAD])).size).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('scanStalledGoals end-to-end over a real store', async () => {
    const home = makeCodexHome()
    try {
      const out = await scanStalledGoals({ codexHome: home, peerByCwd }, T0)
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({ personality: 'zapret2-oneclick', status: 'blocked', threadId: THREAD })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('FOSSIL: a blocked goal on an abandoned thread is silent end-to-end', async () => {
    const home = makeCodexHome({ newerThread: true })
    try {
      expect(await scanStalledGoals({ codexHome: home, peerByCwd }, T0)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('readCurrentThreadByCwd picks the NEWEST thread per cwd', async () => {
    const home = makeCodexHome({ newerThread: true })
    try {
      expect((await readCurrentThreadByCwd(home, [CWD])).get(CWD)).toBe('newer-thread')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('an active goal over a real store is silent', async () => {
    const home = makeCodexHome({ status: 'active' })
    try {
      expect(await scanStalledGoals({ codexHome: home, peerByCwd }, T0)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('goalWatchTick', () => {
  test('raises ONE notice carrying peer/runtime/goal/status', async () => {
    const home = makeCodexHome()
    try {
      const board = new NoticeBoard({ now: () => T0 + 5000 })
      const r = await goalWatchTick({ codexHome: home, peerByCwd, board, now: () => T0 + 5000 }, T0)
      expect(r.raised).toBe(1)
      const [n] = board.list(T0 + 5000)
      expect(n).toMatchObject({
        personality: 'zapret2-oneclick',
        runtime: 'codex',
        kind: 'peer-goal-stalled',
        errorType: 'blocked',
        sessionId: THREAD,
        eventAtMs: T0 + 1000,
        count: 1,
      })
      expect(n?.summary).toContain('goal blocked')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  // The frozen-row property: a blocked goal is never re-accounted, so a re-read of the SAME
  // transition must not inflate count. Proven live: counters frozen through later turns.
  test('the overlapping sweep re-reading the same transition does not inflate count', async () => {
    const home = makeCodexHome()
    try {
      const board = new NoticeBoard({ now: () => T0 + 5000 })
      const deps = { codexHome: home, peerByCwd, board, now: () => T0 + 5000 }
      const first = await goalWatchTick(deps, T0)
      // Sweep again from the boundary the first tick returned — the overlap re-reads the row.
      const second = await goalWatchTick(deps, first.sinceMs)
      expect(first.raised).toBe(1)
      expect(second.raised).toBe(0)
      expect(board.list(T0 + 5000)).toHaveLength(1)
      expect(board.list(T0 + 5000)[0]?.count).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a broken codex home is reported, never thrown', async () => {
    const board = new NoticeBoard({ now: () => T0 })
    const r = await goalWatchTick(
      { codexHome: join(tmpdir(), 'iapeer-nope-xyz'), peerByCwd, board, now: () => T0 },
      T0 - 60_000,
    )
    expect(r.raised).toBe(0)
    expect(board.size(T0)).toBe(0)
  })
})

describe('STALLED_GOAL_STATUSES', () => {
  test('is exactly the unfinished-and-not-continuing set', () => {
    expect([...STALLED_GOAL_STATUSES].sort()).toEqual(['blocked', 'budget_limited', 'usage_limited'])
  })
})
