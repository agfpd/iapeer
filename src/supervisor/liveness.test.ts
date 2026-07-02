// Б4b — supervisor liveness/kill hardening: pid-ownership token (В22) + bring-up-timeout orphan kill (В20).
// The invariant boris verifies live: a REUSED pid must never (a) read as our live session or (b) get
// SIGTERM'd as if it were; and a timed-out bring-up must not leave a bare-conduit orphan running.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pidPath, pidStartToken, readPidFile, sockPath, writePidFile } from './paths.ts'
import { sessionAlive } from './client.ts'
import { killSession, startSupervisorDaemon } from './index.ts'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const pidAlive = (p: number): boolean => {
  try {
    process.kill(p, 0)
    return true
  } catch {
    return false
  }
}
const STALE_TOKEN = 'Wed Jan  1 00:00:00 2020' // a start time no live process could have → simulates a reused pid

const dirs: string[] = []
const procs: ChildProcess[] = []
const mkTmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-live-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const p of procs.splice(0)) try { p.kill('SIGKILL') } catch { /* */ }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('В22 pid-ownership token', () => {
  test('writePidFile/readPidFile round-trips `<pid> <token>`; legacy bare-pid → empty token', () => {
    const dir = mkTmp()
    writePidFile(dir, 's', process.pid)
    expect(readPidFile(dir, 's')).toEqual({ pid: process.pid, token: pidStartToken(process.pid)! })
    writeFileSync(pidPath(dir, 'legacy'), String(process.pid))
    expect(readPidFile(dir, 'legacy')).toEqual({ pid: process.pid, token: '' })
  })

  test('sessionAlive: matching token → alive; MISMATCHED token (reused pid) → NOT alive; legacy → alive', () => {
    const dir = mkTmp()
    writePidFile(dir, 'ok', process.pid) // correct token for this live pid
    expect(sessionAlive(dir, 'ok')).toBe(true)
    writeFileSync(pidPath(dir, 'reused'), `${process.pid} ${STALE_TOKEN}`) // live pid, WRONG token
    expect(sessionAlive(dir, 'reused')).toBe(false)
    writeFileSync(pidPath(dir, 'legacy'), String(process.pid)) // tokenless → kill-0 only
    expect(sessionAlive(dir, 'legacy')).toBe(true)
    expect(sessionAlive(dir, 'absent')).toBe(false) // no pidfile
  })

  test('killSession REFUSES to SIGTERM a reused pid (token mismatch) — the innocent process survives', async () => {
    const dir = mkTmp()
    const innocent = spawn('sleep', ['300'])
    procs.push(innocent)
    await sleep(120)
    expect(pidAlive(innocent.pid!)).toBe(true)
    // the pidfile claims this pid is our session, but the token is wrong → a reused pid
    writeFileSync(pidPath(dir, 'x'), `${innocent.pid} ${STALE_TOKEN}`)
    expect(killSession(dir, 'x')).toBe(false) // refused — not our session
    await sleep(150)
    expect(pidAlive(innocent.pid!)).toBe(true) // NEVER signalled — a live fleet session was not cut
  })

  test('killSession DOES signal when the token matches (our real session)', async () => {
    const dir = mkTmp()
    const ours = spawn('sleep', ['300'])
    procs.push(ours)
    await sleep(120)
    writePidFile(dir, 'y', ours.pid!) // correct token for this pid
    expect(killSession(dir, 'y')).toBe(true) // owned → SIGTERM sent
    await sleep(200)
    expect(pidAlive(ours.pid!)).toBe(false) // the owned process was terminated
  })
})

describe('В20 bring-up-timeout orphan kill', () => {
  test('a bring-up that never comes up KILLS the spawned child and cleans stale state (no bare conduit)', async () => {
    const dir = mkTmp()
    const cap = join(dir, 'childpid')
    // a "daemon" that records its pid then sleeps forever, NEVER creating the sock → bring-up times out.
    // `exec` replaces the shell so the recorded pid IS the direct child startSupervisorDaemon kills.
    const r = await startSupervisorDaemon({
      session: 'orphan',
      runtime: 'tick',
      runDir: dir,
      timeoutMs: 400,
      daemonArgv: ['sh', '-c', `echo $$ > ${cap}; exec sleep 30`],
    })
    expect(r.state).toBe('failed')
    const childPid = Number(readFileSync(cap, 'utf8').trim())
    expect(childPid).toBeGreaterThan(0)
    await sleep(200)
    expect(pidAlive(childPid)).toBe(false) // В20 — the orphan child was killed, not left running as a conduit
    expect(existsSync(sockPath(dir, 'orphan'))).toBe(false) // stale sock/pid cleaned
    expect(existsSync(pidPath(dir, 'orphan'))).toBe(false)
  })
})
