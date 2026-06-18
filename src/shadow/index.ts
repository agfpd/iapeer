// Read-only fidelity OBSERVER for the tmux→pty migration (prod burn-in track).
//
// For each warm claude/codex peer it builds an @xterm/headless model from the daemon's
// EXISTING pipe-pane log (`<identity>.log` under cfg.logDir) — the same raw child bytes
// tmux's emulator gets — and compares the PTY-model verdicts (composer-occupancy / ready-gate
// / liveness) to the live AUTHORITATIVE tmux verdicts, logging divergences + rolling fidelity
// to `<eventLogDir>/shadow-fidelity.{jsonl,json}`.
//
// STRICTLY READ-ONLY: it tails log FILES and runs read-only tmux (`capture-pane`/`display`/
// `has-session`). It NEVER delivers, sends keys, spawns, or touches delivery/lifecycle/
// registry/launch. Nothing in the delivery/lifecycle hot paths imports this module — it runs
// ONLY via the `iapeer shadow` CLI verb (dynamic-imported, so @xterm is never loaded in the
// daemon). With it off, the daemon's behavior is byte-identical. This is the prod burn-in:
// the supervisor's model proven alongside tmux on real traffic BEFORE any delivery cutover.
import { Terminal } from '@xterm/headless'
import { openSync, closeSync, fstatSync, readSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmux, composerCaptureHasHumanInput, listOnlinePeers } from '../transport/index.ts'
import { getAdapter } from '../launch/index.ts'
import { ptyHostEnabled } from '../launch/ptyHost.ts' // spawn-flip Ф0b-3: the observer skips supervisor-hosted peers
import { buildSocketPath, buildProcessAddress } from '../core/socket.ts'
import type { Runtime } from '../core/constants.ts'
import { GateTracker, classifyDirection, evaluateReadyGateFlipEligibility, VERDICTS } from './gate.ts'
// modelToPlainText lives in the leaf render.ts (shared with readyGateModel + the supervisor
// boot-driver); re-exported here so existing importers of './index.ts' keep resolving.
import { composerOccupancyFromModel, modelToPlainText } from './render.ts'
export { composerOccupancyFromModel, modelToPlainText }

const SEED_BYTES = 4 * 1024 * 1024
const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

interface Obs { addr: string; sock: string; runtime: Runtime; cols: number; rows: number; term: Terminal; fd: number; offset: number }

export interface ShadowOptions {
  logDir: string        // daemon pane-logs live here (<identity>.log)
  eventLogDir: string   // shadow-fidelity.{jsonl,json} written here
  sockDir: string
  intervalMs?: number
  maxMinutes?: number   // 0/undefined + once=false → run until <eventLogDir>/shadow-fidelity.STOP
  once?: boolean
  log?: (s: string) => void
}

/** Feed the pane-log delta into the model; resolves with the byte count appended this tick
 *  (drives the coverage state classifier: >0 ⇒ the model is advancing, not idle). */
function feed(o: Obs): Promise<number> {
  const sz = fstatSync(o.fd).size
  if (sz <= o.offset) return Promise.resolve(0)
  const buf = Buffer.alloc(sz - o.offset)
  readSync(o.fd, buf, 0, buf.length, o.offset)
  o.offset = sz
  return new Promise(res => o.term.write(buf, () => res(buf.length)))
}

export function enumerate(models: Map<string, Obs>, opts: ShadowOptions, tracker?: GateTracker): void {
  let peers: { runtime: Runtime; personality: string }[] = []
  try { peers = listOnlinePeers(opts.sockDir).filter(p => p.runtime === 'claude' || p.runtime === 'codex') } catch { return }
  const live = new Set<string>()
  for (const p of peers) {
    const addr = buildProcessAddress(p.runtime, p.personality)
    // SPAWN-FLIP Ф0b-3: NEVER measure a supervisor-HOSTED peer. The observer's premise is pty-model vs
    // LIVE TMUX, so it only compares peers that are actually on tmux. pty-hosting is now the DEFAULT, so
    // ptyHostEnabled is true for a normal peer (hosted → skip) and false only for an explicit `.no-pty-host`
    // opt-OUT peer (tmux → compared). Skip BEFORE `live` — a peer that flips falls out of `live` and is
    // reaped. (Post-migration the whole fleet is pty-default, so this skips everything and the observer is
    // effectively retired until/unless a peer opts back to tmux.)
    if (ptyHostEnabled(opts.logDir, addr)) continue
    live.add(addr)
    if (models.has(addr)) continue
    try {
      const sock = buildSocketPath(p.runtime, p.personality, opts.sockDir)
      const log = join(opts.logDir, `${addr}.log`); if (!existsSync(log)) continue
      const geo = tmux(sock, 'display', '-p', '-t', addr, '#{pane_width}x#{pane_height}'); if (!geo.ok) continue
      const [cols, rows] = geo.out.trim().split('x').map(Number); if (!cols || !rows) continue
      const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 3000 })
      const fd = openSync(log, 'r'); const offset = Math.max(0, fstatSync(fd).size - SEED_BYTES)
      models.set(addr, { addr, sock, runtime: p.runtime, cols, rows, term, fd, offset })
    } catch { /* a peer racing spawn/teardown — skip this round */ }
  }
  for (const [addr, o] of models) if (!live.has(addr)) { try { closeSync(o.fd) } catch { /* */ }; tracker?.peerGone(addr); models.delete(addr) }
}

