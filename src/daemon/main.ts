// Production daemon main — THE composition point. The library `startDaemon`
// (daemon/index.ts) is transport-only (route / deliver / liveness) and takes the
// lifecycle primitives as INJECTED hooks; this module wires them:
//   • wake-on-miss  → lifecycle.wakeOrSpawn (a send to a dead, non-launchd peer
//     spawns it and delivers the envelope as its boot first-message). H4 (never
//     wake a launchd-managed peer) lives INSIDE wakeOrSpawn.
//   • supervise     → a timer running lifecycle.superviseTick (idle-reap /
//     zombie-sweep), H4-guarded per session inside.
// This is where Ф1 (transport) meets Ф2 (lifecycle). It also installs the daemon's
// OWN always-on launchd plist (label com.agfpd.iapeer — a SEPARATE namespace from
// the com.iapeer.* peer fleet, so it never collides with persistent-peer plists).
//
// The CLI at the bottom is the launchd-held process (`bun main.ts`) and the
// foreground entrypoint for acceptance. Installing the plist is a SEPARATE explicit
// action (`--install-plist`); it writes the file but does NOT load it — a live
// `launchctl bootstrap` stays a deliberate operator step.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { DAEMON_PLIST_LABEL } from '../core/constants.ts'
import { IapError } from '../core/errors.ts'
import { pluginLogsDir } from '../storage/index.ts'
import {
  bootstrapDaemon,
  isFoundationOwnedPlist,
  launchAgentsDir,
  renderLaunchdPlist,
} from '../launch/launchd.ts'
import type { BootstrapState, LaunchdPlistSpec } from '../launch/launchd.ts'
import { waitForDaemonHealthy } from '../update/index.ts'
import {
  drainAllEphemeralQueues,
  drainEphemeralQueue,
  enqueueEphemeralTask,
  isEphemeralPeer,
  isLaunchdManaged,
  addTopic,
  loadLifecycleConfig,
  processEagerRelaunches,
  processOrphanEagerMarks,
  readTopic,
  resolveWakeRuntime,
  setEphemeralArmed,
  setLastDelivered,
  superviseTick,
  wakeOrSpawn,
  type LifecycleConfig,
} from '../lifecycle/index.ts'
import { appendLifecycleEvent } from '../lifecycle/eventlog.ts'
import { buildProcessAddress } from '../core/socket.ts'
import { err, ok } from '../core/errors.ts'
import { resolveCallerIdentity } from '../identity/index.ts'
import type { ResolvedCaller } from '../identity/index.ts'
import { findPeer, readPeersIndex } from '../registry/index.ts'
import {
  createComposerDeliveryQueue,
  routeSend,
  type ComposerQueueRouteDeps,
  type ComposerQueuedDelivery,
  type EphemeralRouteDeps,
  type WakeFn,
  type WakeOutcome,
  type WakeRequest,
} from '../transport/index.ts'
import { iapeerBinPath } from '../install/index.ts'
import { appendDeliveryEvent } from './deliverylog.ts'
import { buildFleetHandler } from './fleet.ts'
import { NoticeBoard } from './notices.ts'
import { startMuteWatch } from './mutewatch.ts'
import { defaultDaemonSocketPath, startDaemon, type DaemonHandle } from './index.ts'

/** Default TCP loopback port for the always-on router. Real http MCP clients
 *  (claude/codex `--transport http <url>`) bind to a fixed URL, so production needs
 *  a STABLE port, not an ephemeral one. Override with IAPEER_PORT. */
export const DEFAULT_DAEMON_PORT = 8765

/** Parse IAPEER_PORT STRICTLY (В29). `Number('abc')` = NaN passes `?? DEFAULT` (NaN is not nullish) →
 *  listen(NaN) binds an EPHEMERAL port while the fleet's .mcp.json points at the fixed 8765 → the whole
 *  TCP-MCP surface is silently offline yet the daemon reads "healthy" (health probes only the unix
 *  socket). Unset/empty → the default; anything not an integer in 1–65535 → a LOUD warn + the default. */
