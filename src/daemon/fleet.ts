// Fleet-API — the daemon's OPERATOR-CLIENT HTTP surface (Ф0 of iapeer-tray: one
// fleet-API in the daemon, many thin faces on top — SwiftBar / native tray / web
// gateway / telegram approval buttons). Plain HTTP+JSON + SSE, DELIBERATELY NOT an
// MCP tool: MCP is the AGENT surface and the contract keeps it minimal
// (send_to_peer only — an extra tool occupies every session's context window);
// fleet clients are GUIs/scripts that consume HTTP natively.
//
// Design pillars (spec accepted by the PM 05.07.2026; normative client contract in
// docs/15-fleet-api.md):
//   • SNAPSHOT truth = the SAME in-process primitives `iapeer list` uses
//     (cli.listPeers) — agreement with the CLI is by construction, not by parsing.
//   • EVENTS = tail-follow of the THREE durable logs (lifecycle.log / delivery.log /
//     exits.log under cfg.eventLogDir). Those logs are written by EVERY process
//     (daemon + CLI attach/stop/wake + supervisor deaths) — an in-memory daemon bus
//     would silently miss the CLI-originated events. At-least-once semantics;
//     clients MUST ignore unknown `ev` kinds (the approval-request growth seam).
//   • COMMANDS = the EXISTING verb functions called in-process (stopPeer/startPeer/
//     newPeer/refreshPeer/compactPeer/wakeOrSpawn/routeControl) — H4, the fleet
//     guard and the crash-loop guard all live INSIDE those functions, so the API
//     cannot bypass them. send routes through daemon.callTool — the SAME path as
//     the MCP tool (delivery.log line + all post-delivery hooks included).
//
// Security class: unchanged. The endpoints listen on the SAME two listeners
// (0600 unix socket + TCP loopback) behind the SAME optional H8 bearer gate
// (checked in daemon/index.ts BEFORE dispatch); command power ≤ what the same-uid
// CLI already has. NO CORS headers — a browser page must NOT be able to drive
// loopback fleet commands cross-origin; the future web gateway is its own decision
// with bearer mandatory (see the frozen TCP open-auth decision + its triggers).
//
// Layering: this module is a COMPOSITION-SIDE sibling of daemon/main.ts (wired via
// StartDaemonOptions.fleet — the same injected-seam pattern as wake/supervise), so
// the daemon library stays lifecycle-free. The CLI verb functions are loaded via a
// LAZY dynamic import: cli/index.ts statically imports daemon/main.ts, so a static
// import back would create the repo's first import cycle.

import type { IncomingMessage, ServerResponse } from 'http'
import { closeSync, openSync, readSync, statSync } from 'fs'
import { buildProcessAddress } from '../core/socket.ts'
import { IAPEER_VERSION } from '../core/version.ts'
import {
  ephemeralQueueDepth,
  isEphemeralPeer,
  isLaunchdManaged,
  loadLifecycleConfig,
  peerApprovalMode,
  wakeOrSpawn,
  type LifecycleConfig,
} from '../lifecycle/index.ts'
import { lifecycleLogPath } from '../lifecycle/eventlog.ts'
import { exitLogPath } from '../launch/index.ts'
import { hasAttachedSupervisorClient } from '../launch/ptyHost.ts'
import { readPeersIndex } from '../registry/index.ts'
import { resolveCallerIdentity, type ResolvedCaller } from '../identity/index.ts'
import { routeControl } from '../transport/index.ts'
import {
  eventConcernsPeer,
  parseEventLine,
  readLogTail,
  type ParsedEventLine,
} from '../storage/rotatelog.ts'
import { heartbeatAgeSecs, probeFullDiskAccess, readMemoryProvider, readVoiceProvider } from '../status/index.ts'
import { deliveryLogPath } from './deliverylog.ts'
import { approvalsLogPath } from './approvalslog.ts'
import { ApprovalBroker } from './approvals.ts'
import { callTool, type CallToolDeps } from './index.ts'

/** The API generation baked into every snapshot (additive evolution within v1 —
 *  see docs/15-fleet-api.md «Compatibility»). */
export const FLEET_API_VERSION = 1

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot
// ─────────────────────────────────────────────────────────────────────────────

