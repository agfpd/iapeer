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
  out: (s: string) => void = s => process.stdout.write(s),
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
