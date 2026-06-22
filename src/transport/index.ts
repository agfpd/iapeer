// Transport — liveness scan + delivery target resolution + tmux delivery, plus
// the Ф1 route-and-deliver orchestration (NO wake yet — a miss returns an
// explicit "offline" signal; wake-on-miss lands in Ф2). Consolidated from
// inter-agent-protocol/src/lib/transport.ts (wins) + send.ts (rewritten so the
// caller identity comes FROM THE REQUEST, not a per-process Identity).
//
// The TUI submit TIMING (inputHoldsPaste / submitIntoTui poll+re-press / deliver
// ViaTmux byte layout) is ported BYTE-FOR-BYTE — it is the validated 0.7.6
// deterministic submit and must not be refactored (anti-regression of the
// Enter-swallow flap; blueprint §5 "submit-надёжность"). The ONLY contract-
// sanctioned change (docs/Рантайм-адаптеры): the prompt glyphs /
// paste patterns are no longer a hardcoded union here — they come from the target
// runtime's adapter.deliveryMarkers. The poll/re-press logic is untouched; only the
// marker SOURCE moved, so the timing behaviour is identical.

import { readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  MAX_ATTACHMENTS,
  MAX_MESSAGE_LEN,
  MAX_TOPIC_LEN,
  isRuntime,
  isSupportedLocalRuntime,
  isValidName,
  resolveSockDir,
  type TmuxRuntime,
} from '../core/constants.ts'
import { err, ok, type Result } from '../core/errors.ts'
import {
  buildProcessAddress,
  buildSocketPath,
  type ProcessAddress,
} from '../core/socket.ts'
import { buildEnvelope } from '../codec/index.ts'
import { resolveGlobalRoot } from '../storage/index.ts'
import { findPeer, readPeersIndex, type PeerRecord } from '../registry/index.ts'
import type { ResolvedCaller } from '../identity/index.ts'
// Delivery markers are OWNED by the runtime adapter. transport
// reads them from getAdapter(target.runtime) for the tui submit path. One-way
// dependency: launch does NOT import transport, so no cycle.
import { getAdapter } from '../launch/index.ts'
import type { ControlCommand } from '../launch/types.ts'
// Spawn-flip Ф0b-2: warm-deliver is HOST-AWARE. hostSessionAlive (runtime-state host detect, an
// @xterm-free pid-file check) + deliverHosted (the pure-protocol socket leaf, Ф0a) come from
// launch/ptyHost — already in transport's module graph via getAdapter above and @xterm-free by
// construction (the daemon @xterm-probe covers it). No new cycle: ptyHost's subtree never imports
// transport. Flag-off (no live supervisor session) → hostSessionAlive is a cheap miss → tmux path.
import {
  deliverHosted,
  hasAttachedSupervisorClient,
  hostGeometry,
  hostRunDir,
  hostSessionAlive,
  hostSessionToken,
  listHostedPeers,
} from '../launch/ptyHost.ts'
import { sendControlToHost, type DeliverResult } from '../supervisor/deliver.ts'
import { keysToBytes } from '../supervisor/protocol.ts' // pure send-keys-vocab→pty-byte translation (boot-driver slice a), @xterm-free
import { paneLogComposerOccupied } from '../launch/readyGateModel.ts' // spawn-flip Ф0b-3 slice 3c: hosted busy-composer detector (slice 2). @xterm dynamic-loaded inside it → warm path stays @xterm-free with the flip off

export interface OnlinePeer {
  personality: string
  runtime: TmuxRuntime
}

export interface DeliveryTarget extends ProcessAddress {
  socketPath: string
}


function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n)
}

function sessionAlive(_sock: string, address: string): boolean {
  // pty-only: a peer's liveness is its supervisor daemon (a cheap pid-file check). `address` IS the
  // identity. (`_sock` is retained for call-site compatibility; tmux sockets no longer exist.)
  return hostSessionAlive(address)
}

/** Is the (runtime,personality) endpoint live right now? Public liveness predicate. */
export function isPeerLive(runtime: string, personality: string, sockDir = resolveSockDir()): boolean {
  const socketPath = buildSocketPath(runtime, personality, sockDir)
  return sessionAlive(socketPath, buildProcessAddress(runtime, personality))
}

export function listOnlinePeers(_sockDir = resolveSockDir()): OnlinePeer[] {
  // pty-only: every live peer is a supervisor-hosted session (no tmux sockets to scan).
  const out = new Map<string, OnlinePeer>()
  for (const h of listHostedPeers()) {
    out.set(buildProcessAddress(h.runtime, h.personality), { personality: h.personality, runtime: h.runtime })
  }
  return Array.from(out.values()).sort(
    (a, b) => a.personality.localeCompare(b.personality) || a.runtime.localeCompare(b.runtime),
  )
}

export function resolveDeliveryTarget(args: {
  personality: string
  runtime?: string
  sockDir?: string
}): Result<DeliveryTarget> {
  const sockDir = args.sockDir ?? resolveSockDir()
  if (!isValidName(args.personality)) {
    return err(`invalid personality "${args.personality}" — must match /^[a-z][a-z0-9-]{0,31}$/`)
  }
  if (args.runtime) {
    if (!isRuntime(args.runtime)) return err(`invalid runtime "${args.runtime}"`)
    const runtime = args.runtime
    const socketPath = buildSocketPath(runtime, args.personality, sockDir)
    const address = buildProcessAddress(runtime, args.personality)
    if (!sessionAlive(socketPath, address)) {
      return err(`peer offline: ${args.personality} (${args.runtime})`)
    }
    return ok({ runtime, personality: args.personality, address, socketPath })
  }
  const matches = listOnlinePeers(sockDir).filter(peer => peer.personality === args.personality)
  if (matches.length === 0) return err(`peer offline: ${args.personality}`)
  if (matches.length > 1) {
    return err(
      `${args.personality} is online in multiple runtimes (${matches
        .map(peer => peer.runtime)
        .join(', ')}) — specify runtime`,
    )
  }
  const match = matches[0]
  const socketPath = buildSocketPath(match.runtime, match.personality, sockDir)
  return ok({
    runtime: match.runtime,
    personality: match.personality,
    address: buildProcessAddress(match.runtime, match.personality),
    socketPath,
  })
}

export function resolvePeerDeliveryTarget(
  personality: string,
  runtime: string | undefined,
  peer: PeerRecord,
): Result<DeliveryTarget> {
  if (runtime) return resolveDeliveryTarget({ personality, runtime })
  if (peer.runtime) {
    const exactDefault = resolveDeliveryTarget({ personality, runtime: peer.runtime })
    if (exactDefault.ok) return exactDefault
  }
  return resolveDeliveryTarget({ personality })
}