export interface FleetRuntimeStatus {
  runtime: string
  status: 'live' | 'asleep' | 'stopped'
  /** Present (true) iff a HUMAN operator is attached to this live hosted session. */
  attached?: boolean
}

export interface FleetPeer {
  personality: string
  description: string
  intelligence: string
  default_runtime: string
  cwd: string
  runtimes: FleetRuntimeStatus[]
  last_active_runtime?: string
  last_active_ms?: number
  /** Any runtime session with a human attached. */
  attached: boolean
  /** H4 — launchd owns this peer's lifecycle; the daemon (and the wake/stop/start
   *  commands) treat it read-only / guarded. */
  launchd_managed: boolean
  wake_policy: 'warm' | 'ephemeral'
  /** Ephemeral peers only: pending serial-queue tasks across declared runtimes. */
  queue_depth?: number
  /** Human-approval mode (docs/17-approval): `yolo` (default — bypass + auto-confirm
   *  circuit-breakers) or `gated` (blocking runtime approvals routed to a human). */
  approval_mode: 'yolo' | 'gated'
}

export interface FleetHost {
  version: string
  pid: number
  startedAt: string
  uptimeSecs: number
  memory: { provider: string; version: string; heartbeatAgeSecs: number | null } | null
  voice: { provider: string; version: string; heartbeatAgeSecs: number | null } | null
  fda: boolean | null
}

export interface FleetSnapshot {
  api: typeof FLEET_API_VERSION
  version: string
  ts: string
  host: FleetHost
  peers: FleetPeer[]
}

// The CLI op functions, injectable for tests. Defaults LAZY-load cli/index.ts at
// call time (see the layering note in the module header).
export interface FleetOps {
  listPeers: (opts: { env?: NodeJS.ProcessEnv }) => import('../cli/index.ts').PeerListing[]
  stopPeer: typeof import('../cli/index.ts').stopPeer
  startPeer: typeof import('../cli/index.ts').startPeer
  refreshPeer: typeof import('../cli/index.ts').refreshPeer
  newPeer: typeof import('../cli/index.ts').newPeer
  compactPeer: typeof import('../cli/index.ts').compactPeer
}

async function defaultOps(): Promise<FleetOps> {
  const cli = await import('../cli/index.ts')
  return {
    listPeers: cli.listPeers,
    stopPeer: cli.stopPeer,
    startPeer: cli.startPeer,
    refreshPeer: cli.refreshPeer,
    newPeer: cli.newPeer,
    compactPeer: cli.compactPeer,
  }
}

/** Assemble the full fleet snapshot. Peer rows come from the SAME listPeers the CLI
 *  `list` verb renders — agreement with `iapeer list` is by construction. On top:
 *  the occupancy/ownership facts the registry row alone does not carry (attached
 *  human, H4 launchd ownership, wake_policy, ephemeral queue depth). */
