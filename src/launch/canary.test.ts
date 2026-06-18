// Server-death canary — pure script-builder shape + live-tmux behavior:
// dirty server death (SIGKILL) → ev=server-exit line + forensics snapshot;
// clean teardown (signal / killSession) → silent, no record. Live tests follow
// the suite's test.if(tmuxAvailable) sandbox-socket pattern (lifecycle.test.ts).

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  canaryChannel,
  canaryProcessPattern,
  canaryScript,
  dismissCanary,
  ensureServerCanary,
  exitLogPath,
  serverDeathsDir,
  signalCanaryClean,
} from './canary.ts'
import { killSession } from '../lifecycle/index.ts'
import { teardownAlwaysOnSession } from './launchdRun.ts'

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Poll until `cond` is true or `ms` elapsed. */
async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await sleep(100)
  }
  return cond()
}

function canaryRunning(identity: string): boolean {
  return (
    spawnSync('pgrep', ['-f', `wait-for.*${canaryChannel(identity)}([^a-z0-9-]|$)`], { stdio: 'ignore' }).status === 0
  )
}

function serverPid(sock: string): number {
  const r = spawnSync('tmux', ['-S', sock, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' })
  return Number((r.stdout ?? '').trim())
}

describe('canary script (pure)', () => {
  test('channel is per-identity', () => {
    expect(canaryChannel('claude-bob')).toBe('iap-canary-claude-bob')
  })

  test('exitLogPath → exits.log inside the dir', () => {
    expect(exitLogPath('/r/logs/iapeer')).toBe('/r/logs/iapeer/exits.log')
  })

  test('script carries the v2 protocol: wait-for channel, deliberate-silence guards, liveness probe, record line, forensics', () => {
    const s = canaryScript({
      identity: 'claude-bob',
      sock: '/tmp/x.sock',
      tmuxBin: '/opt/homebrew/bin/tmux',
      exitLogFile: '/r/logs/iapeer/exits.log',
      forensicsDir: '/r/logs/iapeer/server-deaths',
    })
    expect(s).toContain(`wait-for 'iap-canary-claude-bob'`) // the blocking client
    expect(s).toContain(`trap 'exit 0' HUP INT TERM`) // dismissed sh = silent (the ONLY deliberate silencer)
    // v2: NO exit code is trusted as deliberate (a TERMed client returns rc=0 —
    // proven live); the SERVER's liveness decides, after a dismissal grace sleep.
    expect(s).not.toContain(`[ "$rc" -eq 0 ] || [ "$rc" -ge 128 ]; then exit 0`) // the v1 hole
    expect(s).toContain('sleep 2') // dismissal grace window
    expect(s).toContain(`kill -0 "$SPID" 2>/dev/null; then exit 0`) // original server alive → nothing to record
    expect(s).toContain(`[ -z "$SPID" ]`) // fallback only when the original pid was unavailable
    expect(s).toContain('cause=server-vanished') // connection drop (SIGKILL/OOM class)
    expect(s).toContain('cause=signaled-server-gone') // rc=0: channel/client-TERM, server died
    expect(s).toContain('cause=client-killed-server-gone') // rc≥128: client took a hard kill
    expect(s).toContain('ev=server-exit identity=claude-bob') // the exits.log record
    expect(s).toContain(`>> '/r/logs/iapeer/exits.log'`)
    expect(s).toContain('/r/logs/iapeer/server-deaths/claude-bob') // forensics file
    expect(s).toContain('vm_stat') // memory evidence (OOM hypothesis)
    expect(s).toContain(`'/opt/homebrew/bin/tmux' -S '/tmp/x.sock'`) // abs tmux, quoted
    expect(s).not.toContain('cmdlog-tail') // no cmdLogDir → no cmdlog capture line
  })

  test('with cmdLogDir → forensics tail the dead server cmdlog (client-COMMAND kill attribution)', () => {
    const s = canaryScript({
      identity: 'claude-bob',
      sock: '/tmp/x.sock',
      tmuxBin: '/opt/homebrew/bin/tmux',
      exitLogFile: '/r/logs/iapeer/exits.log',
      forensicsDir: '/r/logs/iapeer/server-deaths',
      cmdLogDir: '/r/logs/iapeer/tmux-cmdlog/claude-bob',
    })
    expect(s).toContain('cmdlog-tail') // the kill-server/kill-session witness
    // tails the dead server's own -v log by its captured pid, greps the command lines
    expect(s).toContain(`'/r/logs/iapeer/tmux-cmdlog/claude-bob/tmux-server-'"$SPID"'.log'`)
    expect(s).toContain(`grep -aE 'command:'`)
  })

  test('ensureServerCanary without exitLogDir → skipped (observability off)', () => {
    expect(ensureServerCanary({ identity: 'claude-none', sock: '/tmp/none.sock' })).toBe('skipped')
  })

  test('canaryProcessPattern is identity-anchored (no prefix bleed) and matches both canary processes', () => {
    const p = canaryProcessPattern('claude-iap')
    expect(p).toBe('iap-canary-claude-iap([^a-z0-9-]|$)')
    const re = new RegExp(p)
    expect(re.test(`/opt/homebrew/bin/tmux -S /tmp/x.sock wait-for iap-canary-claude-iap`)).toBe(true) // client argv
    expect(re.test(`/bin/sh -c ... wait-for 'iap-canary-claude-iap'\n...`)).toBe(true) // sh -c script (quoted channel)
    expect(re.test(`tmux wait-for iap-canary-claude-iap-memory`)).toBe(false) // prefix identity must NOT match
  })

  test('dismissCanary is a harmless no-op when no canary runs', () => {
    expect(() => dismissCanary('claude-nobody-here')).not.toThrow()
  })
})

describe.if(tmuxAvailable)('canary live (sandbox tmux servers)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'iap-canary-'))
  const socks: string[] = []

  function bringUp(identity: string): { sock: string; logDir: string } {
    const sock = join(dir, `${identity}.sock`)
    socks.push(sock)
    const r = spawnSync('tmux', ['-S', sock, 'new-session', '-d', '-s', identity, 'sleep', '120'], {
      stdio: 'ignore',
    })
    expect(r.status).toBe(0)
    return { sock, logDir: join(dir, `logs-${identity}`) }
  }

  const allIds = [
    'claude-canadirty',
    'claude-canaclean',
    'claude-canakill',
    'notifier-canatear',
    'claude-canasweep',
    'claude-canaclient',
    'claude-canareplaced',
  ]

  afterAll(() => {
    for (const sock of socks) {
      // teardown is DELIBERATE → silence each canary (signal + dismiss) before
      // killing its server — the v2 contract for every deliberate path.
      for (const id of allIds) {
        signalCanaryClean(sock, id)
        dismissCanary(id)
      }
      spawnSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' })
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test(
    'dirty server death (SIGKILL) → ev=server-exit + forensics snapshot',
    async () => {
      const identity = 'claude-canadirty'
      const { sock, logDir } = bringUp(identity)
      const pid = serverPid(sock)
      expect(pid).toBeGreaterThan(0)

      expect(ensureServerCanary({ identity, sock, exitLogDir: logDir })).toBe('spawned')
      // idempotency: a second ensure must NOT double-spawn
      expect(await waitFor(() => canaryRunning(identity), 3000)).toBe(true)
      expect(ensureServerCanary({ identity, sock, exitLogDir: logDir })).toBe('already')
      await sleep(500) // let the wait-for client register on the channel

      process.kill(pid, 'SIGKILL') // the silent server-killer class
      const log = exitLogPath(logDir)
      expect(await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').includes('ev=server-exit'), 8000)).toBe(
        true,
      )
      const line = readFileSync(log, 'utf8')
      expect(line).toContain(`ev=server-exit identity=${identity}`)
      expect(line).toContain(`server_pid=${pid}`)
      const snaps = readdirSync(serverDeathsDir(logDir))
      expect(snaps.length).toBe(1)
      const snap = readFileSync(join(serverDeathsDir(logDir), snaps[0]!), 'utf8')
      expect(snap).toContain(`server-death identity=${identity}`)
      // canary is one-shot: after firing it must be gone
      expect(await waitFor(() => !canaryRunning(identity), 3000)).toBe(true)
    },
    20000,
  )

  test(
    'clean teardown (signal, then kill-server) → silent, no record',
    async () => {
      const identity = 'claude-canaclean'
      const { sock, logDir } = bringUp(identity)
      expect(ensureServerCanary({ identity, sock, exitLogDir: logDir })).toBe('spawned')
      expect(await waitFor(() => canaryRunning(identity), 3000)).toBe(true)
      await sleep(500) // let the wait-for client register before signaling

      signalCanaryClean(sock, identity)
      expect(await waitFor(() => !canaryRunning(identity), 3000)).toBe(true) // exited silently
      spawnSync('tmux', ['-S', sock, 'kill-server'], { stdio: 'ignore' })
      await sleep(300)
      expect(existsSync(exitLogPath(logDir)) && readFileSync(exitLogPath(logDir), 'utf8').includes('ev=server-exit')).toBe(
        false,
      )
    },
    20000,
  )

  test(
    'teardownAlwaysOnSession (signal-exit of runAlwaysOn) kills session+server, canary stays silent',
    async () => {
      const identity = 'notifier-canatear'
      const { sock, logDir } = bringUp(identity)
      expect(ensureServerCanary({ identity, sock, exitLogDir: logDir })).toBe('spawned')
      expect(await waitFor(() => canaryRunning(identity), 3000)).toBe(true)
      await sleep(500)

      teardownAlwaysOnSession(sock, identity) // the bootout/shutdown path
      // the whole server must be gone (the poller dies WITH the watcher — грабля closed)
      expect(
        await waitFor(
          () => spawnSync('tmux', ['-S', sock, 'has-session', '-t', identity], { stdio: 'ignore' }).status !== 0,
          3000,
        ),
      ).toBe(true)
      expect(await waitFor(() => !canaryRunning(identity), 3000)).toBe(true)
      await sleep(300)
      expect(existsSync(exitLogPath(logDir)) && readFileSync(exitLogPath(logDir), 'utf8').includes('ev=server-exit')).toBe(
        false,
      )
    },
    20000,
  )

  test(
    'killSession (lifecycle clean reap) signals the canary before kill-server → no record',
    async () => {
      const identity = 'claude-canakill'
      const { sock, logDir } = bringUp(identity)
      expect(ensureServerCanary({ identity, sock, exitLogDir: logDir })).toBe('spawned')
      expect(await waitFor(() => canaryRunning(identity), 3000)).toBe(true)
      await sleep(500)

      killSession(sock, identity) // last session → kills the SERVER, signal-first
      expect(await waitFor(() => !canaryRunning(identity), 3000)).toBe(true)
      await sleep(300)
      expect(existsSync(exitLogPath(logDir)) && readFileSync(exitLogPath(logDir), 'utf8').includes('ev=server-exit')).toBe(
        false,
      )
    },
    20000,
  )

  test(
    'death-#4 shape: external killer sweeps server AND canary client → ev=server-exit cause=client-signaled',
    async () => {
      const identity = 'claude-canasweep'
      const { sock, logDir } = bringUp(identity)
      const pid = serverPid(sock)
      expect(ensureServerCanary({ identity, sock, exitLogDir: logDir })).toBe('spawned')
      expect(await waitFor(() => canaryRunning(identity), 3000)).toBe(true)
      await sleep(500)

      // The pre-clean-shaped external killer: one pattern takes the server AND
      // the canary CLIENT (both argv contain `tmux -S <sock> `), the sh recorder
      // survives. The TERMed client returns rc=0 (proven live) — v1 read that as
      // a clean channel signal and stayed silent; exactly how deaths #4–#6
      // (10.06) left zero records. v2 probes the server instead: dead → record.
      spawnSync('pkill', ['-f', `tmux -S ${sock} `], { stdio: 'ignore' })
      const log = exitLogPath(logDir)
      expect(
        await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').includes('ev=server-exit'), 10000),
      ).toBe(true)
      const line = readFileSync(log, 'utf8')
      expect(line).toContain(`ev=server-exit identity=${identity}`)
      expect(line).toContain('cause=signaled-server-gone') // rc=0 shape, server found dead
      expect(line).toContain(`server_pid=${pid}`)
      expect(readdirSync(serverDeathsDir(logDir)).length).toBe(1) // forensics captured
    },
    20000,
  )

  test(
    'canary client killed while server lives → silent (no false record), canary gone for the retrofit to re-arm',
    async () => {
      const identity = 'claude-canaclient'
      const { sock, logDir } = bringUp(identity)
      expect(ensureServerCanary({ identity, sock, exitLogDir: logDir })).toBe('spawned')
      expect(await waitFor(() => canaryRunning(identity), 3000)).toBe(true)
      await sleep(500)

      // TERM the CLIENT only (argv ends with the bare channel — the sh's quoted
      // form does not match this $-anchored pattern), server stays up.
      spawnSync('pkill', ['-f', `wait-for ${canaryChannel(identity)}$`], { stdio: 'ignore' })
      // the sh probes (≈2 s), finds the server ALIVE → exits silently
      expect(await waitFor(() => !canaryRunning(identity), 6000)).toBe(true)
      await sleep(300)
      expect(
        existsSync(exitLogPath(logDir)) && readFileSync(exitLogPath(logDir), 'utf8').includes('ev=server-exit'),
      ).toBe(false) // no false server-death while the server lives
      // server must still be alive — and ensure re-arms a fresh canary (the
      // retrofit path; in prod the supervise tick does this and logs it)
      expect(spawnSync('tmux', ['-S', sock, 'has-session', '-t', identity], { stdio: 'ignore' }).status).toBe(0)
      expect(ensureServerCanary({ identity, sock, exitLogDir: logDir })).toBe('spawned')
    },
    20000,
  )

  test(
    'dirty server death followed by immediate replacement on the same socket still records the ORIGINAL death',
    async () => {
      const identity = 'claude-canareplaced'
      const { sock, logDir } = bringUp(identity)
      const pid = serverPid(sock)
      expect(pid).toBeGreaterThan(0)
      expect(ensureServerCanary({ identity, sock, exitLogDir: logDir })).toBe('spawned')
      expect(await waitFor(() => canaryRunning(identity), 3000)).toBe(true)
      await sleep(500)

      process.kill(pid, 'SIGKILL')
      // Reuse the same socket before the canary's 2s dismissal-grace window
      // expires. The old socket-level probe treated this successor as "server
      // alive" and lost the predecessor's death; the canary must key on SPID.
      let started = false
      for (let i = 0; i < 20; i++) {
        const r = spawnSync('tmux', ['-S', sock, 'new-session', '-d', '-s', identity, 'sleep', '120'], {
          stdio: 'ignore',
        })
        if (r.status === 0) {
          started = true
          break
        }
        await sleep(50)
      }
      expect(started).toBe(true)

      const log = exitLogPath(logDir)
      expect(await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').includes('ev=server-exit'), 8000)).toBe(
        true,
      )
      const line = readFileSync(log, 'utf8')
      expect(line).toContain(`ev=server-exit identity=${identity}`)
      expect(line).toContain(`server_pid=${pid}`)
      expect(readdirSync(serverDeathsDir(logDir)).length).toBe(1)
    },
    20000,
  )
})