export function parseDaemonPort(raw: string | undefined, dflt: number = DEFAULT_DAEMON_PORT): number {
  const t = raw?.trim()
  if (!t) return dflt
  const n = Number(t)
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n
  process.stderr.write(`[iapeer-daemon] WARN invalid IAPEER_PORT=${JSON.stringify(raw)} — falling back to ${dflt}\n`)
  return dflt
}

/** Default supervise-tick cadence (idle-reap / zombie-sweep). idleSecs (1h default)
 *  is the reap threshold; this is just how often the timer checks. */
export const DEFAULT_SUPERVISE_INTERVAL_MS = 60_000

/** Mute-watch cadence (docs/19) — how often the daemon sweeps the runtimes' session files
 *  for a structural API error that left a peer unable to answer. Its OWN timer rather than a
 *  ride on the 60 s supervise tick: detection latency IS the product here (the owner must
 *  learn within a minute), and a 60 s sweep puts the worst case AT the budget with nothing
 *  to spare. The sweep is cheap — it stats only files that CHANGED since the last pass. */
export const DEFAULT_MUTEWATCH_INTERVAL_MS = 20_000

// This module's own path — the launchd plist runs `bun <this>` as the daemon.
const DAEMON_MAIN_PATH = fileURLToPath(import.meta.url)

// ─────────────────────────────────────────────────────────────────────────────
// Composition: wire startDaemon ⇆ lifecycle (wake + supervise)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Adapt the transport WakeFn contract to lifecycle.wakeOrSpawn. The two shapes are
 * structurally identical (WakeRequest ⊆ WakeArgs, WakeResult ⊆ WakeOutcome); this
 * is the one place transport's injected-wake meets the lifecycle implementation.
 */
export function makeWakeFn(cfg: LifecycleConfig, env: NodeJS.ProcessEnv): WakeFn {
  return (req: WakeRequest): Promise<WakeOutcome> =>
    wakeOrSpawn(
      { personality: req.personality, runtime: req.runtime, topic: req.topic, task: req.task },
      { cfg, env },
    )
}

/**
 * wake_policy:ephemeral M2 — the arm-on-outbound composition (the ONE place the
 * daemon's onDelivered seam meets lifecycle, like makeWakeFn for wake). An
 * ephemeral worker sends exactly ONE outbound — its final reply (ADR-006: no
 * intermediate send_to_peer) — so "this caller's send was delivered ok" ⇒ the
 * task is answered ⇒ arm the quiet-reap marker for the caller's identity.
 * Non-ephemeral callers (the profile read keys on the caller's registry cwd) are
 * a no-op, so the hook is safe to run on EVERY delivery. Best-effort: an arm
 * failure must never fail the already-succeeded delivery (superviseTick's idle
 * bound still reaps an unarmed worker eventually).
 */
export function makeArmEphemeralOnDelivered(cfg: LifecycleConfig): (caller: ResolvedCaller) => void {
  return caller => {
    try {
      if (caller.cwd && isEphemeralPeer(caller.cwd)) setEphemeralArmed(cfg, caller.address)
    } catch {
      /* arming is best-effort */
    }
  }
}

/**
 * The fourth lifecycle⇆transport seam (after makeWakeFn / makeArmEphemeralOnDelivered /
 * makeEphemeralRouteDeps): record a LIVE-delivered topic as the target identity's
 * `.topic` marker, so the marker tracks the topic the session LAST WORKED ON — the
 * semantics resolveWakeMode's executor discriminator actually wants — not merely the
 * topic it woke with. Defect: an executor could wake topicless, work a delivered
 * topic for a session, be stop-parked clean, and a later topic-matching resume-wake
 * compared against the STALE wake-time marker → cause=idle-reaped-new-topic → FRESH;
 * the session's context was lost despite the clean park.
 * Same-topic deliveries are a no-op (no marker churn, no log spam) — the lifecycle.log
 * line `ev=topic-note` therefore marks exactly the moments the session's working
 * topic SHIFTED, which is what a fresh-vs-resume postmortem needs. Best-effort: a
 * marker/log failure never fails the already-delivered message.
 */