export function buildFleetSnapshot(
  env: NodeJS.ProcessEnv,
  cfg: LifecycleConfig,
  ops: Pick<FleetOps, 'listPeers'>,
  startedAtMs: number,
  nowMs: number = Date.now(),
): FleetSnapshot {
  const peers: FleetPeer[] = ops.listPeers({ env }).map(r => {
    const runtimes: FleetRuntimeStatus[] = r.runtimes.map(s => {
      const attached =
        s.status === 'live' && hasAttachedSupervisorClient(buildProcessAddress(s.runtime, r.personality), env)
      return { runtime: s.runtime, status: s.status, ...(attached ? { attached: true } : {}) }
    })
    let ephemeral = false
    try {
      ephemeral = isEphemeralPeer(r.cwd)
    } catch {
      /* unreadable profile → treated as warm */
    }
    let queueDepth = 0
    if (ephemeral) {
      for (const s of r.runtimes) queueDepth += ephemeralQueueDepth(cfg, buildProcessAddress(s.runtime, r.personality))
    }
    // Approval mode from the LOCAL profile (same source as ephemeral); a read hiccup →
    // the safe `yolo` default (peerApprovalMode swallows it).
    const approvalMode = peerApprovalMode(r.cwd)
    return {
      personality: r.personality,
      description: r.description,
      intelligence: r.intelligence,
      default_runtime: r.default_runtime,
      cwd: r.cwd,
      runtimes,
      ...(r.last_active_runtime ? { last_active_runtime: r.last_active_runtime } : {}),
      ...(r.last_active_ms !== undefined ? { last_active_ms: r.last_active_ms } : {}),
      attached: runtimes.some(s => s.attached === true),
      launchd_managed: isLaunchdManaged(r.personality, env),
      wake_policy: ephemeral ? ('ephemeral' as const) : ('warm' as const),
      ...(ephemeral ? { queue_depth: queueDepth } : {}),
      approval_mode: approvalMode,
    }
  })
  const mem = readMemoryProvider(env)
  const voice = readVoiceProvider(env)
  return {
    api: FLEET_API_VERSION,
    version: IAPEER_VERSION,
    ts: new Date(nowMs).toISOString(),
    host: {
      version: IAPEER_VERSION,
      pid: process.pid,
      startedAt: new Date(startedAtMs).toISOString(),
      uptimeSecs: Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)),
      memory: mem
        ? { provider: mem.provider, version: mem.version, heartbeatAgeSecs: heartbeatAgeSecs(mem, nowMs) }
        : null,
      voice: voice
        ? { provider: voice.provider, version: voice.version, heartbeatAgeSecs: heartbeatAgeSecs(voice, nowMs) }
        : null,
      fda: probeFullDiskAccess(env),
    },
    peers,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Events — tail-follow of the durable logs → SSE
// ─────────────────────────────────────────────────────────────────────────────

export interface FleetEvent extends ParsedEventLine {
  /** Which log the event came from: lifecycle | delivery | exits. */
  src: string
}

/** The three durable event logs under cfg.eventLogDir (exits.log shares the dir —
 *  lifecycle/index.ts passes exitLogDir: cfg.eventLogDir). */
export function fleetEventFiles(cfg: LifecycleConfig): Array<{ path: string; src: string }> {
  return [
    { path: lifecycleLogPath(cfg.eventLogDir), src: 'lifecycle' },
    { path: deliveryLogPath(cfg.eventLogDir), src: 'delivery' },
    { path: exitLogPath(cfg.eventLogDir), src: 'exits' },
    // Human-approval broker events (docs/17): approval-request / approval-resolved.
    // A pre-approval daemon simply never writes this file (readLogTail tolerates absence).
    { path: approvalsLogPath(cfg.eventLogDir), src: 'approvals' },
  ]
}

/** The newest `limit` events across the given logs (merged by timestamp) — the SSE
 *  `replay=N` primer and the peer-detail recent-events reader. Reads only the last
 *  64 KiB of each file. */
export function readRecentEvents(
  files: Array<{ path: string; src: string }>,
  limit: number,
  concerning?: string,
): FleetEvent[] {
  const events: FleetEvent[] = []
  for (const f of files) {
    for (const line of readLogTail(f.path).split('\n')) {
      const e = parseEventLine(line)
      if (!e) continue
      if (concerning && !eventConcernsPeer(e, concerning)) continue
      events.push({ ...e, src: f.src })
    }
  }
  events.sort((a, b) => a.tsMs - b.tsMs)
  return events.slice(-limit)
}

interface TailState {
  path: string
  src: string
  offset: number
  partial: string
}

/**
 * Shared poll-based tail-follower over the durable logs: ONE timer regardless of
 * how many SSE subscribers are connected (starts with the first, stops with the
 * last). Rotation-aware: a size SMALLER than the held offset means the base file
 * was rotated away (base → .1) — reading restarts at 0 on the fresh file. Poll is
 * deliberately chosen over fs.watch: rotation-robust, no platform edge cases, and
 * a few-hundred-ms latency is invisible on a dashboard.
 */
export class FleetEventTailer {
  private readonly files: TailState[]
  private readonly subs = new Set<(e: FleetEvent) => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  constructor(
    files: Array<{ path: string; src: string }>,
    private readonly pollMs = 400,
    private readonly statSize: (path: string) => number | null = defaultStatSize,
    private readonly readFrom: (path: string, offset: number, length: number) => string | null = defaultReadFrom,
  ) {
    this.files = files.map(f => ({ ...f, offset: -1, partial: '' }))
  }

