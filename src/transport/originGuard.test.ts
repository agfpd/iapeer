// Origin-guard (docs/18) — hermetic coverage of the state model (arm/answer/TTL), the
// pending lifecycle (hold → claim → restore/discard, TTL, double-claim), and the
// routeSend wiring (hold on armed mismatch BEFORE any wake; pass-through for same-
// channel / initiative / bypass / kill-switch; post-ok stamps both directions).
//
// All paths resolve from an INJECTED env (IAPEER_ROOT sandbox) — never process.env —
// per the isolation invariant (a leaked write would hit the real ~/.iapeer).

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  armedOrigin,
  buildHoldNote,
  claimHeldSend,
  discardHeldSend,
  holdSend,
  noteHumanAnswered,
  noteHumanInbound,
  originGuardEnabled,
  restoreHeldSend,
  sweepExpiredPendings,
} from './originGuard.ts'
import { routeSend, type WakeFn } from './index.ts'
import type { ResolvedCaller } from '../identity/index.ts'
import type { PeerRecord } from '../registry/index.ts'

function sandboxEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'og-'))
  return { ...process.env, IAPEER_ROOT: root }
}

const T0 = 1_000_000_000_000 // fixed epoch base — the suites inject nowMs throughout

// ─── State model: arm / answer / TTL ─────────────────────────────────────────────

describe('origin state — armed discriminates reply vs initiative', () => {
  test('inbound arms the pair with the origin runtime; answered disarms; newer inbound re-arms', () => {
    const env = sandboxEnv()
    expect(armedOrigin('agent', 'hume', { env, nowMs: T0 })).toBeNull() // no state → no friction
    noteHumanInbound('agent', 'hume', 'web', { env, nowMs: T0 })
    const armed = armedOrigin('agent', 'hume', { env, nowMs: T0 + 1000 })
    expect(armed).not.toBeNull()
    expect(armed!.rt).toBe('web')
    noteHumanAnswered('agent', 'hume', { env, nowMs: T0 + 2000 })
    expect(armedOrigin('agent', 'hume', { env, nowMs: T0 + 3000 })).toBeNull() // answered → initiative
    noteHumanInbound('agent', 'hume', 'telegram', { env, nowMs: T0 + 4000 })
    expect(armedOrigin('agent', 'hume', { env, nowMs: T0 + 5000 })!.rt).toBe('telegram') // re-armed, new origin
  })

  test('ARM_TTL bounds staleness (a pane/voice-closed thread must not hold forever)', () => {
    const env = { ...sandboxEnv(), IAPEER_ORIGIN_GUARD_ARM_TTL_MS: '1000' }
    noteHumanInbound('agent', 'hume', 'web', { env, nowMs: T0 })
    expect(armedOrigin('agent', 'hume', { env, nowMs: T0 + 999 })).not.toBeNull()
    expect(armedOrigin('agent', 'hume', { env, nowMs: T0 + 1001 })).toBeNull() // stale → no friction
  })

  test('pairs are independent (per human, per agent)', () => {
    const env = sandboxEnv()
    noteHumanInbound('agent', 'hume', 'web', { env, nowMs: T0 })
    expect(armedOrigin('agent', 'other-human', { env, nowMs: T0 })).toBeNull()
    expect(armedOrigin('other-agent', 'hume', { env, nowMs: T0 })).toBeNull()
    noteHumanAnswered('other-agent', 'hume', { env, nowMs: T0 }) // no entry → harmless no-op
    expect(armedOrigin('agent', 'hume', { env, nowMs: T0 })).not.toBeNull()
  })

  test('kill-switch: IAPEER_ORIGIN_GUARD=0 disables', () => {
    expect(originGuardEnabled({ IAPEER_ORIGIN_GUARD: '0' } as NodeJS.ProcessEnv)).toBe(false)
    expect(originGuardEnabled({} as NodeJS.ProcessEnv)).toBe(true)
  })

  test('corrupt state file → fails open (no state, no holds)', () => {
    const env = sandboxEnv()
    noteHumanInbound('agent', 'hume', 'web', { env, nowMs: T0 })
    writeFileSync(join(env.IAPEER_ROOT!, 'state', 'iapeer', 'origin', 'state.json'), '{not json')
    expect(armedOrigin('agent', 'hume', { env, nowMs: T0 })).toBeNull()
  })
})

// ─── Pending lifecycle ───────────────────────────────────────────────────────────

const ORIGIN = { rt: 'web', inboundTs: T0 }