export function makeNoteLiveTopic(
  cfg: LifecycleConfig,
  env: NodeJS.ProcessEnv = process.env,
): (identity: string, topic: string) => void {
  return (identity, topic) => {
    try {
      if (readTopic(cfg, identity) === topic) return // unchanged most-recent → no shift, skip the note
      addTopic(cfg, identity, topic) // accumulate into the session's topic set (a new live thread)
      appendLifecycleEvent(cfg.eventLogDir, { ev: 'topic-note', identity, topic }, { env })
    } catch {
      /* the marker is a discriminator hint — never fail a delivered message */
    }
  }
}

/**
 * wake_policy:"ephemeral" M3 — the serial-queue delivery composition (the third
 * lifecycle⇆transport seam after makeWakeFn / makeArmEphemeralOnDelivered).
 * deliver = enqueue (exclusive-create FIFO) → fast `{queued:true, qd}` ack →
 * ASYNC drain kick (deliberately not awaited: the wake takes ~30-60s and the
 * sender's substantive answer is the worker's own reply — FaaS, ADR-006). A
 * failed kick is not a lost task: the supervise-tick drain scan retries every
 * non-empty queue without a live session. An enqueue FAILURE is a delivery
 * error (fail-loud) — a task that did not reach disk must never be acked queued.
 * `kick` is injectable for tests; default drains the real queue.
 */
export function makeEphemeralRouteDeps(
  cfg: LifecycleConfig,
  env: NodeJS.ProcessEnv,
  kick: (personality: string, runtime: Parameters<typeof drainEphemeralQueue>[2]) => void = (p, rt) => {
    void drainEphemeralQueue(cfg, p, rt, { env }).catch(() => {})
  },
): EphemeralRouteDeps {
  return {
    isEphemeral: cwd => isEphemeralPeer(cwd),
    deliver: async ({ peer, envelope, topic, runtime, sentAt }) => {
      const rt = resolveWakeRuntime(runtime, peer)
      if (!rt.ok) return rt
      const identity = buildProcessAddress(rt.value, peer.personality)
      let depth: number
      try {
        depth = enqueueEphemeralTask(cfg, identity, { task: envelope, topic })
      } catch (e) {
        return err(
          `ephemeral enqueue failed for "${peer.personality}": ${e instanceof Error ? e.message : String(e)}; message NOT queued`,
        )
      }
      kick(peer.personality, rt.value)
      return ok({
        ok: true as const,
        delivered_to: { personality: peer.personality, runtime: rt.value },
        woke: false,
        queued: true,
        queuedBy: 'ephemeral',
        queueDepth: depth,
        ts: sentAt ?? new Date().toISOString(),
      })
    },
  }
}

function queuedFailureMessage(job: ComposerQueuedDelivery, reason: string): string {
  const topic = job.topic ? ` topic="${job.topic}"` : ''
  return (
    `delivery failed: queued message to ${job.target.personality} (${job.target.runtime})${topic} was not delivered.\n` +
    `reason: ${reason}\n` +
    'The original send was accepted as queued because a human operator was typing in the target composer; retry if still needed.'
  )
}

/**
 * Busy-human-composer queue composition. This is deliberately daemon-owned and
 * in-memory: it exists only to bridge a short operator-editing window. Because a
 * queued ack is not a delivery fact, the queue has two extra responsibilities:
 *   1) after actual drain success, run the same post-delivery hooks as the
 *      synchronous path (topic marker + ephemeral caller arm);
 *   2) before daemon shutdown/restart, fail every pending queued envelope back
 *      to its sender, so `queued` never becomes silent loss.
 */
