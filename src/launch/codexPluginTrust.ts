// Native plugin-hook trust. No model turn, no synthesized content hashes.
import { existsSync, readFileSync, mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { writeFileAtomic } from '../storage/index.ts'
import { appendLifecycleEvent } from '../lifecycle/eventlog.ts'
import { codexGlobalConfigPath } from './nativeMemory.ts'

export interface PluginHook { key: string; source: string; pluginId?: string; currentHash: string; trustStatus: string; enabled: boolean; isManaged: boolean }
type Rpc = (method: string, params: unknown) => Promise<any>
export interface PluginTrustConfig { configPath: string; eventLogDir?: string; codexBin: string; cwd: string; env: NodeJS.ProcessEnv }
export const pluginTrustPath = (stateDir: string) => join(stateDir, 'codex-plugin-trust.json')
export function readPluginAllowlist(path: string): string[] {
  if (!existsSync(path)) return []
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (value.version !== 1 || !Array.isArray(value.plugins) || value.plugins.some((p: unknown) => typeof p !== 'string' || !/^[\w.-]+@[\w.-]+$/.test(p))) throw new Error(`invalid plugin trust allowlist: ${path}`)
  return [...new Set<string>(value.plugins)]
}
export function allowPlugin(path: string, id: string): void {
  if (!/^[\w.-]+@[\w.-]+$/.test(id)) throw new Error('plugin ID must be exact <plugin>@<marketplace>')
  const plugins = readPluginAllowlist(path)
  if (!plugins.includes(id)) writeFileAtomic(path, JSON.stringify({ version: 1, plugins: [...plugins, id] }, null, 2) + '\n')
}
/** Each subprocess is bounded and closed even if initialization/list/write fails. */
export async function withCodexAppServer<T>(cfg: PluginTrustConfig, run: (rpc: Rpc) => Promise<T>): Promise<T> {
  const lock = `${cfg.configPath}.lock`, deadline = Date.now() + 2000
  for (;;) {
    try { mkdirSync(lock); break } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (Date.now() >= deadline) throw new Error('plugin trust lock timeout; no native write')
      await Bun.sleep(20)
    }
  }
  try { return await runCodexAppServer(cfg, run) } finally { rmdirSync(lock) }
}
async function runCodexAppServer<T>(cfg: PluginTrustConfig, run: (rpc: Rpc) => Promise<T>): Promise<T> {
  const child = spawn(cfg.codexBin, ['app-server'], { cwd: cfg.cwd, env: cfg.env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  const lines = createInterface({ input: child.stdout })
  const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>()
  let seq = 0
  const fail = (e: Error) => { for (const p of pending.values()) p.reject(e); pending.clear() }
  child.on('error', fail)
  child.stdin.on('error', fail)
  child.on('exit', () => fail(new Error('codex app-server exited before RPC completion')))
  lines.on('line', line => {
    let r: any
    try { r = JSON.parse(line) } catch { fail(new Error('invalid app-server JSON')); return }
    if (r.method) return // no thread/turn is opened; only server notifications are expected
    const p = pending.get(r.id)
    if (!p) return
    pending.delete(r.id)
    if (r.error) p.reject(new Error(JSON.stringify(r.error)))
    else p.resolve(r.result)
  })
  const rpc: Rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n', e => { if (e) { pending.delete(id); reject(e) } })
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        await rpc('initialize', { clientInfo: { name: 'iapeer-hook-trust', version: '1' }, capabilities: { experimentalApi: true } })
        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
        return run(rpc)
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('codex plugin trust timeout')), 10_000) }),
    ])
  } finally {
    clearTimeout(timer); fail(new Error('app-server closed')); lines.close(); child.stdin.destroy(); child.kill('SIGKILL')
  }
}
export async function reconcilePluginTrust(cfg: PluginTrustConfig, check = false, only?: string, backend = withCodexAppServer): Promise<PluginHook[]> {
  const allow = readPluginAllowlist(cfg.configPath)
  if (only && !allow.includes(only)) throw new Error(`plugin not allowed: ${only}`)
  if (!allow.length) return []
  return backend(cfg, async rpc => {
    const list = await rpc('hooks/list', { cwds: [cfg.cwd] })
    if (!Array.isArray(list?.data) || list.data.some((d: any) => d.errors?.length)) throw new Error('hooks/list failed or unsupported response')
    const hooks: PluginHook[] = list.data.flatMap((d: any) => d.hooks ?? []).filter((h: PluginHook) =>
      h.source === 'plugin' && h.enabled === true && h.isManaged === false && allow.includes(h.pluginId ?? '') && (!only || h.pluginId === only))
    for (const h of hooks) if (typeof h.key !== 'string' || !/^sha256:[a-f0-9]{64}\/sha256:[a-f0-9]{64}$/.test(h.currentHash)) throw new Error('unsupported native plugin hook hash')
    if (check) return hooks
    const changed = hooks.filter(h => h.trustStatus !== 'trusted')
    if (!changed.length) return hooks
    let old: any = {}
    const config = codexGlobalConfigPath(cfg.env)
    if (existsSync(config)) old = (Bun.TOML.parse(readFileSync(config, 'utf8')) as any).hooks?.state ?? {}
    const value = Object.fromEntries(changed.map(h => [h.key, { trusted_hash: h.currentHash }]))
    const result = await rpc('config/batchWrite', { edits: [{ keyPath: 'hooks.state', value, mergeStrategy: 'upsert' }] })
    if (result?.status !== 'ok') throw new Error('native hook trust write not acknowledged')
    const verified = await rpc('hooks/list', { cwds: [cfg.cwd] })
    for (const h of changed) {
      const after = verified?.data?.flatMap((d: any) => d.hooks ?? []).find((v: PluginHook) => v.key === h.key)
      if (!after || after.trustStatus !== 'trusted' || after.currentHash !== h.currentHash) throw new Error(`plugin hook changed during trust: ${h.key}`)
      const prior = old[h.key]
      appendLifecycleEvent(cfg.eventLogDir, { ev: 'plugin-hook-trusted', plugin: h.pluginId, key: h.key,
        old_hash: prior ? [prior.trusted_hash, prior.trusted_content_hash].filter(Boolean).join('/') : 'missing', new_hash: h.currentHash }, { env: cfg.env })
    }
    return hooks.map(h => ({ ...h, trustStatus: 'trusted' }))
  })
}
