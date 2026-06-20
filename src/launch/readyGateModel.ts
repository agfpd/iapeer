// Pane-log MODEL leaf — render a supervisor pane-log (raw child pty bytes) through @xterm/headless to
// the readiness viewport + composer-occupancy verdict. The pty-hosted ready-gate (ptyHost.waitHostReady)
// and the warm-deliver busy-composer guard (transport) both read the session state from this model —
// a hosted session has no capture-pane, so the pane-log model is the ONLY readiness/occupancy source.
// @xterm is dynamic-imported (loaded only when a model is actually built), so callers that never build
// one stay @xterm-free.

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import type { Terminal } from '@xterm/headless' // TYPE-ONLY (erased) — the runtime @xterm load is the dynamic import below

const SEED_BYTES = 4 * 1024 * 1024

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
  const { modelToPlainText } = await import('../supervisor/render.ts')
  return modelToPlainText(term, cols, rows)
}

/**
 * Spawn-flip Ф0b-2 hosted composer-occupancy guard (slice 2): does the hosted session's composer hold
 * human input? Reads the pane-log model — the SAME raw child bytes tmux renders — and runs the burn-in-
 * validated `composerOccupancyFromModel` (REUSED, not reimplemented). The hosted equivalent of
 * `targetComposerBlocksDelivery`'s capture-pane occupancy. @xterm loads dynamically here (flag-on
 * hosted only; the leaf `composerOccupancyFromModel` import is type-only at runtime, so the warm path
 * stays @xterm-free with the flip off). UNREADABLE PANE-LOG → NOT busy (false): the hold exists ONLY to
 * avoid clobbering VISIBLE human composer text; if the model can't be built there is NO observed text to
 * protect. This deliberately does NOT mirror the tmux predicate's capture-fail-is-busy stance: tmux
 * `capture-pane` fails ~only when the session is GONE (then the queue's session-token/alive check fails
 * the job loudly), but a hosted pane-log can be absent/unreadable while the session is ALIVE (e.g. a
 * long-lived session whose lifecycle pane-log was rotated/removed) — so "uncertainty → busy" would stall
 * EVERY delivery to such a peer until the 120 s force-timeout, starving the core addressed-delivery
 * feature. The narrow cost (no composer protection while the log is unreadable) is acceptable: a session
 * actively being typed into is precisely one whose pane-log IS being written.
 *
 * NB (sequence): this is the DETECTION primitive. The end-to-end gate (attached-supervisor-
 * client + enqueue + host-aware drain) lands with the attach client in Ф0b-3 — until a human can
 * attach to a hosted session there is no human composer to protect. The caller composes the pane-log
 * path from logDir+identity, mirroring `waitHostReady`.
 */
export async function paneLogComposerOccupied(log: string, cols: number, rows: number, runtime: string): Promise<boolean> {
  const term = await loadPaneLogModel(log, cols, rows)
  if (!term) return false // unreadable pane-log → no observed human composer text → deliver, never stall (see JSDoc)
  const { composerOccupancyFromModel } = await import('../supervisor/render.ts')
  return composerOccupancyFromModel(term, cols, rows, runtime)
}
