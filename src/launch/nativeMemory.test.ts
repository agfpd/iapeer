// Native runtime-memory levers — the canonized forms (slot contract §Native-
// память). The HARD requirement pinned here: NO-CLOBBER — both target files
// carry foreign blocks (plugin enables, statusline wrappers) that every lever
// write must preserve byte-meaningfully.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyNativeMemory,
  claudeSettingsPath,
  codexProjectConfigPath,
  codexGlobalConfigPath,
  preTrustCodexCwd,
  removeCodexCwdTrust,
} from './nativeMemory.ts'

const dirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-natmem-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('claude lever (settings.json merge)', () => {
  test('absent file → created with ONLY the lever key', () => {
    const cwd = mkTmp()
    const [o] = applyNativeMemory(cwd, ['claude'], 'off')
    expect(o?.state).toBe('written')
    expect(JSON.parse(readFileSync(claudeSettingsPath(cwd), 'utf8'))).toEqual({ autoMemoryEnabled: false })
  })

  test('NO-CLOBBER: foreign keys (plugins, statusline) survive off AND on', () => {
    const cwd = mkTmp()
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    const foreign = { enabledPlugins: { 'iapeer-memory@agfpd': true }, statusLine: { type: 'command', command: 'x' } }
    writeFileSync(claudeSettingsPath(cwd), JSON.stringify(foreign))
    applyNativeMemory(cwd, ['claude'], 'off')
    const afterOff = JSON.parse(readFileSync(claudeSettingsPath(cwd), 'utf8'))
    expect(afterOff).toEqual({ ...foreign, autoMemoryEnabled: false })
    const [on] = applyNativeMemory(cwd, ['claude'], 'on')
    expect(on?.state).toBe('written')
    expect(JSON.parse(readFileSync(claudeSettingsPath(cwd), 'utf8'))).toEqual(foreign) // key REMOVED, default restored
  })

  test('idempotent: already-false → already; on with no key → already', () => {
    const cwd = mkTmp()
    applyNativeMemory(cwd, ['claude'], 'off')
    expect(applyNativeMemory(cwd, ['claude'], 'off')[0]?.state).toBe('already')
    applyNativeMemory(cwd, ['claude'], 'on')
    expect(applyNativeMemory(cwd, ['claude'], 'on')[0]?.state).toBe('already')
  })

  test('non-object settings.json → failed (refuses to clobber), file untouched', () => {
    const cwd = mkTmp()
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(claudeSettingsPath(cwd), '"just a string"')
    const [o] = applyNativeMemory(cwd, ['claude'], 'off')
    expect(o?.state).toBe('failed')
    expect(readFileSync(claudeSettingsPath(cwd), 'utf8')).toBe('"just a string"')
  })
})

describe('codex lever (config.toml [features] merge)', () => {
  test('absent file → [features] section with the lever line', () => {
    const cwd = mkTmp()
    const [o] = applyNativeMemory(cwd, ['codex'], 'off')
    expect(o?.state).toBe('written')
    expect(readFileSync(codexProjectConfigPath(cwd), 'utf8')).toBe('[features]\nmemories = false\n')
  })

  test('NO-CLOBBER: plugin blocks survive; [features] appended after them (fleet-file shape)', () => {
    const cwd = mkTmp()
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    const fleet = '[plugins."Inter-Agent-Protocol@agfpd"]\nenabled = true\n\n[plugins."iapeer-memory@agfpd"]\nenabled = true\n'
    writeFileSync(codexProjectConfigPath(cwd), fleet)
    applyNativeMemory(cwd, ['codex'], 'off')
    const text = readFileSync(codexProjectConfigPath(cwd), 'utf8')
    expect(text).toContain('[plugins."Inter-Agent-Protocol@agfpd"]\nenabled = true')
    expect(text).toContain('[plugins."iapeer-memory@agfpd"]\nenabled = true')
    expect(text).toContain('[features]\nmemories = false')
  })

  test('existing [features] WITHOUT memories (followed by another section) → inserted INSIDE the section', () => {
    const cwd = mkTmp()
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    writeFileSync(codexProjectConfigPath(cwd), '[features]\nother = true\n\n[plugins."X@y"]\nenabled = true\n')
    applyNativeMemory(cwd, ['codex'], 'off')
    const text = readFileSync(codexProjectConfigPath(cwd), 'utf8')
    // the lever line lands in [features], NOT in [plugins."X@y"]
    expect(text.indexOf('memories = false')).toBeLessThan(text.indexOf('[plugins."X@y"]'))
    expect(text).toContain('other = true')
  })

  test('memories = true → replaced with false; already false → already', () => {
    const cwd = mkTmp()
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    writeFileSync(codexProjectConfigPath(cwd), '[features]\nmemories = true\n')
    expect(applyNativeMemory(cwd, ['codex'], 'off')[0]?.state).toBe('written')
    expect(readFileSync(codexProjectConfigPath(cwd), 'utf8')).toContain('memories = false')
    expect(applyNativeMemory(cwd, ['codex'], 'off')[0]?.state).toBe('already')
  })

  test('on → the memories line is REMOVED (default restored), section + foreign lines kept', () => {
    const cwd = mkTmp()
    mkdirSync(join(cwd, '.codex'), { recursive: true })
    writeFileSync(codexProjectConfigPath(cwd), '[features]\nmemories = false\nother = true\n')
    const [o] = applyNativeMemory(cwd, ['codex'], 'on')
    expect(o?.state).toBe('written')
    const text = readFileSync(codexProjectConfigPath(cwd), 'utf8')
    expect(text).not.toContain('memories')
    expect(text).toContain('other = true')
    expect(applyNativeMemory(cwd, ['codex'], 'on')[0]?.state).toBe('already')
  })
})

