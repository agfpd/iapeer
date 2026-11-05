// Account-wide selection circuit breaker, deliberately separate from continuation parks.
import { createHash } from 'node:crypto'
import { readFileSync, statSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { readHostLaunchEnv, readLaunchEnv, writeFileAtomic } from '../storage/index.ts'
import type { LifecycleConfig } from './index.ts'
import type { MuteDetection } from '../daemon/mutewatch.ts'
import { readPeersIndex } from '../registry/index.ts'
import { readPeerProfile } from '../identity/index.ts'
import { appendLifecycleEvent } from './eventlog.ts'

type Config = Pick<LifecycleConfig, 'stateDir'> & Partial<Pick<LifecycleConfig, 'eventLogDir'>>
interface AuthIdentity { key: string; home: string; modifiedAtMs: number }

/** Unknown/unsupported auth is NOT evidence that two endpoints share an account.
 * Only the observed file-based ChatGPT mode is supported; no tokens leave memory.
 * Official storage contract: https://learn.chatgpt.com/docs/auth?surface=cli */
function accountIdentity(cwd: string, env: NodeJS.ProcessEnv): AuthIdentity | undefined {
  if (!env.HOME && !env.CODEX_HOME && !env.IAPEER_ROOT) return
  const local = readLaunchEnv(cwd, 'codex')
  const effective = { ...env, ...readHostLaunchEnv('codex', { env }), ...local.env }
  // Inline config/profile/provider overrides cannot be attributed from auth.json alone.
  if (local.startArgs.length || effective.OPENAI_API_KEY || effective.OPENAI_BASE_URL) return
  const home = effective.CODEX_HOME || (effective.HOME ? join(effective.HOME, '.codex') : undefined)
  if (!home || !isAbsolute(home)) return
  try {
    for (const config of [join(home, 'config.toml'), join(cwd, '.codex', 'config.toml')]) {
      if (!existsSync(config)) continue
      const c = Bun.TOML.parse(readFileSync(config, 'utf8')) as Record<string, unknown>
      if (c.model_provider && c.model_provider !== 'openai' || c.profile ||
          c.cli_auth_credentials_store && c.cli_auth_credentials_store !== 'file' ||
          c.openai_base_url || c.chatgpt_base_url || (c.model_providers as Record<string, unknown> | undefined)?.openai) return
    }
    const path = join(home, 'auth.json')
    const a = JSON.parse(readFileSync(path, 'utf8'))
    if (a.auth_mode !== 'chatgpt' || a.OPENAI_API_KEY || typeof a.tokens?.account_id !== 'string' || !a.tokens.account_id.trim()) return
    // Workspace IDs can be shared by different users, whose quotas are not ours
    // to conflate. The subject is a non-secret identity claim, not the JWT itself.
    const subject = JSON.parse(Buffer.from(a.tokens.id_token.split('.')[1], 'base64url').toString()).sub
    if (typeof subject !== 'string' || !subject) return
    return { key: createHash('sha256').update(JSON.stringify(['codex', a.auth_mode, a.tokens.account_id, subject])).digest('hex'), home, modifiedAtMs: statSync(path).mtimeMs }
  } catch { return }
}
const pathFor = (cfg: Config, key: string) => join(cfg.stateDir, 'failover', 'accounts', `${key}.json`)
interface AccountPark { eventAtMs: number; resetsAtMs: number; sourceIdentity: string; blockedPeers: string[] }
function readPark(cfg: Config, key: string): AccountPark | undefined {
  try { return JSON.parse(readFileSync(pathFor(cfg, key), 'utf8')) } catch { return }
}
export function recordAccountLimit(cfg: Config, d: MuteDetection, env: NodeJS.ProcessEnv, now = Date.now()): boolean {
  if (d.runtime !== 'codex' || d.errorType !== 'usage_limit_exceeded' || !Number.isFinite(d.resetsAtMs) || d.resetsAtMs! <= Math.max(d.atMs, now)) return false
  const auth = accountIdentity(d.cwd, env)
  // A login/refresh after the event is not proof of the historical account. A
  // rollout from another CODEX_HOME is also not attributable to this auth file.
  if (!auth || auth.modifiedAtMs > d.atMs || !d.file || !resolve(d.file).startsWith(resolve(auth.home, 'sessions') + '/')) return false
  const old = readPark(cfg, auth.key)
  if (old && old.eventAtMs >= d.atMs) return false
  const blockedPeers = readPeersIndex({ env }).peers.filter(p =>
    p.intelligence === 'artificial' && p.runtimes.includes('codex') &&
    readPeerProfile(p.cwd)?.failover !== false && !existsSync(join(cfg.stateDir, `codex-${p.personality}.stopped`)) &&
    accountIdentity(p.cwd, env)?.key === auth.key).map(p => p.personality).sort()
  mkdirSync(join(cfg.stateDir, 'failover', 'accounts'), { recursive: true, mode: 0o700 })
  const park: AccountPark = { eventAtMs: d.atMs, resetsAtMs: d.resetsAtMs!, sourceIdentity: `${d.runtime}-${d.personality}`, blockedPeers }
  writeFileAtomic(pathFor(cfg, auth.key), JSON.stringify(park) + '\n')
  appendLifecycleEvent(cfg.eventLogDir, { ev: 'account-park', runtime: 'codex', account_key: auth.key, resetAt: new Date(park.resetsAtMs).toISOString(), source: park.sourceIdentity, blocked_peers: blockedPeers.join(',') }, { env })
  return true
}
/** Observe expiry on the next supervisor tick (selection itself expires at the
 * exact reset instant). Does not wake, stop or nudge any peer. */
export function expireAccountLimits(cfg: Config, env: NodeJS.ProcessEnv, now = Date.now()): void {
  const dir = join(cfg.stateDir, 'failover', 'accounts')
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    const key = name.slice(0, -5), park = readPark(cfg, key)
    if (!park || park.resetsAtMs > now) continue
    appendLifecycleEvent(cfg.eventLogDir, { ev: 'account-park-cleared', runtime: 'codex', account_key: key, resetAt: new Date(park.resetsAtMs).toISOString(), reason: 'reset', blocked_peers: park.blockedPeers?.join(',') ?? '' }, { env })
    rmSync(pathFor(cfg, key), { force: true })
  }
}
export function accountLimitActive(cfg: Config, cwd: string, runtime: string, now: number, env: NodeJS.ProcessEnv): boolean {
  if (runtime !== 'codex') return false
  const auth = accountIdentity(cwd, env)
  return !!auth && (readPark(cfg, auth.key)?.resetsAtMs ?? 0) > now
}
