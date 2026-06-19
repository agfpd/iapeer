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
  // caller must declare a telegram presence (the bot machine-key) — these suites
  // double as the "bot-faced sender delivers as before" half of the policy criterion.
  interfaces: { telegram: { bot: 'boris' } },
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

describe.if(tmuxAvailable)('routeSend wake fast-path (concurrent-sender envelope loss)', () => {
  test('taskDelivered:false → routeSend delivers the envelope itself via the live path', async () => {
    const marker = 'SECOND-SENDER-ENVELOPE-7741'
    // The loser-of-the-lock outcome: the session is up (the WINNING wake booted it),
    // READY came back, but THIS caller's task was never delivered.
    const wake: WakeFn = async () => {
      startTargetSession()
      return { status: 'READY', woke: false, runtime: 'telegram', taskDelivered: false }
    }
    const r = await routeSend(caller, { personality: TARGET, message: marker }, { wake })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // honest woke flag: the envelope went the LIVE path, not a boot first-message
    expect(r.value.woke).toBe(false)
    expect(r.value.delivered_to).toEqual({ personality: TARGET, runtime: 'telegram' })
    // the envelope actually LANDED in the session (pre-fix: silently lost)
    expect(capturePane()).toContain(marker)
    killTargetSession()
  })

  test('legacy WakeFn without taskDelivered → prior behavior (no redelivery, woke:true)', async () => {
    const marker = 'LEGACY-IMPL-ENVELOPE-9962'
    const wake: WakeFn = async () => {
      startTargetSession()
      return { status: 'READY', woke: true, runtime: 'telegram' } // field absent → assumed delivered
    }
    const r = await routeSend(caller, { personality: TARGET, message: marker }, { wake })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.woke).toBe(true)
    // assumed delivered as the boot first-message → routeSend must NOT double-deliver
    expect(capturePane()).not.toContain(marker)
    killTargetSession()
  })

  test('taskDelivered:false but the session died right after wake → loud failure, not false ok', async () => {
    const wake: WakeFn = async () => {
      // READY without a live session: verify-before-act must catch it
      return { status: 'READY', woke: false, runtime: 'telegram', taskDelivered: false }
    }
    const r = await routeSend(caller, { personality: TARGET, message: 'never lands' }, { wake })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.message).toMatch(/verify-before-act|not live/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// noteLiveTopic seam — a LIVE delivery carrying a topic must surface it to the
// injected hook (lifecycle's .topic marker write), so the fresh-vs-resume
// discriminator compares against the topic the session last WORKED ON, not the
// one it woke with (defect 11.06: stale wake-time marker → false fresh).
// ─────────────────────────────────────────────────────────────────────────────

describe.if(tmuxAvailable)('routeSend noteLiveTopic seam (live-delivered topic)', () => {
  test('live hit with a topic → hook fired ONCE with the TARGET identity + topic', async () => {
    startTargetSession()
    const notes: Array<[string, string]> = []
    const r = await routeSend(
      caller,
      { personality: TARGET, message: 'm', topic: 'fix-resume' },
      { noteLiveTopic: (id, t) => notes.push([id, t]) },
    )
    expect(r.ok).toBe(true)
    expect(notes).toEqual([[`telegram-${TARGET}`, 'fix-resume']])
    killTargetSession()
  })

  test('no topic → hook NOT fired; a throwing hook never fails the delivered message', async () => {
    startTargetSession()
    const notes: string[] = []
    const r1 = await routeSend(caller, { personality: TARGET, message: 'm1' }, { noteLiveTopic: () => { notes.push('x') } })
    expect(r1.ok).toBe(true)
    expect(notes).toEqual([])
    const r2 = await routeSend(
      caller,
      { personality: TARGET, message: 'm2', topic: 't' },
      { noteLiveTopic: () => { throw new Error('boom') } },
    )
    expect(r2.ok).toBe(true)
    killTargetSession()
  })

  test('post-wake fast-path redelivery (taskDelivered:false) also notes the topic — it is a LIVE delivery', async () => {
    const notes: Array<[string, string]> = []
    const wake: WakeFn = async () => {
      startTargetSession()
      return { status: 'READY', woke: false, runtime: 'telegram', taskDelivered: false }
    }
    const r = await routeSend(
      caller,
      { personality: TARGET, message: 'm', topic: 'tt' },
      { wake, noteLiveTopic: (id, t) => notes.push([id, t]) },
    )
    expect(r.ok).toBe(true)
    expect(notes).toEqual([[`telegram-${TARGET}`, 'tt']])
    killTargetSession()
  })

  test('boot first-message delivery (woke:true) does NOT fire the hook — the wake records its own topic', async () => {
    const notes: string[] = []
    const wake: WakeFn = async () => {
      startTargetSession()
      return { status: 'READY', woke: true, runtime: 'telegram', taskDelivered: true }
    }
    const r = await routeSend(
      caller,
      { personality: TARGET, message: 'm', topic: 'tb' },
      { wake, noteLiveTopic: () => { notes.push('x') } },
    )
    expect(r.ok).toBe(true)
    expect(notes).toEqual([])
    killTargetSession()
  })
})

describe.if(tmuxAvailable)('routeSend busy-composer queue seam', () => {
  test('live local TUI hit can return fast queued ack instead of delivering synchronously', async () => {
    startTuiSession()
    const seen: string[] = []
    const r = await routeSend(
      caller,
      { personality: TUI_TARGET, message: 'hold until operator submits', topic: 'composer-q' },
      {
        composerQueue: {
          tryEnqueue: async ({ target, envelope, topic }) => {
            seen.push(`${target.runtime}-${target.personality}:${topic}:${envelope.includes('hold until operator submits')}`)
            return {
              ok: true,
              value: {
                ok: true as const,
                delivered_to: { personality: target.personality, runtime: target.runtime },
                woke: false,
                queued: true,
                queuedBy: 'composer',
                queueDepth: 1,
                ts: 'now',
              },
            }
          },
        },
      },
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.queued).toBe(true)
    expect(r.value.queuedBy).toBe('composer')
    expect(seen).toEqual([`codex-${TUI_TARGET}:composer-q:true`])
    killTuiSession()
  })
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
  test('bot machine-key (agent peers) → sender face present', () => {
    expect(hasTelegramPresence(rec({ bot: 'boris' }))).toBe(true)
  })
  test('user_id alone (natural peers — nova) → NO sender face: the bridge sends FROM the bot key; user_id is a receive/operator identity (owner fact, bot-only predicate)', () => {
    expect(hasTelegramPresence(rec({ user_id: '100000001' }))).toBe(false)
    expect(hasTelegramPresence(rec({ user_id: 100000001 }))).toBe(false)
  })
  test('no interfaces / no telegram / empty bot → absent', () => {
    expect(hasTelegramPresence(rec(undefined))).toBe(false)
    expect(hasTelegramPresence(rec({}))).toBe(false)
    expect(hasTelegramPresence(rec({ bot: '' }))).toBe(false)
    expect(hasTelegramPresence(rec({ bot: '  ' }))).toBe(false)
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

describe.if(tmuxAvailable)('telegram sender policy — live telegram session', () => {
  test('faceless sender + LIVE telegram target → refused, envelope NEVER reaches the pane', async () => {
    startTargetSession()
    const r = await routeSend(facelessCaller, { personality: TARGET, message: 'POLICY-MUST-BLOCK' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('telegram policy')
    expect(capturePane()).not.toContain('POLICY-MUST-BLOCK')
    killTargetSession()
  })

  test('bot-faced sender (boris) + LIVE telegram target → delivered as before', async () => {
    startTargetSession()
    const r = await routeSend(caller, { personality: TARGET, message: 'BOT-FACED-OK' })
    expect(r.ok).toBe(true)
    expect(capturePane()).toContain('BOT-FACED-OK')
    killTargetSession()
  })
})
