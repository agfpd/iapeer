import { describe, expect, test } from 'bun:test'
import {
  GateTracker,
  classifyDirection,
  classifySampleState,
  evaluateReadyGateFlipEligibility,
  type GateSummary,
  type PeerSample,
  type VerdictGateStat,
} from './gate.ts'

// SYNTHETIC ACCEPTANCE (boris's Block-1 gate): prove the instrument classifies known-behind vs
// known-ahead and records coverage CORRECTLY — the live proof that it measures right before we
// trust any pty verdict for a flip. Pure: no tmux, no @xterm, booleans in, gate stats out.

const mkSample = (peer: string, runtime: string, over: Partial<PeerSample> = {}): PeerSample => ({
  peer,
  runtime,
  occupancy: { pty: false, tmux: false },
  readyGate: { pty: false, tmux: false },
  liveness: { pty: true, tmux: true },
  bytesFed: 0,
  hasHistory: false,
  ...over,
})

describe('classifyDirection (tmux authoritative; true = active/ready/alive pole)', () => {
  test('equal → agree', () => {
    expect(classifyDirection(true, true)).toBe('agree')
    expect(classifyDirection(false, false)).toBe('agree')
  })
  test('pty under-reports (false vs true) → pty-behind (the stale class)', () => {
    expect(classifyDirection(false, true)).toBe('pty-behind')
  })
  test('pty over-reports (true vs false) → pty-ahead', () => {
    expect(classifyDirection(true, false)).toBe('pty-ahead')
  })
})

describe('classifySampleState (coverage regimes — idle must be distinguishable, false-green lesson)', () => {
  test('tmux occupancy → composer-busy (regardless of bytes)', () => {
    expect(classifySampleState(true, 0)).toBe('composer-busy')
    expect(classifySampleState(true, 999)).toBe('composer-busy')
  })
  test('no occupancy + output churn → model-advancing (non-trivial regime)', () => {
    expect(classifySampleState(false, 4096)).toBe('model-advancing')
  })
  test('no occupancy + no churn → idle', () => {
    expect(classifySampleState(false, 0)).toBe('idle')
  })
})

describe('GateTracker — direction is scored hard vs benign per the adjudicated criterion', () => {
  test('pty-BEHIND is ALWAYS hard (zero tolerance) and closes the verdict gate', () => {
    const g = new GateTracker()
    g.sample(0, mkSample('p', 'claude', { occupancy: { pty: false, tmux: true } }))
    const s = g.summary()
    expect(s.verdicts.occupancy.behind).toBe(1)
    expect(s.verdicts.occupancy.gateClean).toBe(false)
    expect(s.hardViolations.some(v => v.kind === 'behind' && v.verdict === 'occupancy')).toBe(true)
  })

  test('boot-window pty-AHEAD that self-heals within budget → BENIGN (latency recorded)', () => {
    const g = new GateTracker({ settleTicks: 3, convergeBudgetTicks: 3 })
    // tick0: readyGate ahead (pty ready, tmux not) — peer just born → boot window
    g.sample(0, mkSample('p', 'claude', { readyGate: { pty: true, tmux: false } }))
    // tick1: readyGate agrees (both ready) → transient closes, latency 1, boot+within budget → benign
    g.sample(1, mkSample('p', 'claude', { readyGate: { pty: true, tmux: true } }))
    const rg = g.summary().verdicts.readyGate
    expect(rg.aheadBenign).toBe(1)
    expect(rg.aheadHard).toBe(0)
    expect(rg.gateClean).toBe(true)
    expect(rg.selfHeal.count).toBe(1)
    expect(rg.selfHeal.max).toBe(1)
  })

  test('READY-GATE non-converging pty-AHEAD is HARD, never benign (refinement #3: false-ready = msg-loss)', () => {
    const g = new GateTracker({ settleTicks: 3, convergeBudgetTicks: 3 })
    // hold readyGate ahead (pty ready, tmux NEVER ready → stays in boot window, never converges)
    for (let t = 0; t <= 5; t++) g.sample(t, mkSample('p', 'codex', { readyGate: { pty: true, tmux: false } }))
    const rg = g.summary().verdicts.readyGate
    expect(rg.aheadHard).toBeGreaterThanOrEqual(1)
    expect(rg.aheadBenign).toBe(0)
    expect(rg.gateClean).toBe(false)
    expect(g.summary().hardViolations.some(v => v.kind === 'ahead-nonconverged' && v.verdict === 'readyGate')).toBe(true)
  })

  test('STEADY-STATE pty-AHEAD is HARD immediately (cannot be a boot self-heal)', () => {
    const g = new GateTracker({ settleTicks: 2, convergeBudgetTicks: 3 })
    // boot the peer: readyGate true for settleTicks
    g.sample(0, mkSample('p', 'claude', { readyGate: { pty: true, tmux: true } }))
    g.sample(1, mkSample('p', 'claude', { readyGate: { pty: true, tmux: true } })) // bootDone now
    // steady-state occupancy ahead → hard 'ahead-steady'
    g.sample(2, mkSample('p', 'claude', { readyGate: { pty: true, tmux: true }, occupancy: { pty: true, tmux: false } }))
    const occ = g.summary().verdicts.occupancy
    expect(occ.aheadHard).toBeGreaterThanOrEqual(1)
    expect(g.summary().hardViolations.some(v => v.kind === 'ahead-steady' && v.verdict === 'occupancy')).toBe(true)
  })

  test('full agreement → clean gate, zero hard violations', () => {
    const g = new GateTracker()
    for (let t = 0; t < 5; t++) g.sample(t, mkSample('p', 'claude', { readyGate: { pty: true, tmux: true } }))
    const s = g.summary()
    expect(s.hardViolations).toHaveLength(0)
    expect(s.verdicts.readyGate.gateClean).toBe(true)
    expect(s.verdicts.occupancy.gateClean).toBe(true)
    expect(s.verdicts.liveness.gateClean).toBe(true)
  })
})

