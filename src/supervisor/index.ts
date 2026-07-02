// Supervisor entry + CLI dispatch (cutover Block 2, ported from PoC pts.mjs). DARK: this module
// (and daemon.ts/client.ts) load @xterm — they are reachable ONLY via the `supervisor` CLI verb
// (dynamic import) and are NOT imported by transport/lifecycle/launch/daemon. The supervisor
// serves NOTHING on the live fleet; it is validated on throwaway `tick` sessions in-repo. When
// serving is productionized (a later block) the daemon-spawn argv is repointed at the installed
// binary; for now it self-spawns from source (bun + this file), which is what the tests exercise.
import { spawn as nodeSpawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runSupervisorClient, sessionAlive } from './client.ts'
import { defaultRunDir, logPath, pidPath, pidStartToken, readPidFile, servePath, sockPath } from './paths.ts'

// daemon.ts loads @xterm. It is dynamic-imported ONLY in the 'daemon' CLI case below (the detached
// daemon process, where @xterm belongs), so importing THIS module — e.g. launch resolving
// startSupervisorDaemon to host a flag-on peer — never pulls @xterm into the launch hot path.
export { runSupervisorClient, sessionAlive } from './client.ts'
export { defaultRunDir, sockPath, pidPath } from './paths.ts'

/** The composed invocation a detached daemon serves (slice b): buildLaunchInvocation output + the
 *  resolved cwd. Serialized to `<runDir>/<session>.serve.json` (0600) so the detached daemon process
 *  picks it up — the seam by which launch hands the supervisor a real session at the spawn-flip. */
export interface ServeSpec {
  argv: string[]
  env: Record<string, string>
  cwd: string
  /** Pane-log path (slice c): `<logDir>/<identity>.log` — where the daemon appends the child's raw
   *  output, byte-identical to tmux pipe-pane, so the observer/shadow read a served session's log. */
  paneLogPath?: string
  /** Exit-cause log (spawn-flip Ф0b): exits.log — the daemon appends the child's death cause here. */
  exitLogPath?: string
  /** Pty geometry (spawn-flip Ф0a): match the tmux launch's 220x50 so the served child + the pane-log
   *  model render at the SAME size launch reads readiness at. Unset → daemon default (80x30). */
  cols?: number
  rows?: number
}

export interface StartDaemonOptions {
  session: string
  runtime: string
  runDir: string
  /** How to launch the detached daemon process (default: bun + this file). The trailing
   *  `daemon <session> <runtime> --run-dir <runDir>` is appended. Serving-prod injects the
   *  installed-binary argv here. */
  daemonArgv?: string[]
  /** Composed invocation to SERVE (slice b). When set, written to the serve-spec file before spawn so
   *  the detached daemon serves it; absent → a bare conduit (throwaway/tick). */
  serve?: ServeSpec
  /** Max ms to wait for the daemon socket+pid to appear (default 5000). */
  timeoutMs?: number
}

/** Read the serve-spec for a detached daemon, or undefined for a bare session. */
function readServeSpec(runDir: string, session: string): ServeSpec | undefined {
  try {
    const s = JSON.parse(readFileSync(servePath(runDir, session), 'utf8')) as ServeSpec
    if (Array.isArray(s.argv) && s.env && typeof s.cwd === 'string') return s
  } catch {
    /* no / invalid serve spec → bare session */
  }
  return undefined
}

export interface StartDaemonResult {
  state: 'started' | 'already-running' | 'failed'
  pid?: number
  detail?: string
}

/**
 * Re-invoke THIS module as the detached daemon (spawn-flip Ф1 serving-wiring). From SOURCE (bun) the
 * module is a real file on disk → run it directly (`bun <self> daemon …` → import.meta.main →
 * runSupervisorCli). In a `bun build --compile` STANDALONE the module is EMBEDDED at a `/$bunfs`
 * virtual path that is NOT on disk; a bare `<binary> <bunfs-path> daemon …` invocation mis-routes
 * through the CLI (the path becomes an unknown verb → usage, daemon never comes up — and a hosted
 * launch then silently falls back to tmux). Detect that (the resolved self path is absent on disk) and
 * re-invoke the installed binary through its `supervisor` verb instead. The caller appends
 * `daemon <session> <runtime> --run-dir <dir>`, so runSupervisorCli is reached either way.
 */
