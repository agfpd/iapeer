// Lifecycle — wake-on-miss / supervise / reap. The warm-on-demand core: a dead
// peer is woken (spawned) on demand, its first message delivered, and idle
// sessions are reaped. Consolidated from Spawned-Peer spawner.ts (performSpawn)
// + watcher.ts (boot / ready-gate / idle phases), but with the detached
// per-session watcher COLLAPSED into the daemon: wakeOrSpawn runs boot + ready
// inline (the daemon awaits it) and a single superviseTick drives idle-reap.
//
// HARD SAFETY (H4): the daemon NEVER wakes / reaps / respawns / sweeps a peer
// that has a launchd plist (~/Library/LaunchAgents/com.iapeer.<p>.plist). Such a
// peer is launchd-managed (KeepAlive owns its lifecycle); the daemon touching it
// would race launchd on the live fleet. isLaunchdManaged() is checked FIRST,
// before any wake or reap. wakeOrSpawn refuses a launchd peer; superviseTick and
// sweepZombies skip it. Only daemon-owned (no-plist) peers are managed here.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import * as lockfile from 'proper-lockfile'
import {
  STATE_DIR,
  LOGS_DIR,
  isRuntime,
  resolveSockDir,
  type Runtime,
} from '../core/constants.ts'
import { buildProcessAddress, buildSocketPath, parseSessionName } from '../core/socket.ts'
import { err, ok, type Result } from '../core/errors.ts'
import { capPaneLogs } from '../launch/cmdlog.ts'
import { resolveGlobalRoot } from '../storage/index.ts'
import { readPeerProfile, resolveIdentity } from '../identity/index.ts'
import {
  ephemeralQueueDepth,
  listQueuedIdentities,
  peekEphemeralTask,
  removeEphemeralTask,
} from './queue.ts'
import { findPeer, publicPeerSummary, readPeersIndex, type PeerRecord, type PublicPeerSummary } from '../registry/index.ts'
// Ф3: launch = HOW to bring up ONE session (runtime-agnostic primitive + adapter).
// lifecycle decides WHEN/HOW-MANY and delegates the bring-up to launch.
import {
  getAdapter,
  launch,
  launchAgentsDir,
  launchdLabel,
  type LaunchConfig,
  type LaunchSpec,
} from '../launch/index.ts'
import { composeSystemPrompt, gatherPromptInput } from '../launch/composeSystemPrompt.ts'
import { hostSessionAlive, killPtyHost } from '../launch/ptyHost.ts'
import { appendLifecycleEvent, superviseLogVerbose } from './eventlog.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface LifecycleConfig {
  claudeBin: string
  codexBin: string
  sockDir: string
  stateDir: string // ~/.iapeer/state/lifecycle
  logDir: string // ~/.iapeer/logs/lifecycle
  /** Where the durable lifecycle DECISION log (lifecycle.log) is written
   *  (~/.iapeer/logs/iapeer — next to daemon-stdout/stderr.log, where the first
   *  investigator looks). Routed through cfg — NOT re-resolved from env — so it is
   *  isolated by the same sandbox as stateDir (eventlog.ts). */
  eventLogDir: string
  bootDeadlineSecs: number
  readyGateSecs: number
  idleSecs: number
  /** Crash-loop guard: refuse to (re)launch after this many deaths within the window. */
  crashLoopMax: number
  /** Crash-loop guard: the sliding window (seconds) the death count is measured over. */
  crashLoopWindowSecs: number
  /** wake_policy:ephemeral M2 — the quiet window (seconds of activity-proxy silence)
   *  after which an ARMED ephemeral session (it has sent its outbound reply) is
   *  reaped. Kept SHORT so the M3 serial conveyor drains the peer's next queued task
   *  promptly once its session is truly idle. "Quiet" here is BOTH the transcript proxy
   *  AND the pane-log (TUI render-stream) silent — the pane-log advances ~1s while the
   *  TUI renders a turn (generation OR a tool), so a still-working session is NEVER
   *  reaped mid-turn even though the transcript is momentarily quiet (the live incident
   *  this fixes: an armed worker generating its next step >20s was reaped at age=29s). */
  ephemeralQuietSecs: number
  /** wake_policy:ephemeral — the UNARMED idle bound (seconds): an ephemeral session
   *  that never armed (finished silently / lost its arm to a daemon-restart window)
   *  is reaped after this much TRUE-idle silence (transcript AND pane-log both quiet).
   *  Live case: a worker that ended silently without its final outbound stalled its M3
   *  FIFO for the FULL generic idleSecs (1 h) — with serial drain that blocks the whole
   *  conveyor per silent worker. Bound chosen ≫ a brief no-output gap and ≪ idleSecs.
   *  A still-WORKING silent-tool worker keeps the pane-log fresh via the TUI render, so it
   *  is no longer reaped mid-task — only a genuinely idle/wedged session crosses this. */
  ephemeralUnarmedIdleSecs: number
  /** Wake-lock acquisition retries (proper-lockfile). The budget is intentionally MODEST (a full
   *  boot can exceed it) — an exhausted budget surfaces as a RETRYABLE FAILED, not a raw ELOCKED, so
   *  the sender retries and routeSend logs the outcome. Tunable via IAPEER_WAKE_LOCK_RETRIES. */
  wakeLockRetries: number
}

