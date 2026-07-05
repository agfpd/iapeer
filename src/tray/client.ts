// tray/client — the fleet-API HTTP client. Ф1 of iapeer-tray is the FIRST EXTERNAL
// client of the daemon's fleet API, and it is written ONLY against the normative
// contract docs/15-fleet-api.md — NOT against daemon source. This module therefore
// imports NOTHING from src/daemon: it discovers the daemon via router.json, speaks
// plain HTTP+JSON (+SSE) over the two advertised listeners, and models the snapshot
// with its OWN local interfaces (client obligation 2: unknown fields ignored). If the
// doc and the daemon ever diverge, this client feels it — that is the whole point of
// dogfooding the contract through a real second client.
//
// Transport: prefer the 0600 unix socket (same-uid, same trust class as the CLI),
// fall back to the TCP loopback. Bun's fetch carries the `unix` option; the compiled
// `iapeer` binary bundles the Bun runtime, so this works when SwiftBar execs it.

import { readFileSync } from 'fs'
import { join } from 'path'
import { pluginStateDir, type StorageOptions } from '../storage/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Discovery — router.json (docs/15 §Surface and transport)
// ─────────────────────────────────────────────────────────────────────────────

export interface FleetAddress {
  /** Unix-socket path (preferred). */
  sock?: string
  /** TCP origin, e.g. `http://127.0.0.1:8765` (derived from router.json `tcp`). */
  tcp?: string
  /** The daemon's advertised version, when present. */
  version?: string
  /** The fleet capability marker: `1` when the daemon serves /fleet/v1. Absent ⇒
   *  a pre-fleet daemon ⇒ the client must degrade (docs/15 §Discovery). */
  fleet?: number
}

/** Read `~/.iapeer/state/iapeer/router.json`. Absent/unreadable ⇒ empty address
 *  (daemon down) — the caller renders the down state. Never throws. */
