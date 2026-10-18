import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { upsertPeer } from '../registry/index.ts'
import { markHostReady } from '../launch/ptyHost.ts'
import { writePidFile } from '../supervisor/paths.ts'
import { loadLifecycleConfig, wakeOrSpawn } from './index.ts'

// A real, deliberately slow asynchronous supervisor teardown. No native runtime/network involved.
// An ordinary wake must reuse it; operator /new must await its death and refuse a failed new launch.
test('operator restart never accepts the dying old hosting as READY', async () => {
  const root = mkdtempSync('/tmp/iap-restart-test-')
  const env = { ...process.env, HOME: join(root, 'home'), IAPEER_ROOT: join(root, 'iap'), IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'), IAPEER_SOCK_DIR: join(root, 's') }
  const cfg = loadLifecycleConfig(env), id = 'claude-restart-proof', runDir = cfg.supervisorRunDir!
  mkdirSync(runDir, { recursive: true })
  mkdirSync(cfg.stateDir, { recursive: true })
  const ready = join(root, 'fixture-ready'), pidFile = join(runDir, id + '.pid')
  const received = join(root, 'term-received')
  const fixture = join(root, 'slow-host.ts')
  writeFileSync(fixture, `import { writeFileSync, rmSync } from 'node:fs';
process.on('SIGTERM', () => {
  writeFileSync(${JSON.stringify(received)}, 'term');
  setTimeout(() => { rmSync(${JSON.stringify(pidFile)}, { force: true }); process.exit(0) }, 400);
});
writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);
`)
  const old = Bun.spawn([process.execPath, fixture], { env, stdout: 'ignore', stderr: 'ignore' })
  try {
    const deadline = Date.now() + 5000
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20)
    expect(existsSync(ready)).toBe(true)
    writePidFile(runDir, id, old.pid)
    markHostReady(id, env)
    // A missing cwd gives a deterministic new-launch failure AFTER old teardown. An old-host
    // fast-path false OK never reaches this check (the installed native counterexample).
    const cwd = join(root, 'missing-cwd')
    await upsertPeer({ personality: 'restart-proof', runtime: 'claude', intelligence: 'artificial', cwd }, { env })
    writeFileSync(join(cfg.stateDir, id + '.session'), JSON.stringify({ identity: id, runtime: 'claude', personality: 'restart-proof', cwd, wokeAt: Date.now() }))
    const ordinary = await wakeOrSpawn({ personality: 'restart-proof', task: '' }, { env, cfg })
    expect(ordinary.status).toBe('READY')
    expect(ordinary.woke).toBe(false)
    const started = Date.now()
    const replaced = await wakeOrSpawn({ personality: 'restart-proof', task: '', resume: false, restart: true }, { env, cfg })
    expect(replaced.status).toBe('FAILED')
    expect(replaced.reason).toContain('cwd does not exist')
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    expect(readFileSync(received, 'utf8')).toBe('term')
    expect(existsSync(pidFile)).toBe(false)
    await old.exited
  } finally {
    if (old.exitCode === null) old.kill('SIGKILL')
    await old.exited
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)
