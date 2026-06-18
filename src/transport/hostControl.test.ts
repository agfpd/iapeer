// Spawn-flip cutover Block 2, Ф0b-2 slice 3 — host-aware in-session control (interrupt / compact).
//
// executeControlOnTarget becomes host-aware: a supervisor-HOSTED target has no `tmux send-keys`, so
// each control plan step is translated to pty bytes by keysToBytes (REUSED from the boot-driver) and
// sent over the supervisor socket. These suites cover the host branch hermetically (a seam injects the
// host-detect + the socket control-send) — asserting the BYTE TRANSLATION + dispatch. The live
// "interrupt really interrupts a hosted turn" effect is proven separately against a real hosted codex.
import { describe, expect, test } from 'bun:test'
import { executeControlOnTarget, type ControlHostSeam, type DeliveryTarget } from './index.ts'

const hostedCodex: DeliveryTarget = {
  runtime: 'codex',
  personality: 'ptyx',
  address: 'codex-ptyx',
  socketPath: '/tmp/nonexistent-iap-test.sock',
}

interface Captured {
  session: string
  chunks: Buffer[]
  stepDelayMs?: number
}

function capturingSeam(captured: Captured[]): ControlHostSeam {
  return {
    hostAlive: () => true,
    sendControl: async (_runDir, session, chunks, opts) => {
      captured.push({ session, chunks, stepDelayMs: opts.stepDelayMs })
      return { ok: true }
    },
  }
}

describe('executeControlOnTarget — hosted control over the socket (slice 3)', () => {
  test('interrupt → a single bare ESC byte (\\x1b), no step delay', async () => {
    const cap: Captured[] = []
    const r = await executeControlOnTarget(hostedCodex, { name: 'interrupt' }, capturingSeam(cap))
    expect(r.ok).toBe(true)
    expect(cap).toHaveLength(1)
    expect(cap[0].session).toBe('codex-ptyx')
    expect(cap[0].chunks.map(b => b.toString('latin1'))).toEqual(['\x1b'])
    expect(cap[0].stepDelayMs).toBeUndefined()
  })

  test('compact → "/compact" literal then Enter (CR), with the 300ms step delay', async () => {
    const cap: Captured[] = []
    const r = await executeControlOnTarget(hostedCodex, { name: 'compact' }, capturingSeam(cap))
    expect(r.ok).toBe(true)
    expect(cap[0].chunks.map(b => b.toString('latin1'))).toEqual(['/compact', '\r'])
    expect(cap[0].stepDelayMs).toBe(300)
  })

  test('flag-off (hostAlive=false) → the socket control-send is NEVER touched (tmux path)', async () => {
    let sendCalls = 0
    const seam: ControlHostSeam = {
      hostAlive: () => false,
      sendControl: async () => {
        sendCalls++
        return { ok: true }
      },
    }
    // tmux send-keys will fail against the bogus socket — incidental; the contract is that flag-off
    // never reaches the host branch.
    await executeControlOnTarget(hostedCodex, { name: 'interrupt' }, seam)
    expect(sendCalls).toBe(0)
  })

  test('socket control-send fails → loud error, no false ok', async () => {
    const seam: ControlHostSeam = {
      hostAlive: () => true,
      sendControl: async () => ({ ok: false, error: 'socket dead during control send' }),
    }
    const r = await executeControlOnTarget(hostedCodex, { name: 'interrupt' }, seam)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toContain('hosted control "interrupt" failed')
      expect(r.error.message).toContain('socket dead')
    }
  })

  test('unsupported command for the runtime → explicit refusal (router runtime, no control plan)', async () => {
    const router: DeliveryTarget = { runtime: 'telegram', personality: 'tg', address: 'telegram-tg', socketPath: '/tmp/x.sock' }
    const r = await executeControlOnTarget(router, { name: 'interrupt' }, capturingSeam([]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('does not support control command')
  })
})
