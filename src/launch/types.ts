// Launch — the single session-bring-up primitive and the per-runtime adapter
// contract. launch.launch is runtime-AGNOSTIC (env + argv + tmux new-session +
// pipe-pane + self-TTL + boot + ready-gate + first-message delivery); the
// runtime specifics (argv flags, system-prompt mechanism, boot dialogs, ready
// markers, activity proxy, permission dialogs, resume) live behind RuntimeAdapter.
//
// Ownership split (blueprint §1, §7): launch = HOW to bring up ONE session;
// lifecycle = WHEN / HOW MANY (wake/lock/reap/supervise). lifecycle.wakeOrSpawn
// calls launch.launch; launch never decides whether or when to wake. The launch
// path carries NO currency (no marketplace/plugin update) — that is install-time
// (blueprint §0.6 fast-wake).
//
// This interface is FROZEN here (single author) so the per-runtime adapters can
// be implemented independently against a known contract.

import type { Intelligence, Runtime } from '../core/constants.ts'
import type { PublicPeerSummary } from '../registry/index.ts'

export type { PublicPeerSummary } from '../registry/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// composeSystemPrompt — the layered Канал-A merge (docs/Сборка системного
// промпта — слои и каналы.md). Five layers, general → specific (local overrides
// global):
//   1. System YAML (identity + host facts) — jq-GOLDEN, byte-for-byte.
//   2. iapeer doctrine: ~/.iapeer/IAPEER.md (global) + <cwd>/.iapeer/IAPEER.md (local).
//   3. Normalized peer registry (publicPeerSummary, exactly 5 fields).
//   4. Plugin user-settings: every OTHER <DOMAIN>.md at the .iapeer/ root, global
//      + local merged per domain. Custom files (SPAWNER_INSTRUCTIONS.md, …) flow
//      in organically here — no special-casing.
//   5. Doctrine fragments: every `*.md` in the `.iapeer/fragments/` subdir, global
//      (~/.iapeer/fragments/) + local (<cwd>/.iapeer/fragments/) merged per stem.
//      PRIMITIVE-owned, machine-regenerated (e.g. a memory provider's guide + note index, …)
//      — a dedicated namespace kept OUT of the hand-authored IAPEER.md doctrine so
//      the auto-writer and the human writer never share a file. Sits LAST: the most
//      volatile layer, so edits to it never disturb the stable prefix above.
// composeSystemPrompt is a PURE renderer over already-gathered data; the FS
// discovery lives in gatherPromptInput (mirrors the bash split: shell read the
// files, the renderer just laid out bytes).
// ─────────────────────────────────────────────────────────────────────────────

/** One merged block: the global + local halves of a single stem (either may be
 *  absent), used for BOTH Layer 4 (`<DOMAIN>.md` at the .iapeer/ root) and Layer 5
 *  (`<STEM>.md` in .iapeer/fragments/). `domain` is the filename stem, used only
 *  for stable ordering — it is NOT emitted. Within a block global precedes local
 *  (general → specific), and each half is rendered as its OWN per-file section
 *  prefixed by a path marker (`globalPath` / `localPath`) — the assembly is now
 *  per-file, not an organic stem-merge. */
export interface PromptDomainBlock {
  domain: string
  /** Global half content (general): ~/.iapeer/<DOMAIN>.md or ~/.iapeer/fragments/<STEM>.md. */
  global?: string
  /** Local half content (specific — overrides global): <cwd>/.iapeer/… counterpart. */
  local?: string
  /** Display path for the global half's marker (HOME abbreviated to ~). Absent →
   *  no marker (pure-renderer callers). */
  globalPath?: string
  /** Display path for the local half's marker. */
  localPath?: string
}

