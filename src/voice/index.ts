// Native Codex voice — open / close / status of the `/voice` realtime conversation inside a LIVE
// codex peer session, plus the idle-close sweep the daemon runs (docs/22-voice.md).
//
// WHAT WE DRIVE. codex-cli's TUI owns a realtime voice conversation on the CURRENT thread
// (tui/src/chatwidget/realtime.rs, rust-v0.163.0): `/voice` TOGGLES it, `/voice stop` closes it
// (no-op when Inactive/Stopping — idempotent), `/voice mute` only mutes the microphone and keeps the
// session up. There is no programmatic API on a TUI session, so we are its keyboard, exactly like
// `iapeer goal`. Because `/voice` is a TOGGLE, it is typed ONLY after observing the state is closed,
// under a per-peer lock — a second `/voice` on an open session would CLOSE it.
//
// WHAT WE OBSERVE (never our own keystrokes as proof):
//   1. AUDIO OWNERSHIP — codex runs each voice session in a separate helper process
//      `codex-voice-host` (realtime-webrtc/src/client.rs spawns it; it holds the CoreAudio mic and
//      speaker and is terminated on close). The number of such processes in the peer's supervised
//      process tree IS the number of live voice sessions. Zero ⇔ audio released. This is the ground
//      truth `state:"closed"` is gated on — the consumer (voicetalk-runtime) takes the microphone
//      back ONLY on it.
//   2. SESSION RECEIPTS — the thread's own rollout (history_mode=paginated, the default since
//      0.160) records `realtime_item` lines: `realtime_session_started{id}`,
//      `transcript_segment{role,text}` per utterance of EITHER side, `realtime_session_closed
//      {outcome}`. Delegated work shows as `task_started{turn_attribution.turn_trigger:"realtime"}`
//      → `task_complete`. Seen live on this host 26.10.2026 (linus, thread 01a159bf…).
//   3. INTENT — what WE asked for and when (state/lifecycle/voice/<identity>.json). Intent alone is
//      never a receipt; it only bridges the window between a keystroke and the helper's spawn, so a
//      caller killed mid-open (SIGKILL) still leaves a status that converges to the truth.
//
// IDLE. Codex has no idle timeout of its own (nothing in realtime_conversation.rs / realtime.rs).
// The conversation is idle when no transcript segment (either side), session start, or turn
// boundary happened for `idleSecs` AND no turn is running — a delegated task the user is waiting for
// is not idleness. The daemon sweep closes only sessions WE opened (intent present); a voice session
// a human opened by hand in an attached pane is his.

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readFirstLine } from '../launch/adapters/transcriptTail.ts'
import { readSessionSlices } from '../daemon/sessionfiles.ts'
import { readPidFile, defaultRunDir } from '../supervisor/paths.ts'

export type VoiceState = 'open' | 'opening' | 'closing' | 'closed'
export type VoiceCloseReason = 'idle' | 'user' | 'error' | 'requested'

/** One process row: enough to walk the supervised tree and name the helper. */
export interface ProcRow { pid: number; ppid: number; comm: string }

/** What the thread's rollout says about voice (the receipts side). */
export interface RolloutVoice {
  /** Newest `realtime_session_started`. */
  started?: { id: string; atMs: number }
  /** Newest `realtime_session_closed`. */
  closed?: { id: string; atMs: number; outcome?: string }
  /** Newest conversational evidence: start, a transcript segment of either side, a turn boundary. */
  lastActivityMs: number
  /** A turn is running (last boundary is task_started) — waiting for requested work is not idle. */
  turnRunning: boolean
  /** Rollout session id (= thread id). */
  threadId?: string
}

/** Intent we persisted. Not a receipt. */
export interface VoiceIntent {
  op: 'open' | 'close'
  atMs: number
  reason?: VoiceCloseReason
  /** Last observed session id, for status continuity. */
  session?: string
  /** Last confirmed close (status `reason`). */
  lastClose?: { reason: VoiceCloseReason; atMs: number; session?: string }
}

