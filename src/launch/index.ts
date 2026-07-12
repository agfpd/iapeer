// Launch — the single runtime-AGNOSTIC session bring-up primitive + adapter
// dispatch. `launch` is the generalized form of the Ф2 wakeOrSpawn inline boot
// loop + ready-gate (lifecycle/index.ts): pre-clean stale tmux server →
// new-session -d with adapter.buildArgv → pipe-pane → session self-TTL → (tui)
// boot dialogs + first-message delivery → ready-gate on adapter.newestActivity
// Mtime. Every runtime specific (argv flags, boot dialogs, ready marker, activity
// proxy) comes through the RuntimeAdapter; this file holds NO runtime strings.
//
// Ownership split (blueprint §1, §7): launch = HOW to bring up ONE session
// (runtime-agnostic). It carries NO lifecycle concerns (no wake-lock, no
// registry/findPeer, no launchd guard, no session-state, no supervise/reap —
// those stay in lifecycle/index.ts, which calls launch) and NO currency (no
// marketplace / plugin install / update — that is install-time). lifecycle
// decides WHEN/HOW-MANY and hands launch a fully-resolved LaunchSpec + adapter.

import { existsSync, mkdirSync, statSync } from 'fs'
import { dirname } from 'path'
import { type Runtime } from '../core/constants.ts'
import { buildLaunchInvocation } from './invocation.ts'
import { deliverHosted, hostSessionAlive, startPtyHost, waitHostReady } from './ptyHost.ts'
import { appendLifecycleEvent } from '../lifecycle/eventlog.ts'
import { claudeAdapter } from './adapters/claude.ts'
import { codexAdapter } from './adapters/codex.ts'
import { telegramAdapter } from './adapters/telegram.ts'
import { notifierAdapter } from './adapters/notifier.ts'
import { voicetalkAdapter } from './adapters/voicetalk.ts'
import type {
  LaunchConfig,
  LaunchFn,
  LaunchResult,
  LaunchSpec,
  RuntimeAdapter,
} from './types.ts'

// Re-export the launch contract so consumers (lifecycle, cli) import from the
// module index, not the frozen types file directly.
export type {
  ComposePromptInput,
  ComposeSystemPrompt,
  PromptDomainBlock,
  PublicPeerSummary,
  LaunchAdapterConfig,
  LaunchConfig,
  LaunchFn,
  LaunchResult,
  LaunchSpec,
  RuntimeAdapter,
} from './types.ts'

// Always-on launchd plist generation (infra runtimes). launchdRun.ts is a CLI
// entrypoint (referenced by the generated plist via its file path) — deliberately
// NOT re-exported here, to avoid an index ↔ launchdRun import cycle.
export {
  launchdLabel,
  launchAgentsDir,
  launchdPlistPath,
  renderLaunchdPlist,
  installAlwaysOnPlist,
  isFoundationOwnedPlist,
  launchctlBootstrap,
  bootstrapJobCore,
  cycleLaunchdJob,
  cycleLaunchdJobCore,
  cycleDaemon,
  cycleDaemonCore,
  resolveExecutable,
  IAPEER_PLIST_OWNER_KEY,
} from './launchd.ts'
export type {
  LaunchdPlistSpec,
  InstallAlwaysOnPlistOptions,
  BootstrapResult,
  BootstrapState,
  BootstrapCoreDeps,
  BootstrapCoreResult,
  DaemonRestartResult,
  DaemonRestartState,
  LaunchdJobCycleResult,
  LaunchdJobCycleState,
  LaunchctlRunner,
} from './launchd.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Adapter dispatch — claude/codex (tui) + telegram/notifier (router, infra).
// ─────────────────────────────────────────────────────────────────────────────

