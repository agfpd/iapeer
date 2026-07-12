// tray/index — the fleet dashboard's runtime entry points, called by the `tray` CLI
// verb. Ф1 of iapeer-tray: the FIRST external client of the daemon fleet API, written
// strictly against docs/15-fleet-api.md.
//
//   • render (one-shot) — fetch /snapshot once, print one SwiftBar block. Used by the
//     poll-fallback plugin and by tests.
//   • render --stream — the SwiftBar streamable loop: print a block, subscribe to
//     /events, and re-fetch the snapshot on each change (the canonical docs/15 loop
//     "snapshot is state, events are hints"). Coalesces event bursts, heartbeats a
//     refresh every 15 s (ages stay fresh + a missed event self-heals), and reconnects
//     across daemon restarts / down windows. Degrades to the daemon-down block.
//   • cmd — POST a fleet command (wake/stop/…): dogfoods the command endpoints.

import { writeSync } from 'fs'
import { resolveFleetAddress, fleetGetJson, fleetPostJson, streamFleetEvents } from './client.ts'
import { renderSwiftBar, renderDaemonDown, type TraySnapshot } from './render.ts'
import { iapeerBinPath } from '../install/index.ts'

export * from './install.ts'
export { resolveFleetAddress } from './client.ts'

const SNAPSHOT_PATH = '/fleet/v1/snapshot'
const DEFAULT_HEARTBEAT_MS = 15_000
const COALESCE_MS = 200
const RECONNECT_BACKOFF_MS = 1_000
const DOWN_RETRY_MS = 3_000

/** Heartbeat cadence: re-render even without an event so ages stay fresh and a missed
 *  event self-heals. Tunable via IAPEER_TRAY_HEARTBEAT_MS (clamped 1s…10m). */
function heartbeatMs(env: NodeJS.ProcessEnv): number {
  const raw = parseInt(env.IAPEER_TRAY_HEARTBEAT_MS ?? '', 10)
  if (!Number.isFinite(raw)) return DEFAULT_HEARTBEAT_MS
  return Math.max(1_000, Math.min(600_000, raw))
}

export const TRAY_COMMANDS = ['wake', 'stop', 'start', 'new', 'refresh', 'interrupt', 'compact'] as const
export type TrayCommand = (typeof TRAY_COMMANDS)[number]

/** Fetch the snapshot and render one SwiftBar block, or the degraded down-block when
 *  no advertised address answers / the daemon predates the fleet API. Never throws. */
export async function renderTrayOnce(env: NodeJS.ProcessEnv): Promise<string> {
  const binPath = iapeerBinPath(env)
  const addr = resolveFleetAddress({ env })
  if (addr.fleet !== 1 || (!addr.sock && !addr.tcp)) {
    const reason = addr.sock || addr.tcp ? 'daemon predates the fleet API (no fleet:1 in router.json)' : 'no daemon address (router.json missing)'
    return renderDaemonDown(reason, { binPath })
  }
  try {
    const snap = await fleetGetJson<TraySnapshot>(addr, SNAPSHOT_PATH, env)
    return renderSwiftBar(snap, { binPath })
  } catch (e) {
    return renderDaemonDown(e instanceof Error ? e.message : String(e), { binPath })
  }
}

