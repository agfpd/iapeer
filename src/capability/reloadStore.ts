// Each request has its OWN durable file. Completing a snapshot never acknowledges a later change.
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LifecycleConfig } from '../lifecycle/index.ts'
import { isValidName } from '../core/constants.ts'
import { writeFileAtomic } from '../storage/index.ts'

export interface ReloadRequest {
  schema: 1
  id: string
  personality: string
  runtime: string
  requestedAt: number
  state: 'pending' | 'replacing' | 'failed' | 'applied'
  detail: string
  resumeRef?: string
  attemptAt?: number
}
export const reloadDir = (cfg: LifecycleConfig, identity: string): string => join(cfg.stateDir, `${identity}.capability-reloads`)
const pathFor = (cfg: LifecycleConfig, r: ReloadRequest) => join(reloadDir(cfg, `${r.runtime}-${r.personality}`), `${r.id}.json`)

export function saveReload(cfg: LifecycleConfig, r: ReloadRequest): void {
  writeFileAtomic(pathFor(cfg, r), JSON.stringify(r) + '\n')
}
export function requestReload(cfg: LifecycleConfig, personality: string, runtime: string): ReloadRequest {
  if (!isValidName(personality) || !['claude', 'codex', 'opencode'].includes(runtime)) throw new Error('invalid capability reload endpoint')
  const r: ReloadRequest = { schema: 1, id: randomUUID(), personality, runtime, requestedAt: Date.now(), state: 'pending', detail: 'waiting for a native idle turn boundary' }
  saveReload(cfg, r)
  return r
}
export function readReload(cfg: LifecycleConfig, r: ReloadRequest): ReloadRequest {
  const next = JSON.parse(readFileSync(pathFor(cfg, r), 'utf8')) as ReloadRequest
  // Completion is a separate monotonic fact. A concurrent pending/error writer can never
  // rewind it by replacing a status file after a successful natural launch.
  return existsSync(`${pathFor(cfg, r)}.applied`) ? { ...next, state: 'applied', detail: 'runtime launched with the current capability configuration' } : next
}
export function pendingReloads(cfg: LifecycleConfig, identity: string): ReloadRequest[] {
  const dir = reloadDir(cfg, identity)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(n => /^[a-f0-9-]+\.json$/.test(n)).flatMap(n => {
    let raw: string
    try { raw = readFileSync(join(dir, n), 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [] // collected between readdir and read
      throw e
    }
    const r = JSON.parse(raw) as ReloadRequest
    if (r.schema !== 1 || `${r.runtime}-${r.personality}` !== identity || `${r.id}.json` !== n) throw new Error(`invalid reload request: ${join(dir, n)}`)
    return [readReload(cfg, r)]
  }).filter(r => r.state !== 'applied')
}
export function reloadIdentities(cfg: LifecycleConfig): string[] {
  if (!existsSync(cfg.stateDir)) return []
  return readdirSync(cfg.stateDir).filter(n => /^(claude|codex|opencode)-[a-z][a-z0-9-]*\.capability-reloads$/.test(n)).map(n => n.replace(/\.capability-reloads$/, ''))
}
/** Snapshot at the configuration-read boundary, completion only after that launch reaches ready. */
export function completeReloads(cfg: LifecycleConfig, requests: ReloadRequest[]): void {
  for (const r of requests) if (existsSync(pathFor(cfg, r))) writeFileAtomic(`${pathFor(cfg, r)}.applied`, 'applied\n')
}

/** Applied requests are kept briefly so the CLI (and an operator) can read the outcome, then collected.
 *  An endpoint that left the registry takes its whole queue with it — nothing could ever apply it. */
export const RELOAD_APPLIED_TTL_MS = 60 * 60 * 1000
export function gcReloads(cfg: LifecycleConfig, identity: string, endpointExists: boolean, now = Date.now()): number {
  const dir = reloadDir(cfg, identity)
  if (!existsSync(dir)) return 0
  if (!endpointExists) { const n = readdirSync(dir).filter(f => f.endsWith('.json')).length; rmSync(dir, { recursive: true, force: true }); return n }
  let removed = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json.applied')) continue
    const marker = join(dir, f)
    try {
      if (now - statSync(marker).mtimeMs < RELOAD_APPLIED_TTL_MS) continue
      rmSync(join(dir, f.slice(0, -'.applied'.length)), { force: true })
      rmSync(marker, { force: true })
      removed++
    } catch { /* raced with another collector */ }
  }
  try { if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true }) } catch { /* */ }
  return removed
}
