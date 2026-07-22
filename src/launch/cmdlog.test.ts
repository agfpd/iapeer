// tmux command-log (cmdlog.ts) — the killer-hunt socket-command layer.
//
// The live suite encodes boris's acceptance criterion directly: a kill-session
// issued by an EXTERNAL client must land in the -v server log WITH client
// attribution (`message: client-<pid> command: …`), file modes never wider than
// 0600, and the cap keeps volume bounded without losing the tail.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import {
  PANELOG_MAX_BYTES,
  PANELOG_TAIL_BYTES,
  PANELOG_COPIES,
  PANELOG_DIR_BUDGET_BYTES,
  PANELOG_STALE_MS,
  capPaneLogs,
  gcPaneLogs,
  paneLogGcConfig,
  paneLogRotateConfig,
} from './cmdlog.ts'

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cmdlog-'))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('capPaneLogs (pane-log copytruncate rotation, hermetic)', () => {
  let logDir: string
  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'panelog-'))
  })
  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true })
  })
  const MB = 1024 * 1024

  test('rotates an oversized pane-log: base tail-kept IN PLACE (inode preserved) + a bounded .1 copy; small ones untouched', () => {
    const big = join(logDir, 'claude-x.log')
    const small = join(logDir, 'codex-y.log')
    writeFileSync(big, Buffer.concat([Buffer.alloc(2 * MB, 0x61), Buffer.from('PANE-TAIL')]))
    writeFileSync(small, 'tiny')
    const inoBefore = statSync(big).ino
    const rotated = capPaneLogs(logDir, MB, 2, 1024) // maxBytes 1 MiB, 2 copies, tail 1024 B
    expect(rotated).toEqual([big])
    const base = readFileSync(big)
    expect(base.length).toBe(1024) // base truncated to the tail floor
    expect(base.toString()).toEndWith('PANE-TAIL') // the live tail survives on the base path
    // COPYTRUNCATE invariant: the base keeps its INODE so the supervisor's live O_APPEND fd
    // and telegram-runtime's mtime-occupancy on the fixed path are never disturbed.
    expect(statSync(big).ino).toBe(inoBefore)
    const copy1 = readFileSync(join(logDir, 'claude-x.log.1'))
    expect(copy1.length).toBeLessThanOrEqual(2 * MB) // bounded by cap-floor (maxBytes ⌈ tail+1 MiB)
    expect(copy1.toString()).toEndWith('PANE-TAIL') // .1 holds the promoted snapshot
    expect(readFileSync(small, 'utf8')).toBe('tiny')
  })

  test('keeps at most `copies` rotated files — shifts .1→.2 and drops the oldest', () => {
    const f = join(logDir, 'claude-z.log')
    const rotateGen = (marker: string) => {
      writeFileSync(f, Buffer.concat([Buffer.alloc(2 * MB, 0x63), Buffer.from(marker)]))
      capPaneLogs(logDir, MB, 2, 1024) // 2 copies
    }
    rotateGen('GEN1')
    rotateGen('GEN2')
    rotateGen('GEN3')
    expect(existsSync(`${f}.1`)).toBe(true)
    expect(existsSync(`${f}.2`)).toBe(true)
    expect(existsSync(`${f}.3`)).toBe(false) // copies=2 → oldest dropped
    expect(readFileSync(`${f}.1`).toString()).toEndWith('GEN3') // newest
    expect(readFileSync(`${f}.2`).toString()).toEndWith('GEN2') // shifted
  })

  test('total footprint is bounded by maxBytes × (copies+1) across repeated rotations', () => {
    const f = join(logDir, 'claude-w.log')
    for (let i = 0; i < 6; i++) {
      writeFileSync(f, Buffer.alloc(2 * MB, 0x64))
      capPaneLogs(logDir, MB, 2, 1024)
    }
    const total = readdirSync(logDir).reduce((s, n) => s + statSync(join(logDir, n)).size, 0)
    // base(tail) + .1 + .2, each ≤ cap(=2 MiB after floor) → well under maxBytes×(copies+1) headroom
    expect(total).toBeLessThanOrEqual(3 * (2 * MB))
  })

  test('rotated copies (.log.1/.2) are never re-processed (only top-level *.log); non-log + missing dir safe', () => {
    writeFileSync(join(logDir, 'not-a-log.txt'), Buffer.alloc(2 * MB, 0x62))
    const f = join(logDir, 'claude-x.log')
    writeFileSync(f, Buffer.alloc(2 * MB, 0x61))
    capPaneLogs(logDir, MB, 2, 1024)
    const c1size = statSync(`${f}.1`).size
    capPaneLogs(logDir, MB, 2, 1024) // second pass: base is now tiny → nothing rotates; .1 untouched
    expect(statSync(`${f}.1`).size).toBe(c1size) // .log.1 not re-rotated
    expect(statSync(join(logDir, 'not-a-log.txt')).size).toBe(2 * MB) // non-.log untouched
    expect(capPaneLogs(join(logDir, 'absent'))).toEqual([])
  })

  test('paneLogRotateConfig reads env with defaults + floors maxBytes above the reader tail', () => {
    expect(paneLogRotateConfig({})).toEqual({ maxBytes: PANELOG_MAX_BYTES, copies: PANELOG_COPIES })
    expect(paneLogRotateConfig({ IAPEER_PANELOG_MAX_BYTES: String(12 * MB), IAPEER_PANELOG_KEEP: '3' })).toEqual({
      maxBytes: 12 * MB,
      copies: 3,
    })
    // a maxBytes below the reader-tail floor is clamped up (base must be able to drop below it)
    expect(paneLogRotateConfig({ IAPEER_PANELOG_MAX_BYTES: '1024' }).maxBytes).toBe(PANELOG_TAIL_BYTES + MB)
  })

  test('TAIL_BYTES stays ≥ the reader seed window (4 MiB) and under the rotate threshold', () => {
    // INVARIANT: the base tail kept after a rotation must cover the pane-log reader's seed
    // window (readyGateModel SEED_BYTES = 4 MiB) so rotation never starves occupancy detection.
    expect(PANELOG_TAIL_BYTES).toBeGreaterThanOrEqual(4 * 1024 * 1024)
    expect(PANELOG_TAIL_BYTES).toBeLessThan(PANELOG_MAX_BYTES)
  })

  // ── RETENTION (gcPaneLogs): the directory-level bound on top of the per-file rotation ──

  const NOW = 1_800_000_000_000 // fixed clock — retention must never depend on the wall clock
  const DAY = 24 * 60 * 60 * 1000
  /** Write a pane-log artifact of `size` bytes with an explicit mtime `ageDays` in the past. */
  const artifact = (name: string, size: number, ageDays: number): string => {
    const p = join(logDir, name)
    writeFileSync(p, Buffer.alloc(size, 0x61))
    const t = new Date(NOW - ageDays * DAY)
    utimesSync(p, t, t)
    return p
  }

  test('AGE retention reclaims artifacts of dead/removed peers (base + copies), fresh ones survive', () => {
    const dead = artifact('claude-gone.log', 4096, 40) // peer removed weeks ago
    const deadCopy = artifact('claude-gone.log.1', 4096, 40)
    const warm = artifact('claude-live.log', 4096, 0.1) // warm session — minutes old
    const recentCopy = artifact('claude-live.log.1', 4096, 3)
    const foreign = artifact('not-a-log.txt', 4096, 99) // never ours → never touched

    const r = gcPaneLogs(logDir, { budgetBytes: 10 * MB, staleMs: 14 * DAY, nowMs: NOW })

    expect(r.reapedStale).toBe(2)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(deadCopy)).toBe(false)
    expect(existsSync(warm)).toBe(true)
    expect(existsSync(recentCopy)).toBe(true)
    expect(existsSync(foreign)).toBe(true) // foreign files are outside the janitor's scope
    expect(r.overBudget).toBe(false)
    expect(r.bytesAfter).toBe(2 * 4096) // foreign file is not counted either
  })

  test('BUDGET drops rotated copies OLDEST first and stops at the budget; live bases untouched', () => {
    const base = artifact('claude-a.log', 3 * MB, 0.1)
    const oldest = artifact('claude-a.log.2', 3 * MB, 5)
    const newer = artifact('claude-a.log.1', 3 * MB, 1)

    const r = gcPaneLogs(logDir, { budgetBytes: 7 * MB, staleMs: 14 * DAY, nowMs: NOW })

    expect(r.droppedCopies).toBe(1)
    expect(existsSync(oldest)).toBe(false) // oldest history is the first casualty
    expect(existsSync(newer)).toBe(true) // …and it stops as soon as the budget is met
    expect(statSync(base).size).toBe(3 * MB) // the live base is never a budget casualty while copies remain
    expect(r.shrunkBases).toBe(0)
    expect(r.bytesAfter).toBeLessThanOrEqual(7 * MB)
    expect(r.overBudget).toBe(false)
  })

  test('BUDGET backstop shrinks the largest base to the reader-floor — tail kept, inode + MTIME preserved', () => {
    const big = join(logDir, 'claude-big.log')
    writeFileSync(big, Buffer.concat([Buffer.alloc(4 * MB, 0x61), Buffer.from('PANE-TAIL')]))
    const mt = new Date(NOW - 2 * DAY)
    utimesSync(big, mt, mt)
    const inoBefore = statSync(big).ino
    artifact('claude-small.log', 512, 0.1)

    // No copies to drop → the backstop is the only lever.
    const r = gcPaneLogs(logDir, { budgetBytes: MB, staleMs: 14 * DAY, tailBytes: 64 * 1024, nowMs: NOW })

    expect(r.droppedCopies).toBe(0)
    expect(r.shrunkBases).toBe(1)
    const after = readFileSync(big)
    expect(after.length).toBe(64 * 1024) // shrunk to the reader-floor…
    expect(after.toString()).toEndWith('PANE-TAIL') // …keeping the LIVE tail readers seed from
    expect(statSync(big).ino).toBe(inoBefore) // same inode → supervisor's O_APPEND fd survives
    // A janitor write must NOT masquerade as peer activity (mtime-occupancy contract).
    expect(Math.round(statSync(big).mtimeMs)).toBe(Math.round(mt.getTime()))
    expect(r.overBudget).toBe(false)
  })

  test('reports overBudget when the reader-floor outranks the budget (honest boundary, no starving)', () => {
    // Two bases that cannot go below the floor: floor(2 × 64 KiB) > budget(64 KiB).
    artifact('claude-a.log', MB, 0.1)
    artifact('claude-b.log', MB, 0.1)
    const r = gcPaneLogs(logDir, { budgetBytes: 64 * 1024, staleMs: 14 * DAY, tailBytes: 64 * 1024, nowMs: NOW })
    expect(r.shrunkBases).toBe(2)
    expect(r.bytesAfter).toBe(2 * 64 * 1024) // floored at the seed window, NOT truncated below it
    expect(r.overBudget).toBe(true) // surfaced, not silently violated
  })

  test('is idempotent and a no-op in steady state (runs every tick, needs no manual step)', () => {
    artifact('claude-a.log', 512, 0.1)
    artifact('claude-a.log.1', 512, 1)
    const opts = { budgetBytes: 10 * MB, staleMs: 14 * DAY, nowMs: NOW }
    const first = gcPaneLogs(logDir, opts)
    const second = gcPaneLogs(logDir, opts)
    for (const r of [first, second]) {
      expect([r.reapedStale, r.droppedCopies, r.shrunkBases, r.overBudget]).toEqual([0, 0, 0, false])
    }
    expect(second.bytesAfter).toBe(first.bytesAfter)
    expect(gcPaneLogs(join(logDir, 'absent')).bytesBefore).toBe(0) // missing dir → clean no-op
  })

  test('paneLogGcConfig reads env with defaults', () => {
    expect(paneLogGcConfig({})).toEqual({ budgetBytes: PANELOG_DIR_BUDGET_BYTES, staleMs: PANELOG_STALE_MS })
    expect(paneLogGcConfig({ IAPEER_PANELOG_DIR_BUDGET: String(64 * MB), IAPEER_PANELOG_STALE_DAYS: '3' })).toEqual({
      budgetBytes: 64 * MB,
      staleMs: 3 * DAY,
    })
    // garbage → defaults (a typo'd knob must never disable retention or nuke the fleet's logs)
    expect(paneLogGcConfig({ IAPEER_PANELOG_DIR_BUDGET: 'x', IAPEER_PANELOG_STALE_DAYS: '-1' })).toEqual({
      budgetBytes: PANELOG_DIR_BUDGET_BYTES,
      staleMs: PANELOG_STALE_MS,
    })
  })

  test('the default budget leaves room for the concurrently-warm fleet at the reader-floor', () => {
    // The budget is only authoritative while live-identities × TAIL_BYTES fits under it.
    // Guard the headroom the default was sized for (~64 warm identities).
    expect(Math.floor(PANELOG_DIR_BUDGET_BYTES / PANELOG_TAIL_BYTES)).toBeGreaterThanOrEqual(48)
    expect(PANELOG_DIR_BUDGET_BYTES).toBeGreaterThan(PANELOG_MAX_BYTES * PANELOG_COPIES)
  })
})
