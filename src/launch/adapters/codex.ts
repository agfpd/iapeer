// codex RuntimeAdapter — the "HOW to launch / observe ONE codex session" half of
// the launch contract (src/launch/types.ts). Runtime-agnostic launch.launch
// drives it identically to claude: argv → boot dialogs → ready marker →
// activity-proxy ready-gate → permission autopilot → resume preflight. Codex is
// a tui that usesDoctrine, but the doctrine is delivered through a config field
// (`-c model_instructions_file=<f>`) rather than a dedicated flag, and resume is
// session-less (`resume --last`, codex matches the newest session for cwd
// itself). Consolidated from three frozen sources:
//
//   - Persistent-Peer/bin/codex-start.sh — argv (224: -c
//     model_instructions_file="<merged>", --dangerously-bypass-approvals-and-
//     sandbox), and the three startup-dialog auto-accepts (255-275: dir-trust
//     Enter, hooks-review Down+Enter). The update-available case is the
//     Spawned-Peer superset (codexUpdatePromptActive).
//   - Spawned-Peer/src/spawner.ts — buildCodexArgv (731-757: [resume --last]
//     --no-alt-screen -C <cwd> --dangerously-bypass-approvals-and-sandbox) and
//     hasCodexSessionForCwd (545-569: a session_meta.payload.cwd realpath-match
//     under ~/.codex/sessions/ is the resume preflight).
//   - Spawned-Peer/src/watcher.ts — codexInputReady (263-269), the boot-dialog
//     predicates (codexUpdatePromptActive/codexDirTrustActive/codexHooksReview
//     Active 253-261) + the keys the boot loop sends (382-400),
//     newestCodexSessionMtime + codexSessionCwd (200-234), and
//     answerPermissionDialog's codex branch (302-306: Down then Enter) over
//     dialogs.ts codexApprovalActive (39-45). NB the permission autopilot was
//     NOT ported (no answerPermissionDialog in this codebase): the permission
//     class is closed STRUCTURALLY instead — every peer runs
//     --dangerously-bypass-approvals-and-sandbox (buildArgs below) and init
//     bakes default_tools_approval_mode="approve", so the dialog never shows.
//
// The doctrine -c value is the bare `model_instructions_file=<f>` token: the
// TOML value-side quotes in codex-start.sh:224 exist only because that string is
// re-parsed by a shell (`printf %q`) before codex sees it; here launch.launch
// shell-quotes each argv element exactly once, so the unquoted path is correct
// and a quoted path would arrive as a literal `"..."`-wrapped (broken) TOML
// value. Order follows the FROZEN contract (types.ts:107), not the bash's
// flag order.
//
// NO currency on this path: no marketplace check, no plugin install/update — that
// is install-time (blueprint §0.6 fast-wake), not session bring-up. (codex-start
// .sh:94-122 runs the currency gate OUTSIDE the tmux launch; it is not ported.)

import { homedir } from 'os'
import { join } from 'path'
import { readdirSync, realpathSync, statSync } from 'fs'
import { codexSessionCwd, lastTimestampedEntryMs } from './transcriptTail.ts'
import { detectNumberedModal } from './modalDetect.ts'
import type { ApprovalMode, ControlCommand, ControlPlan, LaunchAdapterConfig, LaunchSpec, RuntimeAdapter } from '../types.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Boot dialog markers (watcher.codexUpdate/DirTrust/HooksReview, 253-261)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The known codex startup dialogs and the tmux send-keys the boot loop answers
 * each with (watcher.ts:382-400, codex-start.sh:255-275). Order matters: the
 * update screen can stack in front of the trust/hooks modals, so it is matched
 * first. Each option below is verified default-highlighted, so the listed keys
 * land on the proceed path:
 *   - 'Update available!' + 'Press enter to continue' — the self-update offer;
 *     keys ['2','Enter'] decline (option 2 = "not now") so a headless peer never
 *     blocks on an update it cannot drive (watcher.ts:382-384).
 *   - 'Do you trust the contents of this directory' — first-run folder-trust;
 *     option 1 ("Yes, continue") is default-highlighted → ['Enter']
 *     (watcher.ts:386-390, codex-start.sh:261-264).
 *   - 'Hooks need review' — a new/changed plugin hooks.json; "Trust all and
 *     continue" is option 2, default selector (`›`) is on option 1 → a single
 *     '2' (select-by-number commits immediately — В41 live capture, 0.139.0).
 */