export function resolveDaemonSelfArgv(execPath: string, selfPath: string): string[] {
  // A `bun build --compile` standalone embeds this module at a `/$bunfs/root/…` virtual path
  // (verified: import.meta.url → file:///$bunfs/root/…). `existsSync` is NO discriminator — Bun
  // intercepts bunfs reads so it is true for BOTH src and compiled. The `$bunfs` marker in the self
  // path IS the discriminator: compiled → re-invoke the installed binary through its `supervisor` verb
  // (the caller appends `daemon …`); source → a real on-disk file, run it directly via the runtime.
  return selfPath.includes('$bunfs') ? [execPath, 'supervisor'] : [execPath, selfPath]
}
const selfArgv = (): string[] => resolveDaemonSelfArgv(process.execPath, fileURLToPath(import.meta.url))

/** Start a detached supervisor daemon and wait until its socket is live. Idempotent.
 *  Async: the socket-wait yields the event loop (a sync busy-wait here froze the whole
 *  router daemon for the bring-up window on every warm wake). */
export async function startSupervisorDaemon(opts: StartDaemonOptions): Promise<StartDaemonResult> {
  const { session, runtime, runDir } = opts
  if (sessionAlive(runDir, session)) return { state: 'already-running' }
  mkdirSync(runDir, { recursive: true })
  try {
    if (existsSync(sockPath(runDir, session))) unlinkSync(sockPath(runDir, session))
  } catch {
    /* */
  }
  // Serving seam (slice b): persist the composed invocation BEFORE spawn so the detached daemon serves
  // it. 0600 — env may carry launch.env secrets. A stale spec from a prior run is overwritten or cleared.
  if (opts.serve) writeFileSync(servePath(runDir, session), JSON.stringify(opts.serve), { mode: 0o600 })
  else
    try {
      unlinkSync(servePath(runDir, session))
    } catch {
      /* no stale spec */
    }
  const out = openSync(logPath(runDir, session), 'a')
  const argv = opts.daemonArgv ?? selfArgv()
  const child = nodeSpawn(argv[0]!, [...argv.slice(1), 'daemon', session, runtime, '--run-dir', runDir], {
    detached: true,
    stdio: ['ignore', out, out],
  })
  // The child dup'd `out` at spawn — close the PARENT copy immediately. This function
  // runs inside the always-on router daemon on EVERY warm wake; an unclosed fd here bled
  // the daemon ~1 fd/wake toward EMFILE (live-observed) → eventual full routing outage.
  try {
    closeSync(out)
  } catch {
    /* */
  }
  child.unref()
  const deadline = Date.now() + (opts.timeoutMs ?? 5000)
  while (Date.now() < deadline) {
    if (existsSync(sockPath(runDir, session)) && sessionAlive(runDir, session)) {
      return { state: 'started', pid: readPidFile(runDir, session)?.pid }
    }
    await Bun.sleep(80) // yield the loop — never a sync block in the daemon's wake path
  }
  // Failed to come up in time. В20 — KILL the spawned child FIRST. A merely-slow child that becomes the
  // daemon AFTER we unlink the serve-spec would readServeSpec → undefined → come up as a BARE CONDUIT
  // ([bin] runtime with NO PEER_IDENTITY / composed argv / doctrine) that captures the peer's identity:
  // liveness then reads it "online", messages route into an identity-less session, and if it slipped
  // past enroll-on-FAILED it is invisible to idle-reap (an unbounded orphan). Better a dead peer (the
  // next wake respawns clean) than an identity-less conduit. Kill, THEN drop the spec + any stale
  // sock/pid the dying child created (SIGKILL skips the child's own cleanup).
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
  if (opts.serve)
    try {
      unlinkSync(servePath(runDir, session))
    } catch {
      /* */
    }
  for (const p of [sockPath(runDir, session), pidPath(runDir, session)]) {
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* best-effort */
    }
  }
  return { state: 'failed', detail: `daemon did not come up; see ${logPath(runDir, session)}` }
}

