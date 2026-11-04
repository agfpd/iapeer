// Real Anthropic 401 -> native Codex, no mocked provider responses.
// --bin may point at a source CLI wrapper for development; acceptance uses installed iapeer.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const host = homedir(), bin = resolve(arg('--bin') ?? join(host, '.local/bin/iapeer'))
const binSHA256 = createHash('sha256').update(readFileSync(bin)).digest('hex')
const artifacts = resolve(arg('--artifacts') ?? 'docs/internals/proofs/failover-real-auth')
const root = realpathSync(mkdtempSync('/tmp/iapeer-failover-live-')), home = join(root, 'home'), iap = join(root, 'iapeer'), cwd = join(root, 'failover-proof')
const read = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]) : []
const reserve = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserve') })
const port = reserve.port!; reserve.stop(true)
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'), TERM: 'xterm-256color',
  IAPEER_ROOT: iap, IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'), IAPEER_SOCK_DIR: join(root, 's'),
  IAPEER_PORT: String(port), IAPEER_DAEMON_SOCKET: join(root, 'router.sock'),
  IAPEER_CLAUDE_BIN: join(root, 'claude-wrapper'), IAPEER_CODEX_BIN: '/opt/homebrew/bin/codex', IAPEER_IDLE_SECS: '900',
  DISABLE_AUTOUPDATER: '1', HOMEBREW_NO_AUTO_UPDATE: '1', IAPEER_TEST_SANDBOX: '1',
}
for (const k of Object.keys(process.env)) delete process.env[k]
Object.assign(process.env, env)
const { initPeer } = await import('../src/init/index.ts')
const { upsertPeer } = await import('../src/registry/index.ts')
const { writePeerProfileAtomic } = await import('../src/identity/index.ts')
const { peerLaunchEnvPath } = await import('../src/storage/index.ts')
const { loadLifecycleConfig, setStopped } = await import('../src/lifecycle/index.ts')
const { selectFailoverRuntime } = await import('../src/lifecycle/failover.ts')
const { readPeersIndex, findPeer } = await import('../src/registry/index.ts')
const results: unknown[] = []
const until = async (what: string, f: () => boolean, ms = 180_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (f()) return; await Bun.sleep(200) }
  throw new Error(`timeout: ${what}`)
}
const cli = async (...args: string[]) => {
  const p = Bun.spawn([bin, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()])
  const r = { args, code, stdout, stderr }; results.push(r)
  if (code) throw new Error(JSON.stringify(r))
  return r
}
const check = (label: string, value: unknown) => { if (value === false) throw new Error(`failed: ${label}`); results.push({ check: label, value, at: Date.now() }); console.log(`PASS ${label}`) }
const failoverTasks = () => files(join(iap, 'state/lifecycle/failover/tasks')).filter(f => f.endsWith('.json')).map(f => JSON.parse(read(f)))
const claudeText = () => files(join(home, '.claude/projects')).filter(f => f.endsWith('.jsonl')).map(read).join('\n')
const log = join(root, 'effects.log'), first = `FIRST_${randomUUID()}`, second = `SECOND_${randomUUID()}`
const commandTask = (marker: string) => `This is a disposable infrastructure acceptance test. Execute exactly one shell command: printf '%s\\n' '${marker}' >> '${log}'. Do not check for an existing marker or deduplicate yourself: the router is being tested. Do not send messages to anyone. Then reply DONE.`
let daemon: ReturnType<typeof Bun.spawn> | undefined, success = false
try {
  mkdirSync(cwd, { recursive: true }); mkdirSync(join(home, '.claude'), { recursive: true }); mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true }))
  // Read-only copy: the real fleet's credential file/configuration is never modified.
  cpSync(join(host, '.codex/auth.json'), join(home, '.codex/auth.json'))
  const model = /^model\s*=\s*(.+)$/m.exec(read(join(host, '.codex/config.toml')))?.[1]
  if (!model) throw new Error('host Codex model is not configured')
  writeFileSync(join(home, '.codex/config.toml'), `check_for_update_on_startup = false\nmodel = ${model}\nmodel_reasoning_effort = "low"\n`)
  writeFileSync(env.IAPEER_CLAUDE_BIN!, `#!/bin/sh\nexec env ANTHROPIC_AUTH_TOKEN=iapeer-intentionally-invalid-auth-proof '${join(host, '.local/bin/claude')}' "$@"\n`)
  chmodSync(env.IAPEER_CLAUDE_BIN!, 0o700)
  await initPeer({ cwd, runtime: 'claude', personality: 'failover-proof', intelligence: 'artificial', env })
  await initPeer({ cwd, runtime: 'codex', personality: 'failover-proof', intelligence: 'artificial', env })
  writePeerProfileAtomic(cwd, { personality: 'failover-proof', runtime: 'claude', runtimes: ['claude', 'codex'], intelligence: 'artificial' })
  await upsertPeer({ personality: 'failover-proof', runtime: 'claude', runtimes: ['claude', 'codex'], intelligence: 'artificial', cwd }, { env })
  writeFileSync(peerLaunchEnvPath(cwd, 'codex'), "PEER_START_ARGS='--no-daemon -c model_reasoning_effort=low'\n")
  const sender = join(root, 'sender')
  writePeerProfileAtomic(sender, { personality: 'sender', runtime: 'notifier', runtimes: ['notifier'], intelligence: 'absent' })
  await upsertPeer({ personality: 'sender', runtime: 'notifier', intelligence: 'absent', cwd: sender }, { env })
  daemon = Bun.spawn([bin, 'daemon'], { env, stdout: Bun.file(join(root, 'daemon.stdout')), stderr: Bun.file(join(root, 'daemon.stderr')) })
  await until('daemon ready', () => read(join(root, 'daemon.stderr')).includes('daemon READY'))
  await cli('send', 'failover-proof', '--from', 'notifier-sender', '--message', commandTask(first), '--topic', 'real-auth-failover')
  await until('real 401 observed', () => claudeText().includes('"apiErrorStatus":401'))
  check('native Anthropic 401 (no synthetic provider)', /Invalid bearer token/.test(claudeText()))
  await until('first effect transferred to Codex', () => read(log).includes(first))
  await until('durable transfer receipt', () => failoverTasks().some(t => t.state === 'transferred'))
  check('initial refused task transferred exactly once', read(log).trim().split('\n').filter(l => l === first).length === 1)
  const secondResult = await cli('send', 'failover-proof', '--from', 'notifier-sender', '--message', commandTask(second), '--topic', 'known-broken-bypass')
  await until('second effect', () => read(log).includes(second))
  if (claudeText().includes(second)) throw new Error('known-broken primary received second task')
  check('known-broken primary log excludes new task', secondResult)
  // The original failed native ID stays quarantined after daemon restart.
  daemon.kill('SIGTERM'); await daemon.exited
  daemon = Bun.spawn([bin, 'daemon'], { env, stdout: Bun.file(join(root, 'daemon-restart.stdout')), stderr: Bun.file(join(root, 'daemon-restart.stderr')) })
  await until('restarted daemon ready', () => read(join(root, 'daemon-restart.stderr')).includes('daemon READY'))
  const cfg = loadLifecycleConfig(env), p = findPeer(readPeersIndex({ env }), 'failover-proof')!
  if (!process.argv.includes('--quick')) {
  // Credential repair is a native authentication change, never a mocked success.
  // Read the host keychain only in the launched native process; no token is printed or archived.
  writeFileSync(env.IAPEER_CLAUDE_BIN!, `#!/bin/sh\nTOKEN=$(/usr/bin/security find-generic-password -s 'Claude Code-credentials' -w | /usr/bin/python3 -c 'import sys,json; print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])') || exit 1\nexec env CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" '${join(host, '.local/bin/claude')}' "$@"\n`)
  await cli('new', 'failover-proof', 'claude')
  const oldID = failoverTasks().find(t => t.state === 'transferred')?.failure?.sessionId
  if (!oldID || !read(join(iap, 'state/lifecycle/failover/claude-failover-proof.quarantine.json')).includes(oldID)) throw new Error('missing quarantine')
  check('failed native session quarantined durably after restart', oldID)
  const reset = JSON.parse(read(join(cfg.stateDir, 'failover/claude-failover-proof.provider.json'))).retryAtMs
  await until('bounded primary retry interval', () => Date.now() > reset, 310_000)
  await cli('send', 'failover-proof', '--from', 'notifier-sender', '--message', 'This is the repaired-runtime acceptance probe. Do not call tools or repeat any earlier instruction. Reply RECOVERED_PRIMARY_OK.', '--topic', 'provider-recovered')
  await until('repaired primary real response', () => {
    const txt = claudeText()
    return txt.split('\n').some(l => { try { const r = JSON.parse(l); return r.type === 'assistant' && r.message?.model !== '<synthetic>' && JSON.stringify(r.message?.content).includes('RECOVERED_PRIMARY_OK') } catch { return false } })
  })
  await Bun.sleep(65_000) // cross another supervisor/limit-resume opportunity
  if (read(log).trim().split('\n').filter(l => l === first).length !== 1 || read(log).trim().split('\n').filter(l => l === second).length !== 1) throw new Error('duplicate effect after primary recovery')
  check('primary recovery executes neither old task again', read(log))
  }
  // Private isolated policy contrast. Production walt policy is checked read-only separately.
  setStopped(cfg, 'codex-failover-proof'); setStopped(cfg, 'claude-failover-proof')
  if (selectFailoverRuntime(cfg, p).ok) throw new Error('stopped endpoints selected')
  check('all stopped => no failover candidate', true)
  success = true
} finally {
  if (daemon) { daemon.kill('SIGTERM'); await daemon.exited }
  // Installed CLI teardown owns only these isolated hosting sockets/processes.
  for (const rt of ['claude', 'codex']) {
    const p = Bun.spawn([bin, 'stop', 'failover-proof', rt], { env, stdout: 'ignore', stderr: 'ignore' }); await p.exited
  }
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ success, root, bin, binSHA256, results }, null, 2))
  for (const [source, dest] of [[join(iap, 'logs/iapeer'), 'logs'], [join(iap, 'logs/lifecycle'), 'pane-logs'], [join(iap, 'state/lifecycle/failover'), 'failover'], [join(home, '.claude/projects'), 'claude-transcripts'], [join(home, '.codex/sessions'), 'codex-transcripts']] as const) if (existsSync(source)) cpSync(source, join(artifacts, dest), { recursive: true })
  if (existsSync(log)) cpSync(log, join(artifacts, 'effects.log'))
  console.log(JSON.stringify({ success, artifacts, root }))
  rmSync(root, { recursive: true, force: true })
}
