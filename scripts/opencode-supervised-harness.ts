#!/usr/bin/env bun
// OpenCode adapter harness UNDER THE PTY SUPERVISOR (docs/20-opencode.md).
//
// Unlike opencode-native-harness.ts (plugin mechanics under `opencode serve`), this drives the
// core's own launch path: launch() → opencode adapter prepareLaunch → supervisor-hosted native TUI
// → structuralReady → first message via the structural deliver; then warm delivery through the
// transport (deliverWarm), interrupt through executeControlOnTarget, a supervisor teardown (death
// record), and a resume launch with a new doctrine. Isolated: fresh HOME/XDG, IAPEER_ROOT in a temp
// dir, a local synthetic OpenAI-compatible provider. Never touches the fleet daemon or a cloud API.
//
//   OPENCODE_BIN=/path/to/opencode bun scripts/opencode-supervised-harness.ts \
//     --seed-config <dir with node_modules/@opencode-ai/plugin> [--keep]
//
// Exit 0 ⟺ every check passed.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const bin = process.env.OPENCODE_BIN
if (!bin || !existsSync(bin)) {
  console.error('set OPENCODE_BIN to the native opencode executable')
  process.exit(2)
}
const keep = process.argv.includes('--keep')
const seedAt = process.argv.indexOf('--seed-config')
const root = mkdtempSync('/tmp/iapeer-ocsup-')
const home = join(root, 'home')
const cwd = join(root, 'cwd')
mkdirSync(cwd, { recursive: true })
mkdirSync(home, { recursive: true })
if (seedAt > 0) cpSync(process.argv[seedAt + 1]!, join(home, 'config', 'opencode'), { recursive: true })

// The whole process runs sandboxed: every env-resolved path (supervisor run-dir, control env) lands
// under the temp root, never the real ~/.iapeer.
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: home,
  IAPEER_ROOT: join(root, 'iapeer'),
  IAPEER_PORT: '9', // no daemon in the sandbox: the iapeer MCP is configured but unreachable
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

const { launch } = await import('../src/launch/index.ts')
const { opencodeAdapter } = await import('../src/launch/adapters/opencode.ts')
const { opencodePaths } = await import('../src/opencode/config.ts')
const { hostSessionAlive, killPtyHost } = await import('../src/launch/ptyHost.ts')
const { deliverWarm, executeControlOnTarget } = await import('../src/transport/index.ts')
const { paneLogViewport } = await import('../src/launch/readyGateModel.ts')

const personality = 'probe'
const identity = `opencode-${personality}`
const paths = opencodePaths(personality, { env })
mkdirSync(paths.dir, { recursive: true })

// ── synthetic provider ("SLOW" in the last user text → a 4 s streamed reply) ──
const wire: any[] = []
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const body = await req.json()
    wire.push(body)
    const users = (body.messages ?? []).filter((m: any) => m.role === 'user')
    const slow = JSON.stringify(users.at(-1)?.content ?? '').includes('SLOW')
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
// OC04 self-check fixtures: a memory fragment naming a MISSING plugin and a plugin that THROWS on load.
const boom = join(root, 'boom-plugin.mjs')
writeFileSync(boom, "export default { id: 'boom', server: async () => { throw new Error('PLUGIN_BOOM_SELF') } }\n")
writeFileSync(
  join(paths.dir, 'iapeer-memory.json'),
  JSON.stringify({ plugin: ['file://' + join(root, 'missing-plugin.mjs'), 'file://' + boom] }),
)

