import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '..')
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (f: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms
  while (!f()) { if (Date.now() >= end) throw new Error('cleanup proof timed out'); await Bun.sleep(25) }
}

for (const mode of ['success', 'failure', 'SIGTERM', 'SIGINT'] as const) {
  test(`operator stand reaps its real daemon and supervisor on ${mode}`, async () => {
    const logs = mkdtempSync(join(tmpdir(), 'iap-cleanup-test-'))
    const out = join(logs, 'out'), err = join(logs, 'err')
    let ready: { root: string; daemonPid: number; sentinelPid: number; port: number } | undefined
    const p = Bun.spawn([process.execPath, 'scripts/proof-installed-legacy-operators.ts',
      '--runtime', 'codex', '--bin', join(repo, 'bin/iapeer'), '--cleanup-only',
      mode.startsWith('SIG') ? 'wait' : mode], {
      cwd: repo, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, IAPEER_TEST_SANDBOX: '1' },
      stdout: Bun.file(out), stderr: Bun.file(err),
    })
    try {
      await until(() => {
        const line = readFileSync(out, 'utf8').split('\n').find(l => l.startsWith('CLEANUP_READY '))
        if (line) ready = JSON.parse(line.slice('CLEANUP_READY '.length))
        if (!ready && (p.exitCode !== null || p.signalCode !== null)) throw new Error(readFileSync(err, 'utf8'))
        return !!ready
      })
      if (mode === 'SIGTERM' || mode === 'SIGINT') {
        expect(alive(ready!.daemonPid)).toBe(true)
        p.kill(mode)
      }
      await until(() => p.exitCode !== null || p.signalCode !== null)
      expect(alive(ready!.daemonPid)).toBe(false)
      expect(alive(ready!.sentinelPid)).toBe(false)
      expect(await p.exited).toBe(mode === 'success' ? 0 : mode === 'failure' ? 1 : mode === 'SIGTERM' ? 143 : 130)
      expect(existsSync(ready!.root)).toBe(false)
      const probe = await fetch(`http://127.0.0.1:${ready!.port}/`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined)
      expect(probe).toBeUndefined()
    } finally {
      if (p.exitCode === null && p.signalCode === null) { p.kill('SIGKILL'); await p.exited }
      // A red regression must not itself leak the children it just discovered.
      if (ready) {
        for (const pid of [ready.daemonPid, ready.sentinelPid]) if (alive(pid)) {
          process.kill(pid, 'SIGTERM')
          await until(() => !alive(pid), 3000).catch(() => { if (alive(pid)) process.kill(pid, 'SIGKILL') })
        }
        rmSync(ready.root, { recursive: true, force: true })
      }
      rmSync(logs, { recursive: true, force: true })
    }
  }, 30_000)
}
