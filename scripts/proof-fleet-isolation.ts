// Live, isolated reproduction of the 18.10 test-suite SIGTERM incident.
// bun scripts/proof-fleet-isolation.ts [--expect-legacy-failure]
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSupervisorDaemon, killSession, sessionAlive } from '../src/supervisor/index.ts'
import { loadLifecycleConfig, superviseTick } from '../src/lifecycle/index.ts'
import { upsertPeer } from '../src/registry/index.ts'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'iap-isolation-'))
const foreign = join(root, 'foreign')
const own = join(root, 'own')
const runDir = join(foreign, 'state/supervisor')
const env = { ...process.env, IAPEER_ROOT: foreign, IAPEER_LAUNCHAGENTS_DIR: join(own, 'LaunchAgents') }
const cfg = loadLifecycleConfig({ ...env, IAPEER_ROOT: own, IAPEER_BOOT_DEADLINE_SECS: '1', IAPEER_READY_GATE_SECS: '1' })
const ids = ['claude-sentinel', 'telegram-sentinel', 'notifier-sentinel']
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const bin = arg('--bin')
const artifacts = arg('--artifacts')
const pids: Record<string, number | undefined> = {}
const legacyFile = fileURLToPath(new URL(`../src/lifecycle/.proof-legacy-${process.pid}.ts`, import.meta.url))
mkdirSync(cfg.stateDir, { recursive: true })
try {
  for (const session of ids) {
    const r = await startSupervisorDaemon({ session, runtime: session.split('-')[0]!, runDir,
      ...(bin ? { daemonArgv: [bin, 'supervisor'] } : {}),
      serve: { argv: ['/bin/sleep', '600'], env: {}, cwd: root, exitLogPath: join(root, 'exits.log') } })
    if (r.state !== 'started') throw new Error(JSON.stringify(r))
    pids[session] = r.pid
  }
  // Exactly the problematic shape: cfg is isolated, env points at another fleet; no liveness seam.
  let sweep = superviseTick
  if (process.argv.includes('--replay-legacy-resolver')) {
    // Re-run the actual sweep with ONLY its namespace selection restored to the incident's env
    // resolution. Both fleets are created above, never supplied by the caller. Audit stays enabled.
    const source = readFileSync(fileURLToPath(new URL('../src/lifecycle/index.ts', import.meta.url)), 'utf8')
    const fixed = "const runDir = cfg.supervisorRunDir ?? join(cfg.stateDir, 'supervisor')"
    if (!source.includes(fixed)) throw new Error('legacy replay patch no longer matches source')
    writeFileSync(legacyFile, "import { hostRunDir } from '../launch/ptyHost.ts'\n" + source.replace(fixed, 'const runDir = hostRunDir(env)'))
    sweep = (await import(legacyFile)).superviseTick
  }
  const outcomes = sweep(cfg, { env, nowMs: Date.now() + 3600_000 })
  await Bun.sleep(1500)
  const dead = ids.filter(id => !sessionAlive(runDir, id))
  const read = (path: string) => { try { return readFileSync(path, 'utf8') } catch { return '' } }
  const result: Record<string, unknown> = { pids, outcomes, foreignKilled: dead, exits: read(join(root, 'exits.log')) }
  if (process.argv.includes('--expect-legacy-failure') ? dead.length !== ids.length : dead.length !== 0) throw new Error('isolation invariant failed')
  if (bin && dead.length === 0) {
    await upsertPeer({ personality: 'sentinel', runtime: 'claude', runtimes: ['claude', 'telegram', 'notifier'], cwd: root, intelligence: 'artificial' }, { rootDir: foreign })
    const stop = Bun.spawn([bin, 'stop', 'sentinel', 'claude'], { env: { ...env, PEER_IDENTITY: 'test-operator' }, stdout: 'pipe', stderr: 'pipe' })
    const code = await stop.exited
    result.stop = { code, stdout: await new Response(stop.stdout).text(), stderr: await new Response(stop.stderr).text() }
    await Bun.sleep(1000)
    result.afterTargetedStop = Object.fromEntries(ids.map(id => [id, sessionAlive(runDir, id)]))
    if (code || sessionAlive(runDir, ids[0]!) || ids.slice(1).some(id => !sessionAlive(runDir, id))) throw new Error('installed stop affected foreign endpoint')
  }
  result.audit = read(join(runDir, 'terminations.log'))
  result.exits = read(join(root, 'exits.log'))
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(join(artifacts, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  }
  console.log(JSON.stringify(result, null, 2))
  console.log(dead.length ? 'REPRODUCED: cfg-only sandbox killed foreign supervisors' : 'PASS: foreign supervisors survived the real sweep')
} finally {
  for (const id of ids) killSession(runDir, id)
  await Bun.sleep(1000)
  rmSync(root, { recursive: true, force: true })
  rmSync(legacyFile, { force: true })
}
