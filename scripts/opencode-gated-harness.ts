#!/usr/bin/env bun
// OpenCode gated approval end to end (docs/17, docs/20 OC10). A sandboxed daemon runs IN-PROCESS
// (it owns the approval broker); one registered opencode peer in `gated` mode. A scripted synthetic
// provider makes the model call native `bash`; OpenCode raises a native permission ask; the core
// plugin bridges it to POST /fleet/v1/approvals; this harness plays the human face.
//   allow   → the command runs;           deny → it does not, the model sees the rejection;
//   timeout → broker default-deny;         race → the human answers in the native TUI first and the
//                                                 broker card disappears from every face.
//
//   OPENCODE_BIN=/path/to/opencode bun scripts/opencode-gated-harness.ts \
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
const root = mkdtempSync('/tmp/iapeer-ocgate-')
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
if (seedAt > 0) cpSync(process.argv[seedAt + 1]!, join(home, 'config', 'opencode'), { recursive: true })
const port = 34000 + Math.floor(Math.random() * 3000)
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: home,
  IAPEER_ROOT: join(root, 'iapeer'),
  IAPEER_PORT: String(port),
  IAPEER_OPENCODE_BIN: bin,
  IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'),
  IAPEER_APPROVAL_TIMEOUT_MS: '8000',
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_DATA_HOME: join(home, 'data'),
  XDG_CACHE_HOME: join(home, 'cache'),
  XDG_STATE_HOME: join(home, 'state'),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
  HOMEBREW_NO_AUTO_UPDATE: '1',
}
for (const k of Object.keys(process.env)) delete process.env[k]
Object.assign(process.env, env)

const { startConfiguredDaemon } = await import('../src/daemon/main.ts')
const { initPeer } = await import('../src/init/index.ts')
const { setApprovalMode } = await import('../src/approval/install.ts')
const { wakeOrSpawn } = await import('../src/lifecycle/index.ts')
const { opencodePaths } = await import('../src/opencode/config.ts')
const { opencodeAdapter } = await import('../src/launch/adapters/opencode.ts')
const { killPtyHost, resubmitHosted } = await import('../src/launch/ptyHost.ts')