export interface VoiceObservation {
  /** The peer's codex session is live (supervisor + codex child found). */
  live: boolean
  codexPid?: number
  /** codex-voice-host helper pids in the supervised tree. */
  hosts: number[]
  rollout: RolloutVoice | null
  rolloutPath?: string
}

export interface VoiceStatus {
  state: VoiceState
  session?: string
  reason?: VoiceCloseReason
  /** Diagnostics: helper count — the "exactly one" receipt. */
  hosts: number
  live: boolean
  idleMs?: number
  turnRunning?: boolean
}

/** Window between typing `/voice` and the helper being observable; covers a SIGKILLed caller. */
export const OPEN_GRACE_MS = 12_000
export const OPEN_TIMEOUT_MS = 18_000
export const CLOSE_TIMEOUT_MS = 10_000
export const DEFAULT_IDLE_SECS = 90
const POLL_MS = 250
const ROLLOUT_TAIL_BYTES = 4 * 1024 * 1024

// ─────────────────────────────────────────────────────────────────────────────
// Pure parts (unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

/** Parse the rollout tail into voice receipts + activity. Torn lines are not evidence. */
export function parseRolloutVoice(text: string): RolloutVoice {
  const out: RolloutVoice = { lastActivityMs: 0, turnRunning: false }
  let boundaryAt = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let r: { type?: string; timestamp?: string; payload?: Record<string, unknown> }
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(r.timestamp ?? '')
    if (!Number.isFinite(at)) continue
    const p = (r.payload ?? {}) as Record<string, unknown>
    if (r.type === 'session_meta' && typeof p.id === 'string') out.threadId = p.id
    if (r.type === 'realtime_item') {
      const id = typeof p.id === 'string' ? p.id : ''
      if (p.type === 'realtime_session_started') {
        out.started = { id, atMs: at }
        out.lastActivityMs = Math.max(out.lastActivityMs, at)
      } else if (p.type === 'realtime_session_closed') {
        out.closed = { id, atMs: at, ...(typeof p.outcome === 'string' ? { outcome: p.outcome } : {}) }
      } else if (p.type === 'transcript_segment') {
        out.lastActivityMs = Math.max(out.lastActivityMs, at)
      }
      continue
    }
    if (r.type === 'event_msg' && (p.type === 'task_started' || p.type === 'task_complete' || p.type === 'turn_aborted')) {
      out.lastActivityMs = Math.max(out.lastActivityMs, at)
      if (at >= boundaryAt) {
        boundaryAt = at
        out.turnRunning = p.type === 'task_started'
      }
    }
  }
  return out
}

/** Is the rollout's newest realtime session still open (started after the newest close)? */
export function rolloutSessionOpen(r: RolloutVoice | null): boolean {
  return !!r?.started && (!r.closed || r.closed.atMs < r.started.atMs)
}

/** All descendants of `root` (exclusive) in a process table. */
export function descendants(rows: ProcRow[], root: number): ProcRow[] {
  const kids = new Map<number, ProcRow[]>()
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r])
  const out: ProcRow[] = []
  const stack = [root]
  const seen = new Set<number>()
  while (stack.length) {
    const pid = stack.pop()!
    for (const k of kids.get(pid) ?? []) {
      if (seen.has(k.pid)) continue
      seen.add(k.pid)
      out.push(k)
      stack.push(k.pid)
    }
  }
  return out
}

export const isVoiceHost = (r: ProcRow): boolean => basename(r.comm) === 'codex-voice-host'
export const isCodex = (r: ProcRow): boolean => basename(r.comm) === 'codex'

/**
 * Derive the contract state from observation + intent. The ONLY path to `closed` is "no helper
 * process" (audio released) with no fresh open intent still inside its grace window.
 */
