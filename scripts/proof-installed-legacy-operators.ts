// Installed Claude/Codex parity for proof-installed-operators.ts (OpenCode).
// Native TUI + loopback provider; no cloud credentials or host configuration.
// Source imports only arrange fixtures/read native records. All operations use --bin.
// bun scripts/proof-installed-legacy-operators.ts --runtime claude|codex --artifacts <dir>
// Wire docs checked 2026-10-18:
// https://platform.claude.com/docs/en/build-with-claude/streaming
// https://developers.openai.com/api/docs/guides/streaming-responses
// https://developers.openai.com/codex/config-advanced#custom-model-providers
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { findSurfaceNamespace, findSurfaceTool, proveReload, surfaceNames, surfaceProofServer } from './reload-proof.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const runtime = arg('--runtime')
if (runtime !== 'claude' && runtime !== 'codex') throw new Error('set --runtime claude|codex')
const hostHome = homedir(), bin = resolve(arg('--bin') ?? join(hostHome, '.local/bin/iapeer'))
const native = resolve(arg('--native') ?? (runtime === 'claude' ? join(hostHome, '.local/bin/claude') : '/opt/homebrew/bin/codex'))
const artifacts = arg('--artifacts')
let cliBin = arg('--legacy-bin') ?? bin
const binSHA256 = createHash('sha256').update(readFileSync(bin)).digest('hex')
const legacyBinSHA256 = arg('--legacy-bin') ? createHash('sha256').update(readFileSync(resolve(arg('--legacy-bin')!))).digest('hex') : undefined
const root = realpathSync(mkdtempSync(`/tmp/iap-installed-${runtime}-operators-`)), home = join(root, 'home'), iap = join(root, 'iapeer')
let personality = 'operator-proof', cwd = join(root, personality)
mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true })
const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]) : []
const wire: any[] = [], results: any[] = []
let toolAction: 'sleep' | 'self-fresh' | undefined
let contactSent = false
let useSurface = false, busyNext = false, busyReceived = false, releaseBusy: (() => void) | undefined
const surface = surfaceProofServer()
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  const body: any = await req.json().catch(() => ({})), path = new URL(req.url).pathname
  wire.push({ time: Date.now(), path, body })
  if (path.includes('count_tokens')) return Response.json({ input_tokens: 100 })
  if (!path.endsWith('/messages') && !path.endsWith('/responses')) return Response.json({})
  const id = wire.length
  const contact = process.argv.includes('--limit-resume-only') && !contactSent && JSON.stringify(body).includes('AUTONOMOUS_CONTACT_PROOF')
  if (contact) contactSent = true
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
  const command = contact ? `${JSON.stringify(bin)} send sender --runtime notifier --from ${runtime}-${personality} --message AUTONOMOUS_CONTACT_PROOF` : action === 'sleep' ? `echo $$ > ${JSON.stringify(join(root, 'sleep.pid'))}; exec /bin/sleep 180` : `${JSON.stringify(bin)} self-fresh`
  const text = `PROBE_REPLY_${id}`
  const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  if (runtime === 'codex') {
    const item = surfaceTool ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: surfaceTool, ...(surfaceNamespace ? { namespace: surfaceNamespace } : {}), arguments: '{}' } : action || contact
      ? { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: 'exec_command', arguments: JSON.stringify({ cmd: command, yield_time_ms: 10000 }) }
      : { type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    const response = { id: `resp_${id}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } }
    return new Response([
      event('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }),
      event('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }),
      event('response.completed', { type: 'response.completed', response }),
    ].join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  const content = surfaceTool ? [{ type: 'tool_use' as const, id: `toolu_${id}`, name: surfaceTool, input: {} }] : action || contact
    ? [{ type: 'tool_use' as const, id: `toolu_${id}`, name: 'Bash', input: { command, timeout: 300000, description: 'Isolated native operator proof' } }]
    : [{ type: 'text' as const, text }]
  const message = { id: `msg_${id}`, type: 'message', role: 'assistant', model: body.model ?? 'claude-sonnet-4-5', content, stop_reason: action || surfaceTool || contact ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }
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
  IAPEER_CLAUDE_BIN: process.argv.includes('--limit-resume-only') ? join(hostHome, '.local/bin/claude') : native, IAPEER_CODEX_BIN: process.argv.includes('--limit-resume-only') ? '/opt/homebrew/bin/codex' : native, IAPEER_IDLE_SECS: ['--unknown-delivery-only', '--death-delivery-only', '--refusal-delivery-only'].some(flag => process.argv.includes(flag)) ? '600' : '15',
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
let stoppedChild: number | undefined
try {
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true }))
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex/config.toml'), `model = "gpt-5.4"\nmodel_provider = "probe"\ncheck_for_update_on_startup = false\n[model_providers.probe]\nname = "Loopback proof only"\nbase_url = "${provider.url.origin}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`)
  await initPeer({ cwd, runtime, personality, intelligence: 'artificial', env })
  if (process.argv.includes('--wake-delivery-only')) {
    if (runtime !== 'codex') throw new Error('--wake-delivery-only requires codex')
    // Real native hook latency, not a mocked receipt or a delayed provider response. The first
    // USER record is produced after SessionStart; resume runs it again. No host hooks are loaded.
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    writeFileSync(join(cwd, '.codex/hooks.json'), JSON.stringify({ hooks: {
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: '/bin/sleep 8', timeout: 20 }] }],
    } }))
  }
  if (runtime === 'codex') writeFileSync(peerLaunchEnvPath(cwd, runtime), "PEER_START_ARGS='--no-daemon -c model_reasoning_effort=low'\n")
  const senderCwd = join(root, 'sender')
  writePeerProfileAtomic(senderCwd, { personality: 'sender', runtime: 'notifier', runtimes: ['notifier'], intelligence: 'absent' })
  await upsertPeer({ personality: 'sender', runtime: 'notifier', intelligence: 'absent', cwd: senderCwd }, { env })
  const sink = await startSupervisorDaemon({ session: 'notifier-sender', runtime: 'notifier', runDir, daemonArgv: [bin, 'supervisor'], serve: { argv: ['/bin/cat'], env: {}, cwd: root, paneLogPath: join(root, 'sender.log') } })
  if (sink.state !== 'started') throw new Error(JSON.stringify(sink))
  const sentinelPid = readPidFile(runDir, 'notifier-sender')!.pid
  if (process.argv.includes('--death-delivery-only') || process.argv.includes('--unknown-delivery-only')) {
    writeFileSync(join(iap, 'alerts.json'), JSON.stringify({ peer: 'sender', runtime: 'notifier' }))
  }
  await must('version')
  if (process.argv.includes('--limit-resume-only')) {
    // No real human exists in this root: the launch-seed's contact goes to the local cat sink.
    const { readPeerProfile } = await import('../src/identity/index.ts')
    const { loadLifecycleConfig, setFreshNext } = await import('../src/lifecycle/index.ts')
    const { recordLimitPark, LIMIT_RESUME_GRACE_MS } = await import('../src/lifecycle/limitpark.ts')
    const kind = arg('--park-kind') ?? 'stale'
    const defaultRuntime = kind === 'default' ? runtime : runtime === 'codex' ? 'claude' : 'codex'
    writePeerProfileAtomic(cwd, { ...readPeerProfile(cwd)!, runtime: defaultRuntime, runtimes: ['claude', 'codex'], ...(kind === 'explicit' ? {} : { initial_prompt: 'Send AUTONOMOUS_CONTACT_PROOF to sender using the local iapeer CLI.' }) })
    // wake_policy is an owner field: the profile writer preserves it from disk, not its argument.
    if (process.argv.includes('--ephemeral')) {
      const path = join(cwd, '.iapeer/peer-profile.json')
      writeFileSync(path, JSON.stringify({ ...JSON.parse(read(path)), wake_policy: 'ephemeral' }))
    }
    await upsertPeer({ personality, runtime: defaultRuntime, runtimes: ['claude', 'codex'], intelligence: 'artificial', cwd }, { env })
    const { reindexFromLocals } = await import('../src/identity/profileStandard.ts')
    await reindexFromLocals({ env })
    const cfg = loadLifecycleConfig(env), eventAtMs = Date.now() - 10 * 60_000
    if (kind !== 'explicit') {
      recordLimitPark(cfg, { identity: identity(), personality, runtime, resetsAtMs: Date.now() - LIMIT_RESUME_GRACE_MS - 1000, eventAtMs })
      setFreshNext(cfg, identity())
    }
  }
  daemon = Bun.spawn([arg('--legacy-bin') ?? bin, 'daemon'], { env, stdout: Bun.file(join(root, 'daemon.out')), stderr: Bun.file(join(root, 'daemon.err')) })
  await until('installed daemon ready', () => read(join(root, 'daemon.err')).includes('daemon READY'))
  if (process.argv.includes('--limit-resume-only')) {
    const kind = arg('--park-kind') ?? 'stale'
    let original: string | undefined
    if (kind === 'explicit') {
      busyNext = true
      await send('RELOAD_BUSY_PROOF')
      await until('explicit non-default native turn in progress', () => busyReceived, 100000)
      await until('actual-delivery provenance receipt', () => existsSync(join(lifecycle, identity() + '.work-origin.json')))
      original = nativeSession()
      const { loadLifecycleConfig, removeSessionState, setIdleReaped } = await import('../src/lifecycle/index.ts')
      const { recordLimitPark, LIMIT_RESUME_GRACE_MS } = await import('../src/lifecycle/limitpark.ts')
      const { workOriginAtLimit } = await import('../src/lifecycle/workOrigin.ts')
      const cfg = loadLifecycleConfig(env), eventAtMs = Date.now()
      const file = transcripts().find(p => read(p).includes('RELOAD_BUSY_PROOF'))
      const workOrigin = workOriginAtLimit(cfg, identity(), eventAtMs, env, file)
      if (!workOrigin || !original) throw new Error('explicit native work has no proven origin/session')
      record('explicit-work-origin', { workOrigin, original, file })
      await must('supervisor', 'kill', identity(), '--run-dir', runDir)
      releaseBusy?.(); removeSessionState(cfg, identity()); setIdleReaped(cfg, identity())
      recordLimitPark(cfg, { identity: identity(), personality, runtime, resetsAtMs: Date.now() - LIMIT_RESUME_GRACE_MS - 1000, eventAtMs, workOrigin, file, sessionId: original, topic: 'operator-proof' })
    }
    await until('limit resume decision', () => read(join(iap, 'logs/iapeer/lifecycle.log')).includes('ev=limit-resume'), 100000)
    await Bun.sleep(10000)
    const lifecycleLog = read(join(iap, 'logs/iapeer/lifecycle.log'))
    const defaultRuntime = JSON.parse(read(join(iap, 'peers-profiles.json'))).peers.find((p: any) => p.personality === personality)?.default_runtime
    const turnCompleted = completedAfter(Date.now() - 20000)
    const { isEphemeralPeer } = await import('../src/lifecycle/index.ts')
    record('limit-resume-observed', { kind, ephemeral: isEphemeralPeer(cwd), defaultRuntime, original, session: nativeSession(), turnCompleted, hosting: hosting(), contactSent, outbound: read(join(root, 'sender.log')), lifecycle: lifecycleLog })
    if (process.argv.includes('--expect-fixed')) {
      if (contactSent) throw new Error('autonomous wake ran the contact launch-seed')
      if (kind === 'stale' ? hosting().pid || !lifecycleLog.includes('outcome=skipped-nondefault') : !lifecycleLog.includes('outcome=nudged') || !turnCompleted) throw new Error('wrong continuation outcome')
      if (kind === 'explicit' && nativeSession() !== original) throw new Error('explicit task did not resume its original native session')
      if (process.argv.includes('--ephemeral') && (!isEphemeralPeer(cwd) || !lifecycleLog.includes('ev=ephemeral-drain'))) throw new Error('ephemeral proof never exercised the FIFO')
    }
    success = true
  } else if (process.argv.includes('--wake-delivery-only')) {
    let coldSession: string | undefined
    for (const marker of ['COLD_DELAYED_DELIVERY_PROOF', 'RESUMED_DELAYED_DELIVERY_PROOF']) {
      const t = Date.now()
      const sent = await cli('send', personality, '--runtime', runtime, '--from', 'notifier-sender', '--topic', 'operator-proof', '--message', marker)
      await until('delayed native USER and complete', () => completedAfter(t), 60000)
      const nativeUsers = records().filter(r => r.type === 'response_item' && r.payload?.role === 'user' && r.payload.content?.some((c: any) => c.type === 'input_text' && c.text.includes(marker)))
      record('wake-delivery', { marker, sent, nativeUsers: nativeUsers.map(r => ({ timestamp: r.timestamp, path: r.path })), session: nativeSession() })
      if (coldSession && coldSession !== nativeSession()) throw new Error('idle-reaped proof did not resume the original session')
      coldSession = nativeSession()
      if (nativeUsers.length !== 1) throw new Error(`expected exactly one native USER for ${marker}, got ${nativeUsers.length}`)
      if (process.argv.includes('--expect-fixed') && sent.code !== 0) throw new Error(`false failure for ${marker}`)
      if (process.argv.includes('--expect-fixed')) {
        const acceptance = () => files(join(runDir, 'acceptance')).filter(p => p.endsWith('.json'))
          .map(p => JSON.parse(read(p))).find(r => r.message?.includes(marker))
        await until('durable native acceptance finalized and caller notified', () => {
          const r = acceptance()
          return r?.status === 'delivered' && r.callerNotice === 'sent'
        }, 60000)
        record('wake-acceptance-final', acceptance())
      }
      // On the buggy binary, failure exits wake before recording its topic. Preserve the intended
      // resume discriminator in the fixture, otherwise the second run tests another fresh wake.
      const { addTopic, loadLifecycleConfig } = await import('../src/lifecycle/index.ts')
      addTopic(loadLifecycleConfig(env), identity(), 'operator-proof')
      await until('natural idle reap', () => existsSync(join(lifecycle, identity() + '.idle-reaped')) && !hosting().pid, 100000)
    }
    success = true
  } else {
  await turn('FIRST_OPERATOR_PROOF')
  const original = nativeSession()
  if (!original) throw new Error('native session ID missing')
  record('cold-turn', { sessionID: original, hosting: hosting() })

  if (process.argv.includes('--refusal-delivery-only')) {
    // Real installed notifier policy, not a stand-in retry/fallback implementation.
    // Its registration store still reads HOME/.iapeer rather than IAPEER_ROOT.
    // Keep both names within this isolated root; never borrow the host registry.
    symlinkSync(iap, join(home, '.iapeer'))
    // The test harness reads this operator inbox. Declare it as an agent rather
    // than an unattended absent-intelligence service, which notifier correctly refuses.
    writePeerProfileAtomic(senderCwd, { personality: 'sender', runtime: 'notifier', runtimes: ['notifier'], intelligence: 'artificial' })
    await upsertPeer({ personality: 'sender', runtime: 'notifier', intelligence: 'artificial', cwd: senderCwd }, { env })
    await must('stop', personality, runtime)
    const watcherCwd = join(root, 'watcher')
    writePeerProfileAtomic(watcherCwd, { personality: 'watcher', runtime: 'notifier', runtimes: ['notifier'], intelligence: 'absent' })
    await upsertPeer({ personality: 'watcher', runtime: 'notifier', intelligence: 'absent', cwd: watcherCwd }, { env })
    const notifierBin = join(hostHome, '.local/bin/notifier-runtime')
    const watcher = await startSupervisorDaemon({ session: 'notifier-watcher', runtime: 'notifier', runDir,
      daemonArgv: [bin, 'supervisor'], serve: { argv: [notifierBin, 'run'], cwd: watcherCwd,
        env: { ...env, PEER_PERSONALITY: 'watcher', PEER_RUNTIME: 'notifier', PEER_IDENTITY: 'notifier-watcher', IAP_BIN: bin },
        paneLogPath: join(root, 'watcher.log') } })
    if (watcher.state !== 'started') throw new Error(JSON.stringify(watcher))
    await until('native notifier ready', () => read(join(root, 'watcher.log')).includes('"evt":"start"'))
    const { markHostReady } = await import('../src/launch/ptyHost.ts')
    markHostReady('notifier-watcher', env)
    const marker = 'PROVEN_PREPASTE_REFUSAL_FALLBACK', script = join(root, 'signal.sh')
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' '${marker}'\nexec /bin/sleep 300\n`); chmodSync(script, 0o700)
    await must('send', 'watcher', '--runtime', 'notifier', '--from', 'notifier-sender', '--message', JSON.stringify({
      script, target: personality, fallback: 'sender', id: 'prepaste-refusal-proof', topic: 'prepaste-refusal-proof',
    }))
    await until('real notifier automatic fallback', () => read(join(root, 'sender.log')).includes(marker), 90000)
    const nativeUsers = records().filter(r => r.type === 'response_item' && r.payload?.role === 'user' && JSON.stringify(r.payload).includes(marker))
    const log = read(join(iap, 'logs/iapeer/delivery.log'))
    record('prepaste-refusal-automatic-fallback', { log, sender: read(join(root, 'sender.log')), watcher: read(join(root, 'watcher.log')), nativeUsers })
    if (!log.includes('ok=false') || nativeUsers.length) throw new Error('refusal did not fail before native input')
    success = true
  } else if (process.argv.includes('--death-delivery-only')) {
    if (runtime !== 'codex') throw new Error('--death-delivery-only requires codex')
    stoppedChild = Number(Bun.spawnSync(['pgrep', '-P', String(hosting().pid)]).stdout.toString().trim().split('\n')[0])
    if (!stoppedChild) throw new Error('Codex child pid missing')
    process.kill(stoppedChild, 'SIGSTOP')
    const marker = 'CODEX_DIED_AFTER_PASTE_PROOF'
    const sent = await send(marker)
    const acceptance = () => files(join(runDir, 'acceptance')).filter(p => p.endsWith('.json')).map(p => JSON.parse(read(p))).find(r => r.message?.includes(marker))
    if (acceptance()?.status !== 'pending') throw new Error('blocked submit did not transfer pending custody')
    process.kill(stoppedChild, 'SIGKILL'); stoppedChild = undefined
    await until('dead native unresolved and both notices accepted', () => {
      const r = acceptance()
      return r?.status === 'unresolved' && r.callerNotice === 'sent' && r.lastAlertAt !== undefined
    }, 150000)
    const nativeUsers = records().filter(r => r.type === 'response_item' && r.payload?.role === 'user' && JSON.stringify(r.payload).includes(marker))
    const log = read(join(iap, 'logs/iapeer/delivery.log')), sender = read(join(root, 'sender.log'))
    const r = acceptance()
    record('death-after-paste-unresolved', { sent, acceptance: r, nativeUsers, log, sender })
    if (r?.status !== 'unresolved' || nativeUsers.length || log.includes('ev=inflight-redeliver') || !sender.includes(r.id)) throw new Error('death was failed/replayed or escalation missing')
    success = true
  } else if (process.argv.includes('--unknown-delivery-only')) {
    if (runtime !== 'claude') throw new Error('--unknown-delivery-only requires claude')
    stoppedChild = Number(Bun.spawnSync(['pgrep', '-P', String(hosting().pid)]).stdout.toString().trim().split('\n')[0])
    if (!stoppedChild) throw new Error('Claude child pid missing')
    process.kill(stoppedChild, 'SIGSTOP')
    const marker = 'CLAUDE_UNKNOWN_ONCE_PROOF', t = Date.now()
    const sent = await send(marker)
    await until('unknown escalation or legacy replay', () => {
      const log = read(join(iap, 'logs/iapeer/delivery.log'))
      return log.includes('outcome=unresolved') || log.includes('ev=inflight-redeliver')
    }, 210000)
    const log = read(join(iap, 'logs/iapeer/delivery.log'))
    record('unknown-delivery-escalation', { sent, log, sender: read(join(root, 'sender.log')),
      acceptance: files(join(runDir, 'acceptance')).map(p => JSON.parse(read(p))) })
    if (process.argv.includes('--expect-fixed') && (!log.includes('outcome=unresolved') || log.includes('ev=inflight-redeliver'))) throw new Error('unknown was replayed or not escalated')
    process.kill(stoppedChild, 'SIGCONT'); stoppedChild = undefined
    // Do NOT rescue the existing draft with operator keystrokes. The core must
    // either submit normally or keep it truthfully unresolved and visibly escalated.
    await Bun.sleep(3000)
    const userTexts = records().filter(r => r.type === 'user').map(r => typeof r.message?.content === 'string' ? r.message.content : JSON.stringify(r.message?.content))
    const occurrences = userTexts.reduce((n, text) => n + (text?.split(marker).length - 1 || 0), 0)
    const acceptance = files(join(runDir, 'acceptance')).map(p => JSON.parse(read(p))).find(r => r.message?.includes(marker))
    const { captureHostState } = await import('../src/supervisor/capture.ts')
    record('unknown-delivery-native-input', { occurrences, userTexts, acceptance, view: await captureHostState(runDir, identity()), operatorKeystrokes: 0 })
    if (process.argv.includes('--expect-fixed') && (occurrences > 1 || (occurrences === 0 && acceptance?.status !== 'unresolved') || sent.stdout.includes('delivered to'))) throw new Error('unknown input duplicated or falsely reported delivered')
    success = true
  } else if (process.argv.includes('--blocked-only')) {
    // Contrast: a session whose TUI cannot accept input (SIGSTOP stands in for any modal) still
    // ACKs pty bytes. A correct core reports failure; the buggy socket-ack path reported delivered.
    if (runtime !== 'codex') throw new Error('--blocked-only requires codex')
    const child = Bun.spawnSync(['pgrep', '-P', String(hosting().pid)]).stdout.toString().trim().split('\n')[0]
    if (!child) throw new Error('codex child pid missing')
    process.kill(Number(child), 'SIGSTOP')
    const t = Date.now()
    const sent = await cli('send', personality, '--runtime', runtime, '--from', 'notifier-sender', '--topic', 'operator-proof', '--message', 'BLOCKED_DELIVERY_PROOF')
    record('delivery-blocked', { child, sent, completedWhileBlocked: completedAfter(t) })
    process.kill(Number(child), 'SIGCONT')
    success = true
  } else if (process.argv.includes('--deliver-only')) {
    if (runtime !== 'codex') throw new Error('--deliver-only requires codex')
    const { captureHostViewport } = await import('../src/supervisor/capture.ts')
    for (const size of [500, 1482, 8000]) {
      const marker = `DELIVERY_SIZE_${size}`
      const t = Date.now(), sent = await send(marker + ' x'.repeat(Math.ceil(size / 2)))
      await Bun.sleep(2000)
      record('delivery-idle', { size, sent, completed: completedAfter(t), view: await captureHostViewport(runDir, identity()) })
    }
    busyNext = true; busyReceived = false
    await send('RELOAD_BUSY_PROOF'); await until('busy request', () => busyReceived)
    const t = Date.now(), sent = await send('DELIVERY_BUSY_LONG ' + ' x'.repeat(1000))
    record('delivery-busy', { sent, view: await captureHostViewport(runDir, identity()) })
    releaseBusy?.()
    await Bun.sleep(3000)
    record('delivery-after-busy', { completed: completedAfter(t), view: await captureHostViewport(runDir, identity()) })
    success = true
  } else if (process.argv.includes('--reload-only') || process.argv.includes('--provider-only') || process.argv.includes('--remove-only') || process.argv.includes('--hand-edit-only') || process.argv.includes('--enable-only') || arg('--legacy-bin')) {
    let busyAt = 0
    await proveReload({ root, cwd, runtime, cli, turn, hosting, session: nativeSession, record,
      probe: async () => {
        const from = wire.length, calls = surface.calls(); useSurface = true
        try { await turn('RELOAD_TOOL_PROOF') } finally { useSurface = false }
        return { offered: wire.slice(from).some(w => !!findSurfaceTool(w.body.tools)), calls: surface.calls() - calls, names: [...new Set(wire.slice(from).flatMap(w => surfaceNames(w.body.tools)))] }
      },
      nativeRun: async args => {
        const p = Bun.spawn([native, ...args], { env, cwd, stdout: 'pipe', stderr: 'pipe' })
        const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
        return { code, stdout, stderr }
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
    }, surface.url, !!arg('--legacy-bin'), process.argv.includes('--provider-only') ? 'provider' : process.argv.includes('--remove-only') ? 'remove' : process.argv.includes('--hand-edit-only') ? 'hand-edit' : process.argv.includes('--enable-only') ? 'enable' : 'capability')
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
  }
} finally {
  if (stoppedChild) { try { process.kill(stoppedChild, 'SIGCONT') } catch {} }
  releaseBusy?.()
  if (attached) { attached.kill(); await attached.exited; attached.terminal?.close() }
  if (daemon) { daemon.kill(); await daemon.exited }
  for (const p of ['operator-proof', 'operator-renamed']) await cli('supervisor', 'kill', `${runtime}-${p}`, '--run-dir', runDir)
  await cli('supervisor', 'kill', 'notifier-sender', '--run-dir', runDir)
  if (process.argv.includes('--refusal-delivery-only')) await cli('supervisor', 'kill', 'notifier-watcher', '--run-dir', runDir)
  provider.stop(true)
  surface.stop()
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true })
    for (const p of files(root).filter(p => (/(?:\.jsonl|\.log|\.out|\.err|installed_plugins\.json|known_marketplaces\.json|\/settings\.json|\.mcp\.json|config\.toml)$/.test(p) || p.includes('/acceptance/') && p.endsWith('.json')) && !p.includes('/node_modules/'))) {
      const dest = join(artifacts, p.slice(root.length + 1)); mkdirSync(resolve(dest, '..'), { recursive: true }); cpSync(p, dest)
    }
    writeFileSync(join(artifacts, 'wire.json'), JSON.stringify(wire, null, 2))
    writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ success, bin, binSHA256, legacyBinSHA256, runtime, native, results }, null, 2) + '\n')
  }
  console.log(JSON.stringify({ success, runtime, results }, null, 2))
  await Bun.sleep(500); rmSync(root, { recursive: true, force: true })
}
