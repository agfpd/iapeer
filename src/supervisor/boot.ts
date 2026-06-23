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

/** The slice of a RuntimeAdapter the MID-SESSION nag-watcher consumes — the optional
 *  nagDismissKeys (claudeAdapter satisfies it; codex/router omit it → no nags). */
export interface NagPredicate {
  nagDismissKeys?(pane: string): string[] | null
}

export type NagAction = { kind: 'dismiss'; keys: string[]; bytes: Buffer } | { kind: 'none' }

/**
 * MID-SESSION nag/upsell step (livability) — the persistent sibling of nextBootAction. Unlike the
 * boot-driver, which STOPS at ready, the daemon loops this for the WHOLE session: a one-time CC upsell
 * modal (e.g. "Try the new fullscreen renderer?") can pop AFTER the session is live and BLOCK the pty on
 * a keypress no headless peer answers. If the adapter recognizes the (FULL-signature) modal it returns
 * the verified-safe DECLINE keys; the caller writes `action.bytes` to the pty (cooldown-guarded so a
 * cleared modal is never double-answered). An adapter with no nagDismissKeys → always 'none'.
 */
export function nextNagAction(adapter: NagPredicate, viewport: string, enc: KeyEncoding = {}): NagAction {
  const keys = adapter.nagDismissKeys?.(viewport)
  if (keys && keys.length) return { kind: 'dismiss', keys, bytes: keysToBytes(keys, enc) }
  return { kind: 'none' }
}
