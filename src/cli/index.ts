// iapeer CLI — the unified operator/agent entrypoint (`iapeer <verb> …`, contract
// Примитивы §Карта verbs). Thin verbs over the foundation primitives: list (registry
// + liveness + C1 stopped), stop/start (C1 durable flag for warm; launchctl for
// always-on), send (routeSend fallback). init delegates to src/init; launch (folder)
// and attach (last-active resume) land in the next increment.
//
// FLEET SAFETY (H4): the live persistent-peer fleet is launchd-managed (com.iapeer.<p>
// plists the foundation does NOT own). stop/start REFUSE such a peer — the foundation
// is read-only for it; stopping it would fight PP's KeepAlive / tear a live telegram
// bridge off launchd. Only foundation-owned peers (warm no-plist, or our own
// sentinel-marked always-on plist) are stop/start-able.

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, renameSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import {
  isInfraRuntime,
  isRuntime,
  type Intelligence,
  type Runtime,
} from '../core/constants.ts'
import { IAPEER_VERSION } from '../core/version.ts'
import { cascadeTail, recycleFoundationOwnedInfraJobs, updateIapeer, waitForDaemonHealthy } from '../update/index.ts'
import { buildProcessAddress, buildSocketPath, parseSessionName } from '../core/socket.ts'
import { ensureGlobalIapScaffold } from '../storage/index.ts'
import { findPeer, readPeersIndex, removePeer, type PeerRecord } from '../registry/index.ts'
import { compactDoneBaseline, isPeerLive, routeControl, routeSend, waitForCompactDone, type WakeFn } from '../transport/index.ts'
import {
  attachPeer,
  clearIdleReaped,
  clearNewEager,
  clearStopped,
  folderLaunch,
  hasIdleReaped,
  isLaunchdManaged,
  isEphemeralPeer,
  isStopped,
  killSession,
  loadLifecycleConfig,
  purgeIdentityState,
  removeSessionState,
  resolvePeerRuntime,
  setEphemeralArmed,
  setFreshNext,
  setIdleReaped,
  setNewEager,
  setStopped,
  wakeOrSpawn,
  type WakeResult,
} from '../lifecycle/index.ts'
import { getAdapter } from '../launch/index.ts'
import { hostRunDir } from '../launch/ptyHost.ts' // pty-only: attach via the supervisor client
import { runSupervisorClient } from '../supervisor/client.ts' // @xterm-free attach client (both reattach port-deps baked in)
import { cycleDaemon, isFoundationOwnedPlist, launchctlBootstrap, launchdLabel, launchdPlistPath } from '../launch/launchd.ts'
import { readPeerProfile, renamePeer, resolveCallerIdentity, resolveIdentity, writePeerProfileAtomic } from '../identity/index.ts'
import { claudeProjectsRoot, transcriptSlug } from '../launch/adapters/claude.ts'
import { peerProfilePath } from '../storage/index.ts'
import {
  isConformant,
  migrateProfileRuntimeField,
  reconcileIndex,
  reindexFromLocals,
  validateProfileStandard,
} from '../identity/profileStandard.ts'
import { runAlwaysOn } from '../launch/launchdRun.ts'
import { ensureDaemonStarted, installDaemonPlist, parseDaemonPort, startConfiguredDaemon } from '../daemon/main.ts'
import { MARKETPLACE_NAME, onboardHost, runtimeAuthNote, tccFullDiskAccessNote } from '../onboard/index.ts'
import { probeFullDiskAccess, readMemoryProvider } from '../status/index.ts'
import { appendLifecycleEvent } from '../lifecycle/eventlog.ts'
import { pluginLogsDir } from '../storage/index.ts'

function infraRecycleNote(infra: readonly { personality: string; state: string; detail?: string }[] | undefined): string {
  if (!infra?.length) return ''
  const touched = infra.filter(i => i.state === 'restarted').map(i => i.personality)
  const failed = infra.filter(i => i.state === 'failed')
  const passive = infra.filter(i => i.state !== 'restarted' && i.state !== 'failed')
  const parts: string[] = []
  if (touched.length) parts.push(`infra recycled: ${touched.join(', ')}`)
  if (passive.length) parts.push(`infra ${passive.map(i => `${i.personality} ${i.state}`).join(', ')}`)
  if (failed.length) parts.push(`infra FAILED: ${failed.map(i => `${i.personality}${i.detail ? ` (${i.detail})` : ''}`).join('; ')}`)
  return parts.length ? `; ${parts.join('; ')}` : ''
}

function infraRecycleFailed(infra: readonly { state: string }[] | undefined): boolean {
  return (infra ?? []).some(i => i.state === 'failed')
}

// ─────────────────────────────────────────────────────────────────────────────
// list — registry + per-runtime liveness (contract Примитивы §list)
// ─────────────────────────────────────────────────────────────────────────────

export type RuntimeLiveness = 'live' | 'asleep' | 'stopped'
export interface RuntimeStatus {
  runtime: Runtime
  status: RuntimeLiveness
}
export interface PeerListing {
  personality: string
  default_runtime: Runtime
  /** Runtime with the freshest activity (what `attach` resumes); undefined if none. */
  last_active_runtime?: Runtime
  /** Epoch-ms of that freshest activity (the dashboard's ACTIVE age column);
   *  undefined when no runtime has an activity proxy. */
  last_active_ms?: number
  intelligence: Intelligence
  description: string
  /** The peer's working directory (registry fact). Machine-readable so host-local
   *  tooling (e.g. the memory provider's init/verify rendering doctrine into
   *  <cwd>/.iapeer/) keys on the REGISTRY instead of copying the layout default —
   *  a layout change must not silently strand consumers. */
  cwd: string
  runtimes: RuntimeStatus[]
}

export interface CliEnvOptions {
  env?: NodeJS.ProcessEnv
}

/**
 * Gather the peer listing: one row per registered peer, per-runtime liveness (live
 * via tmux has-session / stopped via the C1 durable flag / else asleep) and the
 * last-active runtime by transcript-mtime (the same proxy `attach` keys on).
 */
export function listPeers(opts: CliEnvOptions = {}): PeerListing[] {
  const env = opts.env ?? process.env
  const cfg = loadLifecycleConfig(env)
  const index = readPeersIndex({ env })
  return index.peers.map(peer => {
    const runtimes: RuntimeStatus[] = peer.runtimes.map(rt => ({
      runtime: rt,
      status: isPeerLive(rt, peer.personality, cfg.sockDir, env)
        ? 'live'
        : isStopped(cfg, buildProcessAddress(rt, peer.personality))
          ? 'stopped'
          : 'asleep',
    }))
    let lastActive: Runtime | undefined
    let bestMt = -1
    for (const rt of peer.runtimes) {
      try {
        const mt = getAdapter(rt).newestActivityMtime(peer.cwd)
        if (mt !== null && mt > bestMt) {
          bestMt = mt
          lastActive = rt
        }
      } catch {
        /* no adapter / no proxy for this runtime */
      }
    }
    return {
      personality: peer.personality,
      default_runtime: peer.runtime,
      last_active_runtime: lastActive,
      last_active_ms: bestMt >= 0 ? bestMt : undefined,
      intelligence: peer.intelligence,
      description: peer.description,
      cwd: peer.cwd,
      runtimes,
    }
  })
}

const GLYPH: Record<RuntimeLiveness, string> = { live: '●', asleep: '○', stopped: '✕' }

/** Render the scriptable list table (non-tty default). Columns are PADDED to align
 *  (name · [default] · nature · liveness) — a ragged table reads as noise. The
 *  trailing liveness column is variable-width, so it needs no padding. */
export function formatListTable(rows: PeerListing[]): string {
  if (rows.length === 0) return 'no peers registered\n'
  const cells = rows.map(r => ({
    name: r.personality,
    rt: `[${r.default_runtime}]`,
    intel: r.intelligence,
    status:
      r.runtimes.map(s => `${GLYPH[s.status]} ${s.runtime}`).join('  ') +
      (r.last_active_runtime ? `  last-active:${r.last_active_runtime}` : ''),
  }))
  const wName = Math.max(...cells.map(c => c.name.length))
  const wRt = Math.max(...cells.map(c => c.rt.length))
  const wIntel = Math.max(...cells.map(c => c.intel.length))
  const lines = cells.map(c => `${c.name.padEnd(wName)}  ${c.rt.padEnd(wRt)}  ${c.intel.padEnd(wIntel)}  ${c.status}`)
  return lines.join('\n') + '\n'
}

// ─────────────────────────────────────────────────────────────────────────────
// stop / start — dispatch by runtime class, with the FLEET GUARD (H4)
// ─────────────────────────────────────────────────────────────────────────────

export interface StopStartOutcome {
  personality: string
  runtime: Runtime
  action: 'stopped' | 'started' | 'bootout' | 'bootstrap' | 'refused-foreign-launchd'
  reason?: string
}

function uid(): string {
  const r = spawnSync('id', ['-u'], { encoding: 'utf8' })
  const u = (r.stdout ?? '').trim()
  // Audit #29: NEVER fall back to '0' — that would aim launchctl bootout/bootstrap at
  // the ROOT gui domain. A non-numeric/empty result means `id -u` failed; refuse.
  if (!/^\d+$/.test(u)) {
    throw new Error('cannot resolve the current uid (id -u failed) — refusing to target launchctl at an unknown domain')
  }
  return u
}

/** FLEET GUARD: a peer launchd-managed by a NON-foundation plist (persistent-peer)
 *  is off-limits to stop/start — the foundation is read-only for it (H4). */
function isForeignLaunchd(personality: string, env: NodeJS.ProcessEnv): boolean {
  return isLaunchdManaged(personality, env) && !isFoundationOwnedPlist(launchdPlistPath(personality, env))
}

function targetRuntimes(peer: PeerRecord, runtime: string | undefined): Runtime[] {
  if (runtime) {
    // Audit #28: an explicit runtime the peer does not declare would act on a PHANTOM
    // identity — a spurious durable stop-flag or a no-op bootout on a label that isn't
    // this peer's. Refuse instead of silently targeting a non-existent runtime.
    if (peer.runtime !== runtime && !peer.runtimes.includes(runtime as Runtime)) {
      throw new Error(
        `peer "${peer.personality}" does not declare runtime "${runtime}" (declared: ${peer.runtimes.join(', ')})`,
      )
    }
    return [runtime as Runtime]
  }
  return peer.runtimes
}

/**
 * stop <peer> [runtime]: warm runtime → durable C1 stop flag + kill the session (the
 * daemon will not wake it until `start`); always-on (infra, foundation-owned) → launchctl
 * bootout + kill. REFUSES a foreign-launchd peer (live PP fleet) — fleet guard.
 */
export function stopPeer(personality: string, runtime: string | undefined, opts: CliEnvOptions = {}): StopStartOutcome[] {
  const env = opts.env ?? process.env
  const cfg = loadLifecycleConfig(env)
  const peer = findPeer(readPeersIndex({ env }), personality)
  if (!peer) throw new Error(`peer "${personality}" is not registered`)
  if (isForeignLaunchd(personality, env)) {
    return [{ personality, runtime: peer.runtime, action: 'refused-foreign-launchd', reason: `"${personality}" is managed by persistent-peer (foreign launchd plist) — the foundation does not stop it` }]
  }
  const out: StopStartOutcome[] = []
  for (const rt of targetRuntimes(peer, runtime)) {
    const identity = buildProcessAddress(rt, personality)
    const sock = buildSocketPath(rt, personality, cfg.sockDir)
    if (isInfraRuntime(rt)) {
      // Audit #13 + В48: do NOT swallow the launchctl result — but DISCRIMINATE. An
      // already-unloaded job (exit 3 / "No such process", verified live) is BENIGN for
      // stop: the desired state ("not running") already holds, so it carries NO reason
      // and must not fail the verb. Any other non-zero is a REAL error and sets reason
      // (the CLI maps a reasoned bootout to exit 1).
      const r = spawnSync('launchctl', ['bootout', `gui/${uid()}/${launchdLabel(personality)}`], { encoding: 'utf8' })
      killSession(sock, identity, env)
      const stderrText = (r.stderr ?? '').trim()
      const benign = r.status === 0 || r.status === 3 || /No such process/i.test(stderrText)
      const reason = benign ? undefined : `launchctl bootout exited ${r.status}${stderrText ? `: ${stderrText}` : ''}`
      out.push({ personality, runtime: rt, action: 'bootout', reason })
      appendLifecycleEvent(cfg.eventLogDir, { ev: 'stopped', identity, personality, runtime: rt, action: 'bootout', reason }, { env })
    } else {
      // A deliberate stop is a CLEAN PARK, not a death (stop→start must survive ≥
      // idle-reap): park-mark BEFORE the kill so the post-`start`
      // wake RESUMES, and drop the supervise session-state with the session so
      // the tick never tags this kill as a death (crash-loop ring stays clean,
      // no reaped-gone death class for a state the daemon knows 100%).
      setStopped(cfg, identity)
      setIdleReaped(cfg, identity)
      killSession(sock, identity, env)
      removeSessionState(cfg, identity)
      out.push({ personality, runtime: rt, action: 'stopped' })
      // Durable trace (fleet-API follow-up): the verb was SILENT in lifecycle.log — a
      // CLI stop changed the fleet state (● → ✕) with no event, so an SSE-fed client
      // (tray class) showed a stale status indefinitely (no event ⇒ no snapshot
      // re-read; only the initiator knew). One line per state-changing outcome; the
      // refused-foreign-launchd branch changes nothing and stays silent.
      appendLifecycleEvent(cfg.eventLogDir, { ev: 'stopped', identity, personality, runtime: rt, action: 'stopped' }, { env })
    }
  }
  return out
}

/**
 * start <peer> [runtime]: warm runtime → clear the C1 stop flag (wakeable again on
 * the next message); always-on → launchctl bootstrap the plist. REFUSES a foreign-
 * launchd peer (fleet guard).
 */
export function startPeer(personality: string, runtime: string | undefined, opts: CliEnvOptions = {}): StopStartOutcome[] {
  const env = opts.env ?? process.env
  const cfg = loadLifecycleConfig(env)
  const peer = findPeer(readPeersIndex({ env }), personality)
  if (!peer) throw new Error(`peer "${personality}" is not registered`)
  if (isForeignLaunchd(personality, env)) {
    return [{ personality, runtime: peer.runtime, action: 'refused-foreign-launchd', reason: `"${personality}" is managed by persistent-peer (foreign launchd plist) — the foundation does not start it` }]
  }
  const out: StopStartOutcome[] = []
  for (const rt of targetRuntimes(peer, runtime)) {
    const identity = buildProcessAddress(rt, personality)
    if (isInfraRuntime(rt)) {
      const plist = launchdPlistPath(personality, env)
      // UNDEAD-JOB-SAFE start: a bootstrap right after a bootout used to hit the
      // still-dismantling job (exit 5 I/O
      // error) and leave the router DOWN. launchctlBootstrap now waits for the
      // job to vanish and retries with backoff (~22 s budget); a failure after
      // every attempt is LOUD with the manual rescue recipe. (Also gains the
      // sentinel fleet-guard + sandbox guard the raw spawn never had.)
      const r = launchctlBootstrap(personality, plist, env)
      const ok = r.state === 'loaded' || r.state === 'already-loaded' || r.state === 'skipped-sandbox'
      const reason = ok
        ? undefined
        : `launchctl bootstrap FAILED${r.detail ? `: ${r.detail}` : ''} — peer not started; manual rescue: launchctl bootstrap gui/$(id -u) ${plist}`
      out.push({ personality, runtime: rt, action: 'bootstrap', reason })
      appendLifecycleEvent(cfg.eventLogDir, { ev: 'started', identity, personality, runtime: rt, action: 'bootstrap', reason }, { env })
    } else {
      clearStopped(cfg, identity)
      out.push({ personality, runtime: rt, action: 'started' })
      // Durable trace — mirror of the `stopped` event in stopPeer (✕ → ○ is a state
      // change an SSE-fed client must hear about).
      appendLifecycleEvent(cfg.eventLogDir, { ev: 'started', identity, personality, runtime: rt, action: 'started' }, { env })
    }
  }
  return out
}

export interface RefreshOutcome {
  personality: string
  runtime: Runtime
  action: 'refresh-armed' | 'skipped-non-agentic'
}

/** Runtimes that consume the layered system prompt (doctrine/fragments) — the only ones a soft-reload
 *  affects. Routers (notifier/telegram) and absent runtimes carry no doctrine. */
const AGENTIC_RUNTIMES: ReadonlySet<string> = new Set(['claude', 'codex'])

/**
 * refresh <peer> [runtime] (or --all): arm a LAZY soft-reload. Each agentic (claude/codex) runtime of the
 * peer comes up FRESH on its NEXT natural wake — re-reading doctrine/fragments from disk — WITHOUT killing
 * the live session and WITHOUT eager-relaunch / burst-wake. Non-agentic runtimes (notifier/telegram/absent)
 * are skipped (no doctrine). H4-safe: writes a `.fresh-next` marker only — never wakes / reaps / kills, so
 * it is inert for launchd-managed peers (their lifecycle is KeepAlive's, resolveWakeMode is not their path).
 * The lazy counterpart to `iapeer new` (hard kill) and self-fresh/.new-eager (eager relaunch + burst wake).
 */
export function refreshPeer(personality: string, runtime: string | undefined, opts: CliEnvOptions = {}): RefreshOutcome[] {
  const env = opts.env ?? process.env
  const cfg = loadLifecycleConfig(env)
  const peer = findPeer(readPeersIndex({ env }), personality)
  if (!peer) throw new Error(`peer "${personality}" is not registered`)
  const out: RefreshOutcome[] = []
  for (const rt of targetRuntimes(peer, runtime)) {
    if (!AGENTIC_RUNTIMES.has(rt)) {
      out.push({ personality, runtime: rt, action: 'skipped-non-agentic' })
      continue
    }
    setFreshNext(cfg, buildProcessAddress(rt, personality))
    out.push({ personality, runtime: rt, action: 'refresh-armed' })
  }
  return out
}

export interface AddRuntimeOutcome {
  personality: string
  action: 'added' | 'already' | 'skipped-infra-peer' | 'failed'
  detail?: string
}

/**
 * add-runtime <runtime> (--peer <p> | --all) — give EXISTING peers an additional
 * AGENTIC runtime in one command (the fleet-switch enabler — a claude-only peer
 * has nothing to switch to).
 * Per target: initPeer({cwd, runtime}) — ensurePeerProfile MERGES runtimes (the
 * default_runtime lever is deliberately untouched — capability ≠ routing flip; see
 * `default-runtime`), scaffolds the runtime scope, and the codex side runs its
 * whole birth chain: cwd pre-trust, native-memory lever, memory provision
 * (occasion=birth), host-wide MCP block + update-check-off. Idempotent by
 * construction (merge + append-if-absent everywhere). Infra PEERS (telegram/
 * notifier defaults) are skipped — adding an agentic runtime to a router peer is
 * an operator decision, not a sweep.
 */
