import { describe, expect, test } from 'bun:test'
import { actionContent, formatHookDecision, parseHookInput, runApprovalHook } from './hook.ts'

describe('parseHookInput', () => {
  test('extracts tool_name + tool_input', () => {
    const r = parseHookInput(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'bypassPermissions' }))
    expect(r.toolName).toBe('Bash')
    expect(r.toolInput).toEqual({ command: 'ls' })
  })
  test('throws on non-JSON and on missing tool_name', () => {
    expect(() => parseHookInput('not json')).toThrow()
    expect(() => parseHookInput(JSON.stringify({ tool_input: {} }))).toThrow()
  })
})

describe('actionContent (verbatim content per tool — criterion #7)', () => {
  test('Bash → the full command verbatim + description', () => {
    const a = actionContent('Bash', { command: 'rm -rf /tmp/x && echo done', description: 'clean' })
    expect(a.kind).toBe('tool')
    expect(a.content).toContain('rm -rf /tmp/x && echo done')
    expect(a.content).toContain('# clean')
    expect(a.summary).toBe('rm -rf /tmp/x && echo done')
  })
  test('Edit → file + old/new', () => {
    const a = actionContent('Edit', { file_path: '/w/a.ts', old_string: 'foo', new_string: 'bar' })
    expect(a.content).toContain('/w/a.ts')
    expect(a.content).toContain('foo')
    expect(a.content).toContain('bar')
    expect(a.summary).toBe('Edit /w/a.ts')
  })
  test('Write → file + content', () => {
    const a = actionContent('Write', { file_path: '/w/b.ts', content: 'hello world' })
    expect(a.content).toContain('/w/b.ts')
    expect(a.content).toContain('hello world')
  })
  test('ExitPlanMode → the plan text, kind=plan', () => {
    const a = actionContent('ExitPlanMode', { plan: '1. do X\n2. do Y' })
    expect(a.kind).toBe('plan')
    expect(a.content).toBe('1. do X\n2. do Y')
    expect(a.summary).toBe('1. do X')
  })
  test('apply_patch (codex) → the patch text', () => {
    const a = actionContent('apply_patch', { input: '*** Begin Patch\n+new line' })
    expect(a.content).toContain('+new line')
  })
  test('unknown tool → pretty tool_input, nothing opaque', () => {
    const a = actionContent('WebFetch', { url: 'https://x', prompt: 'p' })
    expect(a.content).toContain('https://x')
    expect(a.summary).toBe('WebFetch')
  })
})

describe('formatHookDecision', () => {
  test('allow → no reason', () => {
    expect(JSON.parse(formatHookDecision({ decision: 'allow' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    })
  })
  test('deny → carries the reason to the model', () => {
    expect(JSON.parse(formatHookDecision({ decision: 'deny', reason: 'too risky' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'too risky' },
    })
  })
})

const env = { PEER_PERSONALITY: 'boris', PEER_RUNTIME: 'claude', IAPEER_TEST_SANDBOX: '1' } as unknown as NodeJS.ProcessEnv
const okFetch = (payload: unknown): typeof fetch =>
  (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch

describe('runApprovalHook (fail-safe orchestration)', () => {
  test('broker allow → allow JSON; the request body carries verbatim content', async () => {
    let sentBody: Record<string, unknown> = {}
    const spyFetch = (async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ decision: 'allow' }) }
    }) as unknown as typeof fetch
    const r = await runApprovalHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }), { env, fetch: spyFetch })
    expect(JSON.parse(r.output).hookSpecificOutput.permissionDecision).toBe('allow')
    expect(sentBody.personality).toBe('boris')
    expect(sentBody.tool).toBe('Bash')
    expect(sentBody.content).toContain('echo hi')
  })
  test('broker deny → deny JSON with the reason', async () => {
    const r = await runApprovalHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }), {
      env,
      fetch: okFetch({ decision: 'deny', reason: 'obviously no' }),
    })
    const out = JSON.parse(r.output).hookSpecificOutput
    expect(out.permissionDecision).toBe('deny')
    expect(out.permissionDecisionReason).toBe('obviously no')
  })
  test('daemon unreachable → FAIL-SAFE deny (never allow-by-accident)', async () => {
    const deadFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const r = await runApprovalHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'x' } }), { env, fetch: deadFetch })
    const out = JSON.parse(r.output).hookSpecificOutput
    expect(out.permissionDecision).toBe('deny')
    expect(out.permissionDecisionReason).toContain('unavailable')
    expect(r.exitCode).toBe(0)
  })
  test('no PEER_PERSONALITY → FAIL-SAFE deny', async () => {
    const r = await runApprovalHook(JSON.stringify({ tool_name: 'Bash', tool_input: {} }), {
      env: { IAPEER_TEST_SANDBOX: '1' } as unknown as NodeJS.ProcessEnv,
      fetch: okFetch({ decision: 'allow' }),
    })
    expect(JSON.parse(r.output).hookSpecificOutput.permissionDecision).toBe('deny')
  })
  test('non-JSON stdin → FAIL-SAFE deny', async () => {
    const r = await runApprovalHook('garbage', { env, fetch: okFetch({ decision: 'allow' }) })
    expect(JSON.parse(r.output).hookSpecificOutput.permissionDecision).toBe('deny')
  })
})
