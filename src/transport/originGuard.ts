// Origin-guard (docs/18) — the daemon-layer mechanic against the "agent answered the
// human in the wrong channel" error class. Doctrine (origin-routing: reply where the
// human wrote from) lives in every agent's memory — unreliable by construction; this
// module enforces it MECHANICALLY at the delivery choke point, routeSend (§3 of the
// host rules: fix errors at the right layer).
//
// WHY transport, not the daemon: live forensics of delivery.log showed that ALL
// human-inbound traffic (telegram-arthur / web-arthur) arrives via `iapeer send`
// (path=cli — the bridges run the CLI verb, an IN-PROCESS routeSend that never touches
// the daemon's callTool), and codex agents send through the CLI shim too. routeSend is
// the ONLY point both directions and both entry paths (daemon MCP + CLI) share — a
// daemon-side guard would be blind to the inbound half and never arm.
//
// Model (per (human, agent) pair, humans = intelligence:natural):
//   • inbound stamp   — an ok human→agent delivery records {rt, inboundTs}.
//   • answered stamp  — an ok agent→human delivery records answeredTs.
//   • armed           — inboundTs > answeredTs (the latest inbound is UNANSWERED) and
//                       younger than ARM_TTL. Discriminates reply-vs-initiative
//                       semantically: an outbound while armed is presumed a REPLY (must
//                       match the origin channel); once answered (or TTL-stale), any
//                       further outbound is INITIATIVE — no friction. A pure time
//                       window would either miss the long-task class (asked from web,
//                       answered 2h later into telegram) or false-hold initiative.
//   • hold            — an armed mismatch (intended runtime ≠ origin runtime) is NOT
//                       delivered: the send is persisted verbatim as a pending file and
//                       the sender gets an instructive error. `iapeer confirm-send <id>`
//                       delivers it as addressed; `--runtime <origin>` redirects it to
//                       the origin channel — zero message regeneration either way.
//
// State is on DISK (not daemon memory) because the CLI entry path is a short-lived
// process, and stamps must survive daemon restarts. Writes are atomic
// (storage.writeFileAtomic); concurrent read-modify-write is LAST-WINS by design — the
// guard is soft, stamp frequency is human-paced, and a lost stamp degrades to at most
// one extra confirm (owner-approved v1 fork; add locking only if it bites live).
//
// Paths resolve from the injected env (the readPeersIndex({env}) pattern) so the
// IAPEER_ROOT sandbox isolates tests — never from a re-resolved process.env.

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { err, ok, type Result } from '../core/errors.ts'
import { pluginStateDir, writeFileAtomic } from '../storage/index.ts'
import { formatSentAt } from '../codec/index.ts'

/** Kill-switch: IAPEER_ORIGIN_GUARD=0 disables the guard AND the stamps host-wide. */
export function originGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IAPEER_ORIGIN_GUARD !== '0'
}

const DEFAULT_ARM_TTL_MS = 48 * 60 * 60 * 1000 // 48 h — covers a realistic reply latency, cuts staleness
const DEFAULT_PENDING_TTL_MS = 15 * 60 * 1000 // 15 min — the agent confirms within its current turn

function envPosInt(raw: string | undefined, dflt: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

export function armTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return envPosInt(env.IAPEER_ORIGIN_GUARD_ARM_TTL_MS, DEFAULT_ARM_TTL_MS)
}

export function pendingTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return envPosInt(env.IAPEER_ORIGIN_GUARD_PENDING_TTL_MS, DEFAULT_PENDING_TTL_MS)
}

export interface OriginGuardOptions {
  env?: NodeJS.ProcessEnv
  /** Injectable clock (tests). Default Date.now. */
  nowMs?: number
}

// ── Origin state (last inbound / answered, per agent→human pair) ─────────────────

export interface OriginEntry {
  /** The runtime the human's latest message arrived FROM (its origin channel). */
  rt: string
  /** When that inbound was delivered ok (epoch ms). */
  inboundTs: number
  /** When the agent last answered this human ok (epoch ms). Absent = never. */
  answeredTs?: number
}

/** agent personality → human personality → entry. */
type OriginState = Record<string, Record<string, OriginEntry>>

