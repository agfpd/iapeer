// Gate-grade instrumentation for the tmux→pty fidelity burn-in (cutover Block 1).
//
// PURE classifiers + one stateful tracker, with NO tmux and NO @xterm import — the observer
// loop feeds it booleans, so all classification is hermetically unit-testable. The synthetic
// acceptance: PROVE the instrument classifies known-behind vs known-ahead and records coverage
// correctly BEFORE we trust any pty verdict for a flip.
//
// It operationalizes the adjudicated gate criterion (NOT a flat sample count):
//   • DIRECTION — pty-BEHIND (pty=False,tmux=True: a stale frame while live tmux moved on) is
//     the reattach-stale class → ZERO tolerance, always hard. pty-AHEAD (pty=True,tmux=False)
//     is benign ONLY when it (a) opened in the boot window, (b) self-heals within the converge
//     budget, and (c) is not steady-state. Anything else → hard. For READY-GATE a non-converging
//     ahead is a FALSE-ready (early-delivery → msg-loss class), so it is hard, never benign.
//   • COVERAGE — which matrix cells the burn-in actually traversed {runtime × {idle,
//     model-advancing, composer-busy}} + births (fresh vs wake-resume-with-history) + restarts +
//     history-bearing samples + fleet width. "Clean" counts only over traversed cells (idle
//     alone is a false green).

export type Verdict = 'occupancy' | 'readyGate' | 'liveness'
export const VERDICTS: Verdict[] = ['occupancy', 'readyGate', 'liveness']

export type Direction = 'agree' | 'pty-behind' | 'pty-ahead'

/**
 * Direction of a (pty, tmux) verdict pair. tmux is AUTHORITATIVE; `true` is the
 * active/ready/alive pole. pty UNDER-reporting it (pty=false, tmux=true) is BEHIND — the
 * stale-frame class (zero tolerance). pty OVER-reporting (pty=true, tmux=false) is AHEAD.
 */
export function classifyDirection(ptyVal: boolean, tmuxVal: boolean): Direction {
  if (ptyVal === tmuxVal) return 'agree'
  return tmuxVal ? 'pty-behind' : 'pty-ahead'
}

export type SampleState = 'idle' | 'model-advancing' | 'composer-busy'

/**
 * Per-sample fleet state for the coverage matrix. composer-busy when tmux (authoritative) sees
 * human occupancy; else model-advancing when output churned this tick (the model is actively
 * rendering — the NON-trivial fidelity regime, not at rest); else idle. The split is what keeps
 * an idle burn-in from reading as a false green.
 */
export function classifySampleState(occTmux: boolean, bytesFedThisTick: number): SampleState {
  if (occTmux) return 'composer-busy'
  if (bytesFedThisTick > 0) return 'model-advancing'
  return 'idle'
}

export interface VerdictSample {
  /** null when the tmux side was unavailable this tick (capture failed) — skipped, not scored. */
  pty: boolean
  tmux: boolean | null
}

export interface PeerSample {
  peer: string
  runtime: string
  occupancy: VerdictSample
  readyGate: VerdictSample
  liveness: VerdictSample
  /** Bytes appended to this peer's pane-log since the previous tick (drives state coverage). */
  bytesFed: number
  /** The model already carries scrollback (transcript taller than the pane) — a history-bearing
   *  peer; at first sight this means it woke WITH resume-history (vs a fresh empty birth). */
  hasHistory: boolean
}

export interface GateConfig {
  /** Consecutive tmux-ready ticks after which a peer is considered booted (out of the boot
   *  window). Default 3. */
  settleTicks?: number
  /** Max ticks an ahead-transient may stay open and still count as a benign self-heal.
   *  Default 3. */
  convergeBudgetTicks?: number
}

export interface HardViolation {
  peer: string
  runtime: string
  verdict: Verdict
  tick: number
  kind: 'behind' | 'ahead-steady' | 'ahead-nonconverged'
  detail?: string
}

interface OpenAhead {
  startTick: number
  bootWindow: boolean
  flaggedNonConverged: boolean
}

interface PeerState {
  runtime: string
  firstTick: number
  readyStreak: number
  bootDone: boolean
  /** History present at first sight ⇒ this peer woke WITH resume-history (vs a fresh empty birth)
   *  — the population the center cell (codex×wake-resume×history) is measured on. */
  bornWithHistory: boolean
  /** This peer reappeared after we saw it die (it was in goneOnce) — a gone→back resume/restart,
   *  NOT a warm-continuous peer. The center cell's warm-exclusion discriminator. */
  wasGoneReenroll: boolean
  /** The center cell is evaluated exactly ONCE per life (first ready sample) — dedup guard. */
  centerEvaluated: boolean
  /** Previous tmux ready value, to annotate whether the not-ready→ready window was observed. */
  prevReadyTmux: boolean | null
  open: Record<Verdict, OpenAhead | null>
}

