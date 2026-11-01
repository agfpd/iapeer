// Reconcile an uncertain native submit. This module never sends input to the original receiver.
import { rmSync } from 'node:fs'
import { listAcceptance, readAcceptance, writeAcceptance, acceptancePath, readResolutionNotice, writeResolutionNotice, type AcceptanceRecord } from '../launch/acceptanceStore.ts'
import { codexReceiptBaseline } from '../launch/codexDelivery.ts'
import { pidStartToken } from '../supervisor/paths.ts'
import { decodeEnvelope } from '../codec/index.ts'
import { systemCaller } from '../identity/index.ts'
import { routeSend, type RouteDeps } from '../transport/index.ts'
import { readAlertTarget } from './bootalert.ts'
import { appendDeliveryEvent } from './deliverylog.ts'
import { deliveryLanded } from '../transport/index.ts'
import type { NoticeBoard } from './notices.ts'

export const ACCEPTANCE_ALERT_AFTER_MS = 120_000
const DEAD_DRAIN_MS = 5000
const FINAL_KEEP_MS = 7 * 24 * 60 * 60_000
function alive(pid: number, token: string | null): boolean {
  try { process.kill(pid, 0) } catch { return false }
  return token === null || (pidStartToken(pid) ?? token) === token
}
export function acceptanceEvent(r: AcceptanceRecord): string {
  return JSON.stringify({ event: 'delivery-acceptance', deliveryId: r.id, outcome: r.status,
    recipient: r.identity, reason: r.resolution?.reason ?? r.reason, originalEnvelope: r.message,
    ...(r.resolution ? { operatorResolved: true, resolution: r.resolution } : {}) })
}
function noticePayload(r: AcceptanceRecord, runDir: string): { message: string; attachments?: string[] } {
  const message = acceptanceEvent(r)
  if (message.length <= 15000) return { message }
  const event = JSON.parse(message)
  delete event.originalEnvelope
  event.originalEnvelopeFile = acceptancePath(runDir, r.id)
  return { message: JSON.stringify(event), attachments: [event.originalEnvelopeFile] }
}
export interface AcceptanceOptions {
  runDir: string
  logDir: string
  env: NodeJS.ProcessEnv
  routeDeps: RouteDeps
  board?: NoticeBoard
  now?: number
  send?: typeof routeSend
  processAlive?: typeof alive
}
let running = false
export async function processAcceptance(opts: AcceptanceOptions): Promise<void> {
  // The daemon tick may overlap while an operator notification wakes a slow peer.
  if (running) return
  running = true
  try { await reconcile(opts) } finally { running = false }
}
async function reconcile(opts: AcceptanceOptions): Promise<void> {
  const now = opts.now ?? Date.now(), isAlive = opts.processAlive ?? alive, send = opts.send ?? routeSend
  for (const r of listAcceptance(opts.runDir)) {
    const runtime = r.identity.startsWith('claude-') ? 'claude' : 'codex'
    const personality = r.identity.slice(runtime.length + 1)
    if (r.resolution) {
      // Closure releases the caller's downstream custody too, but never the operator channel.
      // This checkpoint is separate from both the immutable decision and mutable native notices.
      let from
      try { from = decodeEnvelope(r.message.slice(r.message.indexOf('<iap '))) } catch { /* no caller */ }
      if (!from || from.fromRuntime === 'core') continue
      const notice = readResolutionNotice(opts.runDir, r.id)
      if (notice?.status === 'sent') continue
      if (notice?.status === 'sending') {
        opts.board?.raise({ personality, runtime, kind: 'delivery-acceptance', eventAtMs: r.resolution.at,
          errorType: `resolution-notification-uncertain:${r.id}`, content: acceptanceEvent(r) })
        continue
      }
      writeResolutionNotice(opts.runDir, r.id, { status: 'sending', at: now })
      try {
        const result = await send(systemCaller(), { personality: from.fromPersonality, runtime: from.fromRuntime,
          topic: 'delivery-acceptance', ...noticePayload(r, opts.runDir) }, { ...opts.routeDeps, env: opts.env, coreNotice: true })
        writeResolutionNotice(opts.runDir, r.id, result.ok ? { status: 'sent', at: now } : undefined)
      } catch { /* keep the ambiguous claim; the owner board exposes it next tick */ }
      continue
    }
    if (r.status === 'rejected' || (r.status === 'delivered' && !r.managed)) {
      if (now - r.updatedAt > FINAL_KEEP_MS) rmSync(acceptancePath(opts.runDir, r.id), { force: true })
      continue
    }
    if (r.status === 'sending' && now - r.createdAt < ACCEPTANCE_ALERT_AFTER_MS && isAlive(r.writerPid, r.writerToken)) continue
    const previous = r.status
    const previousDeadSince = r.deadSince
    if (r.status === 'prepared') {
      if (isAlive(r.writerPid, r.writerToken)) continue // preparation may still enter send
      r.status = 'failed'; r.managed = true; r.reason = 'writer died before paste boundary'
      r.updatedAt = now; writeAcceptance(opts.runDir, r)
      appendDeliveryEvent(opts.logDir, { ev: 'delivery-acceptance', id: r.id, to: r.identity, outcome: r.status })
    }
    if (!['delivered', 'failed'].includes(r.status)) {
      const receipt = runtime === 'claude' ? {
        landed: () => deliveryLanded({ runtime, personality, cwd: r.cwd, ts: r.createdAt, rendered: r.message }, { ...opts.env, HOME: r.home }),
      } : codexReceiptBaseline(r.home, r.cwd, r.message, r.snapshot)
      r.managed = true
      if (receipt.landed()) { r.status = 'delivered'; r.reason = 'native user-input receipt' }
      else {
        const allNativeDead = r.embeddedNative === true && !!r.nativeProcesses?.length && r.nativeProcesses.every(p => !isAlive(p.pid, p.token))
        if (allNativeDead) r.deadSince ??= now
        else r.deadSince = undefined
        // Native TurnStart/SteeredUserInput allow background persistence. Process death
        // can destroy evidence of work already started; empty files NEVER prove refusal.
        if (now - r.createdAt >= ACCEPTANCE_ALERT_AFTER_MS || r.status === 'sending'
          || (allNativeDead && now - (r.deadSince ?? now) >= DEAD_DRAIN_MS)) {
          r.status = 'unresolved'; r.reason = 'native acceptance cannot be proved or excluded; do not replay'
        }
      }
      if (r.status !== previous) {
        r.callerNotice = undefined; r.operatorNotice = undefined; r.lastAlertAt = undefined
        r.updatedAt = now; writeAcceptance(opts.runDir, r)
        appendDeliveryEvent(opts.logDir, { ev: 'delivery-acceptance', id: r.id, to: r.identity, outcome: r.status })
      } else if (r.deadSince !== previousDeadSince) writeAcceptance(opts.runDir, r)
    }
    if (r.status === 'pending') continue
    const unresolved = r.status === 'unresolved'
    if (unresolved || r.status === 'failed') {
      opts.board?.raise({ personality, runtime, kind: 'delivery-acceptance',
        eventAtMs: r.updatedAt,
        errorType: `${r.status}:${r.id}`, summary: `${r.status} delivery ${r.id} to ${r.identity}`, content: acceptanceEvent(r) })
    }
    let from
    try { from = decodeEnvelope(r.message.slice(r.message.indexOf('<iap '))) } catch { /* manual non-IAP input: board/operator only */ }
    const notify = async (slot: 'callerNotice' | 'operatorNotice', target: { peer: string; runtime?: string }) => {
      if (readAcceptance(opts.runDir, r.id)?.resolution) return
      if (r[slot] === 'sent') return
      // Claim BEFORE sending. A restart in this boundary is visible unresolved notification custody,
      // never a blind repeated fallback task. The original receiver is never replayed.
      if (r[slot] === 'sending') {
        opts.board?.raise({ personality, runtime, kind: 'delivery-acceptance',
          eventAtMs: r.updatedAt,
          errorType: `notification-uncertain:${r.id}:${slot}`, content: acceptanceEvent(r) })
        return
      }
      r[slot] = 'sending'; writeAcceptance(opts.runDir, r)
      try {
        const result = await send(systemCaller(), { personality: target.peer, runtime: target.runtime,
          topic: 'delivery-acceptance', ...noticePayload(r, opts.runDir) }, { ...opts.routeDeps, env: opts.env, coreNotice: true })
        if (result.ok) r[slot] = 'sent'
        else r[slot] = undefined // refusal before durable custody: retry notification, not receiver input
      } catch { /* ambiguous send: keep sending claim, board exposes it next tick */ }
      writeAcceptance(opts.runDir, r)
    }
    if (from && from.fromRuntime !== 'core') await notify('callerNotice', { peer: from.fromPersonality, runtime: from.fromRuntime })
    const operator = readAlertTarget(opts.env)
    // Accepted inputs need a sender completion event, not an operator fallback. System notifications
    // themselves never recursively generate operator notifications if that operator is unavailable.
    if (operator && r.status !== 'delivered' && from?.fromRuntime !== 'core') await notify('operatorNotice', operator)
    if (unresolved && r.lastAlertAt === undefined) {
      r.lastAlertAt = now
      writeAcceptance(opts.runDir, r)
    }
    if (['delivered', 'failed'].includes(r.status) && now - r.updatedAt > FINAL_KEEP_MS
      && (!from || from.fromRuntime === 'core' || r.callerNotice === 'sent')
      && (r.status === 'delivered' || !operator || r.operatorNotice === 'sent')) rmSync(acceptancePath(opts.runDir, r.id), { force: true })
  }
}