// Ф-B liveness: how long to keep polling the activity proxy for a transcript
// advance when the submit did NOT clear the input (a busy session whose input row
// is not rendered). Env-tunable for LIVE calibration (busy/idle/cold). Conservative
// default — long enough that a busy-but-alive session reliably shows an advance,
// short enough that a genuinely dead session is failed promptly. Prefer a false-
// FAIL (sender retries) over a false-OK (silent loss, which the contract forbids).
const LIVENESS_POLL_MS = 100
function livenessGraceMs(): number {
  const raw = process.env.IAP_LIVENESS_GRACE_MS
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 3000
}

// Host (spawn-flip Ф0b-2) liveness grace — DECOUPLED from the tmux grace by design. The hosted path
// has no input-clear fast confirm (no capture-pane), so a transcript advance is its SOLE landed-proof
// and may need its own calibration. `IAP_HOST_LIVENESS_GRACE_MS` tunes ONLY the hosted path; when
// unset it falls back to the shared `livenessGraceMs()` — so calibrating hosted NEVER loosens the
// tmux/fleet grace (a global bump there would be a fleet regression).
function hostLivenessGraceMs(): number {
  const raw = process.env.IAP_HOST_LIVENESS_GRACE_MS
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : livenessGraceMs()
}

// ─── Warm delivery (pty-only — supervisor socket) ────────────────────────────────────────────────

/** Test seam for `deliverWarm`. Production defaults route on the real supervisor; tests inject a
 *  fake host-deliver + a temp transcript proxy, so the deliver path is covered with no live daemon.
 *  Omitting all fields = pure production behaviour. */
export interface WarmDeliverSeam {
  /** Deliver to the hosted session over its socket. Default: the real `deliverHosted` (Ф0a leaf). */
  deliverHosted?: (identity: string, envelope: string) => Promise<DeliverResult>
  /** Activity proxy for the landed-confirm. Default: the target runtime adapter's transcript mtime. */
  newestActivityMtime?: (cwd: string) => number | null
  /** SECOND landed-confirm proxy: the pane-log (TUI render-stream) mtime, keyed by process
   *  ADDRESS. Default: the real `<root>/logs/lifecycle/<address>.log` mtime. The pane-log ticks
   *  ~1s as the session renders its working state on submit — for codex it advances ~1s while the
   *  session-jsonl only advances at model-turn-start (~4-6s, past the grace), so this is the signal
   *  that gives codex delivery parity. See `deliverViaHost`. */
  paneLogMtime?: (address: string) => number | null
}

/**
 * Warm-deliver `envelope` to a LIVE local target over its supervisor socket (pty-only). Landing is
 * CONFIRMED by a transcript-mtime advance past the pre-deliver baseline, NOT the socket-ack (a flushed
 * CR proves the bytes left us, NOT that the session accepted them; trusting the ack would re-open the
 * silent-loss class the contract forbids). A router (telegram/notifier) has no transcript proxy → it is
 * confirmed by the socket-ack (its liveness is structural via launchd KeepAlive). See `deliverViaHost`.
 */
export async function deliverWarm(
  target: DeliveryTarget,
  envelope: string,
  cwd?: string,
  seam: WarmDeliverSeam = {},
): Promise<Result<void>> {
  return deliverViaHost(target, envelope, cwd, seam)
}

async function deliverViaHost(
  target: DeliveryTarget,
  envelope: string,
  cwd: string | undefined,
  seam: WarmDeliverSeam,
): Promise<Result<void>> {
  const adapter = getAdapter(target.runtime)
  const mtimeOf = seam.newestActivityMtime ?? ((c: string) => adapter.newestActivityMtime(c))
  const paneMtimeOf = seam.paneLogMtime ?? ((addr: string) => defaultPaneLogMtime(addr))
  // Baseline BOTH landed-proxies BEFORE delivery (a paste/CR does not move the transcript — only a
  // model turn does; the pane-log moves as the session renders), so an advance in EITHER afterwards
  // proves the session is alive and took our message.
  const baseline = cwd ? mtimeOf(cwd) ?? 0 : 0
  const paneBaseline = paneMtimeOf(target.address) ?? 0
  const send = seam.deliverHosted ?? deliverHosted
  const sent = await send(target.address, envelope)
  if (!sent.ok) {
    return err(
      `hosted peer "${target.personality}" (${target.runtime}) deliver failed: ${sent.error ?? 'unknown error'}; ` +
        `message NOT delivered`,
    )
  }
  // Router (telegram/notifier): no transcript proxy (adapter.newestActivityMtime=null) → the
  // mtime-advance confirm below can NEVER be satisfied and would false-FAIL every router delivery.
  // Confirm by the socket-ack just obtained — PARITY with deliverViaTmux's router path (C-j success =
  // delivery-level confirm; a router's liveness is structural via launchd KeepAlive, not a model
  // turn). See deliverViaTmux router branch (paste-buffer -r + C-j, no transcript confirm) + its
  // header note "router … liveness is structural".
  if (adapter.kind === 'router') return ok(undefined)
  // socket-ack ≠ landed. With no activity proxy (direct callers/tests without a cwd) we can only
  // trust the flushed submit — confirmed-only, mirroring deliverViaTmux's legacy-caller path.
  if (!cwd) return ok(undefined)
  // Confirm landing by EITHER of two proxies within the grace:
  //  (a) transcript/session-jsonl mtime advance — the strong "model wrote a turn" signal. claude
  //      writes the user turn to its transcript promptly (sub-second); CODEX writes its session
  //      jsonl only at model-turn-START (gated by TTFT, measured ~4-6s after submit), so on the
  //      transcript-ONLY confirm every codex delivery STRUCTURALLY false-FAILED (the 3000ms grace
  //      expires before the first session write — proven in delivery.log).
  //  (b) PANE-LOG (TUI render-stream) mtime advance — the SAME true active-turn signal the 0.4.16
  //      idle-reap fix uses: it ticks ~1s as the session renders the working state on submit, so it
  //      catches codex in ~1s, giving codex delivery parity with claude WITHOUT lengthening the
  //      (synchronous) grace. NOT a false-OK: an advance proves the session is alive and rendered
  //      output in response to our just-flushed bytes (a wedged/dead pty renders nothing → no
  //      advance → correct fail); the bytes are then in the session's input (codex queues input
  //      during a turn). Prefer a false-FAIL (sender retries) over a false-OK (silent loss).
  const graceMs = hostLivenessGraceMs()
  const graceDeadline = monotonicMs() + graceMs
  do {
    if ((mtimeOf(cwd) ?? 0) > baseline) return ok(undefined)
    if ((paneMtimeOf(target.address) ?? 0) > paneBaseline) return ok(undefined)
    sleepSync(LIVENESS_POLL_MS)
  } while (monotonicMs() < graceDeadline)
  return err(
    `hosted peer "${target.personality}" (${target.runtime}) is listed live but did not accept the message ` +
      `(no transcript or pane-log advance within ${graceMs}ms) — live but unresponsive to this delivery (not dead); message NOT delivered`,
  )
}