describe('applyNativeMemory runtime dispatch', () => {
  test('both runtimes → both levers; router-only runtimes → no outcomes', () => {
    const cwd = mkTmp()
    const both = applyNativeMemory(cwd, ['claude', 'codex'], 'off')
    expect(both.map(o => o.runtime).sort()).toEqual(['claude', 'codex'])
    expect(applyNativeMemory(mkTmp(), ['telegram', 'notifier'], 'off')).toEqual([])
  })
})

describe('preTrustCodexCwd (birth-time trust, codex global config)', () => {
  test('codexGlobalConfigPath honors $CODEX_HOME first (same override set as init codexConfigPath — sandbox seam, live-caught by D4 11.06)', () => {
    expect(codexGlobalConfigPath({ CODEX_HOME: '/sandbox/codex', HOME: '/real/home' } as NodeJS.ProcessEnv)).toBe(
      '/sandbox/codex/config.toml',
    )
    expect(codexGlobalConfigPath({ HOME: '/real/home' } as NodeJS.ProcessEnv)).toBe('/real/home/.codex/config.toml')
  })

  test('appends a [projects] block once; NO-CLOBBER of existing content; idempotent', () => {
    const home = mkTmp()
    const env = { HOME: home } as NodeJS.ProcessEnv
    mkdirSync(join(home, '.codex'), { recursive: true })
    const existing = '[projects."/already/trusted"]\ntrust_level = "trusted"\n'
    writeFileSync(codexGlobalConfigPath(env), existing)
    const first = preTrustCodexCwd('/peers/newborn', env)
    expect(first.state).toBe('written')
    const text = readFileSync(codexGlobalConfigPath(env), 'utf8')
    expect(text).toContain(existing.trim())
    expect(text).toContain('[projects."/peers/newborn"]\ntrust_level = "trusted"')
    expect(preTrustCodexCwd('/peers/newborn', env).state).toBe('already')
  })

  test('removeCodexCwdTrust: drops EXACTLY the peer cwd section (header+body), keeps neighbors; idempotent; handles deleted cwd via literal match', () => {
    const home = mkTmp()
    const env = { HOME: home } as NodeJS.ProcessEnv
    mkdirSync(join(home, '.codex'), { recursive: true })
    const cfg =
      '[mcp_servers.iapeer]\nurl = "http://x"\n\n' +
      '[projects."/keep/me"]\ntrust_level = "trusted"\n\n' +
      '[projects."/peers/doomed"]\ntrust_level = "trusted"\n\n' +
      '[features]\nmemories = false\n'
    writeFileSync(codexGlobalConfigPath(env), cfg)
    // cwd "/peers/doomed" does not exist on disk → realpath fails → literal match
    const first = removeCodexCwdTrust('/peers/doomed', env)
    expect(first.state).toBe('written')
    const text = readFileSync(codexGlobalConfigPath(env), 'utf8')
    expect(text).not.toContain('/peers/doomed')
    expect(text).toContain('[projects."/keep/me"]\ntrust_level = "trusted"') // neighbor intact
    expect(text).toContain('[mcp_servers.iapeer]') // foreign sections intact
    expect(text).toContain('[features]\nmemories = false')
    expect(removeCodexCwdTrust('/peers/doomed', env).state).toBe('already') // idempotent
    expect(removeCodexCwdTrust('/never/was', env).state).toBe('already') // absent entry → no-op
  })

  test('removeCodexCwdTrust matches the RESOLVED path of a live symlinked cwd (writer stores realpath)', () => {
    const home = mkTmp()
    const env = { HOME: home } as NodeJS.ProcessEnv
    mkdirSync(join(home, '.codex'), { recursive: true })
    const cwd = mkTmp() // /var/folders/... on macOS — realpath differs from literal /tmp form
    // write the entry the way preTrustCodexCwd does (by realpath)
    preTrustCodexCwd(cwd, env)
    expect(readFileSync(codexGlobalConfigPath(env), 'utf8')).toContain('[projects."')
    // remove by the LITERAL cwd — must hit the resolved-form entry
    expect(removeCodexCwdTrust(cwd, env).state).toBe('written')
    expect(readFileSync(codexGlobalConfigPath(env), 'utf8')).not.toContain('trust_level')
  })

  test('absent global config → created with just the block', () => {
    const home = mkTmp()
    const env = { HOME: home } as NodeJS.ProcessEnv
    expect(preTrustCodexCwd('/peers/first', env).state).toBe('written')
    expect(readFileSync(codexGlobalConfigPath(env), 'utf8')).toBe('[projects."/peers/first"]\ntrust_level = "trusted"\n')
  })
})
