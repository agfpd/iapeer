// init — per-peer onboarding: HTTP-MCP .mcp.json wiring (the install-gate-proven
// transport), doctrine template, and the initPeer orchestration over provisionPeer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CODEX_BEARER_ENV_VAR,
  IAPEER_MCP_SERVER_NAME,
  codexConfigPath,
  ensureClaudeProjectSettings,
  ensureCodexUpdateCheckDisabled,
  ensureDoctrineTemplate,
  ensureGlobalDoctrineTemplate,
  initPeer,
  resolveDaemonMcpUrl,
  resolvePrimaryRuntime,
  writeClaudeMcpConfig,
  writeCodexMcpConfig,
} from './index.ts'
import { readPeersIndex } from '../registry/index.ts'
import { readPeerProfile } from '../identity/index.ts'

let root: string
let cwd: string
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, IAPEER_ROOT: root, ...extra }
  delete env.PEER_PERSONALITY
  delete env.PEER_IDENTITY
  delete env.PEER_RUNTIME
  return env
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-init-root-'))
  cwd = mkdtempSync(join(tmpdir(), 'iapeer-init-cwd-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

describe('resolveDaemonMcpUrl', () => {
  test('no router.json → well-known default loopback URL (IAPEER_PORT respected)', () => {
    expect(resolveDaemonMcpUrl({ env: cleanEnv() })).toBe('http://127.0.0.1:8765/mcp')
    expect(resolveDaemonMcpUrl({ env: cleanEnv({ IAPEER_PORT: '9999' }) })).toBe('http://127.0.0.1:9999/mcp')
  })
  test('router.json present → its tcp field (daemon-published endpoint)', () => {
    const stateDir = join(root, 'state', 'iapeer')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'router.json'), JSON.stringify({ sock: '/x.sock', tcp: 'http://127.0.0.1:8765/mcp' }))
    expect(resolveDaemonMcpUrl({ env: cleanEnv() })).toBe('http://127.0.0.1:8765/mcp')
  })
})

describe('writeClaudeMcpConfig', () => {
  test('writes the iapeer http server with the X-IAPeer-Identity header', () => {
    const path = writeClaudeMcpConfig(cwd, 'boris', 'http://127.0.0.1:8765/mcp')
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    expect(doc.mcpServers[IAPEER_MCP_SERVER_NAME]).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:8765/mcp',
      // env-expanded by claude from the session PEER_IDENTITY; literal fallback for
      // a manual (no-env) session — identity follows the SESSION, not the cwd file.
      headers: { 'X-IAPeer-Identity': '${PEER_IDENTITY:-claude-boris}' },
    })
  })
  test('MERGES — preserves other mcpServers, only (re)writes iapeer', () => {
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://x/mcp' } } }))
    writeClaudeMcpConfig(cwd, 'boris', 'http://127.0.0.1:8765/mcp')
    const doc = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'))
    expect(doc.mcpServers.other).toEqual({ type: 'http', url: 'https://x/mcp' })
    expect(doc.mcpServers.iapeer.headers['X-IAPeer-Identity']).toBe('${PEER_IDENTITY:-claude-boris}')
  })
  test('idempotent — re-running yields the same bytes', () => {
    const p = writeClaudeMcpConfig(cwd, 'boris', 'http://127.0.0.1:8765/mcp')
    const first = readFileSync(p, 'utf8')
    writeClaudeMcpConfig(cwd, 'boris', 'http://127.0.0.1:8765/mcp')
    expect(readFileSync(p, 'utf8')).toBe(first)
  })
})