/** Pane-log (TUI render-stream) mtime for a process address, or null when absent/unreadable.
 *  The pane-log is the canonical `<root>/logs/lifecycle/<address>.log` the supervisor appends raw
 *  pty bytes to (§1 contract). Used as the SECOND landed-confirm proxy in deliverViaHost. */
function defaultPaneLogMtime(address: string): number | null {
  try {
    return statSync(join(resolveGlobalRoot(), 'logs', 'lifecycle', `${address}.log`)).mtimeMs
  } catch {
    return null
  }
}

/**
 * The CURRENT live runtime of a peer — the AUTHORITATIVE, real-time signal for "what
 * runtime is this peer running right now" (NOT default_runtime, which is only the wake
 * DEFAULT, and NOT a `.session` file, a wake-record cleaned on a supervise-tick latency).
 *
 * Resolution: among the peer's PID-ALIVE supervisor sessions (listHostedPeers — the same
 * source delivery uses; `sessionAlive` = pidfile exists AND kill-0), pick the one with the
 * FRESHEST pane-log. A peer can be alive on >1 runtime at once (a `/codex` flip can leave
 * the old session running alongside the new), so the freshest-pane-log among the alive set
 * is the currently-active surface. The alive-filter is what fixes the flip-race: a
 * just-died runtime's pane-log / .sock / .session all LINGER, but its pid is dead → it is
 * excluded here. Returns null when no session is alive.
 *
 * Deps are injectable for hermetic tests (the defaults read the real run-dir + pane-logs).
 */
export function resolveLiveRuntime(
  personality: string,
  deps: { aliveRuntimes?: (p: string) => string[]; paneLogMtime?: (address: string) => number | null } = {},
): string | null {
  const aliveOf = deps.aliveRuntimes ?? ((p: string) => listHostedPeers().filter(h => h.personality === p).map(h => h.runtime))
  const paneMt = deps.paneLogMtime ?? defaultPaneLogMtime
  const alive = aliveOf(personality)
  if (alive.length <= 1) return alive[0] ?? null
  // >1 alive → the freshest pane-log mtime (the currently-rendering turn surface).
  return alive.reduce((best, rt) => ((paneMt(`${rt}-${personality}`) ?? 0) > (paneMt(`${best}-${personality}`) ?? 0) ? rt : best))
}


// ─── Compact done gate (dialogue control must report FACT, not keystroke delivery) ──

export interface CompactDoneBaseline {
  runtime: string
  cwd: string
  capturedAtMs: number
  files: { path: string; size: number }[]
}

export interface CompactDoneWaitResult {
  ok: true
  ms: number
  /** How completion was confirmed:
   *   'transcript+ready' — marker seen AND the composer returned to idle (the clean,
   *       common case: a small/medium compact that settles back to the prompt).
   *   'transcript' — marker seen but the composer is still BUSY past the ready-grace
   *       (a large-context session that auto-continues into a working turn right after
   *       compact). The structured marker is the AUTHORITATIVE completion signal, so this
   *       is SUCCESS, not a timeout. */
  signal: 'transcript+ready' | 'transcript'
}

/** Test seam for waitForCompactDone — inject the tmux liveness + pane capture so the
 *  marker/grace logic is covered hermetically (no live session). Omitting all = prod. */
export interface CompactDoneWaitSeam {
  /** Is the target session still alive? Default: the real tmux/host sessionAlive. */
  sessionAlive?: (target: DeliveryTarget) => boolean
  /** Capture the target pane; null = capture failed. Default: real tmux capture-pane. */
  capturePane?: (target: DeliveryTarget) => string | null
}

function envHome(env: NodeJS.ProcessEnv | undefined): string {
  return env?.HOME?.trim() || homedir()
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

function claudeTranscriptDirForCwd(cwd: string, env?: NodeJS.ProcessEnv): string {
  const slug = canonicalPath(cwd).replace(/[^a-zA-Z0-9]/g, '-')
  return join(envHome(env), '.claude', 'projects', slug)
}

function codexSessionCwd(file: string): string | null {
  try {
    const firstLine = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0]
    if (!firstLine) return null
    const entry = JSON.parse(firstLine) as { type?: unknown; payload?: { cwd?: unknown } }
    return entry.type === 'session_meta' && typeof entry.payload?.cwd === 'string' ? entry.payload.cwd : null
  } catch {
    return null
  }
}

function compactCandidateFiles(runtime: string, cwd: string, env?: NodeJS.ProcessEnv): string[] {
  const target = canonicalPath(cwd)
  const out: string[] = []
  if (runtime === 'claude') {
    const dir = claudeTranscriptDirForCwd(cwd, env)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(join(dir, entry.name))
    }
  } else if (runtime === 'codex') {
    const root = join(envHome(env), '.codex', 'sessions')
    function visit(dir: string): void {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          visit(path)
          continue
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        if (canonicalPath(codexSessionCwd(path) ?? '') === target) out.push(path)
      }
    }
    visit(root)
  }
  return out.sort()
}

function compactDoneFileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

export function compactDoneBaseline(runtime: string, cwd: string, opts: { env?: NodeJS.ProcessEnv } = {}): CompactDoneBaseline {
  return {
    runtime,
    cwd,
    capturedAtMs: monotonicMs(),
    files: compactCandidateFiles(runtime, cwd, opts.env).map(path => ({ path, size: compactDoneFileSize(path) })),
  }
}

function isStructuredCompactDone(runtime: string, obj: unknown): boolean {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const rec = obj as Record<string, unknown>
  const payload = rec.payload && typeof rec.payload === 'object' && !Array.isArray(rec.payload)
    ? rec.payload as Record<string, unknown>
    : undefined

  // Codex writes an explicit structured completion event after slash-/compact.
  // The adjacent top-level `compacted` record is accepted too: older/newer Codex
  // builds can emit it immediately before/without the event_msg wrapper.
  if (runtime === 'codex') {
    if (rec.type === 'event_msg' && payload?.type === 'context_compacted') return true
    if (rec.type === 'compacted') return true
  }

  // Claude Code records the finished compaction as a system compact boundary with
  // compactMetadata (duration/pre/post tokens). Raw text mentions are ignored.
  if (runtime === 'claude') {
    if (rec.type === 'system' && rec.subtype === 'compact_boundary') return true
    if (rec.type === 'system' && rec.compactMetadata && typeof rec.compactMetadata === 'object') return true
  }

  return false
}

