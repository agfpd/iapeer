import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { composeApprovalContent, routeCircuitBreaker, type BreakerRouteDeps } from './approvalRoute.ts'

// Hermetic: an isolated IAPEER_ROOT so resolveFleetBase (inside routeCircuitBreaker) never reads the
// live host's router.json. fetch is injected, so no network is touched.
const roots: string[] = []
function isolatedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'iapeer-approvalroute-'))
  roots.push(root)
  return root
}
afterAll(() => {
  for (const r of roots) try { rmSync(r, { recursive: true, force: true }) } catch { /* */ }
})

const APPROVE = Buffer.from('1\r')
const DENY = Buffer.from('2\r') // dangerous-rm decline (2-option layout)
const input = { taxonomy: 'dangerous-rm', detail: 'cmd="rm -rf /x" target="/x"', approveBytes: APPROVE, denyBytes: DENY }

function deps(fetchImpl: typeof fetch, extra: Partial<BreakerRouteDeps> = {}): { deps: BreakerRouteDeps; written: Buffer[]; logs: string[] } {
  const written: Buffer[] = []
  const logs: string[] = []
  return {
    written,
    logs,
    deps: {
      personality: 'boris',
      runtime: 'claude',
      env: { IAPEER_ROOT: isolatedRoot(), IAPEER_TEST_SANDBOX: '1' } as unknown as NodeJS.ProcessEnv,
      fetch: fetchImpl,
      write: b => written.push(b),
      log: l => logs.push(l),
      now: () => 0,
      ...extra,
    },
  }
}

describe('routeCircuitBreaker — gated circuit-breaker routed to the human broker', () => {
  test('broker ALLOW → inject the AFFIRMATIVE keys; decision returned; BREAKER-ALLOW logged', async () => {
    const { deps: d, written, logs } = deps((async () => ({ ok: true, status: 200, json: async () => ({ id: 'a1', decision: 'allow' }) })) as unknown as typeof fetch)
    const decision = await routeCircuitBreaker(input, d)
    expect(decision).toEqual({ decision: 'allow' })
    expect(written).toEqual([APPROVE]) // pressed YES
    expect(logs[0]).toContain('BREAKER-ALLOW dangerous-rm')
    expect(logs[0]).toContain('cmd="rm -rf /x"')
  })

  test('broker DENY → inject the taxonomy-specific DECLINE keys; reason logged', async () => {
    const { deps: d, written, logs } = deps((async () => ({ ok: true, status: 200, json: async () => ({ id: 'a2', decision: 'deny', reason: 'too risky' }) })) as unknown as typeof fetch)
    const decision = await routeCircuitBreaker(input, d)
    expect(decision).toEqual({ decision: 'deny', reason: 'too risky' })
    expect(written).toEqual([DENY]) // pressed No
    expect(logs[0]).toContain('BREAKER-DENY dangerous-rm')
    expect(logs[0]).toContain('reason="too risky"')
  })

  test('FAIL-SAFE — a dead daemon (fetch throws) DENIES (decline keys), never auto-Yes', async () => {
    const { deps: d, written } = deps((async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch)
    const decision = await routeCircuitBreaker(input, d)
    expect(decision.decision).toBe('deny')
    expect(decision.reason).toContain('denied fail-safe')
    expect(written).toEqual([DENY]) // NEVER APPROVE on a broker fault
  })

  test('FAIL-SAFE — a non-200 status also DENIES', async () => {
    const { deps: d, written } = deps((async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch)
    const decision = await routeCircuitBreaker(input, d)
    expect(decision.decision).toBe('deny')
    expect(written).toEqual([DENY])
  })

  test('POST body carries the circuit-breaker shape (kind/tool/content/summary from the taxonomy + detail)', async () => {
    let sent: Record<string, unknown> = {}
    const { deps: d } = deps((async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ decision: 'allow' }) }
    }) as unknown as typeof fetch)
    await routeCircuitBreaker(input, d)
    expect(sent).toEqual({
      personality: 'boris',
      runtime: 'claude',
      kind: 'circuit-breaker',
      tool: 'dangerous-rm',
      content: 'cmd="rm -rf /x" target="/x"',
      summary: 'dangerous-rm',
    })
  })

  test('command-approval taxonomy carries its own 3-option decline bytes through unchanged', async () => {
    const cmdInput = { taxonomy: 'command-approval', detail: 'cmd="env | grep PATH"', approveBytes: Buffer.from('1\r'), denyBytes: Buffer.from('3\r') }
    const { deps: d, written } = deps((async () => ({ ok: true, status: 200, json: async () => ({ decision: 'deny', reason: 'no' }) })) as unknown as typeof fetch)
    await routeCircuitBreaker(cmdInput, d)
    expect(written).toEqual([Buffer.from('3\r')]) // 3.No, not 2 (which is "Yes, and…")
  })
})

