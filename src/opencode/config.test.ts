import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeOpencodeConfig, opencodePaths, readOpencodeExtension, writeOpencodePlugin } from './config.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function setup() {
  const rootDir = mkdtempSync('/tmp/iapeer-oc-config-'); roots.push(rootDir)
  const paths = opencodePaths('probe', { rootDir }); mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.config, JSON.stringify({ model: 'syn/m' })) // an explicit provider is mandatory (pinProvider)
  return { rootDir, paths }
}
const input = { personality: 'probe', doctrine: 'Synthetic doctrine', daemonUrl: 'http://127.0.0.1:1234/mcp' }

describe('OpenCode private config contract', () => {
  test('no implicit provider: missing model refuses with a hint; small_model and enabled_providers are pinned', () => {
    const { rootDir, paths } = setup()
    writeFileSync(paths.config, JSON.stringify({ provider: { x: {} } }))
    const implicit = composeOpencodeConfig(input, { rootDir }) // allowed (owner policy), never pinned
    expect(implicit.model).toBeUndefined()
    expect(implicit.enabled_providers).toBeUndefined()
    writeFileSync(paths.config, JSON.stringify({ model: 'nvidia/nemo' }))
    const pinned = composeOpencodeConfig(input, { rootDir })
    expect(pinned.small_model).toBe('nvidia/nemo')
    expect(pinned.enabled_providers).toEqual(['nvidia'])
    writeFileSync(paths.config, JSON.stringify({ model: 'nvidia/nemo', small_model: 'ollama/g' }))
    expect(composeOpencodeConfig(input, { rootDir }).enabled_providers).toEqual(['nvidia', 'ollama'])
    writeFileSync(paths.config, JSON.stringify({ model: 'nvidia/nemo', enabled_providers: ['opencode'] }))
    expect(() => composeOpencodeConfig(input, { rootDir })).toThrow(/must include/)
    // the inline env config is an equally explicit source
    writeFileSync(paths.config, '{}')
    expect(composeOpencodeConfig({ ...input, inline: JSON.stringify({ model: 'ollama/g' }) }, { rootDir }).enabled_providers).toEqual(['ollama'])
  })

  test('personality scopes are distinct even for a shared cwd; rootDir wins over env', () => {
    const a = opencodePaths('one', { rootDir: '/isolated', env: { IAPEER_ROOT: '/wrong' } })
    const b = opencodePaths('two', { rootDir: '/isolated' })
    expect(a.dir).toBe('/isolated/state/opencode/one')
    expect(b.dir).not.toBe(a.dir)
    expect(() => opencodePaths('../escape')).toThrow()
  })
  test('core fields win without clobbering foreign providers/agents/MCP/plugins', () => {
    const { rootDir, paths } = setup()
    writeFileSync(paths.config, JSON.stringify({ model: 'nvidia/x', provider: { nvidia: { options: { apiKey: '{env:NVIDIA_API_KEY}' } } }, mcp: { foreign: { type: 'remote', url: 'http://localhost/foreign' } } }))
    writeFileSync(join(paths.dir, 'iapeer-memory.json'), JSON.stringify({ mcp: { 'iapeer-memory': { type: 'remote', url: 'http://localhost/memory' } }, plugin: ['file:///memory.mjs'] }))
    const result = composeOpencodeConfig({ ...input, inline: JSON.stringify({ default_agent: 'wrong', agent: { foreign: { prompt: 'keep' }, iapeer: { prompt: 'stale' } }, plugin: ['file:///foreign.mjs', 'file:///memory.mjs'] }) }, { rootDir })
    expect(result.default_agent).toBe('iapeer')
    expect((result.agent as any).iapeer.prompt).toBe(input.doctrine)
    expect((result.agent as any).foreign.prompt).toBe('keep')
    expect(Object.keys(result.mcp as object).sort()).toEqual(['foreign', 'iapeer', 'iapeer-memory'])
    expect((result.mcp as any).iapeer.headers['X-IAPeer-Identity']).toBe('{env:PEER_IDENTITY}')
    expect((result.provider as any).nvidia.options.apiKey).toBe('{env:NVIDIA_API_KEY}')
    expect((result.plugin as string[]).filter(x => x === 'file:///memory.mjs')).toHaveLength(1)
    expect(result.autoupdate).toBe(false)
  })
  test('missing extension means no memory; malformed or overreaching present extension fails loud', () => {
    const { rootDir, paths } = setup()
    expect(composeOpencodeConfig(input, { rootDir }).mcp).toHaveProperty('iapeer')
    const path = join(paths.dir, 'iapeer-memory.json')
    for (const value of ['{', 'null', '[]', '{"permission":"allow"}', '{"mcp":{"iapeer":{}}}', '{"plugin":["relative.mjs"]}', '{"mcp":[]}']) {
      writeFileSync(path, value)
      expect(() => readOpencodeExtension(path)).toThrow()
      expect(() => composeOpencodeConfig(input, { rootDir })).toThrow()
    }
  })
  test('fresh render uses new doctrine; no silent fallback on invalid inline or empty prompt', () => {
    const { rootDir } = setup()
    expect((composeOpencodeConfig({ ...input, doctrine: 'V2' }, { rootDir }).agent as any).iapeer.prompt).toBe('V2')
    expect(() => composeOpencodeConfig({ ...input, inline: '[' }, { rootDir })).toThrow()
    expect(() => composeOpencodeConfig({ ...input, doctrine: ' ' }, { rootDir })).toThrow()
  })
  test('writes only injected private destination, source is byte-preserved', () => {
    const { rootDir, paths } = setup()
    expect(writeOpencodePlugin('probe', 'export default async () => ({})\n', { rootDir })).toBe(paths.plugin)
    expect(readFileSync(paths.plugin, 'utf8')).toBe('export default async () => ({})\n')
  })
})