export function deriveVoiceStatus(obs: VoiceObservation, intent: VoiceIntent | null, nowMs: number): VoiceStatus {
  const r = obs.rollout
  const base = { hosts: obs.hosts.length, live: obs.live }
  const sessionOpen = rolloutSessionOpen(r)
  const session = sessionOpen ? r!.started!.id : intent?.session
  if (obs.hosts.length > 0) {
    if (intent?.op === 'close') return { ...base, state: 'closing', ...(session ? { session } : {}) }
    // The backend start lands in the rollout a beat after the helper spawns; a started item older
    // than our open intent belongs to a PREVIOUS session.
    const startedForThis = sessionOpen && (!intent || intent.op !== 'open' || r!.started!.atMs >= intent.atMs - 1000)
    if (!startedForThis) return { ...base, state: 'opening' }
    const idleMs = Math.max(0, nowMs - Math.max(r!.lastActivityMs, intent?.op === 'open' ? intent.atMs : 0))
    return { ...base, state: 'open', session: r!.started!.id, idleMs, turnRunning: r!.turnRunning }
  }
  // No helper: audio is released.
  // Grace only for an UNCONFIRMED open (no session recorded yet): a confirmed session whose helper
  // is gone is closed, whatever its age.
  if (intent?.op === 'open' && !intent.session && nowMs - intent.atMs < OPEN_GRACE_MS && !(sessionOpen && r!.started!.atMs >= intent.atMs - 1000)) {
    return { ...base, state: 'opening' }
  }
  const reason = intent?.lastClose?.reason
  return { ...base, state: 'closed', ...(intent?.lastClose?.session ? { session: intent.lastClose.session } : {}), ...(reason ? { reason } : {}) }
}

/** Should the idle sweep close this session now? */
export function shouldIdleClose(st: VoiceStatus, idleSecs: number): boolean {
  return st.state === 'open' && !st.turnRunning && (st.idleMs ?? 0) >= idleSecs * 1000
}

// ─────────────────────────────────────────────────────────────────────────────
// Effects (injectable)
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceDeps {
  env: NodeJS.ProcessEnv
  /** Directory for intent + lock files (cfg.stateDir/voice). */
  stateDir: string
  /** Supervisor run dir (pidfiles). */
  runDir?: string
  procTable?: () => ProcRow[]
  /** Open rollout of a codex pid (lsof). */
  openRollout?: (pid: number) => string | null
  readTail?: (path: string) => string
  /** Type the control into the live session. */
  control: (args: string[]) => Promise<{ ok: boolean; error?: string }>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  idleSecs?: number
  openTimeoutMs?: number
  closeTimeoutMs?: number
  log?: (ev: Record<string, unknown>) => void
}

export function defaultProcTable(): ProcRow[] {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  if (r.error || r.status !== 0) throw new Error('could not read the process table')
  return r.stdout.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3]! }] : []
  })
}

const canonical = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** The rollout the codex process holds open — the CURRENT thread, not the newest file by mtime. */
export function defaultOpenRollout(env: NodeJS.ProcessEnv): (pid: number) => string | null {
  return pid => {
    const sessions = join(canonical(env.CODEX_HOME || join(env.HOME ?? '', '.codex')), 'sessions')
    const r = spawnSync('/usr/sbin/lsof', ['-Fn', '-a', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })
    const files = [...new Set((r.stdout ?? '').split('\n').filter(l => l.startsWith(`n${sessions}/`) && l.endsWith('.jsonl')).map(l => l.slice(1)))]
    return files.length === 1 ? files[0]! : null
  }
}

const intentPath = (d: VoiceDeps, identity: string) => join(d.stateDir, `${identity}.json`)
const lockPath = (d: VoiceDeps, identity: string) => join(d.stateDir, `${identity}.lock`)

export function readIntent(d: VoiceDeps, identity: string): VoiceIntent | null {
  try {
    const v = JSON.parse(readFileSync(intentPath(d, identity), 'utf8'))
    return v && (v.op === 'open' || v.op === 'close') && Number.isFinite(v.atMs) ? v : null
  } catch {
    return null
  }
}