interface VerdictTally {
  samples: number
  agree: number
  behind: number
  aheadBenign: number
  aheadHard: number
  aheadLatencies: number[]
}

export class GateTracker {
  private readonly settleTicks: number
  private readonly budget: number
  private peers = new Map<string, PeerState>()
  private goneOnce = new Set<string>()
  private tally: Record<Verdict, VerdictTally>
  private hard: HardViolation[] = []
  // coverage
  private fleetWidthMax = 0
  private stateCells = new Map<string, number>() // `${runtime}/${state}` → count
  private births = new Map<string, number>() // `${runtime}/${fresh|wake-resume}` → count
  private restarts = new Map<string, number>() // runtime → count
  private historySamples = new Map<string, number>() // runtime → count
  // CENTER cell (robust, first-sight): a gone→back-with-history peer whose readiness the MODEL
  // matches tmux on at its first ready sample — the codex splash-off-screen case the ready-gate flip
  // exists for. A model MISS there lands in readyGate.behind (dirty). PRIMARY eligibility counter.
  private readyResumeCaught = new Map<string, number>() // runtime → count
  // Diagnostic ONLY (not a threshold path): the subset of center hits where the not-ready→ready
  // window was actually observed (prev===false) — "we caught the window", a stronger evidence note.
  private readyResumeCaughtViaTransition = new Map<string, number>() // runtime → count
  private runtimesSeen = new Set<string>()

  constructor(cfg: GateConfig = {}) {
    this.settleTicks = cfg.settleTicks ?? 3
    this.budget = cfg.convergeBudgetTicks ?? 3
    const mk = (): VerdictTally => ({ samples: 0, agree: 0, behind: 0, aheadBenign: 0, aheadHard: 0, aheadLatencies: [] })
    this.tally = { occupancy: mk(), readyGate: mk(), liveness: mk() }
  }

  /** Once per tick, before the per-peer samples — records the concurrent fleet width. */
  tickStart(nPeers: number): void {
    if (nPeers > this.fleetWidthMax) this.fleetWidthMax = nPeers
  }

  /** The observer dropped a peer (session gone) — a later reappearance is a restart. */
  peerGone(addr: string): void {
    if (this.peers.delete(addr)) this.goneOnce.add(addr)
  }

