// Durable custody for an input that may already have crossed the native submit boundary.
// This store is deliberately NOT a retry queue: no consumer is allowed to paste its payload.
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ReceiptSnapshot { offsets: [string, number][]; historyOffset: number }
export type AcceptanceStatus = 'prepared' | 'sending' | 'pending' | 'delivered' | 'failed' | 'unresolved' | 'rejected' | 'dismissed'
export interface AcceptanceResolution {
  outcome: 'delivered' | 'failed' | 'dismissed'
  reason: string
  actor: string
  at: number
}
export interface AcceptanceRecord {
  id: string
  identity: string
  token: string
  home: string
  cwd: string
  message: string
  snapshot: ReceiptSnapshot
  createdAt: number
  updatedAt: number
  writerPid: number
  writerToken: string | null
  nativeProcesses?: { pid: number; token: string | null }[]
  /** Explicit --no-daemon identifies an embedded writer; its death still cannot prove non-execution. */
  embeddedNative?: boolean
  status: AcceptanceStatus
  reason?: string
  managed?: boolean
  deadSince?: number
  callerNotified?: boolean
  operatorNotified?: boolean
  lastAlertAt?: number
  callerNotice?: 'sending' | 'sent'
  operatorNotice?: 'sending' | 'sent'
  resolution?: AcceptanceResolution
}
export const acceptanceDir = (runDir: string) => join(runDir, 'acceptance')
export const acceptancePath = (runDir: string, id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid delivery ID')
  return join(acceptanceDir(runDir), `${id}.json`)
}
export function writeAcceptance(runDir: string, record: AcceptanceRecord): void {
  writeDurableJson(runDir, acceptancePath(runDir, record.id), record)
}
function writeDurableJson(runDir: string, path: string, record: unknown): void {
  mkdirSync(acceptanceDir(runDir), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd)
    closeSync(fd); fd = undefined
    renameSync(tmp, path)
    // The renamed directory entry is part of write-ahead custody, not just the file bytes.
    fd = openSync(acceptanceDir(runDir), 'r'); fsyncSync(fd); closeSync(fd); fd = undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(tmp, { force: true })
  }
}
export interface ResolutionNotice { status: 'sending' | 'sent'; at: number }
export function readResolutionNotice(runDir: string, id: string): ResolutionNotice | undefined {
  try {
    const r = JSON.parse(readFileSync(acceptancePath(runDir, id) + '.resolution-notice', 'utf8'))
    if (!['sending', 'sent'].includes(r.status)) throw new Error('invalid resolution notification checkpoint')
    return r
  } catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e }
}
export function writeResolutionNotice(runDir: string, id: string, notice: ResolutionNotice | undefined): void {
  const path = acceptancePath(runDir, id) + '.resolution-notice'
  if (notice) writeDurableJson(runDir, path, notice)
  else rmSync(path, { force: true }) // only after an explicit pre-custody refusal
}
export function readAcceptance(runDir: string, id: string): AcceptanceRecord | null {
  try {
    const r: AcceptanceRecord = JSON.parse(readFileSync(acceptancePath(runDir, id), 'utf8'))
    try {
      r.resolution = JSON.parse(readFileSync(acceptancePath(runDir, id) + '.resolved', 'utf8'))
      r.status = r.resolution!.outcome
    } catch (e: any) { if (e.code !== 'ENOENT') throw e }
    return r
  } catch { return null }
}
/** Independent immutable checkpoint: a concurrent writer can never reopen a closed case. */
export function resolveAcceptance(runDir: string, id: string, resolution: AcceptanceResolution): AcceptanceRecord {
  if (!['delivered', 'failed', 'dismissed'].includes(resolution.outcome) || !resolution.reason.trim()) throw new Error('outcome and nonempty reason required')
  const r = readAcceptance(runDir, id)
  if (!r) throw new Error(`delivery not found: ${id}`)
  if (r.resolution) {
    if (r.resolution.outcome !== resolution.outcome || r.resolution.reason !== resolution.reason) throw new Error('delivery already resolved differently')
    return r
  }
  const path = acceptancePath(runDir, id) + '.resolved', tmp = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(resolution) + '\n'); fsyncSync(fd); closeSync(fd); fd = undefined
    linkSync(tmp, path) // exclusive publish; no partial record and no overwriting another operator
    fd = openSync(acceptanceDir(runDir), 'r'); fsyncSync(fd); closeSync(fd); fd = undefined
  } finally { if (fd !== undefined) closeSync(fd); rmSync(tmp, { force: true }) }
  return readAcceptance(runDir, id)!
}
export function listAcceptance(runDir: string): AcceptanceRecord[] {
  let names: string[]
  try { names = readdirSync(acceptanceDir(runDir)) } catch { return [] }
  return names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).flatMap(n => {
    const r = readAcceptance(runDir, n.slice(0, -5)); return r ? [r] : []
  })
}