export function makeComposerQueueRouteDeps(cfg: LifecycleConfig, env: NodeJS.ProcessEnv): ComposerQueueRouteDeps {
  const noteLiveTopic = makeNoteLiveTopic(cfg, env)
  const onDelivered = makeArmEphemeralOnDelivered(cfg)
  // NB: no `wake` here — the composer-queue failure outlet (notifyFailed) deliberately does NOT wake an
  // offline sender (В30); it fires on failAll during shutdown/update.
  const ephemeral = makeEphemeralRouteDeps(cfg, env)

  return createComposerDeliveryQueue({
    env,
    // Spawn-flip Ф0b-3 slice 3c: the HOSTED occupancy default reads <logDir>/<identity>.log — the SAME
    // dir the wake→launch path writes warm-peer pane-logs to (cfg.logDir), shared with the ready-gate
    // flip + the shadow observer. tmux targets ignore it.
    logDir: cfg.logDir,
    noteLiveTopic,
    noteDelivered: identity => setLastDelivered(cfg, identity),
    onDelivered,
    notifyFailed: async (job, reason) => {
      const index = readPeersIndex({ env })
      const self = findPeer(index, 'iapeer')
      if (!self) {
        appendDeliveryEvent(cfg.eventLogDir, {
          ev: 'composer-queue-failed-notify',
          caller: 'iapeer',
          to: job.caller.personality,
          rt: job.caller.runtime,
          ok: 'false',
          err: 'foundation peer "iapeer" is not registered; cannot notify queued sender',
        })
        return
      }
      const sender = resolveCallerIdentity({ personality: 'iapeer', runtime: self.runtime }, index)
      // SELF-NOTIFY GUARD: the failure outlet sends FROM the foundation peer (iapeer). When the QUEUED
      // sender IS the foundation peer on the same runtime (e.g. iapeer itself queued a cross-runtime send to
      // its codex twin and that queue later failed), this notify would be iapeer→iapeer — a genuine
      // self-send the address-based router correctly refuses with 'cannot send to self', logging ok=false
      // and tripping monitoring alarms. The notification is moot anyway (the sender IS the one being
      // notified about its own send). Skip it and log a benign skip instead of attempting a self-send.
      if (`${job.caller.runtime}-${job.caller.personality}` === sender.address) {
        appendDeliveryEvent(cfg.eventLogDir, {
          ev: 'composer-queue-failed-notify',
          caller: sender.address,
          to: job.caller.personality,
          rt: job.caller.runtime,
          ok: 'true',
          err: 'skipped self-notify (queued sender is the foundation peer itself)',
          topic: job.topic ?? 'delivery-failed',
        })
        return
      }
      const result = await routeSend(
        sender,
        {
          personality: job.caller.personality,
          runtime: job.caller.runtime,
          message: queuedFailureMessage(job, reason),
          topic: job.topic ?? 'delivery-failed',
        },
        // Do not pass composerQueue here: this path is the queue's failure outlet
        // (including SIGTERM/update). Recursively queueing a failure notification
        // could turn shutdown re-fail into another queued item.
        // В30 — NO wake dep either: this outlet fires on failAll (SIGTERM/update). Waking an offline
        // sender to notify it takes 30-60s (ready-gate), blowing past launchd's ExitTimeOut → SIGKILL
        // drops the remaining notifications (the very silent loss failAll exists to prevent) and stalls
        // the restart. An ephemeral sender still gets a DURABLE-queued notification (ephemeral dep); a
        // non-ephemeral offline sender degrades to a delivery.log record (best-effort) — never a wake.
        { ephemeral, noteLiveTopic },
      )
      appendDeliveryEvent(cfg.eventLogDir, {
        ev: 'composer-queue-failed-notify',
        caller: sender.address,
        to: job.caller.personality,
        rt: job.caller.runtime,
        ok: String(result.ok),
        via: result.ok ? `${result.value.delivered_to.runtime}-${result.value.delivered_to.personality}` : undefined,
        woke: result.ok ? String(result.value.woke) : undefined,
        queued: result.ok && result.value.queued ? 'true' : undefined,
        qkind: result.ok ? result.value.queuedBy : undefined,
        qd: result.ok ? result.value.queueDepth : undefined,
        topic: job.topic ?? 'delivery-failed',
        err: result.ok ? undefined : result.error.message,
      })
    },
  })
}

