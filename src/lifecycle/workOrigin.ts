// A durable delivery receipt, not a permanent exemption for an endpoint. Only explicit runtime
// addressing by a non-core caller can authorize continuing unfinished non-default work.
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../storage/index.ts'
import { deliveryCompleted, deliveryLanded, type InflightNote } from '../transport/index.ts'
import { hostSessionToken } from '../launch/ptyHost.ts'
import type { LifecycleConfig } from './index.ts'

export interface WorkOrigin {
  sessionToken: string
  deliveredAtMs: number
  caller: { personality: string; runtime: string }
}
type Receipt = InflightNote & { ts: number }
const path = (cfg: LifecycleConfig, identity: string) => join(cfg.stateDir, `${identity}.work-origin.json`)
const hostingPath = (cfg: LifecycleConfig, identity: string) => join(cfg.stateDir, `${identity}.last-hosting`)
function lastHosting(cfg: LifecycleConfig, identity: string): string | undefined {
  try { return readFileSync(hostingPath(cfg, identity), 'utf8').trim() } catch { return }
}
export function noteHostingGeneration(cfg: LifecycleConfig, identity: string, token: string | null): void {
  if (!token || lastHosting(cfg, identity) === token) return
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  writeFileAtomic(hostingPath(cfg, identity), token + '\n')
}

export function noteWorkOrigin(cfg: LifecycleConfig, note: Receipt): void {
  noteHostingGeneration(cfg, note.identity, note.sessionToken)
  if (note.caller.runtime === 'core') return // a system notification cannot grant or erase explicit work
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  writeFileAtomic(path(cfg, note.identity), JSON.stringify({ ...note, ts: note.acceptedAtMs ?? note.ts }) + '\n')
}

/** Called when the limit is detected, BEFORE a later ledger sweep can discard its refusal turn. */
export function workOriginAtLimit(cfg: LifecycleConfig, identity: string, eventAtMs: number, env: NodeJS.ProcessEnv, file?: string): WorkOrigin | undefined {
  let r: Receipt
  try { r = JSON.parse(readFileSync(path(cfg, identity), 'utf8')) } catch { return }
  if (!r.explicitRuntime || !r.sessionToken || !Number.isFinite(r.ts) || r.ts > eventAtMs || !r.caller || r.caller.runtime === 'core') return
  if (lastHosting(cfg, identity) !== r.sessionToken) return
  // Another hosting's delivery must not authorize the current session. If the old hosting has
  // already reaped, the receipt's rendered message + completion cutoff still ties it to its work.
  const current = hostSessionToken(identity, env)
  if (current && current !== r.sessionToken) return
  const probe = { ...r, file }
  if (!deliveryLanded(probe, env) || deliveryCompleted(probe, env, eventAtMs)) return
  return { sessionToken: r.sessionToken, deliveredAtMs: r.ts, caller: r.caller }
}

export function workOriginStillValid(cfg: LifecycleConfig, origin: WorkOrigin | undefined, identity: string, eventAtMs: number, env: NodeJS.ProcessEnv): boolean {
  if (!origin?.sessionToken || !Number.isFinite(origin.deliveredAtMs) || origin.deliveredAtMs > eventAtMs || !origin.caller || origin.caller.runtime === 'core') return false
  if (lastHosting(cfg, identity) !== origin.sessionToken) return false
  const current = hostSessionToken(identity, env)
  return !current || current === origin.sessionToken
}