function originDir(env: NodeJS.ProcessEnv): string {
  return join(pluginStateDir('iapeer', { env }), 'origin')
}

function statePath(env: NodeJS.ProcessEnv): string {
  return join(originDir(env), 'state.json')
}

function pendingDir(env: NodeJS.ProcessEnv): string {
  return join(originDir(env), 'pending')
}

function readState(env: NodeJS.ProcessEnv): OriginState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(env), 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as OriginState
  } catch {
    /* missing / corrupt → empty (the guard fails open: no state, no holds) */
  }
  return {}
}

function writeState(env: NodeJS.ProcessEnv, state: OriginState): void {
  mkdirSync(originDir(env), { recursive: true })
  writeFileAtomic(statePath(env), `${JSON.stringify(state)}\n`)
}

/** Record an ok human→agent delivery: the human's origin channel + instant. */
export function noteHumanInbound(agent: string, human: string, rt: string, opts: OriginGuardOptions = {}): void {
  const env = opts.env ?? process.env
  const now = opts.nowMs ?? Date.now()
  const state = readState(env)
  const perAgent = (state[agent] ??= {})
  const prev = perAgent[human]
  // Keep answeredTs — a NEWER inbound re-arms regardless, since inboundTs > answeredTs.
  perAgent[human] = { rt, inboundTs: now, ...(prev?.answeredTs !== undefined ? { answeredTs: prev.answeredTs } : {}) }
  writeState(env, state)
}

/** Record an ok agent→human delivery: the pair is answered (disarms the guard). */
export function noteHumanAnswered(agent: string, human: string, opts: OriginGuardOptions = {}): void {
  const env = opts.env ?? process.env
  const now = opts.nowMs ?? Date.now()
  const state = readState(env)
  const entry = state[agent]?.[human]
  if (!entry) return // nothing to disarm — never wrote to us via the router
  entry.answeredTs = now
  writeState(env, state)
}

/** The ARMED origin for (agent, human), or null: the latest inbound is unanswered AND
 *  younger than ARM_TTL. Null = initiative / already answered / stale — no friction. */
export function armedOrigin(agent: string, human: string, opts: OriginGuardOptions = {}): OriginEntry | null {
  const env = opts.env ?? process.env
  const now = opts.nowMs ?? Date.now()
  const entry = readState(env)[agent]?.[human]
  if (!entry) return null
  if (entry.answeredTs !== undefined && entry.answeredTs >= entry.inboundTs) return null
  if (now - entry.inboundTs > armTtlMs(env)) return null
  return entry
}

// ── Pending (held) sends ─────────────────────────────────────────────────────────

export interface HeldSend {
  id: string
  /** The sender's address (`<runtime>-<personality>`) — the identity confirm-send re-sends AS. */
  caller: string
  personality: string
  runtime?: string
  message: string
  topic?: string
  attachments?: string[]
  /** The armed origin channel the human last wrote from (unanswered). */
  originRt: string
  /** When that unanswered inbound arrived (epoch ms) — shown in the hold note. */
  originTs: number
  /** The channel this send would have landed in (input.runtime ?? the human's default). */
  intendedRt: string
  createdMs: number
}

function pendingPath(env: NodeJS.ProcessEnv, id: string): string {
  return join(pendingDir(env), `${id}.json`)
}

function claimedPath(env: NodeJS.ProcessEnv, id: string): string {
  return join(pendingDir(env), `${id}.json.claimed`)
}

/** Lazy GC — unlink pending files older than the pending TTL (by mtime). Called on
 *  every hold/claim touch; cheap (one readdir of a near-empty dir), no timers. */
export function sweepExpiredPendings(opts: OriginGuardOptions = {}): void {
  const env = opts.env ?? process.env
  const now = opts.nowMs ?? Date.now()
  const ttl = pendingTtlMs(env)
  let entries: string[]
  try {
    entries = readdirSync(pendingDir(env))
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.endsWith('.json') && !name.endsWith('.json.claimed')) continue
    const path = join(pendingDir(env), name)
    try {
      if (now - statSync(path).mtimeMs > ttl) unlinkSync(path)
    } catch {
      /* raced away / unreadable — best-effort */
    }
  }
}