export interface ComposePromptInput {
  personality: string
  description: string
  cwd: string
  /** System facts (claude-start.sh:228-247). */
  platform: string
  osVersion: string
  user: string
  hostname: string
  today: string
  /** Layer 2 local: <cwd>/.iapeer/IAPEER.md content. '' when absent. */
  peerDoctrine: string
  /** Display path for the local IAPEER.md marker (HOME abbreviated to ~). */
  peerDoctrinePath?: string
  /** Layer 2 global, OPTIONAL: ~/.iapeer/IAPEER.md content (sits between the YAML
   *  block and the per-peer doctrine so per-peer overrides global). Existence-
   *  gated: a present-but-empty file → '', an absent file → undefined. */
  globalDoctrine?: string
  /** Display path for the global IAPEER.md marker. */
  globalDoctrinePath?: string
  /** Layer 3: the normalized peer registry. Empty/omitted → the layer emits
   *  nothing (and the output stays byte-identical to the legacy YAML+doctrine). */
  peers?: PublicPeerSummary[]
  /** Layer 4: every non-IAPEER `<DOMAIN>.md` pair at the .iapeer/ root. Empty/
   *  omitted → the layer emits nothing. */
  pluginDomains?: PromptDomainBlock[]
  /** Layer 5: every `<STEM>.md` pair in the .iapeer/fragments/ subdir (global +
   *  local), primitive-owned and machine-regenerated. Empty/omitted → the layer
   *  emits nothing. Appended LAST (after Layer 4). */
  promptFragments?: PromptDomainBlock[]
}

/**
 * Compose the merged system prompt, byte-for-byte equivalent to the claude-start
 * jq pipeline:
 *
 *   ---\n
 *   personality: <jq @json>\n
 *   description: <jq @json>\n
 *   peer-cwd: <jq @json>\n
 *   platform: <jq @json>\n
 *   os_version: <jq @json>\n
 *   user: <jq @json>\n
 *   hostname: <jq @json>\n
 *   today: <jq @json>\n
 *   ---\n
 *   \n
 *   [globalDoctrine + "\n"  — only when present]
 *   peerDoctrine
 *   [\n\n + registry section  — only when peers.length > 0]
 *   [\n\n + merged domains    — only when pluginDomains is non-empty]
 *   [\n\n + merged fragments  — only when promptFragments is non-empty]
 *
 * Layers 1+2 are byte-for-byte the legacy jq output; layers 3+4+5 are appended
 * (each as a `\n\n`-separated section) ONLY when they have content, so a peer
 * with no registry, no extra domains and no fragments produces the exact legacy
 * bytes.
 *
 * Each YAML value is a JSON string literal (jq @json: JSON.stringify), which is
 * also a valid YAML double-quoted scalar — safe against colons/quotes/newlines.
 * The keys use hyphen `peer-cwd` and underscore `os_version` exactly as the bash.
 */
export type ComposeSystemPrompt = (input: ComposePromptInput) => string

// ─────────────────────────────────────────────────────────────────────────────
// Launch spec + adapter config
// ─────────────────────────────────────────────────────────────────────────────

export interface LaunchAdapterConfig {
  claudeBin: string
  codexBin: string
  /** telegram-runtime launch binary (router runtime). */
  telegramBin?: string
  /** notifier-runtime launch binary (router runtime, infra/always-on). */
  notifierBin?: string
  /** voicetalk-runtime launch binary (router runtime, infra/always-on — the owner's voice channel). */
  voicetalkBin?: string
}

