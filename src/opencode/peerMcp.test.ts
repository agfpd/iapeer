import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncOpencodePeerMcp } from './peerMcp.ts'
import { composeOpencodeConfig, opencodePaths } from './config.ts'
import { mcpParity } from '../verify/mcpParity.ts'
import { claudeVarsToOpencode, specFromCodex, toOpencodeMcp } from '../mcp/peerServers.ts'

let root: string
let cwd: string
let env: NodeJS.ProcessEnv
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peermcp-'))
  cwd = join(root, 'mrmechanic')
  mkdirSync(join(cwd, '.codex'), { recursive: true })
  mkdirSync(join(root, 'home'), { recursive: true })
  env = { HOME: join(root, 'home'), IAPEER_ROOT: join(root, 'iapeer') }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const mcpJson = (servers: Record<string, unknown>) => writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: servers }))

describe('OpenCode peer-MCP projection — same set as the other runtimes, verify clean, no hand edit', () => {
  test('THE CRITERION: claude+codex declare carvector/searxng → after the projection verify has no ✗ on opencode', () => {
    mcpJson({
      iapeer: { type: 'http', url: 'http://127.0.0.1:8765/mcp' },
      carvector: { type: 'stdio', command: 'npx', args: ['-y', 'carvector-mcp'], env: { CARVECTOR_API_KEY: 'k' } },
      searxng: { command: 'npx', args: ['-y', 'mcp-searxng'], env: { SEARXNG_URL: 'http://localhost:8888' } },
    })
    writeFileSync(join(cwd, '.codex', 'config.toml'), '[mcp_servers.carvector]\ncommand = "npx"\nargs = ["-y","carvector-mcp"]\n[mcp_servers.searxng]\ncommand = "npx"\nargs = ["-y","mcp-searxng"]\n')
    const rts = ['claude', 'codex', 'opencode']
    expect(mcpParity('mrmechanic', cwd, rts, { env }).map(i => i.server)).toEqual(['carvector', 'searxng'])
    const r = syncOpencodePeerMcp('mrmechanic', cwd, rts, { env })
    expect(r.projected).toEqual(['carvector', 'searxng']) // never the core iapeer
    expect(mcpParity('mrmechanic', cwd, rts, { env })).toEqual([])
    const frag = JSON.parse(readFileSync(r.path, 'utf8'))
    expect(frag.mcp.carvector).toEqual({ type: 'local', command: ['npx', '-y', 'carvector-mcp'], enabled: true, timeout: 30000, environment: { CARVECTOR_API_KEY: 'k' } })
    // idempotent
    expect(syncOpencodePeerMcp('mrmechanic', cwd, rts, { env }).changed).toBe(false)
  })
  test('the projection reaches the composed OpenCode config; an operator entry in the peer opencode.json wins', () => {
    mcpJson({ searxng: { command: 'npx', args: ['-y', 'mcp-searxng'] } })
    syncOpencodePeerMcp('mrmechanic', cwd, ['claude', 'opencode'], { env })
    const p = opencodePaths('mrmechanic', { env })
    let cfg = composeOpencodeConfig({ personality: 'mrmechanic', doctrine: 'd', daemonUrl: 'http://x' }, { env }) as { mcp: Record<string, { command?: string[] }> }
    expect(cfg.mcp.searxng?.command).toEqual(['npx', '-y', 'mcp-searxng'])
    expect(cfg.mcp.iapeer).toBeDefined()
    writeFileSync(p.config, JSON.stringify({ mcp: { searxng: { type: 'local', command: ['own'] } } }))
    cfg = composeOpencodeConfig({ personality: 'mrmechanic', doctrine: 'd', daemonUrl: 'http://x' }, { env }) as typeof cfg
    expect(cfg.mcp.searxng?.command).toEqual(['own'])
  })
  test('a name another OpenCode source owns (memory fragment) is not projected; a removed source server leaves the projection', () => {
    mcpJson({ 'iapeer-memory': { type: 'http', url: 'http://127.0.0.1:8766/mcp' }, email: { command: 'uv' } })
    const p = opencodePaths('mrmechanic', { env })
    mkdirSync(p.dir, { recursive: true })
    writeFileSync(join(p.dir, 'iapeer-memory.json'), JSON.stringify({ mcp: { 'iapeer-memory': { type: 'remote', url: 'http://127.0.0.1:8766/mcp' } } }))
    const r = syncOpencodePeerMcp('mrmechanic', cwd, ['claude', 'opencode'], { env })
    expect(r.projected).toEqual(['email'])
    expect(r.ownedElsewhere).toEqual(['iapeer-memory'])
    mcpJson({})
    expect(syncOpencodePeerMcp('mrmechanic', cwd, ['claude', 'opencode'], { env }).changed).toBe(true)
    expect(existsSync(p.peerMcp)).toBe(false)
  })
  test('format conversion: claude ${VAR} → {env:VAR}; codex url + env headers + bearer → remote headers', () => {
    expect(claudeVarsToOpencode('${PEER_IDENTITY:-claude-x}/${A}')).toBe('{env:PEER_IDENTITY}/{env:A}')
    const s = specFromCodex({ url: 'http://h/mcp', http_headers: { X: '1' }, env_http_headers: { 'X-Id': 'PEER_IDENTITY' }, bearer_token_env_var: 'TOK' }, 'codex')!
    expect(toOpencodeMcp(s)).toEqual({ type: 'remote', url: 'http://h/mcp', enabled: true, oauth: false, headers: { X: '1', 'X-Id': '{env:PEER_IDENTITY}', Authorization: 'Bearer {env:TOK}' } })
  })
})
