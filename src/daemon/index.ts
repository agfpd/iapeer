// Daemon — the always-on HTTP-MCP router. Serves the single agent-facing tool
// (send_to_peer) host-wide over MCP Streamable HTTP, resolving the caller identity
// PER REQUEST from the X-IAPeer-Identity header. (list_online_peers is deprecated by
// contract — it ate context; liveness is the CLI `list` verb, not an agent tool.)
//
// Transport: the CANONICAL SDK StreamableHTTPServerTransport in stateless mode
// (a fresh Server + transport per request, sessionIdGenerator: undefined). The
// caller header is read from `extra.requestInfo.headers` in the CallTool handler
// — verified end-to-end on @modelcontextprotocol/sdk@1.29.0 (the earlier
// "SDK does not surface per-request headers" was a wrong inference from grepping
// streamableHttp.js; requestInfo is built in the web-standard transport layer
// at webStandardStreamableHttp.js:388 and threaded through protocol.js:351).
// Using the canonical transport guarantees on-wire compatibility with real
// claude/codex http MCP clients, so there is no hand-rolled handshake to defend.
//
// Ф1 scope: route + deliver + liveness. Wake-on-miss / spawn (Ф2) are not wired
// yet — a miss returns an explicit "peer offline". H4 (READ-ONLY for launchd
// peers) concerns reap/respawn (Ф2 supervision); Ф1 routing delivers to any live
// peer. H8: a unix socket is the same-uid base; a TCP loopback listener (which
// real http MCP clients require, since they connect to a URL) is broader than
// same-uid and should add a bearer token before production exposure — OPEN.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { createConnection } from 'net'
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import {
  ALWAYS_LOAD_META,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_LEN,
  MAX_TOPIC_LEN,
  NAME_RE_SOURCE,
  RUNTIME_RE_SOURCE,
} from '../core/constants.ts'
import { parseSessionName } from '../core/socket.ts'
import { IapError } from '../core/errors.ts'
import { pluginStateDir, writeFileAtomic, type StorageOptions } from '../storage/index.ts'
import { readPeersIndex, type PeersIndex } from '../registry/index.ts'
import { resolveCallerIdentity, type CallerIdentity, type ResolvedCaller } from '../identity/index.ts'
import { routeSend, type ComposerQueueRouteDeps, type EphemeralRouteDeps, type SendToPeerInput, type WakeFn } from '../transport/index.ts'
import { appendDeliveryEvent } from './deliverylog.ts'

export const CALLER_HEADER = 'x-iapeer-identity'
const SERVER_INFO = { name: 'iapeer', version: '0.0.0' }

/** Does a LIVE listener answer on this unix socket path? (В28) A successful connect ⇒ a daemon is
 *  running; ECONNREFUSED ⇒ a stale socket file (safe to unlink). Bounded by a short timeout so a wedged
 *  socket never hangs startup. */
