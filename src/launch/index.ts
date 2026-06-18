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
import { spawnSync } from 'child_process'
import { type Runtime } from '../core/constants.ts'
import { buildLaunchInvocation } from './invocation.ts'
import { canaryChannel, dismissCanary, ensureServerCanary, exitLogPath, signalCanaryClean } from './canary.ts'
import { hardenCmdLogDir, prepareCmdLogDir } from './cmdlog.ts'
import { logReadyGateCrossCheck, readyGatePtyFlipEnabled, readyGateViewport } from './readyGateModel.ts'
import { deliverHosted, hostSessionAlive, ptyHostEnabled, startPtyHost, waitHostReady } from './ptyHost.ts'
import { appendLifecycleEvent } from '../lifecycle/eventlog.ts'
import { claudeAdapter } from './adapters/claude.ts'
import { codexAdapter } from './adapters/codex.ts'
import { telegramAdapter } from './adapters/telegram.ts'
import { notifierAdapter } from './adapters/notifier.ts'
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
  throw new Error(`no launch adapter for runtime "${runtime}"`)
}

// ─────────────────────────────────────────────────────────────────────────────
// tmux helpers (direct spawnSync; no lifecycle dependency)
// ─────────────────────────────────────────────────────────────────────────────

function tmux(sock: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const r = spawnSync('tmux', ['-S', sock, ...args], { encoding: 'utf8' })
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}
function sessionAlive(sock: string, identity: string): boolean {
  return tmux(sock, 'has-session', '-t', identity).ok
}
function capturePane(sock: string, identity: string): string {
  return tmux(sock, 'capture-pane', '-t', identity, '-p').out
}
function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function fail(identity: string, reason: string): LaunchResult {
  return { status: 'FAILED', identity, process_address: identity, reason }
}

/**
 * The last two non-empty lines of a pane capture, flattened for embedding in a
 * fail reason: quotes → ', whitespace runs collapsed, joined with ' ⏎ ', clipped
 * to 160 chars. '' for an empty/blank capture (caller omits the clause). Exported
 * for unit tests — the boot loop embeds this in `never-became-ready` so the
 * delivery.log err field shows what the TUI was actually displaying.
 */