  /** Subscribe to live events; returns the unsubscribe function. The FIRST
   *  subscriber primes every offset to the current EOF (history is the replay
   *  reader's job) and starts the poll timer; the last unsubscribe stops it. */
  subscribe(fn: (e: FleetEvent) => void): () => void {
    if (this.subs.size === 0) {
      for (const f of this.files) {
        f.offset = this.statSize(f.path) ?? 0
        f.partial = ''
      }
      this.timer = setInterval(() => this.tick(), this.pollMs)
      this.timer.unref?.()
    }
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
      if (this.subs.size === 0 && this.timer) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    }
  }

  /** One poll pass over every file — exposed for tests (deterministic, no timer). */
  tick(): void {
    for (const f of this.files) {
      const size = this.statSize(f.path)
      if (size === null) {
        // file gone (rotation window / never created yet) — restart at 0 when it appears
        f.offset = 0
        f.partial = ''
        continue
      }
      if (size < f.offset) {
        // rotated: base moved to .1, a fresh base is being written — restart
        f.offset = 0
        f.partial = ''
      }
      if (size === f.offset) continue
      const chunk = this.readFrom(f.path, f.offset, size - f.offset)
      if (chunk === null) continue // transient read failure — retry next tick
      f.offset = size
      const text = f.partial + chunk
      const lines = text.split('\n')
      f.partial = lines.pop() ?? '' // the trailing piece before the next newline
      for (const line of lines) {
        const e = parseEventLine(line)
        if (!e) continue
        for (const s of [...this.subs]) {
          try {
            s({ ...e, src: f.src })
          } catch {
            /* a subscriber must never break the tailer */
          }
        }
      }
    }
  }
}