export function writeIntent(d: VoiceDeps, identity: string, v: VoiceIntent): void {
  mkdirSync(d.stateDir, { recursive: true })
  const p = intentPath(d, identity)
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 })
  renameSync(tmp, p)
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Per-peer exclusive lock; a lock whose holder died is stolen. null = held by a live process. */
export function acquireLock(d: VoiceDeps, identity: string): (() => void) | null {
  mkdirSync(d.stateDir, { recursive: true })
  const p = lockPath(d, identity)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => {
        try {
          if (readFileSync(p, 'utf8').trim() === String(process.pid)) unlinkSync(p)
        } catch {
          /* already gone */
        }
      }
    } catch {
      let holder = 0
      try {
        holder = Number(readFileSync(p, 'utf8').trim())
      } catch {
        /* raced */
      }
      if (holder > 0 && holder !== process.pid && pidAlive(holder)) return null
      try {
        unlinkSync(p)
      } catch {
        /* raced */
      }
    }
  }
  return null
}

/** Observe one codex peer identity (`codex-<personality>`). */
export function observeVoice(d: VoiceDeps, identity: string): VoiceObservation {
  const runDir = d.runDir ?? defaultRunDir(d.env)
  const sup = readPidFile(runDir, identity)
  const rows = (d.procTable ?? defaultProcTable)()
  if (!sup || !rows.some(r => r.pid === sup.pid)) return { live: false, hosts: [], rollout: null }
  const tree = descendants(rows, sup.pid)
  const codex = tree.find(r => r.ppid === sup.pid && isCodex(r)) ?? tree.find(isCodex)
  const hosts = tree.filter(isVoiceHost).map(r => r.pid)
  if (!codex) return { live: false, hosts, rollout: null }
  const path = (d.openRollout ?? defaultOpenRollout(d.env))(codex.pid)
  let rollout: RolloutVoice | null = null
  if (path) {
    const tail = d.readTail ? d.readTail(path) : (readSessionSlices(path, ROLLOUT_TAIL_BYTES)?.tail ?? '')
    rollout = parseRolloutVoice(tail)
    if (!rollout.threadId) {
      try {
        const meta = JSON.parse(readFirstLine(path) ?? '{}')
        if (typeof meta?.payload?.id === 'string') rollout.threadId = meta.payload.id
      } catch {
        /* no id */
      }
    }
  }
  return { live: true, codexPid: codex.pid, hosts, rollout, ...(path ? { rolloutPath: path } : {}) }
}

export function voiceStatus(d: VoiceDeps, identity: string): VoiceStatus {
  return deriveVoiceStatus(observeVoice(d, identity), readIntent(d, identity), (d.now ?? Date.now)())
}

export interface VoiceReceipt {
  ok: boolean
  state: VoiceState
  session?: string
  already?: boolean
  reason?: VoiceCloseReason
  error?: string
  hosts?: number
}

const sleeper = (d: VoiceDeps) => d.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))

async function waitFor(d: VoiceDeps, identity: string, timeoutMs: number, done: (s: VoiceStatus) => boolean): Promise<VoiceStatus> {
  const now = d.now ?? Date.now
  const deadline = now() + timeoutMs
  let s = voiceStatus(d, identity)
  while (!done(s) && now() < deadline) {
    await sleeper(d)(POLL_MS)
    s = voiceStatus(d, identity)
  }
  return s
}