const personality = 'ocgate'
const identity = `opencode-${personality}`
const results: { check: string; ok: boolean; detail?: unknown }[] = []
function check(name: string, ok: boolean, detail?: unknown) {
  results.push({ check: name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`)
}
async function until<T>(what: string, f: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 30000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await f()
    if (v) return v
    await Bun.sleep(200)
  }
  throw new Error(`timeout waiting for ${what}`)
}
const marker = (tag: string) => join(root, `ran-${tag}.txt`)

const wire: any[] = []
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const body = await req.json()
    wire.push(body)
    const id = 'chatcmpl-' + wire.length
    const sse = (delta: any, finish: string | null) =>
      'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'
    const msgs = body.messages ?? []
    const last = msgs.at(-1)
    const tag = last?.role === 'user' ? JSON.stringify(last.content).match(/RUN_BASH (\w+)/)?.[1] : undefined
    const out = tag
      ? sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + wire.length, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `echo ${tag} > ${marker(tag)}`, description: `gated ${tag}` }) } }] }, null) + sse({}, 'tool_calls')
      : sse({ role: 'assistant', content: 'DONE' }, null) + sse({}, 'stop')
    return new Response(out + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  },
})

const fleet = `http://127.0.0.1:${port}`
const pending = async (): Promise<any[]> => ((await (await fetch(`${fleet}/fleet/v1/approvals`)).json()) as any).approvals.filter((a: any) => a.personality === personality)
const events = (): any[] => readFileSync(opencodePaths(personality, { env }).events, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const replied = (reply: string, after: number) => events().find(e => e.seq > after && e.type === 'permission.replied' && e.properties?.reply === reply)
const toolResultFor = (tag: string) =>
  wire.flatMap(b => b.messages ?? []).filter((m: any) => m.role === 'tool').map((m: any) => JSON.stringify(m.content)).find((c: string) => c.length > 0 && wire.length > 0 && c !== undefined && (c.includes(tag) || /reject|denied|permission/i.test(c)))
async function decide(id: string, action: 'approve' | 'deny') {
  return (await fetch(`${fleet}/fleet/v1/approvals/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify({ via: 'harness', reason: `harness ${action}` }) })).json()
}
async function ask(tag: string) {
  const seq = events().at(-1)?.seq ?? 0
  const d = await opencodeAdapter.deliver!({ personality, identity }, `RUN_BASH ${tag}`, env)
  if (!d.ok) throw new Error(`deliver ${tag}: ${d.error}`)
  const card = await until(`broker card for ${tag}`, async () => (await pending()).find((a: any) => JSON.stringify(a).includes(tag)), 20000)
  return { card, seq }
}

let daemon: Awaited<ReturnType<typeof startConfiguredDaemon>> | undefined
let code = 1
try {
  daemon = await startConfiguredDaemon({ port, socketPath: join(root, 'router.sock'), env })
  const cwd = join(root, personality)
  mkdirSync(cwd, { recursive: true })
  await initPeer({ cwd, runtime: 'opencode', personality, description: 'gated probe', intelligence: 'artificial', env })
  const toggle = setApprovalMode(cwd, 'gated', env)
  check('approval-mode gated reports the opencode launch-time surface', toggle.surfaces.some(s => s.startsWith('opencode: launch-time ask rules')), toggle.surfaces)
  mkdirSync(opencodePaths(personality, { env }).dir, { recursive: true })
  writeFileSync(
    opencodePaths(personality, { env }).config,
    JSON.stringify({
      model: 'synthetic/synthetic',
      small_model: 'synthetic/synthetic',
      enabled_providers: ['synthetic'],
      provider: { synthetic: { npm: '@ai-sdk/openai-compatible', name: 'Synthetic', options: { baseURL: provider.url.toString() + 'v1', apiKey: 'x' }, models: { synthetic: { name: 'Synthetic', tool_call: true, limit: { context: 100000, output: 1000 } } } } },
    }),
  )
  const w = await wakeOrSpawn({ personality, runtime: 'opencode', task: 'hello' }, { env })
  check('gated peer woke', w.status === 'READY', w)
  await until('first turn done', () => wire.length > 0 && JSON.parse(readFileSync(opencodePaths(personality, { env }).state, 'utf8')).status === 'idle', 20000)

  // allow
  {
    const { card, seq } = await ask('allowed')
    check('card: runtime opencode, tool bash, summary names the command', card.runtime === 'opencode' && card.tool === 'bash' && /echo allowed/.test(card.summary ?? card.content), { runtime: card.runtime, tool: card.tool, summary: card.summary })
    check('nothing ran before the decision', !existsSync(marker('allowed')))
    await decide(card.id, 'approve')
    await until('allowed command ran', () => existsSync(marker('allowed')), 15000)
    check('allow → command ran, native reply once', !!replied('once', seq))
  }
  // deny
  {
    const { card, seq } = await ask('denied')
    await decide(card.id, 'deny')
    await until('native reject', () => replied('reject', seq), 15000)
    await Bun.sleep(1500)
    check('deny → command did not run, native reply reject', !existsSync(marker('denied')))
    const errPart = events().find(e => e.seq > seq && e.type === 'message.part.updated' && e.properties?.part?.tool === 'bash' && e.properties.part.state?.status === 'error')
    check('deny → the bash tool part ends in error (model sees the refusal)', !!errPart, errPart?.properties?.part?.state?.error)
  }
  // timeout → default-deny
  {
    const { seq } = await ask('timedout')
    await until('default-deny reject', () => replied('reject', seq), 20000)
    check('timeout → broker default-deny → reject, command did not run', !existsSync(marker('timedout')))
    check('timed-out card is gone from the faces', (await pending()).length === 0)
  }
  // race: the human answers the native TUI prompt first
  {
    const { seq } = await ask('raced')
    await Bun.sleep(1000)
    await resubmitHosted(identity, env) // Enter on the native permission prompt (default: allow once)
    const r = await until('native reply from the TUI', () => events().find(e => e.seq > seq && e.type === 'permission.replied'), 10000).catch(() => null)
    check('human answered in the TUI', !!r, r?.properties)
    await until('card withdrawn', async () => (await pending()).length === 0, 10000).catch(() => {})
    check('broker card withdrawn after the native answer', (await pending()).length === 0)
    const extra = events().filter(e => e.seq > seq && e.type === 'permission.replied').length
    check('exactly one native reply (no double answer)', extra === 1, extra)
  }
  const approvalsLog = readFileSync(join(root, 'iapeer', 'logs', 'iapeer', 'approvals.log'), 'utf8')
  check('approvals.log audits the opencode requests', (approvalsLog.match(/runtime=opencode/g) ?? []).length >= 4, approvalsLog.trim().split('\n').length)
  code = results.every(r => r.ok) ? 0 : 1
} catch (e) {
  check('harness', false, e instanceof Error ? e.message : String(e))
} finally {
  try {
    killPtyHost(identity, env)
  } catch {}
  await daemon?.close().catch(() => {})
  provider.stop(true)
  writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`${results.filter(r => r.ok).length}/${results.length} passed · root ${root}`)
  if (!keep && code === 0) rmSync(root, { recursive: true, force: true })
}
process.exit(code)
void toolResultFor
