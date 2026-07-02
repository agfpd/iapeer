// Dashboard DATA — the in-process state feed (решение B1: фундамент-примитивы, не
// RPC): peer rows via listPeers (registry + per-runtime liveness + last-active), the
// host header via hostStatus (daemon health probe + memory/voice slots), and the
// per-peer event-log tails (delivery.log + lifecycle.log under cfg.eventLogDir).
//
// All paths resolve through the injected env → the same IAPEER_ROOT isolation as
// every other side-effect (sandbox rule). Reads only — the dashboard mutates nothing.

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { listPeers, type PeerListing } from '../../cli/index.ts'
import { loadLifecycleConfig } from '../../lifecycle/index.ts'
import { deliveryLogPath } from '../../daemon/deliverylog.ts'
import { lifecycleLogPath } from '../../lifecycle/eventlog.ts'
import { assemblePeerLog } from './model.ts'

/** One peers snapshot (the poll unit). listPeers is synchronous and cheap: registry
 *  read + pidfile kill-0 liveness + transcript/pane-log statSync per peer. */
export function takePeersSnapshot(env: NodeJS.ProcessEnv): PeerListing[] {
  return listPeers({ env })
}

export interface HostHeader {
  version: string
  daemonHealthy: boolean
  memory: { present: boolean; label: string }
  voice: { present: boolean; label: string }
}

/** The host header line (slow poll — the daemon probe has its own short timeout).
 *  Dynamic import keeps the update/status modules out of the fast peers-poll path. */
export async function takeHostHeader(env: NodeJS.ProcessEnv): Promise<HostHeader> {
  const { hostStatus } = await import('../../status/index.ts')
  const s = await hostStatus({ env })
  const slot = (p: { provider: string; version: string } | null, hbAge: number | null): { present: boolean; label: string } =>
    p ? { present: true, label: `${p.version}${hbAge !== null ? ` · hb ${hbAge}s` : ''}` } : { present: false, label: 'none' }
  return {
    version: s.version,
    daemonHealthy: s.daemon.healthy,
    memory: slot(s.memory.provider, s.memory.heartbeatAgeSecs),
    voice: slot(s.voice.provider, s.voice.heartbeatAgeSecs),
  }
}

/** Read the last `bytes` of a file without loading the whole log (delivery.log can
 *  be MBs before rotation). Missing/unreadable file → ''. */
export function readTail(path: string, bytes = 64 * 1024): string {
  try {
    const size = statSync(path).size
    const fd = openSync(path, 'r')
    try {
      const start = Math.max(0, size - bytes)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      // drop the leading partial line when we started mid-file
      const s = buf.toString('utf8')
      return start > 0 ? s.slice(s.indexOf('\n') + 1) : s
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/** The per-peer log panel content: newest `limit` events concerning the peer from
 *  delivery.log + lifecycle.log (merged by timestamp). */
export function takePeerLog(env: NodeJS.ProcessEnv, personality: string, limit: number): Array<{ text: string; tone: 'ok' | 'fail' | 'info' }> {
  const cfg = loadLifecycleConfig(env)
  const tails = [readTail(deliveryLogPath(cfg.eventLogDir)), readTail(lifecycleLogPath(cfg.eventLogDir))]
  return assemblePeerLog(tails, personality, limit)
}

/** The pane-log path of a peer address — reserved for a future raw-view; unused by
 *  the prototype (raw pty bytes are an attach concern, not a log panel one). */
export function paneLogPath(env: NodeJS.ProcessEnv, address: string): string {
  const cfg = loadLifecycleConfig(env)
  return join(cfg.logDir, `${address}.log`)
}
