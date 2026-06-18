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
import {
  CMDLOG_KEEP_BYTES,
  PANELOG_CAP_BYTES,
  PANELOG_KEEP_BYTES,
  capCmdLogs,
  capPaneLogs,
  cmdLogDirFor,
  hardenCmdLogDir,
  prepareCmdLogDir,
} from './cmdlog.ts'

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cmdlog-'))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('prepareCmdLogDir / hardenCmdLogDir / capCmdLogs (hermetic)', () => {
  test('prepare WIPES the previous generation and recreates 0700', () => {
    const dir = prepareCmdLogDir(root, 'claude-x')
    expect(dir).toBe(cmdLogDirFor(root, 'claude-x'))
    writeFileSync(join(dir!, 'tmux-server-1.log'), 'old generation')
    const again = prepareCmdLogDir(root, 'claude-x')
    expect(readdirSync(again!)).toEqual([]) // old log gone — one generation per dir
    expect(statSync(again!).mode & 0o777).toBe(0o700)
  })

  test('harden clamps every file to 0600', () => {
    const dir = prepareCmdLogDir(root, 'claude-h')!
    writeFileSync(join(dir, 'tmux-server-2.log'), 'x', { mode: 0o644 })
    hardenCmdLogDir(dir)
    expect(statSync(join(dir, 'tmux-server-2.log')).mode & 0o777).toBe(0o600)
  })

  test('cap tail-keeps an oversized log (KEEP bytes of TAIL survive), leaves small logs alone', () => {
    const dir = prepareCmdLogDir(root, 'claude-c')!
    const big = join(dir, 'tmux-server-3.log')
    const small = join(dir, 'tmux-server-4.log')
    // 2 MB of filler ending in a recognizable tail — cap to 1 KB keep for the test
    writeFileSync(big, Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 0x61), Buffer.from('THE-DEATH-TAIL')]))
    writeFileSync(small, 'tiny')
    const capped = capCmdLogs(root, 1024 * 1024, 1024)
    expect(capped).toEqual([big])
    const after = readFileSync(big)
    expect(after.length).toBe(1024)
    expect(after.toString()).toEndWith('THE-DEATH-TAIL') // the tail is what survives
    expect(readFileSync(small, 'utf8')).toBe('tiny')
  })

  test('cap on a missing tree is a silent no-op', () => {
    expect(capCmdLogs(join(root, 'absent'))).toEqual([])
  })

  test('default keep constant stays under the cap', () => {
    expect(CMDLOG_KEEP_BYTES).toBeLessThan(8 * 1024 * 1024)
  })
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

describe.if(tmuxAvailable)('live -v server log (acceptance criterion)', () => {
  test('external client kill-session lands in the server log with client attribution; harden → 0600', () => {
    const dir = prepareCmdLogDir(root, 'claude-live')!
    const sock = join(root, 'live.sock')
    // Start the server FROM the cmdlog dir with -v — exactly the launch wiring.
    const start = spawnSync('tmux', ['-S', sock, '-v', 'new-session', '-d', '-x', '80', '-y', '24', '-s', 'claude-live', 'sleep 60'], {
      cwd: dir,
      encoding: 'utf8',
    })
    expect(start.status).toBe(0)
    hardenCmdLogDir(dir)
    // An EXTERNAL client (separate tmux invocation = separate client pid) kills it.
    const kill = spawnSync('tmux', ['-S', sock, 'kill-session', '-t', 'claude-live'], { encoding: 'utf8' })
    expect(kill.status).toBe(0)
    const serverLog = readdirSync(dir).find(f => f.startsWith('tmux-server-'))
    expect(serverLog).toBeDefined()
    expect(statSync(join(dir, serverLog!)).mode & 0o777).toBe(0o600)
    const text = readFileSync(join(dir, serverLog!), 'utf8')
    // Attribution line: message: client-<pid> command: kill-session -t claude-live
    expect(text).toMatch(/message: client-\d+ command: kill-session -t claude-live/)
    spawnSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' })
  })
})
