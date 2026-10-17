#!/usr/bin/env bun
// Native OpenCode harness for the core-owned plugin (docs/20-opencode.md).
//
// Runs the REAL OpenCode binary against a local synthetic OpenAI-compatible
// provider, with fresh HOME/XDG and an isolated IAPEER root. It never contacts
// production, the fleet daemon or a cloud provider. It exercises the plugin
// through its control socket exactly as the core does and checks the
// observability ABI (events.jsonl/state.json) it produces.
//
//   OPENCODE_BIN=/path/to/opencode bun scripts/opencode-native-harness.ts [--keep]
//     [--seed-config <dir>]
//
// --seed-config copies an already-installed OpenCode config dir (package.json,
// package-lock.json, node_modules with @opencode-ai/plugin) into the fresh HOME.
// Without it the first launch makes OpenCode npm-install that package over the
// network before it loads ANY external plugin — readiness then depends on npm.
//
// Exit 0 ⟺ every check passed. The temp root is printed; --keep retains it.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { composeOpencodeConfig, opencodePaths, OPENCODE_PLUGIN_SOURCE, writeOpencodePlugin } from '../src/opencode/config.ts'
import { opencodeControl } from '../src/opencode/control.ts'

const bin = process.env.OPENCODE_BIN
if (!bin || !existsSync(bin)) {
  console.error('set OPENCODE_BIN to the native opencode executable')
  process.exit(2)
}
const keep = process.argv.includes('--keep')
const root = mkdtempSync('/tmp/iapeer-oc-harness-')
const rootDir = join(root, 'iapeer')
const cwd = join(root, 'cwd')
const home = join(root, 'home')
mkdirSync(cwd, { recursive: true })
mkdirSync(home, { recursive: true })
const seedAt = process.argv.indexOf('--seed-config')
if (seedAt > 0) cpSync(process.argv[seedAt + 1], join(home, 'config', 'opencode'), { recursive: true })
const personality = 'probe'
const identity = `opencode-${personality}`
const paths = opencodePaths(personality, { rootDir })
mkdirSync(paths.dir, { recursive: true })

// ── synthetic provider: "SLOW" in the last user text → a 4 s streamed reply ──
const wire: any[] = []
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const body = await req.json()
    wire.push(body)
    const users = (body.messages ?? []).filter((m: any) => m.role === 'user')
    const last = JSON.stringify(users.at(-1)?.content ?? '')
    const slow = last.includes('SLOW')
    const id = 'chatcmpl-' + wire.length
    const chunk = (delta: any, finish: string | null, usage?: any) =>
      'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n'
    const stream = new ReadableStream({
      async start(c) {
        const enc = new TextEncoder()
        c.enqueue(enc.encode(chunk({ role: 'assistant', content: 'SYNTHETIC_' }, null)))
        if (slow) await Bun.sleep(4000)
        c.enqueue(enc.encode(chunk({ content: 'OK' }, null)))
        c.enqueue(enc.encode(chunk({}, 'stop', { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })))
        c.enqueue(enc.encode('data: [DONE]\n\n'))
        c.close()
      },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
  },
})

// The operator-owned provider config (the place a real NVIDIA config would live).
writeFileSync(
  paths.config,
  JSON.stringify({
    model: 'synthetic/synthetic',
    small_model: 'synthetic/synthetic',
    enabled_providers: ['synthetic'],
    provider: {
      synthetic: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Synthetic',
        options: { baseURL: provider.url.toString() + 'v1', apiKey: 'not-a-secret' },
        models: { synthetic: { name: 'Synthetic', limit: { context: 100000, output: 1000 } } },
      },
    },
  }),
)
writeFileSync(join(cwd, 'AGENTS.md'), 'NATIVE_AGENTS_SENTINEL\n')
writeOpencodePlugin(personality, OPENCODE_PLUGIN_SOURCE, { rootDir })