export function loadLifecycleConfig(env: NodeJS.ProcessEnv = process.env): LifecycleConfig {
  const home = env.HOME?.trim() || homedir()
  const root = resolveGlobalRoot(env)
  const num = (raw: string | undefined, dflt: number): number => {
    const n = parseInt(raw ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : dflt
  }
  return {
    claudeBin: env.IAPEER_CLAUDE_BIN ?? join(home, '.local', 'bin', 'claude'),
    codexBin: env.IAPEER_CODEX_BIN ?? 'codex',
    sockDir: resolveSockDir(env),
    stateDir: join(root, STATE_DIR, 'lifecycle'),
    logDir: join(root, LOGS_DIR, 'lifecycle'),
    eventLogDir: join(root, LOGS_DIR, 'iapeer'),
    bootDeadlineSecs: num(env.IAPEER_BOOT_DEADLINE_SECS, 240),
    readyGateSecs: num(env.IAPEER_READY_GATE_SECS, 120),
    idleSecs: num(env.IAPEER_IDLE_SECS, 3600),
    crashLoopMax: num(env.IAPEER_CRASHLOOP_MAX, 3),
    crashLoopWindowSecs: num(env.IAPEER_CRASHLOOP_WINDOW_SECS, 300),
    ephemeralQuietSecs: num(env.IAPEER_EPHEMERAL_QUIET_SECS, 20),
    ephemeralUnarmedIdleSecs: num(env.IAPEER_EPHEMERAL_UNARMED_IDLE_SECS, 600),
    wakeLockRetries: (() => {
      const n = parseInt(env.IAPEER_WAKE_LOCK_RETRIES ?? '', 10)
      return Number.isFinite(n) && n >= 0 ? n : 30
    })(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// H4 — launchd-managed detector (checked FIRST, before any wake/reap)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True iff the peer is launchd-managed: `~/Library/LaunchAgents/
 * com.iapeer.<personality>.plist` exists. A launchd peer is in the launchd
 * domain — KeepAlive owns its lifecycle — and the daemon must be READ-ONLY for
 * it (deliver to it if live, but never wake / reap / respawn / sweep it). This
 * is the hard guard against fighting launchd on the live fleet.
 */
export function isLaunchdManaged(personality: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // Label + LaunchAgents dir come from the SAME helpers the plist generator uses
  // (launch/launchd.ts), so this H4 detector and installAlwaysOnPlist can never
  // disagree on `com.iapeer.<personality>.plist`. IAPEER_LAUNCHAGENTS_DIR overrides
  // the dir for tests (so an H4-guard test never touches ~/Library/LaunchAgents).
  return existsSync(join(launchAgentsDir(env), `${launchdLabel(personality)}.plist`))
}

// ─────────────────────────────────────────────────────────────────────────────
// Session state — what the supervisor walks (daemon-owned sessions only)
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionState {
  identity: string
  runtime: Runtime
  personality: string
  cwd: string
  wokeAt: number
}

function sessionStatePath(cfg: LifecycleConfig, identity: string): string {
  return join(cfg.stateDir, `${identity}.session`)
}

function writeSessionState(cfg: LifecycleConfig, state: SessionState): void {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(sessionStatePath(cfg, state.identity), JSON.stringify(state), { mode: 0o600 })
  } catch {
    /* best-effort — supervision degrades to liveness scan, never blocks a wake */
  }
}

/** Drop the supervise session-state. Exported for the STOP verb: a deliberate stop
 *  removes the state with the session so superviseTick never tags the kill as a
 *  death (no crash-loop entry, no reaped-gone death class). */
export function removeSessionState(cfg: LifecycleConfig, identity: string): void {
  try {
    rmSync(sessionStatePath(cfg, identity), { force: true })
  } catch {
    /* already gone */
  }
}

/** Atomically CLAIM a dead session for reaping: rename `.session` → `.session.reaping`. Returns true
 *  iff THIS caller won the rename. superviseTick runs from BOTH the daemon timer AND the prelude of
 *  every wakeOrSpawn (in whatever process called it), so two passes can see the same dead `.session`
 *  in the same sub-second window; without a claim BOTH would recordDeath, and TWO deaths for ONE real
 *  death can trip the crash-loop guard prematurely (a peer refused to wake for the whole window). The
 *  rename is atomic on a single filesystem — the loser gets ENOENT → false and skips recordDeath/eager.
 *  A leftover `.reaping` (crash mid-reap) is ignored by readSessionStates (it filters `.session`). */
function claimDeadSession(cfg: LifecycleConfig, identity: string): boolean {
  try {
    renameSync(sessionStatePath(cfg, identity), `${sessionStatePath(cfg, identity)}.reaping`)
    return true
  } catch {
    return false // ENOENT — another pass already claimed this death (or the file vanished)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 — durable stopped flag (warm-on-demand stop/start; contract ЖЦ §stop/start,
// Демон §stopped). `stop <peer>` on a warm runtime kills the session AND drops this
// flag → the daemon REFUSES to wake the peer (a DELIBERATE operator halt, not a
// fault — no message queue, the sender gets an explicit "stopped" error). `start`
// clears it (wakeable again). Distinct from idle-reap (temporary; the daemon DOES
// wake on the next message). Lives next to the session-state, in state/lifecycle —
// daemon-owned, durable across restarts. Keyed on IDENTITY (runtime-personality):
// `stop <peer> <runtime>` halts one runtime; the flag is per-runtime presence.
// always-on (launchd) peers are NOT stopped this way — their stop is launchctl
// bootout (ЖЦ); a launchd peer never carries this flag (and the daemon is H4
// read-only for it regardless).
// ─────────────────────────────────────────────────────────────────────────────

function stoppedFlagPath(cfg: LifecycleConfig, identity: string): string {
  return join(cfg.stateDir, `${identity}.stopped`)
}

/** True iff the peer identity carries a durable stop flag (daemon must not wake it). */
export function isStopped(cfg: LifecycleConfig, identity: string): boolean {
  return existsSync(stoppedFlagPath(cfg, identity))
}

/** Drop the durable stop flag (the `stop` verb does this after killing the session). */
export function setStopped(cfg: LifecycleConfig, identity: string): void {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(stoppedFlagPath(cfg, identity), `${new Date().toISOString()}\n`, { mode: 0o600 })
}

/** Clear the durable stop flag (the `start` verb does this — peer wakeable again). */
export function clearStopped(cfg: LifecycleConfig, identity: string): void {
  try {
    rmSync(stoppedFlagPath(cfg, identity), { force: true })
  } catch {
    /* already gone */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle markers — the DAEMON decides fresh-vs-resume by the DEATH CAUSE it
// tracks itself (TARGET redesign). Plain files in state/lifecycle/<identity>.* :
//
//   .idle-reaped : the CLEAN-PARK marker — written when the daemon idle-reaps the
//     session AND by the deliberate `stop` verb (both are daemon/operator-initiated
//     parks, not faults; stop→start must survive ≥ idle-reap).
//     Presence on the next wake = session was parked cleanly = RESUME-eligible.
//     ABSENT on a dead session = it died on its own (crash / self-close) = FRESH.
//     (resolver branch 3.)
//   .new-eager   : set when /new is invoked (owner reset, via `iapeer self-fresh`).
//     Presence on a dead session = the daemon EAGERLY relaunches FRESH (does NOT
//     wait for a message) and injects initial_prompt. Consumed on the relaunch.
//   .deaths      : crash-loop guard — a small JSON ring of recent death epoch-ms.
//   .topic       : the topic the current/last session last WORKED ON (executor
//     fresh-vs-resume discriminator). Written at wake (the boot topic) AND on
//     every live delivery carrying a different non-empty topic (the daemon/CLI
//     compositions wire transport's noteLiveTopic seam to writeTopic — defect:
//     a wake-only marker goes stale over a long session and false-freshes the
//     stop→start resume the clean park promised).
//   .ephemeral-armed : wake_policy:ephemeral M2 — set by the DAEMON when it routes
//     an OUTBOUND send from an ephemeral worker (its single final reply, ADR-006:
//     workers send no intermediate messages, so outbound ⇒ the task is answered).
//     An ARMED live session is reaped by superviseTick after a quiet window
//     (die-after-reply). The marker belongs to the session that sent the outbound:
//     it is cleared on the quiet-reap, on that session's own death, and on the
//     next successful launch — it NEVER survives into a successor session (else a
//     stray marker would quiet-reap the next task before its answer).
//
// Boolean markers carry an ISO timestamp line (audit-friendly); .deaths is a JSON
// array; .topic is the raw topic string.
// ─────────────────────────────────────────────────────────────────────────────

function idleReapedPath(cfg: LifecycleConfig, identity: string): string {
  return join(cfg.stateDir, `${identity}.idle-reaped`)
}

/** True iff the identity was idle-reaped by the daemon (→ RESUME-eligible). */
export function hasIdleReaped(cfg: LifecycleConfig, identity: string): boolean {
  return existsSync(idleReapedPath(cfg, identity))
}

/** Write the clean-park marker. Three writers, all deliberate parks: the idle-reap
 *  path in superviseTick, the `stop` verb (park before kill), and superviseTick's
 *  stopped-catch-up branch (a stop that raced the tick). Never a crash path. */
export function setIdleReaped(cfg: LifecycleConfig, identity: string): void {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(idleReapedPath(cfg, identity), `${new Date().toISOString()}\n`, { mode: 0o600 })
}

/** Consume the idle-reaped marker (the resolver does this on the resume decision). */
export function clearIdleReaped(cfg: LifecycleConfig, identity: string): void {
  try {
    rmSync(idleReapedPath(cfg, identity), { force: true })
  } catch {
    /* already gone */
  }
}

function newEagerPath(cfg: LifecycleConfig, identity: string): string {
  return join(cfg.stateDir, `${identity}.new-eager`)
}

/** True iff the identity carries a /new eager-fresh mark (→ eager fresh + seed). */
export function hasNewEager(cfg: LifecycleConfig, identity: string): boolean {
  return existsSync(newEagerPath(cfg, identity))
}

/** Set the /new eager-fresh mark (the `self-fresh` verb does this before self-kill). */
export function setNewEager(cfg: LifecycleConfig, identity: string): void {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(newEagerPath(cfg, identity), `${new Date().toISOString()}\n`, { mode: 0o600 })
}

/** Consume the /new eager-fresh mark (the daemon does this on the eager relaunch). */
export function clearNewEager(cfg: LifecycleConfig, identity: string): void {
  try {
    rmSync(newEagerPath(cfg, identity), { force: true })
  } catch {
    /* already gone */
  }
}

function freshNextPath(cfg: LifecycleConfig, identity: string): string {
  return join(cfg.stateDir, `${identity}.fresh-next`)
}

/** True iff the identity carries a LAZY soft-reload mark (→ FRESH on its next natural wake,
 *  re-reading doctrine/fragments from disk). Unlike .new-eager this is NOT eager — no relaunch,
 *  no burst-wake; it only changes the resume decision when the peer next wakes on its own. */
export function hasFreshNext(cfg: LifecycleConfig, identity: string): boolean {
  return existsSync(freshNextPath(cfg, identity))
}

/** Set the lazy soft-reload mark (the `iapeer refresh` verb does this — no kill, no relaunch). */
export function setFreshNext(cfg: LifecycleConfig, identity: string): void {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(freshNextPath(cfg, identity), `${new Date().toISOString()}\n`, { mode: 0o600 })
}

/** Consume the lazy soft-reload mark (resolveWakeMode does this on the fresh decision). */
export function clearFreshNext(cfg: LifecycleConfig, identity: string): void {
  try {
    rmSync(freshNextPath(cfg, identity), { force: true })
  } catch {
    /* already gone */
  }
}

function ephemeralArmedPath(cfg: LifecycleConfig, identity: string): string {
  return join(cfg.stateDir, `${identity}.ephemeral-armed`)
}

/** True iff the identity's live ephemeral session has sent its outbound reply
 *  (→ quiet-reap candidate). */
export function hasEphemeralArmed(cfg: LifecycleConfig, identity: string): boolean {
  return existsSync(ephemeralArmedPath(cfg, identity))
}

/** Arm the die-after-reply reap — ONLY the daemon's outbound seam does this
 *  (an ephemeral caller's send_to_peer was routed ok). */
export function setEphemeralArmed(cfg: LifecycleConfig, identity: string): void {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(ephemeralArmedPath(cfg, identity), `${new Date().toISOString()}\n`, { mode: 0o600 })
}

/** Clear the armed mark (quiet-reap done / the armed session died / a new launch). */
export function clearEphemeralArmed(cfg: LifecycleConfig, identity: string): void {
  try {
    rmSync(ephemeralArmedPath(cfg, identity), { force: true })
  } catch {
    /* already gone */
  }
}

function deathsPath(cfg: LifecycleConfig, identity: string): string {
  return join(cfg.stateDir, `${identity}.deaths`)
}

/** Read the crash-loop death ring (epoch-ms timestamps). Garbage → empty. */
export function readDeaths(cfg: LifecycleConfig, identity: string): number[] {
  try {
    const arr = JSON.parse(readFileSync(deathsPath(cfg, identity), 'utf8'))
    return Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : []
  } catch {
    return []
  }
}

/** Append a death epoch-ms to the crash-loop ring (best-effort, bounded). */
export function recordDeath(cfg: LifecycleConfig, identity: string, nowMs: number = Date.now()): void {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  // Keep the ring small — only the most recent matter for the window check.
  const next = [...readDeaths(cfg, identity), nowMs].slice(-16)
  try {
    writeFileSync(deathsPath(cfg, identity), JSON.stringify(next), { mode: 0o600 })
  } catch {
    /* best-effort accounting; never block a reap */
  }
}

/** Count deaths within `windowSecs` of `nowMs` (crash-loop guard input). */
export function countRecentDeaths(
  cfg: LifecycleConfig,
  identity: string,
  windowSecs: number,
  nowMs: number = Date.now(),
): number {
  const cutoff = nowMs - windowSecs * 1000
  return readDeaths(cfg, identity).filter(t => t >= cutoff).length
}

/** Trim the death ring to the window (called on a successful wake to reset the loop). */
export function trimDeaths(
  cfg: LifecycleConfig,
  identity: string,
  windowSecs: number,
  nowMs: number = Date.now(),
): void {
  const cutoff = nowMs - windowSecs * 1000
  const kept = readDeaths(cfg, identity).filter(t => t >= cutoff)
  try {
    if (kept.length === 0) rmSync(deathsPath(cfg, identity), { force: true })
    else writeFileSync(deathsPath(cfg, identity), JSON.stringify(kept), { mode: 0o600 })
  } catch {
    /* best-effort */
  }
}

function topicPath(cfg: LifecycleConfig, identity: string): string {
  return join(cfg.stateDir, `${identity}.topic`)
}

// Per-session TOPIC SET (executor resume discriminator). The `.topic` file holds the
// topics this session lineage has touched — newline-separated, most-recent LAST, deduped
// and capped. A peer can carry several threads in ONE session, so resume matches the
// incoming topic against ANY topic in the set: a later ping on an earlier thread continues
// that session's context instead of starting fresh and redoing work. The set is RESET on a
// FRESH wake (new lineage) and ACCUMULATES on the wake topic + every live delivery topic.
const MAX_SESSION_TOPICS = 16

/** All topics the current session lineage has touched (most-recent last). [] if none. */
export function readTopics(cfg: LifecycleConfig, identity: string): string[] {
  try {
    return readFileSync(topicPath(cfg, identity), 'utf8')
      .split('\n')
      .map(t => t.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** The session's MOST-RECENT topic (last in the set), or '' — single-value back-compat read. */
export function readTopic(cfg: LifecycleConfig, identity: string): string {
  const t = readTopics(cfg, identity)
  return t.length ? t[t.length - 1]! : ''
}

/** Is `topic` (non-empty) one of the session lineage's topics? Drives resume-vs-fresh. */
export function hasTopic(cfg: LifecycleConfig, identity: string, topic: string): boolean {
  const t = topic.trim()
  return !!t && readTopics(cfg, identity).includes(t)
}

/** Add a topic to the session's set (most-recent-last, deduped, capped). Empty → no-op.
 *  Two callers: the wake (boot topic, wakeOrSpawn) and live deliveries via the noteLiveTopic
 *  seam (makeNoteLiveTopic) — so the set follows the work, not just the boot. Best-effort. */
export function addTopic(cfg: LifecycleConfig, identity: string, topic: string): void {
  const t = topic.trim()
  if (!t) return
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  try {
    const set = readTopics(cfg, identity).filter(x => x !== t)
    set.push(t)
    writeFileSync(topicPath(cfg, identity), set.slice(-MAX_SESSION_TOPICS).join('\n') + '\n', { mode: 0o600 })
  } catch {
    /* best-effort — topic is a discriminator hint, never blocks a wake */
  }
}

/** Drop the session's topic set — a FRESH wake starts a new lineage with no carried topics. */
export function resetTopics(cfg: LifecycleConfig, identity: string): void {
  try {
    rmSync(topicPath(cfg, identity), { force: true })
  } catch {
    /* best-effort */
  }
}

/**
 * Purge EVERY identity-keyed lifecycle artifact of `<identity>` from stateDir:
 * the marker files (`.stopped` / `.idle-reaped` / `.deaths` / `.topic` /
 * `.new-eager` / `.ephemeral-armed`), the supervise `.session`, the `.wake.lock`
 * and the M3 `.queue/` dir — everything matching `<identity>.*` (the dot
 * delimiter keeps `claude-bob` from ever matching `claude-bob2.*`).
 *
 * Consumer: `iapeer remove` (live defect): a removed peer's stale
 * `.stopped`/`.idle-reaped` survived in state/lifecycle, and a NEWBORN peer
 * REUSING the personality inherited the dead namesake's parking — the daemon
 * refused to wake it (`mode=refused cause=stopped`). Identity-keyed state must
 * die with the registry record. Deliberately NOT called at birth: provision runs
 * on EXISTING peers too (init re-runs), and purging there would erase a parked
 * peer's `.idle-reaped` → its next wake comes up FRESH instead of RESUME
 * (violates «на resume нет потери контекста»).
 *
 * Returns the removed entry names (for the verb's output); never throws.
 */
export function purgeIdentityState(cfg: LifecycleConfig, identity: string): string[] {
  const removed: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(cfg.stateDir)
  } catch {
    entries = [] // no state dir → no markers; the cmdlog purge below still runs
  }
  for (const name of entries) {
    if (!name.startsWith(`${identity}.`)) continue
    try {
      rmSync(join(cfg.stateDir, name), { recursive: true, force: true })
      removed.push(name)
    } catch {
      /* best-effort — a locked/vanished entry must not fail the remove */
    }
  }
  return removed
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveWakeMode — the resume-vs-fresh decision (TARGET redesign). The DAEMON
// decides by the DEATH CAUSE it tracks (.idle-reaped marker), plus peer-type /
// topic — NOT an agent-dropped fresh mark. Takes the adapter's resolveResume as a
// parameter so it is unit-testable without a runtime. The .idle-reaped marker is
// CONSUMED when the default branch acts on it (a wake side-effect).
// ─────────────────────────────────────────────────────────────────────────────

export interface WakeMode {
  resume: boolean
  resumeRef?: string
  /** Set ONLY for an EXPLICIT resume request that found nothing to resume — the
   *  caller must fail loud (never a silent fresh fallback). */
  failReason?: string
  /** Which decision branch fired — the durable "why fresh / why resume" reason.
   *  Logged by wakeOrSpawn: the .idle-reaped marker is CONSUMED inside this
   *  function (branch 3b), so this cause is the only surviving record of it. */
  cause?: string
}

/**
 * True iff the peer of `cwd` is a human-conversational peer — i.e. its local
 * profile declares an `interfaces.telegram` binding (a telegram-fronted dialogue).
 * Such a peer NEVER auto-freshes a resume-eligible wake; only an explicit /new
 * (eager) resets it. A profile read hiccup → not-human (safe default: an executor).
 */
function isHumanConversational(cwd: string): boolean {
  try {
    const ifaces = readPeerProfile(cwd)?.interfaces
    return !!(ifaces && ifaces.telegram != null)
  } catch {
    return false
  }
}

/**
 * True iff the peer of `cwd` declares `wake_policy: "ephemeral"` — a stateless worker
 * that ALWAYS wakes fresh on delivery (never resume), dies after its turn, and whose
 * warm-session deliveries are queued (M3). A profile read hiccup → not-ephemeral (safe
 * default: normal warm-on-demand). When BOTH ephemeral and a telegram interface are
 * set, ephemeral WINS in resolveWakeMode (explicit policy beats the inferred human
 * type) — provision warns on that combination; it should not occur for real workers.
 */
export function isEphemeralPeer(cwd: string): boolean {
  try {
    return readPeerProfile(cwd)?.wake_policy === 'ephemeral'
  } catch {
    return false
  }
}

/**
 * Decide resume vs fresh on a wake (TARGET redesign). Branch order:
 *   1. argsResume === false (folder-launch `iapeer <runtime>`) → FRESH.
 *   2. argsResume === true (attach) → RESUME; FAIL-LOUD via resolveResume if there
 *      is nothing to resume (failReason set; never a silent fresh fallback).
 *   3. default (argsResume undefined — a message woke a dead/asleep peer):
 *      a. NOT hasIdleReaped → FRESH. (It died on its own: crash / self-close. A
 *         crash needs a CLEAN fresh, not a re-crashing resume of a broken context;
 *         durable handoff carries continuity.)
 *      b. hasIdleReaped (CONSUME the marker now) → resume-eligible, then by type:
 *         - human-conversational (interfaces.telegram present) → RESUME.
 *         - executor: incomingTopic non-empty AND differs from stored .topic →
 *           FRESH (new work); else (same topic, or no incoming topic) → RESUME.
 */
export function resolveWakeMode(
  cfg: LifecycleConfig,
  identity: string,
  cwd: string,
  argsResume: boolean | undefined,
  resolveResume: (cwd: string) => { ok: boolean; ref?: string; reason?: string },
  incomingTopic?: string,
): WakeMode {
  // 1. folder-launch → always fresh.
  if (argsResume === false) return { resume: false, cause: 'folder-launch' }
  // 2. attach → always resume, fail-loud if nothing to resume.
  if (argsResume === true) {
    const r = resolveResume(cwd)
    if (!r.ok) return { resume: false, failReason: r.reason ?? 'resume requested but nothing to resume', cause: 'attach-nothing-to-resume' }
    return { resume: true, resumeRef: r.ref, cause: 'attach' }
  }
  // 3-soft-reload (LAZY fleet refresh, `iapeer refresh`): a `.fresh-next` mark means "come up FRESH on the
  // next natural wake" — re-read doctrine/fragments from disk WITHOUT killing the live session or burst-
  // waking the fleet. Checked at the TOP of branch 3, BEFORE the type/death-cause logic, so it overrides
  // resume for ALL peer types — including telegram-fronted (human-conversational) ones, which otherwise
  // RESUME and chew stale doctrine session-after-session until an explicit /new. Consume-on-fire: clear
  // .fresh-next AND .idle-reaped (mirror the ephemeral hygiene below — else a stale .idle-reaped would make
  // a later CRASH read as a clean park in 3b → RESUME a killed context, exactly the 3a hazard).
  if (hasFreshNext(cfg, identity)) {
    clearFreshNext(cfg, identity)
    clearIdleReaped(cfg, identity)
    return { resume: false, cause: 'soft-reload' }
  }
  // 3. default (a message woke a dead/asleep peer): decide by the death cause.
  // 3-ephemeral (M1): a stateless worker ALWAYS wakes fresh on delivery — never resume,
  // regardless of death cause or topic. Its clean-window-per-task is the whole point.
  // Consume a stray .idle-reaped marker so it does not accumulate (it has no effect for
  // an ephemeral peer, which never resumes, but keep state tidy).
  if (isEphemeralPeer(cwd)) {
    clearIdleReaped(cfg, identity)
    return { resume: false, cause: 'ephemeral-policy' }
  }
  // 3a. NOT parked-clean → FRESH either way, but tell the two cases apart in the
  // cause: a peer with NO transcript at all never ran here —
  // that is its FIRST-ever wake, not a crash. (A peer whose transcripts were rotated
  // away also reads first-wake — equally honest: there is nothing it could resume.)
  if (!hasIdleReaped(cfg, identity)) {
    return resolveResume(cwd).ok
      ? { resume: false, cause: 'crash-or-self-close' }
      : { resume: false, cause: 'first-wake' }
  }
  // 3b. idle-reaped → resume-eligible. Consume the marker now (it has done its job).
  clearIdleReaped(cfg, identity)
  // human-conversational dialogue never auto-freshes; only an explicit /new resets it.
  if (isHumanConversational(cwd)) {
    const r = resolveResume(cwd)
    return r.ok
      ? { resume: true, resumeRef: r.ref, cause: 'idle-reaped-human' }
      : { resume: false, cause: 'idle-reaped-human-no-resume' }
  }
  // executor: RESUME is an INTENTIONAL "continue THIS work" signal — it happens ONLY when
  // the incoming message carries a topic that matches the session's topic set. A DIFFERENT
  // topic (new work) OR NO topic at all → FRESH. Rationale: a topicless ping after an idle
  // gap is not a request to resume specific work; defaulting it to resume revived stale
  // context (e.g. a 3-day-old session). The sender opts INTO continuity by passing the topic.
  const topic = incomingTopic?.trim() ?? ''
  if (!topic) return { resume: false, cause: 'idle-reaped-no-topic' }
  // RESUME if the incoming topic matches ANY thread this session lineage worked on — not
  // just the last. Different threads accumulate in one session; a later ping on an earlier
  // thread continues that context. A topic the session never touched → new work → FRESH.
  if (!hasTopic(cfg, identity, topic)) return { resume: false, cause: 'idle-reaped-new-topic' }
  const r = resolveResume(cwd)
  return r.ok
    ? { resume: true, resumeRef: r.ref, cause: 'idle-reaped-resume' }
    : { resume: false, cause: 'idle-reaped-no-resume' }
}

export function readSessionStates(cfg: LifecycleConfig): SessionState[] {
  let files: string[]
  try {
    files = readdirSync(cfg.stateDir)
  } catch {
    return []
  }
  const out: SessionState[] = []
  for (const f of files) {
    if (!f.endsWith('.session')) continue
    try {
      const s = JSON.parse(readFileSync(join(cfg.stateDir, f), 'utf8')) as SessionState
      if (s && s.identity && s.cwd && isRuntime(s.runtime)) out.push(s)
    } catch {
      /* skip garbage */
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// H5 — wake-runtime resolution (registry-based, NO live-socket scan)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide which runtime to wake on a miss, WITHOUT scanning live sockets (a dead
 * peer has none — the registry is the only source). Order: an explicit
 * caller-supplied runtime (must be declared) → peer.runtime (registry default)
 * → first of peer.runtimes[] → fail-loud. (blueprint-v2 §H5)
 */
export function resolveWakeRuntime(
  requested: string | undefined,
  peer: PeerRecord,
): Result<Runtime> {
  if (requested) {
    if (!isRuntime(requested)) return err(`invalid runtime "${requested}"`)
    if (peer.runtime !== requested && !peer.runtimes.includes(requested)) {
      return err(`runtime "${requested}" is not declared for "${peer.personality}"`)
    }
    return ok(requested)
  }
  if (peer.runtime) return ok(peer.runtime)
  if (peer.runtimes.length > 0) return ok(peer.runtimes[0])
  return err(`cannot pick a runtime to wake "${peer.personality}"; specify runtime`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Wake lock — serialize wake per identity (idempotent; concurrent = one spawn)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run `fn` while holding an exclusive per-identity lock so two concurrent sends
 * to the same dead peer produce exactly ONE spawn (the second waits, then takes
 * the has-session fast path inside the lock). flock-style advisory lock via
 * proper-lockfile on ~/.iapeer/state/lifecycle/<identity>.wake.lock.
 */
export async function withWakeLock<T>(
  cfg: LifecycleConfig,
  identity: string,
  fn: () => Promise<T>,
): Promise<T> {
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  const lockTarget = join(cfg.stateDir, `${identity}.wake.lock`)
  writeFileSync(lockTarget, '', { flag: 'a', mode: 0o600 })
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    stale: 60_000,
    update: 5_000,
    retries: { retries: cfg.wakeLockRetries, factor: 1.3, minTimeout: 100, maxTimeout: 1_000 },
    // В5 — a compromised wake-lock (mtime-refresh timer fired late, e.g. after system sleep >60s) MUST
    // NOT rethrow from proper-lockfile's timer: unhandled it crashes the whole router and silently drops
    // the in-memory composer queue. Log and continue — a controlled degrade beats killing the daemon.
    onCompromised: (err: Error) => {
      process.stderr.write(`[iapeer] WARN wake-lock compromised for ${identity} (continuing, not crashing): ${err.message}\n`)
    },
  })
  try {
    return await fn()
  } finally {
    await release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// liveness
// ─────────────────────────────────────────────────────────────────────────────

function sessionAlive(_sock: string, identity: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // pty-only: a peer is alive iff its supervisor session is live (a cheap pid-file check). Routing
  // liveness on the live session (not the `.pty-host` spawn-intent marker) keeps a marker rollback safe
  // on a still-running session. (`_sock` retained for call-site compatibility; no tmux sockets exist.)
  // env sandboxes the run-dir — a test with an injected root must not read the real fleet's liveness.
  return hostSessionAlive(identity, env)
}

/** Death-class tag for a gone session (pty-only). A gone peer is a supervisor session that ended; its
 *  real cause lives in the supervisor exits.log (death-EVENT). There is no tmux server to distinguish
 *  `session-gone` (pane died, server alive) from `server-dead` (server gone). This tag is
 *  observability-only (lifecycle.log trace) and drives no decision. The `death`/`hosted` shape is kept
 *  for the trace schema + call-site compatibility. */
export function classifyGoneSession(_sock: string, _hosted = false): { death: 'server-dead' | 'session-gone'; reason: string } {
  return { death: 'server-dead', reason: 'pty host session ended (supervisor) — cause in exits.log (death-EVENT)' }
}

// ─────────────────────────────────────────────────────────────────────────────
// System-prompt composition for a woken peer (delegates the jq doctrine-merge to
// launch/composeSystemPrompt). The tmux launch + boot/ready + activity-proxy all
// moved to launch/ (Ф3); lifecycle only gathers the inputs and decides when.
// ─────────────────────────────────────────────────────────────────────────────

function gatherSystemFacts(env: NodeJS.ProcessEnv): {
  platform: string
  osVersion: string
  user: string
  hostname: string
  today: string
} {
  const platform =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'linux'
        ? 'linux'
        : String(process.platform)
  let osVersion = 'unknown'
  if (platform === 'darwin') {
    const r = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' })
    if (r.status === 0) osVersion = (r.stdout ?? '').trim() || 'unknown'
  } else if (platform === 'linux') {
    try {
      const m = readFileSync('/etc/os-release', 'utf8').match(/^VERSION_ID="?([^"\n]+)/m)
      osVersion = m?.[1] ?? 'unknown'
    } catch {
      /* unknown */
    }
  }
  let hostname = 'unknown'
  const h = spawnSync('hostname', ['-s'], { encoding: 'utf8' })
  if (h.status === 0 && (h.stdout ?? '').trim()) hostname = h.stdout.trim()
  let user = env.USER?.trim() ?? ''
  if (!user) {
    const r = spawnSync('id', ['-un'], { encoding: 'utf8' })
    user = (r.stdout ?? '').trim() || 'unknown'
  }
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { platform, osVersion, user, hostname, today }
}

/**
 * Compose the merged system prompt for a peer that carries a doctrine and write
 * it to a per-identity file, returning its path (for --system-prompt-file /
 * model_instructions_file).
 *
 * Канал A, all four layers (docs/Сборка системного промпта): 1 YAML facts +
 * 2 IAPEER.md (global+local) + 3 normalized registry + 4 every other <DOMAIN>.md
 * (global+local). FS discovery is delegated to gatherPromptInput; composeSystem
 * Prompt lays out the bytes. Layers 3+4 add nothing when there are no peers and
 * no extra domains, so the output stays golden-identical for a bare doctrine.
 *
 * BARE-SESSION GATE (unchanged): a peer WITHOUT a local <cwd>/.iapeer/IAPEER.md
 * doctrine → undefined (a throwaway test peer launches bare). The local doctrine
 * is what marks "this is a configured peer" (contract: role lives in that file).
 */
function composePeerPrompt(
  peer: PeerRecord,
  cwd: string,
  identity: string,
  cfg: LifecycleConfig,
  env: NodeJS.ProcessEnv,
  peers: PublicPeerSummary[],
): string | undefined {
  const peerDoctrinePath = join(cwd, '.iapeer', 'IAPEER.md')
  if (!existsSync(peerDoctrinePath)) return undefined
  const facts = gatherSystemFacts(env)
  // `peers` is the registry already read for findPeer (wake path) — passed through
  // so gatherPromptInput does NOT read+parse peers-profiles.json a second time on
  // this hot launch path (and the corrupt-registry failure stays at that one read).
  const input = gatherPromptInput({
    personality: peer.personality,
    description: peer.description,
    cwd,
    ...facts,
    env,
    peers,
  })
  const prompt = composeSystemPrompt(input)
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  const file = join(cfg.stateDir, `${identity}.system-prompt.md`)
  writeFileSync(file, prompt, { mode: 0o600 })
  return file
}

/**
 * C2 — compose the first message delivered to a FRESH-woken session: the peer's
 * initial_prompt (launch-seed, contract ЖЦ §initial_prompt) followed by the routed
 * `task` (the IAP envelope), so the agent sees the opening directive THEN the message
 * it must reply to (with its from-*). On resume (fresh=false) or with no seed → just
 * the task. The seed is read from the local profile best-effort: a profile read error
 * yields no seed and never blocks the wake (the seed is optional).
 */
export function composeFirstMessage(cwd: string, task: string, fresh: boolean): string {
  if (!fresh) return task
  let seed: string | undefined
  try {
    seed = readPeerProfile(cwd)?.initial_prompt
  } catch {
    /* invalid/absent profile → no seed */
  }
  if (!seed) return task
  // seed + the routed message (both delivered, seed first). When there is NO incoming
  // message (an eager /new re-launch, C4b — task is empty), the seed is self-sufficient.
  return task ? `${seed}\n\n${task}` : seed
}

// ─────────────────────────────────────────────────────────────────────────────
// wakeOrSpawn — the WakeFn (= performSpawn consolidated, boot+ready inline)
// ─────────────────────────────────────────────────────────────────────────────

export interface WakeArgs {
  personality: string
  runtime?: string
  topic?: string
  /** First message delivered to the woken session (the routed envelope). */
  task: string
  resume?: boolean
}

export interface WakeResult {
  status: 'READY' | 'FAILED'
  woke: boolean
  runtime?: Runtime
  process_address?: string
  reason?: string
  /** C1: the wake was refused because the peer carries a durable stop flag (a
   *  deliberate halt, distinct from offline/wake-failure). The sender is told the
   *  peer is stopped, not that delivery failed transiently. */
  stopped?: boolean
  /** Was `task` actually delivered by this wake? true on the launch path (the
   *  task rode as the boot first-message); FALSE on the idempotent live-session
   *  fast path — a CONCURRENT sender's boot won the lock and only ITS envelope
   *  was delivered; this caller's task was NOT. The caller (routeSend) must then
   *  deliver the envelope itself via the live path, or the second sender's
   *  message is silently lost behind a false ok (contract forbids silent loss). */
  taskDelivered?: boolean
}

export interface WakeDeps {
  env?: NodeJS.ProcessEnv
  cfg?: LifecycleConfig
}

/**
 * Wake (or, idempotently, reuse) a peer session and deliver `task` as its first
 * message; resolve to READY only after the model has produced its first turn
 * (transcript mtime advances past baseline). Serialized per-identity by
 * withWakeLock. Refuses a launchd-managed peer (H4). Ф2 claude path; codex is a
 * follow-up (the structure generalizes).
 */
export async function wakeOrSpawn(args: WakeArgs, deps: WakeDeps = {}): Promise<WakeResult> {
  const env = deps.env ?? process.env
  const cfg = deps.cfg ?? loadLifecycleConfig(env)

  // Durable wake-decision trace (eventlog.ts): one line per bring-up decision —
  // fresh / resume (with the resolveWakeMode cause) or a refusal (stopped / crash-
  // loop / launchd). This is the direct answer to "why did peer X come up fresh",
  // and the only surviving record of the .idle-reaped marker resolveWakeMode consumes.
  const logWake = (fields: Record<string, string | number | undefined>): void =>
    appendLifecycleEvent(cfg.eventLogDir, { ev: 'wake', personality: args.personality, ...fields }, { env })

  // Heal strays before launching — the sweep-at-spawn-start. This is the SAME
  // H4-guarded superviseTick the daemon timer runs, so both reap entry points
  // (timer + wake) go through one guarded path. Best-effort: never block a wake.
  try {
    superviseTick(cfg, { env })
  } catch {
    /* supervision must never affect this wake's outcome */
  }

  const peersIndex = readPeersIndex({ env })
  const peer = findPeer(peersIndex, args.personality)
  if (!peer) return { status: 'FAILED', woke: false, reason: `unknown peer "${args.personality}"` }

  // H4 — never wake a launchd-managed peer (launchd KeepAlive owns it).
  if (isLaunchdManaged(args.personality, env)) {
    logWake({ runtime: args.runtime, mode: 'refused', cause: 'launchd-managed' })
    return {
      status: 'FAILED',
      woke: false,
      reason: `"${args.personality}" is launchd-managed; the daemon does not wake it (launchd KeepAlive owns its lifecycle)`,
    }
  }

  const runtimeResult = resolveWakeRuntime(args.runtime, peer)
  if (!runtimeResult.ok) return { status: 'FAILED', woke: false, reason: runtimeResult.error.message }
  const runtime = runtimeResult.value

  // Resolve the per-runtime adapter (launch = HOW). getAdapter throws only for an
  // unregistered runtime (claude/codex/telegram/notifier are all registered);
  // surface that as FAILED rather than letting it escape the wake.
  let adapter
  try {
    adapter = getAdapter(runtime)
  } catch (e) {
    return { status: 'FAILED', woke: false, runtime, reason: e instanceof Error ? e.message : String(e) }
  }

  const identity = buildProcessAddress(runtime, args.personality)
  const sock = buildSocketPath(runtime, args.personality, cfg.sockDir)
  const cwd = peer.cwd

  // C1 — durable stopped flag: a DELIBERATELY stopped peer is NOT woken (contract
  // ЖЦ §stop, Демон §stopped). Unlike idle-reap (temporary), `stop` is an operator
  // halt: refuse with stopped:true so the sender gets an explicit "stopped" error,
  // not a generic "offline" — and no message is queued. `start` clears the flag.
  if (isStopped(cfg, identity)) {
    logWake({ identity, runtime, mode: 'refused', cause: 'stopped' })
    return {
      status: 'FAILED',
      woke: false,
      runtime,
      stopped: true,
      reason: `"${args.personality}" (${runtime}) is stopped and not accepting messages; start it to resume`,
    }
  }

  const runWake = async (): Promise<WakeResult> => {
    // Re-check the refusal gates INSIDE the lock (audit #3/#11): a `stop` (C1 flag) or a
    // plist install that completed AFTER the pre-lock check but before the lock was
    // acquired must still be honored — else a concurrently stopped / launchd-claimed peer
    // could be spawned live-but-flagged. These re-checks are fail-SAFE (they only add a
    // refusal). A stop racing DURING the spawn is a narrower window the wake-lock does not
    // cover (stop does not take this lock).
    if (isStopped(cfg, identity)) {
      logWake({ identity, runtime, mode: 'refused', cause: 'stopped-mid-wake' })
      return { status: 'FAILED', woke: false, runtime, stopped: true, reason: `"${args.personality}" (${runtime}) is stopped and not accepting messages; start it to resume` }
    }
    if (isLaunchdManaged(args.personality, env)) {
      logWake({ identity, runtime, mode: 'refused', cause: 'launchd-managed-mid-wake' })
      return { status: 'FAILED', woke: false, runtime, reason: `"${args.personality}" became launchd-managed mid-wake; the daemon does not wake it` }
    }
    // Idempotent fast path inside the lock: a live session wins (a concurrent
    // wake already brought it up) — no second spawn.
    if (sessionAlive(sock, identity, env)) {
      writeSessionState(cfg, { identity, runtime, personality: args.personality, cwd, wokeAt: Date.now() })
      // taskDelivered:false — the winning concurrent wake delivered ITS OWN task as
      // the boot first-message; THIS caller's task was not delivered by anything.
      return { status: 'READY', woke: false, runtime, process_address: identity, taskDelivered: false }
    }
    if (!existsSync(cwd)) {
      return { status: 'FAILED', woke: false, runtime, reason: `peer cwd does not exist: ${cwd}` }
    }

    // Crash-loop guard — BEFORE launching: if the peer has died crashLoopMax times
    // within crashLoopWindowSecs, refuse to (re)launch and leave it asleep (a clear
    // FAILED reason, not a silent fresh that re-crashes). A successful wake below
    // trims the ring, so the guard only fires on a genuine tight loop.
    const recentDeaths = countRecentDeaths(cfg, identity, cfg.crashLoopWindowSecs, Date.now())
    if (recentDeaths >= cfg.crashLoopMax) {
      logWake({ identity, runtime, mode: 'refused', cause: 'crash-loop', reason: `${recentDeaths} deaths in ${cfg.crashLoopWindowSecs}s` })
      return {
        status: 'FAILED',
        woke: false,
        runtime,
        reason: `crash-loop guard: ${recentDeaths} deaths in ${cfg.crashLoopWindowSecs}s, leaving asleep`,
      }
    }

    // Resolve resume vs fresh (TARGET redesign resolveWakeMode): the daemon decides
    // by the death cause (.idle-reaped marker) + peer-type/topic. An EXPLICIT resume
    // that finds nothing to resume fails loud. incomingTopic (args.topic) is the
    // executor discriminator.
    const mode = resolveWakeMode(cfg, identity, cwd, args.resume, c => adapter.resolveResume(c), args.topic)
    // The bring-up decision is the durable trace — log it BEFORE launch (the decision
    // stands regardless of whether the subsequent launch succeeds). resolveWakeMode has
    // already consumed any .idle-reaped marker, so `cause` is now its only record.
    logWake({
      identity,
      runtime,
      mode: mode.failReason ? 'fail' : mode.resume ? 'resume' : 'fresh',
      cause: mode.cause,
      ref: mode.resumeRef,
      reason: mode.failReason,
    })
    if (mode.failReason) return { status: 'FAILED', woke: false, runtime, reason: mode.failReason }
    const resume = mode.resume
    const resumeRef = mode.resumeRef
    const fresh = !resume

    // Compose the system prompt when the peer carries a doctrine (tui runtimes);
    // a doctrine-less peer (throwaway) → undefined → a bare session.
    const systemPromptFile = adapter.usesDoctrine
      ? composePeerPrompt(peer, cwd, identity, cfg, env, peersIndex.peers.map(publicPeerSummary))
      : undefined

    // Hand the fully-resolved spec to the launch primitive (HOW). lifecycle has
    // made every WHEN/HOW-MANY decision (lock, registry, H4, runtime, resume).
    const spec: LaunchSpec = {
      personality: args.personality,
      runtime,
      cwd,
      identity,
      socketPath: sock,
      systemPromptFile,
      resume, // RESOLVED resume/fresh (C3a), not the raw caller flag
      resumeRef,
      extraArgs: [],
      // Carry the peer's nature so the launch primitive can enforce an adapter's
      // intelligence gate (telegram requires natural). From the registry record.
      intelligence: peer.intelligence,
    }
    const launchCfg: LaunchConfig = {
      claudeBin: cfg.claudeBin,
      codexBin: cfg.codexBin,
      sockDir: cfg.sockDir,
      bootDeadlineSecs: cfg.bootDeadlineSecs,
      readyGateSecs: cfg.readyGateSecs,
      logDir: cfg.logDir,
      // Exit-cause log → next to lifecycle.log (~/.iapeer/logs/iapeer), where the
      // investigator already looks: a self-death now leaves `exits.log` with the
      // status/signal the daemon's post-factum reaped-gone could never recover.
      exitLogDir: cfg.eventLogDir,
      env,
    }
    // C2 — initial_prompt (launch-seed): on a FRESH wake, seed the first turn with
    // the peer's initial_prompt BEFORE the routed message — the agent sees the
    // opening directive, then the IAP message (with its from-* to reply to). NOT on
    // resume (a resumed session already holds its context). Best-effort read: a
    // profile read hiccup must never block the wake (the seed is optional).
    const firstMessage = composeFirstMessage(cwd, args.task, fresh)
    const result = await launch(spec, adapter, firstMessage, launchCfg)
    if (result.status === 'FAILED') {
      // enroll-on-FAILED (0.2.57): launch can return FAILED on a ready-gate false-negative
      // (model-did-not-process-task) while the tmux session + its process actually SURVIVE —
      // observed live. Since 0.2.55 removed the self-TTL, such a remnant
      // would be an UNBOUNDED orphan: no .session → invisible to superviseTick's idle-reap,
      // and no wall-clock backstop. If the session is in fact ALIVE, enroll it so the
      // activity-aware idle-reap stays the UNIVERSAL bound (a genuinely wedged session is
      // idle-reaped after idleSecs; a false-negative-but-working one keeps working and is
      // reaped only when truly idle, and its next message reaches it via the has-session fast
      // path above). We do NOT flip to READY — the wake DID fail its ready-gate, the caller
      // must still hear FAILED; we only make the live remnant supervised. Best-effort: a write
      // hiccup must not mask the original FAILED reason.
      if (sessionAlive(sock, identity, env)) {
        try {
          writeSessionState(cfg, { identity, runtime, personality: args.personality, cwd, wokeAt: Date.now() })
        } catch { /* keep the original FAILED reason — enroll is best-effort */ }
      } else {
        // В14 — the launch FAILED and left NO live remnant → a genuine boot-crash (broken binary /
        // doctrine, process died before READY). It writes NO .session, so superviseTick never sees it
        // and never records the death → countRecentDeaths stays 0 and the crash-loop guard NEVER fires.
        // Every next message / ephemeral-drain then re-runs the doomed launch (up to bootDeadline each)
        // forever. Count the fault here so the guard bounds the loop after crashLoopMax in the window.
        // (No claim needed — there is no .session for a concurrent pass to race on.)
        recordDeath(cfg, identity, Date.now())
      }
      return { status: 'FAILED', woke: false, runtime, reason: result.reason }
    }
    // The session is up and the message delivered. Recording supervise-state must not
    // turn a successful wake into a failure (audit #18): log loudly rather than throw
    // past a live spawn. NB since 0.2.55 (self-TTL removed) the session-state file IS
    // the only thing that enrolls this session into the activity-aware idle-reap — a
    // failed write leaves it UNSUPERVISED with no TTL backstop, hence the loud WARN.
    try {
      writeSessionState(cfg, { identity, runtime, personality: args.personality, cwd, wokeAt: Date.now() })
    } catch (e) {
      process.stderr.write(
        `[iapeer] WARN session-state write failed for ${identity} — session is live but UNSUPERVISED (not enrolled in idle-reap; self-TTL removed): ${e instanceof Error ? e.message : String(e)}\n`,
      )
    }
    // A NEWLY launched session starts UNARMED by definition (no outbound yet) — clear
    // any stray .ephemeral-armed so it can never quiet-reap this session before its
    // reply. ONLY here on the actual launch path, NEVER on the live-session fast path
    // above (a live session may be legitimately armed mid-quiet-window).
    clearEphemeralArmed(cfg, identity)
    // Establish/extend the session's topic SET (executor resume discriminator) and reset the
    // crash-loop ring. A FRESH wake starts a new lineage → drop the old topic set; a RESUME
    // keeps accumulating. The wake's own topic joins the set (no-op if empty). resolveWakeMode
    // already read the OLD set above, so mutating here is safe. Best-effort.
    if (!mode.resume) resetTopics(cfg, identity)
    addTopic(cfg, identity, args.topic?.trim() ?? '')
    trimDeaths(cfg, identity, cfg.crashLoopWindowSecs, Date.now())
    return { status: 'READY', woke: true, runtime, process_address: identity, taskDelivered: true }
  }

  try {
    return await withWakeLock(cfg, identity, runWake)
  } catch (e) {
    // В15 — the wake-lock retry budget (~25s) is shorter than a legitimate boot (bootDeadline +
    // readyGate, up to minutes). A concurrent send to a WAKING peer can exhaust it → proper-lockfile
    // throws ELOCKED, which otherwise escaped through routeSend as a raw protocol error with NO
    // delivery.log line (a hole in the very log that reconstructs a suspected loss). Convert it to a
    // RETRYABLE FAILED: the sender retries, the fast path then finds the now-live session, and routeSend
    // records the outcome. re-resolving each retry = verify-before-act (no false-OK).
    const msg = e instanceof Error ? e.message : String(e)
    if ((e as NodeJS.ErrnoException).code === 'ELOCKED' || /\bELOCKED\b|lock.*already.*held/i.test(msg)) {
      logWake({ identity, runtime, mode: 'refused', cause: 'wake-lock-held' })
      return {
        status: 'FAILED',
        woke: false,
        runtime,
        reason: `"${args.personality}" (${runtime}) wake already in progress (another wake holds the lock) — retry shortly`,
      }
    }
    throw e
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reap — kill a session (used by idle-reap / supervise; H4-guarded by callers)
// ─────────────────────────────────────────────────────────────────────────────

export function killSession(_sock: string, identity: string, env: NodeJS.ProcessEnv = process.env): void {
  // pty-only: SIGTERM the supervisor daemon — its shutdown SIGKILLs the child and removes the
  // sock/pid/serve-spec/markers. Idempotent if the session is already gone. (`_sock` retained for
  // call-site compatibility; no tmux sockets exist.) env sandboxes the run-dir — a test with an
  // injected root must NEVER SIGTERM a real fleet peer's supervisor.
  killPtyHost(identity, env)
}

// ─────────────────────────────────────────────────────────────────────────────
// superviseTick — the SINGLE H4-guarded reap pass (idle + zombie-gone)
// ─────────────────────────────────────────────────────────────────────────────
//
// Walks only daemon-owned sessions (those wakeOrSpawn recorded a .session for —
// a launchd peer never has one). For each candidate the launchd-plist check is
// FIRST: a launchd-managed peer is skipped untouched (H4 — the daemon is
// read-only for it; reaping it would fight launchd KeepAlive on the live fleet).
// In this consolidation the idle-reap and the zombie-sweep are ONE guarded path,
// so no reap can bypass H4. Called by the daemon's supervise timer AND at the
// start of every wakeOrSpawn (heal strays before launching).

export interface SuperviseOutcome {
  identity: string
  action: 'reaped-idle' | 'reaped-gone' | 'reaped-ephemeral' | 'skipped-launchd' | 'skipped-stopped' | 'alive' | 'needs-eager-fresh' | 'skipped-error'
  reason?: string
  /** For 'needs-eager-fresh': the peer to EAGERLY re-launch fresh (its session died
   *  carrying a .new-eager mark). The daemon timer drives the async relaunch.
   *  Also set on 'reaped-ephemeral' — the M3 queue-drain hook needs the peer to
   *  wake fresh for the next queued task. */
  personality?: string
  runtime?: Runtime
}

export interface SuperviseDeps {
  env?: NodeJS.ProcessEnv
  nowMs?: number
  /** IDLE-proxy seam (default: the runtime adapter's `lastTurnMtime` = content-ts of the last meaningful
   *  transcript entry). This is the RELIABLE idle signal — NOT the transcript FILE mtime (re-saved at
   *  idle) and NOT the pane-log mtime (a statusline re-render ticks it at idle); both falsely keep an
   *  idle session young. Tests inject a controlled value to exercise the idle/quiet age hermetically. */
  lastTurnMtime?: (runtime: string, cwd: string) => number | null
  /** Liveness seam (default: the real `sessionAlive` = pty-host pid-file check). Tests inject a fixed
   *  verdict so the idle path is exercised hermetically — no live pty session needed. */
  sessionAlive?: (sock: string, identity: string) => boolean
  /** Reap seam (default: the real `killSession` = SIGTERM the supervisor daemon). Tests inject a no-op
   *  so exercising the reap path NEVER SIGTERMs a real process — the destructive-kill isolation guard. */
  killSession?: (sock: string, identity: string) => void
}

/** Resolved per-tick context threaded into superviseOnePeer (deps already defaulted by superviseTick). */
interface SuperviseCtx {
  cfg: LifecycleConfig
  env: NodeJS.ProcessEnv
  nowMs: number
  lastTurnMt: (runtime: string, cwd: string) => number | null
  isAlive: (sock: string, identity: string) => boolean
  kill: (sock: string, identity: string) => void
  verbose: boolean
  trace: (fields: Record<string, string | number | undefined>) => void
}

/**
 * Evaluate ONE daemon-owned session and take its at-most-one reap action, returning the outcome.
 * Extracted from superviseTick so a throw on a SINGLE peer can be ISOLATED by the caller: a malformed
 * peer-state must never abort the whole sweep (that is the silent fleet-wide reap-outage class — one bad
 * peer and NO peer gets reaped, the error swallowed by the daemon's supervise-tick catch). Every branch
 * returns exactly one outcome; the trace side-effects mirror the prior inline behaviour.
 */
function superviseOnePeer(s: SessionState, ctx: SuperviseCtx): SuperviseOutcome {
  const { cfg, env, nowMs, lastTurnMt, isAlive, kill, verbose, trace } = ctx
  // H4 — FIRST, before any reap. A launchd-managed peer is read-only.
  if (isLaunchdManaged(s.personality, env)) {
    if (verbose) trace({ identity: s.identity, action: 'skipped-launchd', outcome: 'read-only-h4' })
    return { identity: s.identity, action: 'skipped-launchd' }
  }
  const sock = buildSocketPath(s.runtime, s.personality, cfg.sockDir)
  if (!isAlive(sock, s.identity)) {
    // A DELIBERATE stop is not a death: the stop verb parks clean
    // (.stopped + .idle-reaped) and kills the session itself. Catch-up branch for
    // a stop that raced this tick (or a pre-fix stop): drop the state quietly —
    // no crash-loop entry, no death class — and ensure the clean-park marker so
    // the post-`start` wake RESUMES (stop→start must survive ≥ idle-reap).
    if (isStopped(cfg, s.identity)) {
      removeSessionState(cfg, s.identity)
      clearEphemeralArmed(cfg, s.identity)
      setIdleReaped(cfg, s.identity) // idempotent with the stop verb's own park
      trace({ identity: s.identity, action: 'skipped-stopped', outcome: 'resume-on-start' })
      return { identity: s.identity, action: 'skipped-stopped', reason: 'deliberate stop — parked clean, resumes on start' }
    }
    // A dead session: record a death for crash-loop accounting, then branch on the
    // .new-eager mark. This death was NOT daemon-initiated (the daemon only initiates
    // the idle-reap below) → it died on its own → do NOT write .idle-reaped here.
    // ATOMIC CLAIM (В16): a concurrent supervise pass (daemon timer + a CLI-process
    // wakeOrSpawn prelude) must not BOTH recordDeath — two deaths for one real death can
    // trip the crash-loop guard prematurely. The rename-claim makes recordDeath + eager
    // happen exactly once; the loser reports a benign concurrently-reaped outcome.
    if (!claimDeadSession(cfg, s.identity)) {
      return { identity: s.identity, action: 'reaped-gone', reason: 'concurrently reaped by another supervise pass' }
    }
    recordDeath(cfg, s.identity, nowMs)
    rmSync(`${sessionStatePath(cfg, s.identity)}.reaping`, { force: true }) // claim token consumed
    // The .ephemeral-armed mark belongs to THIS (now dead) session — it armed on its
    // outbound reply. Clear it with the session, so a successor session can never be
    // quiet-reaped on a stale mark before answering its own task. No-op otherwise.
    clearEphemeralArmed(cfg, s.identity)
    // A session that died carrying a .new-eager mark is an owner /new: re-launch
    // EAGERLY as fresh (not lazily on the next message). The mark is LEFT for the
    // eager relaunch (processEagerRelaunches) to consume; the daemon timer drives it.
    if (hasNewEager(cfg, s.identity)) {
      trace({ identity: s.identity, action: 'needs-eager-fresh', reason: '/new eager mark', outcome: 'eager-fresh' })
      return {
        identity: s.identity,
        action: 'needs-eager-fresh',
        reason: '/new eager mark — eager fresh re-launch',
        personality: s.personality,
        runtime: s.runtime,
      }
    }
    // Crash / self-close: NO marker written, NO eager relaunch — the peer stays
    // asleep and wakes FRESH lazily on the next message (resolveWakeMode branch 3a).
    // The death-class tag (classifyGoneSession) makes the two gone-classes
    // distinguishable in lifecycle.log: `session-gone` (pane died, server alive →
    // exits.log should have the cause) vs `server-dead` (whole tmux server died →
    // exits.log structurally empty; this line is the only durable trace).
    const gone = classifyGoneSession(sock)
    trace({ identity: s.identity, action: 'reaped-gone', death: gone.death, reason: gone.reason, outcome: 'fresh-next-msg' })
    return { identity: s.identity, action: 'reaped-gone', reason: gone.reason }
  }
  // В17 — a LIVE session carrying the .stopped flag is an illegitimate state: `stop` takes no wake-lock,
  // so a stop that raced an in-flight wake killed the pre-pidfile session as a no-op and the wake then
  // drove a NEW session to READY → alive + .stopped. The live path (routeSend) does not re-check
  // .stopped, so this peer keeps accepting messages until idle-reap (up to 1h) — the operator halt
  // silently failed. Reap it now (catch-up for the window the wake-lock cannot cover). H4 is already
  // cleared above; no legitimate alive+stopped state exists. Park like the stop verb (.idle-reaped is
  // idempotent with it) — .stopped keeps the peer down until `start`, .idle-reaped makes it resume-clean.
  if (isStopped(cfg, s.identity)) {
    kill(sock, s.identity)
    setIdleReaped(cfg, s.identity)
    clearEphemeralArmed(cfg, s.identity)
    removeSessionState(cfg, s.identity)
    trace({ identity: s.identity, action: 'reaped-idle', reason: 'alive-but-stopped', outcome: 'operator-halt-enforced' })
    return { identity: s.identity, action: 'reaped-idle', reason: 'live session carried .stopped — operator halt enforced (stop-vs-wake race)' }
  }
  // Idle accounting via the LAST MEANINGFUL TRANSCRIPT ENTRY's content-timestamp (adapter.lastTurnMtime)
  // — the only RELIABLE idle signal. The two raw mtimes both report FALSE freshness for an idle session:
  //   • pane-log mtime — a statusline / footer re-render writes pty bytes at idle (the clock/usage/ctx%
  //     redraw + Claude Code's own update-check/token-counter), so the pane-log ticks at the prompt. The
  //     0.4.16 invariant "the pane-log goes quiet ONLY at the prompt" was broken by the statusline.
  //   • transcript FILE mtime — a live claude session RE-SAVES its .jsonl without appending a new entry,
  //     so the file is fresh while the last real turn was hours ago (the 0.4.16 re-touch).
  // Both made real peers live idle 3-5h UNREAPED (incident 23.06: perplex/mrwriter/doc). The transcript
  // ENTRY stream only advances on actual turn activity, so the last timestamped entry is the true last
  // turn. The launch ready-gate keeps newestActivityMtime (file-mtime advance = "a turn produced
  // output"). FLOORED at wokeAt: a freshly-woken session that produced no turn yet (lastTurn from a PRIOR
  // session is old) must not be reaped out from under an attaching op — max(lastTurn, wokeAt) reaps it
  // idleSecs after the wake, never before. null lastTurn (unreadable / churned out of the tail) → wokeAt
  // governs (an old wokeAt = woken-long-ago = idle → reaped; a recent wokeAt = just-woken → protected).
  const ephemeral = isEphemeralPeer(s.cwd)
  let lt = 0
  try { lt = lastTurnMt(s.runtime, s.cwd) ?? 0 } catch { /* unreadable → wokeAt floor */ }
  const mt = Math.max(lt, s.wokeAt)
  const ageSecs = Math.floor((nowMs - mt) / 1000)
  // wake_policy:ephemeral M2 — die-after-reply: an ARMED ephemeral session (the
  // daemon routed its outbound reply) is reaped after a QUIET window, checked
  // BEFORE the idle branch (quiet ≪ idle). Quiet = the pane-log silent for
  // ephemeralQuietSecs (the reliable render signal above) — a still-rendering turn
  // keeps it fresh, so the worker finishes its turn first; post-reply housekeeping
  // (operative-note writes) also advances it.
  // NOT armed (still mid-task) → the ordinary idle bound below is its only reaper.
  // Deliberate, policy-driven death: NO .idle-reaped (an ephemeral peer never resumes)
  // and NO recordDeath (the crash-loop ring counts faults, not policy reaps).
  if (ephemeral && hasEphemeralArmed(cfg, s.identity) && ageSecs > cfg.ephemeralQuietSecs) {
    kill(sock, s.identity)
    clearEphemeralArmed(cfg, s.identity)
    removeSessionState(cfg, s.identity)
    trace({ identity: s.identity, action: 'reaped-ephemeral', age: `${ageSecs}s`, outcome: 'ephemeral-done' })
    return {
      identity: s.identity,
      action: 'reaped-ephemeral',
      reason: `armed, quiet ${ageSecs}s`,
      personality: s.personality,
      runtime: s.runtime,
    }
  }
  // UNARMED ephemeral idle bound (live case): a worker that ended
  // SILENTLY (no final outbound → never armed; or its arm was lost to a CLI/
  // daemon-restart window) used to wait out the FULL generic idleSecs (1 h) —
  // and the M3 serial drain waits for the session's death, so ONE silent worker
  // stalled its whole conveyor. This bound is the defense-in-depth backstop:
  // ≫ the legitimate silent-tool case (sleep-180), ≪ idleSecs. The ШТАТНЫЙ
  // silent-finish path is `iapeer self-done` (arm without waking anyone —
  // the invariant «нет пустых пробуждений» stays intact); this branch only
  // bounds the damage when a worker does neither. Policy reap: NO .idle-reaped
  // (ephemeral never resumes), NO recordDeath (the ring counts faults). The pane-log
  // fold-in above also covers this branch: a STILL-WORKING unarmed worker (a silent
  // tool, no reply yet) keeps the pane-log fresh via the TUI render, so it is no longer
  // reaped mid-task — only a genuinely idle/wedged unarmed session crosses this bound.
  if (ephemeral && ageSecs > cfg.ephemeralUnarmedIdleSecs) {
    kill(sock, s.identity)
    clearEphemeralArmed(cfg, s.identity)
    removeSessionState(cfg, s.identity)
    trace({ identity: s.identity, action: 'reaped-ephemeral', age: `${ageSecs}s`, outcome: 'ephemeral-unarmed-bound' })
    return {
      identity: s.identity,
      action: 'reaped-ephemeral',
      reason: `unarmed idle ${ageSecs}s (silent-finish backstop; штатный путь — iapeer self-done)`,
      personality: s.personality,
      runtime: s.runtime,
    }
  }
  if (ageSecs > cfg.idleSecs) {
    // THE ONLY place .idle-reaped is written: this is the one death the daemon
    // INITIATES. Its presence on the next wake = the session was parked cleanly =
    // RESUME-eligible (resolveWakeMode branch 3b). A crash/self-close (the dead
    // branch above) never writes it → that wakes FRESH (branch 3a).
    kill(sock, s.identity)
    setIdleReaped(cfg, s.identity)
    removeSessionState(cfg, s.identity)
    trace({ identity: s.identity, action: 'reaped-idle', age: `${ageSecs}s`, outcome: 'resume-eligible' })
    return { identity: s.identity, action: 'reaped-idle', reason: `idle ${ageSecs}s` }
  }
  // ALIVE and not idle. (pty-only: no tmux server-death canary — a hosted death is recorded by the
  // supervisor's exits.log and classified by classifyGoneSession on the next sweep.)
  if (verbose) trace({ identity: s.identity, action: 'alive', age: `${ageSecs}s` })
  return { identity: s.identity, action: 'alive' }
}

export function superviseTick(cfg: LifecycleConfig, deps: SuperviseDeps = {}): SuperviseOutcome[] {
  const env = deps.env ?? process.env
  const nowMs = deps.nowMs ?? Date.now()
  const lastTurnMt = deps.lastTurnMtime ?? ((rt: string, c: string) => getAdapter(rt as Runtime).lastTurnMtime(c))
  // Default seams bind the injected env so a sandboxed tick never reads/kills the real fleet.
  const isAlive = deps.sessionAlive ?? ((sock: string, identity: string) => sessionAlive(sock, identity, env))
  const kill = deps.killSession ?? ((sock: string, identity: string) => killSession(sock, identity, env))
  const verbose = superviseLogVerbose(env)
  // Pane-log volume cap (launch/cmdlog.ts capPaneLogs): the per-identity pane-log
  // (<logDir>/<identity>.log) is the RAW TUI byte stream pipe-pane/the supervisor
  // append for a session's whole life — it had NO bound and grew to hundreds of MB
  // per warm peer on an always-on host. Tail-keep it each tick (KEEP ≥ the occupancy
  // reader's 4 MiB seed window, so capping never starves composer detection).
  // Not H4-gated: log janitoring is orthogonal to lifecycle ownership, so launchd-
  // managed peers' pane-logs are capped too. Best-effort by construction.
  capPaneLogs(cfg.logDir)
  // Durable decision trace (eventlog.ts): every reap/death/eager-fresh gets a line
  // so a postmortem can answer "when & how did peer X's prior session end" even
  // after the .idle-reaped / .deaths markers are consumed. alive / skipped-launchd
  // are steady-state non-decisions → logged only under IAPEER_SUPERVISE_LOG_VERBOSE.
  const trace = (fields: Record<string, string | number | undefined>): void =>
    appendLifecycleEvent(cfg.eventLogDir, { ev: 'supervise', ...fields }, { env, nowMs })
  const out: SuperviseOutcome[] = []
  const ctx: SuperviseCtx = { cfg, env, nowMs, lastTurnMt, isAlive, kill, verbose, trace }
  for (const s of readSessionStates(cfg)) {
    // Per-peer ISOLATION: a throw while evaluating ONE peer must NOT abort the whole sweep — that is
    // the silent fleet-wide reap-outage class (one malformed peer-state and NO peer gets reaped, the
    // error swallowed by the daemon's supervise-tick catch). Catch it, log it loudly to lifecycle.log,
    // and continue to the next peer — the rest of the fleet is still swept.
    try {
      out.push(superviseOnePeer(s, ctx))
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      out.push({ identity: s.identity, action: 'skipped-error', reason })
      trace({ identity: s.identity, action: 'skipped-error', reason, outcome: 'peer-error-isolated' })
    }
  }
  return out
}

/**
 * Drive the EAGER fresh re-launch for peers superviseTick flagged 'needs-eager-fresh'
 * (their session died carrying a .new-eager mark — an owner /new). Async + best-effort:
 * task='' so the seed (initial_prompt) is self-sufficient (a /new has no incoming message
 * — the agent auto-reports "I'm up" from the seed). The relaunch is FRESH BY CONSTRUCTION:
 * we CONSUME .new-eager here and pass resume:false so wakeOrSpawn's resolveWakeMode takes
 * the folder-launch fresh branch WITHOUT consulting the death-cause markers. The mark is
 * consumed BEFORE the relaunch so a relaunch failure does not loop on the same eager mark
 * (it then fresh-wakes lazily on its next message — branch 3a — never lost). NB: a /new'd
 * peer is expected to carry an initial_prompt; without one the first turn delivers nothing.
 *
 * Runtime is DELIBERATELY NOT pinned to the dead session's runtime: the relaunch passes
 * no runtime so resolveWakeRuntime falls through to the registry default (H5 — registry
 * is the only source of wake-runtime truth). Pinning broke the fleet-switch procedure
 * (`default-runtime <rt>` + `self-fresh`): the peer silently resurrected on the OLD
 * runtime, ignoring the just-flipped default (live incident). A
 * session deliberately living on a non-default runtime has explicit paths back (wake
 * with an explicit runtime); an owner /new returns the peer to its declared default.
 */
export async function processEagerRelaunches(
  cfg: LifecycleConfig,
  outcomes: SuperviseOutcome[],
  deps: WakeDeps & { wakeFn?: (args: WakeArgs, deps: WakeDeps) => Promise<WakeResult> } = {},
): Promise<WakeResult[]> {
  const wake = deps.wakeFn ?? wakeOrSpawn
  const results: WakeResult[] = []
  for (const o of outcomes) {
    if (o.action !== 'needs-eager-fresh' || !o.personality) continue
    clearNewEager(cfg, o.identity) // consume the eager mark — the relaunch is fresh by construction
    try {
      results.push(
        await wake(
          { personality: o.personality, task: '', resume: false },
          { cfg, env: deps.env },
        ),
      )
    } catch (e) {
      results.push({ status: 'FAILED', woke: false, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// wake_policy:"ephemeral" M3 — the serial-queue DRAIN. Deliveries to an ephemeral
// target are always ENQUEUED (transport's injected ephemeral seam → queue.ts);
// this is the consumer side: feed the worker ONE task per fresh session.
// Re-export the queue API so consumers (daemon main, tests) reach it through the
// module index.
// ─────────────────────────────────────────────────────────────────────────────

export {
  enqueueEphemeralTask,
  ephemeralQueueDepth,
  ephemeralQueueDir,
  listQueuedIdentities,
  peekEphemeralTask,
  removeEphemeralTask,
  type EphemeralQueueItem,
  type PeekedQueueItem,
} from './queue.ts'

export interface DrainDeps {
  env?: NodeJS.ProcessEnv
  /** Injectable wake (tests); default wakeOrSpawn. */
  wakeFn?: (args: WakeArgs, deps: WakeDeps) => Promise<WakeResult>
}

/**
 * Feed ONE queued task to an ephemeral worker IFF it has no live session:
 * peek → wake FRESH (the task is the boot first-message; resolveWakeMode takes
 * the ephemeral-policy branch) → remove the item ONLY on READY. A FAILED wake
 * LEAVES the item at the head — the next supervise-tick drain retries it (the
 * crash-loop guard bounds a tight failure loop, its refusals land in
 * lifecycle.log). Returns null when there is nothing to do (empty queue, or a
 * session is still live — invariant: ≤1 live session = exactly one task).
 * Serialization: concurrent drains converge on wakeOrSpawn's per-identity
 * wake.lock — the loser takes the idempotent live-session fast path and the
 * item is removed once, delivered once.
 */
export async function drainEphemeralQueue(
  cfg: LifecycleConfig,
  personality: string,
  runtime: Runtime,
  deps: DrainDeps = {},
): Promise<WakeResult | null> {
  const env = deps.env ?? process.env
  const identity = buildProcessAddress(runtime, personality)
  const sock = buildSocketPath(runtime, personality, cfg.sockDir)
  if (sessionAlive(sock, identity, env)) return null // one task per session — wait for its reap
  const item = peekEphemeralTask(cfg, identity)
  if (!item) return null
  // Durable drain trace: which item, how deep the queue.
  appendLifecycleEvent(
    cfg.eventLogDir,
    { ev: 'ephemeral-drain', identity, seq: item.seq, depth: ephemeralQueueDepth(cfg, identity) },
    { env },
  )
  const wake = deps.wakeFn ?? wakeOrSpawn
  const result = await wake({ personality, runtime, topic: item.topic, task: item.task }, { cfg, env })
  // Remove ONLY when THIS wake actually delivered the task. On the live-session fast
  // path (READY, taskDelivered:false) a CONCURRENT wake delivered ITS OWN task — ours
  // was NOT delivered. Deleting it here would silently drop a queued task (the loss the
  // contract forbids); leaving it at the head lets the next drain (after that session
  // reaps) deliver it into a fresh session — invariant "one task = one fresh session".
  if (result.status === 'READY' && result.taskDelivered !== false) {
    removeEphemeralTask(cfg, identity, item.seq)
  }
  return result
}

/**
 * Drain every identity with a non-empty queue and no live session — the daemon's
 * supervise-tick hook. ONE mechanism is the whole M3 delivery loop: the inline
 * kick after an enqueue covers the cold/empty case, and this periodic scan covers
 * (a) the next task after a reaped-ephemeral (same tick that reaped it),
 * (b) drain-on-start (the queue is durable across daemon restarts), and
 * (c) the RETRY of a failed wake (the item was left at the head). H4-guarded:
 * a launchd-managed peer is never woken by a drain (it should never have a
 * queue, but the guard is structural, not situational).
 */
export async function drainAllEphemeralQueues(cfg: LifecycleConfig, deps: DrainDeps = {}): Promise<WakeResult[]> {
  const env = deps.env ?? process.env
  const results: WakeResult[] = []
  for (const identity of listQueuedIdentities(cfg)) {
    const parsed = parseSessionName(identity)
    if (!parsed) continue
    if (isLaunchdManaged(parsed.personality, env)) continue
    try {
      const r = await drainEphemeralQueue(cfg, parsed.personality, parsed.runtime, deps)
      if (r) results.push(r)
    } catch (e) {
      results.push({ status: 'FAILED', woke: false, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return results
}

// ─────────────────────────────────────────────────────────────────────────────
// folderLaunch / attachPeer — operator verbs (contract ЖЦ §Запуск из папки, §attach;
// Примитивы §Карта verbs). Both reuse wakeOrSpawn (one bring-up path); the difference
// is resume vs fresh and which runtime.
// ─────────────────────────────────────────────────────────────────────────────

export interface FolderLaunchOptions {
  cwd: string
  runtime?: string
  env?: NodeJS.ProcessEnv
  cfg?: LifecycleConfig
}

/**
 * `iapeer <runtime>` (launch) — bring up the peer of the CURRENT cwd, ALWAYS FRESH
 * (contract: folder-launch never resumes). personality/runtime come from the cwd's
 * profile (resolveIdentity), not an arg. The fresh session carries the initial_prompt
 * seed if the peer has one (composeFirstMessage), else a bare interactive session the
 * operator drives. Goes through wakeOrSpawn (resume:false) so H4 / the wake-lock /
 * the intelligence gate all apply — incl. H4 refusal for a launchd-managed peer (a
 * fresh folder-launch alongside its launchd session would collide on the identity).
 */
export async function folderLaunch(opts: FolderLaunchOptions): Promise<WakeResult> {
  const env = opts.env ?? process.env
  const cfg = opts.cfg ?? loadLifecycleConfig(env)
  const identity = resolveIdentity({ cwd: opts.cwd, env })
  const runtime = opts.runtime ?? identity.runtime
  const seed = composeFirstMessage(opts.cwd, '', true) // initial_prompt or '' (bare)
  return wakeOrSpawn({ personality: identity.personality, runtime, task: seed, resume: false }, { cfg, env })
}

/**
 * The runtime with the freshest transcript activity for a peer. undefined when no
 * runtime has any activity (a never-run peer). NOTE: this is NO LONGER the attach
 * default — operator runtime resolution moved to `resolvePeerRuntime` (default_runtime
 * anchored) because last-active-by-mtime is hidden state and unreliable for codex
 * (rollout flushed only on a real turn). Kept as a diagnostic / `list` helper.
 */
export function lastActiveRuntime(peer: PeerRecord, cfg: LifecycleConfig): Runtime | undefined {
  let best: Runtime | undefined
  let bestMt = -1
  for (const rt of peer.runtimes) {
    try {
      const mt = getAdapter(rt).newestActivityMtime(peer.cwd)
      if (mt !== null && mt > bestMt) {
        bestMt = mt
        best = rt
      }
    } catch {
      /* no adapter / no proxy for this runtime */
    }
  }
  return best
}

/** Runtimes of `peer` whose session is LIVE right now (lifecycle-local liveness,
 *  same `sessionAlive` predicate the wake/attach paths use). */
function liveRuntimesOf(peer: PeerRecord, cfg: LifecycleConfig, env: NodeJS.ProcessEnv = process.env): Runtime[] {
  return peer.runtimes.filter(rt =>
    sessionAlive(buildSocketPath(rt, peer.personality, cfg.sockDir), buildProcessAddress(rt, peer.personality), env),
  )
}

/**
 * The SINGLE runtime an operator verb (new / attach / compact) acts on when the
 * runtime arg is OMITTED, for a peer that may declare several. PREDICTABLE by
 * construction and IDENTICAL across those verbs — this is the fix for the
 * multi-runtime footgun where `new` defaulted to `default_runtime` while `attach`
 * defaulted to last-active-by-mtime, so `iapeer new <peer>` freshed one runtime
 * while `iapeer attach <peer>` resurrected the other ("new had no effect, attach
 * came up on the old session").
 *
 * Precedence (never refuses — the naive flow must self-resolve, no explicit arg):
 *   1. sole declared runtime → it.
 *   2. `default_runtime` is LIVE → `default_runtime` (the configured anchor AND the
 *      obvious running target).
 *   3. exactly ONE other runtime is live (default dead) → that live one.
 *   4. otherwise (nothing live, or 2+ live without the default) → `default_runtime`.
 *
 * The peer's runtime is governed by its CONFIGURABLE `default_runtime` (the
 * documented `iapeer default-runtime` lever), NOT by which transcript was touched
 * last — last-active-by-mtime is hidden state and unreliable for codex (its rollout
 * file is flushed only on a real model turn, so a just-spawned fresh codex session
 * reads as "older" than a stale one). To make `iapeer new/attach <peer>` (no runtime
 * arg) resolve to codex, set the peer's default to codex once; per-command runtime
 * args remain the explicit override.
 */
export function resolvePeerRuntime(peer: PeerRecord, cfg: LifecycleConfig, env: NodeJS.ProcessEnv = process.env): Runtime {
  if (peer.runtimes.length === 1) return peer.runtimes[0]
  const live = liveRuntimesOf(peer, cfg, env)
  if (live.includes(peer.runtime)) return peer.runtime
  if (live.length === 1) return live[0]
  return peer.runtime
}

export interface AttachOptions {
  personality: string
  runtime?: string
  env?: NodeJS.ProcessEnv
  cfg?: LifecycleConfig
}
export type AttachResult =
  | { ok: true; identity: string; socketPath: string; woke: boolean; runtime: Runtime }
  | { ok: false; reason: string }

/**
 * `iapeer attach <peer> [runtime]` — ensure the peer is live, then hand back the
 * socket/identity for the caller to `tmux attach`. ALWAYS RESUME (contract: attach
 * never starts fresh). Runtime: explicit arg, else `resolvePeerRuntime` (the SAME
 * resolver `new`/`compact` use — default_runtime anchored with a sole-live
 * refinement), so attach and new never disagree on which runtime "peer" means. A
 * warm-live session is attached directly; a warm-asleep one is woken with --resume
 * first (fail-loud if there is nothing to resume — a never-run peer must be folder-launched).
 */
export async function attachPeer(opts: AttachOptions): Promise<AttachResult> {
  const env = opts.env ?? process.env
  const cfg = opts.cfg ?? loadLifecycleConfig(env)
  const peer = findPeer(readPeersIndex({ env }), opts.personality)
  if (!peer) return { ok: false, reason: `peer "${opts.personality}" is not registered` }
  const runtimeResult = resolveWakeRuntime(opts.runtime, peer)
  if (opts.runtime && !runtimeResult.ok) return { ok: false, reason: runtimeResult.error.message }
  // Omitted runtime resolves IDENTICALLY to `new`/`compact` (resolvePeerRuntime):
  // default_runtime anchored, sole-live refinement, never hidden last-active — so
  // `iapeer attach <peer>` and `iapeer new <peer>` never disagree on the runtime.
  const runtime = opts.runtime ?? resolvePeerRuntime(peer, cfg)
  const identity = buildProcessAddress(runtime, opts.personality)
  const sock = buildSocketPath(runtime, opts.personality, cfg.sockDir)
  if (sessionAlive(sock, identity, env)) return { ok: true, identity, socketPath: sock, woke: false, runtime }
  const woke = await wakeOrSpawn({ personality: opts.personality, runtime, task: '', resume: true }, { cfg, env })
  if (woke.status === 'FAILED') return { ok: false, reason: woke.reason ?? 'wake failed' }
  return { ok: true, identity, socketPath: sock, woke: true, runtime }
}
