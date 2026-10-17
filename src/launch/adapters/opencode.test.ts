import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { opencodeAdapter } from './opencode.ts'
import { opencodePaths } from '../../opencode/config.ts'
import type { LaunchSpec } from '../types.ts'

let root: string
let env: NodeJS.ProcessEnv
let servers: Server[] = []

beforeEach(() => {
  // short base: unix socket paths are length-limited (control.sock under the root)
  root = mkdtempSync(join('/tmp', 'ocad-'))
  env = { HOME: join(root, 'home'), IAPEER_ROOT: join(root, 'r'), IAPEER_PORT: '9911' }
  mkdirSync(env.HOME!, { recursive: true })
})
afterEach(() => {
  for (const s of servers) s.close()
  servers = []
  rmSync(root, { recursive: true, force: true })
})

function spec(over: Partial<LaunchSpec> = {}): LaunchSpec {
  // an explicit provider is mandatory for every launch (pinProvider)
  const pp = opencodePaths(over.personality ?? 'alice', { env })
  mkdirSync(pp.dir, { recursive: true })
  if (!existsSync(pp.config)) writeFileSync(pp.config, JSON.stringify({ model: 'syn/m' }))
  const prompt = join(root, 'prompt.md')
  writeFileSync(prompt, 'DOCTRINE-X')
  return { personality: 'alice', runtime: 'opencode', cwd: root, identity: 'opencode-alice', socketPath: '/tmp/x.sock', systemPromptFile: prompt, ...over }
}

/** A fake plugin control socket answering one JSON line per connection. */
function fakeControl(personality: string, answer: (req: any) => object): Promise<void> {
  const dir = opencodePaths(personality, { env }).dir
  mkdirSync(dir, { recursive: true })
  const srv = createServer(conn => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('data', c => {
      buf += c
      const nl = buf.indexOf('\n')
      if (nl >= 0) conn.end(JSON.stringify(answer(JSON.parse(buf.slice(0, nl)))) + '\n')
    })
  })
  servers.push(srv)
  return new Promise(r => srv.listen(join(dir, 'control.sock'), () => r()))
}

describe('opencode adapter — argv', () => {
  test('fresh yolo: agent + --auto, no session', () => {
    expect(opencodeAdapter.buildArgv(spec(), { claudeBin: 'c', codexBin: 'x', opencodeBin: '/bin/oc' })).toEqual(['/bin/oc', '--agent', 'iapeer', '--auto'])
  })
  test('resume carries --session; gated drops --auto; extra args last', () => {
    const argv = opencodeAdapter.buildArgv(spec({ resume: true, resumeRef: 'ses_1', approvalMode: 'gated', extraArgs: ['-m', 'p/m'] }), { claudeBin: 'c', codexBin: 'x' })
    expect(argv).toEqual(['opencode', '--session', 'ses_1', '--agent', 'iapeer', '-m', 'p/m'])
  })
})