export interface ConfiguredDaemonOptions {
  /** TCP loopback port (default DEFAULT_DAEMON_PORT). */
  port?: number
  host?: string
  /** Unix-socket path (H8 same-uid base; default: defaultDaemonSocketPath). */
  socketPath?: string
  /** H8 bearer token; falls back to env.IAPEER_BEARER_TOKEN. Off when neither set. */
  bearerToken?: string
  superviseIntervalMs?: number
  /** Mute-watch sweep cadence (default DEFAULT_MUTEWATCH_INTERVAL_MS). */
  muteWatchIntervalMs?: number
  /** Write the router.json discovery file (default true for production). */
  discovery?: boolean
  rootDir?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Start the fully-composed production daemon: the router (startDaemon) wired to
 * wake-on-miss (wakeOrSpawn) and the supervise timer (superviseTick). DUAL-LISTEN
 * by default — a 0600 unix socket (local same-uid callers: notifier/telegram/CLI)
 * AND TCP loopback (real http MCP agent clients), both over one MCP handler — and
 * the router.json discovery file written for daemon-aware `iap send`. The bearer
 * layer (H8) engages only when a token is configured.
 */
export async function startConfiguredDaemon(opts: ConfiguredDaemonOptions = {}): Promise<DaemonHandle> {
  const env = opts.env ?? process.env
  const cfg = loadLifecycleConfig(env)
  const bearerToken = opts.bearerToken ?? (env.IAPEER_BEARER_TOKEN?.trim() || undefined)
  const noteLiveTopic = makeNoteLiveTopic(cfg, env)
  const armEphemeralOnDelivered = makeArmEphemeralOnDelivered(cfg)
  const ephemeral = makeEphemeralRouteDeps(cfg, env)
  const composerQueue = makeComposerQueueRouteDeps(cfg, env)
  // Notice board (docs/19) — ONE instance shared by the mute-watch (raises) and the
  // fleet handler (serves /notices + the snapshot field). Constructed HERE, at the
  // composition point, because that sharing is the whole wiring.
  const board = new NoticeBoard({ logDir: cfg.eventLogDir, env })
  const stopMuteWatch = startMuteWatch(cfg, board, {
    env,
    intervalMs: opts.muteWatchIntervalMs ?? DEFAULT_MUTEWATCH_INTERVAL_MS,
    // Same stance as the supervise tick's onError: a detector throw must be VISIBLE, not
    // swallowed into a silently-dead watch — the exact failure mode this feature exists to
    // end. Best-effort; a reporter must never fail the daemon.
    onError: (err: unknown) => {
      try {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
        appendLifecycleEvent(cfg.eventLogDir, { ev: 'mutewatch-error', error: detail.replace(/\s+/g, ' ').slice(0, 600) }, { env })
      } catch { /* best-effort */ }
    },
  })
  const handle = await startDaemon({
    wake: makeWakeFn(cfg, env),
    // M2 arm-on-outbound (see makeArmEphemeralOnDelivered): ephemeral caller's ok
    // send ⇒ armed for the supervise quiet-reap. No-op for every other caller.
    onDelivered: armEphemeralOnDelivered,
    // M3 serial queue (see makeEphemeralRouteDeps): ephemeral TARGET ⇒ enqueue +
    // async drain. No-op for every other target.
    ephemeral,
    // Live-delivered topic → the target's .topic marker (see makeNoteLiveTopic):
    // the wake resolver's executor discriminator then compares against the topic
    // the session last WORKED ON, not the one it woke with.
    noteLiveTopic,
    // В7 — a confirmed live delivery floors the target's idle proxy (setLastDelivered), so a
    // just-delivered message is never reaped away before its turn record lands.
    noteDelivered: identity => setLastDelivered(cfg, identity),
    // Busy-human-composer queue: fast queued ack, async drain, fail all pending
    // on daemon close/update so a queued envelope is never silently lost.
    composerQueue,
    // H4 launchd-revive delivery retry (see RouteDeps.isLaunchdManaged): a MISS on a
    // launchd-managed target (the daemon can't wake it, but KeepAlive revives it) → retry-
    // resolve for a bounded window instead of failing in ~16ms — bridges a router restart.
    isLaunchdManaged: (personality: string) => isLaunchdManaged(personality, env),
    // Fleet-API (Ф0 iapeer-tray): the operator-client surface /fleet/v1/* — snapshot
    // (the same listPeers truth as `iapeer list`), SSE events (tail of the durable
    // logs), commands over the existing verb functions. Same listeners, same bearer
    // gate; advertised in router.json as fleet:1. Contract: docs/15-fleet-api.md.
    fleet: buildFleetHandler({ env, board }),
    supervise: {
      intervalMs: opts.superviseIntervalMs ?? DEFAULT_SUPERVISE_INTERVAL_MS,
      // idle-reap / zombie-sweep, THEN the eager fresh re-launch for any peer whose
      // session died carrying a .new-eager mark (owner /new; async, best-effort).
      // The DURABLE decision trace (which peer, what outcome, when, why) is emitted
      // INSIDE superviseTick (lifecycle/eventlog.ts → logs/iapeer/lifecycle.log), so
      // every reap is recorded regardless of entry point (this timer AND the heal-at-
      // wake superviseTick inside wakeOrSpawn). The outcomes array drives only the
      // eager relaunch here; the trace does not depend on consuming it.
      tick: async () => {
        const outcomes = superviseTick(cfg, { env })
        await processEagerRelaunches(cfg, outcomes, { env })
        // Orphaned-eager fallback: a .new-eager whose session died WITHOUT a .session
        // on disk is invisible to superviseTick — relaunch it fresh here (H4-guarded;
        // live incident 03.07: a self-fresh peer lay down until the owner attached).
        await processOrphanEagerMarks(cfg, { env })
        // M3 drain scan — ONE mechanism for the whole serial-queue loop: feeds the
        // next task right after a reaped-ephemeral (same tick), drains on daemon
        // start (durable queue), and RETRIES a failed wake (the item stayed at the
        // head). Identities without a queue or with a live session are no-ops.
        await drainAllEphemeralQueues(cfg, { env })
      },
      // Surface a supervise-tick throw that the daemon timer would otherwise SWALLOW (the class that
      // hid a stuck reaper for hours): record ev=supervise-error in lifecycle.log, flattened to one
      // logfmt line. Best-effort — a reporter must never fail the daemon.
      onError: (err: unknown) => {
        try {
          const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
          appendLifecycleEvent(cfg.eventLogDir, { ev: 'supervise-error', error: detail.replace(/\s+/g, ' ').slice(0, 600) }, { env })
        } catch { /* best-effort */ }
      },
    },
    bearerToken,
    port: opts.port ?? DEFAULT_DAEMON_PORT,
    host: opts.host ?? '127.0.0.1',
    socketPath: opts.socketPath ?? defaultDaemonSocketPath({ env, rootDir: opts.rootDir }),
    // Ф-#8a per-delivery outcome log → delivery.log NEXT TO lifecycle.log, routed
    // through the SAME lifecycle cfg (NOT re-resolved from env) so a sandboxed cfg
    // sandboxes this log too.
    deliveryLogDir: cfg.eventLogDir,
    discovery: opts.discovery ?? true,
    env,
    rootDir: opts.rootDir,
  })
  // The mute-watch timer is OURS, not startDaemon's — so its teardown must hang off the
  // handle we return, or a closed daemon would leave a live timer sweeping the disk (and
  // every test that starts a daemon would hang on exit).
  return { ...handle, close: async () => { stopMuteWatch(); await handle.close() } }
}

// ─────────────────────────────────────────────────────────────────────────────
// The daemon's OWN launchd plist (com.agfpd.iapeer) — distinct from peer plists
// ─────────────────────────────────────────────────────────────────────────────

export function daemonPlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(launchAgentsDir(env), `${DAEMON_PLIST_LABEL}.plist`)
}