function defaultStatSize(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

function defaultReadFrom(path: string, offset: number, length: number): string | null {
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(length)
      const n = readSync(fd, buf, 0, length, offset)
      return buf.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────────

const JSON_HEADERS = { 'content-type': 'application/json' }
const MAX_BODY_BYTES = 64 * 1024
const SSE_HEARTBEAT_MS = 15_000
const MAX_REPLAY = 500

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, JSON_HEADERS)
  res.end(`${JSON.stringify(value)}\n`)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('request body must be a JSON object'))
          return
        }
        resolve(parsed as Record<string, unknown>)
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e instanceof Error ? e.message : String(e)}`))
      }
    })
    req.on('error', reject)
  })
}

/** Resolve the SENDER identity for POST /fleet/v1/send. Explicit `from` (either a
 *  full `<runtime>-<personality>` or a bare personality → its default runtime) wins;
 *  otherwise the SINGLE natural-intelligence peer of the registry (the host owner —
 *  a GUI-originated message is the human's). Ambiguity → an instructive error. */
export function resolveSendCaller(from: string | undefined, env: NodeJS.ProcessEnv): ResolvedCaller {
  const index = readPeersIndex({ env })
  if (from?.trim()) {
    const raw = from.trim()
    const byName = index.peers.find(p => p.personality === raw)
    if (byName) return resolveCallerIdentity({ personality: byName.personality, runtime: byName.runtime }, index)
    const dash = raw.indexOf('-')
    if (dash > 0) {
      return resolveCallerIdentity({ runtime: raw.slice(0, dash), personality: raw.slice(dash + 1) }, index)
    }
    throw new Error(`unknown from peer "${raw}"`)
  }
  const natural = index.peers.filter(p => p.intelligence === 'natural')
  if (natural.length === 1) {
    return resolveCallerIdentity({ personality: natural[0]!.personality, runtime: natural[0]!.runtime }, index)
  }
  throw new Error(
    natural.length === 0
      ? 'no natural-intelligence peer registered — pass "from" explicitly'
      : `ambiguous default sender (${natural.length} natural peers) — pass "from" explicitly`,
  )
}

export interface FleetHandlerOptions {
  env?: NodeJS.ProcessEnv
  /** Injectable CLI ops (tests). Default: lazy dynamic import of cli/index.ts. */
  ops?: FleetOps
  /** Injectable tailer poll interval (tests). */
  pollMs?: number
  /** Injectable approval broker (tests — e.g. a short timeout). Default: a fresh one. */
  broker?: ApprovalBroker
}

export type FleetHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { deps: CallToolDeps },
) => Promise<void>

/**
 * Build the /fleet/v1 request handler the composition point injects into
 * startDaemon (StartDaemonOptions.fleet). One handler instance per daemon —
 * it owns the shared event tailer and the daemon start timestamp.
 */
export function buildFleetHandler(opts: FleetHandlerOptions = {}): FleetHandler {
  const env = opts.env ?? process.env
  const cfg = loadLifecycleConfig(env)
  const startedAtMs = Date.now()
  const files = fleetEventFiles(cfg)
  const tailer = new FleetEventTailer(files, opts.pollMs)
  // The approval broker — one per daemon; the ASK side (POST /approvals long-poll) and
  // the ANSWER side (GET/POST /approvals/*) are all interfaces to this one queue.
  const broker = opts.broker ?? new ApprovalBroker({ logDir: cfg.eventLogDir, env })
  let opsPromise: Promise<FleetOps> | undefined
  const getOps = (): Promise<FleetOps> => {
    if (opts.ops) return Promise.resolve(opts.ops)
    opsPromise ??= defaultOps()
    return opsPromise
  }

  return async (req, res, ctx) => {
    const url = new URL(req.url ?? '/', 'http://fleet.local')
    const path = url.pathname
    const method = (req.method ?? 'GET').toUpperCase()
    try {
      // ── reads ────────────────────────────────────────────────────────────
      if (path === '/fleet/v1/snapshot') {
        if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed — GET /fleet/v1/snapshot' })
        return sendJson(res, 200, buildFleetSnapshot(env, cfg, await getOps(), startedAtMs))
      }
      if (path === '/fleet/v1/events') {
        if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed — GET /fleet/v1/events' })
        serveEvents(req, res, url, tailer, files)
        return
      }
      const peerMatch = /^\/fleet\/v1\/peers\/([^/]+)$/.exec(path)
      if (peerMatch) {
        if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed — GET /fleet/v1/peers/<peer>' })
        const personality = decodeURIComponent(peerMatch[1]!)
        const snapshot = buildFleetSnapshot(env, cfg, await getOps(), startedAtMs)
        const peer = snapshot.peers.find(p => p.personality === personality)
        if (!peer) return sendJson(res, 404, { error: `unknown peer "${personality}"` })
        const events = readRecentEvents(files, 50, personality)
        return sendJson(res, 200, { api: FLEET_API_VERSION, version: IAPEER_VERSION, ts: snapshot.ts, peer, events })
      }
      // ── commands ─────────────────────────────────────────────────────────
      const cmdMatch = /^\/fleet\/v1\/peers\/([^/]+)\/(wake|stop|start|new|refresh|interrupt|compact)$/.exec(path)
      if (cmdMatch) {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed — POST' })
        const personality = decodeURIComponent(cmdMatch[1]!)
        const command = cmdMatch[2]!
        let body: Record<string, unknown>
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
        const runtime = typeof body.runtime === 'string' ? body.runtime : undefined
        const topic = typeof body.topic === 'string' ? body.topic : undefined
        return await runCommand(res, command, { personality, runtime, topic }, cfg, env, await getOps())
      }
      if (path === '/fleet/v1/send') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed — POST /fleet/v1/send' })
        let body: Record<string, unknown>
        try {
          body = await readBody(req)
        } catch (e) {
          return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
        if (typeof body.personality !== 'string' || !body.personality || typeof body.message !== 'string' || !body.message) {
          return sendJson(res, 400, { error: 'send needs {personality, message} (+ optional runtime/topic/from)' })
        }
        let caller: ResolvedCaller
        try {
          caller = resolveSendCaller(typeof body.from === 'string' ? body.from : undefined, env)
        } catch (e) {
          return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
        }
        // The SAME path the MCP tool takes (routeSend + delivery.log + post-delivery
        // hooks) — ctx.deps is the daemon's own wired CallToolDeps.
        const result = await callTool(
          caller,
          'send_to_peer',
          {
            personality: body.personality,
            runtime: typeof body.runtime === 'string' ? body.runtime : undefined,
            message: body.message,
            topic: typeof body.topic === 'string' ? body.topic : undefined,
          },
          ctx.deps,
        )
        const text = result.content[0]?.text ?? ''
        if (result.isError) return sendJson(res, 502, { error: text })
        return sendJson(res, 200, { from: caller.address, result: safeParse(text) })
      }
      // ── approvals — the human-approval broker surface (docs/17) ────────────
      if (path === '/fleet/v1/approvals') {
        if (method === 'GET') {
          return sendJson(res, 200, { api: FLEET_API_VERSION, version: IAPEER_VERSION, ts: new Date().toISOString(), approvals: broker.list() })
        }
        if (method === 'POST') {
          // The gated peer's hook BLOCKS here (long-poll): enqueue + await a decision.
          let body: Record<string, unknown>
          try {
            body = await readBody(req)
          } catch (e) {
            return sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) })
          }
          if (typeof body.personality !== 'string' || !body.personality || typeof body.tool !== 'string' || typeof body.content !== 'string') {
            return sendJson(res, 400, { error: 'approval request needs {personality, runtime, tool, content} (+ optional kind/summary/title/approvers)' })
          }
          const { id, decision } = broker.request({
            personality: body.personality,
            runtime: typeof body.runtime === 'string' ? body.runtime : 'claude',
            kind: typeof body.kind === 'string' ? body.kind : 'tool',
            tool: body.tool,
            content: body.content,
            summary: typeof body.summary === 'string' ? body.summary : undefined,
            title: typeof body.title === 'string' ? body.title : undefined,
            approvers: Array.isArray(body.approvers) ? body.approvers.filter((a): a is string => typeof a === 'string') : undefined,
          })
          // No idle-socket kill during the (≤ broker-timeout) hold; cancel default-deny
          // if the asking hook's transport dies before an answer (drop it from the queue).
          res.setTimeout?.(0)
          let settled = false
          const onClose = (): void => {
            if (!settled) broker.cancel(id)
          }
          req.on('close', onClose)
          const d = await decision
          settled = true
          return sendJson(res, 200, { id, ...d })
        }
        return sendJson(res, 405, { error: 'method not allowed — GET|POST /fleet/v1/approvals' })
      }
      const apMatch = /^\/fleet\/v1\/approvals\/([^/]+)(?:\/(approve|deny))?$/.exec(path)
      if (apMatch) {
        const id = decodeURIComponent(apMatch[1]!)
        const action = apMatch[2]
        if (!action) {
          if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed — GET /fleet/v1/approvals/<id>' })
          const item = broker.get(id)
          if (!item) return sendJson(res, 404, { error: `no pending approval "${id}"` })
          return sendJson(res, 200, { api: FLEET_API_VERSION, version: IAPEER_VERSION, ts: new Date().toISOString(), approval: item })
        }
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed — POST /fleet/v1/approvals/<id>/(approve|deny)' })
        let body: Record<string, unknown> = {}
        try {
          body = await readBody(req)
        } catch {
          /* empty/invalid body is fine — approve/deny carry only optional fields */
        }
        const by = typeof body.approver === 'string' ? body.approver : undefined
        const via = typeof body.via === 'string' ? body.via : 'cli'
        const ok =
          action === 'approve'
            ? broker.resolve(id, { decision: 'allow', reason: typeof body.reason === 'string' ? body.reason : undefined }, { by, via })
            : broker.resolve(id, { decision: 'deny', reason: typeof body.reason === 'string' ? body.reason : 'denied by human' }, { by, via })
        if (!ok) return sendJson(res, 404, { error: `no pending approval "${id}" (already resolved, expired, or unknown)` })
        return sendJson(res, 200, { id, action, ok: true })
      }
      return sendJson(res, 404, {
        error: `unknown fleet endpoint ${method} ${path}`,
        endpoints: [
          'GET /fleet/v1/snapshot',
          'GET /fleet/v1/peers/<peer>',
          'GET /fleet/v1/events?replay=N',
          'POST /fleet/v1/peers/<peer>/(wake|stop|start|new|refresh|interrupt|compact)',
          'POST /fleet/v1/send',
          'GET /fleet/v1/approvals',
          'POST /fleet/v1/approvals (hook long-poll)',
          'GET /fleet/v1/approvals/<id>',
          'POST /fleet/v1/approvals/<id>/(approve|deny)',
        ],
      })
    } catch (e) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
      } else {
        try {
          res.end()
        } catch {
          /* connection already gone */
        }
      }
    }
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function runCommand(
  res: ServerResponse,
  command: string,
  args: { personality: string; runtime?: string; topic?: string },
  cfg: LifecycleConfig,
  env: NodeJS.ProcessEnv,
  ops: FleetOps,
): Promise<void> {
  const { personality, runtime, topic } = args
  switch (command) {
    case 'wake': {
      // Same H4 / crash-loop / wake-lock semantics as a message wake — wakeOrSpawn
      // owns them. task:'' = bare bring-up (the seed/initial prompt is the first turn).
      const r = await wakeOrSpawn({ personality, runtime, topic, task: '' }, { cfg, env })
      return sendJson(res, r.status === 'FAILED' ? 502 : 200, { command, ...r })
    }
    case 'stop': {
      const outcomes = ops.stopPeer(personality, runtime, { env })
      const failed = outcomes.some(o => o.action === 'refused-foreign-launchd' || (o.action === 'bootout' && o.reason !== undefined))
      return sendJson(res, failed ? 502 : 200, { command, outcomes })
    }
    case 'start': {
      const outcomes = ops.startPeer(personality, runtime, { env })
      const failed = outcomes.some(o => o.action === 'refused-foreign-launchd' || (o.action === 'bootstrap' && o.reason !== undefined))
      return sendJson(res, failed ? 502 : 200, { command, outcomes })
    }
    case 'new': {
      const o = await ops.newPeer(personality, runtime, { env })
      return sendJson(res, o.action === 'fresh' ? 200 : 502, { command, ...o })
    }
    case 'refresh': {
      const outcomes = ops.refreshPeer(personality, runtime, { env })
      return sendJson(res, 200, { command, outcomes })
    }
    case 'interrupt': {
      const r = await routeControl(personality, runtime, { name: 'interrupt' })
      if (!r.ok) return sendJson(res, 502, { command, error: r.error.message })
      return sendJson(res, 200, { ...r.value, command }) // routeControl echoes its own `command` — ours (the endpoint name) wins
    }
    case 'compact': {
      const o = await ops.compactPeer(personality, runtime, { env })
      return sendJson(res, o.action === 'compacted' ? 200 : 502, { command, ...o })
    }
    default:
      return sendJson(res, 404, { error: `unknown command "${command}"` })
  }
}

/** Serve the SSE event stream: optional replay of the newest N historical events,
 *  then live tail. At-least-once semantics (a reconnect may re-see events — `id`
 *  is the event's epoch-ms for client-side dedup); heartbeat comment every 15 s. */
function serveEvents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  tailer: FleetEventTailer,
  files: Array<{ path: string; src: string }>,
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const writeEvent = (e: FleetEvent): void => {
    const data = JSON.stringify({ src: e.src, ev: e.ev, ...e.fields })
    res.write(`event: ${e.ev}\nid: ${e.tsMs}\ndata: ${data}\n\n`)
  }
  const replayRaw = parseInt(url.searchParams.get('replay') ?? '', 10)
  const replay = Number.isFinite(replayRaw) ? Math.max(0, Math.min(MAX_REPLAY, replayRaw)) : 0
  if (replay > 0) for (const e of readRecentEvents(files, replay)) writeEvent(e)
  res.write(`: connected\n\n`)
  const unsubscribe = tailer.subscribe(writeEvent)
  const heartbeat = setInterval(() => {
    try {
      res.write(`: hb\n\n`)
    } catch {
      /* torn connection — close handler cleans up */
    }
  }, SSE_HEARTBEAT_MS)
  heartbeat.unref?.()
  const cleanup = (): void => {
    clearInterval(heartbeat)
    unsubscribe()
  }
  res.on('close', cleanup)
  req.on('close', cleanup)
}