describe('opencode adapter — prepareLaunch', () => {
  test('writes the plugin, composes config with fresh doctrine + identity MCP, merges inline config', () => {
    const p = opencodeAdapter.prepareLaunch!(spec({ resume: true, resumeRef: 'ses_9' }), { OPENCODE_CONFIG_CONTENT: '{"model":"p/m"}' }, { claudeBin: 'c', codexBin: 'x', env })
    const paths = opencodePaths('alice', { env })
    expect(existsSync(paths.plugin)).toBe(true)
    expect(p.env.IAPEER_OPENCODE_DIR).toBe(paths.dir)
    expect(p.env.IAPEER_OPENCODE_SESSION).toBe('ses_9')
    expect(p.env.IAPEER_OPENCODE_LAUNCH_ID).toBe(p.readyToken!)
    const cfg = JSON.parse(p.env.OPENCODE_CONFIG_CONTENT!)
    expect(cfg.model).toBe('p/m')
    expect(cfg.agent.iapeer.prompt).toBe('DOCTRINE-X')
    expect(cfg.mcp.iapeer.url).toBe('http://127.0.0.1:9911/mcp')
    expect(cfg.mcp.iapeer.headers['X-IAPeer-Identity']).toBe('{env:PEER_IDENTITY}')
  })
  test('fresh launch sets no session; each launch gets a distinct launchID', () => {
    const a = opencodeAdapter.prepareLaunch!(spec(), {}, { claudeBin: 'c', codexBin: 'x', env })
    const b = opencodeAdapter.prepareLaunch!(spec(), {}, { claudeBin: 'c', codexBin: 'x', env })
    expect(a.env.IAPEER_OPENCODE_SESSION).toBeUndefined()
    expect(a.readyToken).not.toBe(b.readyToken)
  })
  test('gated: agent ask rules + broker bridge env; yolo: none', () => {
    const g = opencodeAdapter.prepareLaunch!(spec({ approvalMode: 'gated' }), {}, { claudeBin: 'c', codexBin: 'x', env })
    expect(g.env.IAPEER_APPROVAL_MODE).toBe('gated')
    expect(g.env.IAPEER_FLEET_URL).toBe('http://127.0.0.1:9911')
    expect(JSON.parse(g.env.OPENCODE_CONFIG_CONTENT!).agent.iapeer.permission).toMatchObject({ bash: 'ask', edit: 'ask', webfetch: 'ask' })
    const y = opencodeAdapter.prepareLaunch!(spec(), { OPENCODE_CONFIG_CONTENT: '{"agent":{"iapeer":{"permission":{"bash":"allow"}}}}' }, { claudeBin: 'c', codexBin: 'x', env })
    expect(y.env.IAPEER_APPROVAL_MODE).toBe('yolo')
    expect(JSON.parse(y.env.OPENCODE_CONFIG_CONTENT!).agent.iapeer.permission).toEqual({ bash: 'allow' }) // foreign kept on yolo
    const g2 = opencodeAdapter.prepareLaunch!(spec({ approvalMode: 'gated' }), { OPENCODE_CONFIG_CONTENT: '{"agent":{"iapeer":{"permission":{"bash":"allow"}}}}' }, { claudeBin: 'c', codexBin: 'x', env })
    expect(JSON.parse(g2.env.OPENCODE_CONFIG_CONTENT!).agent.iapeer.permission.bash).toBe('ask') // gated is last writer
  })
  test('no provider configured → launches, but never silently (warning for lifecycle.log)', () => {
    const s = spec()
    writeFileSync(opencodePaths('alice', { env }).config, '{}')
    const p = opencodeAdapter.prepareLaunch!(s, {}, { claudeBin: 'c', codexBin: 'x', env })
    expect(p.warnings?.[0]).toMatch(/opencode-implicit-provider/)
    writeFileSync(opencodePaths('alice', { env }).config, JSON.stringify({ model: 'syn/m' }))
    expect(opencodeAdapter.prepareLaunch!(s, {}, { claudeBin: 'c', codexBin: 'x', env }).warnings).toEqual([])
  })
  test('missing composed prompt fails loud', () => {
    expect(() => opencodeAdapter.prepareLaunch!(spec({ systemPromptFile: join(root, 'nope.md') }), {}, { claudeBin: 'c', codexBin: 'x', env })).toThrow(/system prompt missing/)
  })
})

describe('opencode adapter — structural readiness', () => {
  function journal(line: object) {
    appendFileSync(opencodePaths('alice', { env }).events, JSON.stringify(line) + '\n')
  }
  test('ready only on THIS launch runtime.ready, after the prepare-time offset', async () => {
    const s = spec()
    const p = opencodeAdapter.prepareLaunch!(s, {}, { claudeBin: 'c', codexBin: 'x', env })
    await fakeControl('alice', () => ({ ok: true, launchID: p.readyToken }))
    journal({ seq: 1, launchID: 'lch_other', type: 'runtime.ready' })
    setTimeout(() => journal({ seq: 2, launchID: p.readyToken, type: 'runtime.ready' }), 100)
    const r = await opencodeAdapter.structuralReady!(s, p.readyToken!, Date.now() + 5000, () => true, env)
    expect(r).toEqual({ ok: true })
  })
  test('a stale ready line written before prepare does not count', async () => {
    const s = spec()
    mkdirSync(opencodePaths('alice', { env }).dir, { recursive: true })
    const p0 = opencodeAdapter.prepareLaunch!(s, {}, { claudeBin: 'c', codexBin: 'x', env })
    journal({ seq: 1, launchID: p0.readyToken, type: 'runtime.ready' })
    const p = opencodeAdapter.prepareLaunch!(s, {}, { claudeBin: 'c', codexBin: 'x', env })
    const r = await opencodeAdapter.structuralReady!(s, p.readyToken!, Date.now() + 700, () => true, env)
    expect(r.ok).toBe(false)
  })
  test('runtime.error fails with the reported error; dead process fails fast', async () => {
    const s = spec()
    const p = opencodeAdapter.prepareLaunch!(s, {}, { claudeBin: 'c', codexBin: 'x', env })
    journal({ seq: 1, launchID: p.readyToken, type: 'runtime.error', properties: { error: 'boom' } })
    expect(await opencodeAdapter.structuralReady!(s, p.readyToken!, Date.now() + 5000, () => true, env)).toEqual({ ok: false, reason: 'runtime.error: boom' })
    const q = opencodeAdapter.prepareLaunch!(s, {}, { claudeBin: 'c', codexBin: 'x', env })
    const r = await opencodeAdapter.structuralReady!(s, q.readyToken!, Date.now() + 5000, () => false, env)
    expect(r.reason).toMatch(/exited before runtime.ready/)
  })
  test('ready line but control socket answering another launch → not ready', async () => {
    const s = spec()
    const p = opencodeAdapter.prepareLaunch!(s, {}, { claudeBin: 'c', codexBin: 'x', env })
    await fakeControl('alice', () => ({ ok: true, launchID: 'lch_stale' }))
    journal({ seq: 1, launchID: p.readyToken, type: 'runtime.ready' })
    const r = await opencodeAdapter.structuralReady!(s, p.readyToken!, Date.now() + 5000, () => true, env)
    expect(r.ok).toBe(false)
  })
})