export interface InstallDaemonPlistOptions {
  /** How to launch the daemon (default [bun, main.ts]). */
  programArgv?: string[]
  /** TCP port baked into the plist env (default DEFAULT_DAEMON_PORT). */
  port?: number
  /** H8 bearer token baked into the plist env (only when provided). */
  bearerToken?: string
  /** PATH for the launchd minimal env. */
  path?: string
  workingDirectory?: string
  env?: NodeJS.ProcessEnv
  throttleIntervalSecs?: number
}

/** Build the daemon's launchd plist spec (PURE — render/lint-testable). */
export function buildDaemonPlistSpec(opts: InstallDaemonPlistOptions = {}): LaunchdPlistSpec {
  const env = opts.env ?? process.env
  const home = env.HOME?.trim() || homedir()
  const defaultPath = `${home}/.bun/bin:${home}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`
  const logDir = pluginLogsDir('iapeer', { env })
  const environment: Record<string, string> = {
    PATH: opts.path ?? env.PATH ?? defaultPath,
    IAPEER_PORT: String(opts.port ?? DEFAULT_DAEMON_PORT),
  }
  if (opts.bearerToken) environment.IAPEER_BEARER_TOKEN = opts.bearerToken
  // Propagate the FULL set of non-default path overrides so the launchd-held daemon
  // reads the SAME tree the rest of the fleet uses (audit #26: a sandbox daemon that
  // carried only IAPEER_ROOT would scan the wrong tmux socket dir and key its H4
  // launchd-guard on the wrong LaunchAgents dir — the routing + fleet-guard surfaces).
  for (const key of ['IAPEER_ROOT', 'IAPEER_SOCK_DIR', 'IAPEER_LAUNCHAGENTS_DIR'] as const) {
    if (env[key]?.trim()) environment[key] = env[key]!.trim()
  }
  return {
    label: DAEMON_PLIST_LABEL,
    // Ф-F: run the INSTALLED binary (`iapeer daemon`), NOT `bun <src>/daemon/main.ts`
    // — this is the decoupling of prod from the mutable src tree. opts.programArgv
    // overrides for tests / a non-default layout.
    programArguments: opts.programArgv ?? [iapeerBinPath(env), 'daemon'],
    workingDirectory: opts.workingDirectory ?? home, // daemon is cwd-agnostic (per-request identity)
    environment,
    stdoutPath: join(logDir, 'daemon-stdout.log'),
    stderrPath: join(logDir, 'daemon-stderr.log'),
    throttleIntervalSecs: opts.throttleIntervalSecs,
  }
}

