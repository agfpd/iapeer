// Durable custody for an input that may already have crossed the native submit boundary.
// This store is deliberately NOT a retry queue: no consumer is allowed to paste its payload.
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ReceiptSnapshot { offsets: [string, number][]; historyOffset: number }
export type AcceptanceStatus = 'sending' | 'pending' | 'delivered' | 'failed' | 'unresolved' | 'rejected'
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
  /** Explicit --no-daemon proves the tracked native process owns persistence, not a shared server. */
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
}
export const acceptanceDir = (runDir: string) => join(runDir, 'acceptance')
export const acceptancePath = (runDir: string, id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid delivery ID')
  return join(acceptanceDir(runDir), `${id}.json`)
}
export function writeAcceptance(runDir: string, record: AcceptanceRecord): void {
  const path = acceptancePath(runDir, record.id)
  mkdirSync(acceptanceDir(runDir), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd)
    closeSync(fd); fd = undefined
    renameSync(tmp, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(tmp, { force: true })
  }
}
export function readAcceptance(runDir: string, id: string): AcceptanceRecord | null {
  try { return JSON.parse(readFileSync(acceptancePath(runDir, id), 'utf8')) } catch { return null }
}
export function listAcceptance(runDir: string): AcceptanceRecord[] {
  let names: string[]
  try { names = readdirSync(acceptanceDir(runDir)) } catch { return [] }
  return names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).flatMap(n => {
    const r = readAcceptance(runDir, n.slice(0, -5)); return r ? [r] : []
  })
}
