// Server-death canary — the SERVER-level catcher for the exit-cause gap the
// pane-died hook structurally cannot close (контракт: pane-died needs a living
// tmux event loop; SIGKILL/OOM to the tmux SERVER runs no hook). Raised from the
// deferred backlog after the SECOND live case of the class (both: a healthy
// session with active Bash subprocessing, the whole server gone silently, zero
// system traces).
//
// Mechanism: one tiny detached `sh` per LIVE tmux server, holding a blocking
// client `tmux -S <sock> wait-for iap-canary-<identity>` — a process OUTSIDE the
// dying server, connected via its socket, so the server's death (any cause,
// including SIGKILL) is observed the moment the connection drops. Protocol (v2 —
// a live death proved v1's exit-code trust wrong twice over: the killer
// took the SERVER and the canary CLIENT together, AND a TERMed tmux client
// returns rc=0 — indistinguishable from a clean channel signal — so the rc-based
// `0 || ≥128 → silent` guard silenced a real death):
//   • DELIBERATE silence is an explicit act, never an exit-code inference:
//     every deliberate teardown (idle-reap / stop / pre-clean / pane-died hook /
//     bootout teardown) signals the channel (`wait-for -S`) AND dismisses the
//     sh recorder (`dismissCanary` → TERM → trap → silent exit). POSIX trap
//     semantics make this race-free: the trap runs before any recording.
//   • When wait-for returns — ANY code — the script sleeps 2 s (a concurrent
//     dismissal TERM wins here), then probes the ORIGINAL SERVER PID captured at
//     arm time: still alive → exit silently (a lost canary is re-armed and logged
//     by the supervise retrofit within a tick); gone with nobody having dismissed
//     us → the death is real and unclaimed → ONE logfmt line `ev=server-exit`
//     into exits.log (the per-peer death-cause home, next to pane-died's
//     `ev=session-exit`) + a forensics snapshot (vm_stat / swap / top-RSS ps /
//     fresh DiagnosticReports) captured within seconds — the evidence the 60 s
//     supervise tick can never recover (zero system traces was the recurring
//     investigation outcome). PID identity matters: a wake/attach can replace the
//     tmux server on the same socket before the 2 s grace elapses; probing only
//     the socket would mistake the successor for the dead original and lose the
//     canary record (a live canary-gap).
//     The raw wait_rc still ATTRIBUTES the death (cause=server-vanished /
//     signaled-server-gone / client-killed-server-gone).
// Residual blind spot (structural): a killer that SIGKILLs the sh recorder
// itself leaves no in-process way to record. With v2 the ABSENCE of a record on
// a server-dead reap narrows the diagnosis to exactly that shape; the canary
// ensure-state lines in lifecycle.log (origin=launch/retrofit) evidence the
// churn post-hoc.
//
// The canary is pure observability: it never wakes, reaps, restarts or otherwise
// manages anything (H4-compatible by construction), it fires at most once, and
// every failure to spawn/record is swallowed (never load-bearing). The daemon's
// reaped-gone death-class (classifyGoneSession) remains the detection backstop
// when no canary was running.

