// Spawn-flip cutover Block 2, Ф0b-2 — host-aware warm delivery (`deliverWarm`).
//
// The warm-deliver path is host-aware: a supervisor-HOSTED target is delivered over its socket
// (Ф0a leaf) and CONFIRMED MESSAGE-SPECIFICALLY — by a NEW transcript record CARRYING this envelope,
// NOT the socket-ack and NOT a bare mtime advance. The mtime confirm (transcript OR pane-log) was a
// false-OK: a receiver in an active turn bumps both mtimes with its OWN rendering even when our paste
// was swallowed at the turn boundary (incident 2026-06-23 — ok=true, message gone). The replacement
// reads only the transcript bytes appended past a pre-deliver baseline and looks for a record that
// echoes our envelope (claude queue-operation/user-turn; codex user-input response_item).
//
// Hermetic: the confirm is an injected seam (no live supervisor, no host fs). Routers (no transcript)
// confirm by the socket-ack. The transcriptCarriesEnvelope repro at the bottom exercises the REAL
// confirm over a temp transcript dir.
import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildEnvelope } from '../codec/index.ts'
import {
  compactDoneBaseline,
  deliverWarm,
  resolveLiveRuntime,
  transcriptCarriesEnvelope,
  type DeliveryTarget,
  type WarmDeliverSeam,
} from './index.ts'

const hostedTarget: DeliveryTarget = {
  runtime: 'codex',
  personality: 'ptyx',
  address: 'codex-ptyx',
  socketPath: '/tmp/nonexistent-iap-test.sock',
}

describe('deliverWarm — hosted target confirms by a NEW transcript record CARRYING the envelope', () => {
  test('socket deliver ok AND a record carrying the envelope appears → ok', async () => {
    let landed = false
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => {
        landed = true // the session recorded our envelope (queue-op / user-turn)
        return { ok: true }
      },
      confirmLanded: () => landed,
    }
    const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
    expect(r.ok).toBe(true)
  })

  test('FALSE-OK KILLER: session is ACTIVE (mtime would bump) but NO record carries our envelope → loud false-FAIL, not ok', async () => {
    // The incident shape: the receiver is mid-turn (its own rendering would advance transcript+pane
    // mtimes), but our paste was swallowed at the turn boundary → no envelope-carrying record. The OLD
    // mtime confirm returned ok=true here (silent loss); the message-specific confirm correctly FAILS.
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => ({ ok: true }), // CR flushed — bytes left us
      confirmLanded: () => false, // active session, but no record carries THIS envelope
      sleep: async () => {}, // never actually wait
    }
    const prev = process.env.IAP_HOST_LIVENESS_GRACE_MS
    process.env.IAP_HOST_LIVENESS_GRACE_MS = '0' // expire immediately — deterministic fail
    try {
      const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.message).toContain('no transcript record carrying the message')
    } finally {
      if (prev === undefined) delete process.env.IAP_HOST_LIVENESS_GRACE_MS
      else process.env.IAP_HOST_LIVENESS_GRACE_MS = prev
    }
  })

  test('the carrying record appears only after a couple of polls (busy enqueues, then logs) → ok', async () => {
    let polls = 0
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => ({ ok: true }),
      confirmLanded: () => ++polls >= 3, // lands on the 3rd poll
      sleep: async () => {}, // poll fast, no real delay
    }
    const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
    expect(r.ok).toBe(true)
    expect(polls).toBeGreaterThanOrEqual(3)
  })

  test('socket deliver fails (socket dead/stalled) → loud fail, confirm never consulted', async () => {
    let confirmProbes = 0
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => ({ ok: false, error: 'socket dead during submit' }),
      confirmLanded: () => (confirmProbes++, true),
    }
    const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toContain('deliver failed')
      expect(r.error.message).toContain('socket dead')
    }
    expect(confirmProbes).toBe(0) // a failed submit never reaches the landed-confirm
  })

  test('no cwd (direct caller, no transcript) → confirmed-only (socket-ack), confirm never consulted', async () => {
    let confirmProbes = 0
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => ({ ok: true }),
      confirmLanded: () => (confirmProbes++, false),
    }
    const r = await deliverWarm(hostedTarget, 'task', undefined, seam)
    expect(r.ok).toBe(true)
    expect(confirmProbes).toBe(0) // no cwd → the transcript confirm is never consulted
  })
})

