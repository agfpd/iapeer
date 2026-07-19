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

import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'fs'
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
import { buildEnvelope, formatSentAt, renderEnvelopeForAgent } from '../codec/index.ts'
import { resolveGlobalRoot } from '../storage/index.ts'
import { findPeer, readPeersIndex, type PeerRecord } from '../registry/index.ts'
import type { ResolvedCaller } from '../identity/index.ts'
// Delivery markers are OWNED by the runtime adapter. transport
// reads them from getAdapter(target.runtime) for the tui submit path. One-way
// dependency: launch does NOT import transport, so no cycle.
import { getAdapter } from '../launch/index.ts'
import { codexSessionCwd } from '../launch/adapters/transcriptTail.ts'
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
  resubmitHosted,
} from '../launch/ptyHost.ts'
import { sendControlToHost, type DeliverResult } from '../supervisor/deliver.ts'
// Origin-guard (docs/18) — reply-channel mechanic for agent→human sends. Lives in
// transport because routeSend is the ONLY choke point both directions share (human
// inbound arrives via the CLI entry path, past the daemon — see originGuard.ts header).
import {
  armedOrigin,
  buildHoldNote,
  holdSend,
  noteHumanAnswered,
  noteHumanInbound,
  originGuardEnabled,
} from './originGuard.ts'
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

function sessionAlive(_sock: string, address: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // pty-only: a peer's liveness is its supervisor daemon (a cheap pid-file check). `address` IS the
  // identity. (`_sock` is retained for call-site compatibility; tmux sockets no longer exist.)
  // env sandboxes the run-dir — an env-injected verb must not read the real fleet's liveness.
  return hostSessionAlive(address, env)
}

/** Is the (runtime,personality) endpoint live right now? Public liveness predicate. */
export function isPeerLive(runtime: string, personality: string, sockDir = resolveSockDir(), env: NodeJS.ProcessEnv = process.env): boolean {
  const socketPath = buildSocketPath(runtime, personality, sockDir)
  return sessionAlive(socketPath, buildProcessAddress(runtime, personality), env)
}

export function listOnlinePeers(_sockDir = resolveSockDir(), env: NodeJS.ProcessEnv = process.env): OnlinePeer[] {
  // pty-only: every live peer is a supervisor-hosted session (no tmux sockets to scan).
  const out = new Map<string, OnlinePeer>()
  for (const h of listHostedPeers(env)) {
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
  /** Б7 — injected env sandboxes the liveness reads (supervisor run-dir); default process.env (prod). */
  env?: NodeJS.ProcessEnv
}): Result<DeliveryTarget> {
  const env = args.env ?? process.env
  const sockDir = args.sockDir ?? resolveSockDir(env)
  if (!isValidName(args.personality)) {
    return err(`invalid personality "${args.personality}" — must match /^[a-z][a-z0-9-]{0,31}$/`)
  }
  if (args.runtime) {
    if (!isRuntime(args.runtime)) return err(`invalid runtime "${args.runtime}"`)
    const runtime = args.runtime
    const socketPath = buildSocketPath(runtime, args.personality, sockDir)
    const address = buildProcessAddress(runtime, args.personality)
    if (!sessionAlive(socketPath, address, env)) {
      return err(`peer offline: ${args.personality} (${args.runtime})`)
    }
    return ok({ runtime, personality: args.personality, address, socketPath })
  }
  const matches = listOnlinePeers(sockDir, env).filter(peer => peer.personality === args.personality)
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
  env: NodeJS.ProcessEnv = process.env,
): Result<DeliveryTarget> {
  // Routing is CONFIG-ANCHORED, not liveness-selected. An omitted runtime means
  // exactly the peer's default_runtime (`PeerRecord.runtime` is the normalized
  // in-memory name), even when another declared runtime already has a live
  // session. If that default endpoint is asleep, returning its exact offline
  // miss is load-bearing: routeSend will wake THE DEFAULT instead of falling
  // through to whichever non-default session happens to be alive.
  //
  // An explicit runtime remains an exact override. `resolveDeliveryTarget`
  // without a runtime is deliberately NOT used here: its sole-live discovery is
  // useful for observation/control callers, but would silently defeat the
  // operator's `default-runtime` routing lever.
  return resolveDeliveryTarget({ personality, runtime: runtime ?? peer.runtime, env })
}

// Confirm poll interval — how often deliverViaHost re-reads the transcript for a NEW record carrying
// our envelope while waiting out the grace.
const LIVENESS_POLL_MS = 100

// Confirm grace — how long deliverViaHost polls for a transcript record CARRYING our envelope before
// declaring a false-FAIL. This applies ONLY to the 'transcript'-confirm runtimes (claude): claude
// writes the queue-operation (busy) / user-turn (idle) record PROMPTLY (sub-second), so a short grace
// suffices and the confirm doubles as a swallow-guard. codex is 'socket-ack' (adapter.deliveryConfirm)
// and never reaches this loop — its input queue is durable but it logs the user-input only at ingest
// (tens of seconds into a long turn), so a grace would only false-FAIL a message that WILL be processed.
// `IAP_HOST_LIVENESS_GRACE_MS` overrides (operator calibration; tests set 0 for an immediate
// deterministic fail). Prefer a false-FAIL (sender retries) over a false-OK (silent loss, forbidden).
const CONFIRM_GRACE_MS = 4000