describe('GateTracker — coverage matrix (clean counts only over traversed cells)', () => {
  test('births split fresh vs wake-resume by history-at-first-sight', () => {
    const g = new GateTracker()
    g.tickStart(1)
    g.sample(0, mkSample('fresh-peer', 'claude', { hasHistory: false }))
    g.tickStart(2)
    g.sample(1, mkSample('woke-peer', 'codex', { hasHistory: true })) // history at first sight = wake-resume
    const cov = g.summary().coverage
    expect(cov.births['claude/fresh']).toBe(1)
    expect(cov.births['codex/wake-resume']).toBe(1)
  })

  test('a peer that died and reappeared is a restart', () => {
    const g = new GateTracker()
    g.sample(0, mkSample('p', 'claude'))
    g.peerGone('p')
    g.sample(5, mkSample('p', 'claude'))
    expect(g.summary().coverage.restarts['claude']).toBe(1)
  })

  test('state cells, fleet width, and history samples are recorded', () => {
    const g = new GateTracker()
    g.tickStart(3) // fleet width 3 this tick
    g.sample(0, mkSample('p', 'claude', { occupancy: { pty: true, tmux: true } })) // composer-busy
    g.sample(1, mkSample('p', 'claude', { bytesFed: 4096 })) // model-advancing
    g.sample(2, mkSample('p', 'claude', { bytesFed: 0 })) // idle
    g.sample(3, mkSample('h', 'codex', { hasHistory: true }))
    const cov = g.summary().coverage
    expect(cov.fleetWidthMax).toBe(3)
    expect(cov.byRuntimeState['claude/composer-busy']).toBe(1)
    expect(cov.byRuntimeState['claude/model-advancing']).toBe(1)
    expect(cov.byRuntimeState['claude/idle']).toBe(1)
    expect(cov.historySamples['codex']).toBe(1)
    expect(cov.runtimes).toEqual(['claude', 'codex'])
  })
})

describe('GateTracker — robust center cell (gone→back + history + first-ready parity; cadence-proof)', () => {
  // Drive a peer through a gone→back cycle: birth (not-ready), then die. The caller's next sample
  // is the re-enroll (a resume/restart), where the center is evaluated at the first ready sample.
  const goneBack = (g: GateTracker, peer: string, rt: string): void => {
    g.sample(0, mkSample(peer, rt, { hasHistory: true, readyGate: { pty: false, tmux: false } }))
    g.peerGone(peer)
  }

  test('warm-continuous peer (never gone→back) → NOT counted, even ready-with-history (warm-exclusion)', () => {
    const g = new GateTracker()
    g.sample(0, mkSample('w', 'codex', { hasHistory: true, readyGate: { pty: false, tmux: false } }))
    g.sample(1, mkSample('w', 'codex', { hasHistory: true, readyGate: { pty: true, tmux: true } }))
    expect(g.summary().coverage.readyResumeCaught['codex']).toBeUndefined()
  })

  test('gone→back + history + first-ready parity → counted (robust, even first-sight-already-ready)', () => {
    const g = new GateTracker()
    goneBack(g, 'c', 'codex')
    g.sample(1, mkSample('c', 'codex', { hasHistory: true, readyGate: { pty: true, tmux: true } })) // re-enroll already-ready (fast resume)
    const cov = g.summary().coverage
    expect(cov.readyResumeCaught['codex']).toBe(1)
    expect(cov.readyResumeCaughtViaTransition['codex']).toBeUndefined() // window not observed (fast) — still counted
  })

  test('gone→back WITHOUT history → NOT counted (a fresh restart, not a resume-with-history)', () => {
    const g = new GateTracker()
    g.sample(0, mkSample('c', 'codex', { hasHistory: false, readyGate: { pty: false, tmux: false } }))
    g.peerGone('c')
    g.sample(1, mkSample('c', 'codex', { hasHistory: false, readyGate: { pty: true, tmux: true } }))
    expect(g.summary().coverage.readyResumeCaught['codex']).toBeUndefined()
  })

  test('gone→back + history + DIVERGENCE at first ready (model missed) → NOT counted + dirty (behind)', () => {
    const g = new GateTracker()
    goneBack(g, 'c', 'codex')
    g.sample(1, mkSample('c', 'codex', { hasHistory: true, readyGate: { pty: false, tmux: true } })) // tmux ready, model NOT
    const s = g.summary()
    expect(s.coverage.readyResumeCaught['codex']).toBeUndefined()
    expect(s.verdicts.readyGate.behind).toBeGreaterThanOrEqual(1) // the splash-blind bug → dirty → ineligible
  })

  test('counted exactly ONCE per life (dedup: one resume = one center++)', () => {
    const g = new GateTracker()
    goneBack(g, 'c', 'codex')
    for (let t = 1; t <= 4; t++) g.sample(t, mkSample('c', 'codex', { hasHistory: true, readyGate: { pty: true, tmux: true } }))
    expect(g.summary().coverage.readyResumeCaught['codex']).toBe(1)
  })

  test('observed not-ready→ready window → counted AND flagged caughtViaTransition (diagnostic only)', () => {
    const g = new GateTracker()
    goneBack(g, 'c', 'codex')
    g.sample(1, mkSample('c', 'codex', { hasHistory: true, readyGate: { pty: false, tmux: false } })) // re-enroll not-ready
    g.sample(2, mkSample('c', 'codex', { hasHistory: true, readyGate: { pty: true, tmux: true } })) // becomes ready
    const cov = g.summary().coverage
    expect(cov.readyResumeCaught['codex']).toBe(1)
    expect(cov.readyResumeCaughtViaTransition['codex']).toBe(1) // window was observed
  })
})

