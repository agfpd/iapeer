// tmux command-log — the SOCKET-COMMAND observability layer of the killer hunt.
//
// Why (a session-death class): a tmux server killed by a
// CLIENT COMMAND (`kill-server` / `kill-session` over the unix socket) dies with
// zero signals — structurally invisible to ALL THREE existing layers: the eslogger
// trap (no kill(2) anywhere; kernel-originated SIGHUP to the panes is also proven
// invisible), the pane-died hook (kill-session destroys the pane without retention)
// and the server-death canary (sees only "server gone"). The tmux server's OWN
// verbose log is the only witness of that layer: started with `-v`, the server
// appends `message: client-<pid> command: <verb> <args>` for every client command —
// the attribution (client pid + exact command + timestamp) that decides the class
// binarily: "killed by client X" vs "no command ⇒ internal exit".
//
// Sensitivity: the -v log carries FULL send-keys payloads
// (every delivered envelope, plaintext) — tmux has no commands-only level and the
// server writes the file itself (name tmux-server-<pid>.log in the STARTING
// client's cwd — no FIFO/pipe interposition possible). Containment instead:
//   • the per-identity dir is 0700 (others cannot traverse — same protection class
//     as the transcripts that already hold the same texts);
//   • files are chmod'ed 0600 right after the server starts (hardenCmdLogDir);
//   • volume is capped: ~7 KB/s under a 10 fps TUI redraw (measured) — the
//     supervise tick tail-keeps each log over CAP_BYTES down to KEEP_BYTES.
//     tmux writes with O_APPEND (proven live: external truncation is safe, the
//     server keeps appending at the new EOF), and a killer's command is by nature
//     the LAST thing in the log — the death tail always survives capping.
//   • scope: agent-runtime (warm) sessions only — always-on infra sessions relaunch
//     rarely (no rotation point) and are not the dying class.
// Rotation: prepareCmdLogDir WIPES the identity dir on every launch — one server
// generation per dir, no unbounded accumulation across relaunches.
//
// Best-effort BY CONSTRUCTION: observability must never fail a launch or a
// supervise tick — every export swallows FS errors.

import { chmodSync, mkdirSync, openSync, closeSync, readSync, readdirSync, rmSync, statSync, writeFileSync, fstatSync } from 'fs'
import { join } from 'path'

/** Tail-keep cap: a log over CAP_BYTES is cut down to its last KEEP_BYTES. */
export const CMDLOG_CAP_BYTES = 8 * 1024 * 1024
export const CMDLOG_KEEP_BYTES = 1024 * 1024

/** Pane-log tail-keep cap (capPaneLogs): a per-identity pane-log over CAP is cut to
 *  its last KEEP. KEEP_BYTES INVARIANT — must stay ≥ the pane-log reader's seed
 *  window (readyGateModel SEED_BYTES = 4 MiB, the tail fed into the headless xterm
 *  for composer-occupancy / viewport detection); capping below it would starve that
 *  reader of the tail it reconstructs the live screen from. 8 MiB = 2× the seed. */
export const PANELOG_CAP_BYTES = 32 * 1024 * 1024
export const PANELOG_KEEP_BYTES = 8 * 1024 * 1024

const CMDLOG_SUBDIR = 'tmux-cmdlog'

/** The per-identity command-log dir: <eventLogDir>/tmux-cmdlog/<identity>. The
 *  session-creating tmux client runs FROM this dir with `-v`, so the server drops
 *  tmux-server-<pid>.log (and the client its tmux-client-*.log) here. */
export function cmdLogDirFor(eventLogDir: string, identity: string): string {
  return join(eventLogDir, CMDLOG_SUBDIR, identity)
}

/** Wipe + recreate the identity's command-log dir (0700) for a fresh server
 *  generation. Returns the dir, or undefined when the FS refuses (the caller then
 *  launches WITHOUT -v — observability is never load-bearing). */
export function prepareCmdLogDir(eventLogDir: string, identity: string): string | undefined {
  try {
    const dir = cmdLogDirFor(eventLogDir, identity)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return dir
  } catch {
    return undefined
  }
}

/** Clamp every file the freshly-started server/client dropped into the dir to
 *  0600 (the dir's 0700 already blocks traversal; this is the belt to that
 *  suspender — the acceptance criterion: no file wider than 0600). */
export function hardenCmdLogDir(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      try {
        chmodSync(join(dir, name), 0o600)
      } catch {
        /* per-file best-effort */
      }
    }
  } catch {
    /* dir gone — nothing to harden */
  }
}

/** Tail-keep ONE file: if it exceeds capBytes, rewrite it as its last keepBytes.
 *  Safe against a live O_APPEND writer (tmux `cat >>`, the supervisor append-fd):
 *  the next write lands at the new EOF (proven by live truncation test). Lines
 *  appended between the tail-read and the rewrite are lost — acceptable mid-life
 *  noise. Returns true iff the file was capped. Best-effort: swallows FS errors. */
function tailKeepFile(path: string, capBytes: number, keepBytes: number): boolean {
  try {
    if (statSync(path).size <= capBytes) return false
    const fd = openSync(path, 'r')
    let tail: Buffer
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - keepBytes)
      tail = Buffer.alloc(Math.min(keepBytes, size))
      readSync(fd, tail, 0, tail.length, start)
    } finally {
      closeSync(fd)
    }
    writeFileSync(path, tail, { mode: 0o600 })
    return true
  } catch {
    return false // per-file best-effort
  }
}

/** Tail-keep cap over every command log under <eventLogDir>/tmux-cmdlog/<identity>.
 *  A file over capBytes is rewritten as its last keepBytes. The death tail is never
 *  here because the peer is alive while being capped. */
export function capCmdLogs(
  eventLogDir: string,
  capBytes: number = CMDLOG_CAP_BYTES,
  keepBytes: number = CMDLOG_KEEP_BYTES,
): string[] {
  const capped: string[] = []
  let identities: string[]
  try {
    identities = readdirSync(join(eventLogDir, CMDLOG_SUBDIR))
  } catch {
    return capped
  }
  for (const identity of identities) {
    const dir = join(eventLogDir, CMDLOG_SUBDIR, identity)
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.endsWith('.log')) continue
      const path = join(dir, name)
      if (tailKeepFile(path, capBytes, keepBytes)) capped.push(path)
    }
  }
  return capped
}

/** Tail-keep cap over the per-identity PANE-LOGS (<logDir>/<identity>.log) — the RAW
 *  TUI byte stream that pipe-pane (tmux) / the supervisor append for a session's whole
 *  life. Unlike the lifecycle/delivery logs (their own size-rotation under logs/iapeer),
 *  the pane-log had NO bound and grew to hundreds of MB per warm peer on an always-on
 *  host. The supervise tick caps it here with the same tail-keep mechanism as the
 *  cmd-logs. logDir (logs/lifecycle) holds ONLY pane-logs, so only top-level *.log is
 *  touched — never the rotated logs elsewhere. KEEP_BYTES stays ≥ the reader seed
 *  window (see PANELOG_KEEP_BYTES). Best-effort by construction. */
export function capPaneLogs(
  logDir: string,
  capBytes: number = PANELOG_CAP_BYTES,
  keepBytes: number = PANELOG_KEEP_BYTES,
): string[] {
  const capped: string[] = []
  let names: string[]
  try {
    names = readdirSync(logDir)
  } catch {
    return capped
  }
  for (const name of names) {
    if (!name.endsWith('.log')) continue
    const path = join(logDir, name)
    if (tailKeepFile(path, capBytes, keepBytes)) capped.push(path)
  }
  return capped
}
