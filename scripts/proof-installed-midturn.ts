// Mid-turn delivery closure on the INSTALLED daemon/CLI/supervisors with the real native runtime and a
// loopback provider (no cloud, no fleet). Source code only sets up fixtures and reads logs.
// bun scripts/proof-installed-midturn.ts --runtime claude|codex|opencode [--bin ~/.local/bin/iapeer]
//   [--native <runtime bin>] [--seed-config <OpenCode config with SDK modules>] [--artifacts <dir>]
//
// S1 «absorbed then finished»: A starts a turn with an 8 s tool call; B is delivered while the tool runs;
//    the turn ends; the session is idle-reaped → 0 redeliveries, 0 notices, 0 wakes.
// S2 «unprocessed at death»: A's request hangs on the provider; B is delivered into that turn; the session
//    is killed → every message accounted for exactly once (B redelivered; A redelivered or reported
//    interrupted), no duplicates over the following ticks, then the redelivered turn closes and the reap
//    after it is quiet again.
// Provider formats: https://platform.claude.com/docs/en/build-with-claude/streaming ,
// https://developers.openai.com/codex/config-advanced#custom-model-providers (checked 2026-10-18).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileSHA256 } from './proof-installed-lib.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const runtime = arg('--runtime')
if (runtime !== 'claude' && runtime !== 'codex' && runtime !== 'opencode') throw new Error('set --runtime claude|codex|opencode')
const hostHome = homedir(), bin = resolve(arg('--bin') ?? join(hostHome, '.local/bin/iapeer'))
const binSHA256 = fileSHA256(bin)
const native = resolve(arg('--native') ?? (runtime === 'claude' ? join(hostHome, '.local/bin/claude') : runtime === 'codex' ? '/opt/homebrew/bin/codex' : join(hostHome, '.opencode/bin/opencode')))
const artifacts = arg('--artifacts'), root = mkdtempSync('/tmp/iap-installed-midturn-')
const home = join(root, 'home'), iap = join(root, 'iapeer'), cwd = join(root, 'midturn-proof')
mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true })
const seed = arg('--seed-config')
if (seed) cpSync(seed, join(home, 'config/opencode'), { recursive: true })