export interface InstallDaemonPlistResult {
  /** The plist path (always returned, written or not). */
  path: string
  /** false when the on-disk plist already matched byte-for-byte → NO write was
   *  done. The deploy path calls this on EVERY `iapeer update`; a byte-identical
   *  rewrite serves nothing (the daemon never re-reads the file — launchd holds
   *  its loaded definition; a changed file takes effect only on an explicit
   *  bootout+bootstrap) yet each write into ~/Library/LaunchAgents trips macOS
   *  Background Task Management → a "background activity" notification to the
   *  owner on every deploy. Skipping the no-op write suppresses that noise. */
  changed: boolean
}

/**
 * Generate + install the daemon's always-on launchd plist at
 * ~/Library/LaunchAgents/com.agfpd.iapeer.plist (or IAPEER_LAUNCHAGENTS_DIR),
 * returning {path, changed}. Writes the FILE only — does NOT bootstrap it (load
 * is a deliberate operator step). IDEMPOTENT BY CONTENT: writes only when the
 * rendered plist differs from what is already on disk (an unconditional rewrite
 * on every deploy spams the owner's Background Task Management notification for
 * zero benefit). Collision guard: refuses to
 * overwrite an existing com.agfpd.iapeer.plist that is not foundation-owned
 * (lacks the sentinel) — the same ownership proof the peer-plist installer uses.
 * com.agfpd.* is the foundation-exclusive daemon namespace, so this never
 * touches the com.iapeer.* persistent-peer fleet.
 */
export function installDaemonPlist(opts: InstallDaemonPlistOptions = {}): InstallDaemonPlistResult {
  const env = opts.env ?? process.env
  const path = daemonPlistPath(env)
  if (existsSync(path) && !isFoundationOwnedPlist(path)) {
    throw new IapError(
      `refusing to overwrite ${path}: ${DAEMON_PLIST_LABEL} exists but is not foundation-managed ` +
        `(no ownership sentinel) — another manager owns it`,
    )
  }
  const rendered = renderLaunchdPlist(buildDaemonPlistSpec(opts))
  mkdirSync(launchAgentsDir(env), { recursive: true })
  mkdirSync(pluginLogsDir('iapeer', { env }), { recursive: true, mode: 0o700 })
  // Write-if-changed: a byte-identical rewrite is a pure no-op for the daemon but
  // trips the owner's BTM notification — skip it (see InstallDaemonPlistResult).
  let existing: string | null = null
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    existing = null
  }
  if (existing === rendered) return { path, changed: false }
  writeFileSync(path, rendered, { mode: 0o644 })
  return { path, changed: true }
}

