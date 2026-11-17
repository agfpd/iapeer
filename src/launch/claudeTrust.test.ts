import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeTrustDirs, ensureClaudeTrust } from './claudeTrust.ts'
import { claudeAdapter } from './adapters/claude.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'iapeer-ctrust-')); dirs.push(d); return d }
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

// The verbatim 2.1.326 modals (live pane captures, 2026-11-17).
const ADD_DIR_MODAL = (cursorOnYes: boolean) => [
  ' Adding a new directory:', ' /',
  " This session hasn't worked here before. Is this a directory you created or one you trust?",
  " Claude Code'll be able to read, edit, and execute files here. Your answer holds for this session.",
  ' Security guide', '',
  cursorOnYes ? '   No, exit' : ' ❯ No, exit',
  cursorOnYes ? ' ❯ Yes, add it' : '   Yes, add it', '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

describe('claudeTrustDirs', () => {
  test('cwd + every --add-dir value (variadic and = form)', () => {
    expect(claudeTrustDirs(['claude', '--add-dir', '/', '/x', '--foo', '--add-dir=/y'], '/c')).toEqual(['/c', '/', '/x', '/y'])
  })
  test('the real claude argv seeds `/`', () => {
    const argv = claudeAdapter.buildArgv({ personality: 'p', runtime: 'claude', cwd: '/c', identity: 'claude-p', socketPath: '/s' }, { claudeBin: 'claude', codexBin: 'codex' })
    expect(claudeTrustDirs(argv, '/c')).toEqual(['/c', '/'])
  })
})

describe('ensureClaudeTrust', () => {
  test('seeds missing keys, keeps every other field and the mode; second call is read-only', () => {
    const cfgDir = tmp(); const cwd = tmp(); const path = join(cfgDir, '.claude.json')
    writeFileSync(path, JSON.stringify({ numStartups: 7, projects: { [cwd]: { allowedTools: ['x'] } } }), { mode: 0o600 })
    const r = ensureClaudeTrust([cwd, '/'], cwd, { CLAUDE_CONFIG_DIR: cfgDir })
    expect(r.state).toBe('written')
    const c = read(path)
    expect(c.numStartups).toBe(7)
    expect(c.projects['/'].hasTrustDialogAccepted).toBe(true)
    expect(c.projects[cwd]).toEqual({ allowedTools: ['x'], hasTrustDialogAccepted: true })
    expect(c.projects[realpathSync(cwd)].hasTrustDialogAccepted).toBe(true) // /var → /private/var spelling
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const mtime = statSync(path).mtimeMs
    expect(ensureClaudeTrust([cwd, '/'], cwd, { CLAUDE_CONFIG_DIR: cfgDir }).state).toBe('already')
    expect(statSync(path).mtimeMs).toBe(mtime)
  })
  test('missing config file → created with just the trust records', () => {
    const cfgDir = join(tmp(), 'nested'); const cwd = tmp()
    expect(ensureClaudeTrust([cwd, '/'], cwd, { CLAUDE_CONFIG_DIR: cfgDir }).state).toBe('written')
    expect(read(join(cfgDir, '.claude.json')).projects['/'].hasTrustDialogAccepted).toBe(true)
  })
  test('unparsable config is never overwritten (fail-open)', () => {
    const cfgDir = tmp(); const path = join(cfgDir, '.claude.json')
    writeFileSync(path, '{"half": ')
    expect(ensureClaudeTrust(['/'], '/', { CLAUDE_CONFIG_DIR: cfgDir }).state).toBe('failed')
    expect(readFileSync(path, 'utf8')).toBe('{"half": ')
  })
  test('HOME fallback resolves <HOME>/.claude.json', () => {
    const home = tmp()
    expect(ensureClaudeTrust(['/'], '/', { HOME: home }).path).toBe(join(home, '.claude.json'))
  })
})

describe('claude adapter — trust', () => {
  test('prepareLaunch seeds cwd and / and reports it as a launch-warning', () => {
    const cfgDir = tmp(); const cwd = tmp(); mkdirSync(cwd, { recursive: true })
    const p = claudeAdapter.prepareLaunch!({ personality: 'p', runtime: 'claude', cwd, identity: 'claude-p', socketPath: '/s' },
      { CLAUDE_CONFIG_DIR: cfgDir }, { claudeBin: 'claude', codexBin: 'codex', env: { CLAUDE_CONFIG_DIR: cfgDir } })
    expect(p.env).toEqual({})
    expect(p.warnings?.[0]).toContain('claude trust seeded')
    const c = read(join(cfgDir, '.claude.json'))
    expect(c.projects['/'].hasTrustDialogAccepted).toBe(true)
    expect(c.projects[cwd].hasTrustDialogAccepted).toBe(true)
  })
  test('2.1.326 trust modal: Down while on "No, exit", Enter only on "Yes, add it"; never an unknown modal', () => {
    expect(claudeAdapter.bootDialogKeys(ADD_DIR_MODAL(false))).toEqual(['Down'])
    expect(claudeAdapter.bootDialogKeys(ADD_DIR_MODAL(true))).toEqual(['Enter'])
    expect(claudeAdapter.unknownBlockingModal!(ADD_DIR_MODAL(false))).toBeNull()
    expect(claudeAdapter.isInputReady(ADD_DIR_MODAL(false))).toBe(false)
  })
})
