// claude RuntimeAdapter — the "HOW to launch / observe ONE claude session" half
// of the launch contract (src/launch/types.ts). Runtime-agnostic launch.launch
// drives it: argv → boot dialogs → ready marker → activity-proxy ready-gate →
// permission autopilot → resume preflight. Consolidated from three frozen
// sources, with the exact slug fix that already lives in lifecycle:
//
//   - Persistent-Peer/bin/claude-start.sh — argv (292-318: --dangerously-skip-
//     permissions, --disallowedTools AskUserQuestion, --system-prompt-file), the
//     ready-marker (`❯` + dev-channels-gone, 357-371) and the boot dialog answers
//     (the dev-channels "I am using this for local development" Enter, 335-345).
//   - Spawned-Peer/src/spawner.ts — buildClaudeArgv (759-787: same flags +
//     optional --resume <uuid>) and findLatestTranscript (522-538: resume uuid).
//   - iapeer/src/lifecycle/index.ts — claudeInputReady / claudeBootDialog /
//     newestClaudeTranscriptMtime / findLatestClaudeTranscript. This is the
//     canonical port: the slug is realpath(cwd).replace(/[^a-zA-Z0-9]/g,'-') —
//     claude encodes EVERY non-alphanumeric char (not just '/'); the old
//     Spawned-Peer replace(/\//g,'-') silently broke on a cwd carrying '_' or '.'
//     (a mkdtemp temp dir). REUSE this exact logic — do not reintroduce the bug.
//
// NO currency on this path: no marketplace check, no plugin install/update — that
// is install-time (blueprint §0.6 fast-wake), not session bring-up.

import { homedir } from 'os'
import { join } from 'path'
import { readdirSync, realpathSync, statSync } from 'fs'
import type { ApprovalMode, ControlCommand, ControlPlan, LaunchAdapterConfig, LaunchSpec, RuntimeAdapter } from '../types.ts'
import { lastTimestampedEntryMs } from './transcriptTail.ts'
import { detectNumberedModal } from './modalDetect.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Boot dialog + ready markers (lifecycle claudeBootDialog / claudeInputReady)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Markers that a claude startup dialog / picker is on screen — used by isInputReady
 * to GATE delivery (a dialog up ⇒ not ready). The KEYS that clear each live in
 * bootDialogKeys (NOT uniformly Enter — the resume picker must be NAVIGATED, see there):
 *   - 'trust this folder'                      — first-run folder-trust modal.
 *   - 'Allow external CLAUDE.md file imports?' — external-import consent.
 *   - 'I am using this for local development'   — dev-channels accept
 *     (claude-start.sh:337), shown when PEER_START_ARGS carries
 *     --dangerously-load-development-channels.
 *   - 'Resume from summary'      — the resume compact-picker (default cursor =
 *     "summary (recommended)", which compacts; bootDialogKeys steps the cursor to
 *     "full" ONE key per iteration and confirms only after SEEING it there).
 *   - 'Resuming the full session' — the post-select load state (still not ready).
 */
const CLAUDE_BOOT_DIALOG_MARKERS = [
  'trust this folder',
  'Allow external CLAUDE.md file imports?',
  'I am using this for local development',
  'Resume from summary',
  'Resuming the full session',
  // First-run theme picker ("Let's get started. Choose the text style…") — appears
  // on a CLEAN host (fresh config dir) BEFORE the input prompt. NOT removed by
  // --dangerously-skip-permissions; if not cleared the peer never reaches ready.
  'Choose the text style',
  // Bypass-permissions ACCEPT gate ("WARNING: Claude Code running in Bypass
  // Permissions mode"; options "1. No, exit" / "2. Yes, I accept") — shown on a
  // VIRGIN config the FIRST time --dangerously-skip-permissions runs, BEFORE the
  // input prompt. (An earlier note here claimed this screen was "absent in 2.1.181";
  // that was a NON-VIRGIN observation — the host had already accepted it once, so it
  // was masked. On a truly virgin config it IS shown and BLOCKS the boot — verified
  // live, claude 2.1.183 via tmux. bootDialogKeys steps the cursor to "2. Yes, I
  // accept" and confirms; a bare Enter would hit the "1. No, exit" DEFAULT and kill
  // the peer.) Once accepted, claude records it natively and the ready banner is the
  // lowercase "bypass permissions on" (a DISTINCT string), so this marker vanishes —
  // it never falsely traps isInputReady, and a re-launch is dialog-free (verified).
  'Bypass Permissions mode',
] as const