export interface DaemonStartResult {
  /** 'would-start' = dryRun report; otherwise the bootstrap outcome. */
  state: BootstrapState | 'would-start'
  /** Socket health after a (non-sandbox) bootstrap; undefined when not probed. */
  healthy?: boolean
  detail?: string
}

/**
 * `iapeer onboard`'s first, non-disableable step: ensure the foundation daemon is up.
 * Writes the plist if missing (idempotent write-if-changed — defensive when onboard
 * runs on a host where the plist is absent), idempotently bootstraps it (no-op when
 * already loaded — NOT a restart), then health-checks the socket. dryRun reports the
 * intent without touching launchctl. Sandbox-safe: bootstrapDaemon + waitForDaemonHealthy
 * both short-circuit under IAPEER_TEST_SANDBOX, so this never loads a real job in tests.
 */
export async function ensureDaemonStarted(
  opts: { env?: NodeJS.ProcessEnv; dryRun?: boolean } = {},
): Promise<DaemonStartResult> {
  const env = opts.env ?? process.env
  if (opts.dryRun) {
    return {
      state: 'would-start',
      detail: 'install plist if missing + launchctl bootstrap com.agfpd.iapeer (idempotent) + health-check',
    }
  }
  installDaemonPlist({ env })
  const b = bootstrapDaemon(env)
  if (b.state === 'failed') return { state: 'failed', detail: b.detail }
  if (b.state === 'skipped-sandbox') return { state: 'skipped-sandbox', detail: b.detail }
  const h = await waitForDaemonHealthy({ env })
  return { state: b.state, healthy: h.healthy, detail: h.healthy ? undefined : h.detail }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — launchd-held process / foreground acceptance entrypoint
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const arg = process.argv[2]
  if (arg === '--print-plist') {
    process.stdout.write(renderLaunchdPlist(buildDaemonPlistSpec()))
    process.exit(0)
  } else if (arg === '--install-plist') {
    const { path: p, changed } = installDaemonPlist()
    process.stdout.write(
      `daemon plist ${changed ? 'written' : 'unchanged'}: ${p}\n` +
        `NOT loaded. \`iapeer onboard\` starts it (idempotent); or manually: launchctl bootstrap gui/$(id -u) ${p}\n`,
    )
    process.exit(0)
  } else {
    const env = process.env
    const handle = await startConfiguredDaemon({
      port: parseDaemonPort(env.IAPEER_PORT),
      socketPath: env.IAPEER_DAEMON_SOCKET?.trim() || undefined,
      env,
    })
    process.stderr.write(`[iapeer-daemon] READY tcp=${handle.url} sock=${handle.socketPath}\n`)
    const shutdown = () => {
      void handle.close().then(() => process.exit(0))
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
    // В5 — a NON-signal crash (an unhandledRejection, or any uncaught error) would otherwise kill the
    // daemon WITHOUT running handle.close() → failAll, so in-memory composer-queued messages (the sender
    // already got queued:true) would vanish SILENTLY — the forbidden loss class. Run failAll on these
    // paths too so senders are notified, then exit(1) so launchd KeepAlive respawns a clean daemon. A
    // bounded timeout guarantees the exit even if close() hangs. (Hard SIGKILL/OOM cannot be caught — a
    // durable on-disk composer queue would be needed for that, a deliberate follow-up.)
    let crashing = false
    const crashExit = (kind: string) => (errObj: unknown) => {
      if (crashing) return
      crashing = true
      const detail = errObj instanceof Error ? (errObj.stack ?? errObj.message) : String(errObj)
      process.stderr.write(`[iapeer-daemon] ${kind} — failing pending queued deliveries then exiting: ${detail}\n`)
      const done = (): never => process.exit(1)
      const t = setTimeout(done, 3000)
      if (typeof t.unref === 'function') t.unref()
      void handle.close().then(done, done)
    }
    process.on('uncaughtException', crashExit('uncaughtException'))
    process.on('unhandledRejection', crashExit('unhandledRejection'))
    await new Promise(() => {}) // launchd KeepAlive holds this process; block forever
  }
}