// Cutover infra-track — a hosted ROUTER (telegram/notifier) has NO transcript, so the message-specific
// transcript confirm a TUI uses can never apply and would false-FAIL every router delivery. The host
// path confirms a router by the socket-ack — PARITY with the legacy tmux router C-j path (delivery-level
// confirm; router liveness is structural via launchd, not a model turn). These cases pin that behavior.
const routerTarget: DeliveryTarget = {
  runtime: 'notifier', // notifierAdapter.kind === 'router'
  personality: 'timer',
  address: 'notifier-timer',
  socketPath: '/tmp/nonexistent-iap-test.sock',
}

describe('deliverWarm — hosted ROUTER confirms by socket-ack (no transcript confirm)', () => {
  test('router deliver ok → ok EVEN with no envelope-carrying record (the exact scenario a TUI fails on)', async () => {
    const prev = process.env.IAP_HOST_LIVENESS_GRACE_MS
    process.env.IAP_HOST_LIVENESS_GRACE_MS = '0' // a confirm-gated path would fail at once here
    try {
      const seam: WarmDeliverSeam = {
        deliverHosted: async () => ({ ok: true }),
        confirmLanded: () => false, // a router writes no transcript — the path must NOT gate on this
      }
      const r = await deliverWarm(routerTarget, '<iap>x</iap>', '/peer/cwd', seam)
      expect(r.ok).toBe(true) // socket-ack IS the confirm for a router; the missing record is irrelevant
    } finally {
      if (prev === undefined) delete process.env.IAP_HOST_LIVENESS_GRACE_MS
      else process.env.IAP_HOST_LIVENESS_GRACE_MS = prev
    }
  })

  test('router socket deliver fails (dead/stalled) → loud fail, no false ok', async () => {
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => ({ ok: false, error: 'socket dead during paste' }),
    }
    const r = await deliverWarm(routerTarget, '<iap>x</iap>', '/peer/cwd', seam)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('deliver failed')
  })
})

// ─── transcriptCarriesEnvelope — the REAL message-specific confirm over a temp transcript dir ──
// This is the hermetic falling-before / passing-after repro for the false-OK fix: a session whose OWN
// turn writes records (assistant/tool — no envelope) does NOT confirm (the old mtime proxy WOULD have);
// only a NEW record CARRYING our envelope confirms. Covers both runtime shapes (claude slug-dir +
// codex sessions-by-cwd) with real fs reads under a temp HOME.
const tmpRoots: string[] = []
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true })
})
function tmpHomeAndCwd(): { env: NodeJS.ProcessEnv; home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), 'iap-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'iap-cwd-'))
  tmpRoots.push(home, cwd)
  return { env: { ...process.env, HOME: home }, home, cwd }
}
const sampleEnvelope = buildEnvelope({
  fromPersonality: 'arthur',
  fromRuntime: 'telegram',
  fromIntelligence: 'natural',
  message: 'привет boris — это сообщение должно дойти',
})

