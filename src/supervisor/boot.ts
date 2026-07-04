// Supervisor BOOT-DRIVER decision (serving slice a) — the pure half of "answer the startup dialogs
// off the model". A real codex/claude TUI stalls on trust/update/hooks/resume modals; under tmux the
// launch primitive (index.ts boot loop, 384-411) answers them via capture-pane (read) + send-keys
// (write). The supervisor reads its authoritative @xterm model (modelToPlainText) and writes raw pty
// bytes (keysToBytes) — same decision, different surfaces. This module is the DECISION; daemon.ts
// owns the loop (render → decide → write). PURE: no @xterm, no pty — feed it a viewport string + the
// runtime's boot predicates and it returns the bytes to send, so it is unit-testable against the
// real adapters.
import { keysToBytes, type KeyEncoding } from './protocol.ts'

/** The slice of a RuntimeAdapter the boot-driver consumes. codexAdapter / claudeAdapter satisfy it
 *  structurally, so boot.ts stays decoupled from launch/types.ts. */
export interface BootPredicates {
  bootDialogKeys(pane: string): string[] | null
  isInputReady(pane: string): boolean
}

export type BootAction =
  | { kind: 'dialog'; keys: string[]; bytes: Buffer }
  | { kind: 'ready' }
  | { kind: 'wait' }

/**
 * One boot step, mirroring the launch primitive's order (index.ts:384-411): a visible startup dialog
 * is answered FIRST (its keys clear it; bytes encoded for the model's current cursor mode), ELSE the
 * input surface is checked for readiness, ELSE wait for the next frame. The caller loops this on a
 * cadence, writing `action.bytes` to the pty on a 'dialog' and stopping on 'ready'.
 */
export function nextBootAction(adapter: BootPredicates, viewport: string, enc: KeyEncoding = {}): BootAction {
  const keys = adapter.bootDialogKeys(viewport)
  if (keys && keys.length) return { kind: 'dialog', keys, bytes: keysToBytes(keys, enc) }
  if (adapter.isInputReady(viewport)) return { kind: 'ready' }
  return { kind: 'wait' }
}

/** The slice of a RuntimeAdapter the MID-SESSION nag-watcher consumes — the optional nagDismissKeys
 *  (benign upsell → silent decline) + blockingConfirm (circuit-breaker → affirmative + audit log).
 *  claudeAdapter satisfies both; codex/router omit them → no action. */
export interface NagPredicate {
  nagDismissKeys?(pane: string): string[] | null
  blockingConfirm?(pane: string): { keys: string[]; taxonomy: string; detail: string } | null
}

export type NagAction =
  | { kind: 'dismiss'; keys: string[]; bytes: Buffer } // benign upsell — press keys silently
  | { kind: 'approve'; keys: string[]; bytes: Buffer; taxonomy: string; detail: string } // circuit-breaker — press keys + LOG
  | { kind: 'none' }

/**
 * MID-SESSION nag/confirm step (livability) — the persistent sibling of nextBootAction. Unlike the
 * boot-driver (which STOPS at ready), the daemon loops this for the WHOLE session for TWO classes of
 * mid-session blocking prompt no headless peer can answer:
 *   1. a CIRCUIT-BREAKER confirm (blockingConfirm — e.g. the dangerous-rm guard above the permission
 *      layer) → press the affirmative AND surface a `detail`/`taxonomy` the caller logs (owner audit);
 *   2. a benign UPSELL modal (nagDismissKeys — e.g. "Try the new fullscreen-renderer?") → decline silently.
 * The circuit-breaker is checked FIRST (safety-relevant). The caller writes `action.bytes` (cooldown- +
 * stuck-gate-guarded so a cleared prompt is never double-answered). An adapter with neither → 'none'.
 */
export function nextNagAction(adapter: NagPredicate, viewport: string, enc: KeyEncoding = {}): NagAction {
  const confirm = adapter.blockingConfirm?.(viewport)
  if (confirm && confirm.keys.length)
    return { kind: 'approve', keys: confirm.keys, bytes: keysToBytes(confirm.keys, enc), taxonomy: confirm.taxonomy, detail: confirm.detail }
  const keys = adapter.nagDismissKeys?.(viewport)
  if (keys && keys.length) return { kind: 'dismiss', keys, bytes: keysToBytes(keys, enc) }
  return { kind: 'none' }
}

// ── В60 — stuck-gate for the nag-watcher (timing signal, closer to the root than text) ────────────
// A REAL blocked modal freezes the pty: claude stops writing entirely (the dialog is static and the
// session cannot proceed). A LIVE peer that merely RENDERS the modal text — reviewing this code,
// quoting a bug report, editing the adapter (the В40 live incident class) — keeps WRITING (streamed
// output, spinner frames). So "the pane has written NOTHING for a while" discriminates a genuinely
// stuck modal from a working peer displaying the same glyphs, where any text/position match
// structurally cannot. The gate composes WITH the В40 position match (both must pass); the watcher
// stays load-bearing (В59 suppression-at-source is expected but unproven) — this gate just limits its
// fire to a genuinely wedged session.

/** Mutable gate state the caller owns (one per watched session). */
export interface StuckGate {
  /** The last write-sequence observed (any pty output bumps it). -1 = not yet baselined. */
  lastSeq: number
  /** Wall-clock ms when the sequence last CHANGED (progress observed). */
  stableSinceMs: number
}

export function newStuckGate(nowMs: number): StuckGate {
  return { lastSeq: -1, stableSinceMs: nowMs }
}

/**
 * One gate step: feed the current write-sequence + clock; returns true iff the pane has been
 * COMPLETELY static (no pty writes) for at least `thresholdMs`. Any progress re-arms the gate.
 * Pure w.r.t. time (clock injected) — unit-testable.
 */
export function paneIsStuck(gate: StuckGate, seq: number, nowMs: number, thresholdMs: number): boolean {
  if (seq !== gate.lastSeq) {
    gate.lastSeq = seq
    gate.stableSinceMs = nowMs
    return false
  }
  return nowMs - gate.stableSinceMs >= thresholdMs
}
