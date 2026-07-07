import { describe, expect, test } from 'bun:test'
import { actionContent, formatHookDecision, parseHookInput, runApprovalHook } from './hook.ts'

describe('parseHookInput', () => {
  test('extracts event + tool_name + tool_input', () => {
    const r = parseHookInput(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }))
    expect(r.event).toBe('PermissionRequest')
    expect(r.toolName).toBe('Bash')
    expect(r.toolInput).toEqual({ command: 'ls' })
    expect(parseHookInput(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} })).event).toBe('PreToolUse')
  })
  test('throws on non-JSON, unknown event, and missing tool_name', () => {
    expect(() => parseHookInput('not json')).toThrow()
    expect(() => parseHookInput(JSON.stringify({ hook_event_name: 'Bogus', tool_name: 'Bash' }))).toThrow()
    expect(() => parseHookInput(JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: {} }))).toThrow()
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

describe('formatHookDecision (per-event shape — verified live)', () => {
  test('PermissionRequest → decision.behavior (+ message on deny)', () => {
    expect(JSON.parse(formatHookDecision({ decision: 'allow' }, 'PermissionRequest'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    })
    expect(JSON.parse(formatHookDecision({ decision: 'deny', reason: 'too risky' }, 'PermissionRequest'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'too risky' } },
    })
  })
  test('PreToolUse claude → permissionDecision allow/deny (affirmative allow honored)', () => {
    expect(JSON.parse(formatHookDecision({ decision: 'allow' }, 'PreToolUse', 'claude'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    })
    expect(JSON.parse(formatHookDecision({ decision: 'deny', reason: 'too risky' }, 'PreToolUse', 'claude'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'too risky' },
    })
  })
  test('PreToolUse codex ALLOW → EMPTY output (abstain — an affirmative allow fails the codex hook, verified live 0.142.5)', () => {
    // The fix: codex honors ONLY deny; permissionDecision:"allow" marks the hook Failed
    // (fail-open + TUI error). Abstaining (empty stdout, exit 0) → hook Completed → tool runs.
    expect(formatHookDecision({ decision: 'allow' }, 'PreToolUse', 'codex')).toBe('')
  })
  test('PreToolUse codex DENY → permissionDecision deny + reason (unchanged, not a regress)', () => {
    expect(JSON.parse(formatHookDecision({ decision: 'deny', reason: 'nope' }, 'PreToolUse', 'codex'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'nope' },
    })
  })
  test('default runtime = claude (unspecified) keeps the affirmative allow', () => {
    expect(JSON.parse(formatHookDecision({ decision: 'allow' }, 'PreToolUse'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    })
  })
})

const env = { PEER_PERSONALITY: 'boris', PEER_RUNTIME: 'claude', IAPEER_TEST_SANDBOX: '1' } as unknown as NodeJS.ProcessEnv
const okFetch = (payload: unknown): typeof fetch =>
  (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch

const PREQ = (tool_input: Record<string, unknown>, tool_name = 'Bash'): string =>
  JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name, tool_input })

describe('runApprovalHook (fail-safe orchestration)', () => {
  test('broker allow → PermissionRequest decision.behavior=allow; body carries verbatim content', async () => {
    let sentBody: Record<string, unknown> = {}
    const spyFetch = (async (_url: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ decision: 'allow' }) }
    }) as unknown as typeof fetch
    const r = await runApprovalHook(PREQ({ command: 'echo hi' }), { env, fetch: spyFetch })
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior).toBe('allow')
    expect(r.exitCode).toBe(0)
    expect(sentBody.personality).toBe('boris')
    expect(sentBody.tool).toBe('Bash')
    expect(sentBody.content).toContain('echo hi')
  })
  test('broker deny → PermissionRequest decision.behavior=deny + message to model', async () => {
    const r = await runApprovalHook(PREQ({ command: 'rm -rf /' }), { env, fetch: okFetch({ decision: 'deny', reason: 'obviously no' }) })
    const out = JSON.parse(r.stdout).hookSpecificOutput.decision
    expect(out.behavior).toBe('deny')
    expect(out.message).toBe('obviously no')
  })
  test('PreToolUse + claude runtime → permissionDecision allow shape', async () => {
    const r = await runApprovalHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), { env, fetch: okFetch({ decision: 'allow' }) })
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('allow')
  })
  test('PreToolUse + codex runtime + ALLOW → EMPTY stdout, exit 0 (the fix: no hook error, tool runs)', async () => {
    const codexEnv = { ...env, PEER_RUNTIME: 'codex' } as unknown as NodeJS.ProcessEnv
    const r = await runApprovalHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), { env: codexEnv, fetch: okFetch({ decision: 'allow' }) })
    expect(r.stdout).toBe('') // abstain → codex marks the hook Completed and runs the tool
    expect(r.exitCode).toBe(0)
  })
  test('PreToolUse + codex runtime + DENY → still blocks with reason (not a regress)', async () => {
    const codexEnv = { ...env, PEER_RUNTIME: 'codex' } as unknown as NodeJS.ProcessEnv
    const r = await runApprovalHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }), { env: codexEnv, fetch: okFetch({ decision: 'deny', reason: 'obviously no' }) })
    const out = JSON.parse(r.stdout).hookSpecificOutput
    expect(out.permissionDecision).toBe('deny')
    expect(out.permissionDecisionReason).toBe('obviously no')
  })
  test('PreToolUse + codex runtime + daemon unreachable → FAIL-SAFE deny (blocks, exit 0)', async () => {
    const codexEnv = { ...env, PEER_RUNTIME: 'codex' } as unknown as NodeJS.ProcessEnv
    const deadFetch = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const r = await runApprovalHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' } }), { env: codexEnv, fetch: deadFetch })
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny') // fail-safe DENIES, never abstains-to-allow
    expect(r.exitCode).toBe(0)
  })
  test('daemon unreachable → FAIL-SAFE deny (event-appropriate, exit 0)', async () => {
    const deadFetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const r = await runApprovalHook(PREQ({ command: 'x' }), { env, fetch: deadFetch })
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior).toBe('deny')
    expect(r.exitCode).toBe(0)
  })
  test('no PEER_PERSONALITY → FAIL-SAFE deny', async () => {
    const r = await runApprovalHook(PREQ({}), { env: { IAPEER_TEST_SANDBOX: '1' } as unknown as NodeJS.ProcessEnv, fetch: okFetch({ decision: 'allow' }) })
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior).toBe('deny')
  })
  test('unparseable stdin → exit 2 (denies under BOTH events, no stdout JSON)', async () => {
    const r = await runApprovalHook('garbage', { env, fetch: okFetch({ decision: 'allow' }) })
    expect(r.exitCode).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('denied fail-safe')
  })
})