describe('evaluateReadyGateFlipEligibility (boris guardrail: the eligibility logic itself under test)', () => {
  const stat = (over: Partial<VerdictGateStat> = {}): VerdictGateStat => ({
    samples: 10,
    agree: 10,
    behind: 0,
    aheadBenign: 0,
    aheadHard: 0,
    selfHeal: { count: 0, max: 0, mean: 0 },
    gateClean: true,
    ...over,
  })
  const mkSummary = (over: {
    rgBehind?: number
    rgAheadHard?: number
    center?: Record<string, number>
    births?: Record<string, number>
    restarts?: Record<string, number>
  } = {}): GateSummary => ({
    verdicts: {
      occupancy: stat(),
      readyGate: stat({ behind: over.rgBehind ?? 0, aheadHard: over.rgAheadHard ?? 0 }),
      liveness: stat(),
    },
    hardViolations: [],
    coverage: {
      fleetWidthMax: 2,
      runtimes: ['claude', 'codex'],
      byRuntimeState: {},
      births: over.births ?? {},
      restarts: over.restarts ?? {},
      historySamples: {},
      readyResumeCaught: over.center ?? {},
      readyResumeCaughtViaTransition: {},
    },
  })
  const COMPLETE = {
    center: { codex: 1 },
    births: { 'claude/fresh': 1, 'codex/wake-resume': 1 },
    restarts: { codex: 1 },
  }

  test('incomplete (empty) → NOT eligible, reasons name every missing cell (actionable)', () => {
    const e = evaluateReadyGateFlipEligibility(mkSummary())
    expect(e.eligible).toBe(false)
    expect(e.reasons.some(r => /center codex×wake-resume×history/.test(r))).toBe(true)
    expect(e.reasons.some(r => /no codex birth/.test(r))).toBe(true)
    expect(e.reasons.some(r => /no claude birth/.test(r))).toBe(true)
    expect(e.reasons.some(r => /no restart/.test(r))).toBe(true)
  })

  test('complete + clean → eligible', () => {
    const e = evaluateReadyGateFlipEligibility(mkSummary(COMPLETE))
    expect(e.eligible).toBe(true)
    expect(e.reasons).toHaveLength(0)
  })

  test('complete BUT dirty (readyGate behind) → NOT eligible, reason names the dirt', () => {
    const e = evaluateReadyGateFlipEligibility(mkSummary({ ...COMPLETE, rgBehind: 2 }))
    expect(e.eligible).toBe(false)
    expect(e.reasons.some(r => /readyGate dirty: behind=2/.test(r))).toBe(true)
  })

  test('complete except the CENTER cell empty → NOT eligible, center reason only', () => {
    const e = evaluateReadyGateFlipEligibility(mkSummary({ ...COMPLETE, center: {} }))
    expect(e.eligible).toBe(false)
    expect(e.reasons).toHaveLength(1)
    expect(e.reasons[0]).toMatch(/center codex×wake-resume×history: 0/)
  })

  test('complete except no restart → NOT eligible, restart reason only', () => {
    const e = evaluateReadyGateFlipEligibility(mkSummary({ ...COMPLETE, restarts: {} }))
    expect(e.eligible).toBe(false)
    expect(e.reasons).toEqual(['no restart observed'])
  })

  test('composer-busy is ORTHOGONAL — its absence never blocks ready-gate eligibility', () => {
    // COMPLETE carries no composer-busy state anywhere; eligibility must still be true.
    expect(evaluateReadyGateFlipEligibility(mkSummary(COMPLETE)).eligible).toBe(true)
  })
})
