// notifier RuntimeAdapter — the "HOW to launch / observe ONE notifier session"
// half of the launch contract (src/launch/types.ts). Like telegram, the notifier
// runtime is a long-running ROUTER (notifier-runtime run: a Scheduler/Supervisor
// loop + an IAP envelope pump on stdin, ported from telegram-runtime), NOT an LLM
// TUI. So kind:'router' tells launch.launch to SKIP every TUI phase — no pane boot
// dialog, no ready-marker, no first-user-turn delivery, no activity-proxy ready-
// gate, no permission modal, no transcript to resume. The pane predicates below
// are trivial constants, present only to satisfy the frozen interface.
//
// ONE adapter for the whole runtime: notifier carries TWO peer-roles, `timer`
// (primitive TIME → Scheduler) and `watcher` (primitive EVENT → Supervisor). The
// role is NOT an adapter concern — it is dispatched INSIDE `notifier-runtime run`
// from PEER_PERSONALITY (resolvePersonality: watcher → Supervisor, else timer →
// Scheduler), exactly as personality reaches every other runtime: via env +
// `tmux new-session -c "$PEER_CWD"`, i.e. launch.launch's job, not buildArgv's.
//
// notifier is an INFRA runtime (always-on): launchd KeepAlive holds the session so
// the daemon can deliver send_to_peer(timer|watcher, …) into its tmux pane (the
// stdin reader picks up the registration/live-reload envelope). That always-on
// bring-up is the plist path (src/launch/launchd.ts); THIS adapter only describes
// how to launch one notifier session, identical in shape to telegram.
//
// NO currency on this path: no marketplace check, no plugin install/update.

import type { ControlCommand, ControlPlan, LaunchAdapterConfig, LaunchSpec, RuntimeAdapter } from '../types.ts'

export const notifierAdapter: RuntimeAdapter = {
  runtime: 'notifier',
  kind: 'router',
  usesDoctrine: false,

  /** No submit surface — a router uses the deliverViaTmux C-j path, not submitIntoTui.
   *  Empty glyphs. (No intelligence gate: notifier peers are intelligence='absent'
   *  programmatic sources, which is exactly their expected nature — nothing to refuse.) */
  deliveryMarkers: { promptGlyphs: [] },

  /**
   * argv = notifierBin + 'run' + extraArgs — symmetric with telegram-runtime
   * (`$BIN run ${PEER_START_ARGS}`).
   *   - cfg.notifierBin ?? 'notifier-runtime'  the launch binary; the literal is
   *     left for launch.launch's PATH to resolve when cfg does not pin it.
   *   - 'run'  the Scheduler/Supervisor subcommand: reads the peer's triggers,
   *     runs the TIME grid (timer) or EVENT supervisor (watcher) by PEER_PERSONALITY,
   *     and pumps IAP envelopes in via the session's stdin (registration/live-reload).
   *   - ...extraArgs  PEER_START_ARGS passthrough (LaunchSpec.extraArgs).
   *
   * NO --system-prompt-file (usesDoctrine:false — a router is not an LLM). NO
   * --resume (a router has no transcript). NO currency on this path.
   */
  buildArgv(spec: LaunchSpec, cfg: LaunchAdapterConfig): string[] {
    return [cfg.notifierBin ?? 'notifier-runtime', 'run', ...(spec.extraArgs ?? [])]
  },

  /** No startup dialogs — a router has no pane TUI to answer; launch.launch skips
   *  the boot phase, so this is never consulted. */
  bootDialogKeys(_pane: string): string[] | null {
    return null
  },

  /** Always ready: a router is "up" the instant `notifier-runtime run` is launched
   *  into the tmux session; launch.launch skips the ready-gate for kind:'router'. */
  isInputReady(_pane: string): boolean {
    return true
  },

  /** No activity proxy: a router writes no transcript/session jsonl to mtime. */
  newestActivityMtime(_cwd: string): number | null {
    return null
  },

  lastTurnMtime(_cwd: string): number | null {
    return null // router — no transcript
  },

  /** Nothing to resume: a router does not replay a transcript. */
  resolveResume(_cwd: string): { ok: boolean; ref?: string; reason?: string } {
    return { ok: true }
  },

  /** No in-session control: a router has no TUI turn. null → explicit refusal upstream. */
  executeControl(_command: ControlCommand): ControlPlan | null {
    return null
  },
}
