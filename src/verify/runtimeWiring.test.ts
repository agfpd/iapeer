import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runtimeWiringIssues } from './runtimeWiring.ts'
import { discoverPeerRuntimes, readPeerProfile, writePeerProfileAtomic } from '../identity/index.ts'
import { upsertPeer } from '../registry/index.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'iapeer-wiring-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
function check(runtimes = ['claude', 'codex']) {
  return runtimeWiringIssues(join(root, 'peer'), runtimes, { env: { HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex') } })
}

test('declared but unwired endpoints are errors even without domain MCP parity drift', () => {
  expect(check().map(i => i.runtime)).toEqual(['claude', 'codex'])
  put(join(root, 'peer', '.mcp.json'), JSON.stringify({ mcpServers: { iapeer: { type: 'http', url: 'http://localhost:8765/mcp' } } }))
  put(join(root, 'codex', 'config.toml'), '[mcp_servers.iapeer]\nurl="http://localhost:8765/mcp"\n')
  expect(check()).toEqual([])
})

test('peer Codex declaration overrides host, including disabled or unusable wiring', () => {
  put(join(root, 'codex', 'config.toml'), '[mcp_servers.iapeer]\nurl="http://localhost:8765/mcp"\n')
  expect(check(['codex'])).toEqual([])
  put(join(root, 'peer', '.codex', 'config.toml'), '[mcp_servers.iapeer]\nenabled=true\n')
  expect(check(['codex'])).toEqual([]) // a partial table inherits the host URL
  put(join(root, 'peer', '.codex', 'config.toml'), '[mcp_servers.iapeer]\nenabled=false\n')
  expect(check(['codex'])).toHaveLength(1)
  put(join(root, 'peer', '.codex', 'config.toml'), '[mcp_servers.iapeer]\nurl=""\n')
  expect(check(['codex'])).toHaveLength(1)
  put(join(root, 'peer', '.codex', 'config.toml'), 'a = {')
  expect(check(['codex'])).toHaveLength(1)
})

test('invalid Claude config is not wired; dynamic OpenCode and infra are not false alarms', () => {
  put(join(root, 'peer', '.mcp.json'), '{bad-json')
  expect(check(['claude'])).toHaveLength(1)
  put(join(root, 'peer', '.mcp.json'), '{"mcpServers":{"iapeer":{}}}')
  expect(check(['claude'])).toHaveLength(1)
  expect(check(['opencode', 'web', 'telegram'])).toEqual([])
})

test('empty scope does not auto-declare a runtime; explicit profile declaration survives', () => {
  const cwd = join(root, 'peer')
  mkdirSync(join(cwd, '.iapeer', 'runtimes', 'opencode'), { recursive: true })
  expect(discoverPeerRuntimes(cwd, 'claude')).toEqual(['claude'])
  writePeerProfileAtomic(cwd, { personality: 'peer', runtime: 'claude', runtimes: ['claude', 'opencode'] })
  expect(readPeerProfile(cwd)!.runtimes).toContain('opencode')
  expect(discoverPeerRuntimes(cwd, 'opencode')).toContain('opencode')
})

test('real verify CLI reports missing core MCP in JSON, exits nonzero, then passes after wiring', async () => {
  const cwd = join(root, 'peer')
  const env = { ...process.env, HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'), IAPEER_ROOT: join(root, 'state'), IAPEER_LAUNCHAGENTS_DIR: join(root, 'launchagents') }
  writePeerProfileAtomic(cwd, { personality: 'peer', runtime: 'claude', runtimes: ['claude'], intelligence: 'artificial', description: 'Isolated verify test' })
  await upsertPeer({ personality: 'peer', runtime: 'claude', cwd, intelligence: 'artificial', description: 'Isolated verify test' }, { env })
  const run = () => Bun.spawnSync([process.execPath, join(import.meta.dir, '../cli/index.ts'), 'verify', '--json'], { env })
  const before = run()
  expect(before.exitCode).toBe(1)
  expect(JSON.parse(before.stdout.toString()).runtimeWiring).toEqual([{ personality: 'peer', runtime: 'claude', detail: 'core iapeer MCP server is missing, disabled or has no URL' }])
  put(join(cwd, '.mcp.json'), '{"mcpServers":{"iapeer":{"type":"http","url":"http://localhost:8765/mcp"}}}')
  const after = run()
  expect(after.exitCode).toBe(0)
  expect(JSON.parse(after.stdout.toString()).runtimeWiring).toEqual([])
})
