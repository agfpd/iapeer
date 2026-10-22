// Boot-modal alert outlet. A bring-up that hit an UNRECOGNIZED boot modal fails fast (launch
// waitHostReady → lifecycle ev=boot-modal → WakeDeps.onBootModal). The waking sender already hears the
// FAILED reason; this outlet tells the people who can FIX it: a notice on the owner board (tray / web /
// fleet SSE) and, when the host configures one, an IAP alert to an operator peer.
//
// The operator peer is HOST configuration, never a baked name (the package ships to foreign installs):
// `<IAPEER_ROOT>/alerts.json` → {"peer": "<personality>", "runtime"?: "<rt>"}. Absent/invalid → board +
// lifecycle.log only.
//
// Dedup: one alert per (identity, modal title) per DEDUP window — a peer whose every wake hits the same
// modal must not bury the operator. The board's own dedupKey folds repeats the same way.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveGlobalRoot } from '../storage/index.ts'
import { systemCaller } from '../identity/index.ts'
import { routeSend, type RouteDeps } from '../transport/index.ts'
import { appendDeliveryEvent } from './deliverylog.ts'
import type { NoticeBoard } from './notices.ts'
import { FleetEventTailer, type FleetEvent } from './fleet.ts'
import { lifecycleLogPath } from '../lifecycle/eventlog.ts'

export const BOOT_MODAL_ALERT_DEDUP_MS = 30 * 60_000

export interface AlertTarget {
  peer: string
  runtime?: string
}

/** Read the host's operator-alert target, or null when none is configured / the file is malformed. */
export function readAlertTarget(env: NodeJS.ProcessEnv = process.env): AlertTarget | null {
  const path = join(resolveGlobalRoot(env), 'alerts.json')
  if (!existsSync(path)) return null
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as { peer?: unknown; runtime?: unknown }
    if (typeof j.peer !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(j.peer)) return null
    return { peer: j.peer, ...(typeof j.runtime === 'string' && j.runtime ? { runtime: j.runtime } : {}) }
  } catch {
    return null
  }
}

export interface BootModalInfo {
  personality: string
  runtime: string
  identity: string
  content: string
  option1: string
  title: string
}

export function bootModalAlertText(i: BootModalInfo): string {
  return [
    `iapeer: ${i.personality} (${i.runtime}) did not come up — an unrecognized dialog blocks its boot, and no adapter knows how to answer it.`,
    `The wake failed fast and the session was torn down; the next message will hit the same dialog until an adapter recognizes it.`,
    `Option 1 on screen: "${i.option1}"`,
    `Screen:`,
    i.content,
  ].join('\n')
}

export function makeBootModalAlert(
  opts: { eventLogDir: string; env: NodeJS.ProcessEnv; board?: NoticeBoard; routeDeps?: RouteDeps },
  seam: { send?: typeof routeSend; now?: () => number; target?: () => AlertTarget | null } = {},
): (info: BootModalInfo) => void {
  const sent = new Map<string, number>()
  const now = seam.now ?? Date.now
  const send = seam.send ?? routeSend
  return info => {
    const title = info.title
    try {
      opts.board?.raise({
        personality: info.personality,
        runtime: info.runtime,
        kind: 'boot-modal',
        errorType: 'unknown-boot-modal',
        summary: `${info.personality} (${info.runtime}): unrecognized boot dialog — ${title}`.slice(0, 240),
        content: info.content,
      })
    } catch { /* best-effort */ }
    const key = `${info.identity}\u0000${title}`
    const last = sent.get(key)
    if (last !== undefined && now() - last < BOOT_MODAL_ALERT_DEDUP_MS) return
    const target = (seam.target ?? (() => readAlertTarget(opts.env)))()
    if (!target) return
    sent.set(key, now())
    void (async () => {
      let ok = 'false'
      let err: string | undefined
      try {
        const r = await send(
          systemCaller(),
          { personality: target.peer, ...(target.runtime ? { runtime: target.runtime } : {}), message: bootModalAlertText(info), topic: 'boot-modal' },
          opts.routeDeps ?? { env: opts.env },
        )
        ok = String(r.ok)
        if (!r.ok) err = r.error.message
      } catch (e) {
        err = e instanceof Error ? e.message : String(e)
      }
      try {
        appendDeliveryEvent(opts.eventLogDir, { ev: 'boot-modal-alert', caller: systemCaller().address, to: target.peer, about: info.identity, ok, err: err?.slice(0, 300) })
      } catch { /* best-effort */ }
    })()
  }
}

/** ev=boot-modal lifecycle line → the alert payload (null for any other / malformed line). */
export function bootModalFromEvent(e: Pick<FleetEvent, 'ev' | 'fields'>): BootModalInfo | null {
  if (e.ev !== 'boot-modal') return null
  const f = e.fields
  if (!f.identity || !f.personality || !f.runtime) return null
  return { identity: f.identity, personality: f.personality, runtime: f.runtime, content: f.content ?? '', option1: f.option1 ?? '', title: f.title ?? '' }
}

/** Tail lifecycle.log from its CURRENT end and alert on every new ev=boot-modal line. Returns stop. */
export function startBootModalWatch(
  opts: { eventLogDir: string; env: NodeJS.ProcessEnv; board?: NoticeBoard; routeDeps?: RouteDeps; pollMs?: number },
): () => void {
  const alert = makeBootModalAlert(opts)
  const tailer = new FleetEventTailer([{ path: lifecycleLogPath(opts.eventLogDir), src: 'lifecycle' }], opts.pollMs ?? 1000)
  return tailer.subscribe(e => {
    const info = bootModalFromEvent(e)
    if (info) alert(info)
  })
}
