import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSupervisorDaemon, killSession, sessionAlive } from '../supervisor/index.ts'
import { backfillHostReady, hostRunDir, hostSessionReady } from './ptyHost.ts'
import { getAdapter, launch } from './index.ts'

test('legacy migration proves THIS emulator; stale shared log cannot make a pre-main hang ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'iap-ready-'))
  const env = { ...process.env, HOME: root, IAPEER_ROOT: root }
  const runDir = hostRunDir(env)
  const ids = ['codex-hung', 'codex-painted']
  const paneLog = join(root, 'old.log')
  writeFileSync(paneLog, '› stale ready from a previous hosting\r\n')
  try {
    for (const id of ids) {
      const r = await startSupervisorDaemon({ session: id, runtime: 'codex', runDir,
        serve: { argv: id.endsWith('hung') ? ['/bin/sleep', '600'] : ['/bin/sh', '-c', "printf '\r\n› ready\r\n'; exec sleep 600"], env: {}, cwd: root, paneLogPath: paneLog } })
      expect(r.state).toBe('started')
    }
    await Bun.sleep(100)
    expect(sessionAlive(runDir, ids[0]!)).toBe(true)
    expect(hostSessionReady(ids[0]!, env)).toBe(false)
    expect(await backfillHostReady(env)).toEqual(['codex-painted'])
    expect(hostSessionReady(ids[0]!, env)).toBe(false)
    expect(hostSessionReady(ids[1]!, env)).toBe(true)
    const pid = join(runDir, 'codex-painted.pid')
    const original = readFileSync(pid, 'utf8')
    writeFileSync(pid, String(process.pid)) // another live hosting token cannot inherit readiness
    expect(hostSessionReady(ids[1]!, env)).toBe(false)
    writeFileSync(pid, original)
  } finally {
    for (const id of ids) killSession(runDir, id, { reason: 'readiness-test-cleanup' })
    await Bun.sleep(300)
    rmSync(root, { recursive: true, force: true })
  }
}, 10000)

test('native bring-up timeout tears down the live supervisor, not just returns FAILED', async () => {
  const root = mkdtempSync(join(tmpdir(), 'iap-boot-timeout-'))
  const env = { ...process.env, HOME: root, IAPEER_ROOT: root }
  const runDir = hostRunDir(env)
  const shim = join(root, 'hang')
  writeFileSync(shim, '#!/bin/sh\nexec /bin/sleep 600\n', { mode: 0o700 })
  const identity = 'codex-timeout'
  try {
    const result = await launch({ identity, runtime: 'codex', personality: 'timeout', cwd: root, intelligence: 'artificial', socketPath: join(root, 'unused.sock'), resume: false }, getAdapter('codex'), 'MUST NOT BE ACKED', {
      env, codexBin: shim, claudeBin: 'claude', sockDir: root, logDir: root, bootDeadlineSecs: 1, readyGateSecs: 1,
    })
    expect(result.status).toBe('FAILED')
    expect(result.reason).toContain('never-became-ready')
    await Bun.sleep(300)
    expect(sessionAlive(runDir, identity)).toBe(false)
    expect(hostSessionReady(identity, env)).toBe(false)
  } finally {
    killSession(runDir, identity, { reason: 'readiness-test-cleanup' })
    await Bun.sleep(200)
    rmSync(root, { recursive: true, force: true })
  }
}, 10000)
