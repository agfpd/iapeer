// Installed core (daemon + CLI + supervisors), native Codex, disposable HOME/root.
// Source imports below only arrange fixtures/read files; no source route/wake/sweep is executed.
// bun scripts/proof-installed-recovery.ts --bin ~/.local/bin/iapeer --legacy ~/.local/bin/iapeer.prev \
//   --codex-bin /opt/homebrew/bin/codex --artifacts <dir>
// Copies ONLY auth.json into the temporary HOME and always removes it, including on failure.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileSHA256 } from './proof-installed-lib.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const hostHome = homedir()
const bin = resolve(arg('--bin') ?? join(hostHome, '.local/bin/iapeer'))
const legacy = resolve(arg('--legacy') ?? `${bin}.prev`)
const binSHA256 = fileSHA256(bin), legacyBinSHA256 = fileSHA256(legacy)
const native = resolve(arg('--codex-bin') ?? '/opt/homebrew/bin/codex')
const auth = join(process.env.CODEX_HOME ?? join(hostHome, '.codex'), 'auth.json')
const artifacts = arg('--artifacts')
if (!existsSync(native) || !existsSync(auth)) throw new Error('native Codex and its auth.json are required')
const root = mkdtempSync('/tmp/iap-installed-recovery-')
const home = join(root, 'home'), iap = join(root, 'iapeer'), codexHome = join(home, '.codex')
mkdirSync(codexHome, { recursive: true })
cpSync(auth, join(codexHome, 'auth.json'))
const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('reserve') } })
const port = reserve.port!
reserve.stop(true)
const shim = join(root, 'codex-shim')
writeFileSync(shim, '#!/bin/sh\nexec /bin/sleep 600\n', { mode: 0o700 })
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, TERM: 'xterm-256color',
  IAPEER_ROOT: iap, IAPEER_SOCK_DIR: join(root, 's'), IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'),
  IAPEER_DAEMON_SOCKET: join(root, 'router.sock'), IAPEER_PORT: String(port), IAPEER_CODEX_BIN: shim,
  IAPEER_BOOT_DEADLINE_SECS: '2', IAPEER_READY_GATE_SECS: '2',
}
// Network settings only; no host doctrine, plugins, MCP servers, provider overrides or data.
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
  if (process.env[k]) env[k] = process.env[k]
}
for (const k of Object.keys(process.env)) delete process.env[k]
Object.assign(process.env, env)
const { initPeer } = await import('../src/init/index.ts')
const { upsertPeer } = await import('../src/registry/index.ts')
const { startSupervisorDaemon, sessionAlive } = await import('../src/supervisor/index.ts')
const { readInflight } = await import('../src/lifecycle/inflight.ts')
const { deliveryCompleted, deliveryProcessed } = await import('../src/transport/index.ts')
const { peerLaunchEnvPath } = await import('../src/storage/index.ts')
const runDir = join(iap, 'state/supervisor'), stateDir = join(iap, 'state/lifecycle')
const personality = 'recovery', identity = `codex-${personality}`, cwd = join(root, personality)
const sender = 'notifier-sender', sinkLog = join(root, 'sender.log')
const nonce = `RECOVERY_${process.pid}`
const snapshots: unknown[] = []
let daemon: ReturnType<typeof Bun.spawn> | undefined, success = false
const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const until = async (what: string, f: () => unknown | Promise<unknown>, ms = 180000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await f()) return; await Bun.sleep(250) }
  throw new Error(`timeout: ${what}`)
}
const cli = async (exe: string, args: string[]) => {
  const p = Bun.spawn([exe, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
  return { code, stdout, stderr }
}
const snapshot = async () => (await fetch(`http://127.0.0.1:${port}/fleet/v1/snapshot`, { proxy: '' })).json() as Promise<any>
const status = (s: any) => s.peers.find((p: any) => p.personality === personality)?.runtimes.find((r: any) => r.runtime === 'codex')?.status
const start = async (exe: string) => {
  daemon = Bun.spawn([exe, 'daemon'], { env, stdout: Bun.file(join(root, `daemon-${snapshots.length}.out`)), stderr: Bun.file(join(root, `daemon-${snapshots.length}.err`)) })
  await until('installed daemon', async () => { try { return !!(await snapshot()).version } catch { return false } }, 15000)
}
const stop = async () => { if (daemon) { daemon.kill(); await daemon.exited; daemon = undefined } }
const send = async (message: string) => {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, { proxy: '', method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'X-IAPeer-Identity': sender },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_to_peer', arguments: { personality, runtime: 'codex', message, topic: 'installed-proof' } } }),
  })
  const raw = await r.text()
  const json = JSON.parse(raw.startsWith('event:') || raw.startsWith('data:') ? raw.split('\n').find(l => l.startsWith('data:'))!.slice(5) : raw)
  snapshots.push({ phase: 'send', message, http: r.status, response: json })
  return json.result
}
const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]) : []
const transcripts = () => files(join(codexHome, 'sessions')).filter(p => p.endsWith('.jsonl'))
const nativeSleepCall = (after: number) => transcripts().some(p => read(p).split('\n').some(line => {
  try {
    const r = JSON.parse(line)
    return Date.parse(r.timestamp) >= after && r.type === 'response_item' &&
      ((r.payload?.type === 'function_call' && JSON.stringify(r.payload.arguments).includes('sleep 180')) ||
       (r.payload?.type === 'custom_tool_call' && String(r.payload.input).includes('sleep 180')))
  } catch { return false }
}))
const noticeCount = () => (read(join(iap, 'logs/iapeer/delivery.log')).match(/ev=inflight-interrupted\b/g) ?? []).length
const killReceiver = async () => {
  const r = await cli(bin, ['supervisor', 'kill', identity, '--run-dir', runDir])
  snapshots.push({ phase: 'kill-receiver', ...r })
  if (r.code) throw new Error('installed kill failed')
  await until('receiver gone', () => !sessionAlive(runDir, identity), 10000)
}
try {
  mkdirSync(cwd, { recursive: true })
  await initPeer({ cwd, runtime: 'codex', personality, intelligence: 'artificial', env })
  // Native init writes the core MCP/trust surfaces; command-line config makes the provider choice explicit.
  writeFileSync(peerLaunchEnvPath(cwd, 'codex'), 'PEER_START_ARGS=\'-m gpt-6.1-sol -c model_reasoning_effort="low" -c check_for_update_on_startup=false\'\n')
  await upsertPeer({ personality: 'sender', runtime: 'notifier', intelligence: 'absent', cwd: join(root, 'sender') }, { env })
  for (const spec of [
    { session: sender, runtime: 'notifier', argv: ['/bin/cat'], paneLogPath: sinkLog },
    { session: identity, runtime: 'codex', argv: ['/bin/sleep', '600'], paneLogPath: join(iap, 'logs/lifecycle', `${identity}.log`) },
  ]) {
    const r = await startSupervisorDaemon({ session: spec.session, runtime: spec.runtime, runDir, daemonArgv: [legacy, 'supervisor'],
      serve: { argv: spec.argv, env: {}, cwd: root, paneLogPath: spec.paneLogPath, exitLogPath: join(iap, 'logs/lifecycle/exits.log') } })
    if (r.state !== 'started') throw new Error(JSON.stringify(r))
  }
  await start(legacy)
  const old = await snapshot()
  if (status(old) !== 'live') throw new Error('legacy control did not show live')
  const original = `Reply with exactly ${nonce}. This is a synthetic delivery check.`
  const oldAck = await send(original)
  const entries = readInflight(stateDir, identity)
  if (oldAck?.isError || !entries.some(e => e.message === original)) throw new Error('legacy false-ok did not persist an envelope')
  snapshots.push({ phase: 'legacy-false-live-ok', version: old.host?.version, status: status(old), entries })
  await stop()
  await start(bin)
  const current = await snapshot()
  if (status(current) !== 'booting') throw new Error('new daemon called pre-main hang live')
  if (readInflight(stateDir, identity)[0]?.id !== entries[0]!.id) throw new Error('migration lost original ledger')
  snapshots.push({ phase: 'installed-migration', version: current.host?.version, status: status(current) })
  const fail = await send('This message must fail while the test executable hangs before main.')
  if (!fail?.isError) throw new Error('hung runtime was acknowledged')
  if (!readInflight(stateDir, identity).some(e => e.id === entries[0]!.id)) throw new Error('failed wake erased original envelope')
  snapshots.push({ phase: 'installed-not-ok-ledger-preserved', entries: readInflight(stateDir, identity) })
  await stop()
  writeFileSync(shim, `#!/bin/sh\nexec '${native.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 })
  env.IAPEER_BOOT_DEADLINE_SECS = '60'; env.IAPEER_READY_GATE_SECS = '60'
  Object.assign(process.env, env)
  await start(bin)
  await until('original envelope recovered by installed daemon', () => transcripts().some(p => read(p).includes(nonce) && read(p).includes('task_complete')), 240000)
  const raw = transcripts().map(p => ({ path: p, text: read(p) }))
  if (!raw.some(f => f.text.includes('[redelivered by iapeer:') && f.text.includes(nonce))) throw new Error('not a redelivery')
  snapshots.push({ phase: 'native-codex-recovered', status: status(await snapshot()), transcriptFiles: raw.map(f => f.path), noticeCount: noticeCount() })
  // Kill a newly completed turn before a sweep can prune its entry, then let the installed daemon settle it.
  const finished = await send(`Reply with exactly FINISHED_${nonce}.`)
  if (finished?.isError) throw new Error('finished native send failed')
  await until('native terminal completion', () => readInflight(stateDir, identity).some(e => e.message.includes(`FINISHED_${nonce}`) && deliveryCompleted(e, env)), 120000)
  await killReceiver()
  await until('completed ledger settled by installed daemon', () => readInflight(stateDir, identity).length === 0, 90000)
  if (noticeCount() !== 0 || read(sinkLog).includes('INTERRUPTED')) throw new Error('completed native Codex turn generated INTERRUPTED')
  snapshots.push({ phase: 'native-codex-finished-kill', noticeCount: noticeCount() })
  const mid = await send(`Run /bin/sleep 180 in the shell in the foreground, then reply MID_${nonce}. This synthetic check deliberately keeps a tool running.`)
  if (mid?.isError) throw new Error('mid-turn native send failed')
  await until('native tool running', () => readInflight(stateDir, identity).some(e => e.message.includes(`MID_${nonce}`) && deliveryProcessed(e, env) && !deliveryCompleted(e, env) && nativeSleepCall(e.ts)), 120000)
  snapshots.push({ phase: 'native-codex-unfinished', entries: readInflight(stateDir, identity) })
  await killReceiver()
  await until('one installed interruption notice', () => noticeCount() === 1 && read(sinkLog).includes('INTERRUPTED'), 90000)
  await Bun.sleep(65000) // a second real daemon tick must not duplicate the notice
  if (noticeCount() !== 1) throw new Error('duplicate interruption notice')
  snapshots.push({ phase: 'native-codex-mid-kill-two-ticks', noticeCount: noticeCount(), sink: read(sinkLog) })
  success = true
} finally {
  await stop()
  for (const id of [identity, sender]) await cli(bin, ['supervisor', 'kill', id, '--run-dir', runDir])
  rmSync(join(codexHome, 'auth.json'), { force: true })
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true })
    for (const p of files(root).filter(p => /(?:\.jsonl|\.log|\.out|\.err)$/.test(p))) {
      const dest = join(artifacts, p.slice(root.length + 1))
      mkdirSync(resolve(dest, '..'), { recursive: true }); cpSync(p, dest)
    }
    writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ success, bin, binSHA256, legacy, legacyBinSHA256, native, snapshots }, null, 2) + '\n')
  }
  console.log(JSON.stringify({ success, snapshots }, null, 2))
  await Bun.sleep(500)
  rmSync(root, { recursive: true, force: true })
}