// docs/17 yolo-robustness — the composed human-facing content. KNOWN breakers keep the Ф1 format; the
// always-human classes carry EXPLICIT button semantics so the human decides informed (boris refinement).
describe('composeApprovalContent — explicit button semantics for the human', () => {
  test('unknown-modal: content states Allow presses option 1 (verbatim) + Deny cancels via Esc + the block', () => {
    const { content, summary } = composeApprovalContent({
      taxonomy: 'unknown-modal',
      brokerKind: 'unknown-modal',
      detail: 'How should I proceed?\n1. Rewrite in place\n2. Version it',
      option1: 'Rewrite in place',
      approveBytes: Buffer.from('1\r'),
      denyBytes: Buffer.from('\x1b'),
    })
    expect(content).toContain('Allow → presses option 1: "Rewrite in place"') // the human sees WHAT Allow does
    expect(content).toContain('Deny  → cancels the modal (Esc)')
    expect(content).toContain('modal (verbatim)')
    expect(content).toContain('1. Rewrite in place') // the verbatim block is included
    expect(summary).toContain('Allow presses option 1: Rewrite in place')
  })

  test('unknown-modal without a parsed option-1 label falls back to a safe placeholder', () => {
    const { content } = composeApprovalContent({ taxonomy: 'unknown-modal', brokerKind: 'unknown-modal', detail: 'x', approveBytes: Buffer.alloc(0), denyBytes: Buffer.alloc(0) })
    expect(content).toContain('Allow → presses option 1: "(option 1)"')
  })

  test('org-policy: content states the known 1.Yes / 3.No mapping', () => {
    const { content } = composeApprovalContent({ taxonomy: 'org-policy', brokerKind: 'circuit-breaker', detail: 'cmd="mcp__x__y"', approveBytes: Buffer.from('1\r'), denyBytes: Buffer.from('3\r') })
    expect(content).toContain('Organization policy requires approval')
    expect(content).toContain('Allow → presses "1. Yes"')
    expect(content).toContain('Deny  → presses "3. No"')
    expect(content).toContain('cmd="mcp__x__y"')
  })

  test('known circuit-breaker (dangerous-rm) content is UNCHANGED (Ф1 format — no regression)', () => {
    const { content, summary } = composeApprovalContent(input)
    expect(content).toBe('cmd="rm -rf /x" target="/x"')
    expect(summary).toBe('dangerous-rm')
  })
})

describe('routeCircuitBreaker — unknown-modal routed to the human (kind + Esc-deny)', () => {
  const unknownInput = {
    taxonomy: 'unknown-modal',
    brokerKind: 'unknown-modal',
    detail: 'How should I proceed?\n1. Rewrite\n2. Version',
    option1: 'Rewrite',
    approveBytes: Buffer.from('1\r'),
    denyBytes: Buffer.from('\x1b'), // Escape
  }

  test('broker ALLOW → injects option-1 keys ("1\\r")', async () => {
    const { deps: d, written } = deps((async () => ({ ok: true, status: 200, json: async () => ({ decision: 'allow' }) })) as unknown as typeof fetch)
    await routeCircuitBreaker(unknownInput, d)
    expect(written).toEqual([Buffer.from('1\r')])
  })

  test('broker DENY → injects Escape (cancel the modal)', async () => {
    const { deps: d, written } = deps((async () => ({ ok: true, status: 200, json: async () => ({ decision: 'deny', reason: 'not sure' }) })) as unknown as typeof fetch)
    await routeCircuitBreaker(unknownInput, d)
    expect(written).toEqual([Buffer.from('\x1b')]) // Esc, never a blind numbered choice
  })

  test('FAIL-SAFE — a dead daemon denies → Escape injected (never a blind Yes)', async () => {
    const { deps: d, written } = deps((async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch)
    const decision = await routeCircuitBreaker(unknownInput, d)
    expect(decision.decision).toBe('deny')
    expect(written).toEqual([Buffer.from('\x1b')])
  })

  test('POST body carries kind=unknown-modal + the semantics-bearing content', async () => {
    let sent: Record<string, unknown> = {}
    const { deps: d } = deps((async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ decision: 'allow' }) }
    }) as unknown as typeof fetch)
    await routeCircuitBreaker(unknownInput, d)
    expect(sent.kind).toBe('unknown-modal')
    expect(sent.tool).toBe('unknown-modal')
    expect(String(sent.content)).toContain('Allow → presses option 1: "Rewrite"')
    expect(String(sent.content)).toContain('modal (verbatim)')
  })
})