export async function addRuntime(
  runtime: string,
  opts: CliEnvOptions & { peer?: string; all?: boolean },
): Promise<AddRuntimeOutcome[]> {
  const env = opts.env ?? process.env
  if (!isRuntime(runtime)) throw new Error(`invalid runtime "${runtime}"`)
  if (isInfraRuntime(runtime)) {
    throw new Error(`"${runtime}" is an infra runtime — infra presence is operator-add via \`iapeer create\` (plist semantics), not a sweep`)
  }
  const index = readPeersIndex({ env })
  const targets = opts.all === true ? index.peers : index.peers.filter(p => p.personality === opts.peer)
  if (targets.length === 0) throw new Error(opts.peer ? `peer "${opts.peer}" is not registered` : 'no targets — pass --peer <p> or --all')
  // CROSS-PEER operation: strip the CALLER's identity env (PEER_*) — an operator
  // (or an agent peer) running this from inside their own session would otherwise
  // poison the TARGET's ensurePeerProfile identity check (the caller's
  // PEER_PERSONALITY would mismatch the target personality → failed).
  const cleanEnv: NodeJS.ProcessEnv = { ...env }
  delete cleanEnv.PEER_PERSONALITY
  delete cleanEnv.PEER_RUNTIME
  delete cleanEnv.PEER_IDENTITY
  const { initPeer } = await import('../init/index.ts')
  const out: AddRuntimeOutcome[] = []
  for (const p of targets) {
    if (isInfraRuntime(p.runtime)) {
      out.push({ personality: p.personality, action: 'skipped-infra-peer', detail: `default runtime "${p.runtime}" is infra` })
      continue
    }
    if (p.runtimes.includes(runtime as Runtime)) {
      out.push({ personality: p.personality, action: 'already' })
      continue
    }
    try {
      const warns: string[] = []
      await initPeer({ cwd: p.cwd, runtime: runtime as Runtime, env: cleanEnv, warn: m => warns.push(m) })
      out.push({ personality: p.personality, action: 'added', detail: warns.length ? warns.join(' | ') : undefined })
    } catch (e) {
      out.push({ personality: p.personality, action: 'failed', detail: e instanceof Error ? e.message : String(e) })
    }
  }
  // Self-heal the registry from the locals: provisionPeer's upsert sets the record's
  // default to the PROVISIONED runtime («args.runtime wins» — right for births, wrong
  // here: add-runtime is capability-only and must NOT flip routing). The reindex
  // REPLACE projection restores the local profile's untouched default (otherwise
  // the registry default flips to the added runtime while the local keeps its own).
  if (out.some(o => o.action === 'added')) await reindexFromLocals({ env })
  return out
}

export interface DefaultRuntimeOutcome {
  personality: string
  action: 'flipped' | 'already' | 'refused-undeclared-runtime' | 'skipped-infra-peer' | 'failed'
  detail?: string
}

/**
 * default-runtime <runtime> (--peer <p> | --all) — flip the PRIMARY lever
 * (contract Идентичность: primary держит default_runtime, НЕ порядок runtimes[]).
 * This is the routing/wake/first-launch default — the
 * actual fleet-switch moment is a mass flip of exactly this field. The local
 * profile is rewritten through the H1 merge-writer (default_runtime + the legacy
 * in-sync mirror; normalizeRuntimes re-prepends the new default), then the
 * registry is self-healed from the flipped locals (the reindex REPLACE rail —
 * same as `verify --fix`), so routing flips in the same command. REFUSES a peer
 * that does not declare the runtime (add-runtime first) and skips infra peers.
 * Symmetric back: `default-runtime claude --all` reverts the fleet.
 */
export async function defaultRuntime(
  runtime: string,
  opts: CliEnvOptions & { peer?: string; all?: boolean },
): Promise<DefaultRuntimeOutcome[]> {
  const env = opts.env ?? process.env
  if (!isRuntime(runtime)) throw new Error(`invalid runtime "${runtime}"`)
  if (isInfraRuntime(runtime)) throw new Error(`"${runtime}" is an infra runtime — not a warm routing default`)
  const index = readPeersIndex({ env })
  const targets = opts.all === true ? index.peers : index.peers.filter(p => p.personality === opts.peer)
  if (targets.length === 0) throw new Error(opts.peer ? `peer "${opts.peer}" is not registered` : 'no targets — pass --peer <p> or --all')
  const out: DefaultRuntimeOutcome[] = []
  for (const p of targets) {
    if (isInfraRuntime(p.runtime)) {
      out.push({ personality: p.personality, action: 'skipped-infra-peer', detail: `default runtime "${p.runtime}" is infra` })
      continue
    }
    try {
      const profile = readPeerProfile(p.cwd)
      if (!profile) {
        out.push({ personality: p.personality, action: 'failed', detail: `no local profile at ${p.cwd}` })
        continue
      }
      if (profile.runtime === runtime) {
        out.push({ personality: p.personality, action: 'already' })
        continue
      }
      if (!profile.runtimes.includes(runtime as Runtime)) {
        out.push({
          personality: p.personality,
          action: 'refused-undeclared-runtime',
          detail: `declares [${profile.runtimes.join(', ')}] — run \`iapeer add-runtime ${runtime} --peer ${p.personality}\` first`,
        })
        continue
      }
      writePeerProfileAtomic(p.cwd, { ...profile, runtime: runtime as Runtime })
      out.push({ personality: p.personality, action: 'flipped' })
    } catch (e) {
      out.push({ personality: p.personality, action: 'failed', detail: e instanceof Error ? e.message : String(e) })
    }
  }
  // Self-heal the registry from the flipped locals so routing flips in the same
  // command (REPLACE projection — the verify --fix rail).
  if (out.some(o => o.action === 'flipped')) await reindexFromLocals({ env })
  return out
}

export interface NewPeerOutcome {
  personality: string
  runtime: string
  action: 'fresh' | 'refused-foreign-launchd' | 'refused-infra' | 'refused-undeclared-runtime' | 'failed'
  reason?: string
}

/**
 * new <peer> [runtime] — the UNCONDITIONAL fresh-restart control command
 * (docs/Control-команды §new).
 *
 * The emergency lever for a HUNG or dead agent session: /alias_new covers only
 * the COOPERATIVE path (a live peer reads the expanded prompt and runs
 * `iapeer self-fresh`); a stuck/raving/dead peer never reads a prompt — this
 * command restarts it MECHANICALLY, bypassing the peer entirely:
 *   fresh-slate markers (un-park C1 stop, clear stale .idle-reaped/.new-eager) →
 *   canary-clean teardown of any live session (killSession — a deliberate kill,
 *   never a death class; session-state dropped so supervise stays silent) →
 *   wakeOrSpawn(resume:false, task:'') — fresh BY CONSTRUCTION, the same recipe
 *   as the eager relaunch (the C2 initial_prompt seeds the first turn).
 *
 * exit-0 contract: success ⟺ the fresh session is UP
 * and READY (verified by the wake's ready gate, not merely scheduled) — for a
 * sleeping, dead AND hung target alike. Duration is a real TUI boot: typically
 * 5–30 s, bounded by cfg.bootDeadlineSecs. Idempotent in effect: each repeat
 * leaves exactly one fresh live session (concurrent calls serialize on the
 * wake lock). REFUSES foreign-launchd peers (fleet guard) and infra runtimes
 * (launchd-held — their restart is `launchctl kickstart`'s domain), like
 * stop/start; an explicitly-passed runtime the peer does not declare is an
 * explicit refusal (never a silent launch of an undeclared runtime).
 */
export async function newPeer(
  personality: string,
  runtime: string | undefined,
  opts: CliEnvOptions & { wakeFn?: (args: { personality: string; runtime: Runtime; task: string; resume: false }) => Promise<WakeResult> } = {},
): Promise<NewPeerOutcome> {
  const env = opts.env ?? process.env
  const cfg = loadLifecycleConfig(env)
  const peer = findPeer(readPeersIndex({ env }), personality)
  if (!peer) throw new Error(`peer "${personality}" is not registered`)
  if (isForeignLaunchd(personality, env)) {
    return {
      personality,
      runtime: peer.runtime,
      action: 'refused-foreign-launchd',
      reason: `"${personality}" is managed by persistent-peer (foreign launchd plist) — the foundation does not restart it`,
    }
  }
  if (runtime && !isRuntime(runtime)) throw new Error(`invalid runtime "${runtime}"`)
  // Omitted runtime resolves IDENTICALLY to `attach` (resolvePeerRuntime): default_runtime
  // anchored, sole-live refinement — so `iapeer new <peer>` and `iapeer attach <peer>` never
  // target different runtimes (the "new had no effect, attach resurrected the other" footgun).
  const rt: Runtime = (runtime as Runtime | undefined) ?? resolvePeerRuntime(peer, cfg)
  if (!peer.runtimes.includes(rt)) {
    return {
      personality,
      runtime: rt,
      action: 'refused-undeclared-runtime',
      reason: `peer "${personality}" does not declare runtime "${rt}" (declared: ${peer.runtimes.join(', ')})`,
    }
  }
  if (isInfraRuntime(rt)) {
    return {
      personality,
      runtime: rt,
      action: 'refused-infra',
      reason: `infra runtime "${rt}" is launchd-held — restart it with: launchctl kickstart -k gui/$(id -u)/${launchdLabel(personality)}`,
    }
  }
  const identity = buildProcessAddress(rt, personality)
  const sock = buildSocketPath(rt, personality, cfg.sockDir)
  // Fresh slate: an explicit operator /new outranks a C1 park (it demands a live
  // fresh session NOW) and any stale death/fresh markers (the wake below is fresh
  // by construction — markers must not leak into a LATER wake's decision).
  clearStopped(cfg, identity)
  clearIdleReaped(cfg, identity)
  clearNewEager(cfg, identity)
  killSession(sock, identity, env) // canary-clean deliberate teardown; no-op when dead
  removeSessionState(cfg, identity) // never a death class — supervise stays silent
  const wake = opts.wakeFn ?? (args => wakeOrSpawn(args, { cfg, env }))
  const r = await wake({ personality, runtime: rt, task: '', resume: false })
  if (r.status !== 'READY') {
    return { personality, runtime: rt, action: 'failed', reason: r.reason ?? 'wake failed' }
  }
  return { personality, runtime: rt, action: 'fresh' }
}

export interface CompactPeerOutcome {
  personality: string
  runtime: string
  action: 'compacted' | 'nothing-to-compact' | 'refused-foreign-launchd' | 'refused-infra' | 'refused-undeclared-runtime' | 'failed'
  woke?: boolean
  reason?: string
}

/**
 * compact <peer> [runtime] — compact the DIALOGUE, not merely the currently-live
 * session. A live target receives the in-session `/compact` control; a cleanly
 * idle-reaped target is first resumed into the same dialogue, then controlled.
 * SUCCESS is gated on actual compaction completion (structured transcript marker
 * after the command + input surface ready), not on keystrokes being accepted. A
 * crashed / never-run / non-resumable target returns an honest "nothing to compact"
 * instead of starting a fresh empty session and compacting that.
 */