// ── UTF-8-atomic stdout sink ─────────────────────────────────────────────────────
// WHY (root cause of the vanishing menu-bar icon, 13.07.2026): SwiftBar v2.0.1 decodes
// EVERY pipe chunk independently — RunScript.swift: `String(data: availableData, .utf8)`
// per readabilityHandler fire. A chunk boundary that lands INSIDE a multi-byte UTF-8
// character makes that decode nil; StreamablePlugin treats nil as "clear content" and
// MenuBarItem._updateMenu answers empty content with hide() → the NSStatusItem vanishes
// (and AppKit PERSISTS the hidden state as `NSStatusItem VisibleCC <plugin>` = 0 via the
// item's autosaveName, so it survives SwiftBar restarts). Our menu block is ~35 KB of
// emoji/box-glyph-rich text written in ONE write(2): the kernel delivers it to the reader
// in pipe-buffer-fill chunks (measured live: 16384+16384+2400 — byte-arbitrary
// boundaries), so a mid-character split — and a hidden icon — was a stochastic certainty.
//
// FIX (kills the class by construction): emit in quanta of ≤512 bytes (PIPE_BUF on
// macOS — writes ≤PIPE_BUF into a pipe are ATOMIC, all-or-nothing) with every quantum
// ending on a UTF-8 character boundary. The pipe buffer then only ever contains whole
// quanta, and a full-drain read (what FileHandle.availableData does — verified with a
// live harness) always returns a concatenation of whole quanta ⇒ every chunk SwiftBar
// can ever see is valid UTF-8. See docs/16-tray.md §icon-visibility.

const PIPE_ATOMIC_MAX = 512

/** Split `s` into Buffers of ≤`max` bytes, each ending on a UTF-8 character boundary.
 *  Exported for tests. */
export function utf8AtomicQuanta(s: string, max = PIPE_ATOMIC_MAX): Buffer[] {
  const buf = Buffer.from(s, 'utf8')
  const quanta: Buffer[] = []
  let i = 0
  while (i < buf.length) {
    let end = Math.min(i + max, buf.length)
    if (end < buf.length) {
      // buf[end] is the first byte of the NEXT quantum — it must start a character.
      // 0b10xxxxxx = UTF-8 continuation byte ⇒ step back to the character's first byte.
      while (end > i && (buf[end]! & 0xc0) === 0x80) end--
      // Defensive only (a valid UTF-8 char is ≤4 B < max): never stall on garbage input.
      if (end === i) end = Math.min(i + max, buf.length)
    }
    quanta.push(buf.subarray(i, end))
    i = end
  }
  return quanta
}

function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The default stream sink: synchronous atomic-quantum writes to stdout (fd 1).
 *  EPIPE ⇒ the reader (SwiftBar) is gone — exit cleanly so a dead tray-host never
 *  accumulates orphaned `tray render --stream` processes. */