/** Persist a held send verbatim and return its record. */
export function holdSend(
  callerAddress: string,
  input: { personality: string; runtime?: string; message: string; topic?: string; attachments?: string[] },
  origin: OriginEntry,
  intendedRt: string,
  opts: OriginGuardOptions = {},
): HeldSend {
  const env = opts.env ?? process.env
  const now = opts.nowMs ?? Date.now()
  sweepExpiredPendings(opts)
  const id = `og-${randomBytes(4).toString('hex')}`
  const held: HeldSend = {
    id,
    caller: callerAddress,
    personality: input.personality,
    ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
    message: input.message,
    ...(input.topic !== undefined ? { topic: input.topic } : {}),
    ...(input.attachments?.length ? { attachments: [...input.attachments] } : {}),
    originRt: origin.rt,
    originTs: origin.inboundTs,
    intendedRt,
    createdMs: now,
  }
  mkdirSync(pendingDir(env), { recursive: true })
  writeFileAtomic(pendingPath(env, id), `${JSON.stringify(held, null, 2)}\n`)
  return held
}

/** The instructive error the sender receives INSTEAD of a delivery. Self-sufficient:
 *  it names the mismatch, both zero-regeneration exits, and the TTL. */
export function buildHoldNote(held: HeldSend, opts: OriginGuardOptions = {}): string {
  const env = opts.env ?? process.env
  const ttlMin = Math.round(pendingTtlMs(env) / 60_000)
  return (
    `origin-guard: "${held.personality}" last wrote to you from "${held.originRt}" ` +
    `(${formatSentAt(new Date(held.originTs))}) and that message is not yet answered — ` +
    `this send targets "${held.intendedRt}". Message NOT delivered; held verbatim as ${held.id} (expires in ${ttlMin} min).\n` +
    `- cross-channel is intentional → deliver as addressed: iapeer confirm-send ${held.id}\n` +
    `- reply to the origin channel instead: iapeer confirm-send ${held.id} --runtime ${held.originRt}\n` +
    `Do not re-send the message text — confirm-send delivers the held message.`
  )
}

/** Claim a pending send for delivery — atomic rename (<id>.json → <id>.json.claimed),
 *  so a concurrent second confirm loses cleanly (ENOENT → "no pending"). TTL-checked. */
export function claimHeldSend(id: string, opts: OriginGuardOptions = {}): Result<HeldSend> {
  const env = opts.env ?? process.env
  const now = opts.nowMs ?? Date.now()
  sweepExpiredPendings(opts)
  const src = pendingPath(env, id)
  const dst = claimedPath(env, id)
  let raw: string
  try {
    renameSync(src, dst) // atomic claim — exactly one confirmer wins
    raw = readFileSync(dst, 'utf8')
  } catch {
    return err(`no pending held send "${id}" (expired, already confirmed, or unknown) — re-send the message instead`)
  }
  let held: HeldSend
  try {
    held = JSON.parse(raw) as HeldSend
  } catch {
    try {
      unlinkSync(dst)
    } catch {
      /* best-effort */
    }
    return err(`held send "${id}" is unreadable (corrupt pending file) — re-send the message instead`)
  }
  if (now - held.createdMs > pendingTtlMs(env)) {
    try {
      unlinkSync(dst)
    } catch {
      /* best-effort */
    }
    return err(`held send "${id}" expired (${Math.round(pendingTtlMs(env) / 60_000)} min TTL) — re-send the message instead`)
  }
  return ok(held)
}

/** Delivery failed — put the claimed pending back so confirm-send can be retried until TTL. */
export function restoreHeldSend(id: string, opts: OriginGuardOptions = {}): void {
  const env = opts.env ?? process.env
  try {
    renameSync(claimedPath(env, id), pendingPath(env, id))
  } catch {
    /* best-effort */
  }
}

/** Delivery succeeded — drop the claimed pending. */
export function discardHeldSend(id: string, opts: OriginGuardOptions = {}): void {
  const env = opts.env ?? process.env
  try {
    unlinkSync(claimedPath(env, id))
  } catch {
    /* best-effort */
  }
}
