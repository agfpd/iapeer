// Isolated acceptance: installed Codex --no-daemon, real stdio MCP + real source self-fresh.
// A deterministic LOOPBACK model emits ping then exec(self-fresh); no model/account/auth is used.
// Eager relaunch uses the real lifecycle mark processor with an injected throwaway host launcher.
// Run: IAPEER_TEST_SANDBOX=1 bun scripts/proof-stdio-teardown.ts [--expect-orphan]
// Optional IAPEER_PROOF_SUPERVISOR_ENTRY points at a clean baseline worktree's supervisor/index.ts.
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { hasNewEager, loadLifecycleConfig, processOrphanEagerMarks } from '../src/lifecycle/index.ts'
import { killSession, sessionAlive, startSupervisorDaemon } from '../src/supervisor/index.ts'
import { defaultRunDir, pidStartToken } from '../src/supervisor/paths.ts'

assert.equal(process.env.IAPEER_TEST_SANDBOX, '1', 'sandbox opt-in required')
const codex = Bun.which('codex')
assert(codex, 'installed Codex required; the hermetic regression uses no installed runtime')
const dir = mkdtempSync(join(tmpdir(), 'iap-codex-'))
const home = join(dir, 'home'), codexHome = join(home, '.codex')
mkdirSync(codexHome, { recursive: true })
const fixture = resolve(import.meta.dir, '../src/supervisor/fixtures/owned-stdio.ts')
const cli = resolve(import.meta.dir, '../src/cli/index.ts')
const env: Record<string, string> = {
  HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH!, TERM: 'xterm-256color',
  IAPEER_TEST_SANDBOX: '1', IAPEER_ROOT: join(dir, 'root'), IAPEER_LAUNCHAGENTS_DIR: join(dir, 'agents'),
  PEER_IDENTITY: 'codex-stdio-proof',
}
const session = env.PEER_IDENTITY, runDir = defaultRunDir(env), cfg = loadLifecycleConfig(env)
const seen = new Map<number, string>()
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const events = (generation: string): Array<{event: string; pid: number}> => {
  const p = join(dir, generation, 'events.jsonl')
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
}
async function until(pred: () => boolean, message: string, ms = 20000) {
  const end = Date.now() + ms
  while (!pred() && Date.now() < end) await Bun.sleep(50)
  assert(pred(), message)
}
let generation = 'old', step = 0, freshPong = false
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  if (!new URL(req.url).pathname.endsWith('/responses')) return new Response('{}', { status: 404 })
  const body = await req.json() as any
  const names = (body.tools ?? []).map((t: any) => t.name)
  const pingNamespace = (body.tools ?? []).find((t: any) => t.type === 'namespace' && t.name === 'mcp__owned' && t.tools?.some((f: any) => f.name === 'ping'))
  const ping = names.find((n: string) => n?.endsWith('__ping'))
  console.log(JSON.stringify({ generation, step, ownedToolAdvertised: !!(ping || pingNamespace) }))
  if (step === 1) {
    const output = (body.input ?? []).find((i: any) => i.type === 'function_call_output' && i.call_id === `call_${generation}_ping`)
    assert(output && JSON.stringify(output).includes('pong:'), 'Codex must consume its MCP response before the next model request')
    if (generation === 'fresh') freshPong = true
    const owned = events(generation).filter(e => e.event === 'server' || e.event === 'wrapper')
    const pids = [...new Set(owned.flatMap((e: any) => [e.pid, e.ppid]))].join(',')
    console.log(JSON.stringify({ generation, phase: 'mcp-pong-consumed', ps: spawnSync('/bin/ps', ['-o', 'pid,ppid,pgid,tty,lstart', '-p', pids], { encoding: 'utf8' }).stdout.trim() }))
  }
  let item: any
  if (step === 0) {
    assert(ping || pingNamespace, 'Codex must advertise the owned MCP ping tool')
    item = { type: 'function_call', id: `fc_${generation}_ping`, call_id: `call_${generation}_ping`, name: ping ?? 'ping', ...(pingNamespace ? { namespace: 'mcp__owned' } : {}), arguments: '{}' }
  } else if (step === 1 && generation === 'old') {
    assert(names.includes('exec_command'), 'Codex exec_command is required for the real self-call')
    item = { type: 'function_call', id: 'fc_fresh', call_id: 'call_fresh', name: 'exec_command', arguments: JSON.stringify({ cmd: `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} self-fresh` }) }
  } else {
    item = { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PROBE_OK', annotations: [] }] }
  }
  step++
  const response = { id: `resp_${generation}_${step}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  const sse = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
} })
const sentinel = Bun.spawn(['sleep', '90'])
const remember = () => {
  for (const g of ['old', 'fresh']) for (const e of events(g)) {
    const token = pidStartToken(e.pid)
    if (token) seen.set(e.pid, token)
  }
}
const start = async () => {
  const cwd = join(dir, generation)
  mkdirSync(cwd)
  writeFileSync(join(codexHome, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "probe"\ncheck_for_update_on_startup = false\n[model_providers.probe]\nname = "Loopback proof only"\nbase_url = "http://127.0.0.1:${server.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[mcp_servers.owned]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([fixture, 'wrapper', cwd])}\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`)
  const baseline = process.env.IAPEER_PROOF_SUPERVISOR_ENTRY
  const r = await startSupervisorDaemon({ session, runtime: 'codex', runDir,
    ...(baseline ? { daemonArgv: [process.execPath, resolve(baseline)] } : {}),
    serve: { argv: [codex, '--no-daemon', '--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox', '-C', cwd, 'Run the probe.'], env, cwd, paneLogPath: join(cwd, 'pane.log') },
  })
  assert.equal(r.state, 'started')
  await until(() => events(generation).some(e => e.event === 'tools/list'), 'Codex did not initialize MCP')
  remember()
}
try {
  console.log(JSON.stringify({ codex: spawnSync(codex, ['--version'], { encoding: 'utf8' }).stdout.trim(), baseline: process.env.IAPEER_PROOF_SUPERVISOR_ENTRY ?? false }))
  await start()
  await until(() => hasNewEager(cfg, session) && !sessionAlive(runDir, session), 'Codex did not execute self-fresh and terminate')
  await Bun.sleep(500)
  const old = events('old').filter(e => e.event === 'server' || e.event === 'wrapper')
  const oldAlive = old.filter(e => alive(e.pid))
  console.log(JSON.stringify({ phase: 'old-after-self-fresh', old, oldAlive, events: events('old'), sentinelAlive: alive(sentinel.pid) }))
  assert.equal(oldAlive.length > 0, process.argv.includes('--expect-orphan'))
  assert(alive(sentinel.pid))
  generation = 'fresh'; step = 0
  const result = await processOrphanEagerMarks(cfg, { env, wakeFn: async args => {
    assert.equal(args.resume, false)
    await start()
    return { status: 'READY', woke: true, runtime: 'codex' }
  } })
  assert.equal(result[0]?.status, 'READY')
  await until(() => freshPong, 'fresh Codex did not consume the new MCP response')
  console.log(JSON.stringify({ phase: 'fresh-mcp-called', events: events('fresh'), sentinelAlive: alive(sentinel.pid) }))
  assert(alive(sentinel.pid))
  console.log('PASS: isolated Codex self-fresh / fresh MCP call / unrelated sentinel')
} catch (e) {
  for (const g of ['old', 'fresh']) {
    const p = join(dir, g, 'pane.log')
    if (existsSync(p)) console.error(readFileSync(p, 'utf8').slice(-6000))
  }
  throw e
} finally {
  remember()
  killSession(runDir, session)
  await until(() => !sessionAlive(runDir, session), 'supervisor cleanup failed', 5000)
  for (const [pid, token] of seen) if (pidStartToken(pid) === token) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  await until(() => [...seen].every(([pid, token]) => pidStartToken(pid) !== token), 'owned proof process survived cleanup', 5000)
  sentinel.kill('SIGKILL'); await sentinel.exited
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
}
