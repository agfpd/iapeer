// Real OpenCode + synthetic streaming provider, isolated root. No cloud calls or fleet traffic.
// OPENCODE_BIN=... bun scripts/proof-inflight-turns.ts --seed-config <opencode config dir> [--keep]
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const bin = process.env.OPENCODE_BIN
if (!bin || !existsSync(bin)) throw new Error('set OPENCODE_BIN')
const root = mkdtempSync('/tmp/iap-inflight-live-')
const home = join(root, 'home')
const env = { PATH: process.env.PATH, HOME: home, IAPEER_ROOT: join(root, 'iapeer'), IAPEER_PORT: '9',
  IAPEER_OPENCODE_BIN: bin, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
  XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', HOMEBREW_NO_AUTO_UPDATE: '1' }
mkdirSync(home, { recursive: true })
const seed = process.argv.indexOf('--seed-config')
if (seed >= 0) cpSync(process.argv[seed + 1]!, join(home, 'config/opencode'), { recursive: true })
for (const k of Object.keys(process.env)) delete process.env[k]
Object.assign(process.env, env)
const { initPeer } = await import('../src/init/index.ts')
const { loadLifecycleConfig, wakeOrSpawn } = await import('../src/lifecycle/index.ts')
const { routeSend, deliveryProcessed, deliveryCompleted } = await import('../src/transport/index.ts')
const { makeNoteInflight, processInflight } = await import('../src/daemon/main.ts')
const { readInflight } = await import('../src/lifecycle/inflight.ts')
const { opencodePaths } = await import('../src/opencode/config.ts')
const { killPtyHost, hostSessionAlive } = await import('../src/launch/ptyHost.ts')
const { ok } = await import('../src/core/errors.ts')
const cfg = loadLifecycleConfig(env)
const personality = 'turn-proof', identity = `opencode-${personality}`, cwd = join(root, personality)
mkdirSync(cwd, { recursive: true })
let hanging = false
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  await req.json()
  const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'proof', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'
  const initial = chunk({ role: 'assistant', content: hanging ? 'STILL WORKING' : 'FINISHED' }, null)
  return new Response(hanging ? new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(initial)) } }) : initial + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
} })
const notices: string[] = []
const sink = (async (_caller: unknown, input: { message: string; personality: string }) => {
  notices.push(input.message)
  return ok({ ok: true, delivered_to: { personality: input.personality, runtime: 'codex' }, woke: false, ts: 'x' })
}) as never
const until = async (what: string, f: () => boolean) => {
  for (let i = 0; i < 300; i++) { if (f()) return; await Bun.sleep(100) }
  throw new Error(`timeout: ${what}`)
}
const snapshots: unknown[] = []
let success = false
try {
  await initPeer({ cwd, runtime: 'opencode', personality, intelligence: 'artificial', env })
  const paths = opencodePaths(personality, { env })
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.config, JSON.stringify({ model: 'synthetic/synthetic', small_model: 'synthetic/synthetic', enabled_providers: ['synthetic'], provider: {
    synthetic: { npm: '@ai-sdk/openai-compatible', name: 'Synthetic', options: { baseURL: provider.url.toString() + 'v1', apiKey: 'x' }, models: { synthetic: { name: 'Synthetic', limit: { context: 100000, output: 1000 } } } },
  } }))
  const caller = { personality: 'sender', runtime: 'codex', address: 'codex-sender', intelligence: 'artificial', cwd, description: '', record: { personality: 'sender', runtime: 'codex', runtimes: ['codex'], intelligence: 'artificial', cwd } } as never
  const deps = { env, wake: (args: never) => wakeOrSpawn(args, { cfg, env }), noteInflight: makeNoteInflight(cfg) }
  const send = async (message: string) => {
    const r = await routeSend(caller, { personality, runtime: 'opencode', message }, deps)
    if (!r.ok) throw r.error
    return r.value
  }
  snapshots.push({ phase: 'finished-send', ack: await send('FINISHED_TURN_PROOF') })
  await until('native terminal record', () => readInflight(cfg.stateDir, identity).some(e => deliveryCompleted(e, env)))
  snapshots.push({ phase: 'native-completed', entries: readInflight(cfg.stateDir, identity).map(e => ({ id: e.id, processed: deliveryProcessed(e, env), completed: deliveryCompleted(e, env) })) })
  // Do not sweep before killing: completion must still be recognized after the receiver is gone.
  killPtyHost(identity, env, { reason: 'proof-kill-after-native-completion' })
  await until('finished receiver gone', () => !hostSessionAlive(identity, env))
  await processInflight(cfg, env, deps, { send: sink })
  if (notices.length || readInflight(cfg.stateDir, identity).length) throw new Error('finished turn generated notice or retained ledger')
  snapshots.push({ phase: 'kill-after-finish', noticeCount: notices.length })

  hanging = true
  snapshots.push({ phase: 'mid-send', ack: await send('UNFINISHED_TURN_PROOF') })
  await until('native assistant starts without terminal', () => readInflight(cfg.stateDir, identity).some(e => deliveryProcessed(e, env) && !deliveryCompleted(e, env)))
  snapshots.push({ phase: 'native-unfinished', entries: readInflight(cfg.stateDir, identity).map(e => ({ id: e.id, processed: deliveryProcessed(e, env), completed: deliveryCompleted(e, env) })) })
  killPtyHost(identity, env, { reason: 'proof-kill-during-native-stream' })
  await until('unfinished receiver gone', () => !hostSessionAlive(identity, env))
  await processInflight(cfg, env, deps, { send: sink })
  await processInflight(cfg, env, deps, { send: sink })
  if (notices.length !== 1 || !notices[0]!.includes('INTERRUPTED')) throw new Error(`expected one notice, got ${notices.length}`)
  snapshots.push({ phase: 'kill-mid-turn-two-sweeps', noticeCount: notices.length, notices })
  success = true
} finally {
  killPtyHost(identity, env, { reason: 'proof-cleanup' })
  provider.stop(true)
  writeFileSync(join(root, 'result.json'), JSON.stringify({ success, codeSource: import.meta.url, snapshots }, null, 2))
  console.log(JSON.stringify({ root, success, snapshots }, null, 2))
  await Bun.sleep(300)
  if (success && !process.argv.includes('--keep')) rmSync(root, { recursive: true, force: true })
}
