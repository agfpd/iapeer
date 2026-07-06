import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ApprovalBroker } from './approvals.ts'
import { approvalsLogPath } from './approvalslog.ts'

let logDir: string
beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'iapeer-approvals-'))
})
afterEach(() => {
  rmSync(logDir, { recursive: true, force: true })
})

function readLog(): string {
  const p = approvalsLogPath(logDir)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

describe('ApprovalBroker', () => {
  test('request → list shows it; resolve(allow) settles the promise and clears the queue', async () => {
    const broker = new ApprovalBroker({ logDir, timeoutMs: 60_000 })
    const { id, decision } = broker.request({
      personality: 'boris',
      runtime: 'claude',
      kind: 'tool',
      tool: 'Bash',
      content: 'rm -rf /tmp/x && echo done',
    })
    const list = broker.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe(id)
    expect(list[0]!.tool).toBe('Bash')
    expect(list[0]!.content).toBe('rm -rf /tmp/x && echo done') // FULL content preserved (criterion #7)
    expect(list[0]!.summary).toBe('rm -rf /tmp/x && echo done') // one-line summary defaults to first line
    expect(list[0]!.title).toBe('boris · Bash')

    expect(broker.resolve(id, { decision: 'allow' }, { by: 'arthur', via: 'cli' })).toBe(true)
    await expect(decision).resolves.toEqual({ decision: 'allow' })
    expect(broker.list()).toHaveLength(0)

    // both events durably logged (summary only, not the full content)
    const log = readLog()
    expect(log).toContain('ev=approval-request')
    expect(log).toContain('ev=approval-resolved')
    expect(log).toContain('decision=allow')
    expect(log).toContain('by=arthur')
  })

  test('deny carries a reason to the model', async () => {
    const broker = new ApprovalBroker({ logDir, timeoutMs: 60_000 })
    const { id, decision } = broker.request({ personality: 'p', runtime: 'claude', kind: 'tool', tool: 'Bash', content: 'sudo rm' })
    broker.resolve(id, { decision: 'deny', reason: 'too risky' }, { by: 'arthur', via: 'cli' })
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'too risky' })
    expect(readLog()).toContain('reason="too risky"')
  })

  test('timeout → default-deny, the peer never hangs', async () => {
    const broker = new ApprovalBroker({ logDir, timeoutMs: 25 })
    const { decision } = broker.request({ personality: 'p', runtime: 'claude', kind: 'tool', tool: 'Bash', content: 'echo hi' })
    const d = await decision
    expect(d.decision).toBe('deny')
    expect(d.reason).toContain('timed out')
    expect(broker.list()).toHaveLength(0)
    expect(readLog()).toContain('via=timeout')
  })

  test('resolve of an unknown / already-resolved id → false', () => {
    const broker = new ApprovalBroker({ logDir, timeoutMs: 60_000 })
    const { id } = broker.request({ personality: 'p', runtime: 'claude', kind: 'tool', tool: 'Bash', content: 'x' })
    expect(broker.resolve(id, { decision: 'allow' })).toBe(true)
    expect(broker.resolve(id, { decision: 'allow' })).toBe(false) // already gone
    expect(broker.resolve('nope', { decision: 'allow' })).toBe(false)
  })

  test('cancel (requester disconnected) → default-deny + dropped from the queue', async () => {
    const broker = new ApprovalBroker({ logDir, timeoutMs: 60_000 })
    const { id, decision } = broker.request({ personality: 'p', runtime: 'codex', kind: 'tool', tool: 'apply_patch', content: 'diff' })
    expect(broker.cancel(id)).toBe(true)
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'requester disconnected' })
    expect(broker.list()).toHaveLength(0)
    expect(broker.cancel(id)).toBe(false)
  })

  test('explicit summary/title/approvers override the defaults', () => {
    const broker = new ApprovalBroker({ logDir, timeoutMs: 60_000 })
    broker.request({
      personality: 'p',
      runtime: 'claude',
      kind: 'circuit-breaker',
      tool: 'dangerous-rm',
      content: 'Dangerous rm operation on working directory or its ancestor:\n/some/path\nDo you want to proceed?',
      summary: 'dangerous-rm /some/path',
      title: 'p · dangerous-rm',
      approvers: ['arthur'],
    })
    const item = broker.list()[0]!
    expect(item.summary).toBe('dangerous-rm /some/path')
    expect(item.title).toBe('p · dangerous-rm')
    expect(item.approvers).toEqual(['arthur'])
    expect(item.kind).toBe('circuit-breaker')
  })
})