  private inc(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1)
  }

  /** Record one peer's sample at `tick`. Updates boot state, classifies every verdict's
   *  direction, manages ahead-transients, and accumulates the coverage matrix. */
  sample(tick: number, s: PeerSample): void {
    this.runtimesSeen.add(s.runtime)
    let ps = this.peers.get(s.peer)
    if (!ps) {
      // First sight this lifetime → a birth. A peer we saw DIE before (in goneOnce) reappearing is
      // a gone→back cycle (a resume/restart, NOT a warm-continuous peer) — the discriminator the
      // robust center cell keys on.
      const birthType = s.hasHistory ? 'wake-resume' : 'fresh'
      this.inc(this.births, `${s.runtime}/${birthType}`)
      const reenrolled = this.goneOnce.has(s.peer)
      if (reenrolled) {
        this.inc(this.restarts, s.runtime)
        this.goneOnce.delete(s.peer)
      }
      ps = {
        runtime: s.runtime,
        firstTick: tick,
        readyStreak: 0,
        bootDone: false,
        bornWithHistory: s.hasHistory,
        wasGoneReenroll: reenrolled,
        centerEvaluated: false,
        prevReadyTmux: null,
        open: { occupancy: null, readyGate: null, liveness: null },
      }
      this.peers.set(s.peer, ps)
    }

    // Boot-window: a peer is booted once tmux-ready has held true for settleTicks in a row.
    if (s.readyGate.tmux === true) {
      ps.readyStreak++
      if (ps.readyStreak >= this.settleTicks) ps.bootDone = true
    } else if (s.readyGate.tmux === false) {
      ps.readyStreak = 0
    }
    const bootWindow = !ps.bootDone

    // CENTER cell — cadence-ROBUST (first-sight, the SAME invariant births/restarts use), so a fast
    // resume can't slip through a transition-polling gap. Counted ONCE per life (dedup: one resume =
    // one center++) at the FIRST ready sample of a peer that (a) is a gone→back re-enroll (resume/
    // restart, NOT warm-continuous — the warm-exclusion discriminator: a warm peer never entered
    // goneOnce; also stricter than a transition, which a fresh peer's first boot would trip) and
    // (b) re-enrolled WITH history (a resume-with-history). Parity there (rgPty===rgTmux===true) on a
    // splash-off-screen frame validates the source swap; a model MISS is a pty-behind (the splash-blind
    // bug) → readyGate.behind → dirty → ineligible. The observed not-ready→ready transition is kept as a
    // DIAGNOSTIC annotation only ("we caught the window" — stronger evidence), NOT a second path to threshold.
    if (s.readyGate.tmux !== null) {
      if (ps.wasGoneReenroll && ps.bornWithHistory && !ps.centerEvaluated && s.readyGate.tmux === true) {
        ps.centerEvaluated = true // evaluate exactly once, at the first ready sample
        if (s.readyGate.pty === true) {
          this.inc(this.readyResumeCaught, s.runtime)
          if (ps.prevReadyTmux === false) this.inc(this.readyResumeCaughtViaTransition, s.runtime) // diagnostic: window caught
        }
      }
      ps.prevReadyTmux = s.readyGate.tmux
    }

    // Coverage.
    const state = classifySampleState(s.occupancy.tmux === true, s.bytesFed)
    this.inc(this.stateCells, `${s.runtime}/${state}`)
    if (s.hasHistory) this.inc(this.historySamples, s.runtime)

    // Per-verdict direction + transient bookkeeping.
    this.scoreVerdict('occupancy', tick, ps, bootWindow, s.runtime, s.peer, s.occupancy)
    this.scoreVerdict('readyGate', tick, ps, bootWindow, s.runtime, s.peer, s.readyGate)
    this.scoreVerdict('liveness', tick, ps, bootWindow, s.runtime, s.peer, s.liveness)
  }

  private scoreVerdict(
    verdict: Verdict,
    tick: number,
    ps: PeerState,
    bootWindow: boolean,
    runtime: string,
    peer: string,
    vs: VerdictSample,
  ): void {
    if (vs.tmux === null) return // tmux side unavailable → not scored
    const t = this.tally[verdict]
    t.samples++
    const dir = classifyDirection(vs.pty, vs.tmux)

    // An open ahead-transient that exceeds the converge budget is a hard violation the moment
    // it overruns (logged once), regardless of how it later resolves.
    const open = ps.open[verdict]
    if (open && !open.flaggedNonConverged && tick - open.startTick > this.budget) {
      open.flaggedNonConverged = true
      t.aheadHard++
      this.hard.push({ peer, runtime, verdict, tick, kind: 'ahead-nonconverged', detail: `ahead open ${tick - open.startTick} ticks > budget ${this.budget}` })
    }

    if (dir === 'agree') {
      t.agree++
      if (open) {
        // transient closed → measure self-heal latency; benign iff it opened in the boot
        // window AND healed within budget (and was not already flagged non-converged).
        const latency = tick - open.startTick
        t.aheadLatencies.push(latency)
        if (!open.flaggedNonConverged) {
          if (open.bootWindow && latency <= this.budget) t.aheadBenign++
          else {
            t.aheadHard++
            this.hard.push({ peer, runtime, verdict, tick, kind: open.bootWindow ? 'ahead-nonconverged' : 'ahead-steady', detail: `latency ${latency}, boot=${open.bootWindow}` })
          }
        }
        ps.open[verdict] = null
      }
      return
    }

    if (dir === 'pty-behind') {
      // The stale-frame class — always hard, zero tolerance. A behind also closes any open
      // ahead-transient as an abnormal resolution (not a benign heal).
      t.behind++
      this.hard.push({ peer, runtime, verdict, tick, kind: 'behind' })
      ps.open[verdict] = null
      return
    }

    // pty-ahead: open a transient if none is open. Steady-state ahead is hard immediately
    // (it cannot be a boot self-heal); boot-window ahead waits to see if it converges.
    if (!open) {
      if (!bootWindow) {
        t.aheadHard++
        this.hard.push({ peer, runtime, verdict, tick, kind: 'ahead-steady' })
        // still open it so we can measure when it clears, but it is already counted hard
        ps.open[verdict] = { startTick: tick, bootWindow: false, flaggedNonConverged: true }
      } else {
        ps.open[verdict] = { startTick: tick, bootWindow: true, flaggedNonConverged: false }
      }
    }
  }

  /** True iff no hard divergence has been recorded for `verdict` (the per-verdict gate bar). */
  verdictGateClean(verdict: Verdict): boolean {
    const t = this.tally[verdict]
    return t.behind === 0 && t.aheadHard === 0
  }

  summary(): GateSummary {
    const latStats = (xs: number[]): { count: number; max: number; mean: number } =>
      xs.length ? { count: xs.length, max: Math.max(...xs), mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) } : { count: 0, max: 0, mean: 0 }
    const verdicts = {} as Record<Verdict, VerdictGateStat>
    for (const v of VERDICTS) {
      const t = this.tally[v]
      verdicts[v] = {
        samples: t.samples,
        agree: t.agree,
        behind: t.behind,
        aheadBenign: t.aheadBenign,
        aheadHard: t.aheadHard,
        selfHeal: latStats(t.aheadLatencies),
        gateClean: this.verdictGateClean(v),
      }
    }
    return {
      verdicts,
      hardViolations: this.hard.slice(),
      coverage: {
        fleetWidthMax: this.fleetWidthMax,
        runtimes: [...this.runtimesSeen].sort(),
        byRuntimeState: Object.fromEntries([...this.stateCells].sort()),
        births: Object.fromEntries([...this.births].sort()),
        restarts: Object.fromEntries([...this.restarts].sort()),
        historySamples: Object.fromEntries([...this.historySamples].sort()),
        readyResumeCaught: Object.fromEntries([...this.readyResumeCaught].sort()),
        readyResumeCaughtViaTransition: Object.fromEntries([...this.readyResumeCaughtViaTransition].sort()),
      },
    }
  }
}

