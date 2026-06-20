// launchd always-on entrypoint — the blocking process launchd KeepAlive holds for
// an INFRA (always-on) peer. It brings the peer's session up via the launch
// primitive in alwaysOn mode (tmux endpoint for the daemon's deliverViaTmux; NO
// self-TTL) and then BLOCKS until that session dies, at which point it exits so
// launchd respawns it (the plist's ThrottleInterval bounds a crashloop).
//
// IDEMPOTENT: if the session is already live (a prior instance, or a manual
// bring-up), it skips the launch and only block-watches — never a second spawn.
// The bring-up is a check-then-launch with NO advisory lock (unlike wakeOrSpawn's
// withWakeLock): serialization is delegated to launchd, which runs at most one
// instance per Label. Do NOT invoke this manually alongside the launchd-managed job
// for the same identity — two concurrent racers could both pass the liveness check.
//
// Invoked by the generated plist (launchd.ts installAlwaysOnPlist):
//   bun <this> <personality> <runtime>
// with WorkingDirectory=<peer cwd> and EnvironmentVariables PEER_* set by launchd,
// so process.cwd() IS the peer cwd.

import { join } from 'path'
import { INFRA_RUNTIME_BIN_ENV, isInfraRuntime, resolveSockDir } from '../core/constants.ts'
import { buildProcessAddress, buildSocketPath } from '../core/socket.ts'
import { peerLogsDir, pluginLogsDir } from '../storage/index.ts'
import { readPeerProfile } from '../identity/index.ts'
import { getAdapter, launch } from './index.ts'
import { hostSessionAlive, killPtyHost } from './ptyHost.ts'
import type { LaunchConfig, LaunchSpec } from './types.ts'

/** Block-watch poll cadence — seconds, deliberately NOT a tight loop (the session
 *  rarely dies; this only needs to notice a crash within a few seconds). The sleep
 *  is cancelable, so a shutdown signal does not wait out a full interval. */
const WATCH_INTERVAL_MS = 5000

/** After a router launch returns READY (= tmux new-session succeeded), wait this
 *  long and recheck: a missing/broken runtime bin lets the pane die instantly, and
 *  this turns that into a NON-zero diagnostic exit instead of a clean-looking run. */
const BOOT_RECHECK_MS = 2000

/**
 * Build the always-on LaunchSpec for an infra peer, reading intelligence from the
 * local peer-profile.json. launchd sets WorkingDirectory = peer cwd, so that file
 * is the authoritative per-peer source (it self-heals legacy human→natural on read).
 *
 * The intelligence field is LOAD-BEARING for the launch primitive's nature gate
 * (telegram requires natural). Omitting it (the original bug) made every always-on
 * telegram launch fail the gate (`natural !== undefined`) → exit 1 → launchd
 * KeepAlive crash-loop. A correctly-provisioned telegram peer (intelligence=natural)
 * now clears the gate; a mis-provisioned one is refused LOUDLY, not crash-looped.
 * Exported so this invariant is unit-testable WITHOUT touching tmux.
 */
