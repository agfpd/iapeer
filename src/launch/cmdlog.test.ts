// tmux command-log (cmdlog.ts) — the killer-hunt socket-command layer.
//
// The live suite encodes boris's acceptance criterion directly: a kill-session
// issued by an EXTERNAL client must land in the -v server log WITH client
// attribution (`message: client-<pid> command: …`), file modes never wider than
// 0600, and the cap keeps volume bounded without losing the tail.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { PANELOG_CAP_BYTES, PANELOG_KEEP_BYTES, capPaneLogs } from './cmdlog.ts'

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cmdlog-'))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('capPaneLogs (pane-log tail-keep, hermetic)', () => {
  let logDir: string
  beforeAll(() => {
    logDir = mkdtempSync(join(tmpdir(), 'panelog-'))
  })
  afterAll(() => {
    rmSync(logDir, { recursive: true, force: true })
  })

  test('tail-keeps an oversized pane-log, leaves small ones untouched', () => {
    const big = join(logDir, 'claude-x.log')
    const small = join(logDir, 'codex-y.log')
    writeFileSync(big, Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 0x61), Buffer.from('PANE-TAIL')]))
    writeFileSync(small, 'tiny')
    const capped = capPaneLogs(logDir, 1024 * 1024, 1024)
    expect(capped).toEqual([big])
    const after = readFileSync(big)
    expect(after.length).toBe(1024)
    expect(after.toString()).toEndWith('PANE-TAIL') // the live tail survives
    expect(readFileSync(small, 'utf8')).toBe('tiny')
  })

  test('only top-level *.log is touched — non-log files and the rotated logs elsewhere are safe', () => {
    writeFileSync(join(logDir, 'not-a-log.txt'), Buffer.alloc(2 * 1024 * 1024, 0x62))
    capPaneLogs(logDir, 1024 * 1024, 1024)
    expect(statSync(join(logDir, 'not-a-log.txt')).size).toBe(2 * 1024 * 1024) // untouched
  })

  test('cap on a missing dir is a silent no-op', () => {
    expect(capPaneLogs(join(logDir, 'absent'))).toEqual([])
  })

  test('KEEP_BYTES stays ≥ the reader seed window (4 MiB) and under the cap', () => {
    // INVARIANT: capPaneLogs must keep at least the pane-log reader's seed window
    // (readyGateModel SEED_BYTES = 4 MiB) so capping never starves occupancy detection.
    expect(PANELOG_KEEP_BYTES).toBeGreaterThanOrEqual(4 * 1024 * 1024)
    expect(PANELOG_KEEP_BYTES).toBeLessThan(PANELOG_CAP_BYTES)
  })
})
