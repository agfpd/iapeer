// telegram RuntimeAdapter — the "HOW to launch / observe ONE telegram session"
// half of the launch contract (src/launch/types.ts). Unlike claude/codex, the
// telegram runtime is a long-running ROUTER (telegram-runtime run: grammy
// long-polling + IAP envelope pump), NOT an LLM TUI. So kind:'router' tells
// launch.launch to SKIP every TUI phase — there is no pane boot dialog, no
// ready-marker, no first-user-turn delivery, no activity-proxy ready-gate, no
// permission modal, no transcript to resume. The pane predicates below are
// therefore trivial constants, present only to satisfy the frozen interface.
//
// Ported from one frozen source:
//
//   - Persistent-Peer/bin/telegram-start.sh — the launch command (line 119:
//     `CMD="$TELEGRAM_RUNTIME_BIN run ${PEER_START_ARGS}"`), and the explicit
//     facts that this adapter carries NO doctrine/system-prompt (it is not an
//     LLM that consumes one — header lines 6-16) and is gated to human peers
//     (intelligence='human', lines 24-28/63-71). The binary defaults to the
//     PATH-resolved literal `telegram-runtime` (line 107); the run subcommand
//     takes only PEER_START_ARGS as extra flags — no personality/cwd positional
//     (those are env + `tmux new-session -c "$PEER_CWD"`, i.e. launch.launch's
//     job, not buildArgv's).
//
// NO currency on this path: no marketplace check, no plugin install/update —
// that is install-time (blueprint §0.6 fast-wake), not session bring-up.

import type { ControlCommand, ControlPlan, LaunchAdapterConfig, LaunchSpec, RuntimeAdapter } from '../types.ts'

// ─────────────────────────────────────────────────────────────────────────────
// telegramAdapter
// ─────────────────────────────────────────────────────────────────────────────

export const telegramAdapter: RuntimeAdapter = {
  runtime: 'telegram',
  kind: 'router',
  usesDoctrine: false,

  /** No submit surface — a router takes no bracketed-paste-then-Enter turn
   *  (deliverViaTmux uses the router C-j path, not submitIntoTui). Empty glyphs. */
  deliveryMarkers: { promptGlyphs: [] },

  /**
   * telegram is a HUMAN channel — launch REFUSES a non-natural peer (fail-loud).
   * Porting the persistent-peer FATAL guard (it stood in two places): a peer with
   * intelligence artificial/absent must never be brought up on telegram (it would
   * route a human's bot to an agent/script). The launch primitive enforces this
   * against LaunchSpec.intelligence; source of intelligence → docs/Идентичность.
   */
  requiresIntelligence: 'natural',

  /**
   * argv = telegramBin + 'run' + extraArgs (telegram-start.sh:119,
   * `$TELEGRAM_RUNTIME_BIN run ${PEER_START_ARGS}`).
   *
   *   - cfg.telegramBin ?? 'telegram-runtime'  the launch binary. The bash
   *     resolves it via `command -v telegram-runtime` (line 107) against a PATH
   *     that prefers ~/.iapeer/runtimes/telegram/bin then ~/.local/bin; here we
   *     defer that resolution to cfg.telegramBin when set, else emit the literal
   *     'telegram-runtime' for launch.launch's PATH to resolve.
   *   - 'run'  the router subcommand: reads peer-profile + global bots registry,
   *     brings up grammy long-polling for every linked bot, and pumps IAP
   *     envelopes both directions through the session's stdio (DECISIONS §12.1).
   *   - ...extraArgs  PEER_START_ARGS passthrough (LaunchSpec.extraArgs) — the
   *     only extra flags telegram-start.sh forwards to `run`.
   *
   * NO --system-prompt-file: usesDoctrine:false — telegram-runtime is a router,
   * not an LLM, so there is no doctrine to merge (telegram-start.sh:6-12). NO
   * --resume: a router has no transcript. NO currency on this path.
   */
  buildArgv(spec: LaunchSpec, cfg: LaunchAdapterConfig): string[] {
    return [cfg.telegramBin ?? 'telegram-runtime', 'run', ...(spec.extraArgs ?? [])]
  },

  /**
   * No startup dialogs — the router has no pane TUI to answer (kind:'router',
   * telegram-start.sh:14-16). launch.launch skips the boot phase, so this is
   * never consulted; null is the contractual "no dialog to clear".
   */
  bootDialogKeys(_pane: string): string[] | null {
    return null
  },

  /**
   * Always ready: a router has no input surface waiting for a first message —
   * it is "up" the instant `telegram-runtime run` is launched into the tmux
   * session (telegram-start.sh has no ready-marker polling, lines 14-16).
   * launch.launch skips the ready-gate for kind:'router'; true is the
   * contractual "nothing to wait for".
   */
  isInputReady(_pane: string): boolean {
    return true
  },

  /**
   * No activity proxy: a router writes no transcript/session jsonl to mtime as a
   * ready-gate or idle signal (contract: "null for a router (no proxy)").
   * launch.launch skips the activity-proxy ready-gate for kind:'router'.
   */
  newestActivityMtime(_cwd: string): number | null {
    return null
  },

  /**
   * Nothing to resume: a router does not replay a transcript, so resume cannot
   * fail-loud the way claude/codex do — there is no prior session ref to resolve
   * or miss. Always {ok:true} (the contract: "a router does not resume a
   * transcript; nothing to fail on").
   */
  resolveResume(_cwd: string): { ok: boolean; ref?: string; reason?: string } {
    return { ok: true }
  },

  /** No in-session control: a router has no TUI turn to interrupt/compact. null for
   *  every command → the daemon/CLI surfaces an explicit "unsupported" refusal. */
  executeControl(_command: ControlCommand): ControlPlan | null {
    return null
  },
}
