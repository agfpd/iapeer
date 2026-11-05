// Durable provider evidence and session quarantine. Paths always come from cfg.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFileAtomic } from '../storage/index.ts'
import { readPeerProfile } from '../identity/index.ts'
import { getAdapter } from '../launch/index.ts'
import { err, ok, type Result } from '../core/errors.ts'
import type { PeerRecord } from '../registry/index.ts'
import type { LifecycleConfig } from './index.ts'
import type { MuteDetection } from '../daemon/mutewatch.ts'
import type { InflightNote } from '../transport/index.ts'
import { accountLimitActive, recordAccountLimit, clearAccountLimit } from './accountlimit.ts'
import { appendLifecycleEvent } from './eventlog.ts'

type Config = Pick<LifecycleConfig, 'stateDir'> & Partial<Pick<LifecycleConfig, 'eventLogDir'>>
export interface ProviderFailure extends MuteDetection { retryAtMs: number }
export interface FailoverTask extends InflightNote {
  id: string
  ts: number
  state: 'watching' | 'claimed' | 'dispatching' | 'transferred' | 'review' | 'finished'
  targetRuntime?: string
  error?: string
  /** Failed positive-proof condition, or uncertain custody/dispatch boundary. */
  reviewReason?: string
  failure?: ProviderFailure
}
const root = (cfg: Config) => join(cfg.stateDir, 'failover')
const healthPath = (cfg: Config, identity: string) => join(root(cfg), `${identity}.provider.json`)
const taskDir = (cfg: Config) => join(root(cfg), 'tasks')
const activeDir = (cfg: Config) => join(root(cfg), 'active')
function read<T>(path: string): T | undefined {
  if (!existsSync(path)) return
  // Corrupt durable custody is not permission to replay or use an endpoint.
  return JSON.parse(readFileSync(path, 'utf8')) as T
}
function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 })
  writeFileAtomic(path, JSON.stringify(value) + '\n')
}
export function failoverEnabled(cwd: string): boolean {
  return readPeerProfile(cwd)?.failover !== false
}
export function providerFailure(cfg: Config, identity: string): ProviderFailure | undefined {
  return read(healthPath(cfg, identity))
}
export function recordProviderFailure(cfg: Config, d: MuteDetection, env: NodeJS.ProcessEnv = {}): boolean {
  recordAccountLimit(cfg, d, env)
  const path = healthPath(cfg, `${d.runtime}-${d.personality}`)
  const previous = read<ProviderFailure>(path)
  if (previous && previous.atMs >= d.atMs) return false
  // No reset is extrapolated. Auth/overload/general refusals get a bounded circuit
  // breaker, not a permanent disable; the next real message can test recovery.
  write(path, { ...d, retryAtMs: d.resetsAtMs ?? d.atMs + 5 * 60_000 })
  return true
}
export function clearProviderFailure(cfg: Config, peer: PeerRecord, runtime: string, env: NodeJS.ProcessEnv, now = Date.now()): void {
  const identity = `${runtime}-${peer.personality}`
  const prior = providerFailure(cfg, identity)
  // Keep atMs as the detector's dedup watermark; do not remove custody/quarantine.
  if (prior) write(healthPath(cfg, identity), { ...prior, retryAtMs: now })
  const account = clearAccountLimit(cfg, peer.cwd, runtime, env, now)
  appendLifecycleEvent(cfg.eventLogDir, { ev: 'provider-cleared', identity, reason: 'operator', atMs: prior?.atMs, account_key: account ?? 'unknown-or-unparked' }, { env })
}
export function quarantineSession(cfg: Config, identity: string, ref: string): void {
  const refs = read<string[]>(join(root(cfg), `${identity}.quarantine.json`)) ?? []
  if (!refs.includes(ref)) write(join(root(cfg), `${identity}.quarantine.json`), [...refs, ref])
}
export function sessionQuarantined(cfg: Config, identity: string, ref: string | undefined): boolean {
  return !!ref && (read<string[]>(join(root(cfg), `${identity}.quarantine.json`)) ?? []).includes(ref)
}
export function markFailoverFresh(cfg: Config, identity: string): void {
  write(join(root(cfg), `${identity}.fresh.json`), true)
}
export function hasFailoverFresh(cfg: Config, identity: string): boolean {
  return existsSync(join(root(cfg), `${identity}.fresh.json`))
}
export function clearFailoverFresh(cfg: Config, identity: string): void {
  rmSync(join(root(cfg), `${identity}.fresh.json`), { force: true })
}
export function selectFailoverRuntime(cfg: Config, peer: PeerRecord, explicit?: string, now = Date.now(), excluded: readonly string[] = [], env: NodeJS.ProcessEnv = {}): Result<{ runtime?: string; eligible: boolean }> {
  if (peer.intelligence !== 'artificial' || getAdapter(explicit ?? peer.runtime).kind !== 'tui') return ok({ runtime: explicit, eligible: false })
  const enabled = failoverEnabled(peer.cwd)
  const eligible = enabled && (!explicit || explicit === peer.runtime)
  const candidates = eligible ? [peer.runtime, ...peer.runtimes.filter(r => r !== peer.runtime)] : [explicit ?? peer.runtime]
  for (const runtime of candidates) {
    if (excluded.includes(runtime)) continue
    if (getAdapter(runtime).kind !== 'tui') continue
    const identity = `${runtime}-${peer.personality}`
    if (existsSync(join(cfg.stateDir, `${identity}.stopped`))) continue
    // While ownership is moving, no fresh task may slip into the failed hosting.
    if (existsSync(join(root(cfg), `${identity}.claim.json`))) continue
    const failure = providerFailure(cfg, identity)
    if (eligible && failure && failure.retryAtMs > now) continue
    if (eligible && accountLimitActive(cfg, peer.cwd, runtime, now, env)) continue
    return ok({ runtime, eligible })
  }
  return err(`peer "${peer.personality}" has no available agent runtime (stopped or provider refusal); message NOT delivered`)
}
export function recordFailoverTask(cfg: Config, note: InflightNote): void {
  if (!note.failoverEligible) return
  const ts = note.acceptedAtMs ?? Date.now()
  const id = createHash('sha256').update(JSON.stringify([note.identity, note.sessionToken, ts, note.rendered])).digest('hex')
  const path = join(taskDir(cfg), `${id}.json`)
  if (!existsSync(path)) saveFailoverTask(cfg, { ...note, id, ts, state: 'watching' })
}
export function saveFailoverTask(cfg: Config, task: FailoverTask): void {
  // Index first, canonical record second: a crash may leave an empty marker, never
  // an unindexed active receipt. Canonical paths remain stable for review evidence.
  const active = join(activeDir(cfg), task.id)
  const claim = join(root(cfg), `${task.identity}.claim.json`)
  const terminal = ['transferred', 'review', 'finished'].includes(task.state)
  if (!terminal) { mkdirSync(activeDir(cfg), { recursive: true, mode: 0o700 }); writeFileAtomic(active, '') }
  if (task.state === 'claimed' || task.state === 'dispatching') write(claim, { id: task.id })
  write(join(taskDir(cfg), `${task.id}.json`), task)
  if (terminal) {
    rmSync(active, { force: true })
    if (read<{ id: string }>(claim)?.id === task.id) rmSync(claim, { force: true })
  }
}