export function compactTranscriptHasDone(
  baseline: CompactDoneBaseline,
  opts: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const offsets = new Map(baseline.files.map(f => [f.path, f.size]))
  // Include a transcript/session file that appears after the baseline (rare, but a
  // resume/rotate race should not make the done gate blind). Existing files are
  // read only from their baseline byte offset, so old compact markers cannot pass.
  for (const path of compactCandidateFiles(baseline.runtime, baseline.cwd, opts.env)) {
    if (!offsets.has(path)) offsets.set(path, 0)
  }

  for (const [path, offset] of offsets) {
    let buf: Buffer
    try {
      buf = readFileSync(path)
    } catch {
      continue
    }
    const start = Math.min(Math.max(0, offset), buf.length)
    const tail = buf.subarray(start).toString('utf8')
    for (const line of tail.split(/\r?\n/)) {
      if (!line.trim()) continue
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (isStructuredCompactDone(baseline.runtime, obj)) return true
    }
  }
  return false
}

function compactDoneTimeoutMs(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.IAPEER_COMPACT_DONE_TIMEOUT_MS
  const n = raw === undefined ? NaN : Number(raw)
  // Keep default below telegram-runtime's 300 s command timeout so iapeer returns
  // the truthful failure itself instead of letting the channel kill the process.
  return Number.isFinite(n) && n >= 0 ? n : 290_000
}

function compactDonePollMs(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.IAPEER_COMPACT_DONE_POLL_MS
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 1000
}

// Once the completion marker is seen, how long to keep PREFERRING the idle-composer
// confirmation (the clean 'transcript+ready' signal) before reporting success on the
// marker alone. A large-context session that auto-continues into a working turn never
// goes idle — this bounds how long we wait for an idle that may never come, so the
// busy case succeeds promptly instead of stalling to the overall deadline. Short by
// design; the marker is already authoritative.
function compactReadyGraceMs(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.IAPEER_COMPACT_READY_GRACE_MS
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 5000
}

/**
 * Wait until a slash-/compact command has actually FINISHED, not merely until its
 * keystrokes were accepted. The AUTHORITATIVE signal is scroll-proof structured
 * transcript state written by the runtimes at the END of the operation (with post-
 * compact token metadata): Codex `context_compacted`, Claude `compact_boundary`.
 * Once that marker is present the compact objectively completed.
 *
 * Idle-composer (`isInputReady`) is treated as a FAST-PATH confirmation, NOT a
 * requirement. A healthy large-context session auto-continues into a working turn
 * right after compact — its composer is legitimately busy (not idle) for a while, so
 * requiring idle here false-failed a finished compact (marker seen, but the first
 * post-compact idle only arrived hundreds of seconds later, past the ~290s gate).
 * Therefore: marker seen + composer idle → 'transcript+ready' (clean); marker seen +
 * composer still busy past a short grace → 'transcript' (busy-but-done, still SUCCESS).
 *
 * BOUNDARY (preserved): a compact whose structured marker NEVER appears still fails
 * honestly — that is the genuine "hung / never completed" case. Cross-runtime: the
 * marker set + isInputReady are both per-adapter, so claude and codex share this path.
 */
export function waitForCompactDone(
  target: DeliveryTarget,
  cwd: string,
  baseline: CompactDoneBaseline,
  opts: {
    env?: NodeJS.ProcessEnv
    timeoutMs?: number
    pollMs?: number
    graceMs?: number
    seam?: CompactDoneWaitSeam
  } = {},
): Result<CompactDoneWaitResult> {
  const env = opts.env ?? process.env
  const timeoutMs = opts.timeoutMs ?? compactDoneTimeoutMs(env)
  const pollMs = opts.pollMs ?? compactDonePollMs(env)
  const graceMs = opts.graceMs ?? compactReadyGraceMs(env)
  const aliveFn = opts.seam?.sessionAlive ?? ((t: DeliveryTarget) => sessionAlive(t.socketPath, t.address))
  // pty-only: the AUTHORITATIVE compact-done signal is the transcript marker (compactTranscriptHasDone).
  // The pane capture was a tmux fast-path (idle-composer detect) + error context; with tmux gone the
  // default is no-capture (the transcript marker remains the contract). Tests inject seam.capturePane.
  const captureFn = opts.seam?.capturePane ?? ((_t: DeliveryTarget): string | null => null)
  const adapter = getAdapter(target.runtime)
  const started = monotonicMs()
  const deadline = started + timeoutMs
  let sawTranscriptDone = false
  let markerSeenAtMs = -1
  let lastPane = ''

  do {
    if (!aliveFn(target)) {
      return err(`compact did not complete: tmux session vanished`)
    }
    if (!sawTranscriptDone && compactTranscriptHasDone(baseline, { env })) {
      sawTranscriptDone = true
      markerSeenAtMs = monotonicMs()
    }
    const pane = captureFn(target)
    if (pane !== null) lastPane = pane
    if (sawTranscriptDone) {
      // Fast clean path: the composer returned to idle (the historical signal).
      if (pane !== null && adapter.isInputReady(pane)) {
        return ok({ ok: true, ms: monotonicMs() - started, signal: 'transcript+ready' })
      }
      // Marker is authoritative: a busy composer after a held marker is a healthy
      // auto-continue, not a failure. Succeed on the marker once the grace elapses.
      if (monotonicMs() - markerSeenAtMs >= graceMs) {
        return ok({ ok: true, ms: monotonicMs() - started, signal: 'transcript' })
      }
    }
    sleepSync(pollMs)
  } while (monotonicMs() < deadline)

  // Deadline hit. The marker is authoritative: if it was EVER seen, the compact did
  // finish — a still-busy composer at the deadline is not a failure (succeed on the
  // marker). Only a MISSING marker is an honest failure (hung / never-completed compact).
  if (sawTranscriptDone) {
    return ok({ ok: true, ms: monotonicMs() - started, signal: 'transcript' })
  }
  const tail = lastPane
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' ⏎ ')
    .replace(/"/g, "'")
    .slice(0, 240)
  return err(
    `compact did not complete within ${timeoutMs}ms (no transcript compact marker` +
      `${tail ? `; pane tail: ${tail}` : ''})`,
  )
}

// ─── Control channel (Ф-E) — in-session control via the adapter, UNCONDITIONAL ──

/**
 * Perform an in-session control command on a LIVE target (Ф-E, docs/Control-команды).
 * The target's adapter maps the abstract command to a control sequence (ControlPlan); each step is
 * sent IN ORDER, UNCONDITIONALLY — NO ready-gate, NO submit-confirm (the point of `interrupt` is to
 * break a stuck/raving turn exactly when normal delivery would not land). An unsupported command
 * (router runtimes, unknown name) → explicit refusal, not a silent no-op.
 */
/** Test seam for the control path: inject the socket control-send so it is covered without a live
 *  supervisor. Omitting all = prod. */
export interface ControlHostSeam {
  sendControl?: (runDir: string, session: string, chunks: Buffer[], opts: { stepDelayMs?: number }) => Promise<DeliverResult>
}