describe('pending lifecycle — hold / claim / restore / discard / TTL', () => {
  test('hold persists verbatim; claim wins once; restore re-opens; discard closes', () => {
    const env = sandboxEnv()
    const held = holdSend(
      'claude-agent',
      { personality: 'hume', message: 'msg body', topic: 'top', attachments: ['/a/b'] },
      ORIGIN,
      'telegram',
      { env, nowMs: T0 },
    )
    expect(held.id).toMatch(/^og-[0-9a-f]{8}$/)
    expect(held.originRt).toBe('web')
    expect(held.intendedRt).toBe('telegram')

    const claimed = claimHeldSend(held.id, { env, nowMs: T0 + 1000 })
    expect(claimed.ok).toBe(true)
    if (claimed.ok) {
      expect(claimed.value.message).toBe('msg body')
      expect(claimed.value.topic).toBe('top')
      expect(claimed.value.attachments).toEqual(['/a/b'])
      expect(claimed.value.caller).toBe('claude-agent')
    }
    // double-claim loses cleanly (atomic rename — exactly one confirmer)
    const second = claimHeldSend(held.id, { env, nowMs: T0 + 1000 })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.message).toContain('no pending held send')
    // delivery failed → restore → claimable again
    restoreHeldSend(held.id, { env })
    expect(claimHeldSend(held.id, { env, nowMs: T0 + 2000 }).ok).toBe(true)
    // delivery ok → discard → gone
    discardHeldSend(held.id, { env })
    expect(claimHeldSend(held.id, { env, nowMs: T0 + 3000 }).ok).toBe(false)
  })

  test('pending TTL: an expired hold is refused at claim', () => {
    const env = { ...sandboxEnv(), IAPEER_ORIGIN_GUARD_PENDING_TTL_MS: '600000' }
    const held = holdSend('claude-agent', { personality: 'hume', message: 'm' }, ORIGIN, 'telegram', { env, nowMs: T0 })
    const r = claimHeldSend(held.id, { env, nowMs: T0 + 600_001 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('expired')
  })

  test('lazy sweep GCs stale pending files by mtime', () => {
    const env = sandboxEnv()
    const held = holdSend('claude-agent', { personality: 'hume', message: 'm' }, ORIGIN, 'telegram', { env, nowMs: T0 })
    const dir = join(env.IAPEER_ROOT!, 'state', 'iapeer', 'origin', 'pending')
    const path = join(dir, `${held.id}.json`)
    expect(existsSync(path)).toBe(true)
    const old = (Date.now() - 16 * 60_000) / 1000 // older than the 15-min default TTL
    utimesSync(path, old, old)
    sweepExpiredPendings({ env })
    expect(existsSync(path)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  test('hold note names both zero-regeneration exits + the id', () => {
    const env = sandboxEnv()
    const held = holdSend('claude-agent', { personality: 'hume', message: 'm' }, ORIGIN, 'telegram', { env, nowMs: T0 })
    const note = buildHoldNote(held, { env })
    expect(note).toContain('origin-guard')
    expect(note).toContain(`iapeer confirm-send ${held.id}\n`)
    expect(note).toContain(`iapeer confirm-send ${held.id} --runtime web`)
    expect(note).toContain('NOT delivered')
  })
})

// ─── routeSend wiring ────────────────────────────────────────────────────────────

const HUMAN = 'hume'

function registryWith(env: NodeJS.ProcessEnv): void {
  writeFileSync(
    join(env.IAPEER_ROOT!, 'peers-profiles.json'),
    JSON.stringify({
      version: 2,
      peers: [
        {
          personality: 'agent',
          runtime: 'claude',
          runtimes: ['claude'],
          description: '',
          intelligence: 'artificial',
          cwd: '/tmp/agent',
          interfaces: { telegram: { bot_username: 'agent_bot' } },
        },
        {
          personality: HUMAN,
          runtime: 'telegram',
          runtimes: ['telegram', 'web'],
          description: '',
          intelligence: 'natural',
          cwd: '/tmp/hume',
        },
      ],
    }),
  )
}

const agentCaller: ResolvedCaller = {
  personality: 'agent',
  runtime: 'claude',
  address: 'claude-agent',
  description: '',
  intelligence: 'artificial',
  cwd: '/tmp/agent',
  record: {
    personality: 'agent',
    runtime: 'claude',
    runtimes: ['claude'],
    description: '',
    intelligence: 'artificial',
    cwd: '/tmp/agent',
    interfaces: { telegram: { bot_username: 'agent_bot' } },
  } as unknown as PeerRecord,
}

const humanCaller: ResolvedCaller = {
  personality: HUMAN,
  runtime: 'web',
  address: 'web-hume',
  description: '',
  intelligence: 'natural',
  cwd: '/tmp/hume',
  record: {
    personality: HUMAN,
    runtime: 'telegram',
    runtimes: ['telegram', 'web'],
    description: '',
    intelligence: 'natural',
    cwd: '/tmp/hume',
  } as unknown as PeerRecord,
}

describe('routeSend origin-guard wiring', () => {
  test('armed mismatch → HELD before any wake: instructive err + pending file, wake untouched', async () => {
    const env = sandboxEnv()
    registryWith(env)
    noteHumanInbound('agent', HUMAN, 'web', { env })
    const source = join(env.IAPEER_ROOT!, 'held-source.txt')
    writeFileSync(source, 'held attachment bytes')
    let wakeCalled = false
    const wake: WakeFn = async () => ((wakeCalled = true), { status: 'READY', woke: true, taskDelivered: true })
    // no runtime → intended = the human's default (telegram) ≠ armed origin (web)
    const r = await routeSend(
      agentCaller,
      { personality: HUMAN, message: 'reply body', attachments: [source] },
      { env, wake },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toContain('origin-guard')
      expect(r.error.message).toContain('from "web"')
      expect(r.error.message).toContain('targets "telegram"')
      expect(r.error.message).toMatch(/iapeer confirm-send og-[0-9a-f]{8}/)
    }
    expect(wakeCalled).toBe(false)
    const pendings = readdirSync(join(env.IAPEER_ROOT!, 'state', 'iapeer', 'origin', 'pending'))
    expect(pendings.length).toBe(1)
    // the held file is claimable and carries the send verbatim
    const id = pendings[0].replace('.json', '')
    const claimed = claimHeldSend(id, { env })
    expect(claimed.ok).toBe(true)
    if (claimed.ok) {
      expect(claimed.value.message).toBe('reply body')
      const stable = claimed.value.attachments![0]!
      expect(stable).not.toBe(source)
      rmSync(source)
      expect(readFileSync(stable, 'utf8')).toBe('held attachment bytes')
    }
  })

  test('same-channel reply (explicit runtime = armed origin) → NO hold (passes to normal routing)', async () => {
    const env = sandboxEnv()
    registryWith(env)
    noteHumanInbound('agent', HUMAN, 'web', { env })
    const r = await routeSend(agentCaller, { personality: HUMAN, runtime: 'web', message: 'm' }, { env })
    expect(r.ok).toBe(false) // offline in the sandbox — but NOT held
    if (!r.ok) expect(r.error.message).not.toContain('origin-guard')
  })

  test('default channel IS the origin (armed telegram, no runtime) → NO hold', async () => {
    const env = sandboxEnv()
    registryWith(env)
    noteHumanInbound('agent', HUMAN, 'telegram', { env })
    const r = await routeSend(agentCaller, { personality: HUMAN, message: 'm' }, { env })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).not.toContain('origin-guard')
  })

  test('initiative (answered) and stale (ARM_TTL) → NO hold', async () => {
    const env = { ...sandboxEnv(), IAPEER_ORIGIN_GUARD_ARM_TTL_MS: '50' }
    registryWith(env)
    noteHumanInbound('agent', HUMAN, 'web', { env })
    noteHumanAnswered('agent', HUMAN, { env })
    const answered = await routeSend(agentCaller, { personality: HUMAN, message: 'm' }, { env })
    if (!answered.ok) expect(answered.error.message).not.toContain('origin-guard')
    // re-arm, then let it go stale
    noteHumanInbound('agent', HUMAN, 'web', { env, nowMs: Date.now() - 60 })
    const stale = await routeSend(agentCaller, { personality: HUMAN, message: 'm' }, { env })
    if (!stale.ok) expect(stale.error.message).not.toContain('origin-guard')
  })

  test('bypass dep (confirm-send path) and kill-switch env → NO hold', async () => {
    const env = sandboxEnv()
    registryWith(env)
    noteHumanInbound('agent', HUMAN, 'web', { env })
    const bypassed = await routeSend(agentCaller, { personality: HUMAN, message: 'm' }, { env, originGuardBypass: true })
    if (!bypassed.ok) expect(bypassed.error.message).not.toContain('origin-guard')
    const killed = await routeSend(agentCaller, { personality: HUMAN, message: 'm' }, { env: { ...env, IAPEER_ORIGIN_GUARD: '0' } })
    if (!killed.ok) expect(killed.error.message).not.toContain('origin-guard')
  })

  test('agent→agent traffic is untouched even when armed state exists for other pairs', async () => {
    const env = sandboxEnv()
    registryWith(env)
    noteHumanInbound('agent', HUMAN, 'web', { env })
    // target 'agent' is artificial → guard is out of the path entirely
    const r = await routeSend(humanCaller, { personality: 'agent', message: 'm' }, { env })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).not.toContain('origin-guard')
  })

  test('post-ok stamps: human→agent arms (via the ephemeral ok seam); agent→human answers', async () => {
    const env = sandboxEnv()
    registryWith(env)
    // human → agent, delivered ok through the ephemeral seam → the pair ARMS with the caller's runtime
    const okDeliver = {
      isEphemeral: () => true,
      deliver: async () =>
        ({ ok: true as const, value: { ok: true as const, delivered_to: { personality: 'agent', runtime: 'claude' }, woke: false, queued: true as const, ts: 'x' } }),
    }
    const inbound = await routeSend(humanCaller, { personality: 'agent', message: 'ask' }, { env, ephemeral: okDeliver })
    expect(inbound.ok).toBe(true)
    expect(armedOrigin('agent', HUMAN, { env })!.rt).toBe('web')
    // agent → human, delivered ok (ephemeral seam again — the wrapper stamps on ANY ok) → DISARMS
    const reply = await routeSend(
      agentCaller,
      { personality: HUMAN, runtime: 'web', message: 'answer' },
      { env, ephemeral: okDeliver },
    )
    expect(reply.ok).toBe(true)
    expect(armedOrigin('agent', HUMAN, { env })).toBeNull()
  })
})
