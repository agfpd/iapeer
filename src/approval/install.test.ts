import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { IAPEER_MCP_ALLOW, codexHooksJsonPath, installClaudeApproval, removeClaudeApproval, setApprovalMode } from './install.ts'
import { claudeSettingsPath } from '../launch/nativeMemory.ts'
import { peerProfilePath } from '../storage/index.ts'
import { readPeerProfile } from '../identity/index.ts'

let cwd: string
const env = { ...process.env, IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv
beforeEach(() => {
  cwd = mkdtempSyncSafe()
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})
function mkdtempSyncSafe(): string {
  const d = join(tmpdir(), `iapeer-approval-install-${Math.floor(performance.now())}-${process.hrtime()[1]}`)
  mkdirSync(d, { recursive: true })
  return d
}
function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(claudeSettingsPath(cwd), 'utf8'))
}

describe('claude approval install / remove — the toggle idempotency invariant', () => {
  test('install seeds the PermissionRequest hook + MCP allow-rule; remove restores byte-identical bytes', () => {
    // a pre-existing settings.json with foreign content (as ensureClaudeProjectSettings leaves)
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(claudeSettingsPath(cwd), `${JSON.stringify({ enableAllProjectMcpServers: true, tui: 'default' }, null, 2)}\n`)
    const pristine = readFileSync(claudeSettingsPath(cwd), 'utf8')

    installClaudeApproval(cwd, env)
    const s = readSettings()
    const group = (s.hooks as { PermissionRequest: Array<{ matcher?: string; hooks: Array<{ command: string }> }> }).PermissionRequest[0]!
    expect(group.matcher).toBeUndefined() // matcher-FREE (Option D: PermissionRequest fires only on prompts)
    expect(group.hooks[0]!.command).toContain('approval-hook')
    expect((s.permissions as { allow: string[] }).allow).toContain(IAPEER_MCP_ALLOW)
    // foreign keys preserved
    expect(s.enableAllProjectMcpServers).toBe(true)
    expect(s.tui).toBe('default')
    const installed = readFileSync(claudeSettingsPath(cwd), 'utf8')

    // install is idempotent (no duplicate group / allow entry)
    installClaudeApproval(cwd, env)
    expect(readFileSync(claudeSettingsPath(cwd), 'utf8')).toBe(installed)

    // remove restores the pristine bytes (foreign content intact, our block gone)
    removeClaudeApproval(cwd)
    expect(readFileSync(claudeSettingsPath(cwd), 'utf8')).toBe(pristine)

    // repeated flip install→remove→install→remove is byte-identical each way
    installClaudeApproval(cwd, env)
    expect(readFileSync(claudeSettingsPath(cwd), 'utf8')).toBe(installed)
    removeClaudeApproval(cwd)
    expect(readFileSync(claudeSettingsPath(cwd), 'utf8')).toBe(pristine)
  })

  test('a foreign PreToolUse hook + foreign allow-rule survive our install/remove', () => {
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    const foreign = {
      hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: '/foreign/thing' }] }] },
      permissions: { allow: ['Bash(ls)'] },
    }
    writeFileSync(claudeSettingsPath(cwd), `${JSON.stringify(foreign, null, 2)}\n`)
    const pristine = readFileSync(claudeSettingsPath(cwd), 'utf8')

    installClaudeApproval(cwd, env)
    const s = readSettings()
    // our hook lands under PermissionRequest; the foreign PreToolUse hook is untouched
    expect((s.hooks as { PreToolUse: unknown[] }).PreToolUse).toHaveLength(1) // foreign preserved
    expect((s.hooks as { PermissionRequest: unknown[] }).PermissionRequest).toHaveLength(1) // ours
    expect((s.permissions as { allow: string[] }).allow).toEqual(['Bash(ls)', IAPEER_MCP_ALLOW])

    removeClaudeApproval(cwd)
    expect(readFileSync(claudeSettingsPath(cwd), 'utf8')).toBe(pristine) // only OUR block removed
  })
})