describe('opencode adapter — observation, resume, delivery, control', () => {
  const ctx = () => ({ personality: 'alice', env })
  function state(st: object) {
    const p = opencodePaths('alice', { env })
    mkdirSync(p.dir, { recursive: true })
    writeFileSync(p.state, JSON.stringify({ schema: 1, identity: 'opencode-alice', launchID: 'l', sessionID: 'ses_A', lastActivityMs: 1234, status: 'idle', ...st }))
  }
  test('no context → null / not ok (state is personality-scoped)', () => {
    expect(opencodeAdapter.lastTurnMtime(root)).toBeNull()
    expect(opencodeAdapter.newestActivityMtime(root)).toBeNull()
    expect(opencodeAdapter.resolveResume(root).ok).toBe(false)
  })
  test('resume ref = recorded session; none recorded → explicit failure', () => {
    expect(opencodeAdapter.resolveResume(root, ctx()).ok).toBe(false)
    state({})
    expect(opencodeAdapter.resolveResume(root, ctx())).toEqual({ ok: true, ref: 'ses_A' })
  })
  test('idle → lastActivityMs; busy/approval → now', () => {
    state({ status: 'idle' })
    expect(opencodeAdapter.lastTurnMtime(root, ctx())).toBe(1234)
    state({ status: 'busy' })
    expect(opencodeAdapter.lastTurnMtime(root, ctx())!).toBeGreaterThan(Date.now() - 5000)
  })
  test('deliver acks with the native messageID; failure is surfaced', async () => {
    let seen = ''
    await fakeControl('alice', req => (seen = req.text, req.text === 'bad' ? { ok: false, error: 'nope' } : { ok: true, messageID: 'msg_1' }))
    expect(await opencodeAdapter.deliver!({ personality: 'alice', identity: 'opencode-alice' }, 'hello', env)).toEqual({ ok: true, messageID: 'msg_1' })
    expect(seen).toBe('hello')
    expect(await opencodeAdapter.deliver!({ personality: 'alice', identity: 'opencode-alice' }, 'bad', env)).toEqual({ ok: false, error: 'nope' })
  })
  test('deliver with no live plugin fails (never a silent ok)', async () => {
    const r = await opencodeAdapter.deliver!({ personality: 'alice', identity: 'opencode-alice' }, 'x', env)
    expect(r.ok).toBe(false)
  })
  test('interrupt is structural; unsupported commands fail loud', async () => {
    let op = ''
    await fakeControl('alice', req => (op = req.op, { ok: true }))
    expect(await opencodeAdapter.control!({ personality: 'alice', identity: 'opencode-alice' }, { name: 'interrupt' }, env)).toEqual({ ok: true })
    expect(op).toBe('interrupt')
    const c = await opencodeAdapter.control!({ personality: 'alice', identity: 'opencode-alice' }, { name: 'goal' }, env)
    expect(c.ok).toBe(false)
    expect(await opencodeAdapter.control!({ personality: 'alice', identity: 'opencode-alice' }, { name: 'compact' }, env)).toEqual({ ok: true })
    expect(op).toBe('compact')
    expect(opencodeAdapter.executeControl({ name: 'interrupt' })).toBeNull()
  })
})
