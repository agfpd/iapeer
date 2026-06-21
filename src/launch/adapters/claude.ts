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
import type { ControlCommand, ControlPlan, LaunchAdapterConfig, LaunchSpec, RuntimeAdapter } from '../types.ts'

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
  // Project MCP-server approval ("N new MCP servers found in this project", servers
  // pre-checked [✔]) — shown when cwd carries a .mcp.json the config has not yet
  // approved. Suppressed at the source by enableAllProjectMcpServers in
  // <cwd>/.claude/settings.json (init writes it); bootDialogKeys Enter-confirms it as
  // a backstop. Substring matches both "1 new MCP server" and "N new MCP servers".
  'new MCP server',
] as const

function anyBootDialog(pane: string): boolean {
  return CLAUDE_BOOT_DIALOG_MARKERS.some(m => pane.includes(m))
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
    return [
      cfg.claudeBin,
      '--dangerously-skip-permissions',
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
      // Project MCP-server approval (servers pre-checked [✔]; Enter confirms, Esc
      // rejects all). enableAllProjectMcpServers normally suppresses it; this is the
      // backstop. Matches both "1 new MCP server" and "N new MCP servers".
      pane.includes('new MCP server') ||
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
   * Ready for the first message iff the input surface is rendered AND no startup
   * dialog is still up (lifecycle.claudeInputReady, index.ts:272-279;
   * claude-start.sh:365-366):
   *   - '❯' (U+276F) — the TUI input-prompt glyph, present only at the ready
   *     input row, never in the splash art (claude-start.sh:357-360).
   *   - 'bypass permissions on' — the banner --dangerously-skip-permissions
   *     emits once booted past the splash.
   *   - none of the boot dialogs present (a dialog row can also carry '❯').
   */
  isInputReady(pane: string): boolean {
    if (anyBootDialog(pane)) return false
    return pane.includes('❯') && pane.includes('bypass permissions on')
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
