// Ф1 READY-GATE viewport-source FLIP (cutover Block 3) — DARK / flag-gated, canary-first.
//
// The cold-wake ready-gate (launch index.ts step 6) decides "is the input surface ready?" by
// running adapter.isInputReady on a VIEWPORT. Today that viewport is a `tmux capture-pane` scrape.
// This is the FIRST migration mutation: swap the viewport SOURCE to the pty-MODEL (an @xterm/headless
// emulation of the daemon's pane-log — the SAME raw child bytes tmux renders), keeping the SAME
// production predicate (adapter.isInputReady) and an UNCONDITIONAL capture-pane fallback.
//
// Why this is low-radius: it is a viewport-SOURCE swap, NOT a predicate change.
// The model verdict was validated 0-divergence vs capture-pane on the readiness predicate by the
// burn-in gate (incl. the codex resume-with-history splash-off-screen center cell) before any peer
// is flipped. It touches ONLY the isInputReady INPUT — dialog detection upstream and the delivery +
// delivery-confirm downstream (submitIntoTui's submit-landed + deliverViaTmux's transcript-mtime
// advance, the "real model advancement" final-arbiter) are untouched, so the canonical
// harmless-false-glyph property is preserved by construction.
//
// FLAG: a per-peer marker `<logDir>/<identity>.pty-readygate`. Absent → capture-pane (byte-identical
// to today). Present → the model viewport. Per-peer so the first flip is a single canary with the
// whole fleet still on tmux; dynamic (touch/rm, no daemon restart). @xterm is dynamic-imported ONLY
// when the flag is set, so the launch hot path stays @xterm-free with the flip off.

import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import type { Terminal } from '@xterm/headless' // TYPE-ONLY (erased) — the runtime @xterm load is the dynamic import below

const SEED_BYTES = 4 * 1024 * 1024

/**
 * SERVING-path cross-check log (the post-flip soak gate). When a peer is flipped, the MODEL verdict
 * is AUTHORITATIVE in the cold-wake ready-gate; this records, per evaluation, what capture-pane WOULD
 * have said — so a soak can prove 0 model-vs-capture divergence IN THE SERVING PATH (the read-only
 * burn-in measures continuously but never drove the actual ready decision). Append-only jsonl under
 * the event-log dir. Best-effort: a log hiccup never affects the ready decision. No-op without a dir.
 */
export function logReadyGateCrossCheck(
  eventLogDir: string | undefined,
  rec: { identity: string; modelReady: boolean; captureReady: boolean; geom: string; nowISO: string },
): void {
  if (!eventLogDir) return
  try {
    appendFileSync(
      join(eventLogDir, 'readygate-flip.jsonl'),
      JSON.stringify({
        ts: rec.nowISO,
        identity: rec.identity,
        modelReady: rec.modelReady,
        captureReady: rec.captureReady,
        diverged: rec.modelReady !== rec.captureReady,
        geom: rec.geom,
      }) + '\n',
    )
  } catch {
    /* observability only — never block the ready-gate */
  }
}

/** Per-peer ready-gate flip flag: the marker `<logDir>/<identity>.pty-readygate`. */
export function readyGatePtyFlipEnabled(logDir: string, identity: string): boolean {
  return existsSync(`${logDir}/${identity}.pty-readygate`)
}

export interface ReadyGateViewportOpts {
  logDir: string
  identity: string
  /** The capture-pane scrape — returned verbatim when the flag is off OR any model build fails. */
  fallback: string
  cols: number
  rows: number
}

/**
 * Resolve the ready-gate viewport. Flag OFF → `fallback` (capture-pane) verbatim — zero work, the
 * caller never even reaches here unless it pre-checked the flag, but this stays safe regardless.
 * Flag ON → the pty-model viewport as plain text. ANY failure (unreadable/short log, @xterm hiccup)
 * → `fallback`: the flip can never make readiness WORSE than capture-pane today (tmux is the floor).
 */
export async function readyGateViewport(opts: ReadyGateViewportOpts): Promise<string> {
  if (!readyGatePtyFlipEnabled(opts.logDir, opts.identity)) return opts.fallback
  if (!(opts.cols > 0 && opts.rows > 0)) return opts.fallback
  const view = await paneLogViewport(`${opts.logDir}/${opts.identity}.log`, opts.cols, opts.rows)
  return view ?? opts.fallback // tmux-fallback is unconditional — never worse than today
}