const results: { check: string; ok: boolean; detail?: unknown }[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`)
}
const readEvents = () =>
  existsSync(paths.events) ? readFileSync(paths.events, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const readState = () => (existsSync(paths.state) ? JSON.parse(readFileSync(paths.state, 'utf8')) : null)
async function until<T>(what: string, f: () => T | undefined | null | false, ms = 20000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = f()
    if (v) return v
    await Bun.sleep(100)
  }
  throw new Error(`timeout waiting for ${what}`)
}

let n = 0
function launch(doctrine: string, session?: string) {
  n++
  const config = composeOpencodeConfig({ personality, doctrine, daemonUrl: 'http://127.0.0.1:9/mcp' }, { rootDir })
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH!,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    PEER_IDENTITY: identity,
    PEER_PERSONALITY: personality,
    PEER_RUNTIME: 'opencode',
    IAPEER_OPENCODE_DIR: paths.dir,
    IAPEER_OPENCODE_LAUNCH_ID: `harness-${n}`,
    ...(session ? { IAPEER_OPENCODE_SESSION: session } : {}),
  }
  const port = 20000 + Math.floor(Math.random() * 20000)
  const p = Bun.spawn([bin!, 'serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'], {
    cwd,
    env,
    stdout: Bun.file(join(root, `stdout-${n}.log`)),
    stderr: Bun.file(join(root, `stderr-${n}.log`)),
  })
  // `serve` builds the directory instance (and so loads plugins) lazily, on the first
  // request for it; the TUI does that at startup. Poke it the way the TUI would.
  void (async () => {
    for (let i = 0; i < 150 && p.exitCode === null; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/config?directory=${encodeURIComponent(cwd)}`)).ok) return
      } catch {}
      await Bun.sleep(200)
    }
  })()
  return p
}
const sock = join(paths.dir, 'control.sock')
/** Native: a SIGTERM during startup can leave `serve` running — escalate like the supervisor. */
async function stop(p: ReturnType<typeof launch>) {
  p.kill('SIGTERM')
  const t = setTimeout(() => p.kill('SIGKILL'), 5000)
  await p.exited
  clearTimeout(t)
}
const userTexts = () => wire.flatMap(b => (b.messages ?? []).filter((m: any) => m.role === 'user').map((m: any) => JSON.stringify(m.content)))