describe('setApprovalMode — profile field + surfaces', () => {
  function seedPeer(runtimes: string[]): void {
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      peerProfilePath(cwd),
      JSON.stringify({ personality: 'tester', default_runtime: runtimes[0], runtimes, description: 'x', intelligence: 'artificial' }),
    )
  }

  test('gated writes the field + installs claude surfaces; yolo removes both', () => {
    seedPeer(['claude'])
    const g = setApprovalMode(cwd, 'gated', env)
    expect(g.mode).toBe('gated')
    expect(readPeerProfile(cwd)!.approval_mode).toBe('gated')
    expect(existsSync(claudeSettingsPath(cwd))).toBe(true)
    expect(readSettings().hooks).toBeDefined()

    const y = setApprovalMode(cwd, 'yolo', env)
    expect(y.mode).toBe('yolo')
    expect(readPeerProfile(cwd)!.approval_mode).toBeUndefined() // field removed → pristine yolo
    // our hook block removed
    const s = existsSync(claudeSettingsPath(cwd)) ? readSettings() : {}
    expect(s.hooks).toBeUndefined()
  })

  test('throws for a cwd with no peer profile', () => {
    expect(() => setApprovalMode(cwd, 'gated', env)).toThrow()
  })

  // docs/17 reframe (07.07): gated codex = native modal + supervisor proxy, so iapeer installs NO broker
  // PreToolUse hook on gated codex (the hook would SILENCE the native modal). CODEX_HOME is isolated so the
  // trust-clear (removeCodexHooksTrustUnder) never touches the real ~/.codex.
  function codexEnvFor(): NodeJS.ProcessEnv {
    return { ...env, CODEX_HOME: join(cwd, '.codexhome') }
  }
  function codexHooksText(): string | null {
    const p = codexHooksJsonPath(cwd)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  }

  test('gated codex installs NO broker hook (native-modal model); surface says so; round-trip has no accumulation', () => {
    seedPeer(['codex'])
    const cenv = codexEnvFor()
    const g = setApprovalMode(cwd, 'gated', cenv)
    expect(g.mode).toBe('gated')
    expect(readPeerProfile(cwd)!.approval_mode).toBe('gated')
    // no iapeer broker hook seeded — hooks.json absent, or (if present for other reasons) not ours
    expect(codexHooksText() ?? '').not.toContain('approval-hook')
    expect(g.surfaces.some(s => s.includes('native modal'))).toBe(true)
    // gated → yolo → gated leaves no codex broker hook either way (byte-identical round-trip: no hook)
    setApprovalMode(cwd, 'yolo', cenv)
    expect(codexHooksText() ?? '').not.toContain('approval-hook')
    setApprovalMode(cwd, 'gated', cenv)
    expect(codexHooksText() ?? '').not.toContain('approval-hook')
  })

  test('a prior (pre-reframe) codex broker hook is REMOVED when re-toggling gated (clean migration)', () => {
    seedPeer(['codex'])
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    // simulate what a pre-reframe gated toggle left: OUR approval-hook group in hooks.json
    writeFileSync(
      codexHooksJsonPath(cwd),
      `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: '/x/iapeer approval-hook' }] }] } }, null, 2)}\n`,
    )
    setApprovalMode(cwd, 'gated', codexEnvFor())
    expect(codexHooksText() ?? '').not.toContain('approval-hook') // our stale hook is gone
  })

  test('a FOREIGN codex hook survives a gated toggle (only our block is touched)', () => {
    seedPeer(['codex'])
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    writeFileSync(
      codexHooksJsonPath(cwd),
      `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: '/foreign/thing' }] }] } }, null, 2)}\n`,
    )
    setApprovalMode(cwd, 'gated', codexEnvFor())
    expect(codexHooksText() ?? '').toContain('/foreign/thing')
  })
})
