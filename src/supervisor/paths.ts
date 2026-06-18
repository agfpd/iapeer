// Supervisor session paths — under a configurable run dir (NOT hardcoded). Prod resolves it to
// ~/.iapeer/state/supervisor via the storage layer; tests pass a temp dir, so the daemon's
// socket/pid files never touch a real location.
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginStateDir } from '../storage/index.ts'

/** Default run dir for the supervisor's session sockets/pids: ~/.iapeer/state/supervisor. */
export function defaultRunDir(env: NodeJS.ProcessEnv = process.env): string {
  return pluginStateDir('supervisor', { env })
}

export const sockPath = (runDir: string, session: string): string => join(runDir, `${session}.sock`)
export const pidPath = (runDir: string, session: string): string => join(runDir, `${session}.pid`)
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

/** Remove the geometry sidecar (shutdown cleanup); best-effort. */
export function clearGeometry(runDir: string, session: string): void {
  try {
    unlinkSync(geometryPath(runDir, session))
  } catch {
    /* */
  }
}