describe('ensureClaudeProjectSettings (project-local startup-modal suppression)', () => {
  const settingsPath = (c: string) => join(c, '.claude', 'settings.json')

  test('creates <cwd>/.claude/settings.json with enableAllProjectMcpServers:true + tui:default', () => {
    const p = ensureClaudeProjectSettings(cwd)
    expect(p).toBe(settingsPath(cwd))
    const obj = JSON.parse(readFileSync(p!, 'utf8'))
    expect(obj.enableAllProjectMcpServers).toBe(true) // no MCP-approval boot dialog
    expect(obj.tui).toBe('default') // no fullscreen-renderer upsell modal (prevention belt to the nag-watcher)
  })

  test('tui:default is set only when ABSENT — an explicit tui choice is NOT overridden', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(settingsPath(cwd), JSON.stringify({ tui: 'fullscreen' }))
    ensureClaudeProjectSettings(cwd)
    const obj = JSON.parse(readFileSync(settingsPath(cwd), 'utf8'))
    expect(obj.tui).toBe('fullscreen') // operator's explicit choice preserved
    expect(obj.enableAllProjectMcpServers).toBe(true) // MCP key still merged
  })

  test('NO-CLOBBER merge — preserves foreign keys (plugin/statusline/native-memory blocks)', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(settingsPath(cwd), JSON.stringify({ autoMemoryEnabled: false, statusLine: { type: 'command' } }))
    ensureClaudeProjectSettings(cwd)
    const obj = JSON.parse(readFileSync(settingsPath(cwd), 'utf8'))
    expect(obj.enableAllProjectMcpServers).toBe(true)
    expect(obj.autoMemoryEnabled).toBe(false)
    expect(obj.statusLine).toEqual({ type: 'command' })
  })

  test('idempotent — already-true returns the path and does not rewrite', () => {
    ensureClaudeProjectSettings(cwd)
    const first = readFileSync(settingsPath(cwd), 'utf8')
    expect(ensureClaudeProjectSettings(cwd)).toBe(settingsPath(cwd))
    expect(readFileSync(settingsPath(cwd), 'utf8')).toBe(first)
  })

  test('refuses to clobber a non-object settings.json (returns null, leaves file intact)', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(settingsPath(cwd), '["not","an","object"]')
    expect(ensureClaudeProjectSettings(cwd)).toBeNull()
    expect(readFileSync(settingsPath(cwd), 'utf8')).toBe('["not","an","object"]')
  })

  test('is project-LOCAL — writes only under cwd, never the user global ~/.claude', () => {
    ensureClaudeProjectSettings(cwd)
    // the written path is strictly inside the peer's cwd (constraint: no global mutation)
    expect(settingsPath(cwd).startsWith(cwd)).toBe(true)
  })
})

describe('ensureDoctrineTemplate', () => {
  test('creates the template when absent', () => {
    const { path, created } = ensureDoctrineTemplate(cwd)
    expect(created).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('Peer doctrine')
  })
  test('never overwrites an existing doctrine', () => {
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(join(cwd, '.iapeer', 'IAPEER.md'), 'I am boris.')
    const { created } = ensureDoctrineTemplate(cwd)
    expect(created).toBe(false)
    expect(readFileSync(join(cwd, '.iapeer', 'IAPEER.md'), 'utf8')).toBe('I am boris.')
  })
})

describe('ensureGlobalDoctrineTemplate (FU11 — host-wide stub)', () => {
  test('creates the global ~/.iapeer/IAPEER.md stub when absent', () => {
    const { path, created } = ensureGlobalDoctrineTemplate(cleanEnv())
    expect(created).toBe(true)
    expect(path).toBe(join(root, 'IAPEER.md'))
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('Host doctrine')
  })
  test('never overwrites an existing host doctrine', () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'IAPEER.md'), 'host rules by the owner')
    const { created } = ensureGlobalDoctrineTemplate(cleanEnv())
    expect(created).toBe(false)
    expect(readFileSync(join(root, 'IAPEER.md'), 'utf8')).toBe('host rules by the owner')
  })
})

