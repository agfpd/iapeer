import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexMcpNames, mcpParity } from './mcpParity.ts'

let root: string
let cwd: string
let env: NodeJS.ProcessEnv
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcppar-'))
  cwd = join(root, 'impact-finder')
  mkdirSync(join(cwd, '.codex'), { recursive: true })
  env = { HOME: join(root, 'home'), IAPEER_ROOT: join(root, 'iapeer') }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const claude = (servers: string[]) =>
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(servers.map(s => [s, { type: 'http', url: 'x' }])) }))
const codex = (servers: string[]) =>
  writeFileSync(join(cwd, '.codex', 'config.toml'), servers.map(s => `[mcp_servers.${s.includes('.') ? `"${s}"` : s}]\nurl = "x"\n[mcp_servers.${s.includes('.') ? `"${s}"` : s}.env]\nA = "1"\n`).join('\n'))

describe('MCP parity (verify)', () => {
  test('codexMcpNames: bare and quoted table names; sub-tables are not servers', () => {
    expect(codexMcpNames('[mcp_servers.impact-volvo]\nx=1\n[mcp_servers.impact-volvo.env]\n[mcp_servers."a.b"]\n[other]\n').sort()).toEqual(['a.b', 'impact-volvo'])
  })

  test('the incident: a server in the codex config but missing from .mcp.json → reported with the server name and both sides', () => {
    claude(['iapeer', 'iapeer-memory'])
    codex(['iapeer-memory', 'impact-volvo'])
    expect(mcpParity('impact-finder', cwd, ['claude', 'codex'], { env })).toEqual([
      { server: 'impact-volvo', presentIn: ['codex'], missingIn: ['claude'] },
    ])
  })

  test('the core iapeer server is excluded (host-wide on codex by construction); parity → clean', () => {
    claude(['iapeer', 'searxng'])
    codex(['searxng'])
    expect(mcpParity('impact-finder', cwd, ['claude', 'codex'], { env })).toEqual([])
  })

  test('opencode joins the comparison through its host + peer + fragment config', () => {
    claude(['searxng'])
    const host = join(root, 'iapeer', 'runtimes', 'opencode')
    mkdirSync(host, { recursive: true })
    writeFileSync(join(host, 'opencode.json'), JSON.stringify({ mcp: {} }))
    expect(mcpParity('impact-finder', cwd, ['claude', 'opencode'], { env })).toEqual([
      { server: 'searxng', presentIn: ['claude'], missingIn: ['opencode'] },
    ])
    const priv = join(root, 'iapeer', 'state', 'opencode', 'impact-finder')
    mkdirSync(priv, { recursive: true })
    writeFileSync(join(priv, 'opencode.json'), JSON.stringify({ model: 'x/y', mcp: { searxng: { type: 'remote', url: 'x' } } }))
    expect(mcpParity('impact-finder', cwd, ['claude', 'opencode'], { env })).toEqual([])
  })

  test('a single agent runtime (or channel runtimes) has nothing to compare', () => {
    claude(['a'])
    expect(mcpParity('impact-finder', cwd, ['claude', 'telegram'], { env })).toEqual([])
  })
})
