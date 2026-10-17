import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capabilitiesDir, listCapabilities, parseCapabilityDeclaration } from './index.ts'
import { capabilityCli } from './cli.ts'
import { upsertPeer } from '../registry/index.ts'

let root: string
let laDir: string
let callLog: string
let pluginBin: string
function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, IAPEER_ROOT: root, IAPEER_LAUNCHAGENTS_DIR: laDir, IAPEER_SOCK_DIR: join(root, 'socks'), CODEX_HOME: join(root, 'codex-home') }
  delete e.PEER_PERSONALITY
  delete e.PEER_IDENTITY
  delete e.PEER_RUNTIME
  return e
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-cap-root-'))
  laDir = mkdtempSync(join(tmpdir(), 'iapeer-cap-la-'))
  callLog = join(root, 'calls.log')
  pluginBin = join(root, 'fake-plugin')
  // The fake plugin records its argv, one call per line; FAIL_FOR=<personality> makes it exit 3.
  writeFileSync(pluginBin, `#!/bin/sh\necho "$*" >> "${callLog}"\ncase "$*" in *"--personality $FAIL_FOR "*) echo boom >&2; exit 3;; esac\nexit 0\n`, { mode: 0o755 })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(laDir, { recursive: true, force: true })
})
const calls = () => (existsSync(callLog) ? readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean) : [])
const decl = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  capability: 'statusline',
  version: '1.0.0',
  runtimes: ['claude', 'codex'],
  provision: { command: pluginBin, args: ['provision-peer', '--personality', '{personality}', '--runtime', '{runtime}', '--cwd', '{cwd}', '--occasion', '{occasion}'] },
  unprovision: { command: pluginBin, args: ['unprovision-peer', '--personality', '{personality}', '--runtime', '{runtime}', '--cwd', '{cwd}', '--occasion', '{occasion}'] },
  ...over,
})
function writeDecl(d: unknown): string {
  const f = join(root, 'decl.json')
  writeFileSync(f, JSON.stringify(d))
  return f
}
const sink = () => {
  const lines: string[] = []
  return { lines, fn: (s: string) => void lines.push(s) }
}

describe('capability declaration validation', () => {
  test('relative command, missing {personality}, bad schema and bad name are refused', () => {
    expect(() => parseCapabilityDeclaration(decl({ provision: { command: 'fake', args: ['{personality}'] } }))).toThrow('absolute')
    expect(() => parseCapabilityDeclaration(decl({ unprovision: { command: pluginBin, args: ['--cwd', '{cwd}'] } }))).toThrow('{personality}')
    expect(() => parseCapabilityDeclaration(decl({ schema: 2 }))).toThrow('schema')
    expect(() => parseCapabilityDeclaration(decl({ capability: '../x' }))).toThrow('name')
    expect(() => parseCapabilityDeclaration(decl({ runtimes: [] }))).toThrow('runtimes')
  })
  test('an invalid file in the directory is REPORTED, never silently skipped', () => {
    mkdirSync(capabilitiesDir({ env: env() }), { recursive: true })
    writeFileSync(join(capabilitiesDir({ env: env() }), 'broken.json'), '{"schema":1}')
    const l = listCapabilities({ env: env() })
    expect(l.declarations).toEqual([])
    expect(l.invalid.length).toBe(1)
  })
})

describe('capability lifecycle joints', () => {
  test('register sweeps existing peers per applicable agent endpoint; channels and undeclared runtimes are skipped', async () => {
    const e = env()
    await upsertPeer({ personality: 'alpha', runtime: 'claude', cwd: join(root, 'alpha'), intelligence: 'artificial' }, { rootDir: root })
    await upsertPeer({ personality: 'owner', runtime: 'telegram', cwd: join(root, 'owner'), intelligence: 'natural' }, { rootDir: root })
    const o = sink()
    expect(await capabilityCli(['register', writeDecl(decl({ runtimes: ['claude'] }))], e, o.fn, o.fn)).toBe(0)
    expect(calls()).toEqual([`provision-peer --personality alpha --runtime claude --cwd ${join(root, 'alpha')} --occasion sweep-on`])
  })

  test('birth (initPeer → provisionPeer) provisions every declared agent endpoint', async () => {
    const e = env()
    const o = sink()
    expect(await capabilityCli(['register', writeDecl(decl())], e, o.fn, o.fn)).toBe(0)
    const cwd = join(root, 'peers', 'beta')
    mkdirSync(cwd, { recursive: true })
    const { initPeer } = await import('../init/index.ts')
    await initPeer({ cwd, runtime: 'claude', env: e })
    const born = calls().filter(c => c.includes('--occasion birth'))
    expect(born.some(c => c.startsWith('provision-peer --personality beta --runtime claude'))).toBe(true)
  })

  test('remove unprovisions; unregister unwinds every peer then drops the declaration', async () => {
    const e = env()
    const o = sink()
    await capabilityCli(['register', writeDecl(decl())], e, o.fn, o.fn)
    await upsertPeer({ personality: 'gamma', runtime: 'claude', cwd: join(root, 'gamma'), intelligence: 'artificial' }, { rootDir: root })
    await upsertPeer({ personality: 'delta', runtime: 'codex', cwd: join(root, 'delta'), intelligence: 'artificial' }, { rootDir: root })
    const { removePeerCli } = await import('../cli/index.ts')
    const r = await removePeerCli('gamma', { env: e })
    expect(r.action).toBe('removed')
    expect(calls()).toContain(`unprovision-peer --personality gamma --runtime claude --cwd ${join(root, 'gamma')} --occasion remove`)
    expect(await capabilityCli(['unregister', 'statusline'], e, o.fn, o.fn)).toBe(0)
    expect(calls()).toContain(`unprovision-peer --personality delta --runtime codex --cwd ${join(root, 'delta')} --occasion off-all`)
    expect(listCapabilities({ env: e }).declarations).toEqual([])
  })

  test('a failing plugin is LOUD (exit 1, per-peer line) and sync is the repair', async () => {
    const e: NodeJS.ProcessEnv = { ...env(), FAIL_FOR: 'eps' }
    await upsertPeer({ personality: 'eps', runtime: 'claude', cwd: join(root, 'eps'), intelligence: 'artificial' }, { rootDir: root })
    const o = sink()
    expect(await capabilityCli(['register', writeDecl(decl())], e, o.fn, o.fn)).toBe(1)
    expect(o.lines.join('')).toContain('eps (claude): failed — boom')
    delete e.FAIL_FOR
    expect(await capabilityCli(['sync', 'statusline'], e, o.fn, o.fn)).toBe(0)
  })
})