/** Run the read-only fidelity observer. Resolves when once/maxMinutes/STOP completes. */
export async function runShadowFidelity(opts: ShadowOptions): Promise<void> {
  mkdirSync(opts.eventLogDir, { recursive: true })
  const jsonl = join(opts.eventLogDir, 'shadow-fidelity.jsonl')
  const statsFile = join(opts.eventLogDir, 'shadow-fidelity.json')
  const stopFile = join(opts.eventLogDir, 'shadow-fidelity.STOP')
  const interval = opts.intervalMs ?? 5000
  const log = opts.log ?? (() => { /* */ })
  const models = new Map<string, Obs>()
  const tracker = new GateTracker()
  const startedISO = new Date().toISOString(), t0 = Date.now()
  enumerate(models, opts, tracker)
  for (const o of models.values()) await feed(o)  // seed each model
  log(`shadow-fidelity: ${models.size} warm peers, interval ${interval}ms\n`)
  let i = 0
  for (;;) {
    if (opts.maxMinutes && Date.now() - t0 >= opts.maxMinutes * 60000) break
    if (existsSync(stopFile)) break
    // Re-enroll every ~3 ticks (~15s), not 15 (~75s): a freshly-woken peer must be enrolled
    // and sampled DURING its not-ready phase for a readiness transition (the center cell) to
    // register — a 75s enroll-lag could first-sight it already-ready and miss the transition.
    if (i > 0 && i % 3 === 0) enumerate(models, opts, tracker)
    tracker.tickStart(models.size)
    for (const o of models.values()) {
      try {
        const bytesFed = await feed(o)
        const adapter = getAdapter(o.runtime)
        const capE = tmux(o.sock, 'capture-pane', '-e', '-p', '-t', o.addr); if (!capE.ok) continue
        const occTmux = composerCaptureHasHumanInput(capE.out, adapter.deliveryMarkers)
        const occPty = composerOccupancyFromModel(o.term, o.cols, o.rows, o.runtime)
        const capP = tmux(o.sock, 'capture-pane', '-p', '-t', o.addr)
        const rgTmux = capP.ok ? adapter.isInputReady(capP.out) : null
        const rgPty = adapter.isInputReady(modelToPlainText(o.term, o.cols, o.rows))
        const livTmux = tmux(o.sock, 'has-session', '-t', o.addr).ok
        const ppid = tmux(o.sock, 'display', '-p', '-t', o.addr, '#{pane_pid}')
        const pid = ppid.ok ? Number(ppid.out.trim()) : NaN
        const livPty = Number.isFinite(pid) ? pidAlive(pid) : false
        const hasHistory = o.term.buffer.active.baseY > 0

        // Feed the gate tracker — it scores DIRECTION (behind=hard / ahead=benign-if-boot-self-heal)
        // and accumulates the COVERAGE matrix. The boolean booleans never leave this call.
        tracker.sample(i, {
          peer: o.addr, runtime: o.runtime,
          occupancy: { pty: occPty, tmux: occTmux },
          readyGate: { pty: rgPty, tmux: rgTmux },
          liveness: { pty: livPty, tmux: livTmux },
          bytesFed, hasHistory,
        })

        // DIRECTION-AWARE per-event divergence trail (gate scoring lives in the tracker; this is
        // the forensic log). Occupancy carries the raw capture + model frames for root-cause.
        const occDir = classifyDirection(occPty, occTmux)
        const rgDir = rgTmux === null ? 'agree' : classifyDirection(rgPty, rgTmux)
        const livDir = classifyDirection(livPty, livTmux)
        if (occDir !== 'agree' || rgDir !== 'agree' || livDir !== 'agree') {
          appendFileSync(jsonl, JSON.stringify({
            ts: new Date().toISOString(), peer: o.addr, geom: `${o.cols}x${o.rows}`, hasHistory,
            occupancy: { pty: occPty, tmux: occTmux, dir: occDir },
            readyGate: { pty: rgPty, tmux: rgTmux, dir: rgDir },
            liveness: { pty: livPty, tmux: livTmux, dir: livDir },
            ...(occDir !== 'agree' ? { capE: capE.out.slice(-2500), model: modelToPlainText(o.term, o.cols, o.rows).slice(-2500) } : {}),
          }) + '\n')
          log(`DIVERGE ${o.addr} occ=${occDir} rg=${rgDir} liv=${livDir}\n`)
        }
      } catch { /* an observer error must NEVER escape — it is a passive sidecar */ }
    }
    i++
    const gs = tracker.summary()
    const totalSamples = VERDICTS.reduce((n, v) => n + gs.verdicts[v].samples, 0)
    writeFileSync(statsFile, JSON.stringify({
      startedISO, lastISO: new Date().toISOString(), elapsedMin: +((Date.now() - t0) / 60000).toFixed(1),
      peers: models.size, samples: totalSamples,
      // Gate criterion: clean iff zero hard divergences across all verdicts. Hard =
      // every pty-behind + non-benign pty-ahead (steady-state or non-converging). Benign =
      // boot-window ahead that self-heals within budget. Coverage proves the matrix was traversed.
      gateClean: VERDICTS.every(v => gs.verdicts[v].gateClean),
      hardTotal: gs.hardViolations.length,
      // Ready-gate FLIP eligibility (first-flip verdict) self-reported: NECESSARY input, not an
      // auto-trigger — the flip stays an explicit decision. On !eligible, `reasons` say which cell
      // is empty/dirty (actionable). composer-busy is excluded (orthogonal — gates the later occupancy flip).
      readyGateFlip: evaluateReadyGateFlipEligibility(gs),
      verdicts: gs.verdicts,
      coverage: gs.coverage,
      recentHard: gs.hardViolations.slice(-20),
    }, null, 2))
    if (opts.once) break
    await new Promise(r => setTimeout(r, interval))
  }
  for (const o of models.values()) { try { closeSync(o.fd) } catch { /* */ } }
}