export async function compactPeer(
  personality: string,
  runtime: string | undefined,
  opts: CliEnvOptions & {
    wakeFn?: (args: { personality: string; runtime: Runtime; task: string; resume: true }) => Promise<WakeResult>
    controlFn?: typeof routeControl
    compactDoneFn?: typeof waitForCompactDone
  } = {},
): Promise<CompactPeerOutcome> {
  const env = opts.env ?? process.env
  const cfg = loadLifecycleConfig(env)
  const peer = findPeer(readPeersIndex({ env }), personality)
  if (!peer) throw new Error(`peer "${personality}" is not registered`)
  if (isForeignLaunchd(personality, env)) {
    return {
      personality,
      runtime: peer.runtime,
      action: 'refused-foreign-launchd',
      reason: `"${personality}" is managed by persistent-peer (foreign launchd plist) — the foundation does not control it`,
    }
  }
  if (runtime && !isRuntime(runtime)) throw new Error(`invalid runtime "${runtime}"`)
  if (runtime && peer.runtime !== runtime && !peer.runtimes.includes(runtime as Runtime)) {
    return {
      personality,
      runtime,
      action: 'refused-undeclared-runtime',
      reason: `peer "${personality}" does not declare runtime "${runtime}" (declared: ${peer.runtimes.join(', ')})`,
    }
  }

  const control = opts.controlFn ?? routeControl
  const compactDone = opts.compactDoneFn ?? waitForCompactDone
  const waitDone = (rt: Runtime, baseline: ReturnType<typeof compactDoneBaseline>, woke: boolean): CompactPeerOutcome | null => {
    const done = compactDone(
      {
        personality,
        runtime: rt,
        address: buildProcessAddress(rt, personality),
        socketPath: buildSocketPath(rt, personality, cfg.sockDir),
      },
      peer.cwd,
      baseline,
      { env },
    )
    if (!done.ok) return { personality, runtime: rt, action: 'failed', woke, reason: done.error.message }
    return null
  }
  const liveRuntimes = peer.runtimes.filter(rt => isPeerLive(rt, personality, cfg.sockDir, env))
  if (runtime ? liveRuntimes.includes(runtime as Runtime) : liveRuntimes.length > 0) {
    const rt = (runtime as Runtime | undefined)
      ?? (liveRuntimes.includes(peer.runtime) ? peer.runtime : liveRuntimes.length === 1 ? liveRuntimes[0] : undefined)
    if (!rt) {
      return {
        personality,
        runtime: peer.runtime,
        action: 'failed',
        reason: `${personality} is online in multiple runtimes (${liveRuntimes.join(', ')}) — specify runtime`,
      }
    }
    const baseline = compactDoneBaseline(rt, peer.cwd, { env })
    const r = await control(personality, rt, { name: 'compact' })
    if (!r.ok) return { personality, runtime: rt, action: 'failed', reason: r.error.message }
    const waited = waitDone(r.value.controlled.runtime as Runtime, baseline, false)
    if (waited) return waited
    return { personality, runtime: r.value.controlled.runtime, action: 'compacted', woke: false }
  }

  // Asleep branch: omitted runtime resolves like new/attach (resolvePeerRuntime) — consistent
  // default_runtime anchoring instead of the old hidden last-active-by-mtime.
  const rt: Runtime = (runtime as Runtime | undefined) ?? resolvePeerRuntime(peer, cfg)
  if (!peer.runtimes.includes(rt)) {
    return {
      personality,
      runtime: rt,
      action: 'refused-undeclared-runtime',
      reason: `peer "${personality}" does not declare runtime "${rt}" (declared: ${peer.runtimes.join(', ')})`,
    }
  }
  if (isInfraRuntime(rt)) {
    return {
      personality,
      runtime: rt,
      action: 'refused-infra',
      reason: `infra runtime "${rt}" is launchd-held and has no compactable TUI dialogue`,
    }
  }
  const identity = buildProcessAddress(rt, personality)
  if (!hasIdleReaped(cfg, identity)) {
    return { personality, runtime: rt, action: 'nothing-to-compact', reason: 'context is fresh; nothing to compact' }
  }
  const wake = opts.wakeFn ?? (args => wakeOrSpawn(args, { cfg, env }))
  const w = await wake({ personality, runtime: rt, task: '', resume: true })
  if (w.status !== 'READY') {
    const reason = w.reason ?? 'wake failed'
    if (/no .*session to resume|no transcript to resume|nothing to resume/i.test(reason)) {
      return { personality, runtime: rt, action: 'nothing-to-compact', reason: 'context is fresh; nothing to compact' }
    }
    return { personality, runtime: rt, action: 'failed', reason }
  }
  clearIdleReaped(cfg, identity)
  const baseline = compactDoneBaseline(rt, peer.cwd, { env })
  const r = await control(personality, rt, { name: 'compact' })
  if (!r.ok) return { personality, runtime: rt, action: 'failed', woke: true, reason: r.error.message }
  const waited = waitDone(rt, baseline, true)
  if (waited) return waited
  return { personality, runtime: rt, action: 'compacted', woke: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// remove — delete a peer's record from the registry through the LOCKED writer
// (registry.removePeer). Direct edits of peers-profiles.json are refused at
// storage.ts:304 (locked-writer invariant); this is the operator path that used
// to require dropping into `bun -e removePeer(...)`. The use case is reaping the
// ephemeral zombie records a retired spawn leaves behind.
// ─────────────────────────────────────────────────────────────────────────────

export interface RemoveOutcome {
  personality: string
  action: 'removed' | 'absent' | 'refused-live' | 'refused-foreign-launchd'
  reason?: string
  /** Always-on plist teardown outcome (`bootout + plist removed` / `skipped-sandbox` /
   *  `skipped-foreign …`). Present only when the peer had a com.iapeer.<p> plist — an
   *  always-on (infra) peer. Without this, remove orphaned the loaded plist → launchd
   *  KeepAlive crash-looped `run-infra` against the deleted record. */
  plistTeardown?: string
  /** The removed peer's cwd (registry fact, captured BEFORE the removal). remove
   *  deliberately keeps the folder — user data is never deleted by a registry reap
   *  (say so in the output instead of leaving silent orphans). */
  cwd?: string
  /** v1.2: per-runtime unprovision outcomes (`<rt>:<state>`), present when the
   *  slot declares an unprovision command (occasion=remove ran before the purge). */
  unprovision?: string[]
  /** Codex pre-trust cleanup outcome: 'removed' when the peer's cwd trust entry
   *  was dropped from the host codex config; a failure detail otherwise. Absent
   *  for non-codex peers and when no entry existed. */
  codexTrust?: string
  /** Codex hooks-trust cleanup outcome: `removed <n>` when pre-seeded
   *  `[hooks.state."<cwd>/…"]` entries were dropped (trust-hooks verb is the
   *  writer); a failure detail otherwise. Absent when nothing matched. */
  codexHooksTrust?: string
  /** Identity-keyed lifecycle artifacts purged with the record (state/lifecycle/
   *  `<identity>.*` per runtime). Without this purge a NEWBORN peer reusing the
   *  personality inherits the dead namesake's parking (defect: stale .stopped →
   *  `mode=refused cause=stopped` on a freshly-created peer). */
  purgedState?: string[]
}

/**
 * remove <peer> [--force]: drop the registry record via the locked writer.
 * IDEMPOTENT — an absent peer is a no-op success (`absent`), never an error.
 * SAFETY: refuses a peer that is currently LIVE on any runtime — deleting a
 * running session's record would orphan it from routing (resolveCallerIdentity /
 * findPeer would no longer resolve it while it still runs). --force overrides.
 * A zombie record is dead by definition, so the guard never blocks the cleanup
 * it exists for.
 */
export async function removePeerCli(
  personality: string,
  opts: CliEnvOptions & { force?: boolean } = {},
): Promise<RemoveOutcome> {
  const env = opts.env ?? process.env
  const peer = findPeer(readPeersIndex({ env }), personality)
  if (!peer) return { personality, action: 'absent' }
  if (!opts.force) {
    const cfg = loadLifecycleConfig(env)
    const liveRt = peer.runtimes.find(rt => isPeerLive(rt, personality, cfg.sockDir, env))
    if (liveRt) {
      return {
        personality,
        action: 'refused-live',
        reason: `"${personality}" is LIVE on ${liveRt} — removing its registry record would orphan the running session from routing; stop it first or pass --force`,
      }
    }
  }
  // PLIST TEARDOWN (the always-on / launchd-managed peer). An infra peer
  // (notifier/telegram/voicetalk) has a com.iapeer.<p> plist with KeepAlive. Removing
  // ONLY the registry record leaves the plist LOADED → launchd keeps relaunching
  // `iapeer run-infra <p> <rt>` against the now-deleted record → CRASH-LOOP (doc alerts
  // "gone-without-disable"). So bootout the job BEFORE the registry remove (stop KeepAlive
  // before its target vanishes — no crash-loop window), then rm the plist file.
  // FLEET GUARD (H4): a FOREIGN persistent-peer plist is off-limits — refuse (unless
  // --force, which then drops ONLY the registry record and leaves the foreign plist intact).
  let plistTeardown: string | undefined
  if (isLaunchdManaged(personality, env)) {
    if (isForeignLaunchd(personality, env)) {
      if (!opts.force) {
        return {
          personality,
          action: 'refused-foreign-launchd',
          reason: `"${personality}" is managed by persistent-peer (foreign launchd plist) — the foundation will not remove it (H4). Use persistent-peer tooling, or --force to drop ONLY the registry record (the foreign plist is left intact).`,
        }
      }
      plistTeardown = 'skipped-foreign (H4 — foreign plist left intact; --force dropped only the registry record)'
    } else {
      const plistPath = launchdPlistPath(personality, env)
      // Sandbox/test: never invoke real launchctl (a test peer's label isn't a real job);
      // still remove the (temp-dir) plist file so the teardown is observable.
      let bootoutNote: string
      if (env.IAPEER_TEST_SANDBOX === '1') {
        bootoutNote = 'skipped-sandbox'
      } else {
        const r = spawnSync('launchctl', ['bootout', `gui/${uid()}/${launchdLabel(personality)}`], { encoding: 'utf8' })
        // bootout exits non-zero when the job was already unloaded — benign for a teardown.
        bootoutNote = r.status === 0 ? 'bootout' : `bootout (exit ${r.status}${(r.stderr ?? '').trim() ? `: ${(r.stderr ?? '').trim()}` : ''})`
      }
      let rmNote: string
      try {
        rmSync(plistPath, { force: true })
        rmNote = ' + plist removed'
      } catch (e) {
        rmNote = ` (plist rm FAILED: ${e instanceof Error ? e.message : String(e)} — remove ${plistPath} manually)`
      }
      plistTeardown = `${bootoutNote}${rmNote}`
    }
  }
  await removePeer(personality, { env })
  // v1.2 UNPROVISION joint (контракт §Provision провайдера): a provision-declaring
  // slot gets its unprovision command per agentic runtime with occasion=remove —
  // BEFORE purgeIdentityState, so the provider sees the peer's last consistent
  // state while unwinding its surfaces. Best-effort: a provider hiccup must not
  // block the reap (the outcome line says what happened; repair is the provider's
  // verify sweep).
  const unprovisionOutcomes: string[] = []
  try {
    const slot = readMemoryProvider(env)
    if (slot?.unprovision) {
      const { runProvisionCommand } = await import('../enable/provisionCommand.ts')
      const agentic = peer.runtimes.filter((r): r is 'claude' | 'codex' => r === 'claude' || r === 'codex')
      for (const rt of agentic) {
        const o = runProvisionCommand({
          block: slot.unprovision,
          cwd: peer.cwd,
          runtime: rt,
          personality,
          occasion: 'remove',
          env,
        })
        appendLifecycleEvent(
          pluginLogsDir('iapeer', { env }),
          {
            ev: 'memory-provision',
            identity: `${rt}-${personality}`,
            occasion: 'remove',
            state: o.state,
            exit: o.exitCode ?? undefined,
            ms: o.durationMs,
            detail: o.detail,
          },
          { env },
        )
        unprovisionOutcomes.push(`${rt}:${o.state}${o.state !== 'ok' && o.detail ? ` (${o.detail})` : ''}`)
      }
    }
  } catch (e) {
    unprovisionOutcomes.push(`failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  // Codex pre-trust cleanup (reap-side counterpart of the birth-time
  // preTrustCodexCwd): a removed codex peer must
  // not leave its cwd trusted in the host ~/.codex/config.toml forever. After
  // unprovision (the provider sees the peer's last consistent state first),
  // best-effort like everything else on this path.
  let trustCleaned: string | undefined
  let hooksTrustCleaned: string | undefined
  if (peer.runtimes.includes('codex')) {
    try {
      const { removeCodexCwdTrust } = await import('../launch/nativeMemory.ts')
      const t = removeCodexCwdTrust(peer.cwd, env)
      trustCleaned = t.state === 'written' ? 'removed' : t.state === 'already' ? undefined : `${t.state}${t.detail ? ` (${t.detail})` : ''}`
    } catch (e) {
      trustCleaned = `failed (${e instanceof Error ? e.message : String(e)})`
    }
    // Same class, hooks edition: pre-seeded `[hooks.state."<cwd>/…"]` entries
    // (trust-hooks verb) must not outlive the peer either.
    try {
      const { removeCodexHooksTrustUnder } = await import('../launch/codexHooksTrust.ts')
      const h = removeCodexHooksTrustUnder(peer.cwd, env)
      hooksTrustCleaned =
        h.state === 'written' ? `removed ${h.removed.length}` : h.state === 'already' ? undefined : `${h.state}${h.detail ? ` (${h.detail})` : ''}`
    } catch (e) {
      hooksTrustCleaned = `failed (${e instanceof Error ? e.message : String(e)})`
    }
  }
  // Purge identity-keyed lifecycle state WITH the record (per runtime): stale
  // .stopped/.idle-reaped/... must never outlive the peer and ambush a future
  // namesake (purgeIdentityState doc). After the registry write, so a failed
  // remove never half-purges a still-registered peer.
  const cfg = loadLifecycleConfig(env)
  const purgedState = peer.runtimes.flatMap(rt => purgeIdentityState(cfg, buildProcessAddress(rt, personality)))
  return {
    personality,
    action: 'removed',
    cwd: peer.cwd,
    purgedState,
    ...(plistTeardown ? { plistTeardown } : {}),
    ...(unprovisionOutcomes.length ? { unprovision: unprovisionOutcomes } : {}),
    ...(trustCleaned ? { codexTrust: trustCleaned } : {}),
    ...(hooksTrustCleaned ? { codexHooksTrust: hooksTrustCleaned } : {}),
  }
}

/**
 * `connect telegram <peer>` core — give a peer a Telegram bot face (interfaces.telegram).
 * Shared by the `connect telegram` verb AND the `enable telegram <peer>` discoverability
 * alias (telegram is a CHANNEL, not a marketplace plugin, so both route here, not through
 * enableCapability). Returns the process exit code. The human owes only the token (prompted
 * when omitted on a tty); the system does bot-add → interface → router restart.
 */
async function connectTelegramVerb(
  peer: string,
  token: string | undefined,
  env: NodeJS.ProcessEnv,
  out: (s: string) => void,
  errOut: (s: string) => void,
): Promise<number> {
  const { connectTelegram } = await import('../connect/index.ts')
  const r = await connectTelegram({ peer, token, env })
  if (r.state === 'noop-same-token') {
    out(`connect telegram ${r.peer}: ${r.detail}\n`)
    return 0
  }
  if (r.state !== 'connected') {
    errOut(`connect telegram ${r.peer}: ${r.state}${r.detail ? ` — ${r.detail}` : ''}\n`)
    return 1
  }
  const rs = r.restart!
  out(`bot ${r.username ?? `for "${r.peer}"`} added + interfaced to "${r.peer}"\n`)
  out(
    rs.state === 'restarted'
      ? `router restarted — credentials loaded\n`
      : `router restart ${rs.state}${rs.detail ? ` — ${rs.detail}` : ''} (the channel stays dead until the router restarts)\n`,
  )
  out(`activation: send the bot ${r.username ?? '(see @BotFather)'} its FIRST message — Telegram does not let a bot start the chat\n`)
  return rs.state === 'restarted' ? 0 : 1
}

// ─────────────────────────────────────────────────────────────────────────────
// rename — first-class peer-identity rename (parity with remove/create). Wraps
// renamePeer (registry + per-cwd profile, atomic, inside the lock) and KEEPS the
// cwd, so the claude transcript history (slug = realpath(cwd)) survives the rename.
// ─────────────────────────────────────────────────────────────────────────────

export interface RenameOutcome {
  oldPersonality: string
  newPersonality: string
  action: 'renamed' | 'absent' | 'target-exists' | 'target-cwd-exists' | 'refused-live'
  reason?: string
  oldCwd?: string
  newCwd?: string
  transcriptMoved?: boolean
  purgedState?: string[]
  sideEffects?: string[]
}

/**
 * FULL folder rename of a peer (Arthur's invariant: personality == normalize(basename(cwd)),
 * a self-healed mirror — so a rename MUST move the folder, or profile-standard self-heal
 * reverts the personality back to the basename). Atomic core, best-effort side-effects:
 *  1. mv the cwd folder oldCwd → dirname(oldCwd)/<new> (the per-cwd profile, .mcp.json,
 *     native-memory, CLAUDE.md, .git all ride it).
 *  2. mv the claude transcript slug dir (~/.claude/projects/<oldSlug> → <newSlug>) — keyed
 *     by realpath(cwd), so this is how the claude history is NOT orphaned. (codex history
 *     is keyed by the cwd recorded INSIDE each ~/.codex/sessions jsonl, not a path-dir, so
 *     it does NOT carry — a documented limitation; codex starts fresh sessions at the new cwd.)
 *  3. renamePeer(…, newCwd): atomic registry personality+cwd + per-cwd profile personality.
 * On any failure in 1-3 the fs moves are rolled back (folder + transcript back). Then
 * best-effort: codex re-trust the new cwd + clean the old, re-write the claude .mcp.json
 * identity fallback, purge the old identity's lifecycle markers. Refuses a LIVE peer unless
 * --force. Does NOT touch memory (operativka/author/index) — the provider re-keys that
 * separately AFTER this rename; deliberately NO `remove`/unprovision (which would risk a
 * memory purge). `claudeProjectsDir` is a test seam (default ~/.claude/projects).
 */
export async function renamePeerCli(
  oldPersonality: string,
  newPersonality: string,
  opts: CliEnvOptions & { force?: boolean; claudeProjectsDir?: string } = {},
): Promise<RenameOutcome> {
  const env = opts.env ?? process.env
  const index = readPeersIndex({ env })
  const peer = findPeer(index, oldPersonality)
  if (!peer) return { oldPersonality, newPersonality, action: 'absent' }
  if (findPeer(index, newPersonality)) {
    return { oldPersonality, newPersonality, action: 'target-exists', reason: `"${newPersonality}" already exists` }
  }
  const oldCwd = peer.cwd
  const newCwd = join(dirname(oldCwd), newPersonality)
  if (existsSync(newCwd)) {
    return { oldPersonality, newPersonality, action: 'target-cwd-exists', reason: `${newCwd} already exists — move or remove it first` }
  }
  const cfg = loadLifecycleConfig(env)
  if (!opts.force) {
    const liveRt = peer.runtimes.find(rt => isPeerLive(rt, oldPersonality, cfg.sockDir, env))
    if (liveRt) {
      return {
        oldPersonality,
        newPersonality,
        action: 'refused-live',
        reason: `"${oldPersonality}" is LIVE on ${liveRt} — its session + folder must be quiescent for the move; stop it first (\`iapeer stop ${oldPersonality}\`) or pass --force`,
      }
    }
  }
  // ── atomic core (1-3) with rollback ──────────────────────────────────────────
  const projectsDir = opts.claudeProjectsDir ?? claudeProjectsRoot()
  const oldSlug = transcriptSlug(oldCwd) // BEFORE the mv — realpath needs the live dir
  const oldTx = join(projectsDir, oldSlug)
  renameSync(oldCwd, newCwd) // 1. folder (atomic on one filesystem)
  let transcriptMoved = false
  let newTx: string | undefined
  try {
    const newSlug = transcriptSlug(newCwd) // AFTER the mv — realpath(newCwd) resolves
    newTx = join(projectsDir, newSlug)
    if (oldSlug !== newSlug && existsSync(oldTx) && !existsSync(newTx)) {
      renameSync(oldTx, newTx) // 2. claude transcript slug dir
      transcriptMoved = true
    }
    await renamePeer(oldPersonality, newPersonality, { env }, newCwd) // 3. atomic registry+profile
  } catch (e) {
    if (transcriptMoved && newTx) {
      try { renameSync(newTx, oldTx) } catch { /* best-effort rollback */ }
    }
    try { renameSync(newCwd, oldCwd) } catch { /* best-effort rollback */ }
    throw e
  }
  // ── best-effort side-effects (the core rename already committed) ──────────────
  const sideEffects: string[] = []
  if (peer.runtimes.includes('codex')) {
    try {
      const { preTrustCodexCwd, removeCodexCwdTrust } = await import('../launch/nativeMemory.ts')
      preTrustCodexCwd(newCwd, env)
      removeCodexCwdTrust(oldCwd, env)
      const { removeCodexHooksTrustUnder } = await import('../launch/codexHooksTrust.ts')
      removeCodexHooksTrustUnder(oldCwd, env)
      sideEffects.push('codex-trust: re-trusted new cwd + cleaned old')
    } catch (e) {
      sideEffects.push(`codex-trust: failed (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  if (peer.runtimes.includes('claude')) {
    try {
      const { writeClaudeMcpConfig, resolveDaemonMcpUrl } = await import('../init/index.ts')
      writeClaudeMcpConfig(newCwd, newPersonality, resolveDaemonMcpUrl({ env }))
      sideEffects.push('claude .mcp.json: identity rewritten')
    } catch (e) {
      sideEffects.push(`claude .mcp.json: failed (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  const purgedState = peer.runtimes.flatMap(rt => purgeIdentityState(cfg, buildProcessAddress(rt, oldPersonality)))
  return { oldPersonality, newPersonality, action: 'renamed', oldCwd, newCwd, transcriptMoved, purgedState, sideEffects }
}

// ─────────────────────────────────────────────────────────────────────────────
// send — manual IAP send fallback (contract Примитивы §send). Goes through the
// same router path as send_to_peer (resolve → deliver / wake), in-process so it
// works even when the daemon HTTP listener is down. --from sets the sender.
// ─────────────────────────────────────────────────────────────────────────────

export interface SendOptions extends CliEnvOptions {
  /** Sender identity `<runtime>-<personality>`; default = the cwd peer's identity. */
  from: string
  target: string
  runtime?: string
  message: string
  topic?: string
  attachments?: string[]
}

const cliWake: WakeFn = req =>
  wakeOrSpawn({ personality: req.personality, runtime: req.runtime, topic: req.topic, task: req.task })

export async function sendMessage(
  opts: SendOptions,
): Promise<{ ok: true; delivered_to: { personality: string; runtime: string }; queued?: boolean; queueDepth?: number }> {
  const env = opts.env ?? process.env
  const caller = resolveCallerIdentity(parseIdentity(opts.from), readPeersIndex({ env }))
  // wake_policy:ephemeral M3 parity: the CLI path used
  // to route an ephemeral target through the normal live/miss path — a notifier
  // burst landed as TURNS in one live worker session instead of serializing
  // through the disk FIFO the daemon path uses. Same seam, ONE difference: the
  // drain kick is a NOOP here — a CLI process exits right after the ack, so an
  // unawaited in-process wake would die with it; the daemon's supervise-tick
  // drain scan (≤60 s) picks the queue up — the EXISTING retry path for failed
  // kicks, not a new mechanism.
  const { makeArmEphemeralOnDelivered, makeEphemeralRouteDeps, makeNoteLiveTopic } = await import('../daemon/main.ts')
  const cfg = loadLifecycleConfig(env)
  const t0 = Date.now()
  const result = await routeSend(
    caller,
    {
      personality: opts.target,
      runtime: opts.runtime,
      message: opts.message,
      topic: opts.topic,
      attachments: opts.attachments,
    },
    // noteLiveTopic — CLI-path parity (same seam the daemon wires): a live delivery
    // through the CLI fallback must update the target's .topic marker too, or a
    // daemon-restart-window send re-opens the stale-marker false-fresh.
    { wake: cliWake, ephemeral: makeEphemeralRouteDeps(cfg, env, () => {}), noteLiveTopic: makeNoteLiveTopic(cfg, env) },
  )
  // delivery.log sink — CLI-path parity (observability gap: enqueues routed
  // through the CLI left to=<peer> at ZERO while real wakes happened; the daemon
  // tool-path logs, this path was blind). Same fields, plus
  // path=cli so the two entry points are distinguishable. Both branches logged.
  const { appendDeliveryEvent } = await import('../daemon/deliverylog.ts')
  appendDeliveryEvent(cfg.eventLogDir, {
    ev: 'delivery',
    path: 'cli',
    caller: caller.address,
    to: opts.target,
    rt: opts.runtime,
    ok: String(result.ok),
    via: result.ok ? `${result.value.delivered_to.runtime}-${result.value.delivered_to.personality}` : undefined,
    woke: result.ok ? String(result.value.woke) : undefined,
    queued: result.ok && result.value.queued ? 'true' : undefined,
    qkind: result.ok ? result.value.queuedBy : undefined,
    qd: result.ok ? result.value.queueDepth : undefined,
    ms: Date.now() - t0,
    len: opts.message.length,
    att: opts.attachments?.length || undefined,
    topic: opts.topic,
    err: result.ok ? undefined : result.error.message,
  })
  if (!result.ok) throw new Error(result.error.message)
  // M2 arm-on-outbound — CLI-path parity (gap: an ephemeral worker's final reply
  // sent through the CLI fallback — e.g. inside a daemon-restart window — never
  // armed, so the worker idled to the unarmed bound and stalled its FIFO). Same
  // hook the daemon path uses; ONLY on
  // an ok outcome, errors swallowed (arming is best-effort, never fails the send).
  try {
    makeArmEphemeralOnDelivered(cfg)(caller)
  } catch {
    /* best-effort */
  }
  return {
    ok: true,
    delivered_to: result.value.delivered_to,
    queued: result.value.queued,
    queueDepth: result.value.queueDepth,
  }
}

function parseIdentity(identity: string): { personality: string; runtime: Runtime } {
  const dash = identity.indexOf('-')
  if (dash <= 0) throw new Error(`invalid --from identity "${identity}" — expected <runtime>-<personality>`)
  const runtime = identity.slice(0, dash)
  if (!isRuntime(runtime)) throw new Error(`invalid runtime in --from "${identity}"`)
  return { runtime, personality: identity.slice(dash + 1) }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI dispatch — `iapeer <verb> …`
// ─────────────────────────────────────────────────────────────────────────────

/** В49 — flags that never take a value. Without the schema the look-ahead form ate the
 *  NEXT positional: `iapeer update --force 0.4.31` parsed as flags.force='0.4.31' with NO
 *  positionals → an UNforced full-cascade update instead of a forced version pin (live
 *  incident shape). A boolean flag is always `true`; forcing a value onto one is only
 *  possible via the explicit `--key=value` form (which stays verbatim). */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'accept-risk',
  'all',
  'check',
  'dry-run',
  'fix',
  'force',
  'foundation-only',
  'install-plist',
  'json',
  'no-bootstrap',
  'no-memory',
  'no-notifier',
  'no-setup',
  'no-telegram',
  'no-voice',
  'npx',
  'plugin-only',
  'remove-codesign-identity',
  'stream',
  'yes',
])

export function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      // Audit #27: support `--key=value` so a value that itself starts with '--' (e.g.
      // `send --message=--look-at-this`) is not silently dropped by the look-ahead form.
      const eq = a.indexOf('=')
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
        continue
      }
      const key = a.slice(2)
      // В49 — a KNOWN boolean flag never consumes the next token as its value.
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else flags[key] = argv[++i]
    } else {
      positionals.push(a)
    }
  }
  return { positionals, flags }
}

/** Verb catalog for `help` — structured so the renderer can wrap descriptions to
 *  the terminal width instead of overflowing a hand-aligned column (the old static
 *  USAGE ran long descriptions off the right edge → collided with the next row on a
 *  narrow terminal). `sig` = the invocation signature, `desc` = one prose line. */
const VERBS: ReadonlyArray<{ sig: string; desc: string }> = [
  { sig: 'install', desc: 'build binary + global scaffold + daemon plist (one bootstrap)' },
  {
    sig: 'update [version] [--force] [--foundation-only]',
    desc: 'cascade-update the WHOLE stack (foundation + installed runtimes + memory) from npm + restart; --foundation-only = core only; a pinned <version> updates the core only',
  },
  { sig: 'rollback', desc: 'revert to the previous binary (.prev) + restart daemon + recycle owned infra jobs' },
  {
    sig: 'uninstall [--dry-run] [--yes] [--remove-codesign-identity]',
    desc: 'remove THIS foundation install (binary, ~/.iapeer, daemon plist, PATH lines); refuses if a persistent-peer fleet is present',
  },
  { sig: 'version | --version | -v', desc: "print the installed binary's version" },
  { sig: 'help | --help | -h', desc: 'print this usage (works appended to any verb; executes nothing)' },
  { sig: 'daemon [--install-plist]', desc: 'run the host-wide HTTP-MCP router (launchd-held)' },
  {
    sig: 'onboard [--accept-risk] [--dry-run] [--no-notifier] [--no-telegram] [--telegram-human <p>] [--telegram-user-id <id>] [--no-memory] [--memory <pkg>] [--no-voice] [--voice <pkg>] [--infra <csv>]',
    desc: 'backbone host-phase: marketplace → notifier → telegram (human peer) → memory → voice (all default YES). --accept-risk (or IAPEER_ACCEPT_RISK=1) accepts the security warning non-interactively',
  },
  { sig: 'status', desc: 'host snapshot: version, daemon health, memory + voice slots (<provider> | none)' },
  { sig: 'live-runtime <peer>', desc: 'print the peer\'s CURRENT live runtime (freshest pane-log among pid-alive sessions; NOT default_runtime). Exit 1 + no output if none alive' },
  { sig: 'install-runtime <runtime> [--package pkg] [--npx]', desc: 'npx-install a runtime package + deploy its declared peer-set' },
  { sig: 'update-runtime <runtime> | --all [--force]', desc: "version-gate → re-install + re-provision declared set → restart the runtime's peers" },
  { sig: 'init [cwd] [--runtime r] [--description d]', desc: 'onboard the CURRENT folder as a peer (name = folder name; identity + MCP + doctrine)' },
  { sig: 'create <personality> [--runtime r] [--path dir] [--bin abs]', desc: 'create a peer anywhere (default ~/.iapeer/peers/<p>) + provision' },
  { sig: 'list [--json]', desc: 'registered peers + per-runtime liveness' },
  {
    sig: 'verify [--json] [--fix]',
    desc: 'profile-standard conformance + index↔local drift (--fix self-heals the index + migrates legacy runtime→default_runtime in local profiles)',
  },
  {
    sig: 'stop <peer> [runtime] | --all',
    desc: 'warm peer: kill the live session + set a durable stop-flag — the daemon will NOT wake it until `start`; always-on (notifier/telegram): launchctl bootout. --all = every registered peer',
  },
  {
    sig: 'start <peer> [runtime] | --all',
    desc: "warm peer: clear the stop-flag — wakeable again; does NOT launch a session (the daemon brings it up on the peer's first message); always-on: launchctl bootstrap. --all = every registered peer",
  },
  {
    sig: 'refresh <peer> [runtime] | --all',
    desc: 'LAZY soft-reload: agentic peer comes up FRESH (re-reads doctrine) on its NEXT natural wake — no kill, no burst-wake; non-agentic runtimes skipped. --all = whole fleet. (eager: `new`/self-fresh)',
  },
  { sig: 'remove <peer> [--force]', desc: 'delete a peer\'s registry record (locked writer); refuses a LIVE peer unless --force' },
  { sig: 'rename <old> <new> [--force]', desc: 'rename a peer — moves the cwd folder + claude transcript + atomic registry/profile (personality = folder name); refuses a LIVE peer unless --force. Memory re-key is the provider\'s separate step.' },
  {
    sig: 'send <target> (--message <text> | --message-file <f|->) [--from <id>] [--attachment <p>]… [--topic <t>]',
    desc: 'manual IAP send (fallback)',
  },
  { sig: '<runtime>', desc: "launch the cwd's peer FRESH; on a TTY drop into it (like attach), else detached" },
  { sig: 'connect telegram <peer> [--token <t>]', desc: 'attach a telegram bot to a peer (bot add → interface → router restart; asks only the token). Alias: `iapeer enable telegram <peer>`' },
  { sig: 'enable <plugin> [peer] [--no-setup]', desc: 'install + enable an agfpd capability for a peer' },
  {
    sig: 'new <peer> [runtime]',
    desc: 'UNCONDITIONAL fresh restart: canary-clean kill + fresh wake (emergency lever for a hung/dead session — bypasses the peer; exit 0 = fresh session up+ready)',
  },
  {
    sig: 'add-runtime <runtime> (--peer <p> | --all)',
    desc: 'add an agentic runtime to existing peer(s): runtimes-merge + scaffold + codex birth chain (pre-trust, native-memory, memory provision, MCP). default_runtime untouched',
  },
  {
    sig: 'default-runtime <runtime> (--peer <p> | --all)',
    desc: 'flip the PRIMARY (routing/wake default) — the fleet-switch lever; refuses an undeclared runtime; registry self-healed in the same command',
  },
  { sig: 'attach <peer> [runtime]', desc: 'ensure-live + resume, then attach to the pty session (Ctrl-] detaches)' },
  { sig: 'interrupt <peer> [runtime]', desc: 'interrupt the current turn (Escape) — context intact' },
  { sig: 'compact <peer> [runtime]', desc: 'compact the peer\'s dialogue (/compact); resumes clean-asleep first' },
  { sig: 'self-fresh', desc: '(agent self-call) mark /new eager-fresh + self-kill — the daemon relaunches fresh' },
  { sig: 'self-done', desc: '(agent self-call, ephemeral) silent finish: arm own quiet-reap, wake no one' },
  { sig: 'native-memory <off|on> (--peer <p> | --all)', desc: "gate/restore runtimes' native memory (canonized lever; контракт «Слот памяти»)" },
  { sig: 'trust-hooks <hooks.json> [--check]', desc: 'pre-seed codex hooks trust for a file-form hooks.json (no modal); --check = drift report' },
  {
    sig: 'supervisor up|start|attach|list|kill <sess> [runtime]',
    desc: 'DARK (cutover Block 2): detach-persistent pty-supervisor PoC port; serves nothing on the live fleet (throwaway validation only)',
  },
  {
    sig: 'tray install|uninstall|render [--stream]|cmd <c> <peer>|approve <id>|deny <id> [reason]|status',
    desc: 'the macOS menu-bar fleet dashboard (SwiftBar plugin) — first external Fleet API client; renders the approval queue (badge + Allow/Deny), install activates it (installs SwiftBar when absent). See docs/16.',
  },
  { sig: 'approval-mode <peer> [gated|yolo]', desc: 'read/flip a peer\'s human-approval mode (docs/17): yolo=current bypass; gated=blocking runtime approvals routed to a human. Persists + brings runtime surfaces to the mode; applies on next fresh session' },
  { sig: 'approvals [--json]', desc: 'list pending human-approval requests (verbatim action content); the host answer channel to the daemon broker' },
  { sig: 'approve <id>', desc: 'approve a pending request — the decision clears it in every channel' },
  { sig: 'deny <id> [reason]', desc: 'deny a pending request; the reason reaches the model' },
  { sig: 'approval-hook', desc: '(runtime-installed) PreToolUse bridge: stdin hook JSON → broker → decision JSON. Not run by hand' },
]

/** Greedy word-wrap to `width` columns. A token longer than `width` keeps its own
 *  line (overflows rather than being split — never break a flag/path mid-token). */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const out: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur === '') cur = w
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`
    else {
      out.push(cur)
      cur = w
    }
  }
  if (cur !== '') out.push(cur)
  return out
}

/** The terminal width to lay help out for — capped so an ultrawide terminal doesn't
 *  stretch descriptions into unreadably long lines; 80 when not a TTY. */
function helpWidth(): number {
  const c = process.stdout.columns
  return c && c > 0 ? Math.min(c, 100) : 80
}

/** Render `iapeer help` as an aligned two-column block that wraps to `width`.
 *  Signatures that fit the left column print inline with their (wrapped) description
 *  in the right column; over-long signatures wrap on their own lines first, then the
 *  description follows at the same right-column indent. Deterministic + width-pure
 *  so it is unit-testable. */
export function renderUsage(width: number = helpWidth()): string {
  const W = Math.max(40, width)
  const INDENT = 2
  const GUTTER = 2
  // Left column: longest signature, but capped (≤44, and shrunk on a narrow
  // terminal) so the right column always keeps a readable ~20+ cols.
  const longest = Math.max(...VERBS.map(v => v.sig.length))
  const leftCol = Math.min(longest, 44, Math.max(16, W - 26))
  const rightStart = INDENT + leftCol + GUTTER
  const rightWidth = Math.max(20, W - rightStart)
  const rightPad = ' '.repeat(rightStart)
  const lines: string[] = ['usage: iapeer <verb> [args]']
  for (const v of VERBS) {
    const desc = wrapText(v.desc, rightWidth)
    if (v.sig.length <= leftCol) {
      lines.push(`${' '.repeat(INDENT)}${v.sig.padEnd(leftCol)}${' '.repeat(GUTTER)}${desc[0] ?? ''}`)
      for (const d of desc.slice(1)) lines.push(rightPad + d)
    } else {
      // Over-long signature: wrap it across its own lines (continuation indented),
      // then the description at the shared right-column indent. Wrap to leave room
      // for the deeper continuation indent (INDENT+2) so no wrapped sig line spills.
      const sigLines = wrapText(v.sig, W - INDENT - 2)
      lines.push(' '.repeat(INDENT) + sigLines[0])
      for (const s of sigLines.slice(1)) lines.push(' '.repeat(INDENT + 2) + s)
      for (const d of desc) lines.push(rightPad + d)
    }
  }
  return lines.join('\n') + '\n'
}

/** Focused help for ONE verb: the VERBS entry whose signature's first token equals `verb`,
 *  rendered as its own `usage: iapeer <sig>` + wrapped description — or null when `verb` is
 *  not a known verb (the caller then falls back to the full renderUsage). This is why
 *  `iapeer connect telegram --help` prints connect's OWN usage instead of the whole verb list
 *  (the prior behavior: `--help` anywhere dumped the general usage, burying the subcommand the
 *  user asked about). First-token match is unambiguous — no two VERBS share a leading token. */
export function renderVerbHelp(verb: string, width: number = helpWidth()): string | null {
  const entry = VERBS.find(v => v.sig.split(/\s+/)[0] === verb)
  if (!entry) return null
  const W = Math.max(40, width)
  const lines = [`usage: iapeer ${entry.sig}`, ...wrapText(entry.desc, W - 2).map(d => `  ${d}`)]
  return lines.join('\n') + '\n'
}

/** Which verb's help an explicit help request targets, or null for the GENERAL usage:
 *   - `<verb> --help` / `<verb> -h`  → the verb (argv[0], when it is not itself a help token)
 *   - `help <verb>`                  → argv[1]
 *   - bare `help` / `--help` / `-h`  → null (whole verb list)
 *  An unknown target falls through to the general usage via renderVerbHelp returning null. */
export function helpTargetVerb(argv: string[]): string | null {
  const first = argv[0]
  if (first && first !== 'help' && first !== '--help' && first !== '-h') return first
  if (first === 'help' && argv[1]) return argv[1]!
  return null
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [verb, ...rest] = argv
  // CLI hygiene (design «Onboard костяка» §CLI-гигиена): an explicit help request —
  // `--help`/`-h` ANYWHERE on the line, or the bare `help` verb — prints usage and
  // executes NOTHING. Checked on the RAW argv BEFORE the switch: parseArgs would
  // bury `--help` in flags no case reads (a cold-start `onboard --help` EXECUTED on
  // prod — idempotency saved it), and `-h` would land in positionals. Token-exact
  // match is safe: the look-ahead parser never consumes a `--`-token as a value, so
  // a LITERAL "--help" value is only expressible as `--key=--help` (not intercepted).
  if (verb === 'help' || argv.includes('--help') || argv.includes('-h')) {
    // Per-verb help when a known verb is named (`connect telegram --help` → connect's own usage,
    // `help connect` → same); the general verb list only for a bare/unknown help request.
    const target = helpTargetVerb(argv)
    process.stdout.write((target && renderVerbHelp(target)) || renderUsage())
    return 0
  }
  const { positionals, flags } = parseArgs(rest)
  const out = (s: string) => process.stdout.write(s)
  const errOut = (s: string) => process.stderr.write(s)

  try {
    switch (verb) {
      case 'onboard': {
        // Interactive TUI wizard (Фаза TUI-редизайн) — the DEFAULT for an
        // interactive `iapeer onboard`. Routed ONLY in a real interactive terminal
        // and never for an automation path (--accept-risk / --dry-run / --no-memory
        // / --no-voice / --infra), which stay on the deterministic linear flow below. Escape
        // hatch: IAPEER_ONBOARD_WIZARD=0 forces the linear path (recovery / scripts
        // that want the old flow). The wizard owns its own gate screen, so we route
        // BEFORE the readline gate. It fails closed: no real TTY →
        // WIZARD_NOT_INTERACTIVE → fall through to linear.
        const wizardOptOut = /^(0|false|no)$/i.test((env.IAPEER_ONBOARD_WIZARD ?? '').trim())
        const automationFlag =
          flags['accept-risk'] === true ||
          flags['dry-run'] === true ||
          flags['no-memory'] === true ||
          flags['no-voice'] === true ||
          typeof flags.infra === 'string'
        if (!wizardOptOut && !automationFlag && process.stdin.isTTY === true && process.stdout.isTTY === true) {
          const { runOnboardWizard, WIZARD_NOT_INTERACTIVE } = await import('../tui/onboard/run.tsx')
          const wc = await runOnboardWizard({ env })
          if (wc !== WIZARD_NOT_INTERACTIVE) return wc
          // not a real interactive TTY after all → linear path below
        }
        // SECURITY GATE (pre-release): the operator must consciously accept the risk of
        // beta infra with live agents BEFORE onboard mutates the host. --accept-risk /
        // IAPEER_ACCEPT_RISK accepts non-interactively (one-liner installers / CI); a
        // TTY is prompted; a non-TTY without the flag is REFUSED with how-to (never a
        // silent proceed / hang). SKIPPED for --dry-run (a read-only preview mutates
        // nothing, so there is no risk to accept yet). Runs BEFORE daemon/peer steps.
        if (flags['dry-run'] !== true) {
          const { confirmOnboardRisk } = await import('../onboard/risk.ts')
          const gate = await confirmOnboardRisk({ accept: flags['accept-risk'] === true, env, out, errOut })
          if (gate === 'refused-non-tty') return 2 // explicit refusal: how-to printed
          if (gate === 'declined') return 1 // operator said no
        }
        // Host-phase: register OUR marketplace in claude + codex (IDEMPOTENT — detect
        // → skip when present; an already-configured host is a no-op). --dry-run
        // reports the would-be actions without touching anything. --infra <csv> ALSO
        // onboards infra runtimes (§6): npx-install each package (auto-resolved) + deploy
        // its declared set. notifier → timer+watcher auto; telegram → operator-add after.
        // STEP 0 (non-disableable): ensure the router daemon is up. Onboard is the
        // explicit "set up the host" action, so starting the always-on daemon belongs
        // here — the operator never types raw `launchctl bootstrap`. Idempotent (no-op
        // if already loaded). A failure here is a real, host-breaking problem → exit 1.
        const dstart = await ensureDaemonStarted({ dryRun: flags['dry-run'] === true, env })
        const dLabel = dstart.state === 'would-start' ? 'would-start (dry-run)' : dstart.state
        out(`daemon: ${dLabel}${dstart.healthy === false ? ' — UNHEALTHY' : ''}${dstart.detail ? ` — ${dstart.detail}` : ''}\n`)
        const daemonFailed = dstart.state === 'failed' || dstart.healthy === false
        const r = onboardHost({ dryRun: flags['dry-run'] === true, env })
        for (const m of r.marketplaces) {
          out(`marketplace ${MARKETPLACE_NAME} @ ${m.runtime}: ${m.state}${m.detail ? ` — ${m.detail}` : ''}\n`)
        }
        out(r.noop ? 'onboard: no marketplace changes (already configured / dry-run)\n' : 'onboard: marketplace(s) registered\n')
        let infraFailed = false
        const infra = typeof flags.infra === 'string' ? flags.infra.split(',').map(s => s.trim()).filter(Boolean) : []
        // Backbone default-yes steps (design «Onboard костяка»). ORDER is
        // significant: notifier → TELEGRAM (creates the human peer) → memory below
        // (its --human resolves from the natural peer that just appeared). Each step
        // is soft-skip on unavailability; only a REAL deploy/create break fails.
        const { onboardNotifierStep, onboardTelegramStep } = await import('./../onboard/steps.ts')
        // An explicit `--infra notifier` takes the fail-closed explicit path below —
        // the default-yes (soft-skip) step then stands aside to avoid double-deploy.
        const ns = await onboardNotifierStep({
          skip: flags['no-notifier'] === true || infra.includes('notifier'),
          dryRun: flags['dry-run'] === true,
          env,
          warn: m => errOut(`warn: ${m}\n`),
        })
        if (ns.state !== 'skipped-flag') {
          const peersLine = ns.peers.length ? ` — ${ns.peers.map(p => `${p.personality} (bootstrap ${p.bootstrap ?? 'n/a'})`).join(', ')}` : ''
          out(`notifier: ${ns.state}${ns.detail ? ` — ${ns.detail}` : ''}${peersLine}\n`)
          if (ns.state === 'deploy-failed') infraFailed = true
        }
        const ts = await onboardTelegramStep({
          skip: flags['no-telegram'] === true,
          human: typeof flags['telegram-human'] === 'string' ? flags['telegram-human'] : undefined,
          userId: typeof flags['telegram-user-id'] === 'string' ? flags['telegram-user-id'] : undefined,
          dryRun: flags['dry-run'] === true,
          env,
          warn: m => errOut(`warn: ${m}\n`),
        })
        if (ts.state !== 'skipped-flag') {
          const line = `telegram: ${ts.state}${ts.personality ? ` — ${ts.personality}` : ''}${ts.detail ? ` — ${ts.detail}` : ''}\n`
          // a refusal/failure goes to stderr (loud), the rest to stdout
          if (ts.state === 'refused-non-tty' || ts.state === 'invalid-input' || ts.state === 'create-failed') errOut(line)
          else out(line)
          if (ts.state === 'invalid-input' || ts.state === 'create-failed') infraFailed = true
        }
        if (infra.length && flags['dry-run'] !== true) {
          const { onboardRuntime } = await import('../runtime/deploy.ts')
          for (const rt of infra) {
            try {
              const or = await onboardRuntime({ runtime: rt as Runtime, env, warn: m => errOut(`warn: ${m}\n`) })
              out(`infra ${rt}: package ${or.install.package ?? '(none)'} ${or.install.state}; ` +
                (or.deploy!.operatorAddOnly ? `operator-add (use \`iapeer create <peer> --runtime ${rt}\`)` : `${or.deploy!.peers.length} peer(s) deployed`) + '\n')
              if (or.deploy!.peers.some(p => p.bootstrap === 'failed' || p.selfConfig === 'failed')) infraFailed = true
            } catch (e) {
              infraFailed = true
              errOut(`infra ${rt}: ${e instanceof Error ? e.message : String(e)}\n`)
            }
          }
        } else if (infra.length) {
          out(`onboard --dry-run: would onboard infra runtimes: ${infra.join(', ')}\n`)
        }
        // Memory slot (контракт «Слот памяти»): optional DEFAULT-YES install of
        // the default provider; its own init runs with INHERITED stdio (the provider
        // owns the install questions). The step is REPORT-ONLY for the exit code — an
        // empty slot is a valid state regardless of why.
        const { onboardMemoryProvider } = await import('../onboard/memory.ts')
        const mem = await onboardMemoryProvider({
          skip: flags['no-memory'] === true,
          package: typeof flags.memory === 'string' ? flags.memory : undefined,
          dryRun: flags['dry-run'] === true,
          env,
        })
        const memLabel = mem.provider ? `${mem.provider.provider} ${mem.provider.version}` : 'none'
        out(`memory: ${mem.state}${mem.detail ? ` — ${mem.detail}` : ''} (slot: ${memLabel})\n`)
        // Voice slot (host backend only — per-peer voice tooling is the separate
        // `iapeer enable voice-connect <peer>`): optional DEFAULT-YES install of the
        // voice provider; its own init runs with INHERITED stdio (it owns the TTS-key
        // prompts). REPORT-ONLY for the exit code — an empty slot is a valid state.
        const { onboardVoiceProvider } = await import('../onboard/voice.ts')
        const voice = await onboardVoiceProvider({
          skip: flags['no-voice'] === true,
          package: typeof flags.voice === 'string' ? flags.voice : undefined,
          dryRun: flags['dry-run'] === true,
          env,
        })
        const voiceLabel = voice.provider ? `${voice.provider.provider} ${voice.provider.version}` : 'none'
        out(`voice: ${voice.state}${voice.detail ? ` — ${voice.detail}` : ''} (slot: ${voiceLabel})\n`)
        // Runtime auth readiness (clean-host prerequisite): a peer runs the runtime's
        // interactive TUI; the launcher auto-clears first-run modals (theme/trust) but
        // CANNOT complete a login OAuth flow. Warn for every INSTALLED runtime (marketplace
        // state != runtime-missing) that has no positive auth evidence — before it ships a
        // peer that would fail to wake on the login screen.
        for (const m of r.marketplaces) {
          if (m.state === 'runtime-missing') continue
          const authNote = runtimeAuthNote(m.runtime, env)
          if (authNote) errOut(authNote + '\n')
        }
        // macOS TCC advisory (manual grant — no flag/setting/script can): PROBE-DRIVEN, not
        // memory-gated — a missing grant silently breaks file I/O (EPERM, no prompt/hang) on
        // any TCC-protected path (iCloud vault, Documents/Desktop/Downloads peer cwd). Silent
        // when granted / non-macOS / undeterminable.
        const { iapeerBinPath } = await import('../install/index.ts')
        const tcc = tccFullDiskAccessNote({ fda: probeFullDiskAccess(env), binPath: iapeerBinPath(env) })
        if (tcc) out(tcc)
        return daemonFailed || r.marketplaces.some(m => m.state === 'failed') || infraFailed ? 1 : 0
      }
      case 'native-memory': {
        // The canonized runtime-memory lever (контракт «Слот памяти» §Native-память):
        // off = explicit disable merged into the peer's runtime config files; on =
        // remove the key (restore the runtime's own default). Consumers: the operator
        // and the memory provider's install-time sweep (`--all`). NOT slot-gated here —
        // an explicit operator/provider action; only the BIRTH-time hook is slot-gated.
        const state = positionals[0]
        if (state !== 'off' && state !== 'on') return argErr(errOut, 'native-memory needs a state — usage: iapeer native-memory <off|on> (--peer <p> | --all)')
        const peerName = typeof flags.peer === 'string' ? flags.peer : undefined
        if (flags.all !== true && !peerName) return argErr(errOut, 'native-memory needs a target — pass --peer <p> or --all')
        const { applyNativeMemory } = await import('../launch/nativeMemory.ts')
        const index = readPeersIndex({ env })
        const targets = flags.all === true ? index.peers : index.peers.filter(p => p.personality === peerName)
        if (targets.length === 0) {
          errOut(`peer "${peerName ?? ''}" is not in the iapeer peers index\n`)
          return 1
        }
        let failed = false
        for (const p of targets) {
          const outcomes = applyNativeMemory(p.cwd, p.runtimes, state)
          if (outcomes.length === 0) {
            out(`${p.personality}: no claude/codex runtime — skipped\n`)
            continue
          }
          for (const o of outcomes) {
            out(`${p.personality} (${o.runtime}): ${o.state}${o.detail ? ` — ${o.detail}` : ''}\n`)
            if (o.state === 'failed') failed = true
          }
        }
        return failed ? 1 : 0
      }
      case 'trust-hooks': {
        // Deterministic pre-seed of the codex hooks trust state for a FILE-form
        // hooks.json (user- or project-local layer) — the headless replacement for
        // the "Hooks need review" modal: codex trusts per hook-command HASH, and in
        // `codex exec` an untrusted hook is SILENTLY skipped (no modal, no error).
        // Verified on codex-cli 0.138.0 (golden hashes in the module tests).
        // Consumers: the memory provider's provision command (writes its per-peer
        // <cwd>/.codex/hooks.json, then shells this verb), operators. `--check` is
        // the read-only drift detector for verify pipelines — per-hook
        // trusted/missing/drift, exit 1 on anything but full trust.
        const target = positionals[0]
        if (!target) return argErr(errOut, 'trust-hooks needs a hooks file — usage: iapeer trust-hooks <hooks.json> [--check]')
        const { preSeedCodexHooksTrust, checkCodexHooksTrust } = await import('../launch/codexHooksTrust.ts')
        if (flags.check === true) {
          let checks
          try {
            checks = checkCodexHooksTrust(target, env)
          } catch (e) {
            errOut(`trust-hooks --check: ${e instanceof Error ? e.message : String(e)}\n`)
            return 1
          }
          for (const c of checks.checks) {
            out(`${c.status}\t${c.event}\t${c.key}${c.status === 'drift' ? ` (state: ${c.found ?? '?'} ≠ expected: ${c.hash})` : ''}\n`)
          }
          if (checks.checks.length === 0) out('no command hooks found — nothing to check\n')
          return checks.checks.every(c => c.status === 'trusted') ? 0 : 1
        }
        const r = preSeedCodexHooksTrust(target, env)
        if (r.state === 'failed') {
          errOut(`trust-hooks: ${r.detail}\n`)
          return 1
        }
        out(
          r.state === 'already'
            ? `already trusted: ${r.entries.length} hook(s) from ${r.source}${r.detail ? ` — ${r.detail}` : ''}\n`
            : `trusted ${r.entries.length} hook(s) from ${r.source} → ${r.path}\n`,
        )
        return 0
      }
      case 'status': {
        // Host snapshot (контракт «Слот памяти» §status): version + daemon health +
        // the memory-slot line. Exit 1 iff the daemon is unhealthy (usable as a
        // health gate); an EMPTY memory slot is a valid state and never fails.
        const { hostStatus, formatHostStatus } = await import('../status/index.ts')
        const s = await hostStatus({ env })
        out(formatHostStatus(s))
        return s.daemon.healthy ? 0 : 1
      }
      case 'live-runtime': {
        // The AUTHORITATIVE current live runtime of a peer (machine-readable, for external
        // consumers like telegram-runtime's typing indicator). Prints the runtime the peer
        // is RUNNING right now — the freshest-pane-log among its PID-alive supervisor
        // sessions — NOT default_runtime (the wake-default) and NOT a .session wake-record.
        // A peer can be alive on >1 runtime (a /codex flip leaves both); this picks the
        // currently-active. Exit 0 + the runtime on stdout when one is live; exit 1 + no
        // output when none is alive (queryable: `rt=$(iapeer live-runtime <p>) || handle-down`).
        if (!positionals[0]) return argErr(errOut, 'live-runtime needs a peer name — usage: iapeer live-runtime <peer>')
        const { resolveLiveRuntime } = await import('../transport/index.ts')
        const rt = resolveLiveRuntime(positionals[0])
        if (!rt) return 1 // no live session — no output, non-zero
        out(`${rt}\n`)
        return 0
      }
      case 'install-runtime': {
        // §6 onboard a runtime END-TO-END: npx-install the package (auto-resolved from
        // the built-in runtime→package registry, or --package; self-deploys bin +
        // manifest), THEN deploy its declared peer-set (each → provision + per-peer
        // self-config + auto-bootstrap). A runtime whose manifest declares no peers
        // (telegram) is operator-add — use `iapeer create <human> --runtime telegram`.
        if (!positionals[0]) return argErr(errOut, 'install-runtime needs a runtime — usage: iapeer install-runtime <runtime> (e.g. telegram | notifier)')
        const { onboardRuntime } = await import('../runtime/deploy.ts')
        const r = await onboardRuntime({
          runtime: positionals[0] as Runtime,
          package: typeof flags.package === 'string' ? flags.package : undefined,
          npx: flags.npx === true,
          bootstrap: flags['no-bootstrap'] === true ? false : undefined,
          env,
          warn: m => errOut(`warn: ${m}\n`),
        })
        out(`package ${r.install.package ?? '(none)'}: ${r.install.state}${r.install.detail ? ` — ${r.install.detail}` : ''}\n`)
        const d = r.deploy!
        if (d.operatorAddOnly) {
          out(`runtime "${d.runtime}": no declared peer-set (operator-add — use \`iapeer create <peer> --runtime ${d.runtime}\`)\n`)
          return 0
        }
        for (const p of d.peers) {
          out(`  ${p.personality} @ ${p.location}: self-config ${p.selfConfig ?? 'n/a'}; bootstrap ${p.bootstrap ?? 'n/a'}\n`)
        }
        out(`deployed runtime "${d.runtime}" (${d.peers.length} peer(s))\n`)
        return d.peers.some(p => p.bootstrap === 'failed' || p.selfConfig === 'failed') ? 1 : 0
      }
      case 'update-runtime': {
        // §(г) runtime-package update: version-gate (npm vs the manifest stamp) →
        // forced re-npx → idempotent re-provision (same path as install-runtime) →
        // restart the runtime's peers via the regular stop/start. The core's own
        // `update` stays foundation-only — this is the runtimes' counterpart.
        const all = flags.all === true
        if (!all && !positionals[0]) return argErr(errOut, 'update-runtime needs a runtime or --all — usage: iapeer update-runtime <runtime> | --all')
        const { updateRuntime, updateAllRuntimes } = await import('../runtime/update.ts')
        const results = all
          ? await updateAllRuntimes({ force: flags.force === true, env, warn: m => errOut(`warn: ${m}\n`) })
          : [await updateRuntime({ runtime: positionals[0] as Runtime, force: flags.force === true, env, warn: m => errOut(`warn: ${m}\n`) })]
        let failed = false
        for (const r of results) {
          const ver = r.from || r.to ? ` ${r.from ?? '?'} → ${r.to ?? '?'}` : ''
          out(`${r.runtime}: ${r.state}${ver}${r.detail ? ` — ${r.detail}` : ''}\n`)
          for (const p of r.peers) out(`  re-provisioned ${p.personality}: self-config ${p.selfConfig ?? 'n/a'}\n`)
          for (const p of r.restarted) out(`  restart ${p.personality}: ${p.state}${p.detail ? ` — ${p.detail}` : ''}\n`)
          if (r.state === 'install-failed' || r.state === 'deploy-failed' || r.state === 'npm-unreachable') failed = true
          if (r.restarted.some(p => p.state === 'failed')) failed = true
          if (!all && r.state === 'not-installed') failed = true
        }
        return failed ? 1 : 0
      }
      case 'init': {
        // cwd-DEPENDENT: onboard the CURRENT folder (or positional cwd) as a peer —
        // identity + MCP wiring + doctrine, runtime resolved from the cwd's markers
        // when not explicit. Auto-bootstraps an infra plist unless --no-bootstrap.
        // A peer's name IS its folder name (normalize(basename(cwd))) — personality ↔ folder
        // is 1:1, so `--personality` is gone: name the folder, don't pass a separate name.
        if (flags.personality !== undefined) {
          errOut("init: --personality was removed — a peer's name is its folder name; rename the folder to set the name\n")
          return 2
        }
        const { initPeer } = await import('../init/index.ts')
        const r = await initPeer({
          cwd: positionals[0] ?? process.cwd(),
          runtime: typeof flags.runtime === 'string' ? (flags.runtime as Runtime) : undefined,
          description: typeof flags.description === 'string' ? flags.description : undefined,
          runtimeBin: typeof flags.bin === 'string' ? flags.bin : undefined,
          bootstrap: flags['no-bootstrap'] === true ? false : undefined,
          env,
          warn: m => errOut(`warn: ${m}\n`),
        })
        // FU5 parity with `create`: a peer's `runtimes` must list EVERY installed agentic
        // runtime (the default is just one of them), so `iapeer <other-runtime>` works
        // without a manual add-runtime. initPeer resolves only the PRIMARY (cwd markers /
        // --runtime); declare the OTHER installed agentic runtime(s) too — otherwise the
        // registry the launch dispatch reads (folderLaunch → resolveWakeRuntime) lists the
        // primary only and `iapeer codex` fails "not declared" on a both-installed host.
        // addRuntime is capability-only (runs the runtime birth chain, reindexes the
        // registry from locals, NEVER flips the default); skip for an infra primary.
        const addedRuntimes: Runtime[] = []
        if (!isInfraRuntime(r.runtime)) {
          const { isRuntimeInstalled } = await import('../init/index.ts')
          const { secondaryRuntimes } = await import('../create/index.ts')
          const installed = (['claude', 'codex'] as Runtime[]).filter(rt => isRuntimeInstalled(rt, env))
          for (const rt of secondaryRuntimes(r.runtime, installed)) {
            try {
              const outcomes = await addRuntime(rt, { peer: r.personality, env })
              const o = outcomes.find(x => x.personality === r.personality)
              if (o && (o.action === 'added' || o.action === 'already')) addedRuntimes.push(rt)
              else errOut(`warn: could not add runtime "${rt}": ${o?.detail ?? o?.action ?? 'failed'}\n`)
            } catch (e) {
              errOut(`warn: could not add runtime "${rt}": ${e instanceof Error ? e.message : String(e)}\n`)
            }
          }
        }
        const allRuntimes = [r.runtime, ...addedRuntimes]
        out(
          `initialized "${r.personality}" (default: ${r.runtime}; runtimes: ${allRuntimes.join(', ')}); ` +
            `mcp: ${r.mcpConfigPaths.join(', ') || r.codexMcpConfigPath || 'none'}` +
            `${r.bootstrapped ? `; bootstrap: ${r.bootstrapped.state}` : ''}` +
            `${r.selfConfig?.state === 'failed' ? '; self-config: FAILED (infra peer NOT started)' : ''}\n`,
        )
        // В47 — a failed runtime self-config means initPeer deliberately did NOT bootstrap:
        // the always-on peer is not running. Exit 0 here read as success to automation.
        if (r.selfConfig?.state === 'failed') return 1
        return r.bootstrapped && (r.bootstrapped.state === 'failed' || r.bootstrapped.state === 'refused-foreign') ? 1 : 0
      }
      case 'create': {
        // cwd-INDEPENDENT: resolve a location (default ~/.iapeer/peers/<p> or --path),
        // scaffold the folder (no-clobber), then init it. Operator-add for an infra
        // human (telegram) or any agentic peer; provisions + auto-bootstraps infra.
        if (!positionals[0]) return argErr(errOut, 'create needs a peer name — usage: iapeer create <personality> [--runtime r] [--path dir]')
        const explicitRuntime = typeof flags.runtime === 'string' ? (flags.runtime as Runtime) : undefined
        // FU5 — never SILENTLY default to claude when both agentic runtimes are
        // installed. `--runtime` selects the DEFAULT (not the sole runtime); the
        // model is `runtimes` = all installed agentic runtimes, `default_runtime` =
        // the one chosen. So: resolve the default explicitly (prompt on a TTY, a loud
        // note off it) and auto-configure the other installed runtime(s) so the
        // `runtimes` list is TRUTHFUL — each listed runtime is actually wired.
        let chosenRuntime = explicitRuntime
        let extraRuntimes: Runtime[] = []
        if (!explicitRuntime || !isInfraRuntime(explicitRuntime)) {
          const { isRuntimeInstalled } = await import('../init/index.ts')
          const { planCreateRuntimes, secondaryRuntimes } = await import('../create/index.ts')
          const installed = (['claude', 'codex'] as Runtime[]).filter(rt => isRuntimeInstalled(rt, env))
          const plan = planCreateRuntimes(explicitRuntime, installed)
          if (plan.ambiguous) {
            chosenRuntime =
              process.stdin.isTTY === true && process.stdout.isTTY === true
                ? await promptDefaultRuntime(plan.installedAgentic)
                : (errOut(
                    `note: ${plan.installedAgentic.join(' and ')} are both installed — defaulting to "${plan.fallbackDefault}". ` +
                      'Pass --runtime to choose the default, or run create in a terminal to be asked.\n',
                  ),
                  plan.fallbackDefault)
          } else {
            chosenRuntime = plan.resolvedDefault
          }
          // installed.length === 0 → chosenRuntime stays undefined; createPeer surfaces
          // the clear "no agentic runtime installed" error.
          extraRuntimes = secondaryRuntimes(chosenRuntime, installed)
        }
        const { createPeer } = await import('../create/index.ts')
        const r = await createPeer({
          personality: positionals[0],
          runtime: chosenRuntime,
          path: typeof flags.path === 'string' ? flags.path : undefined,
          description: typeof flags.description === 'string' ? flags.description : undefined,
          intelligence: typeof flags.intelligence === 'string' ? (flags.intelligence as Intelligence) : undefined,
          runtimeBin: typeof flags.bin === 'string' ? flags.bin : undefined,
          bootstrap: flags['no-bootstrap'] === true ? false : undefined,
          env,
          warn: m => errOut(`warn: ${m}\n`),
        })
        // Wire the other installed agentic runtime(s) — addRuntime is capability-only
        // (merges `runtimes`, runs the runtime's birth chain, NEVER flips the default).
        // Best-effort: a peer is usable on its default even if a secondary warns.
        const addedRuntimes: Runtime[] = []
        for (const rt of extraRuntimes) {
          try {
            const outcomes = await addRuntime(rt, { peer: r.personality, env })
            const o = outcomes.find(x => x.personality === r.personality)
            if (o && (o.action === 'added' || o.action === 'already')) addedRuntimes.push(rt)
            else errOut(`warn: could not add runtime "${rt}": ${o?.detail ?? o?.action ?? 'failed'}\n`)
          } catch (e) {
            errOut(`warn: could not add runtime "${rt}": ${e instanceof Error ? e.message : String(e)}\n`)
          }
        }
        const allRuntimes = [r.runtime, ...addedRuntimes]
        out(
          `created "${r.personality}" (default: ${r.runtime}; runtimes: ${allRuntimes.join(', ')}) at ${r.location}; ` +
            `mcp: ${r.mcpConfigPaths.join(', ') || r.codexMcpConfigPath || 'none'}` +
            `${r.plistPath ? `; plist: ${r.plistPath}` : ''}${r.bootstrapped ? `; bootstrap: ${r.bootstrapped.state}` : ''}` +
            `${r.selfConfig?.state === 'failed' ? '; self-config: FAILED (infra peer NOT started)' : ''}\n`,
        )
        // В47 — selfConfig 'failed' deliberately skips the bootstrap (initPeer), so the
        // always-on peer is NOT running; `create x --runtime telegram` with a broken hook
        // exited 0 and automation read a dead telegram router as provisioned.
        if (r.selfConfig?.state === 'failed') return 1
        return r.bootstrapped && (r.bootstrapped.state === 'failed' || r.bootstrapped.state === 'refused-foreign') ? 1 : 0
      }
      case 'list': {
        // tty + no --json → the live Ink dashboard (Фаза 3: host header · live peer
        // table · per-peer log panel · Enter=attach via suspend-and-spawn);
        // non-tty / --json → the scriptable table (machine-parsable). The dashboard
        // fails CLOSED to the table when no real TTY drives it (sentinel), the same
        // belt as the onboard wizard.
        if (flags.json !== true && process.stdout.isTTY && process.stdin.isTTY) {
          const { runDashboard, DASHBOARD_NOT_INTERACTIVE } = await import('../tui/dashboard/run.tsx')
          const code = await runDashboard({ env })
          if (code !== DASHBOARD_NOT_INTERACTIVE) return code
        }
        const rows = listPeers({ env })
        out(flags.json ? JSON.stringify(rows, null, 2) + '\n' : formatListTable(rows))
        return 0
      }
      case 'verify': {
        // Profile conformance + index↔local self-heal reconciliation. Read-only by
        // default; --fix self-heals the index (reindex from local profiles) AND
        // migrates conformant local profiles off the legacy `runtime` field shape
        // (Phase 2 of the staged default_runtime story). A drift is a signal that
        // the index self-heal lapsed — caught by construction here.
        const index = readPeersIndex({ env })
        let errors = 0
        let driftCount = 0
        const lines: string[] = []
        // Conformant profiles still carrying the LEGACY runtime field shape (no
        // default_runtime, or a diverged mirror) — candidates for the --fix data
        // migration (Phase 2 of the staged default_runtime story).
        const legacyRuntimeProfiles: Array<{ personality: string; cwd: string }> = []
        for (const peer of index.peers) {
          const path = peerProfilePath(peer.cwd)
          if (!existsSync(path)) {
            errors++
            lines.push(`✗ ${peer.personality}: no local profile at ${path}`)
            continue
          }
          let raw: unknown
          try {
            raw = JSON.parse(readFileSync(path, 'utf8'))
          } catch (e) {
            errors++
            lines.push(`✗ ${peer.personality}: profile is invalid JSON — ${e instanceof Error ? e.message : String(e)}`)
            continue
          }
          const issues = validateProfileStandard(raw, peer.cwd)
          const errs = issues.filter(i => i.severity === 'error')
          const warns = issues.filter(i => i.severity === 'warn')
          if (errs.length > 0) errors += errs.length
          if (!isConformant(issues)) {
            lines.push(`✗ ${peer.personality}: ${errs.map(i => `${i.field} — ${i.message}`).join('; ')}`)
          } else if (warns.length > 0 && flags.json !== true) {
            lines.push(`⚠ ${peer.personality}: ${warns.map(i => i.field).join(', ')}`)
          }
          // Migration candidate (Phase-3): conformant AND still carrying the legacy `runtime` field —
          // a warn-fired legacy-only/diverged shape OR an in-sync mirror. In Phase-3 ANY `runtime`
          // field is stripped, so the candidate set is "has a runtime field", not just "warn fired"
          // (an in-sync mirror does not warn, but must still be cleaned). Errored profiles are NEVER
          // rewritten — migration heals shape, it does not guess at broken data.
          const hasLegacyRuntime = !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).runtime !== undefined
          if (errs.length === 0 && (warns.some(i => i.field === 'default_runtime') || hasLegacyRuntime)) {
            legacyRuntimeProfiles.push({ personality: peer.personality, cwd: peer.cwd })
          }
        }
        const reconcile = reconcileIndex({ env })
        for (const r of reconcile) {
          if (r.drift === null) {
            // missing local profile already reported above as an error
          } else if (r.drift.length > 0) {
            driftCount++
            lines.push(`↯ ${r.personality}: index↔local drift on ${r.drift.join(', ')}`)
          }
        }
        if (flags.json === true) {
          out(JSON.stringify({ peers: index.peers.length, errors, drift: driftCount, reconcile }, null, 2) + '\n')
        } else {
          for (const l of lines) out(l + '\n')
          out(`\n${index.peers.length} peers · ${errors} error(s) · ${driftCount} index↔local drift(s)\n`)
        }
        if (flags.fix === true) {
          // Phase-3 data migration (default_runtime story complete): rewrite conformant local profiles
          // still carrying the legacy `runtime` field — the writer now emits ONLY `default_runtime` and
          // STRIPS the mirror. Runs BEFORE the reindex so the healed index is projected from clean locals.
          const migrated: string[] = []
          for (const p of legacyRuntimeProfiles) {
            if (migrateProfileRuntimeField(p.cwd)) migrated.push(p.personality)
          }
          if (migrated.length > 0) {
            out(`stripped legacy \`runtime\` mirror (default_runtime only): ${migrated.join(', ')}\n`)
          }
          if (driftCount > 0 || errors === 0) {
            const { healed, missing } = await reindexFromLocals({ env })
            if (healed.length > 0) out(`self-healed index from local profiles:\n  ${healed.join('\n  ')}\n`)
            if (missing.length > 0) errOut(`peers with no local profile (left untouched): ${missing.join(', ')}\n`)
          }
        }
        return errors > 0 || (driftCount > 0 && flags.fix !== true) ? 1 : 0
      }
      case 'stop': {
        // --all stops every registered peer (the fleet guard still refuses foreign
        // persistent-peer plists, so the live fleet stays untouched).
        const peers = flags.all === true
          ? readPeersIndex({ env }).peers.map(p => p.personality)
          : positionals[0]
            ? [positionals[0]]
            : null
        if (!peers) return argErr(errOut, 'stop needs a peer or --all — usage: iapeer stop <peer> [runtime] | --all')
        const outcomes = peers.flatMap(p => stopPeer(p, flags.all === true ? undefined : positionals[1], { env }))
        for (const o of outcomes) out(`${o.personality} (${o.runtime}): ${o.action}${o.reason ? ` — ${o.reason}` : ''}\n`)
        // В48 — a REAL bootout error (reason set; benign already-unloaded carries none) is exit 1:
        // automation must see that an always-on peer may still be running.
        return outcomes.some(o => o.action === 'refused-foreign-launchd' || (o.action === 'bootout' && o.reason !== undefined)) ? 1 : 0
      }
      case 'add-runtime': {
        // Fleet-switch enabler (codex-parity audit): add an agentic runtime to
        // existing peer(s) — full codex birth chain per target, idempotent.
        const rt = positionals[0]
        if (!rt) return argErr(errOut, 'add-runtime needs a runtime — usage: iapeer add-runtime <runtime> (--peer <p> | --all)')
        const peerName = typeof flags.peer === 'string' ? flags.peer : undefined
        if (flags.all !== true && !peerName) return argErr(errOut, 'add-runtime needs a target — pass --peer <p> or --all')
        const outcomes = await addRuntime(rt, { peer: peerName, all: flags.all === true, env })
        for (const o of outcomes) out(`${o.personality}: ${o.action}${o.detail ? ` — ${o.detail}` : ''}\n`)
        return outcomes.some(o => o.action === 'failed') ? 1 : 0
      }
      case 'default-runtime': {
        // The PRIMARY flip (routing/wake default) — the fleet-switch moment itself.
        const rt = positionals[0]
        if (!rt) return argErr(errOut, 'default-runtime needs a runtime — usage: iapeer default-runtime <runtime> (--peer <p> | --all)')
        const peerName = typeof flags.peer === 'string' ? flags.peer : undefined
        if (flags.all !== true && !peerName) return argErr(errOut, 'default-runtime needs a target — pass --peer <p> or --all')
        const outcomes = await defaultRuntime(rt, { peer: peerName, all: flags.all === true, env })
        for (const o of outcomes) out(`${o.personality}: ${o.action}${o.detail ? ` — ${o.detail}` : ''}\n`)
        return outcomes.some(o => o.action === 'failed') ? 1 : 0
      }
      case 'new': {
        // UNCONDITIONAL fresh restart (control, system class — docs/Control-команды
        // §new): the emergency lever for a hung/dead session, bypasses the peer.
        // Source: operator CLI, or telegram-runtime's clean-/new detect (their bot
        // shells `iapeer new <peer> <runtime>` — exit 0 ⟺ fresh session up+ready).
        if (!positionals[0]) return argErr(errOut, 'new needs a peer name — usage: iapeer new <peer> [runtime]')
        const o = await newPeer(positionals[0], positionals[1], { env })
        if (o.action === 'fresh') {
          out(`new: ${o.runtime}-${o.personality} fresh session up\n`)
          return 0
        }
        errOut(`new: ${o.personality} (${o.runtime}): ${o.action}${o.reason ? ` — ${o.reason}` : ''}\n`)
        return 1
      }
      case 'start': {
        // --all re-enables every REGISTERED peer (mirror of `stop --all` — without
        // it, bringing a stopped fleet back required a manual loop over every
        // peer). Enumeration is the registry, so unregistered garbage (stray flag
        // files for identities no record claims) is never touched. NOTE: for warm
        // peers this clears the stop flag only — no session is launched; each peer
        // becomes wakeable and the daemon brings its session up on the first message.
        const peers = flags.all === true
          ? readPeersIndex({ env }).peers.map(p => p.personality)
          : positionals[0]
            ? [positionals[0]]
            : null
        if (!peers) return argErr(errOut, 'start needs a peer or --all — usage: iapeer start <peer> [runtime] | --all')
        const outcomes = peers.flatMap(p => startPeer(p, flags.all === true ? undefined : positionals[1], { env }))
        for (const o of outcomes) out(`${o.personality} (${o.runtime}): ${o.action}${o.reason ? ` — ${o.reason}` : ''}\n`)
        // В48 — a failed launchctl bootstrap (reason set) means the always-on peer is NOT
        // started; exit 0 here let automation read a dead telegram/notifier as running.
        return outcomes.some(o => o.action === 'refused-foreign-launchd' || (o.action === 'bootstrap' && o.reason !== undefined)) ? 1 : 0
      }
      case 'refresh': {
        // LAZY soft-reload (fleet doctrine refresh): arm `.fresh-next` so each agentic peer comes up FRESH
        // on its NEXT natural wake (re-reads doctrine/fragments) — no kill, no eager relaunch, no burst-wake.
        // --all marks the whole registered fleet. H4-safe (marker only); non-agentic runtimes are skipped.
        const peers = flags.all === true
          ? readPeersIndex({ env }).peers.map(p => p.personality)
          : positionals[0]
            ? [positionals[0]]
            : null
        if (!peers) return argErr(errOut, 'refresh needs a peer or --all — usage: iapeer refresh <peer> [runtime] | --all')
        const outcomes = peers.flatMap(p => refreshPeer(p, flags.all === true ? undefined : positionals[1], { env }))
        for (const o of outcomes) out(`${o.personality} (${o.runtime}): ${o.action}\n`)
        return 0
      }
      case 'remove': {
        // Reap a registry record through the locked writer (the operator path over
        // registry.removePeer). Idempotent on an absent peer (exit 0). Refuses a LIVE
        // peer unless --force (orphaning a running session from routing is the risk).
        if (!positionals[0]) return argErr(errOut, 'remove needs a peer name — usage: iapeer remove <peer> [--force]')
        const o = await removePeerCli(positionals[0], { force: flags.force === true, env })
        if (o.action === 'removed') {
          out(`removed "${o.personality}" from the registry\n`)
          // Always-on plist teardown (bootout + rm) — an orphan loaded plist would
          // KeepAlive-crash-loop run-infra against the deleted record.
          if (o.plistTeardown) {
            out(`launchd plist: ${o.plistTeardown}\n`)
          }
          // v1.2: the provider unwound its surfaces (occasion=remove) — say how it went.
          if (o.unprovision?.length) {
            out(`memory unprovision: ${o.unprovision.join(', ')}\n`)
          }
          // Codex pre-trust cleanup — the cwd's trust entry must die with the peer.
          if (o.codexTrust) {
            out(`codex trust entry: ${o.codexTrust}\n`)
          }
          // Same for pre-seeded hooks trust state (trust-hooks verb's writes).
          if (o.codexHooksTrust) {
            out(`codex hooks trust: ${o.codexHooksTrust}\n`)
          }
          // Stale identity-keyed markers must die with the record (a namesake
          // newborn inherited a dead peer's .stopped → refused to wake).
          if (o.purgedState?.length) {
            out(`lifecycle state purged: ${o.purgedState.join(', ')}\n`)
          }
          // Deliberate: the registry reap never deletes user data — but SAY so, or
          // the default-location peers leave silent orphan folders.
          if (o.cwd && existsSync(o.cwd)) {
            out(`folder kept: ${o.cwd} (remove never deletes peer data — \`rm -rf\` it yourself if it was a throwaway)\n`)
          }
        } else if (o.action === 'absent') out(`"${o.personality}" not registered — no-op\n`)
        else errOut(`remove: ${o.reason}\n`)
        return o.action === 'refused-live' || o.action === 'refused-foreign-launchd' ? 1 : 0
      }
      case 'rename': {
        // FULL folder rename (Arthur's invariant: personality == basename(cwd)): mv the
        // folder + the claude transcript slug dir + atomic registry cwd+personality, with
        // rollback; best-effort codex re-trust + .mcp.json rewrite + old-marker purge.
        // Refuses a LIVE peer unless --force. Memory + codex-history caveats are stated —
        // a silent data move reads as loss otherwise.
        if (!positionals[0] || !positionals[1]) {
          return argErr(errOut, 'rename needs old and new names — usage: iapeer rename <old> <new> [--force]')
        }
        const o = await renamePeerCli(positionals[0], positionals[1], { force: flags.force === true, env })
        if (o.action === 'renamed') {
          out(`renamed "${o.oldPersonality}" → "${o.newPersonality}"\n`)
          out(`  folder: ${o.oldCwd} → ${o.newCwd}\n`)
          out(`  claude transcript: ${o.transcriptMoved ? 'moved (history preserved)' : 'no slug dir to move'}\n`)
          if (o.sideEffects?.length) out(`  ${o.sideEffects.join('\n  ')}\n`)
          if (o.purgedState?.length) out(`  lifecycle state purged (old identity): ${o.purgedState.join(', ')}\n`)
          out(
            `NOTE: memory (operativka folder + author/index) is personality-keyed — re-key it under "${o.newPersonality}" via the memory provider separately. codex resume-history for the old cwd does NOT carry (codex keys sessions on the in-file cwd). Wake "${o.newPersonality}" to verify identity + history.\n`,
          )
        } else if (o.action === 'absent') errOut(`rename: "${o.oldPersonality}" not registered\n`)
        else errOut(`rename: ${o.reason}\n`)
        return o.action === 'renamed' ? 0 : 1
      }
      case 'send': {
        // Message body from EITHER --message <text> OR --message-file <f> (f='-' →
        // stdin). The runtime packages (telegram/notifier) + monitor deliver via
        // --message-file (large/multi-line bodies, special chars); manual/peer-voice
        // use --message. Both supported; keep both — do not replace one with the other.
        let message: string | null = null
        if (typeof flags.message === 'string') {
          message = flags.message
        } else if (typeof flags['message-file'] === 'string') {
          const mf = flags['message-file']
          message = mf === '-' ? readFileSync(0, 'utf8') : readFileSync(mf, 'utf8')
        }
        if (!positionals[0] || message === null) return argErr(errOut, 'send needs a target and a message — usage: iapeer send <target> --message <text> (or --message-file <f|->)')
        // --attachment is REPEATABLE; parseArgs collapses repeats (last-wins), so
        // re-scan the raw rest argv to collect every attachment path (else files
        // silently drop — a text-only smoke test would not catch it).
        const attachments: string[] = []
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--attachment' && rest[i + 1] !== undefined) attachments.push(rest[++i])
          else if (rest[i].startsWith('--attachment=')) attachments.push(rest[i].slice('--attachment='.length))
        }
        const r = await sendMessage({
          target: positionals[0],
          from: typeof flags.from === 'string' ? flags.from : defaultFromIdentity(env),
          message,
          runtime: typeof flags.runtime === 'string' ? flags.runtime : undefined,
          topic: typeof flags.topic === 'string' ? flags.topic : undefined,
          attachments: attachments.length ? attachments : undefined,
          env,
        })
        out(
          r.queued
            ? `queued for ${r.delivered_to.personality} (${r.delivered_to.runtime}), depth ${r.queueDepth ?? '?'} — the daemon tick drains it\n`
            : `delivered to ${r.delivered_to.personality} (${r.delivered_to.runtime})\n`,
        )
        return 0
      }
      case 'version':
      case '--version':
      case '-v': {
        out(`${IAPEER_VERSION}\n`)
        return 0
      }
      case 'update': {
        // CASCADE deploy (FU12): a bare `iapeer update` updates the WHOLE host stack —
        // foundation → every installed runtime → the memory provider — in one command.
        // Foundation goes FIRST and ABORTS the cascade on a hard failure (never update
        // runtimes onto a broken core). Runtimes + memory are BEST-EFFORT (reported, not
        // fatal). Two narrowings stay foundation-ONLY: `--foundation-only` (explicit) and
        // a pinned `update <version>` (a version pin is foundation-specific — downgrade /
        // recover). H4 holds throughout (foreign persistent-peer fleet is refused, never
        // forced — the runtime restart goes via the guarded stop/start). Cloud-only; the
        // first-ever install is `npx @agfpd/iapeer`.
        const pinned = positionals[0]
        const foundationOnly = flags['foundation-only'] === true
        const cascading = !foundationOnly && !pinned
        if (cascading) {
          // no-surprise heads-up: this restarts peers and can run minutes.
          out(
            'iapeer update — updating the WHOLE stack: foundation + installed runtimes + memory provider.\n' +
              'This rebuilds the daemon, restarts the telegram/notifier services and the memory daemon,\n' +
              'and can take a few minutes; agentic peers pick up the new code on their next wake.\n' +
              '(`iapeer update --foundation-only` updates just the core.)\n\n',
          )
        }

        // ── Foundation (the core; a hard failure aborts the cascade) ──
        // updateIapeer owns the whole settle sequence now: restart → health-gate →
        // (infra recycle + known-good stamp) — В54: infra recycles ONLY after health;
        // В50: the healthy binary is stamped so the next install may refresh `.prev`;
        // В53: "already-latest" also verifies the LIVE daemon runs the binary's version
        // (an interrupted prior update heals with a restart instead of a false no-op).
        const r = await updateIapeer({ env, force: flags.force === true, targetVersion: pinned })
        let foundationHardFail = false
        if (r.status === 'failed') {
          errOut(`update failed: ${r.reason}\n`)
          foundationHardFail = true
        } else if (r.status === 'already-latest') {
          out(`foundation: already at version ${r.from}\n`)
        } else if (r.daemon === 'restarted') {
          if (r.healthy !== true) {
            errOut(`foundation: updated ${r.from} → ${r.to} but ${r.reason ?? 'the daemon is NOT healthy after restart'}.\nroll back now: iapeer rollback\n`)
            foundationHardFail = true
          } else {
            const note = infraRecycleNote(r.infra)
            const healNote = r.healedStaleDaemon ? ` (live daemon was still on ${r.healedStaleDaemon} — healed)` : ''
            ;(infraRecycleFailed(r.infra) ? errOut : out)(`foundation: updated ${r.from} → ${r.to}; daemon restarted and healthy${healNote}${note}\n`)
          }
        } else {
          const daemonNote =
            r.daemon === 'not-loaded'
              ? 'daemon not loaded — new binary will be used on next start'
              : r.daemon === 'failed'
                ? `WARNING — ${r.reason}; roll back with: iapeer rollback`
                : String(r.daemon)
          if (r.daemon === 'failed') foundationHardFail = true
          const note = infraRecycleNote(r.infra)
          ;(r.daemon === 'failed' || infraRecycleFailed(r.infra) ? errOut : out)(`foundation: updated ${r.from} → ${r.to}; ${daemonNote}${note}\n`)
        }
        const foundationExit = foundationHardFail || infraRecycleFailed(r.infra) ? 1 : 0

        // foundation-only / pinned / hard-fail → stop here (don't cascade onto a broken core).
        if (!cascading || foundationHardFail) return foundationExit

        // ── Cascade tail: runtimes + memory provider (best-effort) ──
        const { updateAllRuntimes } = await import('../runtime/update.ts')
        const { updateMemoryProvider } = await import('../onboard/memory.ts')
        const { updateVoiceProvider } = await import('../onboard/voice.ts')
        const tail = await cascadeTail({
          runtimes: () => updateAllRuntimes({ force: flags.force === true, env, warn: m => errOut(`warn: ${m}\n`) }),
          memory: () => updateMemoryProvider({ env }),
          voice: () => updateVoiceProvider({ env }),
          out,
        })
        return foundationExit === 0 && !tail.failed ? 0 : 1
      }
      case 'rollback': {
        // Recovery: restore the .prev binary kept by the last install, restart the
        // daemon onto it, and verify health. ONE level deep (single .prev). Cloud is
        // still the source of truth — rollback is the local "undo the last update" while
        // a fixed version is published.
        const { rollbackIapeer, stampBinaryHealthy } = await import('../install/index.ts')
        const rb = rollbackIapeer(env)
        if (rb.status === 'failed') {
          errOut(`rollback failed: ${rb.reason}\n`)
          return 1
        }
        const restart = cycleDaemon(env)
        const infra = recycleFoundationOwnedInfraJobs(env)
        const infraNote = infraRecycleNote(infra)
        const infraFailed = infraRecycleFailed(infra)
        if (restart.state === 'restarted') {
          const h = await waitForDaemonHealthy({ env })
          // В50 — a restored binary that just proved healthy is known-good: stamp it so
          // the NEXT install may refresh `.prev` from it (sandbox never reaches here).
          if (h.healthy) stampBinaryHealthy(env)
          const msg = h.healthy
            ? `rolled back to the previous binary; daemon restarted and healthy${infraNote}\n`
            : `rolled back, but the daemon is NOT healthy after restart (${h.detail})${infraNote}\n`
          ;(h.healthy && !infraFailed ? out : errOut)(msg)
          return h.healthy && !infraFailed ? 0 : 1
        }
        const msg =
          `rolled back to the previous binary; ${
            restart.state === 'not-loaded'
              ? 'daemon not loaded — previous binary will be used on next start'
              : `daemon restart ${restart.state}${restart.detail ? ` (${restart.detail})` : ''}`
          }${infraNote}\n`
        const failed = restart.state === 'failed' || infraFailed
        ;(failed ? errOut : out)(msg)
        return failed ? 1 : 0
      }
      case 'uninstall': {
        // Symmetric foundation removal (namespace-safe; REFUSES on a foreign fleet).
        // DESTRUCTIVE — removes ~/.iapeer (all peers/memory/logs). --dry-run previews;
        // --yes skips the confirm; --remove-codesign-identity also drops the shared
        // agfpd signing identity (otherwise kept).
        const { planUninstall, executeUninstall } = await import('../uninstall/index.ts')
        const removeCodesign = flags['remove-codesign-identity'] === true
        const plan = planUninstall({ env, removeCodesignIdentity: removeCodesign })
        if (plan.refused) {
          errOut(`uninstall refused — ${plan.refused.reason}\n`)
          return 1
        }
        out('iapeer uninstall — will remove:\n')
        for (const it of plan.items) {
          const mark = it.present ? '•' : '·'
          const tail = it.detail ? ` — ${it.detail}` : it.present ? '' : ' — already gone'
          out(`  ${mark} ${it.what}${it.path ? `  (${it.path})` : ''}${tail}\n`)
        }
        if (flags['dry-run'] === true) {
          out('\n(dry-run — nothing removed)\n')
          return 0
        }
        if (flags.yes !== true) {
          if (process.stdin.isTTY !== true) {
            errOut('\nuninstall is destructive (removes ~/.iapeer) — re-run with --yes in a non-interactive shell.\n')
            return 2
          }
          const { createInterface } = await import('node:readline/promises')
          const rl = createInterface({ input: process.stdin, output: process.stdout })
          let answer = ''
          try {
            answer = (await rl.question('\nThis permanently removes iapeer and ALL its data. Continue? [y/N] ')).trim().toLowerCase()
          } finally {
            rl.close()
          }
          if (answer !== 'y' && answer !== 'yes') {
            out('uninstall aborted.\n')
            return 1
          }
        }
        const res = await executeUninstall({ env, removeCodesignIdentity: removeCodesign })
        for (const r of res.removed) out(`  removed: ${r}\n`)
        for (const s of res.skipped) out(`  skipped (absent): ${s}\n`)
        for (const f of res.failed) errOut(`  FAILED: ${f.what} — ${f.detail}\n`)
        out(res.failed.length ? '\nuninstall finished with errors (see above).\n' : '\niapeer uninstalled. (bun left in place.)\n')
        return res.failed.length ? 1 : 0
      }
      case 'install': {
        // UNIFIED foundation install (contract Установка §1 — "один npx ставит
        // фундамент"): ONE command does all three install-phase steps that used to be
        // split across `install` + `daemon --install-plist`:
        //   (1) global scaffold ~/.iapeer/ (+ peers/, state/logs/cache, runtime scopes)
        //   (2) build + place the stable ~/.local/bin/iapeer binary (atomic)
        //   (3) WRITE the daemon's com.agfpd.iapeer plist (NOT bootstrapped — a live
        //       daemon already runs; migrating it onto the installed binary is a
        //       separate coordinated wave, contract Установка §1).
        // Bootstrap path — run from the src tree (`bun src/cli/index.ts install`) or
        // npx; the compiled binary cannot rebuild itself from source (its
        // import.meta.url is the binary → build fails with a clear error).
        const { installIapeer, scaffoldHostDocs } = await import('../install/index.ts')
        const { ensureGlobalDoctrineTemplate } = await import('../init/index.ts')
        ensureGlobalIapScaffold({ env })
        // FU11 — scaffold the GLOBAL host-doctrine stub ~/.iapeer/IAPEER.md (Layer-2
        // global doctrine, consumed at launch but previously never created — asymmetric
        // with the per-peer stub). Idempotent: never overwrites an owner's host doctrine.
        const hostDoctrine = ensureGlobalDoctrineTemplate(env)
        const r = installIapeer(fileURLToPath(import.meta.url), env)
        // FU6 — copy the foundation contract docs to the stable per-package host path
        // ~/.iapeer/docs/iapeer/ (the ecosystem convention: each package copies its OWN
        // docs on its OWN install, version = its binary). install runs from source, so
        // docs/ sits at <entry>/../../docs. Best-effort: never fails the install.
        const docs = scaffoldHostDocs('iapeer', join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs'), env)
        // Ship the tray face WITH the foundation (owner decision — same class as the
        // `iapeer list` TUI). Plugin-file ONLY: drop/refresh the SwiftBar plugin shim
        // (into a configured SwiftBar dir if present, else the dedicated ~/.iapeer dir).
        // Inert without SwiftBar; NEVER auto-installs the GUI here (that is the explicit
        // `iapeer tray install`). Best-effort — a hiccup never fails the foundation install.
        let trayLine = ''
        try {
          const { installTray } = await import('../tray/index.ts')
          const t = installTray({ env, installApp: false, launch: false })
          trayLine = `  tray plugin: ${t.wrote ? 'written' : 'unchanged'} → ${t.pluginFile} (${t.dir})\n`
        } catch (e) {
          trayLine = `  tray plugin: skipped (${e instanceof Error ? e.message : String(e)})\n`
        }
        const { path: plist, changed: plistChanged } = installDaemonPlist({ env })
        const signingLine =
          r.signing == null
            ? ''
            : r.signing.state === 'failed-soft'
              ? `  WARNING signing: ${r.signing.detail}\n`
              : `  signing: ${r.signing.state}${r.signing.state === 'signed-new-identity' ? ' (local identity created — the one install-time event)' : ''}\n`
        out(
          `installed iapeer → ${r.binPath}` +
            `${r.prevPath ? ` (previous kept: ${r.prevPath})` : ''}` +
            `${r.prevKept ? ` (.prev NOT overwritten: ${r.prevKept.reason})` : ''}` +
            `${r.size ? ` (${Math.round(r.size / 1e6)}M)` : ''}\n` +
            signingLine +
            `  scaffold: ~/.iapeer/ ensured (peers/, state, logs, cache, runtimes)\n` +
            `  host doctrine: ${hostDoctrine.path}${hostDoctrine.created ? ' (stub created — fill it in)' : ' (kept)'}\n` +
            `  docs: ${docs.copied ? docs.dest : `skipped (${docs.reason})`}\n` +
            trayLine +
            `  daemon plist ${plistChanged ? 'written' : 'unchanged (byte-identical — no write, no BTM notification)'}: ${plist}\n` +
            `  (NOT loaded — a live daemon migration is a separate step: launchctl bootstrap gui/$(id -u) ${plist})\n`,
        )
        return 0
      }
      case 'daemon': {
        // Ф-F: the prod daemon entrypoint. The launchd plist runs `iapeer daemon`
        // (the INSTALLED binary), decoupling prod from the mutable src tree.
        if (flags['install-plist'] === true) {
          const { path: p, changed } = installDaemonPlist({ env })
          out(`daemon plist ${changed ? 'written' : 'unchanged'}: ${p}\nNOT loaded — to start: launchctl bootstrap gui/$(id -u) ${p}\n`)
          return 0
        }
        const handle = await startConfiguredDaemon({
          port: parseDaemonPort(env.IAPEER_PORT), // В29 — strict: NaN/out-of-range → default, never an ephemeral port
          socketPath: env.IAPEER_DAEMON_SOCKET?.trim() || undefined,
          env,
        })
        errOut(`[iapeer] daemon READY tcp=${handle.url} sock=${handle.socketPath}\n`)
        const shutdown = () => void handle.close().then(() => process.exit(0))
        process.on('SIGTERM', shutdown)
        process.on('SIGINT', shutdown)
        await new Promise(() => {}) // launchd KeepAlive holds this process; block forever
        return 0
      }
      case 'run-infra': {
        // Ф-F: the always-on infra entrypoint (telegram/notifier), held by launchd.
        // The infra plist runs `iapeer run-infra <personality> <runtime>` (installed
        // binary) instead of `bun launchdRun.ts`. cwd = the launchd WorkingDirectory.
        if (!positionals[0] || !positionals[1]) return argErr(errOut, 'run-infra needs a runtime and a personality — usage: iapeer run-infra <runtime> <personality> (internal launchd entrypoint)')
        return await runAlwaysOn(positionals[0], positionals[1], process.cwd())
      }
      case 'self-done': {
        // SILENT-FINISH self-call for an ephemeral worker (контракт ЖЦ §wake_policy):
        // a worker whose task produced NOTHING to send must still release its M3
        // FIFO — but an EMPTY report would violate the invariant
        // «событие-всё-отфильтровано = тишина» (no empty wakes of the
        // target). This verb is the non-waking arm: it sets the worker's OWN
        // .ephemeral-armed (same marker the ok-outbound hook sets), so the quiet
        // window reaps it within seconds and the drain feeds the next task — nobody
        // is woken. Doctrine for silent finishers: «нечего отправлять → iapeer
        // self-done вместо ответа». The unarmed idle bound (ephemeralUnarmedIdleSecs)
        // remains the backstop for workers that do neither. On a NON-ephemeral peer
        // the marker is inert (quiet-reap keys on wake_policy) — warn, exit 0.
        const identity = env.PEER_IDENTITY?.trim()
        if (!identity) {
          errOut('self-done: PEER_IDENTITY is not set — this verb is an agent self-call from inside a session\n')
          return 1
        }
        if (!parseSessionName(identity)) {
          errOut(`self-done: invalid PEER_IDENTITY "${identity}" — expected <runtime>-<personality>\n`)
          return 1
        }
        const cfg = loadLifecycleConfig(env)
        setEphemeralArmed(cfg, identity)
        // The ephemeral check keys on the peer's CANONICAL cwd (registry), NOT on
        // process.cwd(): the verb is invoked from wherever the agent's shell
        // happens to be, and a foreign cwd made this warning LIE — «marker is
        // inert» on a genuinely ephemeral peer (the false warning sends the reader
        // down a wrong root-cause chase). The marker itself was never affected — it is
        // identity-keyed and supervise checks the SESSION's canonical cwd.
        const addr = parseSessionName(identity)!
        const canonicalCwd = findPeer(readPeersIndex({ env }), addr.personality)?.cwd ?? process.cwd()
        const ephemeral = isEphemeralPeer(canonicalCwd)
        out(
          `self-done: armed ${identity} for the quiet-window reap (no one woken)` +
            (ephemeral ? '' : ' — NOTE: this peer is not wake_policy:ephemeral, the marker is inert') +
            '\n',
        )
        return 0
      }
      case 'self-fresh': {
        // /new AGENT-FACING TRIGGER (TARGET redesign). Run BY the agent itself as the
        // FINAL step of a /new graceful wind-down (the owner triggers it via a per-peer
        // telegram alias: "write a handoff to durable memory, then run iapeer self-fresh"
        // — the alias text is telegram-owned, NOT global doctrine). It: resolves the
        // caller identity from PEER_IDENTITY (<runtime>-<personality>), writes the
        // .new-eager mark, then self-kills the caller's OWN tmux session. The daemon's
        // superviseTick then sees the dead session carrying .new-eager → eager fresh
        // relaunch (with initial_prompt) so the agent reports it is back up.
        const identity = env.PEER_IDENTITY?.trim()
        if (!identity) {
          errOut('self-fresh: PEER_IDENTITY is not set — this verb is an agent self-call from inside a session\n')
          return 1
        }
        const addr = parseSessionName(identity)
        if (!addr) {
          errOut(`self-fresh: invalid PEER_IDENTITY "${identity}" — expected <runtime>-<personality>\n`)
          return 1
        }
        const cfg = loadLifecycleConfig(env)
        // Mark FIRST, kill SECOND: if the kill races ahead of the mark the daemon would
        // see a dead session with no .new-eager → a plain reaped-gone (lazy fresh on the
        // next message), not the eager relaunch — degrade gracefully, never lose the mark.
        setNewEager(cfg, identity)
        out(`self-fresh: marked ${identity} for eager fresh re-launch; self-killing session\n`)
        const sock = buildSocketPath(addr.runtime, addr.personality, cfg.sockDir)
        killSession(sock, identity, env)
        return 0
      }
      case 'interrupt': {
        // In-session control (Ф-E, clean-slash namespace): interrupt a stuck/raving
        // turn (Escape). UNCONDITIONAL — acts on the live session.
        if (!positionals[0]) return argErr(errOut, 'interrupt needs a peer name — usage: iapeer interrupt <peer> [runtime]')
        const r = await routeControl(positionals[0], positionals[1], { name: verb })
        if (!r.ok) {
          errOut(`${verb}: ${r.error.message}\n`)
          return 1
        }
        out(`${verb} → ${r.value.controlled.personality} (${r.value.controlled.runtime})\n`)
        return 0
      }
      case 'compact': {
        // Dialogue control: if the session is merely asleep
        // after a clean idle-reap, resume the same dialogue and compact it; if there
        // is no resumable dialogue, fail honestly instead of compacting a fresh one.
        if (!positionals[0]) return argErr(errOut, 'compact needs a peer name — usage: iapeer compact <peer> [runtime]')
        const o = await compactPeer(positionals[0], positionals[1], { env })
        if (o.action === 'compacted') {
          out(`compact → ${o.personality} (${o.runtime})${o.woke ? ' after resume' : ''}\n`)
          return 0
        }
        errOut(`compact: ${o.personality} (${o.runtime}): ${o.action}${o.reason ? ` — ${o.reason}` : ''}\n`)
        return 1
      }
      case 'connect': {
        // Per-peer channel attachment in ONE flow (design «Onboard костяка» §(в)):
        // `connect telegram <peer> [--token <t>]`. The human owes only the token;
        // alias/bot-add/interface/router-restart are resolved by the system. The
        // FIRST message from the human to the bot activates the chat (platform rule).
        if (positionals[0] !== 'telegram' || !positionals[1]) return argErr(errOut, 'connect needs "telegram <peer>" — usage: iapeer connect telegram <peer> [--token <t>] (e.g. iapeer connect telegram boris)')
        return await connectTelegramVerb(positionals[1], typeof flags.token === 'string' ? flags.token : undefined, env, out, errOut)
      }
      case 'enable': {
        // DISCOVERABILITY ALIAS: `enable telegram <peer>` → `connect telegram <peer>`
        // (a layperson reaches for "enable telegram"; telegram is a CHANNEL, not a
        // marketplace plugin, so it routes to the connect flow, NOT enableCapability).
        if (positionals[0] === 'telegram') {
          if (!positionals[1]) return argErr(errOut, 'enable telegram needs a peer — usage: iapeer enable telegram <peer> [--token <t>] (alias of `iapeer connect telegram <peer>`)')
          return await connectTelegramVerb(positionals[1], typeof flags.token === 'string' ? flags.token : undefined, env, out, errOut)
        }
        // Per-peer capability install (contract Установка §3): install <plugin>@agfpd
        // per-runtime (claude project-scope IN the peer cwd / codex global) + enable +
        // call the plugin's `setup` ONLY if its iapeer.json declares it. Idempotent and
        // fleet-safe — claude is keyed by the peer's projectPath. `enable <plugin> [peer]`.
        if (!positionals[0]) return argErr(errOut, 'enable needs a capability/plugin — usage: iapeer enable <plugin> [peer]')
        const { enableCapability } = await import('../enable/index.ts')
        const r = enableCapability({
          plugin: positionals[0],
          peer: positionals[1],
          noSetup: flags['no-setup'] === true,
          env,
        })
        for (const rt of r.runtimes) {
          out(`  ${rt.runtime}: ${rt.state}${rt.detail ? ` — ${rt.detail}` : ''}\n`)
        }
        out(`enable ${r.plugin} @ ${r.personality}: setup ${r.setup}${r.setupDetail ? ` — ${r.setupDetail}` : ''}\n`)
        return r.runtimes.some(rt => rt.state === 'failed') || r.setup === 'failed' ? 1 : 0
      }
      case 'attach': {
        if (!positionals[0]) return argErr(errOut, 'attach needs a peer name — usage: iapeer attach <peer> [runtime]')
        const r = await attachPeer({ personality: positionals[0], runtime: positionals[1], env })
        if (!r.ok) {
          errOut(`attach: ${r.reason}\n`)
          return 1
        }
        out(`${r.woke ? 'woke + ' : ''}attaching ${r.identity}…\n`)
        const attachCfg = loadLifecycleConfig(env)
        return await attachIntoSession(r.identity, r.socketPath, env, attachCfg.eventLogDir, r.woke)
      }
      case 'supervisor': {
        // DARK (cutover Block 2): the detach-persistent pty-supervisor (PoC pts.mjs port). NOT
        // wired into delivery/launch — it serves NOTHING on the live fleet; it is validated on
        // throwaway `tick` sessions. The dynamic import keeps @xterm OUT of the daemon hot path
        // (the daemon never loads this). Sub-commands: up|start|attach|list|kill|daemon.
        const { runSupervisorCli } = await import('../supervisor/index.ts')
        return await runSupervisorCli(rest)
      }
      case 'tray': {
        // Ф1 of iapeer-tray — the SwiftBar fleet dashboard, an EXTERNAL fleet-API
        // client (docs/15). Subcommands: render[--stream] · cmd · install · uninstall
        // · status. The plugin file is a shim that execs `tray render --stream`; all
        // rendering/streaming lives here (tested TS), the .sh carries only metadata.
        const tray = await import('../tray/index.ts')
        const sub = positionals[0]
        switch (sub) {
          case 'render': {
            if (flags.stream === true) {
              await tray.streamTray(env) // SwiftBar streamable loop — runs until the process is killed
              return 0
            }
            out(await tray.renderTrayOnce(env))
            return 0
          }
          case 'attach-term': {
            // Terminal handoff for a tray click: open a system Terminal running
            // `iapeer attach <peer>` via an `open`ed `.command` (no Accessibility/
            // Automation TCC — unlike SwiftBar's own terminal=true).
            const peer = positionals[1]
            if (!peer) return argErr(errOut, 'usage: iapeer tray attach-term <peer> [runtime]')
            try {
              const r = tray.trayAttachTerm({ env, personality: peer, runtime: positionals[2] })
              out(`opening Terminal → iapeer attach ${peer} (${r.cmdFile})\n`)
            } catch (e) {
              errOut(`tray attach-term: ${e instanceof Error ? e.message : String(e)}\n`)
              return 1
            }
            return 0
          }
          case 'cmd': {
            const command = positionals[1]
            const peer = positionals[2]
            const runtime = positionals[3]
            if (!command || !peer) {
              return argErr(errOut, 'usage: iapeer tray cmd <wake|stop|start|new|refresh|interrupt|compact> <peer> [runtime]')
            }
            let r: Awaited<ReturnType<typeof tray.trayCmd>>
            try {
              r = await tray.trayCmd(env, command, peer, runtime)
            } catch (e) {
              errOut(`tray cmd: ${e instanceof Error ? e.message : String(e)}\n`)
              return 1
            }
            out(`${JSON.stringify(r.body)}\n`)
            return r.ok ? 0 : 1
          }
          case 'approve':
          case 'deny': {
            // Tray click → resolve a pending approval over the unix-first fleet client (docs/17). The
            // menu Allow/Deny items run these; the broker resolution is seen by every channel.
            const id = positionals[1]
            if (!id) return argErr(errOut, `usage: iapeer tray ${sub} <approval-id> [reason]`)
            const reason = sub === 'deny' ? positionals.slice(2).join(' ') || undefined : undefined
            let r: Awaited<ReturnType<typeof tray.trayResolveApproval>>
            try {
              r = await tray.trayResolveApproval(env, sub, id, reason)
            } catch (e) {
              errOut(`tray ${sub}: ${e instanceof Error ? e.message : String(e)}\n`)
              return 1
            }
            out(`${JSON.stringify(r.body)}\n`)
            return r.ok ? 0 : 1
          }
          case 'install': {
            // Explicit activation verb: installs SwiftBar.app when absent
            // (owner-sanctioned) + launches, unless --plugin-only (file only).
            const pluginOnly = flags['plugin-only'] === true
            const r = tray.installTray({ env, installApp: !pluginOnly, launch: !pluginOnly })
            out(
              `tray plugin ${r.wrote ? 'written' : 'unchanged'}: ${r.pluginFile}\n` +
                `  plugin dir: ${r.pluginDir} (${r.dir})\n` +
                `  SwiftBar: ${r.app}${r.appReason ? ` — ${r.appReason}` : ''}\n` +
                (r.launched ? '  launched + refreshed SwiftBar\n' : '') +
                (r.app === 'absent' || r.app === 'install-failed'
                  ? '  (SwiftBar not active — run `iapeer tray install` to install it, then it appears in the menu bar)\n'
                  : ''),
            )
            return 0
          }
          case 'uninstall': {
            const r = tray.uninstallTray({ env, launch: true })
            out(
              (r.removed.length ? `removed:\n${r.removed.map(f => `  ${f}`).join('\n')}\n` : 'no tray plugin file found\n') +
                (r.refreshed ? '  refreshed SwiftBar\n' : '') +
                '  fleet untouched (daemon / TUI / delivery unaffected)\n',
            )
            return 0
          }
          case 'status': {
            const s = tray.trayStatus({ env })
            out(
              `daemon fleet API: ${s.daemon.fleet ? `up (v${s.daemon.version ?? '?'})` : 'DOWN / no fleet:1'}\n` +
                `  sock: ${s.daemon.sock ?? '—'}\n` +
                `  tcp:  ${s.daemon.tcp ?? '—'}\n` +
                `SwiftBar: ${s.swiftbar.installed ? `installed (plugin dir: ${s.swiftbar.pluginDir ?? 'unset'})` : 'not installed'}\n` +
                `plugin: ${s.plugin.installed ? s.plugin.path : 'not installed'}\n`,
            )
            return 0
          }
          default:
            return argErr(
              errOut,
              'usage: iapeer tray <render [--stream] | cmd <command> <peer> [runtime] | install [--plugin-only] | uninstall | status>',
            )
        }
      }
      case 'approval-hook': {
        // (runtime-installed, docs/17) the PreToolUse bridge: stdin = the runtime's hook JSON,
        // stdout = the decision JSON (EXACTLY — the runtime parses it), blocking on the broker.
        // Never run by hand. Fail-safe: any error prints a DENY (expressed in JSON, exit 0).
        const { runApprovalHook } = await import('../approval/hook.ts')
        const stdin = await Bun.stdin.text()
        const r = await runApprovalHook(stdin, { env })
        if (r.stdout) out(`${r.stdout}\n`)
        if (r.stderr) errOut(`${r.stderr}\n`)
        return r.exitCode
      }
      case 'approvals': {
        const { approvalsList } = await import('../approval/cli.ts')
        const r = await approvalsList(flags.json === true, env)
        out(r.text)
        return r.code
      }
      case 'approve':
      case 'deny': {
        const id = positionals[0]
        if (!id) return argErr(errOut, `${verb} needs an id — usage: iapeer ${verb} <id>${verb === 'deny' ? ' [reason]' : ''} (list: iapeer approvals)`)
        const { resolveApproval } = await import('../approval/cli.ts')
        const reason = verb === 'deny' ? positionals.slice(1).join(' ') || undefined : undefined
        const approver = typeof flags.approver === 'string' ? flags.approver : undefined
        const r = await resolveApproval(id, verb, { reason, approver }, env)
        out(r.text)
        return r.code
      }
      case 'approval-mode': {
        const peer = positionals[0]
        if (!peer) return argErr(errOut, 'approval-mode needs a peer — usage: iapeer approval-mode <peer> [gated|yolo] [--now]')
        const modeArg = positionals[1]
        if (modeArg && modeArg !== 'gated' && modeArg !== 'yolo') return argErr(errOut, 'approval-mode: mode must be gated | yolo (omit to read the current mode)')
        const { approvalModeCli } = await import('../approval/cli.ts')
        const r = approvalModeCli(peer, modeArg as 'gated' | 'yolo' | undefined, env)
        out(r.text)
        if (r.code === 0 && modeArg && flags.now === true) {
          const o = await newPeer(peer, undefined, { env })
          out(`applied now: fresh session (${o.action})\n`)
        }
        return r.code
      }
      default: {
        // `iapeer <runtime>` (launch) — folder-launch the cwd's peer, ALWAYS fresh. On a TTY this is
        // the human "start a fresh session and work in it" verb (parallel to `attach`, which resumes):
        // after a successful fresh bring-up it drops the operator straight into the new session.
        // Non-TTY (scripted / piped) keeps the fire-and-forget behavior — report the launch and exit.
        if (verb && isRuntime(verb)) {
          const cfg = loadLifecycleConfig(env)
          const id = resolveIdentity({ env })
          const r = await folderLaunch({ cwd: process.cwd(), runtime: verb, env, cfg })
          if (r.status === 'FAILED') {
            // A bare token format-matches a runtime, so it dispatched here as `iapeer
            // <runtime>` (launch the cwd peer on that runtime). When that fails, the user
            // most often just MISTYPED a command — surface BOTH readings so the message is
            // actionable instead of a bare "runtime not declared" (FU13).
            errOut(
              `iapeer: "${verb}" — ${r.reason}\n` +
                '  If you meant a command, run `iapeer help`. `iapeer <runtime>` launches a runtime declared for the current peer.\n',
            )
            return 1
          }
          const identity = r.process_address ?? buildProcessAddress(verb, id.personality)
          if (process.stdin.isTTY && process.stdout.isTTY) {
            const socketPath = buildSocketPath(verb, id.personality, cfg.sockDir)
            out(`launched ${identity} (fresh) — attaching…\n`)
            return await attachIntoSession(identity, socketPath, env, cfg.eventLogDir, true)
          }
          out(`launched ${identity} (fresh)\n`)
          return 0
        }
        errOut(`iapeer: unknown verb "${verb ?? ''}"\n`)
        return usage(errOut)
      }
    }
  } catch (e) {
    errOut(`iapeer ${verb ?? ''}: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

function usage(errOut: (s: string) => void): number {
  errOut(renderUsage())
  return 2
}

/** A TARGETED argument error (FU13): a one-line, addressed, actionable reason for THIS
 *  verb — never the generic top-level help wall (which reads as "nothing happened" to a
 *  user who just mistyped one verb). `message` should name what's missing + the verb's
 *  own form, e.g. "connect telegram needs a peer — usage: iapeer connect telegram <peer>". */
function argErr(errOut: (s: string) => void, message: string): number {
  errOut(`iapeer: ${message}\n`)
  return 2
}

/** Interactive default-runtime picker (FU5) — only called on a real TTY when more
 *  than one agentic runtime is installed and no `--runtime` was given. Accepts a
 *  number or the runtime name; empty input takes the first (the listed default). */
async function promptDefaultRuntime(installed: Runtime[]): Promise<Runtime> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    process.stdout.write('More than one agent runtime is installed. Which should this peer default to?\n')
    installed.forEach((rt, i) => process.stdout.write(`  [${i + 1}] ${rt}\n`))
    for (;;) {
      const ans = (await rl.question(`Choose [1-${installed.length}] (default 1): `)).trim().toLowerCase()
      if (ans === '') return installed[0]!
      const n = Number(ans)
      if (Number.isInteger(n) && n >= 1 && n <= installed.length) return installed[n - 1]!
      const byName = installed.find(rt => rt === ans)
      if (byName) return byName
      process.stdout.write(`Please enter a number 1-${installed.length} or a runtime name (${installed.join(' / ')}).\n`)
    }
  } finally {
    rl.close()
  }
}

/** Default --from for `send`: the identity of the peer in the current cwd (contract:
 *  "по умолчанию — identity пира текущей папки"). Requires running from a peer cwd. */
function defaultFromIdentity(env: NodeJS.ProcessEnv): string {
  return resolveIdentity({ env }).address
}

/** Drop the operator into a live peer session — the interactive open shared by `attach` (resume)
 *  and a TTY `iapeer <runtime>` (fresh launch). pty-only: the operator is handed to the supervisor
 *  client (raw passthrough + repaint-on-attach + Ctrl-] detach). The operator window is bracketed in
 *  lifecycle.log (ev=attach … ev=attach-end) so a death timestamp inside the window reads directly off
 *  the log. Returns the client exit code. (`_socketPath` retained for call-site compatibility.) */
async function attachIntoSession(
  identity: string,
  _socketPath: string,
  env: NodeJS.ProcessEnv,
  eventLogDir: string,
  woke: boolean,
): Promise<number> {
  appendLifecycleEvent(eventLogDir, { ev: 'attach', identity, woke: String(woke) }, { env })
  // runSupervisorClient calls process.exit on every terminal path → bracket attach-end via an exit
  // hook (appendFileSync is signal/exit-safe).
  process.on('exit', () =>
    appendLifecycleEvent(eventLogDir, { ev: 'attach-end', identity, rc: process.exitCode ?? 0 }, { env }),
  )
  await runSupervisorClient(hostRunDir(), identity)
  return 0 // unreachable — runSupervisorClient exits on detach / session end
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then(code => process.exit(code))
}