function codexUpdatePromptActive(pane: string): boolean {
  return pane.includes('Update available!') && pane.includes('Press enter to continue')
}
function codexDirTrustActive(pane: string): boolean {
  return pane.includes('Do you trust the contents of this directory')
}
function codexHooksReviewActive(pane: string): boolean {
  return pane.includes('Hooks need review')
}

// codex's select-modal glyph (U+203A) — the same arrow isInputReady keys on (a numbered option row is
// `› 1. …`; the composer is `› <text>`, no leading digit-dot).
const CODEX_SELECT_GLYPH = '›'
/** Does the pane carry a KNOWN codex boot dialog (update / dir-trust / hooks-review)? unknownBlockingModal
 *  returns null for these so they stay owned by the boot-driver and are never re-routed to a human. */
function isKnownCodexBlockingSignature(pane: string): boolean {
  return codexUpdatePromptActive(pane) || codexDirTrustActive(pane) || codexHooksReviewActive(pane)
}

// ─────────────────────────────────────────────────────────────────────────────
// Session activity proxy + resume preflight (watcher / spawner port)
// ─────────────────────────────────────────────────────────────────────────────

// codexSessionCwd (bounded first-line read + path-memoized) is shared from transcriptTail.ts —
// the old full-file readFileSync here read tens of MB per session file on every hot-path scan.

/** realpath a path so a symlinked cwd compares equal to the dir codex recorded;
 *  a stale/missing path falls through to the original string (the canonicalPath
 *  helper behind watcher.newestCodexSessionMtime / spawner.hasCodexSessionForCwd). */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Newest ~/.codex/sessions/**\/*.jsonl mtimeMs whose recorded session cwd
 * realpath-matches `cwd`, or null when none (watcher.newestCodexSessionMtime,
 * 214-234). Codex files its session logs in a date-nested tree, so the scan
 * recurses. The ready-gate waits for this to strictly advance past baseline
 * (the model produced its first turn); idle accounting reads the same proxy.
 */
function newestCodexSessionMtime(cwd: string): number | null {
  return newestCodexSession(cwd)?.mt ?? null
}

/** The newest ~/.codex/sessions/**\/*.jsonl whose recorded session cwd realpath-matches `cwd`, as
 *  {path, mt}, or null when none. Shared by newestActivityMtime (file-mtime) and lastTurnMtime (needs
 *  the PATH to read the tail). Codex nests its session logs in a date tree, so the scan recurses. */
function newestCodexSession(cwd: string): { path: string; mt: number } | null {
  const root = join(homedir(), '.codex', 'sessions')
  const target = canonicalPath(cwd)
  let best = { path: '', mt: 0 }
  function visit(dir: string): void {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      if (canonicalPath(codexSessionCwd(path) ?? '') !== target) continue
      try {
        const mt = statSync(path).mtimeMs
        if (mt > best.mt) best = { path, mt }
      } catch {
        /* race — entry vanished between readdir and stat */
      }
    }
  }
  visit(root)
  return best.path ? best : null
}

// ─────────────────────────────────────────────────────────────────────────────
// codexAdapter
// ─────────────────────────────────────────────────────────────────────────────

