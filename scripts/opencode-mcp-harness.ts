#!/usr/bin/env bun
// OpenCode tool calls + the core MCP, end to end (docs/20-opencode.md, OC02/OC03/OC12 slices).
//
// A sandboxed iapeer daemon runs IN-PROCESS (startConfiguredDaemon, temp IAPEER_ROOT, own port and
// socket — never the fleet's). Two registered opencode peers, `ocsend` and `ocrecv`. A scripted
// synthetic provider makes ocsend's model (1) call the native `bash` tool, then (2) call the core
// MCP tool `send_to_peer` to ocrecv. The daemon resolves the caller from OpenCode's
// X-IAPeer-Identity header, wakes ocrecv on miss (cold inbound) and delivers the envelope through
// the structural path. Never touches launchd, the fleet daemon or a cloud API.
//
//   OPENCODE_BIN=/path/to/opencode bun scripts/opencode-mcp-harness.ts \
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
const root = mkdtempSync('/tmp/iapeer-ocmcp-')
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
if (seedAt > 0) cpSync(process.argv[seedAt + 1]!, join(home, 'config', 'opencode'), { recursive: true })
const port = 31000 + Math.floor(Math.random() * 3000)
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: home,
  IAPEER_ROOT: join(root, 'iapeer'),
  IAPEER_PORT: String(port),
  IAPEER_OPENCODE_BIN: bin,
  IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'),
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

const { startConfiguredDaemon } = await import('../src/daemon/main.ts')
const { initPeer } = await import('../src/init/index.ts')
const { wakeOrSpawn } = await import('../src/lifecycle/index.ts')
const { opencodePaths } = await import('../src/opencode/config.ts')
const { killPtyHost } = await import('../src/launch/ptyHost.ts')