// В39 — Project MCP-server approval ("N new MCP servers found in this project", servers pre-checked
// [✔]). This one is NOT a plain substring marker: agents on this fleet mention "new MCP server" in
// NORMAL conversation, and a resumed session replays that tail into the viewport → the old substring
// gated isInputReady forever, the wake failed 'never-became-ready', the message was lost (live
// incident). Require the dialog's DISTINGUISHING context ("found in this project") too — a
// conversational mention of the topic phrase does not carry it. Suppressed at the source by
// enableAllProjectMcpServers (init); Enter-confirmed here as a backstop.
function mcpApprovalActive(pane: string): boolean {
  return pane.includes('new MCP server') && pane.includes('found in')
}

function anyBootDialog(pane: string): boolean {
  return CLAUDE_BOOT_DIALOG_MARKERS.some(m => pane.includes(m)) || mcpApprovalActive(pane)
}

// В40 — the fullscreen-renderer nag needles are BUILT from fragments so this SOURCE FILE never contains
// the verbatim modal text. A nag-watcher reads a peer's live VIEWPORT; if this file's text (a peer
// editing/reviewing it) carried the contiguous phrase, viewing it would self-trigger the very bug — which
// is exactly what happened live while this fix was being written. Split literals keep the match working at
// runtime while making the source inert.
const NAG_TITLE = 'Try the new fullscreen render' + 'er?'
const NAG_OPTION_YES = 'Yes, ' + 'try it'
/** Does the pane carry the fullscreen-renderer nag at all (cheap gate)? */
function isFullscreenNagText(pane: string): boolean {
  return pane.includes(NAG_TITLE)
}
/** Is THIS row the modal's LIVE selected option (cursor `❯` on "1. Yes, try it")? The bottom-most `❯`
 *  row of a live modal is this; a mere quote of the modal has the ready composer `❯` below it instead. */
function isFullscreenNagOptionRow(row: string): boolean {
  return row.includes('❯') && (row.includes(NAG_OPTION_YES) || /❯\s*1\.\s*Yes/.test(row))
}

// Dangerous-rm circuit-breaker needles — split-literal (same В40 discipline: a peer reviewing THIS
// adapter / the doctrine must not self-trigger). Verified verbatim against claude 2.1.201 (Mach-O
// strings + a live pty capture): the breaker fires for `rm` AND `rmdir` on the cwd/an ancestor, above
// the permission layer, with a `❯ 1. Yes / 2. No` select whose default cursor is on YES.
const RM_ANCESTOR = 'working directory or its ' + 'ancestor'
const RM_PROCEED = 'Do you want to ' + 'proceed?'
/** FULL-signature + position match for the LIVE dangerous-rm/rmdir confirm (not a mere quote of it):
 *  the breaker phrase + the proceed prompt + the bottom-most `❯` cursor sitting on the "1. Yes" option. */
function isDangerousRmPrompt(pane: string): boolean {
  if (!pane.includes(RM_ANCESTOR) || !pane.includes(RM_PROCEED)) return false
  let lastCursorRow = ''
  for (const line of pane.split(/\r?\n/)) if (line.includes('❯')) lastCursorRow = line
  return /❯\s*1\.\s*Yes\b/.test(lastCursorRow) // live select on Yes; a quote has the ready composer `❯` below
}
/** Best-effort one-line trace of WHAT the breaker guarded — the rm/rmdir command line if the pane still
 *  shows the "Bash command" block, plus the target path printed after "…ancestor:". Owner's post-hoc
 *  audit hook (which peer / which command / when — `when` + `who` are added by the daemon). */
function dangerousRmDetail(pane: string): string {
  const lines = pane.split(/\r?\n/).map(l => l.trim())
  let target = ''
  const ai = lines.findIndex(l => l.includes(RM_ANCESTOR))
  if (ai >= 0) for (let j = ai + 1; j < lines.length; j++) if (lines[j]) { target = lines[j]; break }
  // ANCHORED to a line that STARTS with rm/rmdir (the "Bash command" block's command line, e.g.
  // "rm -rf /path"); never a mid-line match, or the composer's echoed user prompt ("…run: rm -rf")
  // would be captured instead of the actual command.
  const cmd = lines.find(l => /^rm(?:dir)?\s+\S/.test(l)) ?? ''
  return [cmd && `cmd=${JSON.stringify(cmd)}`, target && `target=${JSON.stringify(target)}`].filter(Boolean).join(' ') || '(unparsed)'
}