export async function executeControlOnTarget(
  target: DeliveryTarget,
  command: ControlCommand,
  seam: ControlHostSeam = {},
): Promise<Result<void>> {
  const plan = getAdapter(target.runtime).executeControl(command)
  if (!plan) {
    return err(`runtime "${target.runtime}" does not support control command "${command.name}"`)
  }
  // pty-only: translate each plan step to pty bytes with keysToBytes (REUSED from the boot-driver) and
  // send them over the supervisor socket. UNCONDITIONAL semantics (no ready-gate, no submit-confirm) —
  // the point of interrupt is to break a stuck turn.
  const chunks = plan.sequence.map(keys => keysToBytes(keys))
  const send = seam.sendControl ?? sendControlToHost
  const sent = await send(hostRunDir(), target.address, chunks, { stepDelayMs: plan.stepDelayMs })
  if (!sent.ok) {
    return err(`hosted control "${command.name}" failed for "${target.personality}" (${target.runtime}): ${sent.error ?? 'unknown error'}`)
  }
  return ok(undefined)
}

export interface ControlResult {
  ok: true
  controlled: { personality: string; runtime: string }
  command: string
  ts: string
}

/**
 * Route an in-session control command to a peer: resolve the LIVE target (control
 * acts on a running session — a non-live peer has nothing to interrupt) then
 * executeControlOnTarget. Without a runtime, resolves the single live runtime (2+ →
 * "specify runtime"). The clean-slash control namespace (interrupt/compact/…) is the
 * caller's; /alias_* expansions are message, not control (docs/Control §namespace).
 */
export async function routeControl(personality: string, runtime: string | undefined, command: ControlCommand): Promise<Result<ControlResult>> {
  if (!isValidName(personality)) {
    return err(`invalid personality "${personality}" — must match /^[a-z][a-z0-9-]{0,31}$/`)
  }
  if (runtime && !isRuntime(runtime)) return err(`invalid runtime "${runtime}"`)
  const target = resolveDeliveryTarget({ personality, runtime })
  if (!target.ok) return err(`cannot control "${personality}": ${target.error.message}`)
  const done = await executeControlOnTarget(target.value, command)
  if (!done.ok) return done
  return ok({
    ok: true,
    controlled: { personality: target.value.personality, runtime: target.value.runtime },
    command: command.name,
    ts: new Date().toISOString(),
  })
}

// ─── Route + deliver orchestration (Ф1: no wake; miss → explicit offline) ────

export interface SendToPeerInput {
  personality: string
  runtime?: string
  message: string
  topic?: string
  attachments?: readonly string[]
}

export interface RouteResult {
  ok: true
  delivered_to: { personality: string; runtime: string }
  woke: boolean
  ts: string
  /** wake_policy:"ephemeral" M3 — true when the message was ENQUEUED for a
   *  stateless worker rather than injected/woken synchronously: the daemon
   *  drains the per-peer FIFO one task per fresh session (async). The
   *  substantive result arrives as the worker's own reply (FaaS semantics);
   *  `delivered_to` names the ACCEPTING queue identity, not a live session. */
  queued?: boolean
  /** Which async queue accepted the delivery. `ephemeral` is the durable worker
   *  task queue; `composer` is the daemon's in-memory busy-human-composer queue.
   *  Both surface as `queued:true`, but only `composer` means "not yet delivered
   *  and may still fail with an explicit sender notification". */
  queuedBy?: 'ephemeral' | 'composer'
  /** Queue depth right after the enqueue (observability; only with queued). */
  queueDepth?: number
}

// WakeFn — the lifecycle wake primitive, INJECTED (transport never imports
// lifecycle; the daemon wires lifecycle.wakeOrSpawn as this contract — §2). H4
// (don't wake launchd peers) and the wake-runtime choice live inside the impl.
export interface WakeRequest {
  personality: string
  runtime?: string
  topic?: string
  /** First message delivered to the woken session (the routed envelope). */
  task: string
}
export interface WakeOutcome {
  status: 'READY' | 'FAILED'
  woke: boolean
  runtime?: string
  process_address?: string
  reason?: string
  /** C1: the peer is durably STOPPED (a deliberate operator halt) — the wake was
   *  refused, not failed. routeSend surfaces an explicit "stopped" error to the
   *  sender (contract Демон §stopped: stopped → no wake, no queue, clear error). */
  stopped?: boolean
  /** Did the wake itself deliver `task` (as the boot first-message)? An impl
   *  returns FALSE from its idempotent live-session fast path (a concurrent wake
   *  won and delivered only ITS envelope) — routeSend then delivers this caller's
   *  envelope via the live path. undefined → assumed delivered (legacy impls keep
   *  their prior behavior; the in-repo wakeOrSpawn always sets it explicitly). */
  taskDelivered?: boolean
}
export type WakeFn = (req: WakeRequest) => Promise<WakeOutcome>

/** wake_policy:"ephemeral" M3 — the injected serial-queue delivery seam. Like
 *  WakeFn, transport never imports lifecycle: the daemon composition (main.ts)
 *  wires the queue + drain behind this contract; absent → every target takes
 *  the normal live/miss path (library/CLI/test callers unchanged). */
export interface EphemeralRouteDeps {
  /** Is the target peer (by its registry cwd) an ephemeral stateless worker? */
  isEphemeral: (cwd: string) => boolean
  /** Always-enqueue delivery: enqueue + async drain kick → fast `{queued:true}`
   *  ack. MUST NOT block on the wake (the sender's content-level answer is the
   *  worker's own reply, not this transport ack). */
  deliver: (args: {
    peer: PeerRecord
    envelope: string
    topic?: string
    runtime?: string
  }) => Promise<Result<RouteResult>>
}

export interface ComposerQueuedDelivery {
  id: number
  caller: ResolvedCaller
  peer: PeerRecord
  target: DeliveryTarget
  envelope: string
  topic?: string
  enqueuedAtMs: number
  sessionToken: string
}

export interface ComposerQueueTryEnqueueArgs {
  caller: ResolvedCaller
  peer: PeerRecord
  target: DeliveryTarget
  envelope: string
  topic?: string
}

export interface ComposerQueueRouteDeps {
  /** Return null when the live delivery should proceed synchronously; return a
   *  RouteResult when the envelope was accepted by the composer queue. */
  tryEnqueue: (args: ComposerQueueTryEnqueueArgs) => Promise<Result<RouteResult> | null>
  /** Fail every queued-but-not-yet-delivered envelope, used by daemon shutdown /
   *  restart so `queued` never degrades into silent loss. */
  failAll?: (reason: string) => Promise<void>
}