/**
 * Read a pane-log's tail into a headless @xterm and render the viewport as plain text — the SAME
 * 0-divergence-validated model the ready-gate flip uses, shared with the spawn-flip hosted path (a
 * supervisor-HOSTED session has no capture-pane, so its pane-log model is the ONLY readiness source).
 * @xterm is dynamic-imported here so a flag-off launch never loads it. Returns null on any failure
 * (unreadable/short log, @xterm hiccup) — the caller decides the fallback (capture-pane for the
 * readygate flip; a retry/fail for hosted).
 */
async function loadPaneLogModel(log: string, cols: number, rows: number, startByte = 0): Promise<Terminal | null> {
  if (!(cols > 0 && rows > 0) || !existsSync(log)) return null
  try {
    const { Terminal } = await import('@xterm/headless')
    const fd = openSync(log, 'r')
    try {
      const sz = fstatSync(fd).size
      // RENDER WINDOW = the SEED tail (last 4 MiB) AND, when given, the SESSION-START boundary. The
      // pane-log is a SHARED append-only file across a peer's session lineage, so its tail can carry a
      // PRIOR session's last frame — and a prior session almost always ended idle at a `❯ ready` row.
      // Rendering that on a FRESH wake (before the new runtime has painted) makes isInputReady=true
      // PREMATURELY → the gate delivers into a still-booting session → the first message is LOST and the
      // model never produces a turn ("no activity advance"). `startByte` = the pane-log size captured at
      // THIS session's spawn; clamping `off` to it renders ONLY this session's bytes, never the prior
      // frame. Trim-safety: if capPaneLogs shrank the file BELOW startByte since capture (rare, mid-boot),
      // the boundary is stale → fall back to the SEED tail (no worse than pre-fix; never hang on a 0-len
      // read). startByte=0 (default) is byte-identical to the prior behavior.
      const seedFloor = Math.max(0, sz - SEED_BYTES)
      const off = startByte > 0 && startByte <= sz ? Math.max(startByte, seedFloor) : seedFloor
      const buf = Buffer.alloc(sz - off)
      readSync(fd, buf, 0, buf.length, off)
      const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 3000 })
      await new Promise<void>(res => term.write(buf, () => res()))
      return term
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

export async function paneLogViewport(log: string, cols: number, rows: number, startByte = 0): Promise<string | null> {
  const term = await loadPaneLogModel(log, cols, rows, startByte)
  if (!term) return null
  const { modelToPlainText } = await import('../shadow/render.ts')
  return modelToPlainText(term, cols, rows)
}

/**
 * Spawn-flip Ф0b-2 hosted composer-occupancy guard (slice 2): does the hosted session's composer hold
 * human input? Reads the pane-log model — the SAME raw child bytes tmux renders — and runs the burn-in-
 * validated `composerOccupancyFromModel` (REUSED, not reimplemented). The hosted equivalent of
 * `targetComposerBlocksDelivery`'s capture-pane occupancy. @xterm loads dynamically here (flag-on
 * hosted only; the leaf `composerOccupancyFromModel` import is type-only at runtime, so the warm path
 * stays @xterm-free with the flip off). UNCERTAINTY → BUSY (true): a model-build failure mirrors the
 * tmux predicate's capture-fail-is-busy stance — prefer a false-busy hold over a false-free paste into
 * a human composer.
 *
 * NB (sequence): this is the DETECTION primitive. The end-to-end gate (attached-supervisor-
 * client + enqueue + host-aware drain) lands with the attach client in Ф0b-3 — until a human can
 * attach to a hosted session there is no human composer to protect. The caller composes the pane-log
 * path from logDir+identity, mirroring `waitHostReady`.
 */
export async function paneLogComposerOccupied(log: string, cols: number, rows: number, runtime: string): Promise<boolean> {
  const term = await loadPaneLogModel(log, cols, rows)
  if (!term) return true // uncertainty → busy: never paste into a maybe-occupied composer
  const { composerOccupancyFromModel } = await import('../shadow/render.ts')
  return composerOccupancyFromModel(term, cols, rows, runtime)
}
