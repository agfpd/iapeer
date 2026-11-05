import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { allowPlugin, reconcilePluginTrust, type PluginHook, type PluginTrustConfig, withCodexAppServer } from './codexPluginTrust.ts'
test('native trust excludes unknown, disabled and file hooks; check is read-only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-trust-'))
  try {
    const cfg: PluginTrustConfig = { configPath: join(dir, 'allow.json'), eventLogDir: join(dir, 'logs'), codexBin: 'unused', cwd: dir, env: { HOME: dir, CODEX_HOME: dir } }
    allowPlugin(cfg.configPath, 'plugin@market')
    expect(() => allowPlugin(cfg.configPath, '*@market')).toThrow()
    const hook: PluginHook = { key: 'key', pluginId: 'plugin@market', source: 'plugin', currentHash: `sha256:${'a'.repeat(64)}/sha256:${'b'.repeat(64)}`, trustStatus: 'modified', enabled: true, isManaged: false }
    const hooks = [hook, { ...hook, key: 'unknown', pluginId: 'other@market' }, { ...hook, key: 'disabled', enabled: false }, { ...hook, key: 'file', source: 'user' }]
    const writes: any[] = []
    const backend: typeof withCodexAppServer = async (_cfg, run) => run(async (method, params: any) => {
      if (method === 'hooks/list') return { data: [{ hooks, errors: [] }] }
      writes.push(params); hook.trustStatus = 'trusted'; return { status: 'ok' }
    })
    await reconcilePluginTrust(cfg, true, undefined, backend)
    expect(writes).toHaveLength(0)
    await reconcilePluginTrust(cfg, false, undefined, backend)
    expect(Object.keys(writes[0].edits[0].value)).toEqual(['key'])
    expect(readFileSync(join(dir, 'logs', 'lifecycle.log'), 'utf8')).toContain('ev=plugin-hook-trusted')
    await reconcilePluginTrust(cfg, false, undefined, backend)
    expect(writes).toHaveLength(1)
    hook.currentHash = 'unknown'
    await expect(reconcilePluginTrust(cfg, false, undefined, backend)).rejects.toThrow('unsupported')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
