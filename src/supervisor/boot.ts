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
 *  (benign upsell → silent decline) + blockingConfirm (known circuit-breaker → affirmative/decision) +
 *  unknownBlockingModal (docs/17 yolo-robustness — a numbered-select modal matching NO known signature →
 *  always to the human). claudeAdapter satisfies all three; codex declares unknownBlockingModal only;
 *  router omits all → no action. */
export interface NagPredicate {
  nagDismissKeys?(pane: string): string[] | null
  blockingConfirm?(pane: string): { keys: string[]; denyKeys: string[]; taxonomy: string; detail: string; alwaysHuman?: boolean } | null
  unknownBlockingModal?(pane: string): { content: string; option1: string } | null
}

// Fixed keys for a GENERIC unknown modal whose option layout we do NOT know (docs/17 fork 3): ALLOW
// presses option 1 (the proceed/primary position in every known claude/codex select; the human is told
// exactly what option 1 is), DENY presses Escape (the universal modal cancel — commits no numbered
// choice, so it can never accidentally affirm; if a modal ignores Esc the daemon bounds re-enqueue and
// safe-parks). v1 is BINARY (option-1-or-cancel); a >2-way choice on an unknown modal is a v2 extension.
export const UNKNOWN_MODAL_ALLOW_KEYS = ['1', 'Enter']
export const UNKNOWN_MODAL_DENY_KEYS = ['Escape']

export type NagAction =
  | { kind: 'dismiss'; keys: string[]; bytes: Buffer } // benign upsell — press keys silently
  // A blocking confirm/modal needing a Yes/No decision. Press `bytes` to AFFIRM or `denyBytes` to DECLINE.
  //   - alwaysHuman=false (dangerous-rm / command-approval): yolo auto-Yes, gated → broker.
  //   - alwaysHuman=true  (org-policy / unknown-modal): ALWAYS → broker (both modes; never auto-Yes).
  // `brokerKind` is the broker taxonomy tag (docs/17); `option1` (unknown-modal only) is the verbatim
  // label of option 1, so the human is shown EXACTLY what an Allow will press. `detail` is the audit
  // trace (known) or the verbatim modal block (unknown-modal).
  | {
      kind: 'approve'
      keys: string[]
      bytes: Buffer
      denyKeys: string[]
      denyBytes: Buffer
      taxonomy: string
      detail: string
      alwaysHuman: boolean
      brokerKind: string
      option1?: string
    }
  | { kind: 'none' }

/**
 * MID-SESSION nag/confirm step (livability) — the persistent sibling of nextBootAction. Unlike the
 * boot-driver (which STOPS at ready), the daemon loops this for the WHOLE session over THREE classes of
 * mid-session blocking prompt no headless peer can answer, checked most-specific FIRST:
 *   1. a KNOWN circuit-breaker (blockingConfirm — dangerous-rm / command-approval / org-policy) → press
 *      the affirmative/decision AND surface a `detail`/`taxonomy` the caller logs; `alwaysHuman` decides
 *      whether a yolo peer auto-Yeses (false) or always routes to the human (true, org-policy);
 *   2. a benign UPSELL modal (nagDismissKeys — e.g. "Try the new fullscreen-renderer?") → decline silently;
 *   3. a GENERIC unknown modal (unknownBlockingModal — a numbered select matching no known signature) →
 *      ALWAYS to the human with fixed option-1-or-cancel keys + the verbatim block (docs/17 yolo-robustness).
 * The caller writes `action.bytes` (cooldown- + stuck-gate-guarded so a cleared prompt is never double-
 * answered). An adapter with none of the three → 'none'.
 */
export function nextNagAction(adapter: NagPredicate, viewport: string, enc: KeyEncoding = {}): NagAction {
  const confirm = adapter.blockingConfirm?.(viewport)
  if (confirm && confirm.keys.length)
    return {
      kind: 'approve',
      keys: confirm.keys,
      bytes: keysToBytes(confirm.keys, enc),
      denyKeys: confirm.denyKeys,
      denyBytes: keysToBytes(confirm.denyKeys, enc),
      taxonomy: confirm.taxonomy,
      detail: confirm.detail,
      alwaysHuman: confirm.alwaysHuman ?? false,
      brokerKind: 'circuit-breaker',
    }
  const keys = adapter.nagDismissKeys?.(viewport)
  if (keys && keys.length) return { kind: 'dismiss', keys, bytes: keysToBytes(keys, enc) }
  // GENERIC residue — checked LAST so a known signature always wins its precise keys.
  const unknown = adapter.unknownBlockingModal?.(viewport)
  if (unknown)
    return {
      kind: 'approve',
      keys: UNKNOWN_MODAL_ALLOW_KEYS,
      bytes: keysToBytes(UNKNOWN_MODAL_ALLOW_KEYS, enc),
      denyKeys: UNKNOWN_MODAL_DENY_KEYS,
      denyBytes: keysToBytes(UNKNOWN_MODAL_DENY_KEYS, enc),
      taxonomy: 'unknown-modal',
      detail: unknown.content,
      alwaysHuman: true,
      brokerKind: 'unknown-modal',
      option1: unknown.option1,
    }
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
