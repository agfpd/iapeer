import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLifecycleConfig } from './index.ts'
import { recordProviderFailure, selectFailoverRuntime } from './failover.ts'
import { listLimitParks } from './limitpark.ts'
import { recordAccountLimit, expireAccountLimits } from './accountlimit.ts'
import { upsertPeer } from '../registry/index.ts'
import type { PeerRecord } from '../registry/index.ts'
import type { MuteDetection } from '../daemon/mutewatch.ts'
import { peerLaunchEnvPath } from '../storage/index.ts'
let root: string, env: NodeJS.ProcessEnv, cfg: ReturnType<typeof loadLifecycleConfig>, event: MuteDetection, at: number
function auth(home: string, account = 'account-a', subject = 'user-a') {
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    account_id: account, id_token: `header.${Buffer.from(JSON.stringify({ sub: subject })).toString('base64url')}.secret`, access_token: 'secret-access',
  } }))
  utimesSync(join(home, 'auth.json'), (at - 2000) / 1000, (at - 2000) / 1000)
}
const peer = (cwd: string, personality = 'other'): PeerRecord => ({ personality, cwd, runtime: 'codex', runtimes: ['codex', 'claude'], intelligence: 'artificial', description: '' })
const select = (cwd = root, now = at) => selectFailoverRuntime(cfg, peer(cwd), undefined, now, [], env)
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-accountlimit-'))
  env = { HOME: root, CODEX_HOME: join(root, 'codex'), IAPEER_ROOT: join(root, 'root') }
  cfg = loadLifecycleConfig(env); at = Date.now()
  auth(env.CODEX_HOME!)
  event = { cwd: root, personality: 'source', runtime: 'codex', atMs: at, resetsAtMs: at + 60_000, errorType: 'usage_limit_exceeded', content: 'usage limit', sessionId: 'native', file: join(env.CODEX_HOME!, 'sessions', 'native.jsonl') }
  mkdirSync(join(env.CODEX_HOME!, 'sessions'))
  writeFileSync(event.file!, JSON.stringify({ type: 'session_meta', payload: { id: 'native', timestamp: new Date(at - 1000).toISOString() } }) + '\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
test('same account skips Codex across peers and homes until reset; different user/account and unknown auth do not', () => {
  expect(select().ok && (select() as any).value.runtime).toBe('codex')
  recordProviderFailure(cfg, event, env)
  expect((select() as any).value.runtime).toBe('claude')
  expect((select(root, event.resetsAtMs!) as any).value.runtime).toBe('codex')
  const other = join(root, 'other'); mkdirSync(join(other, '.iapeer', 'codex'), { recursive: true })
  // Use the actual per-peer launch.env path authority, not a hand-written path.
  const path = peerLaunchEnvPath(other, 'codex'); mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `CODEX_HOME=${join(root, 'other-home')}\n`)
  auth(join(root, 'other-home'))
  expect((select(other) as any).value.runtime).toBe('claude')
  auth(join(root, 'other-home'), 'different-account')
  expect((select(other) as any).value.runtime).toBe('codex')
  auth(join(root, 'other-home'), 'account-a', 'different-user')
  expect((select(other) as any).value.runtime).toBe('codex')
  rmSync(join(root, 'other-home', 'auth.json'))
  expect((select(other) as any).value.runtime).toBe('codex')
  expect(listLimitParks(cfg)).toEqual([]) // no fabricated unfinished jobs/nudges
  const files = readdirSync(join(cfg.stateDir, 'failover', 'accounts'))
  expect(files).toHaveLength(1); expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/)
  expect(readFileSync(join(cfg.stateDir, 'failover', 'accounts', files[0]!), 'utf8')).not.toContain('secret')
})
test('newer evidence wins; auth changes after the event never spread historical failure', () => {
  expect(recordAccountLimit(cfg, event, env)).toBe(true)
  expect(recordAccountLimit(cfg, { ...event, atMs: at - 1, resetsAtMs: at + 999_999 }, env)).toBe(false)
  expect((select(root, at + 60_001) as any).value.runtime).toBe('codex')
  auth(env.CODEX_HOME!, 'account-b')
  utimesSync(join(env.CODEX_HOME!, 'auth.json'), (at + 1000) / 1000, (at + 1000) / 1000)
  expect(recordAccountLimit(cfg, event, env)).toBe(false)
  expect((select() as any).value.runtime).toBe('codex')
})
test('unsupported auth/provider, wrong native home, absent reset and other refusal classes remain endpoint-only', () => {
  expect(recordAccountLimit(cfg, { ...event, errorType: 'unauthorized' }, env)).toBe(false)
  expect(recordAccountLimit(cfg, { ...event, resetsAtMs: undefined }, env)).toBe(false)
  expect(recordAccountLimit(cfg, { ...event, file: join(root, 'foreign', 'sessions', 'x') }, env)).toBe(false)
  writeFileSync(join(env.CODEX_HOME!, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n')
  expect(recordAccountLimit(cfg, event, env)).toBe(false)
  writeFileSync(join(env.CODEX_HOME!, 'config.toml'), 'model_provider = "custom"\n')
  expect(recordAccountLimit(cfg, event, env)).toBe(false)
  expect((select() as any).value.runtime).toBe('codex')
})
test('auth switched between native session start and refusal cannot poison the new account', () => {
  auth(env.CODEX_HOME!, 'new-account')
  utimesSync(join(env.CODEX_HOME!, 'auth.json'), (at - 500) / 1000, (at - 500) / 1000)
  expect(recordAccountLimit(cfg, event, env, at)).toBe(false)
  expect((select() as any).value.runtime).toBe('codex')
})
test('diagnostic events show the blocked peers and one observed expiry, with no re-park of historical evidence', async () => {
  await upsertPeer(peer(root, 'same-account'), { env })
  expect(recordAccountLimit(cfg, event, env, at)).toBe(true)
  const log = join(cfg.eventLogDir, 'lifecycle.log')
  expect(readFileSync(log, 'utf8')).toContain('ev=account-park ')
  expect(readFileSync(log, 'utf8')).toContain('blocked_peers=same-account')
  expireAccountLimits(cfg, env, at + 60_000)
  expireAccountLimits(cfg, env, at + 60_001)
  const output = readFileSync(log, 'utf8')
  expect(output.match(/ev=account-park-cleared /g)).toHaveLength(1)
  expect(output).toContain('reason=reset')
  expect(recordAccountLimit(cfg, event, env, at + 60_001)).toBe(false)
  expect(readdirSync(join(cfg.stateDir, 'failover', 'accounts'))).toEqual([])
})
