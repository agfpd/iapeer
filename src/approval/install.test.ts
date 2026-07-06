import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CLAUDE_APPROVAL_MATCHER,
  IAPEER_MCP_ALLOW,
  installClaudeApproval,
  removeClaudeApproval,
  setApprovalMode,
} from './install.ts'
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
  test('install seeds the PreToolUse hook + MCP allow-rule; remove restores byte-identical bytes', () => {
    // a pre-existing settings.json with foreign content (as ensureClaudeProjectSettings leaves)
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(claudeSettingsPath(cwd), `${JSON.stringify({ enableAllProjectMcpServers: true, tui: 'default' }, null, 2)}\n`)
    const pristine = readFileSync(claudeSettingsPath(cwd), 'utf8')

    installClaudeApproval(cwd, env)
    const s = readSettings()
    const group = (s.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).PreToolUse[0]!
    expect(group.matcher).toBe(CLAUDE_APPROVAL_MATCHER)
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
    expect((s.hooks as { PreToolUse: unknown[] }).PreToolUse).toHaveLength(2) // foreign + ours
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
})
