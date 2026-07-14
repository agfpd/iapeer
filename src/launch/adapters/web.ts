// web RuntimeAdapter — the "HOW to launch / observe ONE web session" half of the
// launch contract (src/launch/types.ts). Like telegram/voicetalk, web is a
// long-running ROUTER (`web-runtime run`: the owner's browser fleet-console —
// local HTTP/WebSocket server the browser client connects to → IAP envelopes to
// the fleet; <iap>-marked stdin → rendered into the console chat), NOT an LLM TUI.
// So kind:'router' tells launch.launch to SKIP every TUI phase — no pane boot
// dialog, no ready-marker, no first-user-turn delivery, no activity-proxy
// ready-gate, no permission modal, no transcript to resume. The pane predicates
// below are therefore trivial constants, present only to satisfy the frozen
// interface.
//
// web is a presence-runtime for a HUMAN (the owner's browser console), modelled on
// telegram/voicetalk per the foundation presence-runtime contract: kind:'router',
// usesDoctrine:false, allowedIntelligences:['natural','absent'], argv = `<bin> run
// <extra>`. The server/client mechanics (port, tunnel, auth) live in the
// @agfpd/web-runtime package, NOT in this adapter and NOT interpreted by the
// foundation — interfaces.web (if the package declares one) is opaque here.
//
// NO sender-guard for web (the voicetalk precedent): telegramSenderGuard is
// telegram-specific (the bridge picks the SENDING bot from the sender's
// bot_username); web is a single local owner endpoint — the console renders the
// sender from the envelope's `from`, so any peer may write to it freely.
//
// NO currency on this path: no marketplace check, no plugin install/update — that
// is install-time (the package self-deploys its runtime.json manifest), not
// session bring-up.

import type { ControlCommand, ControlPlan, LaunchAdapterConfig, LaunchSpec, RuntimeAdapter } from '../types.ts'
import { allowedIntelligencesForRuntime } from '../../core/constants.ts'

// ─────────────────────────────────────────────────────────────────────────────
// webAdapter
// ─────────────────────────────────────────────────────────────────────────────

export const webAdapter: RuntimeAdapter = {
  runtime: 'web',
  kind: 'router',
  usesDoctrine: false,

  /** No submit surface — a router takes no bracketed-paste-then-Enter turn; delivery
   *  is deliverHosted → child stdin (<iap> reader), not submitIntoTui. Empty glyphs. */
  deliveryMarkers: { promptGlyphs: [] },

  /**
   * web carries a HUMAN (natural) OR a FACELESS SERVICE bot (absent) — never an LLM
   * agent (artificial), which would route the owner's console channel to an agent/script.
   * Same nature gate as telegram/voicetalk, sourced from the single Ф0 truth
   * (allowedIntelligencesForRuntime); enforced by the launch primitive against
   * LaunchSpec.intelligence. Source → docs/Идентичность.
   */
  allowedIntelligences: allowedIntelligencesForRuntime('web'),

  /**
   * argv = webBin + 'run' + extraArgs.
   *   - cfg.webBin ?? 'web-runtime'  the launch binary (the always-on plist pins an
   *     absolute path via WEB_RUNTIME_BIN — launchd-minimal PATH; here we defer to
   *     cfg.webBin when set, else emit the PATH-resolvable literal for launch.launch
   *     to resolve).
   *   - 'run'  the router subcommand: brings up the console server (browser client ↔
   *     fleet) and pumps IAP envelopes both directions through the session's stdio
   *     (outbound <iap> stdin → console chat; inbound browser input → fleet via the
   *     daemon send_to_peer).
   *   - ...extraArgs  LaunchSpec.extraArgs passthrough.
   *
   * NO --system-prompt-file: usesDoctrine:false — a router is not an LLM, no doctrine to
   * merge. NO --resume: a router has no transcript. NO currency on this path.
   */
  buildArgv(spec: LaunchSpec, cfg: LaunchAdapterConfig): string[] {
    return [cfg.webBin ?? 'web-runtime', 'run', ...(spec.extraArgs ?? [])]
  },

  /** No startup dialogs — a router has no pane TUI to answer. launch.launch skips the
   *  boot phase for kind:'router', so this is never consulted; null = "no dialog". */
  bootDialogKeys(_pane: string): string[] | null {
    return null
  },

  /** Always ready: a router has no input surface waiting for a first message — it is
   *  "up" the instant `web-runtime run` is launched. launch.launch skips the
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