export function paneTail(pane: string): string {
  const lines = pane
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (lines.length === 0) return ''
  return lines.slice(-2).join(' ⏎ ').replace(/"/g, "'").slice(0, 160)
}
function ready(identity: string): LaunchResult {
  return { status: 'READY', identity, process_address: identity }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit-cause observability — capture WHY a session's process died, AT THE MOMENT
// of death. The daemon's 60 s supervise tick only learns of a death post-factum
// (reaped-gone), by which time the exit code/signal — and often the whole tmux
// server — is gone (a blind spot one level deeper than the supervise log). A
// tmux `pane-died` hook closes it: it fires the instant the
// pane's leader process exits (with `remain-on-exit on` retaining the dead pane so
// `#{pane_dead_status}`/`#{pane_dead_signal}` are populated), logs one logfmt line,
// then kill-sessions the now-dead pane so the daemon's `has-session` death
// detection (and the always-on KeepAlive block-watch) stay intact.
//
// Scope — verified live on tmux 3.6a (3 death modes + the daemon-reap path):
//   • graceful exit  → `dead_status=<code> dead_signal=`   (code, no signal)
//   • SIGTERM/SIGKILL/crash to the PROCESS → `dead_status= dead_signal=<name>`
//   • daemon-initiated `kill-session` (idle-reap / self-TTL / stop) does NOT fire
//     pane-died → NO line here (those are already in lifecycle.log — no double-log).
// SERVER-LEVEL GAP: SIGKILL to the tmux SERVER process itself runs no hook (the
//   event loop is gone). Closed one level up by the server-death canary
//   (canary.ts — `ev=server-exit` + forensics snapshot); the daemon's post-factum
//   reaped-gone death-class remains the detection backstop.
// ─────────────────────────────────────────────────────────────────────────────

// The exit-cause log path lives in canary.ts (no import cycle); re-exported here
// so the public surface (`launch/index.ts → exitLogPath`) is unchanged.
export { exitLogPath } from './canary.ts'

/**
 * Build the tmux `pane-died` hook command string (the value of `set-hook -t <id>
 * pane-died <value>`). On the pane leader's death it appends ONE logfmt line —
 *   `ts=<ISO> ev=session-exit identity=<id> dead_status=#{…} dead_signal=#{…}`
 * — to `exitLogFile`, then runs a tmux-NATIVE `kill-session` (no shell `tmux`, so
 * it needs no PATH — launchd gives always-on servers a minimal one). Pure (no I/O)
 * so the exact string is unit-testable. Quoting: the `run-shell` arg is wrapped in
 * tmux SINGLE quotes (literal at the tmux layer, still `#{}`-format-expanded) with
 * sh DOUBLE quotes inside — the two levels never collide; `\n`/`$(…)` pass through
 * tmux untouched to sh. `identity`/`exitLogFile` are assumed free of single quotes
 * (runtime-personality identities and the ~/.iapeer/logs path always are). */
export function exitCauseHook(identity: string, exitLogFile: string): string {
  const line =
    `ts=%s ev=session-exit identity=${identity} ` +
    `dead_status=#{pane_dead_status} dead_signal=#{pane_dead_signal}\\n`
  const log =
    `printf "${line}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${exitLogFile}"`
  // Silence the server-death canary BEFORE kill-session: with a single-session
  // server the kill empties the server and exit-empty takes it down — without
  // explicit silence the canary would append a second, muddier `ev=server-exit`
  // record for a death this very hook just captured (the session-exit line is
  // the richer, authoritative one: it has the exit code/signal). v2 contract:
  // deliberate = channel signal (tmux-NATIVE wait-for -S) + DISMISS the sh
  // recorder (abs-path /usr/bin/pkill — survives the minimal launchd PATH;
  // `\$` keeps the regex anchor literal through the sh double-quote layer; the
  // `[i]` class keeps the pattern from matching its OWN occurrence in this
  // hook-sh's cmdline — the pgrep self-match classic).
  const dismiss = `/usr/bin/pkill -f "[i]${canaryChannel(identity).slice(1)}([^a-z0-9-]|\\$)"`
  return `run-shell '${log} ; ${dismiss}' ; wait-for -S "${canaryChannel(identity)}" ; kill-session -t "${identity}"`
}

/** Install the exit-cause observability on a freshly-created session: ensure the
 *  exit-log dir exists, turn `remain-on-exit` on (so pane-died can read the dead
 *  pane's status/signal) and register the hook. Best-effort — a tmux/FS hiccup
 *  here must never fail the launch (observability is never load-bearing). No-op
 *  when `exitLogDir` is falsy (a partial/test cfg): `remain-on-exit` stays OFF so
 *  behavior is byte-identical to before (and no dead pane can linger un-reaped). */
function installExitHook(sock: string, identity: string, exitLogDir: string | undefined): void {
  if (!exitLogDir) return
  try {
    mkdirSync(exitLogDir, { recursive: true, mode: 0o700 })
    // remain-on-exit must be ON before the process can die, else pane-died won't
    // retain the dead pane and the status/signal are lost. Set it (and the hook)
    // immediately after new-session — the only un-coverable window is the few ms
    // before this runs, irrelevant for a runtime that takes seconds to initialize.
    tmux(sock, 'set-option', '-t', identity, 'remain-on-exit', 'on')
    tmux(sock, 'set-hook', '-t', identity, 'pane-died', exitCauseHook(identity, exitLogPath(exitLogDir)))
  } catch {
    /* observability is best-effort — never block a wake on a hook-install hiccup */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// launch — bring up ONE session (runtime-agnostic via the adapter)
// ─────────────────────────────────────────────────────────────────────────────

export const launch: LaunchFn = async (
  spec: LaunchSpec,
  adapter: RuntimeAdapter,
  firstMessage: string,
  cfg: LaunchConfig,
): Promise<LaunchResult> => {
  const { identity, socketPath: sock, cwd } = spec
  const env = cfg.env ?? process.env

  // (0) Intelligence gate (fail-loud BEFORE any tmux work): an adapter that declares
  //     requiresIntelligence (telegram → 'natural') refuses a peer whose nature does
  //     not match — and refuses too when the nature is unknown (cannot confirm). Ports
  //     the persistent-peer FATAL human-channel guard (docs/Рантайм-адаптеры).
  if (adapter.requiresIntelligence && spec.intelligence !== adapter.requiresIntelligence) {
    return fail(
      identity,
      `runtime "${spec.runtime}" requires intelligence=${adapter.requiresIntelligence}, ` +
        `peer "${spec.personality}" is ${spec.intelligence ?? 'unknown'} — refusing to launch`,
    )
  }

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
  if ((adapter.kind === 'tui' || adapter.kind === 'router') && ptyHostEnabled(cfg.logDir, identity)) {
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
        if (hostSessionAlive(identity)) return ready(identity)
        return fail(identity, 'hosted router session not alive immediately after bringup')
      }
      // BOOT: the supervisor's boot-driver dismisses startup dialogs internally; wait for the input
      // surface via the pane-log model, then deliver over the socket + ready-gate on a model turn —
      // the SAME shape as the tmux boot/deliver/ready-gate below, with host equivalents.
      const baselineMtime = adapter.newestActivityMtime(cwd) ?? 0
      const isReady = await waitHostReady(
        { identity, logDir: cfg.logDir, adapter, bootDeadlineSecs: cfg.bootDeadlineSecs, paneLogStartByte },
        sleep,
      )
      if (!isReady) return fail(identity, 'never-became-ready (hosted: supervisor input surface not ready)')
      if (firstMessage.trim().length === 0) return ready(identity) // bare bring-up — no message to deliver
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
      const d = await deliverHosted(identity, firstMessage)
      if (!d.ok) return fail(identity, `hosted deliver failed: ${d.error}`)
      const readyDeadline = Date.now() + cfg.readyGateSecs * 1000
      while (Date.now() < readyDeadline) {
        await sleep(2000)
        if (!hostSessionAlive(identity)) return fail(identity, 'hosted session vanished during ready-gate')
        if ((adapter.newestActivityMtime(cwd) ?? 0) > baselineMtime) return ready(identity)
      }
      return fail(identity, 'model-did-not-process-task (hosted: no activity advance after delivery)')
    }
    // SPAWN-FALLBACK — host bringup failed; record it and fall through to the tmux path (never worse).
    appendLifecycleEvent(cfg.exitLogDir, { ev: 'pty-host-fallback', identity, reason: host.error }, { env })
  }

  // (1) Pre-clean any stale tmux server on this socket, then launch detached.
  //     Silence the server-death canary EXPLICITLY first — this teardown is
  //     deliberate: signal the channel (client exits 0) AND dismiss the sh
  //     recorder (TERM → trap → silent; canary v2 no longer reads a signaled
  //     client alone as deliberate — an external killer sweeping server+client
  //     was exactly the death-#4 silence). Only then sweep the server processes
  //     (the pkill also matches a leftover canary client — harmless, both
  //     canary processes are already dismissed).
  signalCanaryClean(sock, identity)
  dismissCanary(identity)
  spawnSync('pkill', ['-f', `tmux -S ${sock} `], { stdio: 'ignore' })
  tmux(sock, 'kill-server')

  // (2) tmux new-session -d with the adapter-built, shell-quoted argv. The per-peer
  //     per-runtime launch.env (zone Хранение / Рантайм-адаптеры) contributes
  //     PEER_START_ARGS (APPENDED after the adapter's base flags — extraArgs is last
  //     in every buildArgv) and extra child env. spec.extraArgs (an explicit caller
  //     override) comes first, then launch.env's; both land after the base flags.
  // argv + child env are composed by buildLaunchInvocation (invocation.ts) — the SINGLE source shared
  // with the supervisor serving path (cutover Block 2) so a served session is byte-identical to this
  // tmux-launched one. The tmux path shell-quotes+joins the argv into the new-session string; the
  // supervisor path passes the same argv array to Bun.spawn. (PEER_START_ARGS append, codex bearer
  // stub, identity ABI, PATH — all live there now, byte-for-byte unchanged.)
  const { argv: runtimeArgv, env: childEnv } = buildLaunchInvocation(spec, adapter, cfg)
  const runtimeCmd = runtimeArgv.map(shellQuote).join(' ')
  // (2.4) tmux command-log (killer-hunt socket-command layer, cmdlog.ts): WARM
  //       agent sessions start their server with `-v` so every client command —
  //       incl. a killer's `kill-server`/`kill-session`, invisible to signal
  //       forensics — lands in tmux-server-<pid>.log with client attribution
  //       (`message: client-<pid> command: …`). The starting client runs FROM the
  //       per-identity 0700 cmdlog dir (that is where tmux drops the logs; the
  //       pane's cwd is still `-c cwd`). Gated like the other observability layers
  //       on cfg.exitLogDir; skipped for always-on infra (rare relaunch = no
  //       rotation point, and not the dying class). Best-effort: a failed dir
  //       prepare just launches without -v.
  const cmdLogDir = !cfg.alwaysOn && cfg.exitLogDir ? prepareCmdLogDir(cfg.exitLogDir, identity) : undefined
  const start = spawnSync(
    'tmux',
    [
      '-S', sock,
      ...(cmdLogDir ? ['-v'] : []),
      'new-session', '-d', '-s', identity, '-x', '220', '-y', '50', '-c', cwd, runtimeCmd,
    ],
    { env: childEnv as Record<string, string>, encoding: 'utf8', ...(cmdLogDir ? { cwd: cmdLogDir } : {}) },
  )
  if (start.status !== 0) {
    return fail(identity, `tmux new-session failed: ${(start.stderr ?? '').trim() || 'exit ' + start.status}`)
  }
  // The server/client logs exist once new-session returns — clamp them to 0600.
  if (cmdLogDir) hardenCmdLogDir(cmdLogDir)

  // (2.5) Exit-cause observability: a `pane-died` hook that records WHY this
  //       session's process dies (status/signal) at the moment of death into
  //       <exitLogDir>/exits.log, then kill-sessions the dead pane (so the
  //       daemon's has-session death detection + always-on KeepAlive stay intact).
  //       Installed ASAP — before pipe-pane — so even a runtime that dies during
  //       boot leaves a cause. No-op without cfg.exitLogDir (remain-on-exit off).
  installExitHook(sock, identity, cfg.exitLogDir)

  // (2.6) Server-death canary (canary.ts): the SERVER-level catcher pane-died
  //       structurally cannot be — a detached wait-for client OUTSIDE the server
  //       that records `ev=server-exit` + a forensics snapshot when the whole
  //       server dies dirty (SIGKILL/OOM class). Same gate as the exit hook;
  //       best-effort by construction (every failure → a state, never a throw).
  //       The ensure-state is logged (origin=launch) so the arming trail is
  //       complete in lifecycle.log: 'spawned' is the newborn-server norm here,
  //       'failed' a newborn server starting its life UNWATCHED (death-#4
  //       postmortem hinged on this very question being unanswerable).
  const canaryState = ensureServerCanary({ identity, sock, exitLogDir: cfg.exitLogDir, env })
  if (canaryState !== 'skipped') {
    appendLifecycleEvent(cfg.exitLogDir, { ev: 'canary', identity, state: canaryState, origin: 'launch' }, { env })
  }

  // (3) pipe-pane the session output to the per-identity log.
  mkdirSync(cfg.logDir, { recursive: true, mode: 0o700 })
  const paneLog = `${cfg.logDir}/${identity}.log`
  tmux(sock, 'pipe-pane', '-t', identity, `cat >> ${shellQuote(paneLog)}`)

  // (4) [REMOVED 0.2.55] Session self-TTL. Was a tmux server-side
  //     `run-shell -b -d <maxAgeSecs>` → `kill-session`, intended to bound a zombie
  //     even if no supervise sweep runs. It was a BLIND wall-clock kill armed ONCE
  //     at birth and never re-armed, so it guillotined HEALTHY long-lived sessions
  //     at exactly birth+maxAge (4 h) — the recurrent "mystery deaths".
  //     By construction any session that survives to maxAge is active: idle ones are
  //     already idle-reaped at idleSecs (1 h) by the activity-aware supervisor — so
  //     the blind kill could ONLY ever destroy live work (its sole "useful" case,
  //     daemon dead the whole interval, leaves an inert orphan nothing can deliver
  //     to, self-healed by idle-reap on daemon restart). The activity-aware idle-reap
  //     (superviseTick) is now the SOLE lifecycle bound. (alwaysOn infra never armed it.)

  // (5) Router runtime (telegram): no TUI input surface — there is no boot dialog
  //     and no ready marker to gate on. The process is up; return READY.
  if (adapter.kind === 'router') {
    return ready(identity)
  }

  // (6) BOOT phase (tui) — baseline the activity proxy, answer startup dialogs,
  //     wait for the input surface, then deliver firstMessage (load-buffer +
  //     bracketed paste-buffer + Enter — the SAME byte-path as warm delivery).
  //     An EMPTY firstMessage is a BARE bring-up (folder-launch with no seed, or an
  //     attach-resume that carries no message): reach the input surface and return
  //     READY — there is no message to deliver and nothing to ready-gate on (the
  //     operator drives the session). A non-empty message takes the wake path
  //     (deliver + ready-gate on a model turn).
  const hasMessage = firstMessage.trim().length > 0
  const baselineMtime = adapter.newestActivityMtime(cwd) ?? 0
  const bootIters = Math.max(1, Math.ceil(cfg.bootDeadlineSecs / 2))
  let delivered = false
  let lastPane = '' // the final capture — surfaced in the never-became-ready reason
  for (let i = 0; i < bootIters && !delivered; i++) {
    await sleep(2000)
    if (!sessionAlive(sock, identity)) {
      return fail(identity, 'tmux session vanished during boot')
    }
    const pane = capturePane(sock, identity)
    if (!pane) continue
    lastPane = pane
    const dialogKeys = adapter.bootDialogKeys(pane)
    if (dialogKeys) {
      tmux(sock, 'send-keys', '-t', identity, ...dialogKeys)
      continue
    }
    // Ф1 READY-GATE SOURCE FLIP (per-peer flag, DARK by default). When the peer's flip flag is set,
    // run the SAME isInputReady predicate on the pty-MODEL viewport (validated 0-divergence vs
    // capture-pane by the burn-in gate, incl. the codex resume-with-history splash-off-screen center)
    // instead of the capture-pane scrape, with an UNCONDITIONAL capture-pane fallback. This is the
    // ONLY changed input — dialog detection (above) and delivery + delivery-confirm (below + transport)
    // are untouched. Flag OFF → readyView === pane (byte-identical to today).
    let readyView = pane
    if (readyGatePtyFlipEnabled(cfg.logDir, identity)) {
      const geo = tmux(sock, 'display', '-p', '-t', identity, '#{pane_width}x#{pane_height}')
      const [c, r] = geo.ok ? geo.out.trim().split('x').map(Number) : [0, 0]
      readyView = await readyGateViewport({ logDir: cfg.logDir, identity, fallback: pane, cols: c ?? 0, rows: r ?? 0 })
      // SERVING-path cross-check (post-flip soak gate): the model verdict is AUTHORITATIVE (readyView);
      // record what capture-pane WOULD have said, to prove 0 model-vs-capture divergence live in the
      // serving path. Observability only — never affects the ready decision.
      logReadyGateCrossCheck(cfg.exitLogDir, {
        identity,
        modelReady: adapter.isInputReady(readyView),
        captureReady: adapter.isInputReady(pane),
        geom: `${c ?? 0}x${r ?? 0}`,
        nowISO: new Date().toISOString(),
      })
    }
    if (adapter.isInputReady(readyView)) {
      if (!hasMessage) return ready(identity) // bare bring-up — session up, no message
      // Boot delivery = load-buffer → paste-buffer -p → Enter (Ф-#8b hardening):
      // the SAME mechanism warm delivery uses (transport.deliverViaTmux), replacing
      // the old `send-keys -l`. send-keys retypes the message as literal keystrokes —
      // a multi-KB envelope replays key-by-key through the pty input buffer, and the
      // two paths could diverge (a message that survives warm delivery could be
      // mangled at cold-wake). load-buffer hands the TUI the whole envelope as ONE
      // bracketed paste, byte-identical to the warm path. A load/paste hiccup →
      // retry on the next boot iteration (previously the send-keys result was
      // ignored and a failed inject was declared delivered, failing the wake later
      // with the wrong reason at the ready-gate).
      const bufferName = `iapeer-boot-${process.pid}-${Date.now()}`
      const load = spawnSync(
        'tmux',
        ['-S', sock, 'load-buffer', '-b', bufferName, '-'],
        { input: firstMessage, encoding: 'utf8' },
      )
      if (load.status !== 0) continue
      const paste = tmux(sock, 'paste-buffer', '-p', '-b', bufferName, '-t', identity)
      if (!paste.ok) {
        tmux(sock, 'delete-buffer', '-b', bufferName)
        continue
      }
      await sleep(300)
      tmux(sock, 'send-keys', '-t', identity, 'Enter')
      tmux(sock, 'delete-buffer', '-b', bufferName)
      delivered = true
    }
  }
  if (!delivered) {
    // Surface WHAT the pane showed when the gate gave up — a codex-resume
    // incident (splash scrolled off, composer ready, predicate false for 240 s) was
    // undiagnosable from the bare reason alone. Last two non-empty lines, quotes
    // flattened (the reason lands inside a logfmt-quoted err field), clipped.
    const tail = paneTail(lastPane)
    return fail(
      identity,
      `never-became-ready (stuck at a startup prompt or boot hang)${tail ? `; pane tail: ${tail}` : ''}`,
    )
  }

  // (7) READY-GATE — the activity proxy must strictly advance past baseline
  //     (the model picked up and processed the first message).
  const readyDeadline = Date.now() + cfg.readyGateSecs * 1000
  while (Date.now() < readyDeadline) {
    await sleep(2000)
    if (!sessionAlive(sock, identity)) {
      return fail(identity, 'tmux session vanished during ready-gate')
    }
    const mt = adapter.newestActivityMtime(cwd) ?? 0
    if (mt > baselineMtime) {
      return ready(identity)
    }
  }
  return fail(identity, 'model-did-not-process-task (no activity advance after delivery)')
}
