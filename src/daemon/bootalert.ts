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
import type { WakeDeps } from '../lifecycle/index.ts'

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

type BootModalInfo = Parameters<NonNullable<WakeDeps['onBootModal']>>[0]

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
    const title = info.content.split('\n').map(l => l.trim()).find(Boolean) ?? ''
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
