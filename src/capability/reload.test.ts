import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLifecycleConfig, setStopped, type LifecycleConfig } from '../lifecycle/index.ts'
import { upsertPeer } from '../registry/index.ts'
import { applyReloads } from './reload.ts'
import { completeReloads, pendingReloads, readReload, requestReload, saveReload } from './reloadStore.ts'

let root: string, env: NodeJS.ProcessEnv, cfg: LifecycleConfig
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'iap-reload-'))
  env = { ...process.env, HOME: root, IAPEER_ROOT: join(root, 'iap'), IAPEER_LAUNCHAGENTS_DIR: join(root, 'la') }
  cfg = loadLifecycleConfig(env)
  await upsertPeer({ personality: 'probe', cwd: root, runtime: 'claude', intelligence: 'artificial' }, { env })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
test('non-default maintenance stays pending even for live/recovery endpoints; explicit work can launch normally', async () => {
  await upsertPeer({ personality: 'probe', cwd: root, runtime: 'codex', intelligence: 'artificial' }, { env })
  const r = requestReload(cfg, 'probe', 'codex')
  saveReload(cfg, { ...r, resumeRef: 'old-dialogue' })
  for (const live of [true, false]) {
    await applyReloads(cfg, 'codex-probe', env, { alive: () => live, replace: async () => { throw new Error('autonomous secondary work') } })
    expect(readReload(cfg, r).state).toBe('pending')
    expect(readReload(cfg, r).detail).toContain('non-default')
  }
})
test('asleep/stopped endpoints stay asleep; their ordinary configuration-reading launch acknowledges the snapshot', async () => {
  const r = requestReload(cfg, 'probe', 'claude')
  await applyReloads(cfg, 'claude-probe', env, { alive: () => false, replace: async () => { throw new Error('must stay asleep') } })
  expect(readReload(cfg, r).state).toBe('pending')
  expect(readReload(cfg, r).detail).toContain('asleep')
  setStopped(cfg, 'claude-probe')
  await applyReloads(cfg, 'claude-probe', env, { alive: () => true, replace: async () => { throw new Error('must stay stopped') } })
  expect(readReload(cfg, r).detail).toContain('stopped')
  completeReloads(cfg, [r])
  expect(readReload(cfg, r).state).toBe('applied')
})
test('busy pending survives a new driver instance; a newer request during reload is not consumed', async () => {
  const r = requestReload(cfg, 'probe', 'claude')
  await applyReloads(cfg, 'claude-probe', env, { alive: () => true, replace: async () => ({ status: 'FAILED', woke: false, pending: true, reason: 'native busy' }) })
  expect(readReload(cfg, r).detail).toBe('native busy')
  let later: ReturnType<typeof requestReload> | undefined
  await applyReloads(cfg, 'claude-probe', env, { alive: () => true, replace: async a => {
    a.beforeReloadRetire!('native-dialogue')
    later = requestReload(cfg, 'probe', 'claude')
    return { status: 'READY', woke: true }
  } })
  expect(readReload(cfg, r).state).toBe('applied')
  expect(pendingReloads(cfg, 'claude-probe').map(r => r.id)).toEqual([later!.id])
})
test('applied is monotonic even if a racing writer saves an older pending state', () => {
  const r = requestReload(cfg, 'probe', 'claude')
  completeReloads(cfg, [r])
  saveReload(cfg, { ...r, state: 'pending', detail: 'stale writer' })
  expect(readReload(cfg, r).state).toBe('applied')
})
test('crash after retirement is recovered by exact resume, including after a failed launch', async () => {
  const r = requestReload(cfg, 'probe', 'claude')
  await applyReloads(cfg, 'claude-probe', env, { alive: () => true, replace: async a => {
    a.beforeReloadRetire!('dialogue-123')
    throw new Error('daemon died during launch')
  } })
  expect(readReload(cfg, r).state).toBe('failed')
  expect(readReload(cfg, r).resumeRef).toBe('dialogue-123')
  await applyReloads(cfg, 'claude-probe', env, { alive: () => false, replace: async a => {
    expect(a.reloadResumeRef).toBe('dialogue-123'); expect(a.reload).toBeUndefined()
    return { status: 'READY', woke: true }
  } })
  expect(readReload(cfg, r).state).toBe('applied')
})
test('GC: applied requests are collected after the TTL, pending ones never; a gone endpoint takes its queue', async () => {
  const { gcReloads, reloadDir, RELOAD_APPLIED_TTL_MS } = await import('./reloadStore.ts')
  const { existsSync, readdirSync } = await import('node:fs')
  const done = requestReload(cfg, 'probe', 'claude'), open = requestReload(cfg, 'probe', 'claude')
  completeReloads(cfg, [done])
  expect(gcReloads(cfg, 'claude-probe', true)).toBe(0) // fresh: the CLI may still read the outcome
  expect(gcReloads(cfg, 'claude-probe', true, Date.now() + RELOAD_APPLIED_TTL_MS + 1000)).toBe(1)
  expect(readdirSync(reloadDir(cfg, 'claude-probe'))).toEqual([`${open.id}.json`])
  expect(pendingReloads(cfg, 'claude-probe').map(r => r.id)).toEqual([open.id])
  expect(gcReloads(cfg, 'claude-probe', false)).toBe(1)
  expect(existsSync(reloadDir(cfg, 'claude-probe'))).toBe(false)
  expect(pendingReloads(cfg, 'claude-probe')).toEqual([])
})
test('surface watch: a hosting without baseline adopts it; a later outside write owes ONE reload', async () => {
  const { watchSurfaces } = await import('./reload.ts')
  const { readSurfaceBaseline, surfaceFingerprint } = await import('./surfaces.ts')
  const { writeFileSync } = await import('node:fs')
  const hosted = [{ runtime: 'claude' as const, personality: 'probe' }]
  expect(watchSurfaces(cfg, env, hosted)).toEqual([]) // legacy hosting: adopt, never guess
  expect(readSurfaceBaseline(cfg, 'claude-probe')).toBe(surfaceFingerprint('claude', root, 'probe', env))
  expect(watchSurfaces(cfg, env, hosted)).toEqual([])
  writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{"memory":{"type":"http","url":"http://127.0.0.1:1"}}}') // provider-shaped writer
  expect(watchSurfaces(cfg, env, hosted)).toEqual(['claude-probe'])
  writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{}}')
  expect(watchSurfaces(cfg, env, hosted)).toEqual([]) // still owed: one application reads the latest files
  expect(pendingReloads(cfg, 'claude-probe')).toHaveLength(1)
})
test('surface watch ignores runtime-written OpenCode state and core-regenerated files', async () => {
  const { surfaceFingerprint } = await import('./surfaces.ts')
  const { opencodePrivateDir } = await import('../storage/index.ts')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const dir = opencodePrivateDir('probe', { env }); mkdirSync(dir, { recursive: true })
  const before = surfaceFingerprint('opencode', root, 'probe', env)
  for (const f of ['state.json', 'events.jsonl', 'iapeer-plugin.mjs', 'peer-mcp.json']) writeFileSync(join(dir, f), 'x')
  expect(surfaceFingerprint('opencode', root, 'probe', env)).toBe(before)
  writeFileSync(join(dir, 'iapeer-memory.json'), '{"mcp":{}}')
  expect(surfaceFingerprint('opencode', root, 'probe', env)).not.toBe(before)
})
test('remove-runtime retire: busy stays pending (never killed); asleep completes; the retirement runs inside the wake path', async () => {
  const { requestRetire } = await import('./reloadStore.ts')
  const r = requestRetire(cfg, 'probe', 'claude')
  const removed: string[] = []
  const finishRemove = async (p: string, rt: string) => { removed.push(`${rt}-${p}`); return ['done'] }
  await applyReloads(cfg, 'claude-probe', env, { alive: () => true, finishRemove, replace: async a => {
    expect(a.retireOnly).toBe(true); expect(a.reload).toBe(true)
    return { status: 'FAILED', woke: false, pending: true, reason: 'native Claude session is busy' }
  } })
  expect(readReload(cfg, r).state).toBe('pending')
  expect(removed).toEqual([])
  await applyReloads(cfg, 'claude-probe', env, { alive: () => true, finishRemove, replace: async a => {
    await a.afterRetire!()
    return { status: 'READY', woke: false }
  } })
  expect(removed).toEqual(['claude-probe'])
  const r2 = requestRetire(cfg, 'probe', 'claude')
  await applyReloads(cfg, 'claude-probe', env, { alive: () => false, finishRemove, replace: async () => { throw new Error('asleep: no wake') } })
  expect(removed).toEqual(['claude-probe', 'claude-probe'])
  expect(r2.kind).toBe('retire')
})
