// voicetalk RuntimeAdapter — the "HOW to launch / observe ONE voicetalk session"
// half of the launch contract (src/launch/types.ts). Like telegram, voicetalk is a
// long-running ROUTER (voicetalk-runtime run: mic + wake-word listen → IAP envelopes
// to the fleet; <iap>-marked stdin → TTS to the owner's speaker), NOT an LLM TUI. So
// kind:'router' tells launch.launch to SKIP every TUI phase — no pane boot dialog, no
// ready-marker, no first-user-turn delivery, no activity-proxy ready-gate, no
// permission modal, no transcript to resume. The pane predicates below are therefore
// trivial constants, present only to satisfy the frozen interface.
//
// voicetalk is a presence-runtime for a HUMAN (the owner's voice channel), modelled on
// telegram per the foundation presence-runtime contract: kind:'router',
// usesDoctrine:false, requiresIntelligence:'natural', argv = `<bin> run <extra>`. The
// STT/TTS engines and providers live in a shared voice service (voice-connect), NOT in
// this adapter and NOT in the peer passport — interfaces.voicetalk carries only the
// binding ({wake_word, device}), opaque to the foundation.
//
// NO currency on this path: no marketplace check, no plugin install/update — that is
// install-time (the package self-deploys its runtime.json manifest), not session
// bring-up.

import type { ControlCommand, ControlPlan, LaunchAdapterConfig, LaunchSpec, RuntimeAdapter } from '../types.ts'

// ─────────────────────────────────────────────────────────────────────────────
// voicetalkAdapter
// ─────────────────────────────────────────────────────────────────────────────

export const voicetalkAdapter: RuntimeAdapter = {
  runtime: 'voicetalk',
  kind: 'router',
  usesDoctrine: false,

  /** No submit surface — a router takes no bracketed-paste-then-Enter turn; delivery
   *  is deliverHosted → child stdin (<iap> reader), not submitIntoTui. Empty glyphs. */
  deliveryMarkers: { promptGlyphs: [] },

  /**
   * voicetalk is a HUMAN channel — launch REFUSES a non-natural peer (fail-loud).
   * Same nature gate as telegram: a peer with intelligence artificial/absent must never
   * be brought up on voicetalk (it would route the owner's voice channel to an
   * agent/script). The launch primitive enforces this against LaunchSpec.intelligence;
   * source of intelligence → docs/Идентичность.
   */
  requiresIntelligence: 'natural',

  /**
   * argv = voicetalkBin + 'run' + extraArgs.
   *   - cfg.voicetalkBin ?? 'voicetalk-runtime'  the launch binary (the always-on
   *     plist pins an absolute path via VOICETALK_RUNTIME_BIN — launchd-minimal PATH;
   *     here we defer to cfg.voicetalkBin when set, else emit the PATH-resolvable
   *     literal for launch.launch to resolve).
   *   - 'run'  the router subcommand: reads the peer-profile binding (interfaces.voicetalk),
   *     brings up mic + wake-word listening, and pumps IAP envelopes both directions
   *     through the session's stdio (outbound <iap> stdin → TTS; inbound mic → fleet via
   *     the daemon send_to_peer).
   *   - ...extraArgs  LaunchSpec.extraArgs passthrough.
   *
   * NO --system-prompt-file: usesDoctrine:false — a router is not an LLM, no doctrine to
   * merge. NO --resume: a router has no transcript. NO currency on this path.
   */
  buildArgv(spec: LaunchSpec, cfg: LaunchAdapterConfig): string[] {
    return [cfg.voicetalkBin ?? 'voicetalk-runtime', 'run', ...(spec.extraArgs ?? [])]
  },

  /** No startup dialogs — a router has no pane TUI to answer. launch.launch skips the
   *  boot phase for kind:'router', so this is never consulted; null = "no dialog". */
  bootDialogKeys(_pane: string): string[] | null {
    return null
  },

  /** Always ready: a router has no input surface waiting for a first message — it is
   *  "up" the instant `voicetalk-runtime run` is launched. launch.launch skips the
   *  ready-gate for kind:'router'; true = "nothing to wait for". */
  isInputReady(_pane: string): boolean {
    return true
  },

  /** No activity proxy: a router writes no transcript/session jsonl to mtime as a
   *  ready-gate or idle signal. launch.launch skips the activity-proxy gate for a
   *  router; null per the contract ("null for a router (no proxy)"). */
  newestActivityMtime(_cwd: string): number | null {
    return null
  },

  lastTurnMtime(_cwd: string): number | null {
    return null // router — no transcript
  },

  /** Nothing to resume: a router does not replay a transcript, so resume cannot
   *  fail-loud the way claude/codex do. Always {ok:true}. */
  resolveResume(_cwd: string): { ok: boolean; ref?: string; reason?: string } {
    return { ok: true }
  },

  /** No in-session control: a router has no TUI turn to interrupt/compact. null for
   *  every command → the daemon/CLI surfaces an explicit "unsupported" refusal. */
  executeControl(_command: ControlCommand): ControlPlan | null {
    return null
  },
}