// Standard command-approval prompt (claude 2.1.201 — the NO-RULE-MATCH passthrough / file-access "ask")
// needles. This is the prompt a peer sees when it is NOT in bypass — i.e. GATED mode, OR a yolo peer
// whose bypass the runtime disabled mid-session (the `tengu_disable_bypass_permissions_mode` feature
// gate / `disableBypassPermissionsMode` setting). Under GENUINE bypass this prompt never surfaces (only
// the dangerous-rm breaker does — verified from the 2.1.201 permission-gate: bypass auto-allows every
// `ask` except "Dangerous rm/rmdir operation"). The live render (captured via a nested pty, default
// mode) is a THREE-option select — "❯ 1. Yes / 2. Yes, and <don't ask again | always allow …> / 3. No"
// under "Do you want to proceed?" — which is what distinguishes it from the dangerous-rm breaker's
// TWO-option "1. Yes / 2. No". Split-literal (В40): a peer reviewing this adapter must not self-trigger.
const ORG_POLICY_APPROVAL = 'organization requires ' + 'approval' // MCP org-restriction — NEVER auto-pressed
const BASH_CMD_HEADER = 'Bash' + ' command'
/** FULL-signature + position match for the LIVE standard command-approval prompt. Returns true ONLY for
 *  the 3-option layout with the bottom-most `❯` cursor on "1. Yes" — so a mere QUOTE of the prompt (ready
 *  composer `❯` below) never matches. Two hard exclusions satisfy the owner's NARROW-matcher rule:
 *    · org-policy ("Your organization requires approval for this tool", an MCP restriction) → excluded,
 *      the owner's org rule is HUMAN-only and must never be auto-pressed;
 *    · the dangerous-rm breaker → handled by its own taxonomy (checked first in blockingConfirm), and
 *      structurally excluded here anyway (it is a 2-option "2. No", never "2. Yes," + "3. No"). */
function isCommandApprovalPrompt(pane: string): boolean {
  if (!pane.includes(RM_PROCEED)) return false // shares "Do you want to proceed?" with the rm breaker
  if (pane.includes(ORG_POLICY_APPROVAL)) return false // org-policy → never auto-Yes
  if (isDangerousRmPrompt(pane)) return false // its own taxonomy owns this pane
  // 3-option standard layout: option 2 is a "Yes," variant + option 3 is "No" (the rm breaker is
  // 2-option "1. Yes / 2. No", so it fails BOTH tests — no overlap).
  if (!/(^|\n)\s*2\.\s*Yes/.test(pane)) return false
  if (!/(^|\n)\s*3\.\s*No\b/.test(pane)) return false
  // live-modal position gate: the bottom-most `❯` row must sit on "1. Yes".
  let lastCursorRow = ''
  for (const line of pane.split(/\r?\n/)) if (line.includes('❯')) lastCursorRow = line
  return /❯\s*1\.\s*Yes\b/.test(lastCursorRow)
}
/** Best-effort trace of the command the approval prompt guarded — the first non-blank line under the
 *  "Bash command" block header. Mirrors dangerousRmDetail's post-hoc audit purpose. */
function commandApprovalDetail(pane: string): string {
  const lines = pane.split(/\r?\n/)
  const hi = lines.findIndex(l => l.trim() === BASH_CMD_HEADER)
  if (hi >= 0) for (let j = hi + 1; j < lines.length; j++) { const t = lines[j].trim(); if (t) return `cmd=${JSON.stringify(t)}` }
  return '(unparsed)'
}

// ORG-POLICY approval prompt (docs/17 — yolo-robustness). "Your organization requires approval for this
// tool" is an MCP org-restriction: a barrier ABOVE the peer that the owner's rule says is HUMAN-only —
// NEVER auto-pressed on ANY peer (yolo included). It was previously EXCLUDED from isCommandApprovalPrompt
// (→ fell through to 'none' → a yolo peer HUNG on it). Now it is its OWN recognized-but-always-human tier
// (blockingConfirm alwaysHuman:true) so it routes to the broker under BOTH modes with the SAME 3-option
// command-approval layout keys (Allow=1.Yes, Deny=3.No). If a future org-policy render is NOT this
// 3-option layout, isOrgPolicyPrompt returns false and the GENERIC unknownBlockingModal catches it
// instead (→ human with Esc-deny) — either way it reaches a human, never auto-Yes.
/** FULL-signature + position match for the org-policy approval prompt: the org needle + the 3-option
 *  "proceed?" select with the bottom-most `❯` cursor on "1. Yes" (a live modal, not a quote). */
function isOrgPolicyPrompt(pane: string): boolean {
  if (!pane.includes(RM_PROCEED)) return false
  if (!pane.includes(ORG_POLICY_APPROVAL)) return false
  if (isDangerousRmPrompt(pane)) return false // 2-option breaker owns its pane
  if (!/(^|\n)\s*2\.\s*Yes/.test(pane)) return false
  if (!/(^|\n)\s*3\.\s*No\b/.test(pane)) return false
  let lastCursorRow = ''
  for (const line of pane.split(/\r?\n/)) if (line.includes('❯')) lastCursorRow = line
  return /❯\s*1\.\s*Yes\b/.test(lastCursorRow)
}

