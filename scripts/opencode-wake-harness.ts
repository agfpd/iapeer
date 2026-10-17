#!/usr/bin/env bun
// OpenCode through the FLEET lifecycle (docs/20-opencode.md): a registered opencode peer is
// cold-woken by a message (wakeOrSpawn), its task rides as the first message, the supervise tick
// idle-reaps it from the plugin's state, and the next message resumes the SAME native session with
// a re-composed doctrine. Isolated sandbox (HOME/IAPEER_ROOT temp, synthetic provider); never
// touches the fleet daemon, the real registry or a cloud API.
//
//   OPENCODE_BIN=/path/to/opencode bun scripts/opencode-wake-harness.ts \
//     --seed-config <dir with node_modules/@opencode-ai/plugin> [--keep]
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const bin = process.env.OPENCODE_BIN
if (!bin || !existsSync(bin)) {
  console.error('set OPENCODE_BIN to the native opencode executable')
  process.exit(2)
}
const keep = process.argv.includes('--keep')
const seedAt = process.argv.indexOf('--seed-config')
const root = mkdtempSync('/tmp/iapeer-ocwake-')
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
if (seedAt > 0) cpSync(process.argv[seedAt + 1]!, join(home, 'config', 'opencode'), { recursive: true })
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: home,
  IAPEER_ROOT: join(root, 'iapeer'),
  IAPEER_PORT: '9',
  IAPEER_OPENCODE_BIN: bin,
  IAPEER_IDLE_SECS: '5',
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_DATA_HOME: join(home, 'data'),
  XDG_CACHE_HOME: join(home, 'cache'),
  XDG_STATE_HOME: join(home, 'state'),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
  // a fresh HOME makes any native `brew` probe auto-update over the network
  HOMEBREW_NO_AUTO_UPDATE: '1',
}
for (const k of Object.keys(process.env)) delete process.env[k]
Object.assign(process.env, env)

const { initPeer } = await import('../src/init/index.ts')
const { wakeOrSpawn, superviseTick, loadLifecycleConfig } = await import('../src/lifecycle/index.ts')
const { opencodePaths } = await import('../src/opencode/config.ts')
const { hostSessionAlive, killPtyHost } = await import('../src/launch/ptyHost.ts')

const personality = 'ocwake'
const identity = `opencode-${personality}`
const cwd = join(root, personality)
mkdirSync(cwd, { recursive: true })

const wire: any[] = []
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const body = await req.json()
    wire.push(body)
    const id = 'chatcmpl-' + wire.length
    const chunk = (delta: any, finish: string | null) =>
      'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'
    return new Response(chunk({ role: 'assistant', content: 'OK' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  },
})

