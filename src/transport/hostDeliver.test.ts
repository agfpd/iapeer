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
// Hermetic: the confirm is an injected seam (no live supervisor, no host fs). The transcript confirm
// is for 'transcript'-confirm runtimes (claude — it logs an accepted paste sub-second). codex is
// 'socket-ack' (durable input queue, no prompt-acceptance record) and ROUTERS (no transcript) confirm
// by the socket-ack alone. The transcriptCarriesEnvelope repro at the bottom exercises the REAL confirm
// over a temp transcript dir.
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

// claude is the 'transcript'-confirm runtime — it logs an accepted paste sub-second, so the
// message-specific transcript confirm is its delivery gate (and its swallow-guard).
const hostedTarget: DeliveryTarget = {
  runtime: 'claude',
  personality: 'ptyx',
  address: 'claude-ptyx',
  socketPath: '/tmp/nonexistent-iap-test.sock',
}

describe('deliverWarm — hosted CLAUDE (transcript-confirm) confirms by a NEW record CARRYING the envelope', () => {
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

  // ── SUBMIT-RETRY (16.07.2026) ───────────────────────────────────────────────────────────────
  // deliverToHost presses Enter once, on a fixed settle. That CR is sometimes EATEN — measured on the
  // FIRST attachment-bearing delivery into a session — and then NO turn exists and no record can ever
  // appear, so a passive grace waits forever on nothing. Proven live: an att=4 into an idle receiver
  // left the transcript byte-frozen for 180 s with nothing else sent, and moved only when a later
  // delivery poked it. So while no record has landed, the grace re-presses Enter until one submits.
  // WHY that first CR is eaten is unknown; the retry deliberately does not model it.
  describe('submit-retry', () => {
    test('THE FROZEN CASE: paste landed but the first CR was eaten → retries until the record appears → ok', async () => {
      let resubmits = 0
      // Nothing is recorded until an Enter actually submits the composer — here it takes 2 presses.
      // This is the shape that hung forever before the fix.
      const seam: WarmDeliverSeam = {
        deliverHosted: async () => ({ ok: true }), // paste flushed; its CR was eaten
        confirmLanded: () => resubmits >= 2,
        sleep: async () => {},
        resubmit: async () => void resubmits++,
      }
      const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
      expect(r.ok).toBe(true)
      expect(resubmits).toBeGreaterThanOrEqual(2)
    })

    test('NO REGRESSION: a record that lands immediately (text-only) never triggers a retry', async () => {
      let resubmits = 0
      const seam: WarmDeliverSeam = {
        deliverHosted: async () => ({ ok: true }),
        confirmLanded: () => true, // first CR submitted it — sub-second record
        sleep: async () => {},
        resubmit: async () => void resubmits++,
      }
      const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
      expect(r.ok).toBe(true)
      expect(resubmits).toBe(0) // no stray Enter into a live session
    })

    test('the retry STOPS the instant the record lands — never presses again after confirm', async () => {
      let resubmits = 0
      let landedAfter = 1 // lands once one retry has fired
      const seam: WarmDeliverSeam = {
        deliverHosted: async () => ({ ok: true }),
        confirmLanded: () => resubmits >= landedAfter,
        sleep: async () => {},
        resubmit: async () => void resubmits++,
      }
      const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
      expect(r.ok).toBe(true)
      expect(resubmits).toBe(1) // exactly the one that did the work — not one more
    })

    test('a genuinely unresponsive session still false-FAILs after the grace (retry is not a false-OK)', async () => {
      let resubmits = 0
      const seam: WarmDeliverSeam = {
        deliverHosted: async () => ({ ok: true }),
        confirmLanded: () => false, // nothing ever lands, however often we press
        sleep: async () => {},
        resubmit: async () => void resubmits++,
      }
      const prev = process.env.IAP_HOST_LIVENESS_GRACE_MS
      process.env.IAP_HOST_LIVENESS_GRACE_MS = '0'
      try {
        const r = await deliverWarm(hostedTarget, 'task', '/peer/cwd', seam)
        expect(r.ok).toBe(false) // silent loss stays forbidden
      } finally {
        if (prev === undefined) delete process.env.IAP_HOST_LIVENESS_GRACE_MS
        else process.env.IAP_HOST_LIVENESS_GRACE_MS = prev
      }
    })
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

// CODEX — a 'socket-ack' TUI runtime: its input queue is DURABLE (a mid-turn submit is held + processed
// at the next turn boundary, never lost — verified live 2026-06-25: an 80s turn still ingested + replied
// with the exact probe token even though the send false-FAILed at the 8s grace), and it logs NO
// prompt-acceptance record, so a transcript grace only ever false-FAILs a message that WILL be processed
// and wrongly escalates to a fallback peer. deliverViaHost confirms codex by the socket-ack alone; a
// genuinely dead session still fails at deliverHosted. These cases pin that behavior (the regression the
// fix kills: a busy codex's PRL alert false-FAILing → fallback-escalating onto another peer).
const codexTarget: DeliveryTarget = {
  runtime: 'codex',
  personality: 'cxx',
  address: 'codex-cxx',
  socketPath: '/tmp/nonexistent-iap-test.sock',
}

describe('deliverWarm — hosted CODEX confirms by socket-ack (durable queue, no prompt-acceptance record)', () => {
  test('codex deliver ok → ok EVEN with no envelope-carrying record (a transcript grace would false-FAIL a busy codex)', async () => {
    const prev = process.env.IAP_HOST_LIVENESS_GRACE_MS
    process.env.IAP_HOST_LIVENESS_GRACE_MS = '0' // a confirm-gated path would fail at once here
    try {
      let confirmProbes = 0
      const seam: WarmDeliverSeam = {
        deliverHosted: async () => ({ ok: true }), // bracketed-paste + CR flushed to the pty
        confirmLanded: () => (confirmProbes++, false), // busy codex: no record appears within any grace
      }
      const r = await deliverWarm(codexTarget, '<iap>майнинг PRL</iap>', '/peer/cwd', seam)
      expect(r.ok).toBe(true) // socket-ack IS the confirm for codex; the missing record is irrelevant
      expect(confirmProbes).toBe(0) // codex never consults the transcript confirm — no false-FAIL, no escalation
    } finally {
      if (prev === undefined) delete process.env.IAP_HOST_LIVENESS_GRACE_MS
      else process.env.IAP_HOST_LIVENESS_GRACE_MS = prev
    }
  })

  test('codex socket deliver fails (dead/stalled) → loud fail (a genuinely dead codex STILL escalates)', async () => {
    const seam: WarmDeliverSeam = {
      deliverHosted: async () => ({ ok: false, error: 'socket dead during submit' }),
    }
    const r = await deliverWarm(codexTarget, '<iap>x</iap>', '/peer/cwd', seam)
    expect(r.ok).toBe(false) // really-dead is still caught at the socket-ack → fallback still fires
    if (!r.ok) expect(r.error.message).toContain('deliver failed')
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
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope, { env })).toBe(false)

    // the receiver's OWN turn writes (no envelope) → STILL not carried (this is the false-OK case the
    // old mtime proxy got wrong: mtime moved, but the message was NOT accepted)
    appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: 'working on it…' } }) + '\n')
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope, { env })).toBe(false)

    // the session enqueues OUR paste → queue-operation content = envelope verbatim → carried
    appendFileSync(file, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: sampleEnvelope }) + '\n')
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope, { env })).toBe(true)
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
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope, { env })).toBe(true)
  })

  test('fresh session: a NEW jsonl born AFTER the baseline (self-fresh) carrying the envelope CONFIRMS', () => {
    // Incident 2026-07-10: a self-fresh/eager-fresh session writes its NEW session file LAZILY on the
    // first delivered turn — AFTER the pre-deliver baseline snapshot. Iterating baseline-only scanned the
    // dead OLD file and false-FAILed a message the session actually accepted. The confirm must pick up a
    // post-baseline file (from offset 0).
    const { env, home, cwd } = tmpHomeAndCwd()
    const slug = realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(home, '.claude', 'projects', slug)
    mkdirSync(dir, { recursive: true })
    // baseline captured with ONLY the previous (soon-dead) session's file present
    const oldFile = join(dir, 'old-session.jsonl')
    appendFileSync(oldFile, JSON.stringify({ type: 'assistant', message: { content: 'prior turn' } }) + '\n')
    const baseline = compactDoneBaseline('claude', cwd, { env })
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope, { env })).toBe(false)

    // the FRESH session comes up and creates a NEW jsonl (absent from the baseline) carrying our envelope
    const freshFile = join(dir, 'fresh-session.jsonl')
    appendFileSync(freshFile, JSON.stringify({ type: 'user', message: { role: 'user', content: sampleEnvelope } }) + '\n')
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope, { env })).toBe(true)
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
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope, { env })).toBe(false)
  })

  test('codex: a user-input response_item (nested) carrying the envelope confirms; the session is found by cwd', () => {
    const { env, home, cwd } = tmpHomeAndCwd()
    const root = join(home, '.codex', 'sessions', '2026', '06', '23')
    mkdirSync(root, { recursive: true })
    const file = join(root, 'rollout-sess.jsonl')
    // session_meta with payload.cwd === the peer cwd → compactCandidateFiles picks this file
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { cwd: realpathSync(cwd) } }) + '\n')
    const baseline = compactDoneBaseline('codex', cwd, { env })
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope, { env })).toBe(false)
    appendFileSync(
      file,
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: sampleEnvelope }] } }) + '\n',
    )
    expect(transcriptCarriesEnvelope(baseline, sampleEnvelope, { env })).toBe(true)
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