export interface RouteDeps {
  /** On a miss, wake the dead peer instead of returning offline (Ф2). */
  wake?: WakeFn
  /** Ephemeral-target serial-queue delivery (M3); absent → normal routing. */
  ephemeral?: EphemeralRouteDeps
  /** Busy-human-composer queue. When a LIVE local TUI target has an attached
   *  operator and non-dim text in its composer, routeSend returns a fast
   *  `{queued:true, queuedBy:"composer"}` ack and the daemon drains the message
   *  later instead of blindly paste+Enter-ing into the human's unfinished input. */
  composerQueue?: ComposerQueueRouteDeps
  /** Fired after a successful LIVE delivery whose envelope carried a non-empty
   *  topic — the hit path AND the post-wake fast-path redelivery, NOT the boot
   *  first-message (the wake itself records its topic). The fresh-vs-resume seam:
   *  lifecycle keeps a per-identity `.topic` marker the wake resolver compares
   *  the incoming topic against; before this hook the marker was written ONLY at
   *  wake, so it held «the topic the session woke with», while the resolver's
   *  semantics want «the topic the session last worked on». A long-lived executor
   *  that took live-delivered messages of topic B all day then false-FRESHED on
   *  stop→start→wake with topic B (a day of context lost to
   *  cause=idle-reaped-new-topic). Injected so transport never
   *  imports lifecycle (layering — main.ts is where the two meet); call sites
   *  swallow hook errors (a hook must never fail a delivered message). */
  noteLiveTopic?: (identity: string, topic: string) => void
}

/** Best-effort noteLiveTopic invocation — only on a non-empty topic, never throws. */
function noteTopic(deps: RouteDeps, identity: string, topic: string | undefined): void {
  if (!topic) return
  try {
    deps.noteLiveTopic?.(identity, topic)
  } catch {
    /* a post-delivery hook must never fail the delivery */
  }
}

export interface ComposerDeliveryQueueOptions {
  env?: NodeJS.ProcessEnv
  pollMs?: number
  forceTimeoutMs?: number
  /** Daemon pane-log dir (spawn-flip Ф0b-3 slice 3c) — needed by the HOSTED occupancy default to read
   *  `<logDir>/<identity>.log`. Absent → hosted targets never hold (safe: deliver rather than stall). */
  logDir?: string
  /** Test seam / alternate detector. Production default is the full gate — tmux: local TUI + attached
   *  tmux client + non-dim composer text; HOSTED (spawn-flip): local TUI + attached SUPERVISOR client +
   *  model-occupied composer. May be async (the hosted occupancy reads an @xterm model). */
  shouldQueue?: (args: ComposerQueueTryEnqueueArgs) => boolean | Promise<boolean>
  /** Test seam for the drain phase. Production default re-reads the composer occupancy (WITHOUT the
   *  attached-client prerequisite): once queued, abandoned human text waits until cleared or the 120s
   *  ceiling. tmux → capture-pane colour; HOSTED → pane-log model. May be async. */
  hasHumanInput?: (target: DeliveryTarget) => boolean | Promise<boolean>
  /** Test seam; production default compares the session-replacement token captured at enqueue time, so
   *  `/new`/death/restart fails the old queued envelope rather than delivering it into a fresh same-named
   *  session — tmux: session_id:pane_id; HOSTED: the supervisor daemon pid. */
  sessionToken?: (target: DeliveryTarget) => string | null
  sessionAlive?: (job: ComposerQueuedDelivery) => boolean
  /** Delivery sink. Production default is the HOST-AWARE deliverWarm (tmux target → deliverViaTmux
   *  verbatim, hosted target → the supervisor socket). May be async. */
  deliver?: (target: DeliveryTarget, envelope: string, cwd?: string) => Result<void> | Promise<Result<void>>
  notifyFailed: (job: ComposerQueuedDelivery, reason: string) => void | Promise<void>
  noteLiveTopic?: (identity: string, topic: string) => void
  onDelivered?: (caller: ResolvedCaller) => void
}

function composerQueuePollMs(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.IAPEER_COMPOSER_QUEUE_POLL_MS
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 500
}