export function listSessions(runDir: string): Array<{ session: string; alive: boolean; pid?: number }> {
  if (!existsSync(runDir)) return []
  return readdirSync(runDir)
    .filter(f => f.endsWith('.sock'))
    .map(f => f.replace(/\.sock$/, ''))
    .map(session => {
      const alive = sessionAlive(runDir, session)
      return { session, alive, pid: alive ? readPidFile(runDir, session)?.pid : undefined }
    })
}

export function killSession(runDir: string, session: string): boolean {
  const rec = readPidFile(runDir, session)
  if (!rec) return false
  // В22 — verify the pid is STILL our daemon before SIGTERM. After an abnormal death + pid reuse, a bare
  // kill here would SIGTERM the INNOCENT process that inherited the pid. Skip the kill when the start-token
  // no longer matches (a legacy tokenless pidfile keeps the old behavior — no regression during rollout).
  if (rec.token) {
    const live = pidStartToken(rec.pid)
    if (live !== null && live !== rec.token) return false // reused pid — NOT our session; do not signal it
  }
  try {
    process.kill(rec.pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
  return true
}

/** Parse a `--run-dir <dir>` flag out of an argv slice; returns the value or the default. */
function runDirFrom(args: string[]): string {
  const i = args.indexOf('--run-dir')
  return i >= 0 && args[i + 1] ? args[i + 1]! : defaultRunDir()
}

/** CLI dispatch (also the `import.meta.main` entry used by the spawned daemon process). */
export async function runSupervisorCli(argv: string[]): Promise<number> {
  const [cmd, a, b] = argv
  const runDir = runDirFrom(argv)
  switch (cmd) {
    case 'daemon': {
      // Serving seam (slice b): a serve-spec → serve the launch-composed argv/env/cwd; else bare.
      const serve = readServeSpec(runDir, a!)
      // @xterm loads HERE — in the detached daemon process only (dynamic import keeps it out of any
      // caller that merely resolves startSupervisorDaemon, e.g. the launch hot path).
      const { runSupervisorDaemon } = await import('./daemon.ts')
      runSupervisorDaemon({
        session: a!,
        runtime: b || 'claude',
        runDir,
        ...(serve
          ? {
              argv: serve.argv,
              env: serve.env,
              cwd: serve.cwd,
              paneLogPath: serve.paneLogPath,
              exitLogPath: serve.exitLogPath,
              cols: serve.cols,
              rows: serve.rows,
            }
          : {}),
      })
      // The daemon is event-driven: runSupervisorDaemon RETURNS after wiring the pty + socket
      // server, and the event loop keeps the process alive. Await a never-resolving promise so the
      // caller's `process.exit` does NOT fire — shutdown() (child-exit / SIGTERM) owns the exit.
      await new Promise<never>(() => {})
      return 0 // unreachable
    }
    case 'start': {
      const r = await startSupervisorDaemon({ session: a!, runtime: b || 'claude', runDir })
      console.log(`${r.state}${r.pid ? ` pid=${r.pid}` : ''}${r.detail ? ` — ${r.detail}` : ''}: ${a}`)
      return r.state === 'failed' ? 1 : 0
    }
    case 'attach':
      await runSupervisorClient(runDir, a!)
      return 0
    case 'up': {
      const r = await startSupervisorDaemon({ session: a!, runtime: b || 'claude', runDir })
      if (r.state === 'failed') {
        console.error(r.detail)
        return 1
      }
      await runSupervisorClient(runDir, a!)
      return 0
    }
    case 'list':
      for (const s of listSessions(runDir)) console.log(`${s.session}\t${s.alive ? `running pid=${s.pid}` : 'dead'}`)
      return 0
    case 'kill':
      console.log(killSession(runDir, a!) ? `killed "${a}"` : `no session "${a}"`)
      return 0
    default:
      console.log('usage: supervisor up|start|attach|list|kill <session> [runtime] [--run-dir <dir>]   (detach: Ctrl-])')
      return 0
  }
}

if (import.meta.main) {
  process.exit(await runSupervisorCli(process.argv.slice(2)))
}
