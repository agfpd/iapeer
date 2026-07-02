import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliverToHost } from './deliver.ts'
import { killSession, startSupervisorDaemon } from './index.ts'

// The deliver leaf is the host equivalent of tmux load-buffer/paste-buffer/send-keys: it must put the
// message on the hosted child's pty input as a bracketed paste followed by a CR. Hermetic: a probe
// child captures its raw stdin (stty raw bypasses the line discipline) so we assert the EXACT bytes
// the child received. Guarded on Bun-native pty.
const [maj, min, pat] = (Bun.version || '0.0.0').split('.').map(Number) as [number, number, number]
const bunPty = maj > 1 || (maj === 1 && (min > 3 || (min === 3 && pat >= 5)))
const d = bunPty ? describe : describe.skip
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

d('deliverToHost (supervisor-socket delivery — bracketed paste + CR)', () => {
  test('the child receives exactly: ESC[200~ <message> ESC[201~ CR', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iapeer-deliver-'))
    const out = join(runDir, 'stdin.bin')
    const msg = 'hello-deliver-❯'
    const expected = `\x1b[200~${msg}\x1b[201~\r`
    const n = Buffer.byteLength(expected, 'utf8')
    try {
      // probe child: raw mode (no line-discipline cooking), read exactly n bytes, dump to a file
      const argv = ['sh', '-c', `stty raw -echo; head -c ${n} > '${out}'; sleep 5`]
      const r = await startSupervisorDaemon({ session: 'dlv', runtime: 'tick', runDir, serve: { argv, env: { PATH: process.env.PATH ?? '' }, cwd: runDir } })
      expect(r.state).toBe('started')
      await sleep(400) // let the probe reach raw mode
      const res = await deliverToHost(runDir, 'dlv', msg)
      expect(res.ok).toBe(true)
      // wait for the child to have captured n bytes
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && !(existsSync(out) && readFileSync(out).length >= n)) await sleep(50)
      const got = existsSync(out) ? readFileSync(out) : Buffer.alloc(0)
      expect(got.equals(Buffer.from(expected, 'utf8'))).toBe(true) // bracketed paste + CR, byte-exact
    } finally {
      try {
        killSession(runDir, 'dlv')
      } catch {
        /* */
      }
      await sleep(300)
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  test('no supervisor socket → a clean error, not a throw', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'iapeer-deliver-none-'))
    try {
      const res = await deliverToHost(runDir, 'nope', 'x')
      expect(res.ok).toBe(false)
      expect(res.error).toContain('no supervisor socket')
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})