describe('writeCodexMcpConfig (token-free recipe — dummy bearer + env_http_headers identity)', () => {
  test('adds [mcp_servers.iapeer] with url + approve + bearer_token_env_var + env_http_headers', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'iapeer-codexhome-'))
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome }
      const { path, added } = writeCodexMcpConfig('http://127.0.0.1:8765/mcp', { env })
      expect(added).toBe(true)
      expect(path).toBe(codexConfigPath({ env }))
      const toml = readFileSync(path, 'utf8')
      expect(toml).toContain('[mcp_servers.iapeer]')
      expect(toml).toContain('url = "http://127.0.0.1:8765/mcp"')
      expect(toml).toContain('default_tools_approval_mode = "approve"')
      expect(toml).toContain(`bearer_token_env_var = "${CODEX_BEARER_ENV_VAR}"`)
      expect(toml).toContain('[mcp_servers.iapeer.env_http_headers]')
      expect(toml).toContain('"X-IAPeer-Identity" = "PEER_IDENTITY"')
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })
  test('idempotent — re-run does NOT duplicate the block, and preserves other config', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'iapeer-codexhome2-'))
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome }
      writeFileSync(codexConfigPath({ env }), '[other]\nkeep = true\n')
      expect(writeCodexMcpConfig('http://x/mcp', { env }).added).toBe(true)
      expect(writeCodexMcpConfig('http://x/mcp', { env }).added).toBe(false) // idempotent
      const toml = readFileSync(codexConfigPath({ env }), 'utf8')
      expect((toml.match(/\[mcp_servers\.iapeer\]/g) ?? []).length).toBe(1) // no duplicate
      expect(toml).toContain('[other]') // other config preserved
      expect(toml).toContain('keep = true')
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })
})