function composerQueueForceTimeoutMs(env: NodeJS.ProcessEnv | undefined): number {
  const raw = env?.IAPEER_COMPOSER_QUEUE_TIMEOUT_MS
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 120_000
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── Composer-queue predicates (pty-only) ─────────────────────────────────────────────────────────

/** Enqueue gate. Hold ONLY when a HUMAN is attached (supervisor client) AND the composer model is
 *  occupied — the anti-bug: with no operator attached the composer text is the AI's own output, never
 *  held. No pane-log dir / unreadable model → don't hold (deliver, never stall). */
async function shouldQueueForComposer(target: DeliveryTarget, logDir: string | undefined): Promise<boolean> {
  if (!isSupportedLocalRuntime(target.runtime) || !hasAttachedSupervisorClient(target.address)) return false
  if (!logDir) return false // no pane-log dir → cannot read occupancy → don't hold (deliver, never stall)
  return paneLogComposerOccupied(`${logDir}/${target.address}.log`, hostGeometry(target.address).cols, hostGeometry(target.address).rows, target.runtime)
}

/** Drain re-check (no attached-client prereq — once queued, abandoned input waits until cleared/ceiling).
 *  Pane-log model occupancy. */
async function composerStillBusy(target: DeliveryTarget, logDir: string | undefined): Promise<boolean> {
  if (!logDir) return false
  return paneLogComposerOccupied(`${logDir}/${target.address}.log`, hostGeometry(target.address).cols, hostGeometry(target.address).rows, target.runtime)
}

/** Session-replacement token: the supervisor daemon pid. */
function composerSessionToken(target: DeliveryTarget): string | null {
  return hostSessionToken(target.address)
}

function queuedTargetStillSameSession(job: ComposerQueuedDelivery): boolean {
  return composerSessionToken(job.target) === job.sessionToken
}

let nextComposerQueueId = 1

/**
 * In-memory async delivery queue for the narrow "operator is typing in the target
 * TUI composer" case. It prevents the daemon's paste+Enter from concatenating an
 * IAP envelope with human text already present in the shared composer stdin.
 *
 * Contract:
 *   - enqueue only on live local TUI + attached tmux client + non-dim composer text;
 *   - sender gets fast `{queued:true, queuedBy:"composer"}`;
 *   - FIFO drain delivers with the same deliverViaTmux Ф-B confirmation once the
 *     composer clears;
 *   - after 120s (env-tunable) force-deliver rather than hold forever;
 *   - target death/session replacement or daemon shutdown emits `failed` to sender
 *     via the injected notifier.
 */
export function createComposerDeliveryQueue(opts: ComposerDeliveryQueueOptions): ComposerQueueRouteDeps {
  const env = opts.env ?? process.env
  const pollMs = opts.pollMs ?? composerQueuePollMs(env)
  const forceTimeoutMs = opts.forceTimeoutMs ?? composerQueueForceTimeoutMs(env)
  const logDir = opts.logDir
  const shouldQueue = opts.shouldQueue ?? ((args: ComposerQueueTryEnqueueArgs) => shouldQueueForComposer(args.target, logDir))
  const hasHumanInput = opts.hasHumanInput ?? ((target: DeliveryTarget) => composerStillBusy(target, logDir))
  const sessionToken = opts.sessionToken ?? composerSessionToken
  const sessionAliveFn = opts.sessionAlive ?? queuedTargetStillSameSession
  const deliver = opts.deliver ?? deliverWarm
  const queues = new Map<string, ComposerQueuedDelivery[]>()
  const draining = new Set<string>()
  let closed = false

  async function notifyFailed(job: ComposerQueuedDelivery, reason: string): Promise<void> {
    try {
      await opts.notifyFailed(job, reason)
    } catch {
      /* best-effort notification; delivery.log still has the queued accept */
    }
  }

  function kick(identity: string): void {
    if (draining.has(identity)) return
    draining.add(identity)
    void drain(identity).finally(() => draining.delete(identity))
  }

  async function drain(identity: string): Promise<void> {
    for (;;) {
      const q = queues.get(identity)
      const job = q?.[0]
      if (!q || !job) {
        queues.delete(identity)
        return
      }

      if (!sessionAliveFn(job)) {
        q.shift()
        await notifyFailed(job, `queued delivery to ${job.target.personality} (${job.target.runtime}) failed: target session vanished or was replaced before delivery`)
        continue
      }

      const ageMs = monotonicMs() - job.enqueuedAtMs
      const force = ageMs >= forceTimeoutMs
      if (!force && (await hasHumanInput(job.target))) {
        await delay(pollMs)
        continue
      }

      const delivered = await deliver(job.target, job.envelope, job.peer.cwd)
      q.shift()
      if (!delivered.ok) {
        await notifyFailed(job, `queued delivery to ${job.target.personality} (${job.target.runtime}) failed: ${delivered.error.message}`)
      } else {
        noteTopic({ noteLiveTopic: opts.noteLiveTopic }, job.target.address, job.topic)
        try {
          opts.onDelivered?.(job.caller)
        } catch {
          /* a post-delivery hook must never fail a delivery that already landed */
        }
      }
    }
  }

  return {
    tryEnqueue: async args => {
      if (closed) return err('composer delivery queue is closing; message NOT queued')
      if (!(await shouldQueue(args))) return null
      const token = sessionToken(args.target)
      if (!token) {
        return err(
          `composer queue could not identify the live tmux session for "${args.target.personality}" (${args.target.runtime}); message NOT queued`,
        )
      }
      const job: ComposerQueuedDelivery = {
        id: nextComposerQueueId++,
        caller: args.caller,
        peer: args.peer,
        target: args.target,
        envelope: args.envelope,
        topic: args.topic,
        enqueuedAtMs: monotonicMs(),
        sessionToken: token,
      }
      const q = queues.get(args.target.address) ?? []
      q.push(job)
      queues.set(args.target.address, q)
      kick(args.target.address)
      return ok({
        ok: true as const,
        delivered_to: { personality: args.target.personality, runtime: args.target.runtime },
        woke: false,
        queued: true,
        queuedBy: 'composer',
        queueDepth: q.length,
        ts: new Date().toISOString(),
      })
    },
    failAll: async reason => {
      closed = true
      const jobs = Array.from(queues.values()).flat()
      queues.clear()
      await Promise.all(jobs.map(job => notifyFailed(job, reason)))
    },
  }
}

function truncateTopic(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  return raw.slice(0, MAX_TOPIC_LEN)
}

function validateAttachments(value: readonly string[] = []): Result<string[]> {
  if (value.length > MAX_ATTACHMENTS) return err(`attachments exceeds ${MAX_ATTACHMENTS} item limit`)
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.startsWith('/')) {
      return err('attachments must contain only absolute local paths')
    }
    // Audit #17: a newline in a path corrupts the envelope's attachments framing (paths
    // are joined by '\n') — reject it rather than emit a malformed envelope.
    if (/[\n\r]/.test(item)) {
      return err('attachment paths must not contain newline characters')
    }
    out.push(item)
  }
  return ok(out)
}

// ─── Telegram-domain sender policy ─

/** A SENDER face in the telegram domain: a non-empty interfaces.telegram.bot_username
 *  (the bot binding key SINCE the bot_username-cutover) in the peer's registry passport.
 *  Deliberately bot_username-ONLY, not bot_username|user_id — the bridge picks the SENDING
 *  bot from the sender's bot_username key: a user_id grants a receive/operator identity but
 *  no ability to send, so a user_id-only sender passing the guard would still die at the
 *  bridge — a late asynchronous failure where the guard exists to give a synchronous one.
 *  The guard passes exactly what the bridge can deliver. (Legacy `bot` was the pre-cutover
 *  key; it is NO LONGER read here — the source of truth dropped it and telegram-runtime
 *  resolves the sending bot on bot_username. This guard is the foundation's only consumer
 *  of the telegram passport, so it moves with the cutover.) */
export function hasTelegramPresence(record: PeerRecord): boolean {
  const tg = record.interfaces?.telegram
  if (!tg || typeof tg !== 'object' || Array.isArray(tg)) return false
  const t = tg as Record<string, unknown>
  return typeof t.bot_username === 'string' && t.bot_username.trim() !== ''
}

/** Sender policy for the telegram domain: a peer with NO declared telegram presence
 *  must not write into it — the recipient (a human in Telegram) would face a message
 *  from a peer that has no telegram face (identity confusion: who writes, by what
 *  right?). Bot channel = declared presence; no presence — no right to the domain.
 *  Enforced at the ROUTER, not the bridge: the refusal is synchronous and lands in
 *  the sender's tool result; a bridge-side check would fire AFTER the router's
 *  ok:true — a false-OK + silent loss, the class this contract forbids. Applied to
 *  the INTENDED channel (override / target default — before any wake side-effect,
 *  since a wake delivers the envelope as the boot first-message) AND to the RESOLVED
 *  channel at both delivery points (the only-live-session fallback can land on
 *  telegram without either). */
function telegramSenderGuard(
  caller: ResolvedCaller,
  targetRuntime: string,
  targetPersonality: string,
): Result<void> {
  if (targetRuntime !== 'telegram') return ok(undefined)
  if (hasTelegramPresence(caller.record)) return ok(undefined)
  return err(
    `telegram policy: sender "${caller.personality}" has no telegram face (no interfaces.telegram.bot_username in its passport) — message to "${targetPersonality}" NOT delivered; route via a peer that has a telegram bot in its passport, or provision a bot for this sender`,
  )
}