const results: { check: string; ok: boolean; detail?: unknown }[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`)
}
async function until<T>(what: string, f: () => T | undefined | null | false, ms = 30000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = f()
    if (v) return v
    await Bun.sleep(200)
  }
  throw new Error(`timeout waiting for ${what}`)
}

// ── scripted provider ─────────────────────────────────────────────────────────
const marker = join(root, 'tool-marker.txt')
const wire: { who: string; body: any }[] = []
const toolNames = (b: any): string[] => (b.tools ?? []).map((t: any) => t.function?.name ?? t.name).filter(Boolean)
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const body = await req.json()
    const sys = JSON.stringify((body.messages ?? []).filter((m: any) => m.role === 'system'))
    // The registry layer lists EVERY peer, so match the identity YAML line, not a bare name.
    const who = sys.includes('personality: \\"ocsend\\"') ? 'ocsend' : sys.includes('personality: \\"ocrecv\\"') ? 'ocrecv' : 'other'
    wire.push({ who, body })
    const id = 'chatcmpl-' + wire.length
    const sse = (delta: any, finish: string | null) =>
      'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'
    const msgs = body.messages ?? []
    const last = msgs.at(-1)
    const toolCall = (name: string, args: object) =>
      new Response(
        sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + wire.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null) +
          sse({}, 'tool_calls') +
          'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    const text = (t: string) => new Response(sse({ role: 'assistant', content: t }, null) + sse({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    if (who === 'ocsend') {
      const toolMsgs = msgs.filter((m: any) => m.role === 'tool').length
      const wantsTools = msgs.some((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('DO_TOOLS'))
      if (wantsTools && last?.role !== 'assistant') {
        const names = toolNames(body)
        if (toolMsgs === 0) return toolCall(names.find(n => n === 'bash') ?? 'bash', { command: `echo TOOL_OK > ${marker}`, description: 'write marker' })
        if (toolMsgs === 1) {
          const send = names.find(n => n.includes('send_to_peer'))
          if (send) return toolCall(send, { personality: 'ocrecv', message: 'HELLO_FROM_OC', topic: 'mcp-probe' })
        }
        return text('DONE_TOOLS')
      }
    }
    return text('OK')
  },
})
const providerConfig = JSON.stringify({
  model: 'synthetic/synthetic',
  small_model: 'synthetic/synthetic',
  enabled_providers: ['synthetic'],
  provider: {
    synthetic: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Synthetic',
      options: { baseURL: provider.url.toString() + 'v1', apiKey: 'x' },
      models: { synthetic: { name: 'Synthetic', tool_call: true, limit: { context: 100000, output: 1000 } } },
    },
  },
})

let daemon: Awaited<ReturnType<typeof startConfiguredDaemon>> | undefined
let code = 1
try {
  daemon = await startConfiguredDaemon({ port, socketPath: join(root, 'router.sock'), env })
  check('sandbox daemon up', daemon.url.includes(String(port)), daemon.url)
  for (const p of ['ocsend', 'ocrecv']) {
    const cwd = join(root, p)
    mkdirSync(cwd, { recursive: true })
    await initPeer({ cwd, runtime: 'opencode', personality: p, description: `${p} probe`, intelligence: 'artificial', env })
    mkdirSync(opencodePaths(p, { env }).dir, { recursive: true })
    writeFileSync(opencodePaths(p, { env }).config, providerConfig)
  }
  check('preinstall satisfied from the seeded config (no npm on wake)', existsSync(join(home, 'config', 'opencode', 'node_modules')))

  const w = await wakeOrSpawn({ personality: 'ocsend', runtime: 'opencode', task: 'DO_TOOLS please', topic: 'mcp-probe' }, { env })
  check('ocsend woke with the task', w.status === 'READY' && w.taskDelivered !== false, w)

  const first = await until('ocsend request with tools', () => wire.find(x => x.who === 'ocsend' && toolNames(x.body).length > 0))
  const names = toolNames(first.body)
  check('MCP imported: send_to_peer offered next to native bash', names.includes('bash') && names.some(n => n.includes('send_to_peer')), names)

  await until('bash tool executed', () => existsSync(marker), 30000)
  check('native bash tool ran', readFileSync(marker, 'utf8').trim() === 'TOOL_OK')

  const recv = await until('ocrecv receives HELLO_FROM_OC', () => wire.find(x => x.who === 'ocrecv' && JSON.stringify(x.body.messages).includes('HELLO_FROM_OC')), 60000)
  const envelope = JSON.stringify(recv.body.messages)
  check('cold inbound: ocrecv woken by the daemon and got the message', true)
  check('per-request identity: envelope names the opencode sender', /from=\\?"ocsend\\?"/.test(envelope) && /runtime=\\?"opencode\\?"/.test(envelope), envelope.match(/<iap[^>]{0,200}/)?.[0])

  await until('ocsend finished its turn', () => wire.some(x => x.who === 'ocsend' && x.body.messages.filter((m: any) => m.role === 'tool').length >= 2), 30000)
  const sendTool = wire.filter(x => x.who === 'ocsend').at(-1)!.body.messages.filter((m: any) => m.role === 'tool').at(-1)
  const sendResult = (() => {
    try {
      return JSON.parse(typeof sendTool.content === 'string' ? sendTool.content : JSON.stringify(sendTool.content))
    } catch {
      return null
    }
  })()
  check('send_to_peer tool result: ok, delivered to ocrecv/opencode', sendResult?.ok === true && sendResult?.delivered_to?.personality === 'ocrecv' && sendResult?.delivered_to?.runtime === 'opencode', sendResult)

  const ev = readFileSync(opencodePaths('ocsend', { env }).events, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const toolParts = ev.filter(e => e.type === 'message.part.updated' && e.properties?.part?.type === 'tool' && e.properties.part.state?.status === 'completed').map(e => e.properties.part.tool)
  check('journal carries completed tool parts (observability)', toolParts.includes('bash') && toolParts.some((t: string) => t.includes('send_to_peer')), [...new Set(toolParts)])

  const delivery = readFileSync(join(root, 'iapeer', 'logs', 'iapeer', 'delivery.log'), 'utf8')
  check('delivery.log records the opencode→opencode send', /opencode-ocsend|from=ocsend/.test(delivery) && /ocrecv/.test(delivery), delivery.trim().split('\n').slice(-2))
  code = results.every(r => r.ok) ? 0 : 1
} catch (e) {
  check('harness', false, e instanceof Error ? e.message : String(e))
} finally {
  for (const p of ['ocsend', 'ocrecv']) {
    try {
      killPtyHost(`opencode-${p}`, env)
    } catch {}
  }
  await daemon?.close().catch(() => {})
  provider.stop(true)
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`${results.filter(r => r.ok).length}/${results.length} passed · root ${root}`)
  if (!keep && code === 0) rmSync(root, { recursive: true, force: true })
}
process.exit(code)