/** Ready-gate FLIP eligibility — the verdict-scoped gate, operationalized so the burn-in
 *  SELF-REPORTS instead of being eyeballed. NECESSARY input, NOT an auto-trigger: the flip stays
 *  an explicit human decision (the representativeness of the filled cells — e.g. the splash truly
 *  scrolled off-screen — is verified separately on top of this). Eligible iff:
 *    • ready-gate is HARD-clean (behind=0 ∧ aheadHard=0), AND
 *    • the CENTER cell is filled: codex woke WITH history and the model caught its readiness, AND
 *    • a codex AND a claude birth were observed, AND
 *    • a restart was observed.
 *  composer-busy is ORTHOGONAL to readiness (a typing human already passed readiness) → excluded;
 *  it gates the LATER occupancy flip. On !eligible `reasons` say WHICH cell is empty/dirty —
 *  actionable, never a black-box "not yet". PURE → its own logic is unit-testable. */
export function evaluateReadyGateFlipEligibility(s: GateSummary): FlipEligibility {
  const reasons: string[] = []
  const rg = s.verdicts.readyGate
  if (rg.behind > 0 || rg.aheadHard > 0) reasons.push(`readyGate dirty: behind=${rg.behind} aheadHard=${rg.aheadHard}`)
  const center = s.coverage.readyResumeCaught['codex'] ?? 0
  if (center < 1) reasons.push(`center codex×wake-resume×history: ${center} readiness caught (need ≥1, representatively splash-off-screen)`)
  const hasBirth = (rt: string): boolean => Object.keys(s.coverage.births).some(k => k.startsWith(`${rt}/`))
  if (!hasBirth('codex')) reasons.push('no codex birth observed')
  if (!hasBirth('claude')) reasons.push('no claude birth observed')
  const restarts = Object.values(s.coverage.restarts).reduce((a, b) => a + b, 0)
  if (restarts < 1) reasons.push('no restart observed')
  return { verdict: 'readyGate', eligible: reasons.length === 0, reasons }
}

export interface VerdictGateStat {
  samples: number
  agree: number
  behind: number
  aheadBenign: number
  aheadHard: number
  selfHeal: { count: number; max: number; mean: number }
  gateClean: boolean
}

export interface GateCoverage {
  fleetWidthMax: number
  runtimes: string[]
  byRuntimeState: Record<string, number>
  births: Record<string, number>
  restarts: Record<string, number>
  historySamples: Record<string, number>
  /** runtime → center-cell count: gone→back-with-history peers whose first-ready model verdict
   *  matched tmux (robust, first-sight). The PRIMARY ready-gate-flip eligibility signal. */
  readyResumeCaught: Record<string, number>
  /** runtime → DIAGNOSTIC subset of readyResumeCaught where the not-ready→ready window was observed
   *  (transition caught). Stronger evidence; NOT a separate threshold path. */
  readyResumeCaughtViaTransition: Record<string, number>
}

export interface GateSummary {
  verdicts: Record<Verdict, VerdictGateStat>
  hardViolations: HardViolation[]
  coverage: GateCoverage
}

export interface FlipEligibility {
  verdict: 'readyGate'
  eligible: boolean
  /** On !eligible: one actionable line per unmet requirement (which cell is empty/dirty). */
  reasons: string[]
}