describe('initPeer orchestration', () => {
  test('codex peer: profile + registry + token-free codex config + doctrine', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'iapeer-codexhome3-'))
    const pcwd = join(cwd, 'cpeer') // personality = normalize(basename(cwd)) — name the folder, not a flag
    mkdirSync(pcwd, { recursive: true })
    try {
      const env = cleanEnv({ CODEX_HOME: codexHome })
      const r = await initPeer({ cwd: pcwd, runtime: 'codex', env })
      expect(readPeerProfile(pcwd)?.personality).toBe('cpeer')
      expect(r.mcpConfigPaths.length).toBe(0) // no claude .mcp.json for a codex peer
      expect(r.codexMcpConfigPath).toBe(codexConfigPath({ env }))
      const toml = readFileSync(r.codexMcpConfigPath!, 'utf8')
      expect(toml).toContain('[mcp_servers.iapeer]')
      expect(toml).toContain(`bearer_token_env_var = "${CODEX_BEARER_ENV_VAR}"`) // token-free recipe wired
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  test('claude peer: profile + registry + .mcp.json + doctrine, all wired', async () => {
    const env = cleanEnv()
    const pcwd = join(cwd, 'mypeer') // personality = normalize(basename(cwd))
    mkdirSync(pcwd, { recursive: true })
    const r = await initPeer({ cwd: pcwd, runtime: 'claude', env })
    // identity + registry (via provision)
    expect(readPeerProfile(pcwd)?.personality).toBe('mypeer')
    expect(readPeersIndex({ env }).peers.some(p => p.personality === 'mypeer')).toBe(true)
    // .mcp.json wired to the daemon with the per-peer identity header
    expect(r.mcpConfigPaths.length).toBe(1)
    const mcp = JSON.parse(readFileSync(join(pcwd, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.iapeer.headers['X-IAPeer-Identity']).toBe('${PEER_IDENTITY:-claude-mypeer}')
    expect(mcp.mcpServers.iapeer.url).toBe('http://127.0.0.1:8765/mcp')
    // doctrine template created
    expect(r.doctrineCreated).toBe(true)
    expect(existsSync(r.doctrinePath)).toBe(true)
  })

  test('idempotent — re-init does not throw and keeps an existing doctrine', async () => {
    const env = cleanEnv()
    const pcwd = join(cwd, 'mypeer') // personality = normalize(basename(cwd))
    mkdirSync(pcwd, { recursive: true })
    await initPeer({ cwd: pcwd, runtime: 'claude', env })
    writeFileSync(join(pcwd, '.iapeer', 'IAPEER.md'), 'custom doctrine')
    const r2 = await initPeer({ cwd: pcwd, runtime: 'claude', env })
    expect(r2.doctrineCreated).toBe(false)
    expect(readFileSync(join(pcwd, '.iapeer', 'IAPEER.md'), 'utf8')).toBe('custom doctrine')
  })
})

describe('resolvePrimaryRuntime (install-aware; isInstalled injected for hermeticity)', () => {
  const mk = () => mkdtempSync(join(tmpdir(), 'iapeer-resolve-'))
  const both = (_rt: string) => true
  const none = (_rt: string) => false
  const only = (rt: string) => (x: string) => x === rt

  test('explicit runtime → used when installed', () => {
    expect(resolvePrimaryRuntime(mk(), 'codex', both)).toBe('codex')
  })
  test('explicit runtime NOT installed → throws (no silent later launch failure)', () => {
    expect(() => resolvePrimaryRuntime(mk(), 'codex', only('claude'))).toThrow(/not installed/)
  })
  test('cwd .claude marker takes PRECEDENCE over install-presence (folder config wins)', () => {
    const cwd = mk()
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    expect(resolvePrimaryRuntime(cwd, undefined, only('codex'))).toBe('claude') // marker not re-validated
  })
  test('cwd .codex marker → codex', () => {
    const cwd = mk()
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    expect(resolvePrimaryRuntime(cwd, undefined, both)).toBe('codex')
  })
  test('no marker, exactly one installed → that one (not a silent claude default)', () => {
    expect(resolvePrimaryRuntime(mk(), undefined, only('codex'))).toBe('codex')
  })
  test('no marker, both installed → claude (deterministic default)', () => {
    expect(resolvePrimaryRuntime(mk(), undefined, both)).toBe('claude')
  })
  test('no marker, none installed → throws (no silent claude on a runtime-less host)', () => {
    expect(() => resolvePrimaryRuntime(mk(), undefined, none)).toThrow(/no agentic runtime installed/)
  })
})

describe('ensureCodexUpdateCheckDisabled (boot-gate hygiene — incident 11.06 codex-linus)', () => {
  test('PREPENDS the top-level key BEFORE the first [section] (TOML top-level scope)', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'iapeer-codexhome3-'))
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome }
      writeFileSync(codexConfigPath({ env }), 'model = "gpt-5.5"\n\n[projects."/x"]\ntrust_level = "trusted"\n')
      const { changed } = ensureCodexUpdateCheckDisabled({ env })
      expect(changed).toBe(true)
      const toml = readFileSync(codexConfigPath({ env }), 'utf8')
      expect(toml.startsWith('check_for_update_on_startup = false\n')).toBe(true)
      expect(toml).toContain('[projects."/x"]') // existing config preserved
      // idempotent: second run is a no-op
      expect(ensureCodexUpdateCheckDisabled({ env }).changed).toBe(false)
      expect((toml.match(/check_for_update_on_startup/g) ?? []).length).toBe(1)
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })
  test('respects an EXPLICIT existing value (never overrides the operator)', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'iapeer-codexhome4-'))
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome }
      writeFileSync(codexConfigPath({ env }), 'check_for_update_on_startup = true\n')
      expect(ensureCodexUpdateCheckDisabled({ env }).changed).toBe(false)
      expect(readFileSync(codexConfigPath({ env }), 'utf8')).toContain('check_for_update_on_startup = true')
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })
  test('absent config → created with just the key', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'iapeer-codexhome5-'))
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome }
      expect(ensureCodexUpdateCheckDisabled({ env }).changed).toBe(true)
      expect(readFileSync(codexConfigPath({ env }), 'utf8')).toBe('check_for_update_on_startup = false\n')
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })
})