/** Close under an already-held lock. Receipt ok ⇔ observed closed (helper gone). */
async function closeLocked(d: VoiceDeps, identity: string, reason: VoiceCloseReason): Promise<VoiceReceipt> {
  const now = d.now ?? Date.now
  const before = voiceStatus(d, identity)
  const prev = readIntent(d, identity)
  const session = before.session ?? prev?.session
  if (before.state === 'closed') {
    // Nothing live — still clear a stale open intent so status stops reporting it.
    if (prev && prev.op !== 'close') writeIntent(d, identity, { op: 'close', atMs: now(), reason, ...(session ? { session } : {}), lastClose: { reason, atMs: now(), ...(session ? { session } : {}) } })
    return { ok: true, state: 'closed', already: true, ...(before.reason ? { reason: before.reason } : {}), hosts: 0 }
  }
  writeIntent(d, identity, { op: 'close', atMs: now(), reason, ...(session ? { session } : {}), ...(prev?.lastClose ? { lastClose: prev.lastClose } : {}) })
  // `/voice stop` is idempotent in codex (Inactive/Stopping → no-op) — safe even if state raced.
  const sent = await d.control(['stop'])
  if (!sent.ok) {
    const s = voiceStatus(d, identity)
    return { ok: false, state: s.state, error: `could not type /voice stop: ${sent.error ?? 'control failed'}`, hosts: s.hosts }
  }
  const s = await waitFor(d, identity, d.closeTimeoutMs ?? CLOSE_TIMEOUT_MS, x => x.hosts === 0)
  if (s.hosts === 0) {
    writeIntent(d, identity, { op: 'close', atMs: now(), reason, ...(session ? { session } : {}), lastClose: { reason, atMs: now(), ...(session ? { session } : {}) } })
    d.log?.({ ev: 'voice-closed', identity, reason, ...(session ? { session } : {}) })
    return { ok: true, state: 'closed', reason, ...(session ? { session } : {}), hosts: 0 }
  }
  return { ok: false, state: 'closing', error: `voice helper still running ${d.closeTimeoutMs ?? CLOSE_TIMEOUT_MS}ms after /voice stop`, hosts: s.hosts }
}

/** Lock with a bounded wait (a concurrent open/close/sweep finishes within its own timeouts). */
async function withLock<T extends VoiceReceipt>(d: VoiceDeps, identity: string, fn: () => Promise<T>, busy: () => T): Promise<T> {
  const now = d.now ?? Date.now
  const deadline = now() + (d.openTimeoutMs ?? OPEN_TIMEOUT_MS) + (d.closeTimeoutMs ?? CLOSE_TIMEOUT_MS)
  let release = acquireLock(d, identity)
  while (!release && now() < deadline) {
    await sleeper(d)(POLL_MS)
    release = acquireLock(d, identity)
  }
  if (!release) return busy()
  try {
    return await fn()
  } finally {
    release()
  }
}

export async function openVoice(d: VoiceDeps, identity: string): Promise<VoiceReceipt> {
  return withLock<VoiceReceipt>(d, identity, async (): Promise<VoiceReceipt> => {
    const now = d.now ?? Date.now
    let s = voiceStatus(d, identity)
    if (!s.live) return { ok: false, state: s.state, error: 'codex session is not live', hosts: s.hosts }
    // Settle a transition someone else left behind before deciding (never type a toggle blind).
    if (s.state === 'opening' || s.state === 'closing') s = await waitFor(d, identity, d.openTimeoutMs ?? OPEN_TIMEOUT_MS, x => x.state === 'open' || x.state === 'closed')
    if (s.state === 'open') {
      if (s.hosts > 1) return { ok: false, state: 'open', session: s.session, error: `${s.hosts} voice helpers running — expected exactly one`, hosts: s.hosts }
      return { ok: true, state: 'open', session: s.session, already: true, hosts: s.hosts }
    }
    if (s.state !== 'closed') return { ok: false, state: s.state, error: 'voice is stuck in a transition', hosts: s.hosts }
    const prev = readIntent(d, identity)
    const atMs = now()
    writeIntent(d, identity, { op: 'open', atMs, ...(prev?.lastClose ? { lastClose: prev.lastClose } : {}) })
    const sent = await d.control(['open'])
    if (!sent.ok) {
      // Nothing was typed → nothing can start late; record the failed attempt as closed.
      writeIntent(d, identity, { op: 'close', atMs: now(), reason: 'error', lastClose: { reason: 'error', atMs: now() } })
      return { ok: false, state: 'closed', error: `could not type /voice: ${sent.error ?? 'control failed'}`, hosts: 0 }
    }
    const done = await waitFor(d, identity, d.openTimeoutMs ?? OPEN_TIMEOUT_MS, x => x.state === 'open')
    if (done.state === 'open') {
      writeIntent(d, identity, { op: 'open', atMs, session: done.session, ...(prev?.lastClose ? { lastClose: prev.lastClose } : {}) })
      d.log?.({ ev: 'voice-opened', identity, session: done.session, hosts: done.hosts })
      if (done.hosts !== 1) return { ok: false, state: 'open', session: done.session, error: `${done.hosts} voice helpers running — expected exactly one`, hosts: done.hosts }
      return { ok: true, state: 'open', session: done.session, already: false, hosts: done.hosts }
    }
    // Timeout ≠ closed: clean up and report the OBSERVED state (closed only with the helper gone).
    const c = await closeLocked(d, identity, 'error')
    return { ok: false, state: c.state, error: `voice did not start within ${d.openTimeoutMs ?? OPEN_TIMEOUT_MS}ms${c.ok ? ' (cleaned up)' : `; cleanup: ${c.error}`}`, hosts: c.hosts }
  }, () => ({ ok: false, state: voiceStatus(d, identity).state, error: 'another voice operation holds the lock' }))
}

