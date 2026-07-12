// tmux command-log (cmdlog.ts) — the killer-hunt socket-command layer.
//
// The live suite encodes boris's acceptance criterion directly: a kill-session
// issued by an EXTERNAL client must land in the -v server log WITH client
// attribution (`message: client-<pid> command: …`), file modes never wider than
// 0600, and the cap keeps volume bounded without losing the tail.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { PANELOG_MAX_BYTES, PANELOG_TAIL_BYTES, PANELOG_COPIES, capPaneLogs, paneLogRotateConfig } from './cmdlog.ts'

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
})
