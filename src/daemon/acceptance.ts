// Reconcile an uncertain native submit. This module never sends input to the original receiver.
import { existsSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { listAcceptance, writeAcceptance, acceptancePath, type AcceptanceRecord } from '../launch/acceptanceStore.ts'
import { codexReceiptBaseline } from '../launch/codexDelivery.ts'
import { pidStartToken } from '../supervisor/paths.ts'
import { decodeEnvelope } from '../codec/index.ts'
import { systemCaller } from '../identity/index.ts'
import { routeSend, type RouteDeps } from '../transport/index.ts'
import { readAlertTarget } from './bootalert.ts'
import { appendDeliveryEvent } from './deliverylog.ts'
import type { NoticeBoard } from './notices.ts'

export const ACCEPTANCE_ALERT_AFTER_MS = 120_000
const REMIND_MS = 30 * 60_000
const DEAD_DRAIN_MS = 5000
const FINAL_KEEP_MS = 7 * 24 * 60 * 60_000
function alive(pid: number, token: string | null): boolean {
  try { process.kill(pid, 0) } catch { return false }
  return token === null || (pidStartToken(pid) ?? token) === token
}
export function acceptanceEvent(r: AcceptanceRecord): string {
  return JSON.stringify({ event: 'delivery-acceptance', deliveryId: r.id, outcome: r.status,
    recipient: r.identity, reason: r.reason, originalEnvelope: r.message })
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
    if (r.status === 'rejected' || (r.status === 'delivered' && !r.managed)) {
      if (now - r.updatedAt > FINAL_KEEP_MS) rmSync(acceptancePath(opts.runDir, r.id), { force: true })
      continue
    }
    if (r.status === 'sending' && isAlive(r.writerPid, r.writerToken)) continue
    const previous = r.status
    if (!['delivered', 'failed'].includes(r.status)) {
      const receipt = codexReceiptBaseline(r.home, r.cwd, r.message, r.snapshot)
      r.managed = true
      if (receipt.landed()) { r.status = 'delivered'; r.reason = 'native user-input receipt' }
      else {
        const allNativeDead = r.embeddedNative === true && !!r.nativeProcesses?.length && r.nativeProcesses.every(p => !isAlive(p.pid, p.token))
        if (allNativeDead) r.deadSince ??= now
        else r.deadSince = undefined
        const history = join(r.home, 'history.jsonl')
        const historyReadable = existsSync(history) && statSync(history).size >= r.snapshot.historyOffset
        // A crash at the sending boundary remains unknown. A still-live process, native history
        // submission, or unreadable evidence also forbids an automatic non-execution assertion.
        if (r.status !== 'sending' && allNativeDead && now - (r.deadSince ?? now) >= DEAD_DRAIN_MS
          && receipt.readable() && historyReadable && !receipt.submitted()) {
          r.status = 'failed'; r.reason = 'original native receiver exited; readable native evidence contains neither input nor submission'
        } else if (now - r.createdAt >= ACCEPTANCE_ALERT_AFTER_MS || r.status === 'sending') {
          r.status = 'unresolved'; r.reason = 'native acceptance cannot be proved or excluded; do not replay'
        }
      }
      if (r.status !== previous) {
        r.callerNotice = undefined; r.operatorNotice = undefined; r.lastAlertAt = undefined
        r.updatedAt = now; writeAcceptance(opts.runDir, r)
        appendDeliveryEvent(opts.logDir, { ev: 'delivery-acceptance', id: r.id, to: r.identity, outcome: r.status })
      } else if (r.deadSince !== undefined) writeAcceptance(opts.runDir, r)
    }
    if (r.status === 'pending') continue
    const unresolved = r.status === 'unresolved'
    if (unresolved || r.status === 'failed') {
      opts.board?.raise({ personality: r.identity.slice('codex-'.length), runtime: 'codex', kind: 'delivery-acceptance',
        errorType: `${r.status}:${r.id}`, summary: `${r.status} delivery ${r.id} to ${r.identity}`, content: acceptanceEvent(r) })
      if (unresolved && r.lastAlertAt !== undefined && now - r.lastAlertAt < REMIND_MS) continue
    }
    let from
    try { from = decodeEnvelope(r.message.slice(r.message.indexOf('<iap '))) } catch { /* manual non-IAP input: board/operator only */ }
    const notify = async (slot: 'callerNotice' | 'operatorNotice', target: { peer: string; runtime?: string }) => {
      if (r[slot] === 'sent') return
      // Claim BEFORE sending. A restart in this boundary is visible unresolved notification custody,
      // never a blind repeated fallback task. The original receiver is never replayed.
      if (r[slot] === 'sending') {
        opts.board?.raise({ personality: r.identity.slice(6), runtime: 'codex', kind: 'delivery-acceptance',
          errorType: `notification-uncertain:${r.id}:${slot}`, content: acceptanceEvent(r) })
        return
      }
      r[slot] = 'sending'; writeAcceptance(opts.runDir, r)
      try {
        const event = acceptanceEvent(r)
        const oversized = event.length > 15000
        const result = await send(systemCaller(), { personality: target.peer, runtime: target.runtime,
          topic: 'delivery-acceptance', message: oversized
            ? JSON.stringify({ event: 'delivery-acceptance', deliveryId: r.id, outcome: r.status, recipient: r.identity,
              reason: r.reason, originalEnvelopeFile: acceptancePath(opts.runDir, r.id) }) : event,
          ...(oversized ? { attachments: [acceptancePath(opts.runDir, r.id)] } : {}) }, { ...opts.routeDeps, env: opts.env, coreNotice: true })
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
    if (unresolved) {
      r.lastAlertAt = now
      // Reminder is a notification (explicitly unresolved), not a fallback assertion or re-paste.
      if (r.operatorNotice === 'sent') r.operatorNotice = undefined
      writeAcceptance(opts.runDir, r)
    }
    if (['delivered', 'failed'].includes(r.status) && now - r.updatedAt > FINAL_KEEP_MS
      && (!from || from.fromRuntime === 'core' || r.callerNotice === 'sent')
      && (r.status === 'delivered' || !operator || r.operatorNotice === 'sent')) rmSync(acceptancePath(opts.runDir, r.id), { force: true })
  }
}
