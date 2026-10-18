// Native Claude/OpenCode + synthetic local provider, installed daemon/CLI/supervisors.
// Source code only sets up fixtures and READS native records; routing/sweeps run inside the binary.
// bun scripts/proof-installed-inflight.ts --runtime claude|opencode --bin ~/.local/bin/iapeer \
//   [--native /path/to/runtime] [--seed-config <OpenCode config with SDK modules>] --artifacts <dir>
// Anthropic wire fixture: https://platform.claude.com/docs/en/build-with-claude/streaming
// Provider routing: https://code.claude.com/docs/en/env-vars (checked 2026-10-18).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileSHA256 } from './proof-installed-lib.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const runtime = arg('--runtime')
if (runtime !== 'claude' && runtime !== 'opencode') throw new Error('set --runtime claude|opencode')
const hostHome = homedir(), bin = resolve(arg('--bin') ?? join(hostHome, '.local/bin/iapeer'))
const binSHA256 = fileSHA256(bin)
const native = resolve(arg('--native') ?? join(hostHome, runtime === 'claude' ? '.local/bin/claude' : '.opencode/bin/opencode'))
const artifacts = arg('--artifacts'), root = mkdtempSync('/tmp/iap-installed-inflight-')
const home = join(root, 'home'), iap = join(root, 'iapeer'), cwd = join(root, 'turn-proof')
mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true })
const seed = arg('--seed-config')
if (seed) cpSync(seed, join(home, 'config/opencode'), { recursive: true })
let hanging = false, requestID = 0
const wire: unknown[] = []
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body: any = await req.json().catch(() => ({}))
  wire.push({ path: new URL(req.url).pathname, body })
  if (new URL(req.url).pathname.includes('count_tokens')) return Response.json({ input_tokens: 100 })
  const id = ++requestID
  if (runtime === 'opencode') {
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: `chatcmpl-${id}`, object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'
    const first = chunk({ role: 'assistant', content: hanging ? 'STILL WORKING' : 'FINISHED' }, null)
    return new Response(hanging ? new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(first)) } }) : first + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const text = hanging ? 'STILL WORKING' : 'FINISHED'
  const content: Array<{ type: 'tool_use'; id: string; name: string; input: { command: string; timeout: number; description: string } } | { type: 'text'; text: string }> = hanging ? [{ type: 'tool_use', id: `toolu_${id}`, name: 'Bash', input: { command: '/bin/sleep 180', timeout: 300000, description: 'Synthetic interrupted-turn probe' } }] : [{ type: 'text', text }]
  const message = { id: `msg_${id}`, type: 'message', role: 'assistant', model: body.model ?? 'claude-sonnet-4-5', content, stop_reason: hanging ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }
  if (!body.stream) return Response.json(message)
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  let stream = event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } })
  for (const [index, block] of content.entries()) {
    stream += event('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
    stream += event('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text } })
    stream += event('content_block_stop', { type: 'content_block_stop', index })
  }
  stream += event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } })
  stream += event('message_stop', { type: 'message_stop' })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
} })
const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('reserve') } })
const port = reserve.port!; reserve.stop(true)
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', IAPEER_ROOT: iap,
  IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'), IAPEER_SOCK_DIR: join(root, 's'),
  IAPEER_PORT: String(port), IAPEER_DAEMON_SOCKET: join(root, 'router.sock'),
  IAPEER_CLAUDE_BIN: native, IAPEER_OPENCODE_BIN: native,
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
const { startSupervisorDaemon, sessionAlive } = await import('../src/supervisor/index.ts')
const { readInflight } = await import('../src/lifecycle/inflight.ts')
const { deliveryCompleted, deliveryProcessed } = await import('../src/transport/index.ts')
const { opencodePaths } = await import('../src/opencode/config.ts')
const runDir = join(iap, 'state/supervisor'), stateDir = join(iap, 'state/lifecycle')
const personality = 'turn-proof', identity = `${runtime}-${personality}`, sender = 'notifier-sender', sinkLog = join(root, 'sender.log')
const snapshots: unknown[] = []
let daemon: ReturnType<typeof Bun.spawn> | undefined, success = false
const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]) : []
const until = async (what: string, f: () => unknown | Promise<unknown>, ms = 120000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await f()) return; await Bun.sleep(200) }
  throw new Error(`timeout: ${what}`)
}
const noticeCount = () => (read(join(iap, 'logs/iapeer/delivery.log')).match(/ev=inflight-interrupted\b/g) ?? []).length
const cli = async (...args: string[]) => {
  const p = Bun.spawn([bin, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code, stdout, stderr }
}
const send = async (message: string) => {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, { proxy: '', method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-IAPeer-Identity': sender },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_to_peer', arguments: { personality, runtime, message, topic: 'installed-native' } } }) })
  const raw = await r.text(), data = JSON.parse(raw.startsWith('{') ? raw : raw.split('\n').find(l => l.startsWith('data:'))!.slice(5))
  snapshots.push({ phase: 'send', message, response: data })
  if (data.result?.isError || !data.result) throw new Error(raw)
}
const kill = async () => {
  const result = await cli('supervisor', 'kill', identity, '--run-dir', runDir)
  if (result.code) throw new Error(result.stderr)
  await until('native receiver gone', () => !sessionAlive(runDir, identity), 10000)
}
try {
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true }))
  await initPeer({ cwd, runtime, personality, intelligence: 'artificial', env })
  if (runtime === 'opencode') {
    const paths = opencodePaths(personality, { env })
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(paths.config, JSON.stringify({ model: 'synthetic/synthetic', small_model: 'synthetic/synthetic', enabled_providers: ['synthetic'], provider: {
      synthetic: { npm: '@ai-sdk/openai-compatible', name: 'Synthetic', options: { baseURL: provider.url.origin + '/v1', apiKey: 'x' }, models: { synthetic: { name: 'Synthetic', limit: { context: 100000, output: 1000 } } } },
    } }))
  }
  const senderCwd = join(root, 'sender')
  writePeerProfileAtomic(senderCwd, { personality: 'sender', runtime: 'notifier', runtimes: ['notifier'], intelligence: 'absent' })
  await upsertPeer({ personality: 'sender', runtime: 'notifier', intelligence: 'absent', cwd: senderCwd }, { env })
  const sink = await startSupervisorDaemon({ session: sender, runtime: 'notifier', runDir, daemonArgv: [bin, 'supervisor'], serve: { argv: ['/bin/cat'], env: {}, cwd: root, paneLogPath: sinkLog } })
  if (sink.state !== 'started') throw new Error(JSON.stringify(sink))
  daemon = Bun.spawn([bin, 'daemon'], { env, stdout: Bun.file(join(root, 'daemon.out')), stderr: Bun.file(join(root, 'daemon.err')) })
  await until('installed daemon listening', () => read(join(root, 'daemon.err')).includes('daemon READY'), 15000)
  await send('FINISHED_TURN_PROOF')
  await until('native terminal record', () => readInflight(stateDir, identity).some(e => deliveryCompleted(e, env)))
  snapshots.push({ phase: 'native-finished', entries: readInflight(stateDir, identity) })
  await kill()
  await until('finished ledger settled by installed daemon', () => readInflight(stateDir, identity).length === 0, 90000)
  if (noticeCount() || read(sinkLog).includes('INTERRUPTED')) throw new Error('finished turn generated notice')
  snapshots.push({ phase: 'finished-kill', noticeCount: noticeCount() })
  hanging = true
  await send('UNFINISHED_TURN_PROOF')
  await until('native turn started but unfinished', () => readInflight(stateDir, identity).some(e => deliveryProcessed(e, env) && !deliveryCompleted(e, env)))
  snapshots.push({ phase: 'native-unfinished', entries: readInflight(stateDir, identity) })
  await kill()
  await until('one installed interruption notice', () => noticeCount() === 1 && read(sinkLog).includes('INTERRUPTED'), 90000)
  await Bun.sleep(65000)
  if (noticeCount() !== 1) throw new Error('duplicate interruption notice')
  snapshots.push({ phase: 'mid-turn-kill-two-ticks', noticeCount: noticeCount(), sink: read(sinkLog) })
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
    writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ success, bin, binSHA256, runtime, native, snapshots }, null, 2) + '\n')
  }
  console.log(JSON.stringify({ success, runtime, snapshots }, null, 2))
  await Bun.sleep(500)
  rmSync(root, { recursive: true, force: true })
}