describe('transcriptCarriesEnvelope — message-specific landed-confirm (real fs)', () => {
  test('claude: own-turn records do NOT confirm; a queue-operation carrying the envelope DOES', () => {
    const { env, home, cwd } = tmpHomeAndCwd()
    const slug = realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(home, '.claude', 'projects', slug)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, '') // baseline: empty transcript
    const baseline = compactDoneBaseline('claude', cwd, { env })

    // nothing new yet → not carried
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope)).toBe(false)

    // the receiver's OWN turn writes (no envelope) → STILL not carried (this is the false-OK case the
    // old mtime proxy got wrong: mtime moved, but the message was NOT accepted)
    appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: 'working on it…' } }) + '\n')
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope)).toBe(false)

    // the session enqueues OUR paste → queue-operation content = envelope verbatim → carried
    appendFileSync(file, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: sampleEnvelope }) + '\n')
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope)).toBe(true)
  })

  test('claude idle: a user-turn record carrying the envelope confirms', () => {
    const { env, home, cwd } = tmpHomeAndCwd()
    const slug = realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(home, '.claude', 'projects', slug)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, '')
    const baseline = compactDoneBaseline('claude', cwd, { env })
    appendFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: sampleEnvelope } }) + '\n')
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope)).toBe(true)
  })

  test('a pre-baseline copy of the same envelope does NOT confirm (only bytes past the offset count)', () => {
    const { env, home, cwd } = tmpHomeAndCwd()
    const slug = realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(home, '.claude', 'projects', slug)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.jsonl')
    // an EARLIER identical message already in the transcript before we baseline
    writeFileSync(file, JSON.stringify({ type: 'user', message: { content: sampleEnvelope } }) + '\n')
    const baseline = compactDoneBaseline('claude', cwd, { env })
    // no NEW record → must not confirm off the stale copy
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope)).toBe(false)
  })

  test('codex: a user-input response_item (nested) carrying the envelope confirms; the session is found by cwd', () => {
    const { env, home, cwd } = tmpHomeAndCwd()
    const root = join(home, '.codex', 'sessions', '2026', '06', '23')
    mkdirSync(root, { recursive: true })
    const file = join(root, 'rollout-sess.jsonl')
    // session_meta with payload.cwd === the peer cwd → compactCandidateFiles picks this file
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { cwd: realpathSync(cwd) } }) + '\n')
    const baseline = compactDoneBaseline('codex', cwd, { env })
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope)).toBe(false)
    appendFileSync(
      file,
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: sampleEnvelope }] } }) + '\n',
    )
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope)).toBe(true)
  })
})

// resolveLiveRuntime — the AUTHORITATIVE current live runtime (freshest pane-log among the
// PID-alive supervisor sessions), the signal external packages (telegram-runtime typing)
// must use instead of default_runtime / a lingering .session. Deps injected for hermeticity.
describe('resolveLiveRuntime — freshest pane-log among pid-alive sessions', () => {
  test('no alive session → null', () => {
    expect(resolveLiveRuntime('p', { aliveRuntimes: () => [] })).toBeNull()
  })

  test('exactly one alive → that runtime (pane-log not even consulted)', () => {
    let probes = 0
    const rt = resolveLiveRuntime('p', { aliveRuntimes: () => ['codex'], paneLogMtime: () => (probes++, 1) })
    expect(rt).toBe('codex')
    expect(probes).toBe(0)
  })

  test('multiple alive (a /codex flip left both) → the freshest pane-log = the active surface', () => {
    const mt: Record<string, number> = { 'claude-p': 100, 'codex-p': 200 }
    expect(resolveLiveRuntime('p', { aliveRuntimes: () => ['claude', 'codex'], paneLogMtime: a => mt[a] ?? 0 })).toBe('codex')
    // freshness flips → the resolver follows the active surface
    mt['claude-p'] = 300
    expect(resolveLiveRuntime('p', { aliveRuntimes: () => ['claude', 'codex'], paneLogMtime: a => mt[a] ?? 0 })).toBe('claude')
  })

  test('a dead runtime is EXCLUDED even if its pane-log is freshest (the flip-race fix)', () => {
    // codex just died (not in the alive set) but its pane-log is the freshest (lingers);
    // claude is the only ALIVE one → resolver returns claude, NOT the stale-fresh codex.
    const mt: Record<string, number> = { 'claude-p': 100, 'codex-p': 999 }
    expect(resolveLiveRuntime('p', { aliveRuntimes: () => ['claude'], paneLogMtime: a => mt[a] ?? 0 })).toBe('claude')
  })
})