export function buildAlwaysOnSpec(
  personality: string,
  runtime: string,
  cwd: string,
  sockDir: string,
): LaunchSpec {
  const profile = readPeerProfile(cwd)
  return {
    personality,
    runtime,
    cwd,
    identity: buildProcessAddress(runtime, personality),
    socketPath: buildSocketPath(runtime, personality, sockDir),
    intelligence: profile?.intelligence,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Bring up (if needed) and block-watch one always-on infra session. Returns the
 * process exit code: 0 when the watched session died (→ KeepAlive respawns),
 * 1 when bring-up failed or the runtime is not infra.
 */
export async function runAlwaysOn(personality: string, runtime: string, cwd: string): Promise<number> {
  if (!isInfraRuntime(runtime)) {
    process.stderr.write(`launchdRun: "${runtime}" is not an always-on infra runtime\n`)
    return 1
  }
  const env = process.env
  const sockDir = resolveSockDir(env)
  const identity = buildProcessAddress(runtime, personality)
  const sock = buildSocketPath(runtime, personality, sockDir)
  const adapter = getAdapter(runtime)

  // pty-only liveness: a router is supervisor-HOSTED. Probe by RUNTIME STATE (not the `.pty-host`
  // marker). On child death it goes false → block-watch exits → run-infra exits → launchd KeepAlive
  // respawns (the SOLE respawn owner; the supervisor never self-respawns — H4 held).
  const isAlive = (): boolean => hostSessionAlive(identity)

  const cfg: LaunchConfig = {
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    codexBin: env.CODEX_BIN ?? 'codex',
    // Read the abs runtime-bin the plist baked, via the SAME var-name map the baker
    // (installAlwaysOnPlist) uses — so the pin and the read can never drift.
    telegramBin: env[INFRA_RUNTIME_BIN_ENV.telegram],
    notifierBin: env[INFRA_RUNTIME_BIN_ENV.notifier],
    sockDir,
    bootDeadlineSecs: 30,
    readyGateSecs: 30,
    // GLOBAL infra logs (Фаза §8): ~/.iapeer/logs/<personality>/ — match the plist's
    // stdout/stderr dir (installAlwaysOnPlist), not per-peer <cwd>/.iapeer/logs/.
    logDir: peerLogsDir(personality, { env }),
    // Exit-cause log → the shared ~/.iapeer/logs/iapeer (== lifecycle eventLogDir),
    // so an infra peer's self-death is recorded next to lifecycle.log too. The hook
    // also reaps the dead pane: without it remain-on-exit would linger a dead pane,
    // keeping sessionAlive() true so runAlwaysOn block-watches forever and KeepAlive
    // never respawns — the hook prevents that regression as well as logging the cause.
    exitLogDir: pluginLogsDir('iapeer', { env }),
    env,
    alwaysOn: true,
  }
  // Intelligence MUST be on the spec so the launch primitive's nature gate
  // (telegram requires natural) passes for a correctly-provisioned infra peer
  // (see buildAlwaysOnSpec — omitting it crash-looped every telegram launch).
  const spec = buildAlwaysOnSpec(personality, runtime, cwd, sockDir)

  // Idempotent: bring up only when not already live.
  if (!isAlive()) {
    const result = await launch(spec, adapter, '', cfg)
    if (result.status !== 'READY') {
      process.stderr.write(`launchdRun: launch FAILED for ${identity}: ${result.reason ?? 'unknown'}\n`)
      return 1 // exit → launchd respawns after ThrottleInterval
    }
    // A router returns READY the moment `tmux new-session` succeeds — it does NOT
    // verify the pane command STAYED up. If the runtime bin is missing/broken the
    // session dies at once; recheck after a beat so a crash-on-boot exits NON-zero
    // (a diagnostic, throttled by the plist) instead of a clean exit that reads as a
    // healthy run in the launchd logs.
    await sleep(BOOT_RECHECK_MS)
    if (!isAlive()) {
      process.stderr.write(
        `launchdRun: ${identity} session died immediately after launch — check ${cfg.notifierBin ?? `${runtime}-runtime`}\n`,
      )
      return 1
    }
  }

  // Block-watch until the session dies, then exit 0 so KeepAlive respawns a fresh
  // bring-up. The per-iteration sleep is CANCELABLE: SIGTERM/SIGINT (launchctl
  // bootout / clean shutdown) clears the pending timer and breaks the loop at once,
  // so shutdown does not wait out a full poll interval.
  let stop = false
  let interrupt: (() => void) | null = null
  const onSignal = () => {
    stop = true
    interrupt?.()
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  while (!stop && isAlive()) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, WATCH_INTERVAL_MS)
      interrupt = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    interrupt = null
  }
  // Signal-initiated stop (bootout / shutdown / kickstart -k) tears the session down WITH this watcher —
  // kill the supervisor daemon (killPtyHost: SIGTERM → it SIGKILLs the child + cleans up sock/pid/serve)
  // so the detached child does not outlive bootout holding stale in-memory state. A NATURAL death
  // (stop=false) skips this: nothing to tear down, exit 0 → KeepAlive respawns a fresh bring-up.
  if (stop) killPtyHost(identity)
  return 0
}

// CLI entry: bun launchdRun.ts <personality> <runtime>. cwd = launchd WorkingDirectory.
if (import.meta.main) {
  const personality = process.argv[2] ?? process.env.PEER_PERSONALITY ?? ''
  const runtime = process.argv[3] ?? process.env.PEER_RUNTIME ?? ''
  if (!personality || !runtime) {
    process.stderr.write('usage: launchdRun <personality> <runtime>\n')
    process.exit(2)
  }
  runAlwaysOn(personality, runtime, process.cwd()).then(code => process.exit(code))
}