const results: { check: string; ok: boolean; detail?: unknown }[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`)
}
const paths = opencodePaths(personality, { env })
const readEvents = (): any[] => (existsSync(paths.events) ? readFileSync(paths.events, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
const readState = () => (existsSync(paths.state) ? JSON.parse(readFileSync(paths.state, 'utf8')) : null)
const userTexts = () => wire.flatMap(b => (b.messages ?? []).filter((m: any) => m.role === 'user').map((m: any) => JSON.stringify(m.content)))
const systemOf = (b: any) => JSON.stringify((b.messages ?? []).filter((m: any) => m.role === 'system'))
async function until<T>(what: string, f: () => T | undefined | null | false, ms = 20000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = f()
    if (v) return v
    await Bun.sleep(200)
  }
  throw new Error(`timeout waiting for ${what}`)
}

let code = 1
try {
  const init = await initPeer({ cwd, runtime: 'opencode', personality, description: 'opencode wake probe', intelligence: 'artificial', env })
  check('initPeer opencode: registered, no claude/codex MCP files written', init.runtime === 'opencode' && init.mcpConfigPaths.length === 0 && !init.codexMcpConfigPath, { runtime: init.runtime })
  writeFileSync(join(cwd, '.iapeer', 'IAPEER.md'), 'DOCTRINE_V1\n')
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(
    paths.config,
    JSON.stringify({
      model: 'synthetic/synthetic',
      small_model: 'synthetic/synthetic',
      enabled_providers: ['synthetic'],
      provider: { synthetic: { npm: '@ai-sdk/openai-compatible', name: 'Synthetic', options: { baseURL: provider.url.toString() + 'v1', apiKey: 'x' }, models: { synthetic: { name: 'Synthetic', limit: { context: 100000, output: 1000 } } } } },
    }),
  )

  // 1. cold wake by a message
  const t0 = Date.now()
  const w1 = await wakeOrSpawn({ personality, runtime: 'opencode', task: 'COLD_TASK', topic: 'probe-thread' }, { env })
  check('cold wake READY, task delivered', w1.status === 'READY' && w1.woke === true && w1.taskDelivered !== false, { ...w1, ms: Date.now() - t0 })
  await until('COLD_TASK at the provider', () => userTexts().some(t => t.includes('COLD_TASK')), 30000)
  const sys1 = systemOf(wire.find(b => JSON.stringify(b.messages).includes('COLD_TASK')))
  check('composed doctrine (identity YAML + local IAPEER.md) is the system prompt', sys1.includes('ocwake') && sys1.includes('DOCTRINE_V1'))
  const session1 = readEvents().find(e => e.type === 'runtime.ready')?.sessionID
  await until('idle', () => readState()?.status === 'idle', 20000)

  // 2. a warm wake on a live session is idempotent (no second spawn)
  const w2 = await wakeOrSpawn({ personality, runtime: 'opencode', task: 'IGNORED' }, { env })
  check('live session: wake is idempotent', w2.status === 'READY' && w2.woke === false, w2)

  // 3. idle-reap from the plugin's state (IAPEER_IDLE_SECS=5)
  await Bun.sleep(6500)
  const cfg = loadLifecycleConfig(env)
  const outcomes = superviseTick(cfg, { env })
  const mine = outcomes.find(o => o.identity === identity)
  check('supervise tick idle-reaps the quiet session', mine?.action === 'reaped-idle', mine)
  await until('session gone', () => !hostSessionAlive(identity, env), 15000)
  await until('runtime.stopped', () => readState()?.status === 'stopped', 5000)

  // 4. next message on the SAME topic resumes the SAME session with the re-composed doctrine
  //    (a topicless message after idle-reap wakes fresh by core policy — not an opencode property)
  writeFileSync(join(cwd, '.iapeer', 'IAPEER.md'), 'DOCTRINE_V2\n')
  const w3 = await wakeOrSpawn({ personality, runtime: 'opencode', task: 'RESUME_TASK', topic: 'probe-thread' }, { env })
  check('wake after idle-reap READY', w3.status === 'READY' && w3.woke === true, w3)
  const ready2 = readEvents().filter(e => e.type === 'runtime.ready').at(-1)
  check('resumed the same native session', ready2?.properties?.resumed === true && ready2?.sessionID === session1, { session1, now: ready2?.sessionID })
  await until('RESUME_TASK at the provider', () => userTexts().some(t => t.includes('RESUME_TASK')), 30000)
  const last = wire.find(b => JSON.stringify(b.messages).includes('RESUME_TASK'))
  const sys2 = systemOf(last)
  check('re-composed doctrine V2 replaces V1; history kept', sys2.includes('DOCTRINE_V2') && !sys2.includes('DOCTRINE_V1') && JSON.stringify(last.messages).includes('COLD_TASK'))
  const lc = readFileSync(join(root, 'iapeer', 'logs', 'iapeer', 'lifecycle.log'), 'utf8')
  check('lifecycle.log records fresh then resume for the opencode identity', /ev=wake.*identity=opencode-ocwake.*mode=fresh/.test(lc) && /ev=wake.*identity=opencode-ocwake.*mode=resume/.test(lc))
  code = results.every(r => r.ok) ? 0 : 1
} catch (e) {
  check('harness', false, e instanceof Error ? e.message : String(e))
} finally {
  try {
    killPtyHost(identity, env)
  } catch {}
  provider.stop(true)
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`${results.filter(r => r.ok).length}/${results.length} passed · root ${root}`)
  if (!keep && code === 0) rmSync(root, { recursive: true, force: true })
}
process.exit(code)