export interface LaunchSpec {
  personality: string
  runtime: Runtime
  cwd: string
  /** `<runtime>-<personality>` — the tmux session name + socket stem. */
  identity: string
  /** Socket path (`/tmp/tmux-iap-<identity>.sock`). */
  socketPath: string
  /** Composed system-prompt file path (tui runtimes that usesDoctrine). */
  systemPromptFile?: string
  /** Resume the newest transcript/session for this cwd (adapter validates). */
  resume?: boolean
  /** Pre-resolved resume ref (claude `--resume <uuid>`); set by resolveResume. */
  resumeRef?: string
  /** Free-form extra CLI args (PEER_START_ARGS). */
  extraArgs?: string[]
  /** Peer intelligence (artificial/natural/absent). Used to enforce an adapter's
   *  intelligence gate at launch (telegram requires natural). Optional: a doctrine-
   *  less throwaway may omit it, but an adapter that declares requiresIntelligence
   *  then refuses (cannot confirm the required nature). */
  intelligence?: Intelligence
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery markers — the tui submit surface (owned by the adapter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Markers the transport submit path (submitIntoTui) needs to detect that a
 * bracketed paste landed in the input row before pressing Enter. Contract refactor
 * (docs/Рантайм-адаптеры): the ADAPTER owns delivery markers — they moved out
 * of the transport's hardcoded `PROMPT_GLYPHS = ['❯','›']` union so the generic
 * submit logic carries NO runtime strings and a new runtime ships its own glyph
 * with its adapter, not by editing transport.
 */
export interface DeliveryMarkers {
  /** Glyph(s) at column 0 of the rendered input-prompt row (claude '❯', codex '›').
   *  submitIntoTui locates the prompt row by these. A router has no submit surface
   *  → empty array. */
  promptGlyphs: string[]
  /** Extra "bracketed paste landed" indicators beyond the envelope's own tail-marker
   *  (claude '[Pasted text' / '[Image #'). Optional — when absent the tail-marker is
   *  the sole landed-signal. */
  pastePatterns?: RegExp[]
  /** SGR parameter sequences that the runtime uses for composer ghost/placeholder
   *  text (non-human input). The busy-composer delivery queue captures the pane
   *  with ANSI escapes and treats visible text after the prompt glyph as HUMAN only
   *  when at least one non-whitespace character is NOT under these dim/grey SGR
   *  attributes. Runtime-owned for the same reason as promptGlyphs: color is TUI
   *  surface, not transport policy. Examples observed on live panes:
   *  `2` (faint/dim) and `38;5;246` (xterm 256-color grey). */
  ghostTextSgr?: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Control commands (Ф-E, docs/Control-команды). The SECOND daemon channel: an
// in-session control command (interrupt / compact) is mapped by the target's adapter
// to a tmux send-keys sequence and performed UNCONDITIONALLY (immediate, NOT gated on
// ready — the point is to interrupt / drive, not to wait). System commands (list /
// status) are the daemon's own and do not reach the adapter.
// ─────────────────────────────────────────────────────────────────────────────

/** An abstract in-session control command (`interrupt`, `compact`, runtime-specific). */
export interface ControlCommand {
  name: string
  args?: readonly string[]
}

/** The runtime mechanism for a control command: a sequence of `tmux send-keys`
 *  arg-lists, performed IN ORDER on the target session. */
export interface ControlPlan {
  /** Each inner array is one `tmux send-keys -t <addr>` call's trailing args
   *  (e.g. ['Escape'] or ['-l', '/compact'] then ['Enter']). */
  sequence: string[][]
  /** Pause (ms) between sequence steps — e.g. typed text must settle before Enter. */
  stepDelayMs?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// RuntimeAdapter — per-runtime "HOW to launch / observe one session"
// ─────────────────────────────────────────────────────────────────────────────

export interface RuntimeAdapter {
  runtime: Runtime
  /** 'tui' (claude/codex — pane boot/ready/dialogs) | 'router' (telegram — no TUI phases). */
  kind: 'tui' | 'router'
  /** Does this runtime consume a composed system-prompt doctrine? (tui yes, router no). */
  usesDoctrine: boolean

  /**
   * Delivery markers for the transport submit path (submitIntoTui) — the input-
   * prompt glyph(s) and optional "paste landed" patterns. The adapter OWNS them:
   * transport reads them from here instead of a hardcoded glyph
   * union. A router declares `{ promptGlyphs: [] }` (no submit surface).
   */
  deliveryMarkers: DeliveryMarkers

  /**
   * How a delivered envelope's LANDING is confirmed AFTER the socket-ack, in
   * deliverViaHost (transport). Owned by the adapter because it is a property of
   * HOW the runtime logs an accepted message, not transport policy. A router
   * (kind:'router') is always socket-ack by structure and short-circuits before
   * this field is read; it refines the TUI runtimes. Absent → 'transcript' (the
   * strict default: a new/unknown runtime gets the swallow-guarding confirm, never
   * a weaker one).
   *   - 'transcript' (claude): the runtime writes an acceptance record CARRYING the
   *     envelope PROMPTLY — sub-second: a queue-operation when busy, the user-turn
   *     when idle. So a message-specific transcript-carries-envelope check within a
   *     short grace BOTH proves landing AND catches a paste swallowed at a turn
   *     boundary (the false-OK class, incident 2026-06-23). Cheap and safe → keep it.
   *   - 'socket-ack' (codex): the runtime writes NO acceptance record — its
   *     session-jsonl user-input appears only when the model TURN INGESTS the
   *     message, which during a long turn is many tens of seconds away (measured ~80s
   *     live, 2026-06-25). But its input queue is DURABLE: a mid-turn submit is HELD
   *     and processed at the next turn boundary, never lost (verified live — an 80s
   *     turn still ingested + replied with the exact probe token). So the flushed
   *     socket-ack (bytes left us AND drained to the pty) IS the delivery confirm; a
   *     transcript grace here only ever FALSE-FAILs a message that WILL be processed,
   *     wrongly escalating to a fallback peer. A genuinely dead session still fails
   *     at the socket-ack (no socket / stalled flush) → really-dead still escalates.
   */
  deliveryConfirm?: 'transcript' | 'socket-ack'

  /**
   * If set, launch REFUSES unless the peer's intelligence equals this value
   * (fail-loud). telegram → 'natural' — it is a human channel; launching an
   * artificial/absent peer on it is a category error (the persistent-peer path held
   * a FATAL guard in two places). Most adapters omit it (no nature gate). Source of intelligence →
   * docs/Идентичность; enforced by the launch primitive against LaunchSpec.intelligence.
   */
  requiresIntelligence?: Intelligence

  /**
   * Build the runtime argv: binary + flags, wiring systemPromptFile per-runtime
   *  - claude: `--dangerously-skip-permissions [--disallowedTools …] --system-prompt-file <f> [extra]`
   *  - codex:  `[resume --last] --no-alt-screen -C <cwd> -c model_instructions_file=<f> --dangerously-bypass-approvals-and-sandbox [extra]`
   *  - telegram: `telegram-runtime run …` (no doctrine).
   * NO currency on this path.
   */
  buildArgv(spec: LaunchSpec, cfg: LaunchAdapterConfig): string[]

  /**
   * If a known startup dialog is visible in `pane`, return the tmux send-keys
   * args to clear it (e.g. ['Enter'] or ['Down','Enter']); else null. (tui only).
   */
  bootDialogKeys(pane: string): string[] | null

  /**
   * MID-SESSION nag/upsell auto-dismiss (livability). Distinct from bootDialogKeys:
   * the boot-driver stops at ready, but claude/codex can pop a ONE-TIME interactive
   * upsell modal AFTER the session is live (e.g. "Try the new fullscreen-renderer?")
   * that BLOCKS the pty waiting for a keypress no headless peer answers — it froze the
   * live fleet until a human cleared it. A persistent supervisor watcher (daemon.ts)
   * runs THIS off the authoritative model for the whole session and writes the keys.
   * Return the send-keys args that dismiss with the VERIFIED-SAFE default (decline),
   * else null. Match the FULL modal signature so ordinary content mentioning the
   * feature can never trigger a stray keystroke into the composer. Optional — a runtime
   * with no known mid-session nags (codex/router) omits it. tui only.
   */
  nagDismissKeys?(pane: string): string[] | null

  /** Is the input surface ready for the first message? (tui: ready marker present
   *  AND startup dialogs gone). Router runtimes return true (no input surface). */
  isInputReady(pane: string): boolean

  /** Newest activity-proxy FILE mtime — used by the READY-GATE (it waits for ANY transcript write past
   *  baseline = "the model produced its first turn"). NOT for idle accounting: a live session re-saves
   *  this file without a new entry, so it is falsely fresh at idle. null for a router (no proxy). */
  newestActivityMtime(cwd: string): number | null

  /** Content-timestamp (epoch ms) of the LAST meaningful transcript ENTRY — the reliable IDLE-accounting
   *  signal. Unlike newestActivityMtime (file mtime, re-touched at idle) and the pane-log mtime (a
   *  statusline re-render ticks it at idle), the entry stream only advances on real turn activity.
   *  superviseTick uses THIS for idle/quiet age. null for a router (no transcript). */
  lastTurnMtime(cwd: string): number | null

  /** В58 — newest FILE mtime among the session's CHILD workflow/subagent transcripts (a running workflow
   *  writes them continuously). A peer that launched a long workflow (>1h) makes NO turns of its own, so
   *  lastTurnMtime is stale and the idle-reap would cut the busy session mid-work. superviseTick folds
   *  THIS into the idle proxy so live child work keeps the session alive. Optional — null / undefined for
   *  runtimes without a subagent layout (routers, codex). */
  childActivityMtime?(cwd: string): number | null

  /** Resume preflight — validate a resume request fail-loud (never silent fresh).
   *  Returns the resolved ref (claude uuid) or ok:false with a reason. */
  resolveResume(cwd: string): { ok: boolean; ref?: string; reason?: string }

  /**
   * Map an abstract in-session control command to this runtime's mechanism (a tmux
   * send-keys sequence — ControlPlan), or null when the runtime does not support it
   * (the daemon/CLI surfaces an explicit refusal). Ф-E, docs/Control-команды:
   *   - tui (claude/codex): `interrupt` → ['Escape'] (claude ×1; codex ×1-2, snapped
   *     live), `compact` → type '/compact' then Enter. Declares the supported set.
   *   - router (telegram/notifier): no TUI turn → null for everything (refuse).
   * Performed UNCONDITIONALLY (immediate, not ready-gated) — the point is to
   * interrupt / drive a possibly-stuck session, exactly when normal delivery wouldn't.
   */
  executeControl(command: ControlCommand): ControlPlan | null
}

// ─────────────────────────────────────────────────────────────────────────────
// launch primitive
// ─────────────────────────────────────────────────────────────────────────────

export interface LaunchConfig extends LaunchAdapterConfig {
  sockDir: string
  bootDeadlineSecs: number
  readyGateSecs: number
  /** Log dir for pipe-pane output. */
  logDir: string
  /**
   * Durable EXIT-CAUSE log dir (~/.iapeer/logs/iapeer — next to lifecycle.log,
   * where the investigator looks). When set, launch installs a tmux `pane-died`
   * hook that records WHY the session's process died (exit status / signal) AT THE
   * MOMENT of death, into `<exitLogDir>/exits.log` — the blind spot the daemon's
   * 60 s supervise tick (reaped-gone) can only see post-factum, after the exit code
   * is already lost. Routed through cfg (NOT re-resolved from env) so it is isolated
   * by the same sandbox as the rest of launch; a FALSY dir → no hook installed and
   * `remain-on-exit` stays off (original behavior — a partial/test cfg never writes
   * and never lingers a dead pane). See exitCauseHook in index.ts. */
  exitLogDir?: string
  env?: NodeJS.ProcessEnv
  /**
   * Always-on bring-up (infra runtimes held by launchd KeepAlive). Marks the
   * session as infra-owned: launchd (KeepAlive) owns its lifecycle, the daemon is
   * READ-ONLY for it (H4), and it opts out of the warm-on-demand `-v` tmux
   * command-log (a rare-relaunch infra session has no rotation point and is not the
   * dying warm class). Historically it also skipped the session self-TTL; that TTL
   * was removed in 0.2.55 (see launch step 4), so the exemption is now moot.
   */
  alwaysOn?: boolean
}

export interface LaunchResult {
  status: 'READY' | 'FAILED'
  identity: string
  process_address: string
  reason?: string
}

/**
 * Bring up ONE session: pre-clean stale tmux server → tmux new-session -d with
 * adapter.buildArgv → pipe-pane → boot (answer dialogs via
 * adapter, wait for adapter.isInputReady, deliver the first message via
 * load-buffer + bracketed paste — the same byte-path as warm delivery) →
 * ready-gate (adapter.newestActivityMtime strictly advances).
 * Runtime-agnostic; all specifics come from the adapter. Returns READY/FAILED.
 * `firstMessage` (the task / routed envelope) is delivered as the boot message;
 * a router runtime skips the TUI boot/ready phases.
 */
export type LaunchFn = (
  spec: LaunchSpec,
  adapter: RuntimeAdapter,
  firstMessage: string,
  cfg: LaunchConfig,
) => Promise<LaunchResult>