// claude's select-modal cursor glyph (U+276F) — the same glyph isInputReady / the nag matcher key on.
const CLAUDE_SELECT_GLYPH = '❯'
/** Does the pane carry a KNOWN claude blocking signature (dangerous-rm / command-approval / org-policy /
 *  fullscreen-nag)? unknownBlockingModal returns null for these so it fires ONLY for the unrecognized
 *  residue — the daemon also checks them first, but this keeps the detector self-contained + testable. */
function isKnownClaudeBlockingSignature(pane: string): boolean {
  // anyBootDialog: the numbered boot selects (resume-picker / bypass-accept / theme / MCP-approval) are
  // owned by the boot-driver (nextBootAction) — never treat them as an "unknown" mid-session modal.
  return (
    anyBootDialog(pane) ||
    isDangerousRmPrompt(pane) ||
    isCommandApprovalPrompt(pane) ||
    isOrgPolicyPrompt(pane) ||
    isFullscreenNagText(pane)
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript activity proxy + resume uuid (lifecycle port, claude slug fix)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Claude's project-dir slug: realpath(cwd) with EVERY non-alphanumeric char
 * replaced by '-' (index.ts:232-245). NOT just '/' — a segment with '_' or '.'
 * is slugged too; the Spawned-Peer canon's replace(/\//g,'-') silently worked
 * only because the live fleet's ~/Peers/<name> paths have none, then broke on a
 * mkdtemp temp cwd. realpath first so a symlinked cwd maps to the dir claude
 * actually wrote (a stale path falls through to the original string).
 */
export function transcriptSlug(workDir: string): string {
  let phys = workDir
  try {
    phys = realpathSync(workDir)
  } catch {
    /* stale path — slug the original */
  }
  return phys.replace(/[^a-zA-Z0-9]/g, '-')
}

/** The base dir holding all claude project transcript slugs (~/.claude/projects).
 *  Exported so a cwd-move (peer folder rename) can relocate the slug dir from the
 *  SINGLE source of the slug encoding, never a re-implementation that could drift. */
export function claudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

export function transcriptDir(workDir: string): string {
  return join(claudeProjectsRoot(), transcriptSlug(workDir))
}

// ─────────────────────────────────────────────────────────────────────────────
// claudeAdapter
// ─────────────────────────────────────────────────────────────────────────────

export const claudeAdapter: RuntimeAdapter = {
  runtime: 'claude',
  kind: 'tui',
  usesDoctrine: true,

  /**
   * Delivery markers for submitIntoTui (moved out of transport's PROMPT_GLYPHS
   * union into the adapter; docs/Рантайм claude "Доставка"):
   *   - promptGlyphs ['❯'] — the same U+276F input-prompt glyph as isInputReady;
   *     submitIntoTui finds the prompt row by it. claude-only (codex uses '›'), so
   *     a stray codex glyph in a claude pane no longer false-matches.
   *   - pastePatterns '[Pasted text' / '[Image #' — claude's bracketed-paste land
   *     confirmations (claude-start.sh / transport.ts:191), checked alongside the
   *     envelope tail-marker.
   */
  deliveryMarkers: {
    promptGlyphs: ['❯'],
    pastePatterns: [/\[Pasted text/, /\[Image #/],
    ghostTextSgr: ['2', '38;5;246'],
  },

  // claude logs an accepted paste PROMPTLY (sub-second: a queue-operation when busy,
  // the user-turn when idle), so the message-specific transcript confirm is both cheap
  // and a swallow-guard (the false-OK class). Keep it. (See RuntimeAdapter.deliveryConfirm.)
  deliveryConfirm: 'transcript',

  /**
   * argv = claudeBin + headless flags + (system-prompt-file when set) +
   * (--continue when resuming) + extraArgs.
   *
   *   - '--dangerously-skip-permissions'  claude-start.sh:318, spawner.ts:776 —
   *     headless peer has no interactive owner to grant per-tool permission.
   *   - '--disallowedTools','AskUserQuestion'  claude-start.sh:313/316,
   *     spawner.ts:777 — AskUserQuestion would render in a TUI no headless peer
   *     owner watches; the question goes "into the void". Default is the literal
   *     'AskUserQuestion'; the per-peer override (PEER_DISALLOWED_TOOLS empty =
   *     allow all) is install-time launch.env, not this path.
   *   - '--add-dir','/'  grants the file/edit/bash tools access OUTSIDE cwd (the
   *     CLI equivalent of settings `permissions.additionalDirectories`). A peer
   *     reads/writes its memory vault (often an iCloud Obsidian dir) and ~/.iapeer,
   *     both outside cwd. Passing it as a LAUNCH FLAG means a clean host needs NO
   *     manual `additionalDirectories` in the user's ~/.claude/settings.json — the
   *     requirement travels with the launch, reversible, no user-file mutation.
   *     (OS-level access to TCC-protected dirs — iCloud / Desktop / Documents — is
   *     a SEPARATE macOS grant, not coverable by any flag; onboard instructs it.)
   *   - '--system-prompt-file', spec.systemPromptFile  claude-start.sh:318 —
   *     ONLY when set (a tui runtime that usesDoctrine composes one). Swaps the
   *     CC coding baseline for the merged peer doctrine; plugin/MCP/CLAUDE.md
   *     layers stay intact (claude-start.sh:293-303).
   *   - '--continue' when spec.resume — continue the cwd's MOST-RECENT session
   *     (one session-lineage per peer cwd, so most-recent == the warm peer's
   *     session, == the newest transcript resolveResume validated). NOT
   *     '--resume <uuid>': in claude 2.1.169 `--resume <arg>` treats arg as a
   *     SEARCH QUERY (opens a session-list picker), not a session-id — so a bare
   *     uuid no longer resumes directly. `--continue` resumes the last session
   *     with no session-list step. The summary-vs-full compact picker still
   *     appears (handled in bootDialogKeys: pick "full", never the recommended
   *     summary). resolveResume still gates resume-vs-fresh upstream (fail-loud).
   *   - ...extraArgs  PEER_START_ARGS passthrough (LaunchSpec.extraArgs).
   * NO currency — no marketplace/install/update on this path.
   */
  buildArgv(spec: LaunchSpec, cfg: LaunchAdapterConfig): string[] {
    // Human-approval mode (docs/17). yolo (default) = '--dangerously-skip-permissions'
    // (headless bypass, current fleet behavior). gated = NO bypass + an EXPLICIT
    // '--permission-mode default' so the base is deterministic (never inherits an
    // acceptEdits/bypass defaultMode from settings): the runtime's permission layer is
    // active as a fail-SAFE backstop, and the separately-installed PreToolUse hook is
    // the primary interceptor (it fires regardless of mode — verified live 2.1.201).
    const gated = spec.approvalMode === 'gated'
    return [
      cfg.claudeBin,
      ...(gated ? ['--permission-mode', 'default'] : ['--dangerously-skip-permissions']),
      '--disallowedTools',
      'AskUserQuestion',
      '--add-dir',
      '/',
      ...(spec.systemPromptFile ? ['--system-prompt-file', spec.systemPromptFile] : []),
      ...(spec.resume ? ['--continue'] : []),
      ...(spec.extraArgs ?? []),
    ]
  },

  /**
   * Map a visible startup dialog to the keys that clear it correctly:
   *
   *   - CURSOR-VERIFIED two-step menus ('Resume from summary …' AND 'Bypass
   *     Permissions mode') → step Down, confirm ONLY once the captured pane proves
   *     the cursor sits on "2.". Both menus share one hazard: their DEFAULT cursor is
   *     the WRONG option, so a blind Enter picks it.
   *       · Resume: default "1. Resume from summary (recommended)" COMPACTS the
   *         session (claude runs that choice as an internal /compact) — a resume must
   *         not compact.
   *       · Bypass: default "1. No, exit" makes the peer EXIT (die). "2. Yes, I
   *         accept" is the proceed path. (Virgin-config gate the first time
   *         --dangerously-skip-permissions runs; once accepted claude persists it.)
   *     The original blind ['Down','Enter'] burst (0e67e1f) put BOTH keys in one pty
   *     chunk; under load the TUI dropped the Down and the Enter confirmed the DEFAULT
   *     (proven for resume: pane frame ❯ on option 1 → "❯ /compact"). Fix: ONE key
   *     per boot-iteration — Down while the cursor is NOT yet on "2.", Enter ONLY
   *     after the captured pane PROVES it ("❯ 2."). A swallowed Down self-heals next
   *     iteration; Enter can never hit the bad default. If the layout ever changes the
   *     loop Downs until the boot deadline and the wake fails LOUD.
   *   - SINGLE-CONFIRM modals (folder-trust / external-import / dev-channels / theme /
   *     project MCP-server approval) → ['Enter']: the default-highlighted option IS
   *     the proceed path, so a bare Enter clears each. The MCP approval pre-checks the
   *     servers [✔] (Enter enables them, Esc rejects all) — it is also suppressed at
   *     the source by enableAllProjectMcpServers (init), so the Enter here is a
   *     backstop. (claude-start.sh:341.)
   *   - anything else (incl. the post-select "Resuming…" load state) → null (wait).
   */
  bootDialogKeys(pane: string): string[] | null {
    if (pane.includes('Resume from summary') || pane.includes('Bypass Permissions mode')) {
      return /❯\s*2\./.test(pane) ? ['Enter'] : ['Down']
    }
    if (
      pane.includes('trust this folder') ||
      pane.includes('Allow external CLAUDE.md file imports?') ||
      pane.includes('I am using this for local development') ||
      // Project MCP-server approval (servers pre-checked [✔]; Enter confirms, Esc rejects all).
      // enableAllProjectMcpServers normally suppresses it; this is the backstop. В39: full-signature
      // (topic + "found in") so a conversational mention never triggers a stray Enter.
      mcpApprovalActive(pane) ||
      // First-run theme picker (clean host): the default-highlighted row is always a
      // valid theme (any choice is harmless for a headless peer), so a bare Enter
      // accepts it. Without this the picker blocks the boot forever on a fresh host.
      // NOTE: the LOGIN method picker that can follow on an UNAUTHENTICATED host is
      // deliberately NOT auto-answered — selecting subscription opens a browser OAuth
      // flow no headless peer can complete. Login is an onboard PREREQUISITE
      // (ANTHROPIC_API_KEY or a one-time `claude login`); a never-authed host fails
      // the wake LOUD at the boot deadline rather than auto-entering a dead OAuth.
      pane.includes('Choose the text style')
    ) {
      return ['Enter']
    }
    return null
  },

  /**
   * MID-SESSION nag/upsell auto-dismiss (livability — distinct from bootDialogKeys, which the supervisor
   * drives only until ready). claude pops a ONE-TIME interactive upsell modal AFTER the session is live —
   * the fullscreen-renderer offer — that BLOCKS a headless peer (no human to answer). Its default cursor
   * is on the ACCEPT option, so a bare Enter would enable the alt-screen renderer and change the surface
   * the pane-log model / composer-occupancy / ready-gate all read off. We DECLINE by selecting the "not
   * now" option ('2' then Enter — '2' is emitted verbatim, not a named key). VERIFIED-SAFE on the live
   * fleet ('2'+Enter cleared it on boris/doc; an arrow-step+Enter mis-fired into fullscreen on scriber; Esc/
   * 'n' unverified) — so this is the ONLY accepted sequence.
   *
   * В40 — the match is POSITION-based, NOT phrase-based: the needles are built from fragments (this file
   * never carries the verbatim modal text, or a peer editing/reviewing it would self-trigger — observed
   * live), and it fires ONLY when the BOTTOM-MOST cursor row is the modal's live option (a mere quote of
   * the modal has the ready composer below it). NB text-matching still cannot fully distinguish a live
   * claude modal from an agent RENDERING the modal glyphs at its viewport bottom — the correct fix is a
   * rendering-level signal (the alt-screen switch), tracked as a HIGH-priority follow-up (В59).
   */
  nagDismissKeys(pane: string): string[] | null {
    // В40 — a text-only match fired '2'+Enter into a LIVE composer whenever the peer merely displayed the
    // modal text (a code review of this file, a forwarded bug report — or, live-observed, the peer editing
    // THIS adapter). Discriminate by POSITION, not phrases: claude's live modal REPLACES the composer, so
    // the BOTTOM-MOST cursor row (`❯`) sits on the modal's option. A mere quote of the modal has the READY
    // composer `❯` rendered BELOW it as the bottom-most cursor row. So: fire only when the last `❯`-bearing
    // row is the modal's selected option — a displayed quote never is.
    if (!isFullscreenNagText(pane)) return null
    let lastCursorRow = ''
    for (const line of pane.split(/\r?\n/)) if (line.includes('❯')) lastCursorRow = line
    // the live modal's bottom-most cursor sits on option 1 ("Yes, try it"); the ready composer's `❯` does
    // not carry the option text, so a quote (composer below) fails this.
    return isFullscreenNagOptionRow(lastCursorRow) ? ['2', 'Enter'] : null
  },

  /**
   * Blocking-confirm circuit-breaker (RuntimeAdapter.blockingConfirm). Unlike the fullscreen nag
   * (benign upsell → DECLINE), these guards hang a headless peer forever with no human to answer.
   * Owner decision (Артур, 04.07): auto-press YES — peers run on bypass, so this only restores the
   * pre-2.1.x status quo, and a hang is real recurring harm. Two signatures are matched, most-specific
   * first, each with its own taxonomy so the supervisor's audit log and (later) the human-approval
   * broker can tell them apart:
   *   1. 'dangerous-rm' — the rm/rmdir breaker that sits ABOVE `--dangerously-skip-permissions` (the
   *      ONLY prompt that surfaces under genuine bypass). Default cursor on "1. Yes" (verified live).
   *   2. 'command-approval' — the STANDARD 3-option approval prompt, surfaced when the peer is NOT in
   *      bypass: gated mode, or a yolo peer whose bypass the runtime disabled mid-session (feature gate
   *      / setting). Auto-Yes keeps a yolo peer alive; a gated peer is routed to the human broker by the
   *      supervisor (Unit 4, mode-aware). Org-policy ("Your organization requires approval for this
   *      tool") is EXCLUDED by the matcher — the owner's org rule is never auto-pressed.
   * Both AFFIRM with ['1','Enter'] (the position-robust affirmative — cursor already on "1. Yes"); the
   * DECLINE keys differ by layout: dangerous-rm is a 2-option "1.Yes/2.No" → ['2','Enter']; command-
   * approval is a 3-option "1.Yes/2.Yes,…/3.No" → ['3','Enter']. The supervisor presses `keys` (yolo
   * auto-Yes / gated-approved) or `denyKeys` (gated-denied / broker fail-safe). Each carries a one-line
   * command/target trace for the audit + broker content. NB deliberately NOT a "smart" safe-decline —
   * the gated human-approval path lands via the daemon broker (docs/17, Unit 4).
   */
  blockingConfirm(pane: string): { keys: string[]; denyKeys: string[]; taxonomy: string; detail: string; alwaysHuman?: boolean } | null {
    if (isDangerousRmPrompt(pane)) return { keys: ['1', 'Enter'], denyKeys: ['2', 'Enter'], taxonomy: 'dangerous-rm', detail: dangerousRmDetail(pane) }
    if (isCommandApprovalPrompt(pane)) return { keys: ['1', 'Enter'], denyKeys: ['3', 'Enter'], taxonomy: 'command-approval', detail: commandApprovalDetail(pane) }
    // Org-policy: recognized, but NEVER auto-Yes — always to the human (both modes). Same 3-option keys.
    if (isOrgPolicyPrompt(pane)) return { keys: ['1', 'Enter'], denyKeys: ['3', 'Enter'], taxonomy: 'org-policy', detail: commandApprovalDetail(pane), alwaysHuman: true }
    return null
  },

  /**
   * GENERIC unknown blocking-modal detector (docs/17 — yolo-robustness). Fires for a numbered-select
   * modal that halts the pty but matches NONE of the known signatures above (a new modal we did not
   * foresee — the class that hung a live yolo peer). Returns null for the known signatures (checked by
   * isKnownClaudeBlockingSignature) so the daemon routes those through their own tiers. The verbatim
   * block + option-1 label let the daemon give the human EXPLICIT button semantics (Allow presses
   * option 1 = "<option1>", Deny cancels via Esc). Detection is structural (bottom-most `❯` is a
   * numbered option + ≥2 options) — see modalDetect.ts; the daemon's timing stuck-gate composes on top.
   */
  unknownBlockingModal(pane: string): { content: string; option1: string } | null {
    if (isKnownClaudeBlockingSignature(pane)) return null
    return detectNumberedModal(pane, CLAUDE_SELECT_GLYPH)
  },

  /**
   * Ready for the first message iff the input surface is rendered AND no startup
   * dialog is still up (lifecycle.claudeInputReady, index.ts:272-279;
   * claude-start.sh:365-366):
   *   - '❯' (U+276F) — the TUI input-prompt glyph, present only at the ready
   *     input row, never in the splash art (claude-start.sh:357-360).
   *   - 'bypass permissions on' — the banner --dangerously-skip-permissions
   *     emits once booted past the splash (YOLO mode only).
   *   - none of the boot dialogs present (a dialog row can also carry '❯').
   *
   * GATED (docs/17): the peer launches WITHOUT --dangerously-skip-permissions, so the
   * 'bypass permissions on' banner is ABSENT (verified live 2.1.201 — the no-bypass
   * ready pane is '❯ Try "edit <filepath> to…"', no banner). The ready signal is then
   * the composer '❯' with every boot dialog cleared. This branch is evaluated ONLY at
   * BOOT (waitHostReady / the boot-driver), before any tool runs — so a mid-session
   * '❯'-bearing modal (dangerous-rm / nag) cannot false-positive it.
   */
  isInputReady(pane: string, mode?: ApprovalMode): boolean {
    if (anyBootDialog(pane)) return false
    if (!pane.includes('❯')) return false
    return mode === 'gated' ? true : pane.includes('bypass permissions on')
  },

  /**
   * Newest ~/.claude/projects/<slug>/*.jsonl mtimeMs, or null when the dir is
   * absent / empty (index.ts:247-266). The ready-gate waits for this to strictly
   * advance past baseline (model produced its first turn); idle accounting reads
   * the same proxy. slug = transcriptSlug(cwd) (the claude non-alnum encoding).
   */
  newestActivityMtime(cwd: string): number | null {
    let entries: string[]
    try {
      entries = readdirSync(transcriptDir(cwd))
    } catch {
      return null
    }
    let newest = 0
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      try {
        const mt = statSync(join(transcriptDir(cwd), name)).mtimeMs
        if (mt > newest) newest = mt
      } catch {
        /* race — entry vanished between readdir and stat */
      }
    }
    return newest > 0 ? newest : null
  },

  /**
   * IDLE-accounting signal: the content-timestamp of the last meaningful entry in the ACTIVE transcript
   * (newest .jsonl by file mtime), read from its tail. Immune to the file re-save (file-mtime is fresh
   * but the last ENTRY is not) and to the statusline pane-log tick (the transcript is untouched by a
   * status redraw). null when the dir is absent/empty or no timestamped entry sits in the tail.
   */
  lastTurnMtime(cwd: string): number | null {
    let entries: string[]
    try {
      entries = readdirSync(transcriptDir(cwd))
    } catch {
      return null
    }
    let best = { path: '', mt: 0 }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      try {
        const path = join(transcriptDir(cwd), name)
        const mt = statSync(path).mtimeMs
        if (mt > best.mt) best = { path, mt }
      } catch {
        /* race */
      }
    }
    return best.path ? lastTimestampedEntryMs(best.path) : null
  },

  /**
   * В58 — newest FILE mtime among the session's CHILD workflow/subagent transcripts, or null when there
   * are none. Claude writes them under `~/.claude/projects/<slug>/<session-uuid>/subagents/**\/agent-*.jsonl`
   * (a plain subagent) and `<session-uuid>/subagents/workflows/<wf>/agent-*.jsonl` (a workflow subagent),
   * appending continuously while the child runs — so a fresh mtime here means the peer is actively
   * driving a workflow even though it makes no turns of its OWN (lastTurnMtime is stale). superviseTick
   * folds this into the idle proxy so a peer on a long (>1h) workflow is not idle-reaped mid-work. Bounded
   * recursive walk; a super-fresh file (< 60s) short-circuits so the common active-workflow case is cheap.
   */
  childActivityMtime(cwd: string): number | null {
    const root = transcriptDir(cwd)
    let sessions: string[]
    try {
      sessions = readdirSync(root)
    } catch {
      return null
    }
    let newest = 0
    const freshFloor = Date.now() - 60_000 // any file newer than this is "definitely active" → stop early
    const walk = (dir: string, depth: number): boolean => {
      if (depth > 4) return false // <session>/subagents/workflows/<wf>/agent-*.jsonl — bounded
      let items: import('fs').Dirent[]
      try {
        items = readdirSync(dir, { withFileTypes: true })
      } catch {
        return false
      }
      for (const it of items) {
        const p = join(dir, it.name)
        if (it.isDirectory()) {
          if (walk(p, depth + 1)) return true
        } else if (it.isFile() && it.name.endsWith('.jsonl')) {
          try {
            const mt = statSync(p).mtimeMs
            if (mt > newest) newest = mt
            if (mt > freshFloor) return true // active work found — no need to scan the rest
          } catch {
            /* race — entry vanished */
          }
        }
      }
      return false
    }
    for (const s of sessions) {
      if (walk(join(root, s, 'subagents'), 0)) break
    }
    return newest > 0 ? newest : null
  },

  /**
   * Resume preflight (fail-loud — never a silent fresh fallback): resolve the
   * newest transcript uuid for cwd via the claude-slug dir scan (lifecycle.
   * findLatestClaudeTranscript / spawner.findLatestTranscript). {ok:true, ref}
   * when one exists, else {ok:false, reason:'no transcript to resume'} so the
   * caller surfaces a real failure instead of starting a context-less session.
   */
  resolveResume(cwd: string): { ok: boolean; ref?: string; reason?: string } {
    let entries: string[]
    try {
      entries = readdirSync(transcriptDir(cwd))
    } catch {
      return { ok: false, reason: 'no transcript to resume' }
    }
    let best: { name: string; mt: number } | null = null
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      try {
        const mt = statSync(join(transcriptDir(cwd), name)).mtimeMs
        if (!best || mt > best.mt) best = { name, mt }
      } catch {
        /* race */
      }
    }
    if (!best) return { ok: false, reason: 'no transcript to resume' }
    return { ok: true, ref: best.name.replace(/\.jsonl$/, '') }
  },

  /**
   * Map a control command to claude's in-session mechanism (Ф-E, docs/Control-команды
   * + docs/TUI-взаимодействие):
   *   - interrupt → ['Escape'] (claude interrupts the current turn with ONE Escape;
   *     the session + context stay intact — distinct from the `stop` verb which halts
   *     the session). Interrupts a runaway turn without losing context.
   *   - compact → type '/compact' then Enter (claude's context-compaction slash).
   *   - anything else → null (unsupported → explicit refusal upstream).
   */
  executeControl(command: ControlCommand): ControlPlan | null {
    if (command.name === 'interrupt') return { sequence: [['Escape']] }
    if (command.name === 'compact') return { sequence: [['-l', '/compact'], ['Enter']], stepDelayMs: 300 }
    return null
  },
}