export function getAdapter(runtime: Runtime): RuntimeAdapter {
  if (runtime === 'claude') return claudeAdapter
  if (runtime === 'codex') return codexAdapter
  if (runtime === 'telegram') return telegramAdapter
  if (runtime === 'notifier') return notifierAdapter
  if (runtime === 'voicetalk') return voicetalkAdapter
  throw new Error(`no launch adapter for runtime "${runtime}"`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function fail(identity: string, reason: string): LaunchResult {
  return { status: 'FAILED', identity, process_address: identity, reason }
}

function ready(identity: string): LaunchResult {
  return { status: 'READY', identity, process_address: identity }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit-cause observability — the supervisor records WHY a hosted session's child
// died (dead_status/dead_signal) into <exitLogDir>/exits.log at the moment of death
// (a death-EVENT, host=supervisor), passed in via startPtyHost's exitLogPath. The
// daemon's supervise tick learns of the death post-factum (reaped-gone) and reads
// the cause from that log.
// ─────────────────────────────────────────────────────────────────────────────

/** The exit-cause log file (sibling to lifecycle.log) the supervisor appends death-EVENTs to. */
export function exitLogPath(exitLogDir: string): string {
  return `${exitLogDir}/exits.log`
}

// ─────────────────────────────────────────────────────────────────────────────
// launch — bring up ONE session (runtime-agnostic via the adapter)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The intelligence gate — launch step (0), extracted as a PURE predicate so it is
 * unit-testable in isolation (no bring-up, never touches the pty host). A channel
 * adapter that declares `allowedIntelligences` (telegram/voicetalk → ['natural',
 * 'absent']) refuses a peer whose nature is NOT in the set — and refuses too when
 * the nature is unknown (cannot confirm). Returns the fail-loud reason string, or
 * `null` when the gate PASSES (the peer may proceed to bring-up).
 */
export function intelligenceGateReason(adapter: RuntimeAdapter, spec: LaunchSpec): string | null {
  if (adapter.allowedIntelligences && (spec.intelligence == null || !adapter.allowedIntelligences.includes(spec.intelligence))) {
    return (
      `runtime "${spec.runtime}" requires intelligence ∈ {${adapter.allowedIntelligences.join(', ')}}, ` +
      `peer "${spec.personality}" is ${spec.intelligence ?? 'unknown'} — refusing to launch`
    )
  }
  return null
}

export const launch: LaunchFn = async (
  spec: LaunchSpec,
  adapter: RuntimeAdapter,
  firstMessage: string,
  cfg: LaunchConfig,
): Promise<LaunchResult> => {
  const { identity, socketPath: sock, cwd } = spec
  const env = cfg.env ?? process.env

  // (0) Intelligence gate (fail-loud BEFORE any bring-up work): an adapter that declares
  //     allowedIntelligences (telegram/voicetalk → ['natural','absent']) refuses a peer whose
  //     nature is not IN the set — and refuses too when the nature is unknown (cannot confirm).
  //     A channel runtime carries a human (natural) OR a faceless service bot (absent), never an
  //     LLM agent (artificial). Ports the persistent-peer FATAL human-channel guard, relaxed to
  //     first-class faceless service bots (docs/Рантайм-адаптеры).
  const gateReason = intelligenceGateReason(adapter, spec)
  if (gateReason) return fail(identity, gateReason)

  // (0.5) Ensure the socket's PARENT dir exists before `tmux new-session -S <sock>` —
  //       tmux does NOT create it and fails SILENTLY (the session "dies immediately")
  //       when the dir is absent. In prod the sock dir is /tmp (always there) so this
  //       never bites; it bites a sandbox/test with an IAPEER_SOCK_DIR override pointing
  //       at a not-yet-created dir. Symmetric to the cfg.logDir mkdir before pipe-pane.
  mkdirSync(dirname(sock), { recursive: true })

  // ── PTY-SUPERVISOR HOSTING — the DEFAULT (opt-out per-peer via `.no-pty-host`) ─────────────────────
  // By default a tui peer is HOSTED by the supervisor (it owns the pty + boot-driver + pane-log) instead
  // of `tmux new-session`. The supervisor serves the SAME launch-composed argv+env (buildLaunchInvocation,
  // the single source the tmux path also uses), so the hosted session is parity-identical. Readiness is
  // read off the pane-log model (the supervisor's boot-driver answers startup dialogs internally);
  // delivery goes over the supervisor socket. UNCONDITIONAL SPAWN-FALLBACK: any host-bringup failure
  // falls through to the tmux path below — a hosted peer is NEVER worse than tmux ON SPAWN. Opt-OUT
  // (`.no-pty-host` marker) → this whole block is skipped and the tmux path is byte-identical (golden);
  // it is the dev/debug escape valid only while tmux still exists. Routers (telegram/notifier) are ALSO
  // hosted by default (cutover infra-track): launchd STILL owns their lifecycle via run-infra (H4) — the
  // supervisor only provides the pty + delivery socket + pane-log; the router branch below skips every
  // TUI phase (no boot dialogs — BOOT_ADAPTERS has no router entry so the supervisor's boot-driver is
  // skipped; no transcript ready-gate — newestActivityMtime=null). @xterm stays out of THIS process
  // (ptyHost: @xterm-free start + deliver + sessionAlive; readiness's @xterm import is dynamic and only
  // loads here, default-on — and the router branch never reaches it).
  if (adapter.kind === 'tui' || adapter.kind === 'router') {
    const invocation = buildLaunchInvocation(spec, adapter, cfg)
    mkdirSync(cfg.logDir, { recursive: true, mode: 0o700 }) // the supervisor writes the pane-log here
    const paneLogPath = `${cfg.logDir}/${identity}.log`
    // SESSION-START BOUNDARY (premature-ready fix): the pane-log is a SHARED append-only file across a
    // peer's session lineage. Capture its size BEFORE the supervisor opens+writes it, so the hosted
    // ready-gate (waitHostReady → paneLogViewport) renders ONLY this session's bytes — never a PRIOR
    // session's last frame, which (a `❯ ready` row) would satisfy isInputReady before the fresh runtime
    // has painted → a premature deliver into a still-booting session → the first message is LOST and the
    // model never produces a turn. Captured here, before startPtyHost spawns the writer (single writer).
    const paneLogStartByte = existsSync(paneLogPath) ? statSync(paneLogPath).size : 0
    const host = await startPtyHost({
      identity,
      runtime: spec.runtime,
      cwd,
      paneLogPath,
      exitLogPath: cfg.exitLogDir ? exitLogPath(cfg.exitLogDir) : undefined,
      invocation,
      env, // sandbox the supervisor run-dir (serve-spec + detached spawn) via the injected env
    })
    if (host.ok) {
      // ROUTER (telegram/notifier): no startup dialogs and no transcript. The session is "up" the
      // instant the supervisor child is serving — symmetric to the tmux router path, where launch
      // returns READY the moment `tmux new-session` succeeds and the always-on caller (runAlwaysOn)
      // does its own BOOT_RECHECK to catch an immediate child-death. Always-on routers launch with an
      // EMPTY firstMessage; deliveries arrive LATER over the socket (deliverHosted → child stdin → the
      // router's <iap>-marker stdin reader). So confirm the hosted session is live and return ready —
      // no waitHostReady (would load @xterm for nothing), no first-message deliver, no ready-gate.
      if (adapter.kind === 'router') {
        if (hostSessionAlive(identity, env)) return ready(identity)
        return fail(identity, 'hosted router session not alive immediately after bringup')
      }
      // BOOT: the supervisor's boot-driver dismisses startup dialogs internally; wait for the input
      // surface via the pane-log model, then deliver over the socket + ready-gate on a model turn —
      // the SAME shape as the tmux boot/deliver/ready-gate below, with host equivalents.
      const isReady = await waitHostReady(
        { identity, logDir: cfg.logDir, adapter, bootDeadlineSecs: cfg.bootDeadlineSecs, paneLogStartByte, approvalMode: spec.approvalMode, env },
        sleep,
      )
      if (!isReady) return fail(identity, 'never-became-ready (hosted: supervisor input surface not ready)')
      if (firstMessage.trim().length === 0) return ready(identity) // bare bring-up — no message to deliver
      // В18 — snap the ready-gate baseline AFTER boot, not before. newestActivityMtime is a raw
      // transcript-file mtime that BOOT ITSELF advances: codex writes its rollout-jsonl on start,
      // a claude-resume re-saves the transcript. Captured before waitHostReady, those boot writes
      // alone push mtime past the baseline, so the gate below fires on the boot write — NOT on the
      // model PROCESSING firstMessage — returning ready/taskDelivered while the message is unseen
      // (silent loss). Snapped here — post-boot, pre-deliver — only the model's own turn advances it.
      const baselineMtime = adapter.newestActivityMtime(cwd) ?? 0
      // INSTRUMENTATION (premature-ready diagnosis): record the session-start boundary and how much THIS
      // session had written into the shared pane-log by the time the ready-gate fired. On a recurrence,
      // paneLogBytes ≈ paneLogStartByte (ready seen though the new session wrote ~nothing) localizes a
      // residual stale-frame read; a healthy fresh boot writes well beyond startByte before readiness.
      appendLifecycleEvent(
        cfg.exitLogDir,
        {
          ev: 'hosted-deliver',
          identity,
          paneLogStartByte,
          paneLogBytes: existsSync(paneLogPath) ? statSync(paneLogPath).size : 0,
        },
        { env },
      )
      const d = await deliverHosted(identity, firstMessage, env)
      if (!d.ok) return fail(identity, `hosted deliver failed: ${d.error}`)
      const readyDeadline = Date.now() + cfg.readyGateSecs * 1000
      while (Date.now() < readyDeadline) {
        await sleep(2000)
        if (!hostSessionAlive(identity, env)) return fail(identity, 'hosted session vanished during ready-gate')
        if ((adapter.newestActivityMtime(cwd) ?? 0) > baselineMtime) return ready(identity)
      }
      return fail(identity, 'model-did-not-process-task (hosted: no activity advance after delivery)')
    }
    // pty-only: no tmux fallback — a failed host bringup fails the launch (loud, not silent).
    appendLifecycleEvent(cfg.exitLogDir, { ev: 'pty-host-failed', identity, reason: host.error }, { env })
    return fail(identity, `pty host bringup failed: ${host.error ?? 'unknown error'}`)
  }
  return fail(identity, `unsupported adapter kind "${adapter.kind}"`)
}
