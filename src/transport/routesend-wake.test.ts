// routeSend wake-path delivery guarantee — the concurrent-sender fast-path hole.
//
// The race (found by code-read 09.06, vault «Находка — wake-on-miss fast-path …»):
// sender A's wake boots the session (A's envelope = boot first-message); sender B,
// blocked on wake.lock, enters AFTER the boot and takes the idempotent live-session
// fast path — which delivers NOTHING. Pre-fix, routeSend then reported {ok:true,
// woke:true} for B while B's envelope was silently lost (the class the delivery
// contract forbids). Post-fix, wakeOrSpawn marks the fast path taskDelivered:false
// and routeSend delivers B's envelope itself via the LIVE path.
//
// The fake WakeFn here reproduces the loser-of-the-lock outcome exactly: it brings
// the session up itself (= what the winning concurrent wake did) and returns READY
// without having delivered the caller's task.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { hasTelegramPresence, routeSend, type WakeFn } from './index.ts'
import type { ResolvedCaller } from '../identity/index.ts'
import type { PeerRecord } from '../registry/index.ts'

let root: string
let sockDir: string
const prevRoot = process.env.IAPEER_ROOT

// These suites spawn a REAL tmux session (the live-delivery path). Skip where
// tmux is absent — a clean CI runner has none, and an unguarded live-tmux test
// is what kept main's CI red (fail: "tmux new-session failed: null"). The
// foundation's preversion gate runs the full suite locally (this machine has
// tmux), so the release path keeps the live coverage; CI gates the rest.
const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

// Target peer: NON-TUI runtime (telegram) → the C-j delivery path lands into a
// plain `cat` pane with no TUI prompt machinery; capture-pane then shows the
// envelope text verbatim.
// NB: keep names SHORT — the tmux socket lives under mkdtemp and the unix
// socket path limit on macOS is 104 bytes.
const TARGET = 'fpw'
const SESSION = `telegram-${TARGET}`
const sockPath = () => join(sockDir, `tmux-iap-telegram-${TARGET}.sock`)
const TUI_TARGET = 'tq'
const TUI_SESSION = `codex-${TUI_TARGET}`
const tuiSockPath = () => join(sockDir, `tmux-iap-codex-${TUI_TARGET}.sock`)

const callerRecord = {
  personality: 'boris',
  runtime: 'claude',
  runtimes: ['claude'],
  description: '',
  intelligence: 'artificial',
  cwd: '/tmp/boris',
  // Telegram sender policy: the target of these suites is a telegram peer, so the
  // caller must declare a telegram presence (the bot_username binding key since the
  // cutover) — these suites double as the "faced sender delivers as before" half of
  // the policy criterion.
  interfaces: { telegram: { bot_username: 'boris_claudecode_bot' } },
} as unknown as PeerRecord
const caller: ResolvedCaller = {
  personality: 'boris',
  runtime: 'claude',
  address: 'claude-boris',
  description: '',
  intelligence: 'artificial',
  cwd: '/tmp/boris',
  record: callerRecord,
}