// ─────────────────────────────────────────────────────────────────────────────
// В6 — per-target delivery serialization (concurrent sends to one pty must not splice)
// ─────────────────────────────────────────────────────────────────────────────

describe('В6 per-target delivery serialization', () => {
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  // codex = socket-ack → deliverViaHost returns right after deliverHosted (timing = the seam)
  const codexT = (n: string): DeliveryTarget => ({ personality: n, runtime: 'codex', address: `codex-${n}`, socketPath: '/x' })

  test('two deliveries to the SAME address serialize (no frame interleave)', async () => {
    const events: string[] = []
    const seam: WarmDeliverSeam = {
      deliverHosted: async (_id, msg) => {
        events.push(`start:${msg}`)
        await sleep(30)
        events.push(`end:${msg}`)
        return { ok: true }
      },
    }
    const A = codexT('ser-uniq') // unique address — the module-level chain persists across tests
    const p1 = deliverWarm(A, 'm1', undefined, seam)
    const p2 = deliverWarm(A, 'm2', undefined, seam)
    await Promise.all([p1, p2])
    // m1 fully completes (paste→settle→CR unit) BEFORE m2 begins — never start:m1,start:m2
    expect(events).toEqual(['start:m1', 'end:m1', 'start:m2', 'end:m2'])
  })

  test('deliveries to DIFFERENT addresses run in parallel', async () => {
    const events: string[] = []
    const seam: WarmDeliverSeam = {
      deliverHosted: async (id, _msg) => {
        events.push(`start:${id}`)
        await sleep(30)
        events.push(`end:${id}`)
        return { ok: true }
      },
    }
    const p1 = deliverWarm(codexT('par-a'), 'x', undefined, seam)
    const p2 = deliverWarm(codexT('par-b'), 'y', undefined, seam)
    await Promise.all([p1, p2])
    // both start before either ends → they overlapped (not serialized across addresses)
    expect(events.slice(0, 2).sort()).toEqual(['start:codex-par-a', 'start:codex-par-b'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Envelope-compaction F — deliverWarm render gating: an AGENT target receives the
// compact presentation, a BRIDGE target receives the WIRE form verbatim.
// ─────────────────────────────────────────────────────────────────────────────

describe('deliverWarm — presentation render gating by target runtime', () => {
  const wire = buildEnvelope({
    fromPersonality: 'boris',
    fromRuntime: 'claude',
    fromIntelligence: 'artificial',
    sentAt: '2026-07-14T01:23:45+03:00',
    message: 'gating probe',
  })
  function captureSeam(): { seam: WarmDeliverSeam; got: () => string } {
    let captured = ''
    const seam: WarmDeliverSeam = {
      deliverHosted: async (_identity, msg) => {
        captured = msg
        return { ok: true }
      },
    }
    return { seam, got: () => captured }
  }

  test('agent target (codex, socket-ack) → compact presentation delivered', async () => {
    const { seam, got } = captureSeam()
    const target: DeliveryTarget = { runtime: 'codex', personality: 'ag', address: 'codex-ag', socketPath: '/tmp/x.sock' }
    const r = await deliverWarm(target, wire, undefined, seam)
    expect(r.ok).toBe(true)
    expect(got()).toContain('<iap from="boris" runtime="claude" intelligence="artificial"')
    expect(got()).toContain('<msg>gating probe</msg>')
    expect(got()).not.toContain('from-personality')
    expect(got()).not.toContain('CDATA')
  })

  test('bridge target (telegram router) → WIRE delivered verbatim (sibling parsers untouched)', async () => {
    const { seam, got } = captureSeam()
    const target: DeliveryTarget = { runtime: 'telegram', personality: 'br', address: 'telegram-br', socketPath: '/tmp/x.sock' }
    const r = await deliverWarm(target, wire, undefined, seam)
    expect(r.ok).toBe(true)
    expect(got()).toBe(wire)
  })
})
