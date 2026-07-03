// Supervisor session paths — under a configurable run dir (NOT hardcoded). Prod resolves it to
// ~/.iapeer/state/supervisor via the storage layer; tests pass a temp dir, so the daemon's
// socket/pid files never touch a real location.
import { renameSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pluginStateDir } from '../storage/index.ts'

/** Default run dir for the supervisor's session sockets/pids: ~/.iapeer/state/supervisor. */
export function defaultRunDir(env: NodeJS.ProcessEnv = process.env): string {
  return pluginStateDir('supervisor', { env })
}

export const sockPath = (runDir: string, session: string): string => join(runDir, `${session}.sock`)
export const pidPath = (runDir: string, session: string): string => join(runDir, `${session}.pid`)

// ── pid-OWNERSHIP token (В22) ───────────────────────────────────────────────────
// kill(pid,0) proves SOME process holds the pid, not that it is STILL our daemon: after an abnormal
// death (SIGKILL/panic/reboot) the pidfile survives, and if the OS reuses that pid for another same-uid
// process, a bare kill(pid,0) reads the dead session as "alive" (peer undeliverable + unreapable) and a
// kill() would SIGTERM the innocent reuser. The pidfile therefore stores `<pid> <startToken>` where the
// token is the process's start time; a reused pid has a DIFFERENT start time, so ownership is verifiable.

/** The OS-reported start time of `pid` (a stable per-process-instance token), or null if it is not
 *  running / unreadable. `ps -o lstart=` is a single spawn — callers bound its frequency (see the
 *  liveness cache in client.ts).
 *
 *  LC_ALL=C is PINNED (split-brain live incident 03.07): `lstart` output is LOCALE-DEPENDENT, and the
 *  token is compared as a STRING between processes with different env — the writer (a supervisor
 *  inheriting the spawning terminal's locale, e.g. an operator's ru_RU `iapeer attach`) rendered
 *  «пятница, 3 июля …» while the verifying daemon (launchd env, C locale) rendered "Fri Jul  3 …"
 *  for the SAME start time → a PROVEN-looking mismatch → the live session read as a reused pid,
 *  got reaped, and the next message spawned a duplicate. Pinning the locale on BOTH the write and
 *  the verify path makes the token format process-env-independent. */
export function pidStartToken(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    })
    const t = (r.stdout ?? '').trim()
    return t.length > 0 ? t : null
  } catch {
    return null
  }
}

/**
 * Ownership verdict from a live-read token vs the recorded one — the ONE semantics both liveness
 * (`sessionAlive`) and kill (`killSession`) key on: the pid is ours unless a PROVEN mismatch.
 * `live === null` means the token could not be READ (a transient `ps` spawn failure — EAGAIN under a
 * post-reboot fork-storm, live incident 03.07: split-brain boris), NOT that the pid was reused; kill-0
 * has already proven a live pid, so an unverifiable token must stay fail-SAFE (alive / still ours).
 * Before this primitive, sessionAlive required `live !== null && live === token` (fail-open: a tool
 * hiccup read a LIVE supervisor as dead → every wake spawned a duplicate session and orphaned the
 * previous one by overwriting the pidfile), while killSession already treated null as "ours".
 */
export function ownershipVerdict(live: string | null, recorded: string): boolean {
  return live === null ? true : live === recorded
}

/** Write the pidfile as `<pid> <startToken>` (В22). Falls back to bare `<pid>` if the token is
 *  unavailable — a tokenless pidfile is treated as legacy (owner-check skipped, kill-0 only). */
export function writePidFile(runDir: string, session: string, pid: number): void {
  const token = pidStartToken(pid)
  writeFileSync(pidPath(runDir, session), token ? `${pid} ${token}` : String(pid))
}

/** Parse the pidfile → { pid, token } (token '' for a legacy bare-pid file). null when absent/invalid. */
export function readPidFile(runDir: string, session: string): { pid: number; token: string } | null {
  let raw: string
  try {
    raw = readFileSync(pidPath(runDir, session), 'utf8').trim()
  } catch {
    return null
  }
  if (!raw) return null
  const sp = raw.indexOf(' ')
  const pid = Number(sp < 0 ? raw : raw.slice(0, sp))
  if (!Number.isInteger(pid) || pid <= 0) return null
  return { pid, token: sp < 0 ? '' : raw.slice(sp + 1).trim() }
}
export const logPath = (runDir: string, session: string): string => join(runDir, `${session}.log`)
/** Serving spec (cutover Block 2 slice b): the composed {argv, env, cwd} a detached daemon serves.
 *  Written 0600 by startSupervisorDaemon BEFORE spawn (env can carry launch.env secrets), read by
 *  the daemon CLI entry, removed on shutdown. Absent → a bare throwaway/tick session. */
export const servePath = (runDir: string, session: string): string => join(runDir, `${session}.serve.json`)
/** Attached-client marker (spawn-flip Ф0b-3 slice 3c): present iff ≥1 supervisor client is attached.
 *  The daemon maintains it on every client add/delete; the warm-deliver path (a DIFFERENT process)
 *  reads it to gate the hosted busy-composer hold — never paste over a HUMAN's unfinished input, but
 *  never hold for the AI's own composer output when no operator is attached. */
export const attachedPath = (runDir: string, session: string): string => join(runDir, `${session}.attached`)

/** Geometry sidecar (emulator-model fix): the CURRENT child pty geometry of a hosted session. The
 *  supervisor (the only process that resizes the child) writes it after every successful resize; the
 *  warm-deliver / ready-gate readers in OTHER processes read it to build their pane-log viewport model at
 *  the session's actual size instead of assuming the fixed HOST geometry. Critical because a detached
 *  session is NO LONGER reverted to serve geometry (that revert caused claude to reflow into a tiny
 *  viewport → duplicate scrollback) — so the child can sit at the last client's size, and readers must
 *  follow it. Absent / unreadable → readers fall back to HOST geometry. */
export const geometryPath = (runDir: string, session: string): string => join(runDir, `${session}.geometry.json`)

/** Atomically (temp + rename) record the current child geometry — best-effort, never throws (a hint file). */
export function writeGeometry(runDir: string, session: string, cols: number, rows: number): void {
  const p = geometryPath(runDir, session)
  try {
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ cols, rows }), { mode: 0o600 })
    renameSync(tmp, p)
  } catch {
    /* best-effort: a geometry hint never blocks serving */
  }
}

/** Read the current child geometry of a hosted session; null when absent / unreadable / invalid. */
export function readGeometry(runDir: string, session: string): { cols: number; rows: number } | null {
  try {
    const o = JSON.parse(readFileSync(geometryPath(runDir, session), 'utf8')) as { cols?: unknown; rows?: unknown }
    if (typeof o.cols === 'number' && typeof o.rows === 'number' && o.cols > 0 && o.rows > 0) {
      return { cols: o.cols, rows: o.rows }
    }
  } catch {
    /* absent / malformed → caller falls back to HOST */
  }
  return null
}