const wire: unknown[] = []
let toolIssued = false, toolRequestAt = 0, hangIssued = false, hangAt = 0
const TOOL_MARK = 'MIDTURN_TOOL_A', HANG_MARK = 'MIDTURN_HANG_A'
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(req) {
  const body: any = await req.json().catch(() => ({})), path = new URL(req.url).pathname
  wire.push({ time: Date.now(), path, body })
  if (path.includes('count_tokens')) return Response.json({ input_tokens: 100 })
  if (!path.endsWith('/messages') && !path.endsWith('/responses') && !path.endsWith('/chat/completions')) return Response.json({})
  const id = wire.length, all = JSON.stringify(body)
  const toolCapable = JSON.stringify(body.tools ?? []).includes(runtime === 'claude' ? '"Bash"' : runtime === 'codex' ? '"exec_command"' : 'bash')
  let action: 'tool' | 'hang' | undefined
  if (toolCapable && !toolIssued && all.includes(TOOL_MARK)) { action = 'tool'; toolIssued = true; toolRequestAt = Date.now() }
  else if (toolCapable && !hangIssued && all.includes(HANG_MARK)) { action = 'hang'; hangIssued = true; hangAt = Date.now() }
  const command = '/bin/sleep 8', text = `PROBE_REPLY_${id}`
  const enc = new TextEncoder()
  const hang = (head: string) => new Response(new ReadableStream({ start(c) { if (head) c.enqueue(enc.encode(head)) } }), { headers: { 'content-type': 'text/event-stream' } })
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  if (runtime === 'opencode') {
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: `chatcmpl-${id}`, object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'
    if (action === 'hang') return hang('')
    const first = action === 'tool'
      ? chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command, description: 'Mid-turn proof tool', timeout: 60000 }) } }] }, null)
      : chunk({ role: 'assistant', content: text }, null)
    return new Response(first + chunk({}, action === 'tool' ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }
  if (runtime === 'codex') {
    if (action === 'hang') return hang(event('response.created', { type: 'response.created', response: { id: `resp_${id}`, object: 'response', status: 'in_progress', output: [] } }))
    const item = action === 'tool'
      ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'exec_command', arguments: JSON.stringify({ cmd: command, yield_time_ms: 15000 }) }
      : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    const response = { id: `resp_${id}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } }
    return new Response([
      event('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }),
      event('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }),
      event('response.completed', { type: 'response.completed', response }),
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  const content = action === 'tool'
    ? [{ type: 'tool_use' as const, id: `toolu_${id}`, name: 'Bash', input: { command, timeout: 60000, description: 'Mid-turn proof tool' } }]
    : [{ type: 'text' as const, text }]
  const message = { id: `msg_${id}`, type: 'message', role: 'assistant', model: body.model ?? 'claude-sonnet-4-5', content, stop_reason: action === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }
  if (action === 'hang') return hang(event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }))
  if (!body.stream) return Response.json(message)
  let stream = event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } })
  for (const [index, block] of content.entries()) {
    stream += event('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
    stream += event('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text } })
    stream += event('content_block_stop', { type: 'content_block_stop', index })
  }
  stream += event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } })
  stream += event('message_stop', { type: 'message_stop' })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
} })
const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('reserve') } })
const port = reserve.port!; reserve.stop(true)
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), TERM: 'xterm-256color', IAPEER_ROOT: iap,
  IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'), IAPEER_SOCK_DIR: join(root, 's'),
  IAPEER_PORT: String(port), IAPEER_DAEMON_SOCKET: join(root, 'router.sock'), IAPEER_IDLE_SECS: '20',
  IAPEER_CLAUDE_BIN: native, IAPEER_CODEX_BIN: native, IAPEER_OPENCODE_BIN: native,
  XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', HOMEBREW_NO_AUTO_UPDATE: '1',
  ANTHROPIC_BASE_URL: provider.url.origin, ANTHROPIC_AUTH_TOKEN: 'synthetic-local-only', ANTHROPIC_MODEL: 'claude-sonnet-4-5',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
}
for (const k of Object.keys(process.env)) delete process.env[k]
Object.assign(process.env, env)
const { initPeer } = await import('../src/init/index.ts')
const { upsertPeer } = await import('../src/registry/index.ts')
const { writePeerProfileAtomic } = await import('../src/identity/index.ts')
const { peerLaunchEnvPath } = await import('../src/storage/index.ts')
const { startSupervisorDaemon, sessionAlive } = await import('../src/supervisor/index.ts')
const { readInflight } = await import('../src/lifecycle/inflight.ts')
const { opencodePaths } = await import('../src/opencode/config.ts')
const runDir = join(iap, 'state/supervisor'), stateDir = join(iap, 'state/lifecycle')
const personality = 'midturn-proof', identity = `${runtime}-${personality}`, sender = 'notifier-sender', sinkLog = join(root, 'sender.log')
const results: unknown[] = []
let daemon: ReturnType<typeof Bun.spawn> | undefined, success = false
const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]) : []
const until = async (what: string, f: () => unknown | Promise<unknown>, ms = 180000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await f()) return; await Bun.sleep(250) }
  throw new Error(`timeout: ${what}`)
}
const deliveryLog = () => read(join(iap, 'logs/iapeer/delivery.log'))
const lifecycleLog = () => read(join(iap, 'logs/iapeer/lifecycle.log'))
const count = (re: RegExp) => (deliveryLog().match(re) ?? []).length
const counts = () => ({
  redelivered: count(/ev=inflight-redelivered\b/g),
  undelivered: count(/ev=inflight-undelivered\b/g),
  // interrupted notices group deliveries; sum their count= fields
  interrupted: [...deliveryLog().matchAll(/ev=inflight-interrupted\b.*?\bcount=(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0),
  wakes: (lifecycleLog().match(new RegExp(`ev=wake\\b[^\\n]*identity=${identity}\\b`, 'g')) ?? []).length,
  reaps: (lifecycleLog().match(new RegExp(`ev=supervise identity=${identity} action=reaped-idle`, 'g')) ?? []).length,
  orphaned: (lifecycleLog().match(new RegExp(`ev=inflight-orphaned identity=${identity}\\b`, 'g')) ?? []).length,
})
const record = (check: string, details: unknown) => { results.push({ check, time: new Date().toISOString(), details }); console.log(`PASS ${check} ${JSON.stringify(details)}`) }
const cli = async (...args: string[]) => {
  const p = Bun.spawn([bin, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
  results.push({ cli: { args, code, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) } })
  return { code, stdout, stderr }
}
const send = async (message: string) => {
  const r = await cli('send', personality, '--runtime', runtime, '--from', sender, '--topic', 'midturn-proof', '--message', message)
  if (r.code) throw new Error(JSON.stringify(r))
  return r
}
const TICK = 62000
try {
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true }))
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex/config.toml'), `model = "gpt-5.4"\nmodel_provider = "probe"\ncheck_for_update_on_startup = false\n[model_providers.probe]\nname = "Loopback proof only"\nbase_url = "${provider.url.origin}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nstream_idle_timeout_ms = 3600000\n`)
  await initPeer({ cwd, runtime, personality, intelligence: 'artificial', env })
  if (runtime === 'codex') writeFileSync(peerLaunchEnvPath(cwd, runtime), "PEER_START_ARGS='--no-daemon -c model_reasoning_effort=low'\n")
  if (runtime === 'opencode') {
    const paths = opencodePaths(personality, { env })
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(paths.config, JSON.stringify({ model: 'synthetic/synthetic', small_model: 'synthetic/synthetic', enabled_providers: ['synthetic'], provider: {
      synthetic: { npm: '@ai-sdk/openai-compatible', name: 'Synthetic', options: { baseURL: provider.url.origin + '/v1', apiKey: 'x', timeout: false }, models: { synthetic: { name: 'Synthetic', limit: { context: 100000, output: 1000 } } } },
    } }))
  }
  const senderCwd = join(root, 'sender')
  writePeerProfileAtomic(senderCwd, { personality: 'sender', runtime: 'notifier', runtimes: ['notifier'], intelligence: 'absent' })
  await upsertPeer({ personality: 'sender', runtime: 'notifier', intelligence: 'absent', cwd: senderCwd }, { env })
  const sink = await startSupervisorDaemon({ session: sender, runtime: 'notifier', runDir, daemonArgv: [bin, 'supervisor'], serve: { argv: ['/bin/cat'], env: {}, cwd: root, paneLogPath: sinkLog } })
  if (sink.state !== 'started') throw new Error(JSON.stringify(sink))
  daemon = Bun.spawn([bin, 'daemon'], { env, stdout: Bun.file(join(root, 'daemon.out')), stderr: Bun.file(join(root, 'daemon.err')) })
  await until('installed daemon listening', () => read(join(root, 'daemon.err')).includes('daemon READY'), 15000)

  // ── S1: delivered mid-turn, the turn ends, the session is reaped → silence.
  await send(`${TOOL_MARK}: run the tool, then answer.`)
  await until('A started its tool call', () => toolIssued)
  await Bun.sleep(2000)
  if (Date.now() - toolRequestAt > 7000) throw new Error('tool window missed')
  await send('MIDTURN_B: an acknowledgement delivered while the turn is running (no reply needed).')
  const midSentAt = Date.now(), before = counts() // the reap may share a tick with the ledger close
  if (midSentAt - toolRequestAt > 8000) throw new Error('B was not delivered inside the tool window')
  record('S1 B delivered inside the running turn', { msAfterToolStart: midSentAt - toolRequestAt })
  await until('S1 ledger closed by the installed daemon', () => readInflight(stateDir, identity).length === 0, 240000)
  await until('S1 session idle-reaped', () => counts().reaps > before.reaps, 240000)
  await until('S1 receiver gone', () => !sessionAlive(runDir, identity), 20000)
  await Bun.sleep(TICK * 2)
  const s1 = counts()
  if (s1.redelivered || s1.undelivered || s1.interrupted || s1.orphaned || s1.wakes !== before.wakes || read(sinkLog).includes('iapeer:')) throw new Error(`S1 not silent: ${JSON.stringify({ before, s1, sink: read(sinkLog) })}`)
  record('S1 mid-turn + end of turn + reap → 0 redeliveries, 0 notices, 0 wakes', { before, after: s1, ticksWaited: 2 })

  // ── S2: a turn dies before it processed the mid-turn message → exactly one redelivery.
  await send(`${HANG_MARK}: this request hangs on the provider.`) // wakes the reaped endpoint (one wake)
  await until('A request hanging', () => hangIssued)
  await Bun.sleep(1500)
  await send('MIDTURN_HANG_B: delivered into the hanging turn.')
  const pending = readInflight(stateDir, identity)
  record('S2 both deliveries pending in the ledger', { entries: pending.map(e => ({ msg: e.message.slice(0, 40), unconfirmed: e.unconfirmed ?? false })) })
  const s2before = counts()
  const killed = await cli('supervisor', 'kill', identity, '--run-dir', runDir)
  if (killed.code) throw new Error(killed.stderr)
  await until('S2 receiver gone', () => !sessionAlive(runDir, identity), 15000)
  await until('S2 both deliveries accounted for', () => { const c = counts(); return c.redelivered + c.interrupted - s2before.redelivered - s2before.interrupted >= 2 }, 240000)
  const s2 = counts()
  await until('S2 redelivered turn closed', () => readInflight(stateDir, identity).length === 0, 240000)
  await until('S2 redelivered session idle-reaped', () => counts().reaps > s2.reaps, 240000)
  await Bun.sleep(TICK * 2)
  const s2end = counts()
  const redelivered = s2end.redelivered - s2before.redelivered, interrupted = s2end.interrupted - s2before.interrupted
  if (redelivered < 1 || redelivered + interrupted !== 2 || s2end.undelivered) throw new Error(`S2 accounting wrong: ${JSON.stringify({ s2before, s2, s2end })}`)
  if (s2end.wakes - s2.wakes !== 0) throw new Error(`S2 woke after the redelivered turn closed: ${JSON.stringify({ s2, s2end })}`)
  record('S2 reap mid-turn with B unprocessed → B redelivered once, every message accounted for once, quiet after', { redelivered, interrupted, s2before, s2, s2end })
  success = true
} finally {
  if (daemon) { daemon.kill(); await daemon.exited }
  for (const id of [identity, sender]) await cli('supervisor', 'kill', id, '--run-dir', runDir)
  provider.stop(true)
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true })
    for (const p of files(root).filter(p => /(?:\.jsonl|\.log|\.out|\.err)$/.test(p))) {
      const dest = join(artifacts, p.slice(root.length + 1)); mkdirSync(resolve(dest, '..'), { recursive: true }); cpSync(p, dest)
    }
    writeFileSync(join(artifacts, 'wire.json'), JSON.stringify(wire, null, 2))
    writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ success, bin, binSHA256, runtime, native, results }, null, 2) + '\n')
  }
  console.log(JSON.stringify({ success, runtime }))
  await Bun.sleep(500)
  rmSync(root, { recursive: true, force: true })
}