export const codexAdapter: RuntimeAdapter = {
  runtime: 'codex',
  kind: 'tui',
  usesDoctrine: true,

  /**
   * Delivery markers for submitIntoTui (docs/Рантайм codex "Доставка"):
   *   - promptGlyphs ['›'] — codex's input-row arrow (the same stable invariant as
   *     isInputReady's '› ' check; the exact glyph the prompt row starts with).
   *     codex-only, so a stray claude '❯' no longer false-matches.
   *   - pastePatterns '[Pasted text' / '[Image #' — kept identical to claude (the
   *     old transport union applied them to codex too, so this preserves behaviour;
   *     codex's exact paste-land glyph is a live-verify item — the envelope tail-
   *     marker remains the primary landed-signal regardless).
   */
  deliveryMarkers: {
    promptGlyphs: ['›'],
    pastePatterns: [/\[Pasted text/, /\[Image #/],
    ghostTextSgr: ['2', '38;5;246'],
  },

  // codex writes NO prompt-acceptance record — its session-jsonl user-input appears only
  // when the model TURN ingests the message (during a long turn, tens of seconds away;
  // measured ~80s live 2026-06-25). But its input queue is DURABLE: a mid-turn submit is
  // held and processed at the next turn boundary, never lost (verified live — an 80s turn
  // still ingested + replied with the exact probe token, despite the send false-FAILing at
  // the 8s grace). So the flushed socket-ack IS the delivery confirm; a transcript grace
  // only false-FAILs a message that WILL be processed → wrong fallback escalation. A
  // genuinely dead session still fails at the socket-ack. (See RuntimeAdapter.deliveryConfirm.)
  deliveryConfirm: 'socket-ack',

  /**
   * argv = codexBin + (resume --last when spec.resume) + the TUI args +
   * (doctrine via -c when systemPromptFile set) + bypass + extraArgs. Order is
   * the FROZEN contract (types.ts:107); the bash's flag order differs but the
   * resulting flag SET is identical.
   *
   *   - 'resume','--last'  spawner.ts:756 — ONLY when spec.resume; codex picks
   *     the newest session matching cwd itself (resolveResume merely verified one
   *     exists, so this is never a silent fresh fallback). No uuid — codex has no
   *     per-session resume ref the way claude does.
   *   - '--no-alt-screen'  spawner.ts:742 — keep codex on the main screen buffer
   *     so capture-pane sees the live TUI (the alt screen is not captured).
   *   - '-C', spec.cwd  spawner.ts:743 — codex's working-dir flag (the launch
   *     primitive also new-sessions with -c <cwd>; codex needs its own -C too).
   *   - '-c', `model_instructions_file=${spec.systemPromptFile}`  codex-start.sh
   *     :224 — ONLY when set (a tui runtime that usesDoctrine composes one).
   *     Swaps codex's compile-time BASE_INSTRUCTIONS for the merged peer
   *     doctrine; MCP/plugin/AGENTS.md layers stay intact. The path is the bare
   *     unquoted token — launch.launch shell-quotes the whole argv element once.
   *   - '--dangerously-bypass-approvals-and-sandbox'  codex-start.sh:224,
   *     spawner.ts:754 — codex YOLO; a headless peer has no owner to answer
   *     approval prompts and no reason to sandbox below its peer-cwd.
   *   - ...extraArgs  PEER_START_ARGS passthrough (LaunchSpec.extraArgs).
   * NO currency — no marketplace/install/update on this path.
   */
  buildArgv(spec: LaunchSpec, cfg: LaunchAdapterConfig): string[] {
    // Human-approval mode (docs/17). yolo (default) = the YOLO bypass flag (current
    // fleet behavior). gated = NO bypass + `-c approval_policy=on-request` (the model
    // asks before acting → the PreToolUse/PermissionRequest hook intercepts) with
    // `-c sandbox_mode=danger-full-access` — gated gates APPROVALS, it does NOT add a
    // sandbox (workspace-write would sever the loopback-MCP send_to_peer + vault writes;
    // sandboxing is a separate axis, not v1). Session-scoped `-c`, never a host-config edit.
    const gated = spec.approvalMode === 'gated'
    return [
      cfg.codexBin,
      ...(spec.resume ? ['resume', '--last'] : []),
      '--no-alt-screen',
      '-C',
      spec.cwd,
      ...(spec.systemPromptFile
        ? ['-c', `model_instructions_file=${spec.systemPromptFile}`]
        : []),
      ...(gated
        ? ['-c', 'approval_policy=on-request', '-c', 'sandbox_mode=danger-full-access']
        : ['--dangerously-bypass-approvals-and-sandbox']),
      ...(spec.extraArgs ?? []),
    ]
  },

  /**
   * A visible startup dialog → the keys that clear it (watcher.ts:382-400), else
   * null. Update offer is matched first (it can stack ahead of the trust/hooks
   * modals): decline with ['2','Enter']; dir-trust accepts with ['Enter']; hooks
   * -review selects "Trust all and continue" by NUMBER — a single '2'.
   *
   * В41 — hooks-review was a blind ['Down','Enter'] burst: under load a swallowed
   * Down left Enter confirming the WRONG default ("Review hooks" — the panel opens,
   * the wake stalls; the same class claude had and replaced with cursor-verified
   * stepping). CAPTURED LIVE (codex-cli 0.139.0, isolated CODEX_HOME, 03.07): the
   * modal renders numbered options with a moving `›` selector
   *     › 1. Review hooks
   *       2. Trust all and continue
   *       3. Continue without trusting (hooks won't run)
   * and a BARE DIGIT '2' selects AND commits option 2 immediately (no Enter needed;
   * trusted_hash verified written). One key — nothing can be swallowed between two.
   * The capture harness itself reproduced the burst failure live: a repeated Enter
   * on a stale dir-trust frame landed on this modal and opened the review panel.
   */
  bootDialogKeys(pane: string): string[] | null {
    if (codexUpdatePromptActive(pane)) return ['2', 'Enter']
    if (codexDirTrustActive(pane)) return ['Enter']
    if (codexHooksReviewActive(pane)) return ['2']
    return null
  },

  /**
   * GENERIC unknown blocking-modal detector (docs/17 — yolo-robustness). codex carries no known
   * mid-session circuit-breaker (its tool approvals ride the PreToolUse hook under gated, and yolo
   * bypasses them), so it declares no blockingConfirm/nagDismissKeys — but a NON-hookable modal
   * (MCP-elicitation, a future codex prompt) can still surface on screen and hang the pty. This catches
   * that residue structurally (bottom-most `›` is a numbered option + ≥2 options; see modalDetect.ts),
   * excluding the known boot dialogs (owned by the boot-driver). The daemon routes it to the human with
   * explicit button semantics + the timing stuck-gate on top.
   */
  unknownBlockingModal(pane: string): { content: string; option1: string } | null {
    if (isKnownCodexBlockingSignature(pane)) return null
    return detectNumberedModal(pane, CODEX_SELECT_GLYPH)
  },

  /**
   * Ready for the first message iff the codex TUI composer is rendered and no
   * startup screen is still up:
   *   - pane does NOT include 'Press enter to continue' — the update screen (and
   *     other "press enter" startup prompts) is gone (belt-and-suspenders: the
   *     boot loop answers known dialogs via bootDialogKeys BEFORE asking this).
   *   - some line, trimStart, startsWith '› ' — the rendered input arrow at the
   *     start of the composer row. (Codex rotates its top-of-pane tip line, so
   *     the input arrow is the stable ready invariant — not any single tip.)
   *
   * DELIBERATELY no 'OpenAI Codex' splash check (the watcher.codexInputReady
   * heritage requirement, since removed): `resume --last` replays the prior
   * transcript ABOVE the composer, and a history taller than the pane scrolls
   * the splash box off the top of capture-pane — the predicate then stays false
   * for the entire boot deadline while the composer sits ready, failing the wake
   * `never-became-ready` and LOSING the triggering message (observed live with a
   * tall replayed history). A replayed history message also
   * renders with a leading '› ', so this can fire a frame before the composer
   * activates — benign: the paste/Enter queue in the pty and land in the
   * composer, and the ready-gate still verifies a real model turn (activity
   * mtime advance) before declaring READY.
   */
  // mode is accepted for interface parity but ignored: codex's ready marker (the '› '
  // composer arrow) is the same whether or not it launched with the YOLO bypass flag.
  isInputReady(pane: string, _mode?: ApprovalMode): boolean {
    if (pane.includes('Press enter to continue')) return false
    return pane.split(/\r?\n/).some(line => line.trimStart().startsWith('› '))
  },

  /**
   * Newest ~/.codex/sessions/**\/*.jsonl mtimeMs whose session_meta cwd realpath
   * -matches cwd, or null when none (watcher.newestCodexSessionMtime, 214-234).
   * The ready-gate waits for this to strictly advance past baseline; idle
   * accounting reads the same proxy.
   */
  newestActivityMtime(cwd: string): number | null {
    return newestCodexSessionMtime(cwd)
  },

  /**
   * IDLE-accounting signal: the content-timestamp of the last meaningful entry in the active codex
   * session jsonl (newest cwd-matching file), read from its tail. codex entries (event_msg /
   * response_item) carry a top-level `timestamp`, so this reflects real turn activity — immune to a
   * file re-save and to a statusline pane-log tick. null when no cwd-matching session / no timestamp.
   */
  lastTurnMtime(cwd: string): number | null {
    const s = newestCodexSession(cwd)
    return s ? lastTimestampedEntryMs(s.path) : null
  },

  /**
   * Resume preflight (fail-loud — never a silent fresh fallback). Codex resumes
   * via 'resume --last' with NO ref: it matches the newest session for cwd
   * itself, so buildArgv keys on spec.resume alone and there is nothing to
   * resolve. We only verify a candidate session exists — a session_meta.payload
   * .cwd that realpath-matches cwd under ~/.codex/sessions/ (spawner.hasCodex
   * SessionForCwd, 545-569). {ok:true} when one exists (no ref), else {ok:false,
   * reason} so the caller surfaces a real failure instead of a context-less
   * session.
   */
  resolveResume(cwd: string): { ok: boolean; ref?: string; reason?: string } {
    const target = canonicalPath(cwd)
    const root = join(homedir(), '.codex', 'sessions')
    function visit(dir: string): boolean {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return false
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (visit(path)) return true
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        if (canonicalPath(codexSessionCwd(path) ?? '') === target) return true
      }
      return false
    }
    return visit(root)
      ? { ok: true }
      : { ok: false, reason: 'no codex session to resume' }
  },

  /**
   * Map a control command to codex's in-session mechanism (Ф-E, docs/Control-команды).
   *   - interrupt → ['Escape']. SNAPPED LIVE (codex-cli 0.136.0): a SINGLE Escape
   *     interrupts the turn — NOT a double. (Codex's own footer says "esc to
   *     interrupt"; one Escape yields "■ Conversation interrupted". The contract's
   *     open "×1/×2?" is resolved to ×1, same as claude.) Session + context intact.
   *   - compact → type '/compact' then Enter. SNAPPED LIVE (codex-cli
   *     0.138.0): the slash EXISTS now — autocomplete documents it («summarize
   *     conversation to prevent hitting the context limit») and a live run
   *     yields «• Context compacted». The 0.136-era "codex has no /compact"
   *     finding is stale; the mapping is keyboard-identical to claude's.
   *   - anything else → null.
   */
  executeControl(command: ControlCommand): ControlPlan | null {
    if (command.name === 'interrupt') return { sequence: [['Escape']] }
    if (command.name === 'compact') return { sequence: [['-l', '/compact'], ['Enter']], stepDelayMs: 300 }
    return null
  },
}