export function resolveFleetAddress(opts: StorageOptions = {}): FleetAddress {
  const routerJson = join(pluginStateDir('iapeer', opts), 'router.json')
  try {
    const parsed = JSON.parse(readFileSync(routerJson, 'utf8')) as {
      sock?: unknown
      tcp?: unknown
      version?: unknown
      fleet?: unknown
    }
    const addr: FleetAddress = {}
    if (typeof parsed.sock === 'string' && parsed.sock) addr.sock = parsed.sock
    // router.json advertises the MCP url (…/mcp); the fleet surface lives on the SAME
    // origin under /fleet/v1 — keep only the origin.
    if (typeof parsed.tcp === 'string' && parsed.tcp) {
      try {
        addr.tcp = new URL(parsed.tcp).origin
      } catch {
        /* malformed tcp url → no tcp fallback */
      }
    }
    if (typeof parsed.version === 'string') addr.version = parsed.version
    if (typeof parsed.fleet === 'number') addr.fleet = parsed.fleet
    return addr
  } catch {
    return {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Requests — unix-first, TCP-fallback, optional bearer
// ─────────────────────────────────────────────────────────────────────────────

/** The bearer, when the host configured H8 auth (docs/15 §Auth). Read from the
 *  env the client runs under; open-local hosts have none. */
function bearerHeader(env: NodeJS.ProcessEnv): Record<string, string> {
  const t = env.IAPEER_BEARER_TOKEN?.trim()
  return t ? { authorization: `Bearer ${t}` } : {}
}

export class FleetUnreachableError extends Error {
  constructor(readonly detail: string) {
    super(`fleet daemon unreachable: ${detail}`)
    this.name = 'FleetUnreachableError'
  }
}

interface FetchAttempt {
  url: string
  init: RequestInit & { unix?: string }
}

/** Build the ordered transport attempts for a fleet path: unix socket first, TCP
 *  second. `unix` is Bun's fetch option (routes the HTTP request over the socket). */
function attempts(addr: FleetAddress, path: string, base: RequestInit, env: NodeJS.ProcessEnv): FetchAttempt[] {
  const headers = { ...(base.headers as Record<string, string> | undefined), ...bearerHeader(env) }
  const list: FetchAttempt[] = []
  if (addr.sock) list.push({ url: `http://iapeer${path}`, init: { ...base, headers, unix: addr.sock } })
  if (addr.tcp) list.push({ url: `${addr.tcp}${path}`, init: { ...base, headers } })
  return list
}

async function fetchFleet(
  addr: FleetAddress,
  path: string,
  init: RequestInit,
  env: NodeJS.ProcessEnv,
): Promise<Response> {
  const tries = attempts(addr, path, init, env)
  if (tries.length === 0) throw new FleetUnreachableError('no advertised address (router.json missing sock/tcp)')
  let lastErr = ''
  for (const a of tries) {
    try {
      const res = await fetch(a.url, a.init as RequestInit)
      return res
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      // try the next transport
    }
  }
  throw new FleetUnreachableError(lastErr || 'all transports failed')
}

export async function fleetGetJson<T = unknown>(addr: FleetAddress, path: string, env: NodeJS.ProcessEnv): Promise<T> {
  const res = await fetchFleet(addr, path, { method: 'GET' }, env)
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text) as T
}

export async function fleetPostJson<T = unknown>(
  addr: FleetAddress,
  path: string,
  body: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number; body: T }> {
  const res = await fetchFleet(
    addr,
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  )
  const text = await res.text()
  let parsed: T
  try {
    parsed = JSON.parse(text) as T
  } catch {
    parsed = text as unknown as T
  }
  return { status: res.status, body: parsed }
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE — GET /fleet/v1/events (docs/15 §GET /fleet/v1/events)
// ─────────────────────────────────────────────────────────────────────────────

export interface SseEvent {
  /** The event name (`event:` line) — the `ev` vocabulary. Unknown kinds MUST be
   *  tolerated by the caller (client obligation 1). */
  event: string
  /** Epoch-ms of the event (`id:` line) — for at-least-once dedup. */
  id?: number
  /** The parsed `data:` JSON payload. */
  data: Record<string, unknown>
}

/**
 * Open the SSE stream and invoke `onEvent` per frame until the signal aborts or the
 * connection drops (then this resolves — the caller decides whether to reconnect).
 * Parses the `event:` / `id:` / `data:` triplet; comments (`: connected`, `: hb`) are
 * skipped. Deliberately minimal — no reconnect here (the render loop owns that).
 */
export async function streamFleetEvents(
  addr: FleetAddress,
  onEvent: (e: SseEvent) => void,
  opts: { replay?: number; signal?: AbortSignal; env: NodeJS.ProcessEnv },
): Promise<void> {
  const replay = Math.max(0, Math.min(500, opts.replay ?? 0))
  const res = await fetchFleet(
    addr,
    `/fleet/v1/events?replay=${replay}`,
    { method: 'GET', headers: { accept: 'text/event-stream' }, signal: opts.signal },
    opts.env,
  )
  if (!res.ok || !res.body) throw new Error(`events stream → ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // Frames are separated by a blank line.
      let sep: number
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        const parsed = parseSseFrame(frame)
        if (parsed) onEvent(parsed)
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
}

/** Parse one SSE frame (the text between blank-line separators). Returns null for
 *  comment-only frames (`: connected`, `: hb`) or frames without a data payload. */
export function parseSseFrame(frame: string): SseEvent | null {
  let event = 'message'
  let id: number | undefined
  const dataLines: string[] = []
  for (const raw of frame.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line || line.startsWith(':')) continue // comment or blank
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const val = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = val
    else if (field === 'id') {
      const n = parseInt(val, 10)
      if (Number.isFinite(n)) id = n
    } else if (field === 'data') dataLines.push(val)
  }
  if (dataLines.length === 0) return null
  let data: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(dataLines.join('\n'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
  } catch {
    return null
  }
  return { event, ...(id !== undefined ? { id } : {}), data }
}
