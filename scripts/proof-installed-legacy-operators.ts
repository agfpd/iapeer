// Installed Claude/Codex parity for proof-installed-operators.ts (OpenCode).
// Native TUI + loopback provider; no cloud credentials or host configuration.
// Source imports only arrange fixtures/read native records. All operations use --bin.
// bun scripts/proof-installed-legacy-operators.ts --runtime claude|codex --artifacts <dir>
// Wire docs checked 2026-10-18:
// https://platform.claude.com/docs/en/build-with-claude/streaming
// https://developers.openai.com/api/docs/guides/streaming-responses
// https://developers.openai.com/codex/config-advanced#custom-model-providers
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { findSurfaceNamespace, findSurfaceTool, proveReload, surfaceProofServer } from './reload-proof.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const runtime = arg('--runtime')
if (runtime !== 'claude' && runtime !== 'codex') throw new Error('set --runtime claude|codex')
const hostHome = homedir(), bin = resolve(arg('--bin') ?? join(hostHome, '.local/bin/iapeer'))
const native = resolve(arg('--native') ?? (runtime === 'claude' ? join(hostHome, '.local/bin/claude') : '/opt/homebrew/bin/codex'))
const artifacts = arg('--artifacts')
let cliBin = arg('--legacy-bin') ?? bin
const binSHA256 = createHash('sha256').update(readFileSync(bin)).digest('hex')
const legacyBinSHA256 = arg('--legacy-bin') ? createHash('sha256').update(readFileSync(resolve(arg('--legacy-bin')!))).digest('hex') : undefined
const root = mkdtempSync(`/tmp/iap-installed-${runtime}-operators-`), home = join(root, 'home'), iap = join(root, 'iapeer')
let personality = 'operator-proof', cwd = join(root, personality)
mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true })
const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]) : []
const wire: any[] = [], results: any[] = []
let toolAction: 'sleep' | 'self-fresh' | undefined
let useSurface = false, busyNext = false, busyReceived = false, releaseBusy: (() => void) | undefined
const surface = surfaceProofServer()
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body: any = await req.json().catch(() => ({})), path = new URL(req.url).pathname
  wire.push({ time: Date.now(), path, body })
  if (path.includes('count_tokens')) return Response.json({ input_tokens: 100 })
  if (!path.endsWith('/messages') && !path.endsWith('/responses')) return Response.json({})
  const id = wire.length
  // Telemetry/title requests are not the instructed native turn. Consume an
  // action only when its test input reaches a tool-capable inference request.
  const toolCapable = JSON.stringify(body.tools ?? []).includes(runtime === 'claude' ? '"Bash"' : '"exec_command"')
  if (busyNext && toolCapable && JSON.stringify(body).includes('RELOAD_BUSY_PROOF')) {
    busyNext = false; busyReceived = true
    await new Promise<void>(r => { releaseBusy = r })
  }
  const surfaceTool = useSurface ? findSurfaceTool(body.tools) : undefined
  const surfaceNamespace = surfaceTool ? findSurfaceNamespace(body.tools) : undefined
  if (surfaceTool) useSurface = false
  const action = toolAction && toolCapable && JSON.stringify(body).includes(toolAction === 'sleep' ? 'INTERRUPT_OPERATOR_PROOF' : 'SELF_FRESH_OPERATOR_PROOF') ? toolAction : undefined
  if (action) toolAction = undefined
  const command = action === 'sleep' ? `echo $$ > ${JSON.stringify(join(root, 'sleep.pid'))}; exec /bin/sleep 180` : `${JSON.stringify(bin)} self-fresh`
  const text = `PROBE_REPLY_${id}`
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  if (runtime === 'codex') {
    const item = surfaceTool ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: surfaceTool, ...(surfaceNamespace ? { namespace: surfaceNamespace } : {}), arguments: '{}' } : action
      ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'exec_command', arguments: JSON.stringify({ cmd: command, yield_time_ms: 10000 }) }
      : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    const response = { id: `resp_${id}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } }
    return new Response([
      event('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }),
      event('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }),
      event('response.completed', { type: 'response.completed', response }),
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  const content = surfaceTool ? [{ type: 'tool_use' as const, id: `toolu_${id}`, name: surfaceTool, input: {} }] : action
    ? [{ type: 'tool_use' as const, id: `toolu_${id}`, name: 'Bash', input: { command, timeout: 300000, description: 'Isolated native operator proof' } }]
    : [{ type: 'text' as const, text }]
  const message = { id: `msg_${id}`, type: 'message', role: 'assistant', model: body.model ?? 'claude-sonnet-4-5', content, stop_reason: action || surfaceTool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }
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
  PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), TERM: 'xterm-256color',
  IAPEER_ROOT: iap, IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'), IAPEER_SOCK_DIR: join(root, 's'),
  IAPEER_PORT: String(port), IAPEER_DAEMON_SOCKET: join(root, 'router.sock'),
  IAPEER_CLAUDE_BIN: native, IAPEER_CODEX_BIN: native, IAPEER_IDLE_SECS: '15',
  ANTHROPIC_BASE_URL: provider.url.origin, ANTHROPIC_AUTH_TOKEN: 'synthetic-local-only', ANTHROPIC_MODEL: 'claude-sonnet-4-5',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', HOMEBREW_NO_AUTO_UPDATE: '1',
}
for (const k of Object.keys(process.env)) delete process.env[k]
Object.assign(process.env, env)
const { initPeer } = await import('../src/init/index.ts')
const { upsertPeer } = await import('../src/registry/index.ts')
const { writePeerProfileAtomic } = await import('../src/identity/index.ts')
const { peerLaunchEnvPath } = await import('../src/storage/index.ts')
const { startSupervisorDaemon } = await import('../src/supervisor/index.ts')
const { readPidFile } = await import('../src/supervisor/paths.ts')
const { hostSessionReady } = await import('../src/launch/ptyHost.ts')
const { compactDoneBaseline, compactTranscriptHasDone } = await import('../src/transport/index.ts')
const { transcriptSlug } = await import('../src/launch/adapters/claude.ts')
const runDir = join(iap, 'state/supervisor'), lifecycle = join(iap, 'state/lifecycle')
const identity = () => `${runtime}-${personality}`
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const hosting = () => ({ pid: readPidFile(runDir, identity())?.pid, ready: read(join(runDir, identity() + '.ready')).trim() })
const transcripts = () => files(runtime === 'claude' ? join(home, '.claude/projects', transcriptSlug(cwd)) : join(home, '.codex/sessions')).filter(p => p.endsWith('.jsonl'))
const records = () => transcripts().flatMap(p => read(p).split('\n').flatMap(l => { try { return [{ path: p, ...JSON.parse(l) }] } catch { return [] } }))
  .sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0))
const nativeSession = (): string | undefined => {
  const rows = records()
  if (runtime === 'claude') return rows.findLast(r => r.sessionId)?.sessionId
  return rows.findLast(r => r.type === 'session_meta' && r.payload?.cwd && realpathSync(r.payload.cwd) === realpathSync(cwd))?.payload?.id
}
const until = async (what: string, f: () => unknown | Promise<unknown>, ms = 30000) => {
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
const send = async (message: string) => must('send', personality, '--runtime', runtime, '--from', 'notifier-sender', '--topic', 'operator-proof', '--message', message)
const completedAfter = (start: number) => records().some(r => Date.parse(r.timestamp) >= start && (runtime === 'claude' ? r.type === 'assistant' && r.message?.stop_reason === 'end_turn' : r.type === 'event_msg' && r.payload?.type === 'task_complete'))
const turn = async (message: string) => { const t = Date.now(); await send(message); await until('native completed turn', () => completedAfter(t)); await Bun.sleep(500) }
let daemon: ReturnType<typeof Bun.spawn> | undefined, attached: ReturnType<typeof Bun.spawn> | undefined, success = false
try {
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true }))
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex/config.toml'), `model = "gpt-5.4"\nmodel_provider = "probe"\ncheck_for_update_on_startup = false\n[model_providers.probe]\nname = "Loopback proof only"\nbase_url = "${provider.url.origin}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`)
  await initPeer({ cwd, runtime, personality, intelligence: 'artificial', env })
  if (runtime === 'codex') writeFileSync(peerLaunchEnvPath(cwd, runtime), "PEER_START_ARGS='--no-daemon -c model_reasoning_effort=low'\n")
  const senderCwd = join(root, 'sender')
  writePeerProfileAtomic(senderCwd, { personality: 'sender', runtime: 'notifier', runtimes: ['notifier'], intelligence: 'absent' })
  await upsertPeer({ personality: 'sender', runtime: 'notifier', intelligence: 'absent', cwd: senderCwd }, { env })
  const sink = await startSupervisorDaemon({ session: 'notifier-sender', runtime: 'notifier', runDir, daemonArgv: [bin, 'supervisor'], serve: { argv: ['/bin/cat'], env: {}, cwd: root, paneLogPath: join(root, 'sender.log') } })
  if (sink.state !== 'started') throw new Error(JSON.stringify(sink))
  const sentinelPid = readPidFile(runDir, 'notifier-sender')!.pid
  await must('version')
  daemon = Bun.spawn([arg('--legacy-bin') ?? bin, 'daemon'], { env, stdout: Bun.file(join(root, 'daemon.out')), stderr: Bun.file(join(root, 'daemon.err')) })
  await until('installed daemon ready', () => read(join(root, 'daemon.err')).includes('daemon READY'))
  await turn('FIRST_OPERATOR_PROOF')
  const original = nativeSession()
  if (!original) throw new Error('native session ID missing')
  record('cold-turn', { sessionID: original, hosting: hosting() })

  if (process.argv.includes('--reload-only') || process.argv.includes('--provider-only') || process.argv.includes('--remove-only') || arg('--legacy-bin')) {
    let busyAt = 0
    await proveReload({ root, cwd, runtime, cli, turn, hosting, session: nativeSession, record,
      probe: async () => {
        const from = wire.length, calls = surface.calls(); useSurface = true
        try { await turn('RELOAD_TOOL_PROOF') } finally { useSurface = false }
        return { offered: wire.slice(from).some(w => !!findSurfaceTool(w.body.tools)), calls: surface.calls() - calls }
      },
      beginBusy: async () => {
        busyAt = Date.now(); busyNext = true; busyReceived = false
        await send('RELOAD_BUSY_PROOF'); await until('main native request pending', () => busyReceived)
      },
      finishBusy: async () => { releaseBusy?.(); await until('busy turn completed without abort', () => completedAfter(busyAt)) },
      restartDaemon: async () => {
        cliBin = bin
        daemon!.kill(); await daemon!.exited
        daemon = Bun.spawn([bin, 'daemon'], { env, stdout: Bun.file(join(root, 'daemon.out')), stderr: Bun.file(join(root, 'daemon.err')) })
        await until('new daemon ready', () => read(join(root, 'daemon.err')).includes('daemon READY'))
      },
      peerRuntimes: () => (JSON.parse(read(join(iap, 'peers-profiles.json'))).peers ?? []).find((p: any) => p.personality === personality)?.runtimes ?? [],
    }, surface.url, !!arg('--legacy-bin'), process.argv.includes('--provider-only') ? 'provider' : process.argv.includes('--remove-only') ? 'remove' : 'capability')
    success = true
  } else {

  let attachOut = ''
  attached = Bun.spawn([bin, 'attach', personality, runtime], { env, terminal: { cols: 100, rows: 32, name: 'xterm-256color', data(_t, d) { attachOut += Buffer.from(d).toString('utf8') } } })
  await until('interactive attached marker', () => existsSync(join(runDir, identity() + '.attached')))
  await Bun.sleep(1000)
  const humanStart = Date.now()
  attached.terminal!.write('HUMAN_INPUT_PROOF')
  // Separate typing from Enter: Codex's paste-burst detector otherwise keeps it
  // as an unsubmitted multiline draft, unlike a person pressing Enter afterward.
  await Bun.sleep(500)
  attached.terminal!.write('\r')
  await until('native human input and completed answer', () => completedAfter(humanStart) && records().some(r => Date.parse(r.timestamp) >= humanStart && JSON.stringify(r).includes('HUMAN_INPUT_PROOF')))
  attached.terminal!.write(Buffer.from([0x1d])); const attachCode = await attached.exited; attached.terminal!.close(); attached = undefined
  if (attachCode !== 0 || nativeSession() !== original) throw new Error('attach/detach changed session or failed')
  writeFileSync(join(root, 'attach.out'), attachOut)
  record('attach-human-input-detach', { attachCode, sessionID: nativeSession() })

  const interruptStart = Date.now()
  toolAction = 'sleep'; await send('INTERRUPT_OPERATOR_PROOF')
  await until('native shell actually running', () => Number(read(join(root, 'sleep.pid'))) > 0 && alive(Number(read(join(root, 'sleep.pid')))))
  await must('interrupt', personality, runtime)
  await until('native abort record', () => records().some(r => Date.parse(r.timestamp) >= interruptStart && (runtime === 'claude' ? r.type === 'user' && JSON.stringify(r.message).includes('[Request interrupted by user') : r.type === 'event_msg' && r.payload?.type === 'turn_aborted')))
  record('interrupt-native-abort', { sessionID: nativeSession(), sleepPid: read(join(root, 'sleep.pid')).trim() })
  await turn('AFTER_INTERRUPT_PROOF')
  const compactBaseline = compactDoneBaseline(runtime, cwd, { env })
  await must('compact', personality, runtime)
  if (!compactTranscriptHasDone(compactBaseline, { env }) || nativeSession() !== original) throw new Error('compact did not complete in the original native session')
  record('compact-native-completion', { sessionID: nativeSession(), compactBaseline })

  const beforeRefresh = hosting()
  await must('refresh', personality, runtime)
  if (hosting().pid !== beforeRefresh.pid) throw new Error('refresh eagerly restarted the hosting')
  await until('natural idle reap with refresh armed', () => existsSync(join(lifecycle, identity() + '.idle-reaped')), 100000)
  await turn('AFTER_REFRESH_PROOF')
  if (nativeSession() === original) throw new Error('refresh next wake resumed instead of fresh')
  record('refresh-next-natural-wake', { before: original, after: nativeSession(), beforeHosting: beforeRefresh, afterHosting: hosting() })

  const oldHosting = hosting(), beforeNew = nativeSession()
  await must('new', personality, runtime)
  const newHosting = hosting()
  if (!oldHosting.pid || !newHosting.pid || oldHosting.pid === newHosting.pid || alive(oldHosting.pid) || !alive(newHosting.pid) || !hostSessionReady(identity(), env)) throw new Error('new returned before old hosting died / new hosting reached ready')
  await turn('AFTER_NEW_PROOF')
  if (nativeSession() === beforeNew || !alive(sentinelPid) || readPidFile(runDir, 'notifier-sender')?.pid !== sentinelPid) throw new Error('new reused native session or affected unrelated hosting')
  record('new-fresh', { before: beforeNew, after: nativeSession(), oldHosting, newHosting, sentinelPid })

  for (const mode of ['gated', 'yolo']) {
    await must('approval-mode', personality, mode, '--now')
    const serve = JSON.parse(read(join(runDir, identity() + '.serve.json')))
    const bypass = serve.argv.includes(runtime === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox')
    if (bypass !== (mode === 'yolo') || !hostSessionReady(identity(), env)) throw new Error('approval-mode --now did not apply to ready launch')
    record(`approval-mode-${mode}-now`, { argv: serve.argv, hosting: hosting() })
  }

  const beforeSelfFresh = hosting(), beforeSelfSession = nativeSession()
  toolAction = 'self-fresh'; await send('SELF_FRESH_OPERATOR_PROOF')
  await until('native shell self-fresh and installed daemon eager relaunch', () => hosting().pid && hosting().pid !== beforeSelfFresh.pid && hostSessionReady(identity(), env), 100000)
  await turn('AFTER_SELF_FRESH_PROOF')
  if (nativeSession() === beforeSelfSession || !read(join(runDir, 'terminations.log')).includes('reason=self-fresh')) throw new Error('self-fresh did not take native self-call path')
  record('self-fresh-native-shell-eager-relaunch', { before: beforeSelfFresh, after: hosting(), beforeSession: beforeSelfSession, afterSession: nativeSession() })

  if ((await cli('rename', personality, 'operator-renamed')).code === 0) throw new Error('rename silently moved live endpoint')
  await must('stop', personality, runtime)
  await must('rename', personality, 'operator-renamed')
  personality = 'operator-renamed'; cwd = join(root, personality)
  await must('start', personality, runtime); await turn('RENAMED_IDENTITY_PROOF')
  const serve = JSON.parse(read(join(runDir, identity() + '.serve.json')))
  if (serve.env?.PEER_IDENTITY !== identity() || realpathSync(serve.cwd) !== realpathSync(cwd)) throw new Error('rename launched stale identity/cwd')
  record('rename-guard-move-new-identity', { sessionID: nativeSession(), identity: serve.env.PEER_IDENTITY, cwd: serve.cwd })
  if ((await cli('remove', personality)).code === 0) throw new Error('remove silently orphaned live endpoint')
  await must('remove', personality, '--force')
  if (read(join(iap, 'peers-profiles.json')).includes(personality) || !existsSync(cwd)) throw new Error('remove left registry entry or deleted user data')
  record('remove-live-guard-force-keeps-cwd', {})
  success = true
  }
} finally {
  releaseBusy?.()
  if (attached) { attached.kill(); await attached.exited; attached.terminal?.close() }
  if (daemon) { daemon.kill(); await daemon.exited }
  for (const p of ['operator-proof', 'operator-renamed']) await cli('supervisor', 'kill', `${runtime}-${p}`, '--run-dir', runDir)
  await cli('supervisor', 'kill', 'notifier-sender', '--run-dir', runDir)
  provider.stop(true)
  surface.stop()
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true })
    for (const p of files(root).filter(p => /(?:\.jsonl|\.log|\.out|\.err)$/.test(p))) {
      const dest = join(artifacts, p.slice(root.length + 1)); mkdirSync(resolve(dest, '..'), { recursive: true }); cpSync(p, dest)
    }
    writeFileSync(join(artifacts, 'wire.json'), JSON.stringify(wire, null, 2))
    writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ success, bin, binSHA256, legacyBinSHA256, runtime, native, results }, null, 2) + '\n')
  }
  console.log(JSON.stringify({ success, runtime, results }, null, 2))
  await Bun.sleep(500); rmSync(root, { recursive: true, force: true })
}