import { spawn, spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { resolveExecutable } from './launchd.ts'
import { cmdLogDirFor } from './cmdlog.ts'

/** The exit-cause log file inside `exitLogDir` (sibling to lifecycle.log).
 *  Lives here (not index.ts) so canary ⇆ launch never import-cycle; index.ts
 *  re-exports it, keeping the public import surface unchanged. */
export function exitLogPath(exitLogDir: string): string {
  return `${exitLogDir}/exits.log`
}

/** The per-identity tmux wait-for channel the clean-teardown paths signal. */
export function canaryChannel(identity: string): string {
  return `iap-canary-${identity}`
}

/** Forensics snapshots live next to exits.log: `<exitLogDir>/server-deaths/`. */
export function serverDeathsDir(exitLogDir: string): string {
  return join(exitLogDir, 'server-deaths')
}

export interface CanaryScriptOptions {
  identity: string
  sock: string
  /** Absolute tmux path — the detached canary may outlive any rich PATH. */
  tmuxBin: string
  exitLogFile: string
  forensicsDir: string
  /** The identity's tmux-cmdlog dir (<exitLogDir>/tmux-cmdlog/<identity>). When set,
   *  the death forensics tail the dead server's `tmux-server-<SPID>.log` — the ONLY
   *  witness of a client-COMMAND kill (`kill-server`/`kill-session`), which leaves zero
   *  signals (so signal forensics see nothing) and is otherwise wiped by the respawn's
   *  prepareCmdLogDir before anyone reads it. Best-effort: absent log → grep no-ops. */
  cmdLogDir?: string
}

/**
 * Build the canary shell script (PURE — unit-testable). Quoting: identity is a
 * runtime-personality (`[a-z0-9-]`), sock/log paths are ~/.iapeer-style (no
 * single quotes) — same assumption as exitCauseHook. All forensic tools are
 * /usr/bin- or /bin-resident, so the script survives launchd's minimal PATH;
 * only tmux needs the baked absolute path.
 */
export function canaryScript(o: CanaryScriptOptions): string {
  const ch = canaryChannel(o.identity)
  return [
    // Server PID captured while alive — the postmortem grep key for system logs.
    `SPID="$('${o.tmuxBin}' -S '${o.sock}' display-message -p '#{pid}' 2>/dev/null)"`,
    // A signal to the SH WRAPPER is deliberate dismissal (dismissCanary) or host
    // shutdown → silent. POSIX: the trap runs after the foreground command
    // completes — so a TERM delivered during wait-for/sleep always exits us
    // BEFORE any recording below (the race-free deliberate-silence guarantee).
    `trap 'exit 0' HUP INT TERM`,
    `'${o.tmuxBin}' -S '${o.sock}' wait-for '${ch}'`,
    `rc=$?`,
    // NO wait-for exit code is trusted as "deliberate" by itself — PROVEN live
    // (a death postmortem): a TERM to the tmux CLIENT returns rc=0, identical
    // to a clean channel signal, so an external killer sweeping server+client
    // rides the clean-looking code straight past any rc-based guard (v1's
    // `rc=0 || rc>=128 → silent` was exactly that hole). v2 contract instead:
    //   • deliberate teardowns DISMISS this sh (TERM → trap above) — the sleep
    //     below gives a concurrently-delivered dismissal time to win;
    //   • then the ORIGINAL SERVER PID's liveness, not the exit code, decides: alive →
    //     nothing to record (a lost canary is re-armed and logged by the
    //     supervise retrofit within a tick); original server dead and nobody
    //     dismissed us → the death is real and unclaimed → record it. IMPORTANT:
    //     check the ORIGINAL SPID, not merely "some server answers on the same
    //     socket". A wake/attach can replace the server inside this 2 s window;
    //     socket-liveness would then silently swallow the predecessor's death.
    `sleep 2`,
    `if [ -n "$SPID" ] && kill -0 "$SPID" 2>/dev/null; then exit 0; fi`,
    `if [ -z "$SPID" ] && '${o.tmuxBin}' -S '${o.sock}' has-session 2>/dev/null; then exit 0; fi`,
    // The exit code still ATTRIBUTES the recorded death (raw wait_rc is kept):
    //   rc=0   → signaled-server-gone   (channel signal or client-TERM, server died)
    //   rc≥128 → client-killed-server-gone (client took a non-TERM kill)
    //   else   → server-vanished        (connection drop — SIGKILL/OOM class)
    `cause=server-vanished`,
    `if [ "$rc" -eq 0 ]; then cause=signaled-server-gone; fi`,
    `if [ "$rc" -ge 128 ]; then cause=client-killed-server-gone; fi`,
    // The server is gone under us — record, within seconds of the death.
    `ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
    `f='${o.forensicsDir}/${o.identity}'-"$(date +%s)".txt`,
    `{`,
    `  echo "server-death identity=${o.identity} ts=$ts server_pid=$SPID wait_rc=$rc cause=$cause"`,
    `  echo '--- vm_stat'; vm_stat`,
    `  echo '--- swapusage'; /usr/sbin/sysctl -n vm.swapusage`,
    `  echo '--- ps-top-rss'; ps axo pid,ppid,rss,etime,command | sort -rn -k3 | head -25`,
    `  echo '--- diagnosticreports-user'; ls -t "$HOME/Library/Logs/DiagnosticReports" 2>/dev/null | head`,
    `  echo '--- diagnosticreports-system'; ls -t /Library/Logs/DiagnosticReports 2>/dev/null | head`,
    // The death-class discriminator signal-forensics structurally cannot see: a tmux
    // server killed by a CLIENT COMMAND (`kill-server`/`kill-session`) leaves zero
    // signals. Its only witness is the dead server's own -v cmdlog, which the respawn
    // wipes seconds later — captured HERE (canary fires ~+2 s, respawn ~+7 s) so the
    // killer's `client-<pid> command: …` survives into the forensics.
    ...(o.cmdLogDir
      ? [
          `  echo '--- cmdlog-tail (last client commands; a kill-server/kill-session here IS the killer)'`,
          `  tail -c 131072 '${o.cmdLogDir}/tmux-server-'"$SPID"'.log' 2>/dev/null | grep -aE 'command:' | tail -30`,
        ]
      : []),
    `} > "$f" 2>&1`,
    `printf 'ts=%s ev=server-exit identity=${o.identity} server_pid=%s wait_rc=%s cause=%s forensics=%s\\n' "$ts" "$SPID" "$rc" "$cause" "$f" >> '${o.exitLogFile}'`,
  ].join('\n')
}

export type CanaryEnsureState = 'spawned' | 'already' | 'skipped' | 'failed'

export interface EnsureCanaryOptions {
  identity: string
  sock: string
  /** Same gate as installExitHook: falsy → observability off, no canary. */
  exitLogDir?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Ensure ONE canary is watching this identity's tmux server. Idempotent via a
 * pgrep on the wait-for channel (anchored so an identity can never match another
 * identity's prefix). Called from launch (newborn server) and from the supervise
 * tick's alive-branch (retrofits canaries onto a fleet launched by older code —
 * coverage within one tick of a deploy, no session restarts). Best-effort:
 * every failure returns a state, never throws.
 */
export function ensureServerCanary(o: EnsureCanaryOptions): CanaryEnsureState {
  if (!o.exitLogDir) return 'skipped'
  const env = o.env ?? process.env
  try {
    const probe = spawnSync('pgrep', ['-f', `wait-for.*${canaryChannel(o.identity)}([^a-z0-9-]|$)`], {
      stdio: 'ignore',
      env: env as Record<string, string>,
    })
    if (probe.status === 0) return 'already'
    const tmuxBin = resolveExecutable('tmux', env)
    if (!tmuxBin) return 'failed'
    const forensicsDir = serverDeathsDir(o.exitLogDir)
    mkdirSync(forensicsDir, { recursive: true, mode: 0o700 })
    mkdirSync(o.exitLogDir, { recursive: true, mode: 0o700 })
    const script = canaryScript({
      identity: o.identity,
      sock: o.sock,
      tmuxBin,
      exitLogFile: exitLogPath(o.exitLogDir),
      forensicsDir,
      cmdLogDir: cmdLogDirFor(o.exitLogDir, o.identity),
    })
    const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore', env })
    child.unref()
    return 'spawned'
  } catch {
    return 'failed' // observability is best-effort — never block a launch/tick
  }
}

/**
 * Signal the canary that the upcoming server teardown is DELIBERATE (idle-reap /
 * stop / launch pre-clean / empty-server kill) so it exits silently instead of
 * recording a false server-death. Best-effort: no server / no canary on the
 * channel → harmless no-op.
 */
export function signalCanaryClean(sock: string, identity: string): void {
  try {
    spawnSync('tmux', ['-S', sock, 'wait-for', '-S', canaryChannel(identity)], { stdio: 'ignore' })
  } catch {
    /* best-effort */
  }
}

/** The pgrep/pkill ERE matching BOTH canary processes of ONE identity — the sh
 *  wrapper (its -c script quotes the channel: `…'iap-canary-<id>'…`) and the
 *  tmux client (argv ends with the bare channel). Anchored so an identity can
 *  never match another identity's prefix (claude-alice ≠ claude-alice-bob). */
export function canaryProcessPattern(identity: string): string {
  return `${canaryChannel(identity)}([^a-z0-9-]|$)`
}

/**
 * Dismiss this identity's canary BEFORE a deliberate server teardown: TERM the
 * sh wrapper (trap → silent exit, race-free — the trap always runs before the
 * v2 recording branch) and the tmux client. The explicit counterpart of the
 * channel signal: with v2 a signaled CLIENT alone is no longer read as
 * deliberate, so every deliberate path must dismiss the RECORDER (the sh).
 * Best-effort: no canary running → harmless no-op (pkill exits 1).
 */
export function dismissCanary(identity: string): void {
  try {
    spawnSync('pkill', ['-f', canaryProcessPattern(identity)], { stdio: 'ignore' })
  } catch {
    /* best-effort */
  }
}
