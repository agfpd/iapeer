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