export async function closeVoice(d: VoiceDeps, identity: string, reason: VoiceCloseReason = 'requested'): Promise<VoiceReceipt> {
  return withLock(d, identity, () => closeLocked(d, identity, reason), () => ({ ok: false, state: voiceStatus(d, identity).state, error: 'another voice operation holds the lock' }))
}

/**
 * One idle sweep over the voice sessions WE opened. Closes idle ones; records a close that
 * happened outside us (a human's `/voice`, a transport drop) as `user`/`error` so status reports it.
 * Never blocks on a held lock (an operation in progress owns the session for now).
 */
export async function voiceSweep(d: VoiceDeps, identities: string[]): Promise<Array<{ identity: string; action: string }>> {
  const out: Array<{ identity: string; action: string }> = []
  const now = d.now ?? Date.now
  for (const identity of identities) {
    const intent = readIntent(d, identity)
    if (intent?.op !== 'open') continue
    const release = acquireLock(d, identity)
    if (!release) continue
    try {
      const obs = observeVoice(d, identity)
      const s = deriveVoiceStatus(obs, readIntent(d, identity), now())
      if (s.state === 'closed') {
        const outcome = obs.rollout?.closed?.outcome
        const reason: VoiceCloseReason = obs.rollout?.closed && obs.rollout.closed.atMs >= intent.atMs && outcome === 'ended' ? 'user' : 'error'
        writeIntent(d, identity, { op: 'close', atMs: now(), reason, ...(intent.session ? { session: intent.session } : {}), lastClose: { reason, atMs: now(), ...(intent.session ? { session: intent.session } : {}) } })
        d.log?.({ ev: 'voice-closed', identity, reason, outside: true, ...(outcome ? { outcome } : {}) })
        out.push({ identity, action: `recorded-${reason}` })
        continue
      }
      if (shouldIdleClose(s, d.idleSecs ?? DEFAULT_IDLE_SECS)) {
        const r = await closeLocked(d, identity, 'idle')
        out.push({ identity, action: r.ok ? 'idle-closed' : `idle-close-failed: ${r.error}` })
      }
    } finally {
      release()
    }
  }
  return out
}

/** Identities with a persisted voice intent (the sweep's population). */
export function voiceIdentities(stateDir: string): string[] {
  try {
    return readdirSync(stateDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))
  } catch {
    return []
  }
}

export const voiceStateDir = (lifecycleStateDir: string): string => join(lifecycleStateDir, 'voice')
