// Installed OpenCode operator verbs. Native TUI, local synthetic provider, disposable HOME/root.
// Source imports only set up fixtures and read records. Every operation uses the installed CLI.
// bun scripts/proof-installed-operators.ts --bin ~/.local/bin/iapeer --seed-config <SDK config dir>
//   --artifacts <dir>
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { findSurfaceTool, proveReload, surfaceProofServer } from './reload-proof.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const hostHome = homedir(), bin = resolve(arg('--bin') ?? join(hostHome, '.local/bin/iapeer'))
const native = resolve(arg('--native') ?? join(hostHome, '.opencode/bin/opencode'))
const artifacts = arg('--artifacts'), seed = arg('--seed-config')
let cliBin = arg('--legacy-bin') ?? bin
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const binSHA256 = sha256(bin), legacyBinSHA256 = arg('--legacy-bin') ? sha256(resolve(arg('--legacy-bin')!)) : undefined
if (!seed) throw new Error('set --seed-config to an OpenCode config directory with the SDK installed')
const root = mkdtempSync('/tmp/iap-installed-operators-'), home = join(root, 'home'), iap = join(root, 'iapeer')
let personality = 'operator-proof', cwd = join(root, personality)
mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true })
cpSync(seed, join(home, 'config/opencode'), { recursive: true })
const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]) : []
const wire: any[] = [], results: any[] = []
let hanging = false, selfFresh = false, useSurface = false, surfaceCalls = 0
let busyNext = false, busyReceived = false, releaseBusy: (() => void) | undefined
const surface = surfaceProofServer()
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body: any = await req.json().catch(() => ({}))
  wire.push({ time: Date.now(), path: new URL(req.url).pathname, body })
  if (new URL(req.url).pathname === '/mcp-surface') {
    if (req.method !== 'POST') return new Response('', { status: 405 })
    if (body.id === undefined) return new Response(null, { status: 202 })
    let result: unknown
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'surface-proof', version: '1' } }
    else if (body.method === 'tools/list') result = { tools: [{ name: 'surface_ping', description: 'Isolated lifecycle proof', inputSchema: { type: 'object', properties: {} } }] }
    else if (body.method === 'tools/call') { surfaceCalls++; result = { content: [{ type: 'text', text: 'SURFACE_PONG' }] } }
    else return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } })
    return Response.json({ jsonrpc: '2.0', id: body.id, result })
  }
  const id = wire.length
  const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: `chatcmpl-${id}`, object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'
  let first: string, finish = 'stop'
  const surfaceTool = (body.tools ?? []).find((t: any) => t.function?.name?.includes('surface_ping'))?.function?.name
  if (busyNext && JSON.stringify(body.tools).includes('bash') && JSON.stringify(body).includes('RELOAD_BUSY_PROOF')) {
    busyNext = false; busyReceived = true
    await new Promise<void>(r => { releaseBusy = r })
  }
  if (useSurface && surfaceTool) {
    useSurface = false; finish = 'tool_calls'
    first = chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: surfaceTool, arguments: '{}' } }] }, null)
  } else if (selfFresh) {
    selfFresh = false; finish = 'tool_calls'
    first = chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${id}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `${JSON.stringify(bin)} self-fresh`, description: 'Restart this isolated test session', timeout: 10000 }) } }] }, null)
  } else first = chunk({ role: 'assistant', content: hanging ? 'STILL_WORKING' : `PROBE_REPLY_${id}` }, null)
  return new Response(hanging ? new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(first)) } }) : first + chunk({}, finish) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
} })
const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('reserve') } })
const port = reserve.port!; reserve.stop(true)
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, TERM: 'xterm-256color', IAPEER_ROOT: iap,
  IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'), IAPEER_SOCK_DIR: join(root, 's'),
  IAPEER_PORT: String(port), IAPEER_DAEMON_SOCKET: join(root, 'router.sock'), IAPEER_OPENCODE_BIN: native,
  XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', HOMEBREW_NO_AUTO_UPDATE: '1',
  IAPEER_IDLE_SECS: '15',
}
for (const k of Object.keys(process.env)) delete process.env[k]
Object.assign(process.env, env)
const { initPeer } = await import('../src/init/index.ts')
const { upsertPeer } = await import('../src/registry/index.ts')
const { writePeerProfileAtomic } = await import('../src/identity/index.ts')
const { startSupervisorDaemon } = await import('../src/supervisor/index.ts')
const { readPidFile } = await import('../src/supervisor/paths.ts')
const { hostSessionReady } = await import('../src/launch/ptyHost.ts')
const { opencodePaths } = await import('../src/opencode/config.ts')
const { readOpencodeState, readJournalFrom } = await import('../src/opencode/journal.ts')
const paths = () => opencodePaths(personality, { env })
const state = () => readOpencodeState(paths().state)
const events = () => readJournalFrom(paths().events, 0).lines
const runDir = join(iap, 'state/supervisor'), lifecycle = join(iap, 'state/lifecycle')
const identity = () => `opencode-${personality}`
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const hosting = () => ({ pid: readPidFile(runDir, identity())?.pid, ready: read(join(runDir, identity() + '.ready')).trim() })
const until = async (what: string, f: () => unknown | Promise<unknown>, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await f()) return; await Bun.sleep(100) }
  throw new Error(`timeout: ${what}`)
}
const record = (check: string, details: unknown) => { results.push({ check, time: Date.now(), details }); console.log(`PASS ${check}`) }
const cli = async (...args: string[]) => {
  const t = Date.now(), p = Bun.spawn([cliBin, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
  const r = { args, code, stdout, stderr, ms: Date.now() - t }; results.push({ cli: r })
  return r
}
const must = async (...args: string[]) => { const r = await cli(...args); if (r.code) throw new Error(JSON.stringify(r)); return r }
const send = async (message: string) => must('send', personality, '--runtime', 'opencode', '--from', 'notifier-sender', '--topic', 'operator-proof', '--message', message)
const completed = async (after: number) => until('native idle after a new answer', () => state()?.status === 'idle' && events().some(e => e.seq > after && e.type === 'message.updated' && (e.properties as any)?.info?.role === 'assistant' && (e.properties as any)?.info?.time?.completed))
const turn = async (message: string) => { const seq = state()?.lastEventSeq ?? 0; await send(message); await completed(seq) }
const checkNew = async (before: NonNullable<ReturnType<typeof state>>, sentinelPid: number) => {
  const oldHosting = hosting()
  await must('new', personality, 'opencode')
  if (state()?.status !== 'idle' || state()?.sessionID === before.sessionID || state()?.launchID === before.launchID) throw new Error('new did not bring up a fresh ready session')
  const newHosting = hosting()
  if (!oldHosting.pid || !newHosting.pid || oldHosting.pid === newHosting.pid || alive(oldHosting.pid) || !alive(newHosting.pid) || !hostSessionReady(identity(), env)) throw new Error('new returned before old hosting died / new hosting reached ready')
  if (!alive(sentinelPid) || readPidFile(runDir, 'notifier-sender')?.pid !== sentinelPid) throw new Error('new affected the unrelated hosting')
  record('new-fresh', { state: state(), oldHosting, newHosting, oldAlive: alive(oldHosting.pid), newAlive: alive(newHosting.pid), unrelatedPid: sentinelPid, unrelatedAlive: alive(sentinelPid) })
}
let daemon: ReturnType<typeof Bun.spawn> | undefined, attached: ReturnType<typeof Bun.spawn> | undefined, success = false
try {
  const senderCwd = join(root, 'sender')
  writePeerProfileAtomic(senderCwd, { personality: 'sender', runtime: 'notifier', runtimes: ['notifier'], intelligence: 'absent' })
  await upsertPeer({ personality: 'sender', runtime: 'notifier', intelligence: 'absent', cwd: senderCwd }, { env })
  const sink = await startSupervisorDaemon({ session: 'notifier-sender', runtime: 'notifier', runDir, daemonArgv: [bin, 'supervisor'], serve: { argv: ['/bin/cat'], env: {}, cwd: root, paneLogPath: join(root, 'sender.log') } })
  if (sink.state !== 'started') throw new Error(JSON.stringify(sink))
  const sentinelPid = readPidFile(runDir, 'notifier-sender')!.pid
  await initPeer({ cwd, runtime: 'opencode', personality, intelligence: 'artificial', env })
  mkdirSync(paths().dir, { recursive: true })
  const writeProviderConfig = () => { mkdirSync(paths().dir, { recursive: true }); writeFileSync(paths().config, JSON.stringify({ model: 'synthetic/synthetic', small_model: 'synthetic/synthetic', enabled_providers: ['synthetic'], provider: {
    synthetic: { npm: '@ai-sdk/openai-compatible', name: 'Synthetic', options: { baseURL: provider.url.origin + '/v1', apiKey: 'x' }, models: { synthetic: { name: 'Synthetic', limit: { context: 100000, output: 1000 } } } },
  } })) }
  writeProviderConfig()
  daemon = Bun.spawn([arg('--legacy-bin') ?? bin, 'daemon'], { env, stdout: Bun.file(join(root, 'daemon.out')), stderr: Bun.file(join(root, 'daemon.err')) })
  await until('installed daemon ready', () => read(join(root, 'daemon.err')).includes('daemon READY'))
  await turn('FIRST_OPERATOR_PROOF')
  const original = state()!
  record('cold-turn', original)
  if (process.argv.includes('--reload-only') || process.argv.includes('--provider-only') || process.argv.includes('--remove-only') || process.argv.includes('--hand-edit-only') || arg('--legacy-bin')) {
    let busySeq = 0
    await proveReload({ root, cwd, runtime: 'opencode', cli, turn, hosting, session: () => state()?.sessionID, record,
      probe: async () => {
        const from = wire.length, calls = surface.calls(); useSurface = true
        try { await turn('RELOAD_TOOL_PROOF') } finally { useSurface = false }
        return { offered: wire.slice(from).some(w => !!findSurfaceTool(w.body.tools)), calls: surface.calls() - calls }
      },
      beginBusy: async () => {
        busySeq = state()?.lastEventSeq ?? 0; busyNext = true; busyReceived = false
        await send('RELOAD_BUSY_PROOF'); await until('main native request pending', () => busyReceived)
      },
      finishBusy: async () => { releaseBusy?.(); await completed(busySeq) },
      restartDaemon: async () => {
        cliBin = bin
        daemon!.kill(); await daemon!.exited
        daemon = Bun.spawn([bin, 'daemon'], { env, stdout: Bun.file(join(root, 'daemon.out')), stderr: Bun.file(join(root, 'daemon.err')) })
        await until('new daemon ready', () => read(join(root, 'daemon.err')).includes('daemon READY'))
      },
      afterReAdd: writeProviderConfig,
      peerRuntimes: () => (JSON.parse(read(join(iap, 'peers-profiles.json'))).peers ?? []).find((p: any) => p.personality === personality)?.runtimes ?? [],
    }, surface.url, !!arg('--legacy-bin'), process.argv.includes('--provider-only') ? 'provider' : process.argv.includes('--remove-only') ? 'remove' : process.argv.includes('--hand-edit-only') ? 'hand-edit' : 'capability')
    success = true
  } else if (process.argv.includes('--surfaces-only')) {
    // Real capability installer argv, real register/unregister sweeps, real MCP
    // discovery/calls. A manual /new is the positive/negative control, not the fix.
    const fixture = join(root, 'surface-lifecycle.ts'), declaration = join(root, 'surface-proof.json')
    writeFileSync(fixture, `import {mkdirSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';
const [kind,dir,personality]=process.argv.slice(2);if(!personality)throw new Error('personality required');
const path=join(dir,'surface-proof.json');if(kind==='off')rmSync(path,{force:true});else{mkdirSync(dir,{recursive:true});writeFileSync(path,JSON.stringify({mcp:{surfaceproof:{type:'remote',url:${JSON.stringify(provider.url.origin + '/mcp-surface')},enabled:true,oauth:false}}}));}`)
    writeFileSync(declaration, JSON.stringify({ schema: 1, capability: 'surface-proof', runtimes: ['opencode'],
      provision: { command: process.execPath, args: [fixture, 'on', '{privateDir}', '{personality}'] },
      unprovision: { command: process.execPath, args: [fixture, 'off', '{privateDir}', '{personality}'] },
    }))
    const probe = async (message: string) => {
      const start = wire.length, calls = surfaceCalls
      useSurface = true
      try { await turn(message) } finally { useSurface = false }
      const offered = wire.slice(start).some(w => (w.body.tools ?? []).some((t: any) => t.function?.name?.includes('surface_ping')))
      return { offered, nativeCalls: surfaceCalls - calls, hosting: hosting(), sessionID: state()?.sessionID }
    }
    const before = hosting()
    await must('capability', 'register', declaration)
    const liveProvision = await probe('AFTER_LIVE_PROVISION')
    record('surface-provision-observed', { before, ...liveProvision })
    await must('new', personality, 'opencode')
    const afterNewOn = await probe('AFTER_NEW_PROVISION_CONTROL')
    if (!afterNewOn.offered || afterNewOn.nativeCalls !== 1) throw new Error('provision control: native MCP tool not discovered/called after new')
    record('surface-provision-new-positive-control', afterNewOn)
    await must('capability', 'unregister', 'surface-proof')
    const liveUnprovision = await probe('AFTER_LIVE_UNPROVISION')
    record('surface-unprovision-observed', liveUnprovision)
    await must('new', personality, 'opencode')
    const afterNewOff = await probe('AFTER_NEW_UNPROVISION_CONTROL')
    if (afterNewOff.offered || afterNewOff.nativeCalls) throw new Error('unprovision control: removed native MCP tool survived new')
    record('surface-unprovision-new-negative-control', afterNewOff)
    if (!liveProvision.offered || liveProvision.nativeCalls !== 1 || liveUnprovision.offered || liveUnprovision.nativeCalls) throw new Error('live capability lifecycle left the native endpoint on stale tools')
    success = true
  } else if (process.argv.includes('--new-only')) {
    await checkNew(original, sentinelPid)
    success = true
  } else {

  // A real terminal client, not a raw spectator socket. Human input enters the native TUI.
  let attachOut = ''
  attached = Bun.spawn([bin, 'attach', personality, 'opencode'], { env, terminal: { cols: 100, rows: 32, name: 'xterm-256color', data(_t, d) { attachOut += Buffer.from(d).toString('utf8') } } })
  await until('interactive attached marker', () => existsSync(join(runDir, identity() + '.attached')))
  await Bun.sleep(1000)
  attached.terminal!.write('HUMAN_INPUT_PROOF\r')
  await until('human input in native message parts', () => JSON.stringify(events()).includes('HUMAN_INPUT_PROOF'))
  await until('human answer', () => state()?.status === 'idle' && wire.some(w => JSON.stringify(w.body.messages).includes('HUMAN_INPUT_PROOF')))
  attached.terminal!.write(Buffer.from([0x1d])); const attachCode = await attached.exited; attached.terminal!.close(); attached = undefined
  if (attachCode !== 0 || state()?.sessionID !== original.sessionID) throw new Error('attach/detach changed session or failed')
  writeFileSync(join(root, 'attach.out'), attachOut)
  record('attach-human-input-detach', { attachCode, sameSession: state()?.sessionID })

  hanging = true; await send('INTERRUPT_OPERATOR_PROOF')
  await until('native busy stream', () => state()?.status === 'busy' && JSON.stringify(events()).includes('STILL_WORKING'))
  await must('interrupt', personality, 'opencode'); hanging = false
  await until('native abort record', () => events().some(e => e.type === 'session.error' && JSON.stringify(e.properties).includes('MessageAbortedError')))
  await until('idle after abort', () => state()?.status === 'idle')
  record('interrupt-native-abort', state())
  await turn('AFTER_INTERRUPT_PROOF')
  const beforeCompact = state()!.lastEventSeq
  await must('compact', personality, 'opencode')
  if (!events().some(e => e.seq > beforeCompact && e.type === 'session.compacted')) throw new Error('compact returned without native completion')
  if (state()?.sessionID !== original.sessionID) throw new Error('compact changed the dialogue session')
  record('compact-native-completion', { sameSession: state()?.sessionID === original.sessionID, beforeCompact, after: state()!.lastEventSeq })

  await must('refresh', personality, 'opencode')
  if (state()?.launchID !== original.launchID) throw new Error('refresh eagerly restarted the session')
  await until('natural idle reap with refresh armed', () => existsSync(join(lifecycle, identity() + '.idle-reaped')), 100000)
  await turn('AFTER_REFRESH_PROOF')
  const refreshed = state()!
  if (refreshed.sessionID === original.sessionID) throw new Error('refresh next natural wake resumed instead of fresh')
  record('refresh-next-natural-wake', { before: original, after: refreshed })
  await checkNew(refreshed, sentinelPid)

  await must('approval-mode', personality, 'gated', '--now')
  const gatedServe = JSON.parse(read(join(runDir, identity() + '.serve.json')))
  if (gatedServe.env?.IAPEER_APPROVAL_MODE !== 'gated' || gatedServe.argv?.includes('--auto')) throw new Error('gated --now not applied to launch')
  await must('approval-mode', personality, 'yolo', '--now')
  const yoloServe = JSON.parse(read(join(runDir, identity() + '.serve.json')))
  if (yoloServe.env?.IAPEER_APPROVAL_MODE !== 'yolo' || !yoloServe.argv?.includes('--auto')) throw new Error('yolo --now not applied to launch')
  record('approval-mode-gated-yolo-now', { gatedArgv: gatedServe.argv, yoloArgv: yoloServe.argv })
  // A real launch failure from the normal configuration input, not an injected newPeer result.
  const config = read(paths().config)
  writeFileSync(paths().config, '{invalid-config')
  try {
    const failed = await cli('approval-mode', personality, 'gated', '--now')
    if (failed.code !== 1 || !failed.stderr.includes('saved gated, but apply now failed')) throw new Error('failed --now reported success')
    record('approval-mode-now-failure-exit-1', failed)
  } finally { writeFileSync(paths().config, config) }
  await must('approval-mode', personality, 'yolo', '--now')

  const beforeSelfFresh = state()!
  selfFresh = true; await send('SELF_FRESH_OPERATOR_PROOF')
  await until('native bash self-fresh and daemon eager relaunch', () => state()?.status === 'idle' && state()?.launchID !== beforeSelfFresh.launchID, 100000)
  if (state()?.sessionID === beforeSelfFresh.sessionID || !read(join(runDir, 'terminations.log')).includes('reason=self-fresh')) throw new Error('self-fresh did not take the native self-call path')
  record('self-fresh-native-bash-eager-relaunch', { before: beforeSelfFresh, after: state() })

  const refused = await cli('rename', personality, 'operator-renamed')
  if (refused.code === 0) throw new Error('rename silently moved a live endpoint')
  await must('stop', personality, 'opencode')
  await must('rename', personality, 'operator-renamed')
  personality = 'operator-renamed'; cwd = join(root, personality)
  if (!existsSync(paths().config) || !existsSync(paths().events)) throw new Error('rename lost OpenCode private config/history')
  await must('start', personality, 'opencode'); await turn('RENAMED_IDENTITY_PROOF')
  if (state()?.identity !== identity() || state()?.cwd !== realpathSync(cwd)) throw new Error('rename launched with stale identity/cwd')
  record('rename-guard-move-new-identity', state())
  cpSync(paths().events, join(root, 'native-before-remove.jsonl'))
  const removeRefused = await cli('remove', personality)
  if (removeRefused.code === 0) throw new Error('remove silently orphaned a live endpoint')
  await must('remove', personality, '--force')
  if (existsSync(paths().dir) || read(join(iap, 'peers-profiles.json')).includes(personality)) throw new Error('remove left private state or registry record')
  if (!existsSync(cwd)) throw new Error('remove deleted user data')
  record('remove-live-guard-force-purge-keeps-cwd', {})
  success = true
  }
} finally {
  releaseBusy?.()
  if (attached) { attached.kill(); await attached.exited; attached.terminal?.close() }
  if (daemon) { daemon.kill(); await daemon.exited }
  for (const p of ['operator-proof', 'operator-renamed']) await cli('supervisor', 'kill', 'opencode-' + p, '--run-dir', runDir)
  await cli('supervisor', 'kill', 'notifier-sender', '--run-dir', runDir)
  provider.stop(true)
  surface.stop()
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true })
    for (const p of files(root).filter(p => /(?:\.jsonl|\.log|\.out|\.err)$/.test(p))) {
      const dest = join(artifacts, p.slice(root.length + 1)); mkdirSync(resolve(dest, '..'), { recursive: true }); cpSync(p, dest)
    }
    writeFileSync(join(artifacts, 'wire.json'), JSON.stringify(wire, null, 2))
    writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ success, bin, binSHA256, legacyBinSHA256, native, results }, null, 2) + '\n')
  }
  console.log(JSON.stringify({ success, results }, null, 2))
  await Bun.sleep(500); rmSync(root, { recursive: true, force: true })
}