// ATTACHMENT grace. The "sub-second" assumption above holds only WITHOUT attachments: an att>0 paste
// makes the receiving TUI ingest the files (hoist them into image blocks, rewrite the composer) before
// any turn can begin, so acceptance is not sub-second.
//
// CORRECTED 16.07.2026 — the model this number was first built on was WRONG. The original note here
// read the 15.07 att=4 measurement as "the receiver writes the user-record when it BEGINS the turn,
// and loading the images pushed that start ~22 s out", i.e. a LATE SELF-START that a longer grace
// would catch. A confound-free repro disproved it: att=4 into a claude receiver idle 2m17s, with
// NOTHING else sent, left the transcript byte-frozen for 180 s — the turn NEVER started, and the
// message moved only when an unrelated later delivery poked the session. The 15.07 "22 s self-start"
// was almost certainly that same confound. There is no late self-start to wait for: the SUBMIT was
// eaten, so a passive grace of ANY size waits for a record that cannot exist.
//
// WHICH deliveries get their CR eaten, measured: the FIRST attachment-bearing delivery into a session
// (reproduced on two independent sessions, and again on a purpose-built fresh one). Every LATER
// attachment delivery into the same session submits on the first CR in ~0.7–1 s, even at 9.3 MB. WHY
// the first differs is UNKNOWN — an intermediate "the CR lands mid-hoist" story was retracted as
// confounded, so no hoist-duration constant may be derived from it.
//
// What makes the grace meaningful is the SUBMIT-RETRY below, which needs no such answer: while no
// record has landed we keep pressing Enter, and whichever press finds the composer submittable does
// the work. 60 s is then just a generous give-up BOUND (not a calibrated latency), and it costs
// nothing on the happy path — the confirm returns the moment the record lands.
const CONFIRM_GRACE_ATTACHMENTS_MS = 60_000

// Submit-retry cadence — how often, WHILE NO RECORD HAS LANDED, the grace re-presses Enter on the
// receiver's composer (see the correction above; the primitive is ptyHost.resubmitHosted).
//
// WHY THIS IS SAFE. A bare CR reaches the composer in exactly one of two states: (a) it still holds
// our unsubmitted paste — the CR submits it, which is the entire point; or (b) it is empty because
// the turn already submitted — an empty composer ignores a CR. The loop is gated on `confirm()`
// being false, so we stop the instant the record appears.
//
// Deliberately NOT every poll (100 ms): a CR is a keystroke into a live, human-visible session, so the
// presses are spaced rather than machine-gunned. This is a PACING number only — it is explicitly NOT a
// "how long until the composer is submittable" estimate, because that duration is unknown and the whole
// point of retrying is not needing it. Raising or lowering it changes only how promptly a stuck message
// is rescued (measured live: a rescue landed at ~2.3 s with this value), never whether it is.
const RESUBMIT_INTERVAL_MS = 1500