function startTargetSession(): void {
  const r = spawnSync('tmux', ['-S', sockPath(), 'new-session', '-d', '-x', '200', '-y', '50', '-s', SESSION, 'cat'], {
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`tmux new-session failed: ${r.stderr}`)
}

function killTargetSession(): void {
  spawnSync('tmux', ['-S', sockPath(), 'kill-server'], { encoding: 'utf8' })
}

function capturePane(): string {
  const r = spawnSync('tmux', ['-S', sockPath(), 'capture-pane', '-p', '-t', SESSION], { encoding: 'utf8' })
  return r.stdout ?? ''
}

function startTuiSession(): void {
  const r = spawnSync('tmux', ['-S', tuiSockPath(), 'new-session', '-d', '-x', '200', '-y', '50', '-s', TUI_SESSION, 'cat'], {
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`tmux new-session failed: ${r.stderr}`)
}

function killTuiSession(): void {
  spawnSync('tmux', ['-S', tuiSockPath(), 'kill-server'], { encoding: 'utf8' })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fpw-'))
  sockDir = join(root, 'socks')
  mkdirSync(sockDir, { recursive: true })
  writeFileSync(
    join(root, 'peers-profiles.json'),
    JSON.stringify({
      version: 2,
      peers: [
        { personality: 'boris', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial', cwd: '/tmp/boris' },
        { personality: TARGET, runtime: 'telegram', runtimes: ['telegram'], description: '', intelligence: 'artificial', cwd: root },
        { personality: TUI_TARGET, runtime: 'codex', runtimes: ['codex'], description: '', intelligence: 'artificial', cwd: root },
      ],
    }),
  )
  process.env.IAPEER_ROOT = root
})
afterAll(() => {
  killTargetSession()
  killTuiSession()
  if (prevRoot === undefined) delete process.env.IAPEER_ROOT
  else process.env.IAPEER_ROOT = prevRoot
  rmSync(root, { recursive: true, force: true })
})


// ─── Telegram sender policy (defect track 11.06) ─────────────────────────────
// A sender with NO declared telegram presence (interfaces.telegram.bot|user_id)
// must get a SYNCHRONOUS refusal when the delivery channel is telegram — the
// incident class: the bridge silently dropped such envelopes while the router
// reported ok:true. The bot-faced "delivers as before" half of the criterion is
// carried by the suites above (their caller declares interfaces.telegram.bot).

const facelessCaller: ResolvedCaller = {
  personality: 'ghost',
  runtime: 'claude',
  address: 'claude-ghost',
  description: '',
  intelligence: 'artificial',
  cwd: '/tmp/ghost',
  record: {
    personality: 'ghost',
    runtime: 'claude',
    runtimes: ['claude'],
    description: '',
    intelligence: 'artificial',
    cwd: '/tmp/ghost',
  } as unknown as PeerRecord,
}

describe('telegram sender policy — hasTelegramPresence', () => {
  const rec = (tg: unknown): PeerRecord =>
    ({ personality: 'x', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial', cwd: '/tmp/x', ...(tg !== undefined ? { interfaces: { telegram: tg } } : {}) }) as unknown as PeerRecord
  test('bot_username binding key (agent peers, post-cutover) → sender face present', () => {
    expect(hasTelegramPresence(rec({ bot_username: 'boris_claudecode_bot' }))).toBe(true)
    expect(hasTelegramPresence(rec({ activity: true, bot_username: 'boris_claudecode_bot' }))).toBe(true)
  })
  test('legacy `bot` alone (no bot_username) → NO sender face: the cutover moved the binding key to bot_username; `bot` is no longer read', () => {
    expect(hasTelegramPresence(rec({ bot: 'boris' }))).toBe(false)
  })
  test('user_id alone (natural peers — nova) → NO sender face: the bridge sends FROM the bot_username key; user_id is a receive/operator identity (owner fact, bot_username-only predicate)', () => {
    expect(hasTelegramPresence(rec({ user_id: '100000001' }))).toBe(false)
    expect(hasTelegramPresence(rec({ user_id: 100000001 }))).toBe(false)
  })
  test('no interfaces / no telegram / empty bot_username → absent', () => {
    expect(hasTelegramPresence(rec(undefined))).toBe(false)
    expect(hasTelegramPresence(rec({}))).toBe(false)
    expect(hasTelegramPresence(rec({ bot_username: '' }))).toBe(false)
    expect(hasTelegramPresence(rec({ bot_username: '  ' }))).toBe(false)
    expect(hasTelegramPresence(rec({ aliases: { '/alias_new': 'x' } }))).toBe(false)
  })
})

describe('telegram sender policy — routeSend refusal', () => {
  test('INTENDED channel (target default = telegram, peer offline): refused BEFORE the wake — wake never invoked', async () => {
    let wakeCalled = false
    const wake: WakeFn = async () => {
      wakeCalled = true
      return { status: 'READY', woke: true, runtime: 'telegram', taskDelivered: true }
    }
    const r = await routeSend(facelessCaller, { personality: TARGET, message: 'm' }, { wake })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toContain('telegram policy')
      expect(r.error.message).toContain('"ghost"')
      expect(r.error.message).toContain('NOT delivered')
    }
    expect(wakeCalled).toBe(false)
  })

  test('explicit runtime=telegram override: refused with the policy line, not "offline"', async () => {
    const r = await routeSend(facelessCaller, { personality: TARGET, runtime: 'telegram', message: 'm' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('telegram policy')
  })
})

// ─── #2: launchd-revive delivery retry (bridge the router-restart window) ─────
// A MISS on a LAUNCHD-MANAGED target — the daemon can't wake it (H4) but launchd
// KeepAlive WILL revive it (~1s router restart on connect / `iapeer update`). Without
// the retry, delivery failed in ~16ms with "wake failed: launchd-managed" and an
// in-flight message was lost (observed: natalya→arthur ok=false ms=16 during a connect
// router restart). The fix retries-resolve for a bounded window, then fails LOUD
// (retryable, never silent). TARGET is offline here (no live session in the temp root),
// so the resolve keeps missing and the retry exhausts — exercising the safety path.
describe('launchd-revive delivery retry (#2)', () => {
  const savedGrace = process.env.IAP_LAUNCHD_REVIVE_GRACE_MS
  afterAll(() => {
    if (savedGrace === undefined) delete process.env.IAP_LAUNCHD_REVIVE_GRACE_MS
    else process.env.IAP_LAUNCHD_REVIVE_GRACE_MS = savedGrace
  })

  test('launchd-managed offline target → bounded retry, LOUD err, wake NOT reached', async () => {
    process.env.IAP_LAUNCHD_REVIVE_GRACE_MS = '60' // small window → exits in a few polls
    let wakeCalled = false
    let polls = 0
    const r = await routeSend(
      caller,
      { personality: TARGET, message: 'm' },
      {
        wake: async () => ((wakeCalled = true), { status: 'FAILED', woke: false, reason: 'should-not-reach' }),
        isLaunchdManaged: () => true,
        sleep: async () => {
          polls++
          await new Promise<void>(r => setTimeout(r, 20))
        },
      },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toContain('did not revive') // the launchd-revive err, NOT "wake failed"
      expect(r.error.message).toContain('retry') // retryable, loud — never silent
    }
    expect(polls).toBeGreaterThan(0) // it RETRIED (polled), not an immediate ~16ms fail
    expect(wakeCalled).toBe(false) // launchd path returns before the wake (which would just refuse)
  })

  test('NON-launchd offline target → normal wake path (retry skipped, wake invoked)', async () => {
    let wakeCalled = false
    await routeSend(
      caller,
      { personality: TARGET, message: 'm' },
      { wake: async () => ((wakeCalled = true), { status: 'FAILED', woke: false, reason: 'offline' }), isLaunchdManaged: () => false },
    )
    expect(wakeCalled).toBe(true) // not launchd → straight to wake (existing behavior preserved)
  })

  test('no isLaunchdManaged dep → legacy behavior (wake path, no retry)', async () => {
    let wakeCalled = false
    await routeSend(caller, { personality: TARGET, message: 'm' }, { wake: async () => ((wakeCalled = true), { status: 'FAILED', woke: false, reason: 'offline' }) })
    expect(wakeCalled).toBe(true)
  })
})

// Б7 — routeSend resolves the registry from the INJECTED deps.env, not process.env (the daemon:286
// isolation invariant). Proof: a peer that exists ONLY in a separately-injected sandbox registry is
// found when env is passed, and NOT found when it is not (process.env's registry lacks it).
describe('Б7 routeSend env isolation (registry read is sandboxed by deps.env)', () => {
  test('a peer present only in the injected env registry is resolved via deps.env', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'iapeer-b7-'))
    try {
      writeFileSync(
        join(sandbox, 'peers-profiles.json'),
        JSON.stringify({
          version: 2,
          peers: [
            { personality: 'boris', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial', cwd: '/tmp/boris' },
            { personality: 'zzsandbox', runtime: 'telegram', runtimes: ['telegram'], description: '', intelligence: 'artificial', cwd: sandbox },
          ],
        }),
      )
      const env = { ...process.env, IAPEER_ROOT: sandbox }
      // WITH env → the sandbox registry is read: 'zzsandbox' is found (the error is a channel/offline one,
      // NOT "not in the iapeer peers index").
      const withEnv = await routeSend(caller, { personality: 'zzsandbox', message: 'm' }, { env })
      expect(withEnv.ok).toBe(false)
      if (!withEnv.ok) expect(withEnv.error.message).not.toContain('not in the iapeer peers index')
      // WITHOUT env → process.env's registry (the shared beforeAll root) has NO 'zzsandbox' → not found.
      const noEnv = await routeSend(caller, { personality: 'zzsandbox', message: 'm' })
      expect(noEnv.ok).toBe(false)
      if (!noEnv.ok) expect(noEnv.error.message).toContain('not in the iapeer peers index')
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})
