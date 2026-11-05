// Read-only production inputs; every circuit-breaker/log write goes to a disposable root.
// Replays a natural refusal at its historical instant, NOT a new live-limit acceptance.
// bun scripts/proof-account-limit.ts <saved-provider.json> <output.json>
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadLifecycleConfig } from '../src/lifecycle/index.ts'
import { recordAccountLimit, expireAccountLimits } from '../src/lifecycle/accountlimit.ts'
import { selectFailoverRuntime, type ProviderFailure } from '../src/lifecycle/failover.ts'
import { findPeer, readPeersIndex } from '../src/registry/index.ts'
import { peerLaunchEnvPath } from '../src/storage/index.ts'

const [input, output] = process.argv.slice(2)
if (!input || !output) throw new Error('usage: proof-account-limit.ts <saved-provider.json> <output.json>')
const failure = JSON.parse(readFileSync(input, 'utf8')) as ProviderFailure
const root = mkdtempSync(join(tmpdir(), 'iapeer-account-limit-proof-'))
try {
  const cfg = { ...loadLifecycleConfig(process.env), stateDir: join(root, 'state'), eventLogDir: join(root, 'logs') }
  const at = failure.atMs + 1
  const same = findPeer(readPeersIndex(), 'linus')!
  if (!same || same.personality === failure.personality) throw new Error('requires a distinct real peer linus')
  const select = (p: typeof same, time: number) => selectFailoverRuntime(cfg, p, undefined, time, [], process.env)
  const before = select(same, at)
  if (!recordAccountLimit(cfg, failure, process.env, at)) throw new Error('historical account attribution unavailable; no inference permitted')
  const blocked = select(same, at), recovered = select(same, failure.resetsAtMs! + 1)
  // Negative control: a different, invented identity, not a second authenticated account.
  const otherHome = join(root, 'other-home'), otherCwd = join(root, 'other-peer')
  mkdirSync(otherHome, { recursive: true })
  writeFileSync(join(otherHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    account_id: 'proof-different-account', id_token: `h.${Buffer.from(JSON.stringify({ sub: 'proof-different-user' })).toString('base64url')}.s`,
  } }))
  utimesSync(join(otherHome, 'auth.json'), at / 1000 - 1, at / 1000 - 1)
  const launchEnv = peerLaunchEnvPath(otherCwd, 'codex')
  mkdirSync(join(launchEnv, '..'), { recursive: true })
  writeFileSync(launchEnv, `CODEX_HOME=${otherHome}\n`)
  const different = select({ ...same, personality: 'proof-different', cwd: otherCwd }, at)
  expireAccountLimits(cfg, process.env, failure.resetsAtMs! + 1)
  const events = readFileSync(join(cfg.eventLogDir, 'lifecycle.log'), 'utf8')
  const runtime = (r: ReturnType<typeof select>) => r.ok ? r.value.runtime : undefined
  const passed = runtime(before) === 'codex' && runtime(blocked) !== 'codex' && runtime(recovered) === 'codex' && runtime(different) === 'codex'
  writeFileSync(output, JSON.stringify({ checkedAt: new Date().toISOString(), sourceEvidence: input,
    scope: 'historical replay, real auth and peer configs; different-account control is synthetic; NOT live feature acceptance',
    sourcePeer: failure.personality, otherRealPeer: same.personality, before, blocked, recovered, differentAccountControl: different, passed, events }, null, 2) + '\n')
  if (!passed) throw new Error('selection proof failed; see output')
  console.log(`PASS: ${output}`)
} finally { rmSync(root, { recursive: true, force: true }) }