/**
 * Route a send from a request-resolved caller to a target peer and deliver it.
 *  hit (live)  → build envelope from the CALLER → deliverWarm (host-aware) → {woke:false}
 *  miss (dead) → if deps.wake: wake the peer (envelope = boot first-message) →
 *                verify-before-act re-resolve → {woke:true}; else explicit
 *                "offline" (Ф1 behaviour). H4 (don't wake launchd peers) and the
 *                wake-runtime choice live INSIDE the injected WakeFn.
 * "cannot send to self" compares the resolved target address with the CALLER's
 * address from the request, not a per-process identity.
 */
export async function routeSend(
  caller: ResolvedCaller,
  input: SendToPeerInput,
  deps: RouteDeps = {},
): Promise<Result<RouteResult>> {
  const { personality, runtime, message } = input
  const topic = truncateTopic(input.topic)
  const attachmentsResult = validateAttachments(input.attachments ?? [])
  if (!attachmentsResult.ok) return attachmentsResult

  if (!personality || !message) {
    return err('send_to_peer requires non-empty "personality" and "message"')
  }
  if (!isValidName(personality)) {
    return err(`invalid personality "${personality}" — must match /^[a-z][a-z0-9-]{0,31}$/`)
  }
  if (runtime && !isRuntime(runtime)) {
    return err(`invalid runtime "${runtime}"`)
  }
  if (input.topic && input.topic.length > MAX_TOPIC_LEN) {
    return err(`topic exceeds ${MAX_TOPIC_LEN} char limit (got ${input.topic.length})`)
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return err(`message exceeds ${MAX_MESSAGE_LEN} char limit (got ${message.length})`)
  }

  const index = readPeersIndex()
  const peer = findPeer(index, personality)
  if (!peer) {
    return err(`peer "${personality}" is not in the iapeer peers index; message NOT delivered`)
  }

  // Telegram sender policy — INTENDED channel (explicit override, or the target's
  // default). Checked BEFORE any wake side-effect: a wake delivers the envelope as
  // the boot first-message, past the resolved-target guards further down.
  const intendedGuard = telegramSenderGuard(caller, runtime ?? peer.runtime, personality)
  if (!intendedGuard.ok) return intendedGuard

  // Built once — it is both the live-delivery payload and, on a miss, the wake
  // first-message (the woken session receives it as its boot task).
  const envelope = buildEnvelope({
    fromPersonality: caller.personality,
    fromRuntime: caller.runtime,
    fromIntelligence: caller.intelligence,
    topic,
    attachments: attachmentsResult.value,
    message,
  })

  // M3 wake_policy:"ephemeral" — an ephemeral target is NEVER injected into a live
  // session and never woken synchronously here: the delivery is ALWAYS enqueued
  // (per-peer disk FIFO) and drained one task per fresh session, asynchronously.
  // ONE delivery path by design: no live/miss race, strict FIFO, a clean context
  // window per task. Self-send is refused up front (a worker enqueueing to itself
  // would deadlock its own die-after-reply reap on a forever-non-empty queue).
  if (deps.ephemeral?.isEphemeral(peer.cwd)) {
    if (caller.personality === peer.personality) return err('cannot send to self')
    return deps.ephemeral.deliver({ peer, envelope, topic, runtime })
  }

  const target = resolvePeerDeliveryTarget(personality, runtime, peer)
  if (target.ok) {
    if (target.value.address === caller.address) return err('cannot send to self')
    // Telegram sender policy — RESOLVED channel (the only-live-session fallback can
    // land on telegram without an override and without telegram being the default).
    const liveGuard = telegramSenderGuard(caller, target.value.runtime, personality)
    if (!liveGuard.ok) return liveGuard
    const queued = await deps.composerQueue?.tryEnqueue({ caller, peer, target: target.value, envelope, topic })
    if (queued) return queued
    // peer.cwd enables the Ф-B transcript-mtime liveness probe (busy-session case).
    // deliverWarm is HOST-AWARE (spawn-flip Ф0b-2): a supervisor-hosted target delivers over its
    // socket, any other target keeps the tmux path. Flag-off → byte-identical to deliverViaTmux.
    const delivered = await deliverWarm(target.value, envelope, peer.cwd)
    if (!delivered.ok) return delivered
    noteTopic(deps, target.value.address, topic)
    return ok({
      ok: true,
      delivered_to: { personality: target.value.personality, runtime: target.value.runtime },
      woke: false,
      ts: new Date().toISOString(),
    })
  }

  // MISS — peer offline.
  if (!deps.wake) return target // Ф1: explicit offline, no wake
  const woke = await deps.wake({ personality, runtime, topic, task: envelope })
  if (woke.status === 'FAILED') {
    // C1 — a durably STOPPED peer is a deliberate halt, not a transient miss:
    // surface the explicit "stopped" reason (no "offline and wake failed" wrapping).
    if (woke.stopped) return err(woke.reason ?? `peer "${personality}" is stopped and not accepting messages`)
    return err(`peer "${personality}" offline and wake failed: ${woke.reason ?? 'unknown'}`)
  }
  // verify-before-act: re-resolve the now-live target before declaring success.
  const live = resolvePeerDeliveryTarget(personality, woke.runtime, peer)
  if (!live.ok) {
    return err(`woke "${personality}" but the session is not live (verify-before-act): ${live.error.message}`)
  }
  if (live.value.address === caller.address) return err('cannot send to self')
  // Telegram sender policy — post-wake RESOLVED channel (airtight: a wake should
  // never bring up a telegram session — they are launchd-held — but the policy is
  // enforced on every delivery point, not on an assumption about the wake).
  const postWakeGuard = telegramSenderGuard(caller, live.value.runtime, personality)
  if (!postWakeGuard.ok) return postWakeGuard
  // taskDelivered:false — the wake took the idempotent live-session fast path (a
  // CONCURRENT sender's boot won the wake.lock and delivered only ITS envelope as
  // the boot first-message). OUR envelope was not delivered by anything yet —
  // deliver it NOW via the live path (submit-confirm + liveness guards apply).
  // Without this, the second concurrent sender's message is silently lost behind
  // a false ok:true — the class the contract forbids. A delivery failure here is
  // surfaced loudly (false-FAIL over false-OK).
  if (woke.taskDelivered === false) {
    const queued = await deps.composerQueue?.tryEnqueue({ caller, peer, target: live.value, envelope, topic })
    if (queued) return queued
    const delivered = await deliverWarm(live.value, envelope, peer.cwd)
    if (!delivered.ok) return delivered
    noteTopic(deps, live.value.address, topic)
    return ok({
      ok: true,
      delivered_to: { personality: live.value.personality, runtime: live.value.runtime },
      woke: false, // honest: this sender's envelope went the LIVE path, not a boot
      ts: new Date().toISOString(),
    })
  }
  // The envelope was delivered as the boot first-message during wake.
  return ok({
    ok: true,
    delivered_to: { personality: live.value.personality, runtime: live.value.runtime },
    woke: true,
    ts: new Date().toISOString(),
  })
}