const lastGC = new Map<string, number>()
export function gcFailoverTasks(cfg: Config, now = Date.now()): void {
  if ((lastGC.get(cfg.stateDir) ?? 0) + 3_600_000 > now) return
  lastGC.set(cfg.stateDir, now)
  if (!existsSync(taskDir(cfg))) return
  for (const name of readdirSync(taskDir(cfg))) {
    if (!/^[a-f0-9]{64}\.json$/.test(name) || existsSync(join(activeDir(cfg), name.slice(0, -5)))) continue
    const path = join(taskDir(cfg), name)
    if (now - statSync(path).mtimeMs < 7 * 24 * 3_600_000) continue
    const task = read<FailoverTask>(path)
    if (task && ['transferred', 'finished', 'review'].includes(task.state)) rmSync(path, { force: true })
  }
}
export function listFailoverTasks(cfg: Config, includeSettled = false): FailoverTask[] {
  const dir = includeSettled ? taskDir(cfg) : activeDir(cfg)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(n => includeSettled ? n.endsWith('.json') : /^[a-f0-9]{64}$/.test(n))
    .flatMap(n => { const task = read<FailoverTask>(join(taskDir(cfg), includeSettled ? n : `${n}.json`)); return task ? [task] : [] })
    .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))
}

/** Identity removal must not leave health/quarantine behind for a namesake peer. */
export function purgeFailoverIdentity(cfg: Config, identity: string): string[] {
  const removed: string[] = []
  if (!existsSync(root(cfg))) return removed
  for (const name of readdirSync(root(cfg))) {
    if (!name.startsWith(`${identity}.`)) continue
    rmSync(join(root(cfg), name), { force: true }); removed.push(`failover/${name}`)
  }
  for (const task of listFailoverTasks(cfg, true)) {
    if (task.identity !== identity) continue
    rmSync(join(taskDir(cfg), `${task.id}.json`), { force: true })
    rmSync(join(activeDir(cfg), task.id), { force: true })
    removed.push(`failover/tasks/${task.id}.json`)
  }
  return removed
}