function writeStdoutAtomic(s: string): void {
  for (const q of utf8AtomicQuanta(s)) {
    let off = 0
    while (off < q.length) {
      try {
        off += writeSync(1, q, off, q.length - off)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EAGAIN') {
          sleepSyncMs(2) // pipe full — the reader is momentarily busy
          continue
        }
        if (code === 'EPIPE') process.exit(0)
        throw e
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    ;(t as { unref?: () => void }).unref?.()
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

/**
 * The SwiftBar streamable loop (docs/16 §streaming). Emits a full menu block, then a
 * `~~~` separator before every subsequent block. Drives updates off the SSE stream
 * with burst-coalescing + a heartbeat; reconnects forever. `out` defaults to stdout;
 * `signal` (tests) stops the loop.
 */
export async function streamTray(
  env: NodeJS.ProcessEnv,
  // Default sink is the UTF-8-atomic quantum writer — NOT a plain stdout.write: a single
  // big write reaches SwiftBar in byte-arbitrary chunks whose per-chunk UTF-8 decode can
  // fail and hide the menu-bar icon (see writeStdoutAtomic above).
  out: (s: string) => void = writeStdoutAtomic,
  signal?: AbortSignal,
): Promise<void> {
  // Serialize all emits through a promise chain so a `~~~`+block is never interleaved.
  let chain: Promise<void> = Promise.resolve()
  const emit = (): Promise<void> => {
    chain = chain.then(async () => {
      const block = await renderTrayOnce(env)
      // EVERY block — including the first — is prefixed with the `~~~` stream separator.
      // SwiftBar's default (leading-separator) handler sets content = <text after the
      // last ~~~>, i.e. REPLACE; a block WITHOUT a leading ~~~ is APPENDED to the
      // current content. On a refresh (SwiftBar terminate()s the process WITHOUT
      // clearing content, then re-invoke()s), the restarted process's first block would
      // otherwise append to the stale pre-refresh menu → the whole dashboard renders
      // twice. Always leading with ~~~ makes every emit a clean replace. (root: SwiftBar
      // v2.0.1 StreamablePlugin.onOutputUpdate.)
      out(`~~~\n${block}`)
    })
    return chain
  }
  // Coalesce event bursts into a single re-render.
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined
  const requestEmit = (): void => {
    if (coalesceTimer) return
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined
      void emit()
    }, COALESCE_MS)
    ;(coalesceTimer as { unref?: () => void }).unref?.()
  }

  await emit() // initial block

  while (!signal?.aborted) {
    const addr = resolveFleetAddress({ env })
    if (addr.fleet !== 1 || (!addr.sock && !addr.tcp)) {
      await sleep(DOWN_RETRY_MS, signal)
      await emit() // keep the down-block current until the daemon returns
      continue
    }
    const heartbeat = setInterval(requestEmit, heartbeatMs(env))
    ;(heartbeat as { unref?: () => void }).unref?.()
    try {
      // Blocks until the stream ends (daemon restart / network drop). Each event just
      // marks the menu dirty — the snapshot re-fetch is the source of truth.
      await streamFleetEvents(addr, () => requestEmit(), { replay: 0, signal, env })
    } catch {
      /* connection failed → fall through to a refresh + backoff + reconnect */
    } finally {
      clearInterval(heartbeat)
    }
    if (signal?.aborted) break
    await emit() // reflect whatever changed across the drop
    await sleep(RECONNECT_BACKOFF_MS, signal)
  }
}

export interface TrayCmdResult {
  ok: boolean
  status: number
  body: unknown
}

/** POST a fleet command for a peer (dogfoods POST /fleet/v1/peers/<peer>/<cmd>). */
export async function trayCmd(
  env: NodeJS.ProcessEnv,
  command: string,
  personality: string,
  runtime?: string,
): Promise<TrayCmdResult> {
  if (!(TRAY_COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`unknown tray command "${command}" — one of: ${TRAY_COMMANDS.join(', ')}`)
  }
  const addr = resolveFleetAddress({ env })
  if (addr.fleet !== 1 || (!addr.sock && !addr.tcp)) {
    return { ok: false, status: 0, body: { error: 'fleet daemon unreachable (no fleet:1 in router.json)' } }
  }
  const path = `/fleet/v1/peers/${encodeURIComponent(personality)}/${command}`
  const { status, body } = await fleetPostJson(addr, path, runtime ? { runtime } : {}, env)
  return { ok: status < 400, status, body }
}

export type ApprovalVerb = 'approve' | 'deny'

/**
 * Resolve a pending human-approval from the tray: POST /fleet/v1/approvals/<id>/(approve|deny) over
 * the SAME unix-first fleet client trayCmd uses — the proxy-safe transport (the absolute-form-misroute
 * grabli: a peer's Happ proxy would otherwise mangle a loopback POST). Tags `via:'tray'` for the audit
 * trail; the single-queue invariant means this resolution is seen by every channel (CLI/telegram). A
 * 404 (already resolved / expired) surfaces as ok=false with the daemon's message — the caller reports
 * it (the request the user saw was answered elsewhere first).
 */
export async function trayResolveApproval(
  env: NodeJS.ProcessEnv,
  decision: ApprovalVerb,
  id: string,
  reason?: string,
): Promise<TrayCmdResult> {
  const addr = resolveFleetAddress({ env })
  if (addr.fleet !== 1 || (!addr.sock && !addr.tcp)) {
    return { ok: false, status: 0, body: { error: 'fleet daemon unreachable (no fleet:1 in router.json)' } }
  }
  const path = `/fleet/v1/approvals/${encodeURIComponent(id)}/${decision}`
  const { status, body } = await fleetPostJson(addr, path, { via: 'tray', ...(reason ? { reason } : {}) }, env)
  return { ok: status < 400, status, body }
}