let proc: ReturnType<typeof launch> | undefined
let code = 1
try {
  // 1. fresh launch → runtime.ready with a session, state idle, ping answers
  proc = launch('IAPEER_DOCTRINE_ONE')
  // A COLD config dir makes OpenCode npm-install @opencode-ai/plugin before loading
  // any external plugin (native Config.waitForDependencies) — tens of seconds.
  const t0ready = Date.now()
  const ready1 = await until('runtime.ready #1', () => readEvents().find(e => e.type === 'runtime.ready' && e.launchID === 'harness-1'), 240000)
  console.log(`cold first ready after ${Date.now() - t0ready} ms`)
  check('fresh: runtime.ready resumed=false', ready1.properties.resumed === false, { sessionID: ready1.sessionID })
  const ping = await opencodeControl(sock, { op: 'ping' })
  check('ping answers with the session', ping.ok && ping.sessionID === ready1.sessionID && ping.identity === identity, ping)
  check('state idle after ready', readState()?.status === 'idle', readState())

  // 2. idle delivery → ack carries a messageID that is the persisted native user message
  const d1 = await opencodeControl(sock, { op: 'deliver', text: 'USER_ONE' })
  check('deliver idle: acknowledged', d1.ok === true && typeof d1.messageID === 'string', d1)
  const persisted1 = readEvents().some(e => e.type === 'message.updated' && e.properties?.info?.id === d1.messageID && e.properties.info.role === 'user')
  check('ack only after the user message is persisted (journal has it)', persisted1)
  await until('reply to USER_ONE', () => readEvents().some(e => e.type === 'session.status' && e.properties?.status?.type === 'idle' && e.seq > 0) && userTexts().some(t => t.includes('USER_ONE')))
  check('provider received the doctrine as system prompt', JSON.stringify(wire.at(-1).messages.filter((m: any) => m.role === 'system')).includes('IAPEER_DOCTRINE_ONE'))

  // 3. busy delivery: a second message while a slow turn runs is persisted and processed
  const slow = await opencodeControl(sock, { op: 'deliver', text: 'USER_SLOW' })
  await until('busy state', () => readState()?.status === 'busy', 5000)
  const t0 = Date.now()
  const d3 = await opencodeControl(sock, { op: 'deliver', text: 'USER_WHILE_BUSY' })
  check('deliver busy: acknowledged promptly', d3.ok === true && Date.now() - t0 < 3000, { ...d3, ms: Date.now() - t0 })
  await until('busy message reaches the provider', () => userTexts().some(t => t.includes('USER_WHILE_BUSY')), 20000)
  check('busy message processed after the running turn', slow.ok && userTexts().some(t => t.includes('USER_WHILE_BUSY')))
  await until('idle after busy', () => readState()?.status === 'idle', 20000)

  // 4. interrupt a slow turn
  await opencodeControl(sock, { op: 'deliver', text: 'USER_SLOW_INTERRUPT' })
  await until('busy for interrupt', () => readState()?.status === 'busy', 5000)
  const intr = await opencodeControl(sock, { op: 'interrupt' })
  await until('idle after interrupt', () => readState()?.status === 'idle', 10000)
  check('interrupt stops the turn', intr.ok === true, intr)

  // 5. journal invariants: seq strictly increasing, fence holds
  const ev1 = readEvents()
  const seqOk = ev1.every((e, i) => i === 0 || e.seq === ev1[i - 1].seq + 1)
  check('journal seq contiguous', seqOk, { lines: ev1.length })
  check('state.lastEventSeq ≤ last journal seq (fence)', readState().lastEventSeq <= ev1.at(-1).seq, { state: readState().lastEventSeq, last: ev1.at(-1).seq })

  // 6. full process restart with a NEW doctrine on the SAME session
  const sessionID = ready1.sessionID
  const lastSeqBefore = ev1.at(-1).seq
  await stop(proc)
  proc = launch('IAPEER_DOCTRINE_TWO', sessionID)
  const ready2 = await until('runtime.ready #2', () => readEvents().find(e => e.type === 'runtime.ready' && e.launchID === 'harness-2'), 30000)
  check('resume: same session, resumed=true', ready2.sessionID === sessionID && ready2.properties.resumed === true, { sessionID: ready2.sessionID })
  check('resume: seq continues across the restart', ready2.seq > lastSeqBefore, { before: lastSeqBefore, ready: ready2.seq })
  const d4 = await opencodeControl(sock, { op: 'deliver', text: 'USER_AFTER_RESUME' })
  await until('reply after resume', () => userTexts().some(t => t.includes('USER_AFTER_RESUME')))
  const lastReq = wire.at(-1)
  const sys = JSON.stringify(lastReq.messages.filter((m: any) => m.role === 'system'))
  check('resume: fresh doctrine replaces the old one', d4.ok && sys.includes('IAPEER_DOCTRINE_TWO') && !sys.includes('IAPEER_DOCTRINE_ONE'))
  check('resume: native AGENTS.md still present', sys.includes('NATIVE_AGENTS_SENTINEL'))
  check('resume: earlier history carried', JSON.stringify(lastReq.messages).includes('USER_ONE'))
  code = results.every(r => r.ok) ? 0 : 1
} catch (e) {
  check('harness', false, e instanceof Error ? e.message : String(e))
} finally {
  if (proc) await stop(proc)
  provider.stop(true)
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`${results.filter(r => r.ok).length}/${results.length} passed · root ${root}`)
  if (!keep && code === 0) rmSync(root, { recursive: true, force: true })
}
process.exit(code)