const results: { check: string; ok: boolean; detail?: unknown }[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`)
}
const readEvents = (): any[] => (existsSync(paths.events) ? readFileSync(paths.events, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
const readState = () => (existsSync(paths.state) ? JSON.parse(readFileSync(paths.state, 'utf8')) : null)
const userTexts = () => wire.flatMap(b => (b.messages ?? []).filter((m: any) => m.role === 'user').map((m: any) => JSON.stringify(m.content)))
async function until<T>(what: string, f: () => T | undefined | null | false, ms = 20000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = f()
    if (v) return v
    await Bun.sleep(100)
  }
  throw new Error(`timeout waiting for ${what}`)
}

const logDir = join(root, 'iapeer', 'logs', 'lifecycle')
const cfg = {
  claudeBin: 'claude',
  codexBin: 'codex',
  opencodeBin: bin,
  sockDir: join(root, 'sock'),
  bootDeadlineSecs: 90,
  readyGateSecs: 60,
  logDir,
  exitLogDir: join(root, 'iapeer', 'logs', 'iapeer'),
  env,
}
function spec(doctrine: string, resumeRef?: string) {
  const prompt = join(root, `prompt-${Date.now()}.md`)
  writeFileSync(prompt, doctrine)
  return {
    personality,
    runtime: 'opencode',
    cwd,
    identity,
    socketPath: join(root, 'sock', `${identity}.sock`),
    systemPromptFile: prompt,
    intelligence: 'artificial' as const,
    approvalMode: 'yolo' as const,
    ...(resumeRef ? { resume: true, resumeRef } : {}),
  }
}
const target = { runtime: 'opencode', personality, address: identity, socketPath: join(root, 'sock', `${identity}.sock`) }

let code = 1
try {
  // 1. cold launch under the supervisor, first message through structural delivery
  const t0 = Date.now()
  const r1 = await launch(spec('IAPEER_DOCTRINE_ONE'), opencodeAdapter, 'FIRST_MSG', cfg)
  check('launch #1 READY under supervisor', r1.status === 'READY', { ...r1, ms: Date.now() - t0 })
  check('hosted session alive', hostSessionAlive(identity, env))
  const w = (readEvents().find(e => e.type === 'runtime.ready')?.properties?.warnings ?? []) as string[]
  check('self-check: unreachable MCP reported (never silent)', w.some(x => /^mcp iapeer: failed/.test(x)), w)
  check('self-check: missing fragment plugin reported', w.some(x => x.startsWith('plugin missing:') && x.includes('missing-plugin.mjs')), w)
  check('self-check: throwing fragment plugin reported', w.some(x => x.startsWith('plugin failed:') && x.includes('boom-plugin')), w)
  check('self-check warnings also in state.json', (readState()?.warnings ?? []).length === w.length && w.length > 0)
  const lc = existsSync(join(root, 'iapeer', 'logs', 'iapeer', 'lifecycle.log')) ? readFileSync(join(root, 'iapeer', 'logs', 'iapeer', 'lifecycle.log'), 'utf8') : ''
  check('self-check warnings recorded as ev=launch-warning', (lc.match(/ev=launch-warning/g) ?? []).length >= w.length)
  const ready1 = readEvents().find(e => e.type === 'runtime.ready')
  check('runtime.ready fresh (resumed=false) with a session', ready1?.properties?.resumed === false && typeof ready1?.sessionID === 'string', ready1?.sessionID)
  await until('FIRST_MSG reaches the provider', () => userTexts().some(t => t.includes('FIRST_MSG')), 30000)
  const sys1 = JSON.stringify(wire.at(-1).messages.filter((m: any) => m.role === 'system'))
  check('doctrine ONE is the system prompt; native AGENTS.md kept', sys1.includes('IAPEER_DOCTRINE_ONE') && sys1.includes('NATIVE_AGENTS_SENTINEL'))
  await until('idle after first turn', () => readState()?.status === 'idle', 20000)

  // 2. warm delivery through the transport (structural path; no pty paste)
  const w1 = await deliverWarm(target, 'WARM_ONE', cwd, {}, env)
  check('deliverWarm idle ok', w1.ok, w1)
  await until('WARM_ONE processed', () => userTexts().some(t => t.includes('WARM_ONE')), 20000)

  // 3. busy queue: deliver during a slow turn → acked promptly, processed after
  const slow = await deliverWarm(target, 'SLOW_TURN', cwd, {}, env)
  await until('busy', () => readState()?.status === 'busy', 8000)
  const tb = Date.now()
  const busy = await deliverWarm(target, 'WHILE_BUSY', cwd, {}, env)
  check('deliverWarm while busy acked promptly', slow.ok && busy.ok && Date.now() - tb < 3000, { ms: Date.now() - tb })
  await until('WHILE_BUSY processed after the slow turn', () => userTexts().some(t => t.includes('WHILE_BUSY')), 20000)
  await until('idle after busy', () => readState()?.status === 'idle', 20000)

  // 4. interrupt through the control path
  await deliverWarm(target, 'SLOW_INTERRUPT', cwd, {}, env)
  await until('busy for interrupt', () => readState()?.status === 'busy', 8000)
  const intr = await executeControlOnTarget(target, { name: 'interrupt' })
  await until('idle after interrupt', () => readState()?.status === 'idle', 10000)
  check('interrupt via control', intr.ok, intr)
  const unsupported = await executeControlOnTarget(target, { name: 'goal' })
  check('unsupported control fails loud', !unsupported.ok, unsupported)

  // 4b. compact: native summary turn → session.compacted recorded → ack; the dialogue continues
  const seqC = readEvents().at(-1).seq
  const wireBefore = wire.length
  const compact = await executeControlOnTarget(target, { name: 'compact' })
  const compacted = readEvents().find(e => e.seq > seqC && e.type === 'session.compacted')
  check('compact: acked only with a native session.compacted record', compact.ok && !!compacted, compact)
  check('compact: ran a native summary turn at the provider', wire.length > wireBefore)
  const wc = await deliverWarm(target, 'AFTER_COMPACT', cwd, {}, env)
  await until('AFTER_COMPACT processed', () => userTexts().some(t => t.includes('AFTER_COMPACT')), 20000)
  const afterMsgs = JSON.stringify(wire.at(-1).messages)
  check('after compact: dialogue continues on a compacted history', wc.ok && !afterMsgs.includes('WHILE_BUSY'), { messages: wire.at(-1).messages.length })
  await until('idle after compact', () => readState()?.status === 'idle', 20000)

  // 5. the TUI is the attach surface and shows the core's session
  await Bun.sleep(1500)
  const view = await paneLogViewport(join(logDir, `${identity}.log`), 220, 50, 0)
  check('TUI renders the core session (WARM_ONE visible in the pane)', !!view && /WARM_ONE|WHILE_BUSY|SLOW_INTERRUPT/.test(view), view?.split('\n').filter(Boolean).slice(-8))

  // 6. teardown by the supervisor → the core records the death
  const sessionID = ready1.sessionID
  const seqBefore = readEvents().at(-1).seq
  killPtyHost(identity, env)
  await until('session gone', () => !hostSessionAlive(identity, env), 15000)
  const stopped = await until('runtime.stopped', () => readEvents().find(e => e.type === 'runtime.stopped' && e.seq > seqBefore), 5000)
  check('runtime.stopped recorded on teardown', !!stopped && readState()?.status === 'stopped', stopped?.properties)
  const ev = readEvents()
  check('journal seq contiguous', ev.every((e, i) => i === 0 || e.seq === ev[i - 1].seq + 1), { lines: ev.length })

  // 7. resume with a new doctrine on the same session
  const rr = opencodeAdapter.resolveResume(cwd, { personality, env })
  check('resolveResume → recorded session', rr.ok && rr.ref === sessionID, rr)
  const r2 = await launch(spec('IAPEER_DOCTRINE_TWO', rr.ref), opencodeAdapter, 'AFTER_RESUME', cfg)
  check('launch #2 (resume) READY', r2.status === 'READY', r2)
  const ready2 = readEvents().filter(e => e.type === 'runtime.ready').at(-1)
  check('resume: same session, resumed=true', ready2?.sessionID === sessionID && ready2?.properties?.resumed === true, ready2?.sessionID)
  await until('AFTER_RESUME processed', () => userTexts().some(t => t.includes('AFTER_RESUME')), 30000)
  const last = wire.at(-1)
  const sys2 = JSON.stringify(last.messages.filter((m: any) => m.role === 'system'))
  check('resume: doctrine TWO replaces ONE', sys2.includes('IAPEER_DOCTRINE_TWO') && !sys2.includes('IAPEER_DOCTRINE_ONE'))
  check('resume: earlier (post-compact) history carried', JSON.stringify(last.messages).includes('AFTER_COMPACT'))
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
