// Manual installed-binary check. Only our own sleep PID is exposed to the REAL run-dir;
// no socket, peer registration or existing pidfile is touched (even on a regression).
// bun scripts/proof-installed-sandbox.ts --bin ~/.local/bin/iapeer --artifacts <dir>
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { writePidFile, pidPath } from '../src/supervisor/paths.ts'
import { fileSHA256 } from './proof-installed-lib.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const bin = resolve(arg('--bin') ?? join(homedir(), '.local/bin/iapeer'))
const binSHA256 = fileSHA256(bin)
const runDir = join(homedir(), '.iapeer/state/supervisor')
const session = `guardprobe-${process.pid}` // not a valid runtime-prefixed peer identity
const pidfile = pidPath(runDir, session)
if (!existsSync(runDir) || existsSync(pidfile)) throw new Error('expected existing real run-dir and unused sentinel name')
const child = Bun.spawn(['/bin/sleep', '600'], { stdout: 'ignore', stderr: 'ignore' })
try {
  writePidFile(runDir, session, child.pid)
  const probe = Bun.spawn([bin, 'supervisor', 'kill', session, '--run-dir', runDir], {
    env: { ...process.env, IAPEER_TEST_SANDBOX: '1' }, stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([probe.exited, new Response(probe.stdout).text(), new Response(probe.stderr).text()])
  await Bun.sleep(100)
  let sentinelAlive = false
  try { process.kill(child.pid, 0); sentinelAlive = child.exitCode === null } catch { /* dead */ }
  const result = { bin, binSHA256, code, stdout, stderr, sentinelPid: child.pid, sentinelAlive,
    success: code !== 0 && /refusing to signal the REAL supervisor/.test(stderr) && sentinelAlive }
  const artifacts = arg('--artifacts')
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  }
  console.log(JSON.stringify(result, null, 2))
  if (!result.success) throw new Error('installed sandbox guard failed')
} finally {
  rmSync(pidfile, { force: true })
  child.kill()
  await child.exited
}