function envNonNegative(raw: string | undefined): number | null {
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Does this envelope carry attachments — i.e. will the receiver have to ingest files before it
 *  records anything? Same marker `confirmNeedles` splits on, so the two cannot disagree. */
export function envelopeHasAttachments(envelope: string): boolean {
  return envelope.includes('<attachments>') && envelope.includes('</attachments>')
}

function confirmGraceMs(hasAttachments: boolean): number {
  // An EXPLICIT operator/test override wins for both modes — tests set 0 for a deterministic
  // immediate fail, and an operator calibrating one number must not be silently overridden by
  // the attachment branch.
  const explicit = envNonNegative(process.env.IAP_HOST_LIVENESS_GRACE_MS)
  if (explicit !== null) return explicit
  if (!hasAttachments) return CONFIRM_GRACE_MS
  return envNonNegative(process.env.IAP_HOST_LIVENESS_GRACE_ATTACHMENTS_MS) ?? CONFIRM_GRACE_ATTACHMENTS_MS
}

// Launchd-revive retry — a MISS on a launchd-managed target the daemon can't wake (H4)
// but launchd KeepAlive WILL revive (router restart / crash-revive window). routeSend
// re-resolves for up to this window before failing, bridging the gap (silent-loss guard).
// Env-tunable; default ~4s (a bootout→bootstrap router restart settles well under it).
const LAUNCHD_REVIVE_POLL_MS = 300
function launchdReviveGraceMs(): number {
  const raw = process.env.IAP_LAUNCHD_REVIVE_GRACE_MS
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 4000
}

// ─── Warm delivery (pty-only — supervisor socket) ────────────────────────────────────────────────

/** Test seam for `deliverWarm`. Production defaults route on the real supervisor + the real
 *  message-specific transcript confirm; tests inject a fake host-deliver + a synthetic landed-confirm,
 *  so the deliver path is covered with no live daemon. Omitting all fields = pure production. */
export interface WarmDeliverSeam {
  /** Deliver to the hosted session over its socket. Default: the real `deliverHosted` (Ф0a leaf). */
  deliverHosted?: (identity: string, envelope: string) => Promise<DeliverResult>
  /** MESSAGE-SPECIFIC landed-confirm: did a NEW transcript/session-jsonl record CARRYING this envelope
   *  appear since the pre-deliver baseline? Default: `transcriptCarriesEnvelope` over a file-size
   *  baseline captured before the send. A bare mtime bump (the receiver's OWN turn) is NOT a confirm —
   *  that was the false-OK class this replaces. */
  confirmLanded?: (envelope: string) => boolean
  /** Injectable async sleep for the confirm poll (tests). Default: setTimeout — it YIELDS the event
   *  loop (the grace is up to several seconds for codex, so a sync block would stall the whole router
   *  daemon for the duration of one delivery). */
  sleep?: (ms: number) => Promise<void>
  /** SUBMIT-RETRY: press Enter again on the receiver's composer while no record has landed. Default:
   *  the real `resubmitHosted` (a bare CR over the control channel). Tests inject a spy to assert the
   *  retry fires only while unconfirmed — and never once the record is in. */
  resubmit?: (identity: string) => Promise<void>
}

/**
 * Warm-deliver `envelope` to a LIVE local target over its supervisor socket (pty-only). Confirmation is
 * adapter-driven (RuntimeAdapter.deliveryConfirm):
 *   - 'transcript' (claude): CONFIRMED MESSAGE-SPECIFICALLY — by a NEW transcript record CARRYING this
 *     envelope appearing past the pre-deliver baseline, NOT the socket-ack (a flushed CR proves the
 *     bytes left us, not that the session accepted them) and NOT a bare mtime advance (the receiver's
 *     OWN concurrent turn bumps mtime even when our paste was swallowed — the false-OK class, forbidden).
 *   - 'socket-ack' (codex): confirmed by the socket-ack — its input queue is durable (a mid-turn submit
 *     is never lost) and it logs no prompt-acceptance record, so a transcript grace would only false-FAIL.
 *   - router (telegram/notifier): no transcript → confirmed by the socket-ack (liveness is structural
 *     via launchd KeepAlive).
 * See `deliverViaHost`.
 */
// В6 — per-target delivery serialization. deliverToHost is paste → 300ms settle → CR over the pty; two
// CONCURRENT deliveries to the SAME hosted session interleave their frames (paste2 lands inside paste1's
// settle window → CR1 submits the SPLICED "envelope1envelope2" as one turn, CR2 submits an empty
// composer; for a router target the splice breaks the mate's per-envelope framing). Chain deliveries per
// address so each paste+settle+CR (and its confirm) completes as a UNIT before the next to that address
// starts. Different addresses stay parallel. Covers the DOMINANT path — every agent send_to_peer routes
// through the SINGLE daemon process; a rare CLI in-process `iapeer send` is a separate process this chain
// does not span (fully hermetic serialization would live in the supervisor as a per-session transaction).
const deliverTails = new Map<string, Promise<unknown>>()

export async function deliverWarm(
  target: DeliveryTarget,
  envelope: string,
  cwd?: string,
  seam: WarmDeliverSeam = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result<void>> {
  // Envelope-compaction F: an AGENT target (claude/codex — an LLM reads the text)
  // receives the compact presentation; a bridge target (telegram/notifier/…)
  // receives the WIRE form its parser expects. Rendered BEFORE deliverViaHost so
  // the transcript-confirm matches the text actually delivered. fail-open inside
  // the renderer: a render problem degrades to the wire form, never to a loss.
  const payload = isSupportedLocalRuntime(target.runtime) ? renderEnvelopeForAgent(envelope) : envelope
  const address = target.address
  const prev = deliverTails.get(address) ?? Promise.resolve()
  // run AFTER prev settles (success or failure) — a prior delivery's error must not stall the chain
  const run = prev.then(
    () => deliverViaHost(target, payload, cwd, seam, env),
    () => deliverViaHost(target, payload, cwd, seam, env),
  )
  deliverTails.set(
    address,
    run.then(
      () => {},
      () => {},
    ),
  )
  return run
}

async function deliverViaHost(
  target: DeliveryTarget,
  envelope: string,
  cwd: string | undefined,
  seam: WarmDeliverSeam,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Result<void>> {
  const adapter = getAdapter(target.runtime)
  // Baseline the transcript/session-jsonl file SIZES BEFORE delivery (per-runtime candidate files).
  // The landed-confirm reads ONLY the bytes appended past this baseline, so a record carrying our
  // envelope can only be one written in RESPONSE to this delivery — never a pre-existing copy.
  // LAZY: only 'transcript'-confirm runtimes (claude) use the baseline; router (socket-ack) and
  // socket-ack runtimes (codex) return before it — computing it for them recursively scanned all of
  // ~/.codex/sessions (full-file read per session) on every delivery for nothing.
  const usesBaseline = adapter.kind !== 'router' && adapter.deliveryConfirm !== 'socket-ack'
  const baseline = cwd && usesBaseline ? compactDoneBaseline(target.runtime, cwd, { env }) : null
  // Б7 — the default deliverHosted resolves the supervisor run-dir from env (sandboxed under a test root).
  const send = seam.deliverHosted ?? ((identity: string, msg: string) => deliverHosted(identity, msg, env))
  const sent = await send(target.address, envelope)
  if (!sent.ok) {
    return err(
      `hosted peer "${target.personality}" (${target.runtime}) deliver failed: ${sent.error ?? 'unknown error'}; ` +
        `message NOT delivered`,
    )
  }
  // Router (telegram/notifier): no transcript proxy → confirmed by the socket-ack just obtained. A
  // router's liveness is structural via launchd KeepAlive (not a model turn), so the ack IS the
  // delivery-level confirm (parity with the legacy tmux router C-j path).
  if (adapter.kind === 'router') return ok(undefined)
  // 'socket-ack' TUI runtimes (codex): the input queue is DURABLE — a mid-turn submit is HELD and
  // processed at the next turn boundary, however long that is (verified live 2026-06-25: an 80s turn
  // still ingested + replied; the send false-FAILed at the 8s grace, the message was NOT lost). codex
  // writes NO prompt-acceptance record (its user-input lands only at ingest), so a transcript grace
  // can't tell "swallowed" from "queued-but-not-yet-ingested" within any useful window — it only
  // false-FAILs a message that WILL be delivered, wrongly escalating to a fallback peer. The flushed
  // socket-ack above IS the delivery confirm; a genuinely dead session already failed at deliverHosted
  // (no socket / stalled flush) → really-dead still escalates. (claude stays on the strict
  // message-specific confirm below — it logs acceptance sub-second, so that is cheap AND catches a
  // swallowed paste, the false-OK class.) Driven by adapter.deliveryConfirm, not a hardcoded runtime.
  if (adapter.deliveryConfirm === 'socket-ack') return ok(undefined)
  // socket-ack ≠ landed. With no transcript (direct callers/tests without a cwd) we can only trust the
  // flushed submit — confirmed-only.
  if (!cwd || !baseline) return ok(undefined)
  // MESSAGE-SPECIFIC landed-confirm — the false-OK killer (claude / any 'transcript'-confirm runtime;
  // codex took the socket-ack short-circuit above). A bare transcript/pane-log mtime BUMP is NOT proof
  // the session took THIS message: a receiver in an active turn advances both mtimes with its OWN
  // rendering even when our paste was swallowed at the turn boundary (incident 2026-06-23: ok=true,
  // message gone). The ONLY proof is a NEW transcript record CARRYING the DELIVERED payload (for an
  // agent target that is the compact `<iap from=…>` presentation — deliverWarm rendered it before this
  // point, so the needle matches what was actually pasted) — for claude, a queue-operation `content`
  // (busy → enqueued) or the user-turn message (idle), written sub-second so a short grace covers it.
  // The receiver's own assistant/tool turn never reproduces the full delivered envelope verbatim, so it
  // cannot forge a confirm. No such record within the grace → false-FAIL (the sender retries) — NOT a
  // false-OK (silent loss the contract forbids).
  const confirm = seam.confirmLanded ?? ((payload: string) => transcriptCarriesEnvelope(baseline, payload, { env }))
  const sleep = seam.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const resubmit = seam.resubmit ?? (async (identity: string) => void (await resubmitHosted(identity, env)))
  const graceMs = confirmGraceMs(envelopeHasAttachments(envelope))
  const graceDeadline = monotonicMs() + graceMs
  // SUBMIT-RETRY (see RESUBMIT_INTERVAL_MS). deliverToHost already pressed Enter once, on a fixed
  // settle; that CR is sometimes EATEN, and then NOTHING is running and no record can ever appear. So
  // the grace does not merely WAIT for a record — while none has landed it keeps pressing Enter, and
  // whichever press finds the composer submittable does the work. Cause-agnostic ON PURPOSE: it does
  // not model WHY a CR was eaten (still unknown), so there is deliberately no tuned duration constant
  // on this path — which is also what keeps it correct at any payload weight.
  let nextResubmitAt = monotonicMs() + RESUBMIT_INTERVAL_MS
  while (true) {
    if (confirm(envelope)) return ok(undefined)
    if (monotonicMs() >= graceDeadline) break
    if (monotonicMs() >= nextResubmitAt) {
      // confirm() was false microseconds ago, so the composer still holds our paste — or the record
      // landed in that gap and this CR meets an empty composer, which ignores it.
      await resubmit(target.address)
      nextResubmitAt = monotonicMs() + RESUBMIT_INTERVAL_MS
    }
    await sleep(LIVENESS_POLL_MS)
  }
  return err(
    `hosted peer "${target.personality}" (${target.runtime}) is listed live but did not accept the message ` +
      `(no transcript record carrying the message within ${graceMs}ms) — live but unresponsive to this delivery (not dead); message NOT delivered`,
  )
}

/** Pane-log (TUI render-stream) mtime for a process address, or null when absent/unreadable.
 *  The pane-log is the canonical `<root>/logs/lifecycle/<address>.log` the supervisor appends raw
 *  pty bytes to (§1 contract). Used by `resolveLiveRuntime` (freshest-pane-log among alive sessions).
 *  NB: deliberately NOT used to confirm delivery — a pane-log mtime bump is not message-specific (the
 *  receiver's own turn bumps it too), which was exactly the false-OK class deliverViaHost now avoids. */
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

// codexSessionCwd (bounded first-line read + path-memoized) is shared from launch/adapters/transcriptTail.ts —
// the old full-file readFileSync here scanned tens of MB per session file on every warm delivery baseline.

/** Read ONLY the bytes of `path` past `offset` (the appended tail), without loading the whole file.
 *  O(added bytes) instead of O(entire history) — the transcript files this scans grow to hundreds of MB.
 *  Returns '' on any fs error / empty tail. */
function readFileTailFrom(path: string, offset: number): string {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return ''
  }
  try {
    const size = fstatSync(fd).size
    const start = Math.min(Math.max(0, offset), size)
    const len = size - start
    if (len <= 0) return ''
    const buf = Buffer.allocUnsafe(len)
    let read = 0
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read)
      if (n <= 0) break
      read += n
    }
    return buf.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    closeSync(fd)
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
    const tail = readFileTailFrom(path, offset) // tail-only read (see transcriptCarriesEnvelope)
    if (!tail) continue
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

/** Deep-search every string value of a parsed JSON record for `needle` (CR-stripped on the haystack
 *  side; the needle is pre-stripped by the caller). */
/** ALL needles must be present in ONE string value — not scattered across the record. Splitting
 *  the confirm into head+tail (see confirmNeedles) only stays as forge-resistant as the whole
 *  envelope if both halves are found in the SAME string the receiver actually stored. */
function jsonStringValuesContainAll(value: unknown, needles: readonly string[]): boolean {
  if (typeof value === 'string') {
    const s = value.replace(/\r/g, '')
    return needles.every(n => s.includes(n))
  }
  if (Array.isArray(value)) return value.some(v => jsonStringValuesContainAll(v, needles))
  if (value && typeof value === 'object') return Object.values(value).some(v => jsonStringValuesContainAll(v, needles))
  return false
}

/**
 * The substrings whose presence in ONE new record proves the receiver took THIS envelope.
 *
 * Normally that is the whole envelope: long, unique, and a receiver's own turn does not
 * reproduce it verbatim, so it cannot forge a confirm.
 *
 * WITH ATTACHMENTS the whole envelope is the wrong needle, because the receiver REWRITES it.
 * Measured 15.07.2026 (claude receiver, 4 PNGs). Sent:
 *
 *   <iap …>⏎Reply via send_to_peer.⏎<attachments>a.png⏎…⏎d.png</attachments>⏎<msg>…</msg>⏎</iap>
 *
 * Stored by the receiver:
 *
 *   [Image #108] [Image #109]<iap …>⏎Reply via send_to_peer.⏎d.png</attachments>⏎<msg>…</msg>⏎</iap>
 *
 * The runtime hoists the images into separate image blocks, prepends `[Image #N]` placeholders,
 * and eats the OPENING `<attachments>` tag plus the paths it consumed. The envelope no longer
 * contains itself → no match → a 4 s false-FAIL on a message that DID land. The sender then
 * retries and duplicates it in the receiver's context (three times, live, before this fix).
 *
 * The mutation is structurally CONFINED to the attachments region: the `<iap …>` header and the
 * whole `<msg>…</msg></iap>` tail were byte-intact in the stored record. So we match around the
 * damage — head + tail, both required in the same string value.
 *
 * NOT a short unique token in the header, which is the tempting fix: a short, predictable needle
 * is one the receiver can reproduce in its OWN turn (agents quote IAP headers when reporting),
 * and that forges a confirm. A false-OK is silent loss — the one outcome this contract forbids —
 * while a false-FAIL merely costs a retry. Head+tail keeps the original forge-resistance bar:
 * to fake it the receiver must echo both the header and the entire body verbatim.
 */
export function confirmNeedles(envelope: string): string[] {
  const n = envelope.replace(/\r/g, '')
  const OPEN = '<attachments>'
  const CLOSE = '</attachments>'
  const open = n.indexOf(OPEN)
  if (open < 0) return [n] // no attachments → nothing rewrites the envelope → strongest needle
  const close = n.indexOf(CLOSE, open + OPEN.length)
  if (close < 0) return [n] // malformed → fall back to the whole envelope rather than guess
  const head = n.slice(0, open).trimEnd()
  const tail = n.slice(close + CLOSE.length).trimStart()
  const parts = [head, tail].filter(p => p.length > 0)
  return parts.length ? parts : [n]
}

/**
 * Did a NEW transcript/session-jsonl record CARRYING `envelope` appear since `baseline` (the
 * per-runtime absolute file paths + SIZES captured immediately before delivery)? This is the
 * MESSAGE-SPECIFIC landed-confirm `deliverViaHost` uses to kill the false-OK class — a bare mtime
 * advance from the receiver's OWN turn is NOT a confirm; only a record echoing our envelope is.
 *
 * Reads ONLY the bytes appended past each baseline offset, JSON-parses each new jsonl line, and
 * deep-searches its string values for the envelope (CR-normalized on both sides — a stored line may
 * carry CR the envelope never had; CR is never semantically meaningful inside an IAP envelope). A
 * match means the SESSION recorded our injection:
 *   claude — busy: a `queue-operation` whose `content` is the pasted envelope verbatim; idle: the
 *            user-turn message.
 *   codex  — a user-input `response_item` (written at model-turn-start).
 * The receiver's own assistant/tool records never reproduce the `<iap from-personality=…>` wrapper, so
 * the full envelope is UNFORGEABLE by a concurrent turn — no false-OK. Because only bytes PAST the
 * baseline offset are read, a pre-existing copy of an identical earlier message cannot pass either.
 *
 * Scans each baseline file from its captured offset AND any session file that APPEARS AFTER the baseline
 * from offset 0 — the post-baseline pickup is load-bearing. A FRESH session (self-fresh/eager-fresh)
 * writes its NEW jsonl LAZILY on the first delivered turn, so the confirming record for the FIRST delivery
 * into that session lands in a file the baseline never captured (the fresh jsonl is born ~a beat AFTER the
 * pre-deliver baseline snapshot). Iterating baseline-only made EVERY such first-delivery a false-FAIL: the
 * dead OLD session file gets scanned, the live NEW one is ignored, and the confirm reported "not delivered"
 * for a message the session had actually accepted + processed (verified live 2026-07-10: telegram-arthur →
 * mrmechanic ok=false, yet the envelope stood in the fresh jsonl at +0.3s, within the grace). A
 * post-baseline file is BRAND-NEW for this cwd, so reading it from 0 cannot match a pre-existing copy
 * (nothing pre-existed), and the full `<iap from-personality=…>` envelope is unforgeable by the receiver's
 * own assistant/tool turn — the SAME false-OK safety `compactTranscriptHasDone` already relies on. In
 * production this loop runs ONLY for claude (codex confirms by the socket-ack BEFORE reaching here), so the
 * per-poll re-list is a single cheap readdirSync of one project dir — never a recursive `~/.codex/sessions`
 * walk. `env` scopes the re-list under a test HOME (default process.env).
 */
export function transcriptCarriesEnvelope(
  baseline: CompactDoneBaseline,
  envelope: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): boolean {
  const needles = confirmNeedles(envelope)
  if (!needles.length || needles.every(n => !n)) return false
  // Baseline files at their pre-deliver offset; a file NOT in the baseline (born after it) is read from 0.
  const offsets = new Map(baseline.files.map(f => [f.path, f.size]))
  for (const path of compactCandidateFiles(baseline.runtime, baseline.cwd, opts.env)) {
    if (!offsets.has(path)) offsets.set(path, 0)
  }
  for (const [path, offset] of offsets) {
    // Read ONLY the tail past the offset — a full readFileSync here re-read the ENTIRE transcript
    // (hundreds of MB for a long-running peer) on every ~100ms confirm-poll, stalling the single-threaded
    // router event loop for the whole fleet.
    const tail = readFileTailFrom(path, offset)
    if (!tail) continue
    for (const line of tail.split(/\r?\n/)) {
      if (!line.trim()) continue
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (jsonStringValuesContainAll(obj, needles)) return true
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
    /** Router-acceptance instant (formatSentAt) — the enqueue ACK's `ts` mirrors
     *  it so sender-side ts ≡ envelope ts holds on the queued path too. */
    sentAt?: string
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
  /** Router-acceptance instant (formatSentAt) — the queued ACK's `ts` mirrors it. */
  sentAt?: string
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
  /** Б7 — injected env sandboxes ALL of routeSend's env-resolved reads (the registry, the supervisor
   *  run-dir liveness/delivery). Default process.env (prod: env === process.env). Closes the daemon:286
   *  isolation invariant — a library/test daemon with an injected root no longer reads the real registry
   *  or the real fleet's live sessions. */
  env?: NodeJS.ProcessEnv
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
  /** В7 — stamp a CONFIRMED live delivery (target identity) so superviseTick's idle proxy floors on it
   *  and cannot reap the session before the just-delivered message's turn record lands. Injected (same
   *  layering as noteLiveTopic — lifecycle.setLastDelivered wired in main.ts). */
  noteDelivered?: (identity: string) => void
  /** H4 launchd-managed detector (injected so transport never imports lifecycle —
   *  main.ts wires the real `isLaunchdManaged`). A MISS on a launchd-managed target is
   *  almost always a TRANSIENT restart window (router restart on connect / `iapeer
   *  update`, or a crash that KeepAlive is reviving), NOT a real outage: the daemon
   *  can't wake it (H4) but launchd WILL revive it in ~1s. So routeSend retries the
   *  RESOLVE for a bounded window before failing, bridging the gap (prevents the
   *  silent-loss class: an in-flight delivery — esp. to a HUMAN over a telegram router —
   *  dropped during a restart). Absent → no retry (legacy behaviour). */
  isLaunchdManaged?: (personality: string) => boolean
  /** Injectable async sleep for the launchd-revive retry poll (tests). Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Origin-guard bypass — set ONLY by `iapeer confirm-send` (the held-send delivery).
   *  DELIBERATELY a RouteDeps field, not a SendToPeerInput field: tool arguments are
   *  agent-supplied, so an input flag would let any agent forge the bypass; deps are
   *  wired by the entry points (daemon/CLI), out of the agent's reach. */
  originGuardBypass?: boolean
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

/** Best-effort lastDelivered stamp (В7) — records a CONFIRMED live delivery so the idle-reap proxy
 *  cannot reap the session out from under a just-delivered message before its turn record lands. */
function noteDelivered(deps: RouteDeps, identity: string): void {
  try {
    deps.noteDelivered?.(identity)
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
  /** В7 — stamp a confirmed queued delivery (same seam as RouteDeps.noteDelivered). */
  noteDelivered?: (identity: string) => void
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
    void drain(identity)
      .catch(() => {
        /* drain is internally best-effort; a stray throw must not surface as an unhandled rejection */
      })
      .finally(() => {
        draining.delete(identity)
        // В9 — close the enqueue-during-teardown race: a job pushed AFTER drain's empty-return but
        // BEFORE this finally cleared `draining` saw kick() no-op (draining still held), leaving it
        // undrained until some unrelated later enqueue. Re-kick if work remains so it drains promptly.
        if (queues.get(identity)?.length) kick(identity)
      })
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

      // В8 — take the head OUT of the queue BEFORE committing to deliver. A concurrent failAll snapshots
      // only what remains queued, so an IN-FLIGHT job is never both delivered AND failed (the dup / false-
      // failure the exactly-once contract forbids). The head stayed queued during the composer poll-wait
      // above (still undelivered → failAll correctly fails it); it leaves the queue only at this commit.
      q.shift()
      let delivered: Result<void>
      try {
        delivered = await deliver(job.target, job.envelope, job.peer.cwd)
      } catch (e) {
        // deliverWarm normally returns a Result, but a defensive catch keeps drain from throwing (which,
        // with the В9 re-kick, could otherwise spin) — an unexpected throw is a delivery failure.
        await notifyFailed(job, `queued delivery to ${job.target.personality} (${job.target.runtime}) failed: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      if (!delivered.ok) {
        await notifyFailed(job, `queued delivery to ${job.target.personality} (${job.target.runtime}) failed: ${delivered.error.message}`)
      } else {
        noteTopic({ noteLiveTopic: opts.noteLiveTopic }, job.target.address, job.topic)
        try {
          opts.noteDelivered?.(job.target.address) // В7 — floor the idle proxy for the queued delivery too
        } catch {
          /* best-effort */
        }
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
        ts: args.sentAt ?? new Date().toISOString(),
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
 *  channel at both delivery points (defence in depth against registry/wake drift). */
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
  const result = await routeSendInner(caller, input, deps)
  // Origin-guard stamps — AFTER an ok outcome only (a failed send answered nothing and
  // carried no inbound). Best-effort: a stamp failure must never fail a delivered
  // message. Covers EVERY ok path (live / queued / wake / launchd-revive) in one place.
  if (result.ok) stampOriginOnDelivered(caller, input.personality, deps.env ?? process.env)
  return result
}

/** Post-ok origin stamps: human→agent ⇒ inbound (arms the pair with the human's origin
 *  channel); agent→human ⇒ answered (disarms). Any other pair — no-op. */
function stampOriginOnDelivered(caller: ResolvedCaller, targetPersonality: string, env: NodeJS.ProcessEnv): void {
  try {
    if (!originGuardEnabled(env)) return
    const peer = findPeer(readPeersIndex({ env }), targetPersonality)
    if (!peer) return
    if (caller.intelligence === 'natural' && peer.intelligence === 'artificial') {
      noteHumanInbound(peer.personality, caller.personality, caller.runtime, { env })
    } else if (caller.intelligence === 'artificial' && peer.intelligence === 'natural') {
      noteHumanAnswered(caller.personality, peer.personality, { env })
    }
  } catch {
    /* stamps are observability for the guard — never fail a delivered message */
  }
}

async function routeSendInner(
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

  const env = deps.env ?? process.env
  const index = readPeersIndex({ env })
  const peer = findPeer(index, personality)
  if (!peer) {
    return err(`peer "${personality}" is not in the iapeer peers index; message NOT delivered`)
  }

  // Origin-guard (docs/18) — an agent's PRESUMED REPLY to a human (the human's latest
  // inbound to this agent is unanswered) must target the channel the human wrote from.
  // Checked FIRST, before any resolve/wake side-effect and before the telegram policy:
  // a mismatch is HELD (persisted verbatim + instructive error), not delivered — the
  // agent then confirms cross-channel or redirects to the origin, zero regeneration.
  // Intended runtime = the explicit override or the human's default; exact for the
  // natural-peer class (implicit routing is strictly default_runtime-anchored).
  // Initiative (answered / no inbound / ARM_TTL-stale) passes untouched.
  if (
    !deps.originGuardBypass &&
    originGuardEnabled(env) &&
    caller.intelligence === 'artificial' &&
    peer.intelligence === 'natural'
  ) {
    const armed = armedOrigin(caller.personality, peer.personality, { env })
    const intendedRt = runtime ?? peer.runtime
    if (armed && armed.rt !== intendedRt) {
      const held = holdSend(
        caller.address,
        { personality, runtime, message, topic, attachments: attachmentsResult.value },
        armed,
        intendedRt,
        { env },
      )
      return err(buildHoldNote(held, { env }))
    }
  }

  // Telegram sender policy — INTENDED channel (explicit override, or the target's
  // default). Checked BEFORE any wake side-effect: a wake delivers the envelope as
  // the boot first-message, past the resolved-target guards further down.
  const intendedGuard = telegramSenderGuard(caller, runtime ?? peer.runtime, personality)
  if (!intendedGuard.ok) return intendedGuard

  // Stamped ONCE at router acceptance: the same instant travels as the envelope's
  // `ts` attribute (recipient side) AND is returned as the result's `ts` (sender
  // side) — the two correspond literally, which is what makes async-desync
  // visible (the recipient can tell how old the message it is reading is).
  const sentAt = formatSentAt(new Date())
  // Built once — it is both the live-delivery payload and, on a miss, the wake
  // first-message (the woken session receives it as its boot task). This is the
  // WIRE form; agent-bound hops re-render it compactly at delivery.
  const envelope = buildEnvelope({
    fromPersonality: caller.personality,
    fromRuntime: caller.runtime,
    fromIntelligence: caller.intelligence,
    sentAt,
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
    return deps.ephemeral.deliver({ peer, envelope, topic, runtime, sentAt })
  }

  const target = resolvePeerDeliveryTarget(personality, runtime, peer, env)
  if (target.ok) {
    if (target.value.address === caller.address) return err('cannot send to self')
    // Telegram sender policy — RESOLVED channel (defence in depth: the resolved
    // target must still obey the domain guard even though selection is exact).
    const liveGuard = telegramSenderGuard(caller, target.value.runtime, personality)
    if (!liveGuard.ok) return liveGuard
    const queued = await deps.composerQueue?.tryEnqueue({ caller, peer, target: target.value, envelope, topic, sentAt })
    if (queued) return queued
    // peer.cwd enables the Ф-B transcript-mtime liveness probe (busy-session case).
    // deliverWarm is HOST-AWARE (spawn-flip Ф0b-2): a supervisor-hosted target delivers over its
    // socket, any other target keeps the tmux path. Flag-off → byte-identical to deliverViaTmux.
    const delivered = await deliverWarm(target.value, envelope, peer.cwd, {}, env)
    if (!delivered.ok) return delivered
    noteTopic(deps, target.value.address, topic)
    noteDelivered(deps, target.value.address) // В7 — floor the idle proxy so this delivery isn't reaped away
    return ok({
      ok: true,
      delivered_to: { personality: target.value.personality, runtime: target.value.runtime },
      woke: false,
      ts: sentAt,
    })
  }

  // MISS — peer offline.
  if (!deps.wake) return target // Ф1: explicit offline, no wake
  // LAUNCHD-REVIVE RETRY: a launchd-managed target the daemon can't wake (H4) but launchd
  // KeepAlive WILL revive — a MISS here is almost always a transient RESTART WINDOW (router
  // restart on connect / `iapeer update`, or a crash-revive), not a real outage. Wake would
  // just refuse (launchd-managed) and the delivery would fail in ~16ms — losing an in-flight
  // message (observed: natalya→arthur ok=false ms=16 during a connect router restart; a
  // message to a HUMAN, the silent-loss-adjacent class). Bridge it: re-resolve for a bounded
  // window and deliver the instant it revives. Each poll RE-RESOLVES the live target
  // (verify-before-act) → the ok reflects a CONFIRMED delivery (no false-OK); a genuinely
  // down peer still fails LOUD after the window (retryable, never silent).
  if (deps.isLaunchdManaged?.(personality)) {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
    const reviveDeadline = monotonicMs() + launchdReviveGraceMs()
    while (monotonicMs() < reviveDeadline) {
      await sleep(LAUNCHD_REVIVE_POLL_MS)
      const revived = resolvePeerDeliveryTarget(personality, runtime, peer, env)
      if (!revived.ok) continue // not back yet — keep polling until the deadline
      if (revived.value.address === caller.address) return err('cannot send to self')
      const reviveGuard = telegramSenderGuard(caller, revived.value.runtime, personality)
      if (!reviveGuard.ok) return reviveGuard
      const delivered = await deliverWarm(revived.value, envelope, peer.cwd, {}, env)
      if (delivered.ok) {
        noteTopic(deps, revived.value.address, topic)
        return ok({
          ok: true,
          delivered_to: { personality: revived.value.personality, runtime: revived.value.runtime },
          woke: false,
          ts: sentAt,
        })
      }
      // resolved but the deliver didn't land (session still settling) → keep polling
    }
    return err(
      `peer "${personality}" (launchd-managed) offline and did not revive within ${launchdReviveGraceMs()}ms ` +
        `(restart window outlasted the grace?) — message NOT delivered; retry`,
    )
  }
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
    const queued = await deps.composerQueue?.tryEnqueue({ caller, peer, target: live.value, envelope, topic, sentAt })
    if (queued) return queued
    const delivered = await deliverWarm(live.value, envelope, peer.cwd, {}, env)
    if (!delivered.ok) return delivered
    noteTopic(deps, live.value.address, topic)
    return ok({
      ok: true,
      delivered_to: { personality: live.value.personality, runtime: live.value.runtime },
      woke: false, // honest: this sender's envelope went the LIVE path, not a boot
      ts: sentAt,
    })
  }
  // The envelope was delivered as the boot first-message during wake.
  return ok({
    ok: true,
    delivered_to: { personality: live.value.personality, runtime: live.value.runtime },
    woke: true,
    ts: sentAt,
  })
}
