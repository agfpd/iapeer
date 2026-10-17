import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureOpencodePluginDependency, opencodeConfigDirs, pluginDependencySatisfied } from './deps.ts'

let root: string
let env: NodeJS.ProcessEnv
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ocdeps-'))
  env = { HOME: join(root, 'home') }
  mkdirSync(env.HOME!, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Fake npm: writes exactly what a real `npm install --save` leaves behind. */
function fakeInstall(dir: string, spec: string) {
  const name = spec.slice(0, spec.lastIndexOf('@'))
  mkdirSync(join(dir, 'node_modules', name), { recursive: true })
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: { '': { dependencies: { [name]: spec.slice(spec.lastIndexOf('@') + 1) } } } }))
}

describe('opencode plugin dependency preinstall', () => {
  test('config dirs follow native order: global, cwd-up .opencode, ~/.opencode', () => {
    const cwd = join(env.HOME!, 'w', 'p')
    mkdirSync(join(cwd, '.opencode'), { recursive: true })
    mkdirSync(join(env.HOME!, 'w', '.opencode'), { recursive: true })
    mkdirSync(join(env.HOME!, '.opencode'), { recursive: true })
    expect(opencodeConfigDirs(cwd, env)).toEqual([
      join(env.HOME!, '.config', 'opencode'),
      join(cwd, '.opencode'),
      join(env.HOME!, 'w', '.opencode'),
      join(env.HOME!, '.opencode'),
    ])
    expect(opencodeConfigDirs(cwd, { ...env, XDG_CONFIG_HOME: '/x' })[0]).toBe('/x/opencode')
    expect(opencodeConfigDirs(cwd, { ...env, OPENCODE_CONFIG_DIR: '/y' })[0]).toBe('/y')
  })

  test('satisfied only with node_modules AND the name in the lock root (native no-op condition)', () => {
    const d = join(root, 'd')
    mkdirSync(join(d, 'node_modules'), { recursive: true })
    expect(pluginDependencySatisfied(d)).toBe(false)
    fakeInstall(d, '@opencode-ai/plugin@1.19.3')
    expect(pluginDependencySatisfied(d)).toBe(true)
  })

  test('installs pinned to the binary version, once; present dirs are left alone', () => {
    const calls: string[] = []
    const deps = { version: () => '1.19.3', npmInstall: (dir: string, spec: string) => (calls.push(spec), fakeInstall(dir, spec)) }
    const first = ensureOpencodePluginDependency(env.HOME!, env, deps)
    expect(first.map(o => o.state)).toEqual(['installed'])
    expect(calls).toEqual(['@opencode-ai/plugin@1.19.3'])
    expect(ensureOpencodePluginDependency(env.HOME!, env, deps).map(o => o.state)).toEqual(['present'])
    expect(calls.length).toBe(1)
  })

  test('npm failure / unverifiable result / bad version are failures, never silent', () => {
    expect(ensureOpencodePluginDependency(env.HOME!, env, { version: () => '1.19.3', npmInstall: () => { throw new Error('ETIMEDOUT\nmore') } })[0]).toMatchObject({ state: 'failed', detail: 'ETIMEDOUT' })
    expect(ensureOpencodePluginDependency(env.HOME!, env, { version: () => '1.19.3', npmInstall: () => {} })[0]!.state).toBe('failed')
    expect(ensureOpencodePluginDependency(env.HOME!, env, { version: () => 'garbage', npmInstall: fakeInstall })[0]!.state).toBe('failed')
  })

  test('sandbox guard: never writes into the real HOME under IAPEER_TEST_SANDBOX', () => {
    expect(() => ensureOpencodePluginDependency('/tmp', { IAPEER_TEST_SANDBOX: '1', HOME: homedir() }, { version: () => '1.19.3', npmInstall: () => {} })).toThrow(/real HOME/)
  })

  test('read-only dir is skipped like native', () => {
    const ro = join(env.HOME!, '.opencode')
    mkdirSync(ro)
    chmodSync(ro, 0o500)
    try {
      const out = ensureOpencodePluginDependency(env.HOME!, env, { version: () => '1.19.3', npmInstall: fakeInstall })
      expect(out.find(o => o.dir === ro)!.state).toBe('skipped-readonly')
    } finally {
      chmodSync(ro, 0o700)
    }
  })
})