function socketIsLive(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let settled = false
    const finish = (live: boolean): void => {
      if (settled) return
      settled = true
      try {
        c.destroy()
      } catch {
        /* */
      }
      resolve(live)
    }
    const c = createConnection(socketPath)
    c.once('connect', () => finish(true))
    c.once('error', () => finish(false))
    const t = setTimeout(() => finish(false), timeoutMs)
    if (typeof t.unref === 'function') t.unref()
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Caller identity from the request header
// ─────────────────────────────────────────────────────────────────────────────

/** Parse an `X-IAPeer-Identity: <runtime>-<personality>` header into a caller. */
export function parseCallerHeader(value: string | undefined): CallerIdentity | null {
  const raw = value?.trim()
  if (!raw) return null
  const parsed = parseSessionName(raw) // splits on the first '-': runtime | personality
  if (!parsed) return null
  return { personality: parsed.personality, runtime: parsed.runtime }
}

export function resolveCallerFromHeader(value: string | undefined, index: PeersIndex): ResolvedCaller {
  const caller = parseCallerHeader(value)
  if (!caller) {
    throw new IapError(
      `missing or malformed ${CALLER_HEADER} header — expected "<runtime>-<personality>"`,
    )
  }
  return resolveCallerIdentity(caller, index)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions (ported verbatim from IAP server.ts)
// ─────────────────────────────────────────────────────────────────────────────

// The roster of known peers is DELIBERATELY NOT in this description. It is rendered
// ONCE, in the peer's system prompt (composeSystemPrompt → Layer 3 "## Known peers").
// Embedding it here ALSO duplicated the full list into every agent's context on every
// turn — confirmed live: an agent saw the identical roster twice. The
// description stays light: purpose + parameter semantics only; the model gets the
// roster from its system prompt. The MCP server-level `instructions` field carries
// EXACTLY ONE cross-cutting behavioral rule (the owner-approved no-empty-acks guide,
// SERVER_INSTRUCTIONS) — it loads ONCE per session at initialize (not per turn), so it
// is cheap; it deliberately does NOT restate the roster/doctrine (that lives in the
// system prompt — duplicating it here is the mistake this note warns of). Static.
export function buildSendDescription(): string {
  return [
    'Send a message to a known iapeer peer through Inter-Agent-Protocol.',
    'Peers can be agents, humans, or services. Runtime is the delivery surface, not the peer type.',
    'Current delivery supports any runtime endpoint that follows the IAP tmux socket convention. Claude/Codex are built-in local runtimes; external runtimes such as telegram can be exposed by runtime-router packages.',
    '',
    "Use `personality`, not a runtime-prefixed identity. Set `runtime` to target a specific declared runtime for this send. If that runtime is warm-asleep, the daemon wakes it and delivers there; use this to intentionally bring up a second session of the same peer in parallel to the default runtime (for example codex alongside claude). Inbound peer messages arrive as <iap from-personality=\"...\" from-runtime=\"...\" from-intelligence=\"...\"> blocks. The topic attribute is optional.",
  ].join('\n')
}

// MCP server-level `instructions` — returned in the initialize result, loaded ONCE
// per session (NOT per turn like the tool description), so it is the cheap home for
// a single cross-cutting behavioral rule. VERBATIM owner-approved (no-empty-acks):
// keep the wording exact; do NOT expand it into doctrine/roster (see the note above).
export const SERVER_INSTRUCTIONS =
  'Reply only when a message needs one — a question, task, request, or awaited result. Skip bare acks/FYIs/thanks; they just loop. Silence is the right reply when nothing is asked.'

// The daemon serves the AGENT exactly ONE MCP tool: send_to_peer. list_online_peers
// is DEPRECATED by contract (docs/Примитивы и CLI: "list_online_peers УПРАЗДНЁН —
// ел контекст; список живых пиров — через CLI verb `list`, не через tool агента").
// Every extra tool occupies the context window of EVERY session, so the agent-facing
// tool-set is kept minimal. The liveness scan itself (transport.listOnlinePeers) stays
// — the future `iapeer list` verb and the multi-runtime delivery resolver use it — it
// is simply no longer exposed to the agent as a tool.
export function listTools(): unknown[] {
  return [
    {
      name: 'send_to_peer',
      description: buildSendDescription(),
      inputSchema: {
        type: 'object',
        properties: {
          personality: { type: 'string', description: 'Known peer personality.', pattern: NAME_RE_SOURCE },
          runtime: {
            type: 'string',
            description:
              'Optional target runtime for this send. If the specified runtime is declared and wakeable but asleep, the daemon wakes it warm-on-demand and delivers there; choosing a non-default runtime can intentionally start that peer\'s parallel session. Runtime ids are short channel names such as claude, codex, telegram.',
            pattern: RUNTIME_RE_SOURCE,
          },
          message: {
            type: 'string',
            description: 'Plain-text message body. Keep concise; long messages enter the recipient context.',
            minLength: 1,
            maxLength: MAX_MESSAGE_LEN,
          },
          topic: { type: 'string', description: 'Optional short topic for threading related peer messages.', maxLength: MAX_TOPIC_LEN },
          attachments: {
            type: 'array',
            description: 'Optional absolute local file paths. IAP delivers them as a separate <attachments> field, not as part of message text.',
            maxItems: MAX_ATTACHMENTS,
            items: { type: 'string' },
          },
        },
        required: ['personality', 'message'],
        additionalProperties: false,
      },
      _meta: ALWAYS_LOAD_META,
      annotations: { title: 'Send to IAP peer', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool dispatch
// ─────────────────────────────────────────────────────────────────────────────

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
  structuredContent?: unknown
}

function jsonResult(value: unknown): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
  // MCP structuredContent must be a record (object), not an array. send_to_peer
  // returns an object, so it travels in structuredContent; the guard stays as a
  // belt-and-suspenders against a future array-returning result.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    result.structuredContent = value
  }
  return result
}
function errResult(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

/** Injected seams for callTool — all OPTIONAL, all wired by the composition point
 *  (daemon/main.ts); library/test callers omit them and stay hermetic. */
export interface CallToolDeps {
  /** Wake-on-miss primitive (Ф2) — see StartDaemonOptions.wake. */
  wake?: WakeFn
  /** Per-delivery outcome log dir (Ф-#8a) — see StartDaemonOptions.deliveryLogDir. */
  deliveryLogDir?: string
  /** Fired AFTER a delivery resolved ok, with the request-resolved CALLER (the
   *  sender). The wake_policy:ephemeral M2 arm-on-outbound seam: the composition
   *  point marks an ephemeral caller as armed (its single reply is out → quiet-reap
   *  eligible). Kept as an injected hook so the daemon never imports lifecycle
   *  (layering: main.ts is the only place transport meets lifecycle). Failures are
   *  swallowed — a hook must never fail a delivery that already succeeded. */
  onDelivered?: (caller: ResolvedCaller) => void
  /** Ephemeral-target serial-queue delivery (M3) — see transport.EphemeralRouteDeps. */
  ephemeral?: EphemeralRouteDeps
  /** LIVE-delivered topic → the target's `.topic` marker (fresh-vs-resume seam) —
   *  see transport.RouteDeps.noteLiveTopic. Injected so the daemon never imports
   *  lifecycle; the production main wires makeNoteLiveTopic. */
  noteLiveTopic?: (identity: string, topic: string) => void
  /** В7 — confirmed-delivery stamp → the target's idle-proxy floor (see transport.RouteDeps.noteDelivered). */
  noteDelivered?: (identity: string) => void
  /** Busy-human-composer queue — see transport.createComposerDeliveryQueue. */
  composerQueue?: ComposerQueueRouteDeps
  /** H4 launchd-managed detector — see transport.RouteDeps.isLaunchdManaged (the
   *  launchd-revive delivery retry). Injected so the daemon never imports lifecycle;
   *  the production main wires the real isLaunchdManaged. */
  isLaunchdManaged?: (personality: string) => boolean
}

export async function callTool(
  caller: ResolvedCaller,
  name: string,
  args: Record<string, unknown>,
  deps: CallToolDeps = {},
): Promise<ToolResult> {
  if (name === 'send_to_peer') {
    const input: SendToPeerInput = {
      personality: typeof args.personality === 'string' ? args.personality : '',
      runtime: typeof args.runtime === 'string' ? args.runtime : undefined,
      message: typeof args.message === 'string' ? args.message : '',
      topic: typeof args.topic === 'string' ? args.topic : undefined,
      attachments: Array.isArray(args.attachments) ? (args.attachments as string[]) : undefined,
    }
    const t0 = Date.now()
    const sent = await routeSend(caller, input, {
      wake: deps.wake,
      ephemeral: deps.ephemeral,
      noteLiveTopic: deps.noteLiveTopic,
      noteDelivered: deps.noteDelivered,
      composerQueue: deps.composerQueue,
      isLaunchdManaged: deps.isLaunchdManaged,
    })
    // Ф-#8a: ONE durable outcome line per delivery attempt (delivery.log, sibling
    // to lifecycle.log) — metadata only, never the body. Both branches of the
    // routeSend result are recorded, so a suspected loss is reconstructable from
    // disk (the gap a delivery-loss investigation hit). No-op when no dir is wired
    // (library/test daemons); appendDeliveryEvent itself never throws.
    appendDeliveryEvent(deps.deliveryLogDir, {
      ev: 'delivery',
      caller: caller.address,
      to: input.personality,
      rt: input.runtime, // requested runtime override (skipped when absent)
      ok: String(sent.ok),
      via: sent.ok ? `${sent.value.delivered_to.runtime}-${sent.value.delivered_to.personality}` : undefined,
      woke: sent.ok ? String(sent.value.woke) : undefined,
      // M3 queue observability: a queued accept is marked and carries the queue
      // depth at accept time — a stuck queue is visible.
      queued: sent.ok && sent.value.queued ? 'true' : undefined,
      qkind: sent.ok ? sent.value.queuedBy : undefined,
      qd: sent.ok ? sent.value.queueDepth : undefined,
      ms: Date.now() - t0,
      len: input.message.length,
      att: input.attachments?.length || undefined,
      topic: input.topic,
      err: sent.ok ? undefined : sent.error.message,
    })
    // M2 arm-on-outbound: ONLY on an ok outcome — a failed send means the caller's
    // reply is NOT out, and arming then could quiet-reap a worker mid-retry (the
    // ordinary idle bound covers that case instead). Fail-safe: hook errors are
    // swallowed, the delivery result stands.
    if (sent.ok && sent.value.queuedBy !== 'composer') {
      try {
        deps.onDelivered?.(caller)
      } catch {
        /* a post-delivery hook must never fail the delivery */
      }
    }
    return sent.ok ? jsonResult(sent.value) : errResult(sent.error.message)
  }
  return errResult(`unknown tool: ${name}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP server (canonical SDK) — one fresh instance per request (stateless)
// ─────────────────────────────────────────────────────────────────────────────

function headerFromRequestInfo(extra: { requestInfo?: { headers?: Record<string, unknown> } }): string | undefined {
  const headers = extra.requestInfo?.headers
  const value = headers?.[CALLER_HEADER]
  return Array.isArray(value) ? (value[0] as string) : (value as string | undefined)
}

export function createMcpServer(deps: CallToolDeps = {}): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }))

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    // Per-request identity: read the caller from THIS request's HTTP header,
    // surfaced by the SDK transport as extra.requestInfo.headers.
    const headerIdentity = headerFromRequestInfo(extra as never)
    let caller: ResolvedCaller
    try {
      caller = resolveCallerFromHeader(headerIdentity, readPeersIndex())
    } catch (e) {
      // No silent default — reject the CallTool when identity is missing/invalid.
      if (process.env.IAPEER_DAEMON_LOG) {
        process.stderr.write(`[iapeer-daemon] tools/call REJECTED tool=${req.params.name} caller=${headerIdentity ?? '-'}\n`)
      }
      return errResult(e instanceof Error ? e.message : String(e)) as CallToolResult
    }
    if (process.env.IAPEER_DAEMON_LOG) {
      process.stderr.write(`[iapeer-daemon] tools/call tool=${req.params.name} caller=${caller.address}\n`)
    }
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    return (await callTool(caller, req.params.name, args, deps)) as CallToolResult
  })

  return server
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server (unix socket base, or TCP loopback for real http MCP clients)
// ─────────────────────────────────────────────────────────────────────────────

export function defaultDaemonSocketPath(options: StorageOptions = {}): string {
  return join(pluginStateDir('iapeer', options), 'router.sock')
}

/** The discovery file `<root>/state/iapeer/router.json` — a daemon-aware `iap send`
 *  reads it to route through the daemon. Sits next to router.sock. */
export function daemonDiscoveryPath(options: StorageOptions = {}): string {
  return join(pluginStateDir('iapeer', options), 'router.json')
}

export interface DaemonHandle {
  socketPath?: string
  host?: string
  port?: number
  url?: string
  close: () => Promise<void>
}

export interface StartDaemonOptions extends StorageOptions {
  /**
   * Unix-socket path (H8 base: 0600, same-uid local callers — CLI / pane /
   * notifier / telegram). Bound when given; when NEITHER socketPath NOR port is
   * given, a bare startDaemon() defaults to the same-uid router.sock.
   */
  socketPath?: string
  /**
   * TCP loopback port (0 = ephemeral). REQUIRED for real http MCP clients
   * (claude/codex `--transport http <url>`), which connect to a URL, not a unix
   * socket. NOT mutually exclusive with socketPath — give BOTH for dual-listen
   * (local callers via the 0600 socket, agents via TCP). H8 on the TCP surface is
   * gated by the optional bearer seam (off by default).
   */
  port?: number
  /** TCP bind host, default 127.0.0.1 (loopback). */
  host?: string
  /**
   * Wake-on-miss primitive (Ф2). When provided, a send to a DEAD peer wakes it
   * (spawns the session, delivers the message as its boot first-message) instead
   * of returning offline. Opt-in: omit it (Ф1) and a miss returns an explicit
   * "offline" — so tests never spawn a real session by accident. The daemon is
   * the composition point: it wires lifecycle.wakeOrSpawn here (§2).
   */
  wake?: WakeFn
  /**
   * Optional supervision timer (Ф2): `tick` runs every `intervalMs` — the daemon
   * owns fleet supervision (idle-reap / zombie-sweep) instead of launchd. The
   * caller wires `tick: () => superviseTick(cfg)` (H4-guarded inside).
   */
  supervise?: { intervalMs: number; tick: () => void | Promise<void>; onError?: (err: unknown) => void }
  /**
   * Optional bearer token (H8). When set, EVERY request must carry
   * `Authorization: Bearer <token>` or it is rejected 401 BEFORE any MCP dispatch.
   * Unset → no auth (the same-uid unix-socket base / loopback default). This is the
   * structural layer for closing H8 on the TCP loopback listener — kept OFF until
   * explicitly enabled (the production main reads IAPEER_BEARER_TOKEN). Loopback is
   * broader than same-uid, so a token gates it without changing the on-wire MCP.
   */
  bearerToken?: string
  /**
   * Per-delivery outcome log dir (Ф-#8a) — when set, EVERY send_to_peer the daemon
   * routes appends one logfmt outcome line to `<dir>/delivery.log` (rotated,
   * metadata-only — see daemon/deliverylog.ts). OFF by default (library/test
   * callers stay hermetic); the production main wires cfg.eventLogDir here, so
   * delivery.log sits next to lifecycle.log under the SAME cfg-resolved root.
   */
  deliveryLogDir?: string
  /**
   * Post-delivery hook (wake_policy:ephemeral M2 arm-on-outbound seam) — fired with
   * the request-resolved CALLER after each delivery that resolved ok. See
   * CallToolDeps.onDelivered. OFF by default; the production main wires the
   * lifecycle arm (an ephemeral caller's ok outbound ⇒ armed for quiet-reap).
   */
  onDelivered?: (caller: ResolvedCaller) => void
  /**
   * Ephemeral-target serial-queue delivery (wake_policy:"ephemeral" M3) — see
   * transport.EphemeralRouteDeps. OFF by default; the production main wires the
   * lifecycle queue + drain (makeEphemeralRouteDeps).
   */
  ephemeral?: EphemeralRouteDeps
  /**
   * LIVE-delivered topic → the target identity's `.topic` marker (fresh-vs-resume
   * seam) — see transport.RouteDeps.noteLiveTopic. OFF by default; the production
   * main wires the lifecycle marker write (makeNoteLiveTopic).
   */
  noteLiveTopic?: (identity: string, topic: string) => void
  /** В7 — confirmed-delivery stamp → the target's idle-proxy floor (setLastDelivered). OFF by default;
   *  the production main wires it. */
  noteDelivered?: (identity: string) => void
  /**
   * Busy-human-composer queue — async acceptance for live local TUI delivery when
   * an attached operator has non-dim text in the target composer. OFF by default
   * for library/tests; production main wires an in-memory queue that fail-notifies
   * senders on shutdown/restart.
   */
  composerQueue?: ComposerQueueRouteDeps
  /** H4 launchd-managed detector — see CallToolDeps.isLaunchdManaged / the launchd-revive
   *  delivery retry. OFF by default (library/tests); production main wires the real one. */
  isLaunchdManaged?: (personality: string) => boolean
  /**
   * Write the discovery file (router.json) at <root>/state/iapeer/router.json with
   * the active addresses `{sock, tcp}` — atomically on listen, removed on close.
   * This is the contract a daemon-aware `iap send` reads to route through the
   * daemon. OFF by default (library/test callers); the production main enables it.
   */
  discovery?: boolean
}

export async function startDaemon(opts: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const tcpEnabled = opts.port !== undefined
  // Bind a unix socket when one is given, OR when no TCP is requested at all
  // (legacy default: a bare startDaemon() serves the same-uid router.sock).
  const socketPath = opts.socketPath ?? (tcpEnabled ? undefined : defaultDaemonSocketPath(opts))
  const host = opts.host ?? '127.0.0.1'
  const bearer = opts.bearerToken?.trim() || undefined

  // ONE MCP request handler, shared by EVERY listener (socket + TCP). Stateless:
  // a fresh Server + transport per request, fully isolated.
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    // H8 bearer layer (FIRST, before any MCP work): when a token is configured,
    // reject anything not carrying `Authorization: Bearer <token>`. Off when unset.
    if (bearer && req.headers.authorization !== `Bearer ${bearer}`) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }))
      return
    }
    const server = createMcpServer({
      wake: opts.wake,
      deliveryLogDir: opts.deliveryLogDir,
      onDelivered: opts.onDelivered,
      ephemeral: opts.ephemeral,
      noteLiveTopic: opts.noteLiveTopic,
      noteDelivered: opts.noteDelivered,
      composerQueue: opts.composerQueue,
      isLaunchdManaged: opts.isLaunchdManaged,
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } }))
        }
      })
  }

  // Supervision timer (Ф2): the daemon drives idle-reap / zombie-sweep (one shared
  // timer regardless of how many listeners are bound).
  let supervisor: ReturnType<typeof setInterval> | undefined
  if (opts.supervise) {
    const { intervalMs, tick, onError } = opts.supervise
    // A supervise tick must NEVER crash the daemon — but its error must NOT be SWALLOWED either: a
    // silently-swallowed throw is a sweep that stops reaping INVISIBLY (no log, no stderr — the class
    // that made a stuck reaper undiagnosable for hours). Route BOTH an async rejection and a sync throw
    // to onError (the production main records ev=supervise-error in lifecycle.log); reporting itself
    // never throws.
    const report = (err: unknown): void => {
      try { onError?.(err) } catch { /* a reporter must never crash the daemon */ }
    }
    supervisor = setInterval(() => {
      try {
        void Promise.resolve(tick()).catch(report)
      } catch (err) {
        report(err)
      }
    }, intervalMs)
    supervisor.unref?.()
  }

  const servers: ReturnType<typeof createHttpServer>[] = []

  // Unix-socket listener (H8 same-uid base, 0600).
  if (socketPath) {
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
    if (existsSync(socketPath)) {
      // В28 — a LIVE daemon may already own this socket. Unlinking it out from under a live listener
      // silently breaks every unix-socket caller (CLI/notifier/telegram) until a restart. Probe first:
      // if a daemon answers, REFUSE to start (touch nothing). Only a STALE socket file (no listener,
      // ECONNREFUSED) is removed. Guards the documented `iapeer daemon` foreground acceptance mode.
      if (await socketIsLive(socketPath)) {
        throw new Error(`a daemon is already listening on ${socketPath} — refusing to start a second instance`)
      }
      unlinkSync(socketPath)
    }
    const s = createHttpServer(handle)
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject)
      s.listen(socketPath, () => {
        s.removeListener('error', reject)
        resolve()
      })
    })
    chmodSync(socketPath, 0o600)
    servers.push(s)
  }

  // TCP loopback listener (real http MCP clients connect to a URL).
  let port: number | undefined
  let url: string | undefined
  if (tcpEnabled) {
    const s = createHttpServer(handle)
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject)
      s.listen(opts.port, host, () => {
        s.removeListener('error', reject)
        resolve()
      })
    })
    const addr = s.address()
    port = addr && typeof addr === 'object' ? addr.port : (opts.port as number)
    url = `http://${host}:${port}/mcp`
    servers.push(s)
  }

  // Discovery file (atomic temp+rename) — both active addresses for `iap send`.
  let discoveryPath: string | undefined
  if (opts.discovery) {
    discoveryPath = daemonDiscoveryPath(opts)
    writeFileAtomic(discoveryPath, `${JSON.stringify({ sock: socketPath ?? null, tcp: url ?? null })}\n`)
  }

  const removeArtifacts = (): void => {
    if (socketPath && existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
        /* already gone */
      }
    }
    if (discoveryPath && existsSync(discoveryPath)) {
      try {
        unlinkSync(discoveryPath)
      } catch {
        /* already gone */
      }
    }
  }

  return {
    socketPath,
    host: tcpEnabled ? host : undefined,
    port,
    url,
    close: async () => {
      await opts.composerQueue?.failAll?.('daemon shutting down/restarting before queued delivery completed')
      await new Promise<void>(resolve => {
        if (supervisor) clearInterval(supervisor)
        for (const s of servers) s.closeAllConnections?.() // drop lingering keep-alive/SSE conns
        let pending = servers.length
        if (pending === 0) {
          removeArtifacts()
          resolve()
          return
        }
        for (const s of servers) {
          s.close(() => {
            if (--pending === 0) {
              removeArtifacts()
              resolve()
            }
          })
        }
      })
    },
  }
}
