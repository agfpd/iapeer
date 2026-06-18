// enable — the PURE fleet-safety + idempotency logic: parse `claude plugin list
// --json`, match the entry for THIS peer's projectPath (realpath), and detect a
// plugin's `setup` from iapeer.json (SIMPLE vs СЛОЖНЫЙ). The spawn/install paths are
// live-verified on a throwaway test-peer (project-scope is keyed by projectPath, so a
// test install never touches a live peer's entry).

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findPeerScopedEntry, parseCodexPluginStatus, parseInstalledPlugins, readSetupDescriptor } from './index.ts'

// a realistic `claude plugin list --json` array (the live shape: id/scope/enabled/
// projectPath/installPath), two live peers + the same plugin user-scope.
const LIST = JSON.stringify([
  { id: 'Inter-Agent-Protocol@agfpd', scope: 'project', enabled: true, projectPath: '/Users/x/agents/linus', installPath: '/c/iap/0.7.11' },
  { id: 'peer-voice@agfpd', scope: 'project', enabled: true, projectPath: '/Users/x/agents/boris', installPath: '/c/pv/0.1.8' },
  { id: 'peer-voice@agfpd', scope: 'user', enabled: false, installPath: '/c/pv/0.1.8' },
])

describe('parseInstalledPlugins', () => {
  test('parses the flat array into typed entries; tolerates junk', () => {
    const e = parseInstalledPlugins(LIST)
    expect(e.length).toBe(3)
    expect(e[0]).toMatchObject({ id: 'Inter-Agent-Protocol@agfpd', scope: 'project', enabled: true, projectPath: '/Users/x/agents/linus' })
    expect(parseInstalledPlugins('not json')).toEqual([])
    expect(parseInstalledPlugins('{"not":"array"}')).toEqual([])
    expect(parseInstalledPlugins('[1, null, {"no":"id"}]')).toEqual([]) // entries without a string id are dropped
  })
})

describe('findPeerScopedEntry (per-peer, fleet-safe)', () => {
  test('matches ONLY the project-scope entry for this peer cwd', () => {
    const e = parseInstalledPlugins(LIST)
    expect(findPeerScopedEntry(e, 'peer-voice', 'agfpd', '/Users/x/agents/boris')?.enabled).toBe(true)
    // a DIFFERENT peer cwd → no match (never reports another peer's install as ours)
    expect(findPeerScopedEntry(e, 'peer-voice', 'agfpd', '/Users/x/agents/darwin')).toBeNull()
    // user-scope is not a per-peer match
    expect(findPeerScopedEntry(e, 'peer-voice', 'agfpd', '/Users/x/agents/boris')?.scope).toBe('project')
  })
  test('absent plugin for this peer → null (drives install, not false-skip)', () => {
    const e = parseInstalledPlugins(LIST)
    expect(findPeerScopedEntry(e, 'iapeer-memory', 'agfpd', '/Users/x/agents/linus')).toBeNull()
  })
})

// the real `codex plugin list --json` shape (codex-cli 0.138, live-captured fields)
const CODEX_LIST = JSON.stringify({
  installed: [
    { pluginId: 'peer-voice@agfpd', installed: true, enabled: true },
    { pluginId: 'iapeer-memory@agfpd', installed: true, enabled: false },
    { pluginId: 'spawned-peer@agfpd', installed: false, enabled: false }, // marketplace-known, not installed
  ],
})

describe('parseCodexPluginStatus', () => {
  test('reads the installed/enabled flags per plugin id', () => {
    expect(parseCodexPluginStatus(CODEX_LIST, 'peer-voice@agfpd')).toBe('enabled')
    expect(parseCodexPluginStatus(CODEX_LIST, 'spawned-peer@agfpd')).toBe('absent') // installed:false
    expect(parseCodexPluginStatus(CODEX_LIST, 'iapeer-memory@agfpd')).toBe('disabled') // installed, not enabled
    expect(parseCodexPluginStatus(CODEX_LIST, 'totp-presence@agfpd')).toBe('absent') // not in array
    expect(parseCodexPluginStatus('', 'x@agfpd')).toBe('absent') // empty
    expect(parseCodexPluginStatus('not json', 'x@agfpd')).toBe('absent') // malformed → fail-safe
    expect(parseCodexPluginStatus('{"no":"installed-array"}', 'x@agfpd')).toBe('absent')
  })
})

describe('readSetupDescriptor (SIMPLE vs СЛОЖНЫЙ)', () => {
  test('no installPath / no iapeer.json → null (SIMPLE: install+enable only)', () => {
    expect(readSetupDescriptor(undefined)).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'iapeer-enable-simple-'))
    try {
      expect(readSetupDescriptor(dir)).toBeNull() // peer-voice-like: no manifest
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('iapeer.json with setup string → returns it; with {command,args} → object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iapeer-enable-complex-'))
    try {
      writeFileSync(join(dir, 'iapeer.json'), JSON.stringify({ setup: 'bin/setup' }))
      expect(readSetupDescriptor(dir)).toBe('bin/setup')
      writeFileSync(join(dir, 'iapeer.json'), JSON.stringify({ setup: { command: 'node', args: ['setup.js'] } }))
      expect(readSetupDescriptor(dir)).toEqual({ command: 'node', args: ['setup.js'] })
      // requires present but NO setup → still SIMPLE (iapeer does not resolve requires)
      writeFileSync(join(dir, 'iapeer.json'), JSON.stringify({ requires: ['telegram'] }))
      expect(readSetupDescriptor(dir)).toBeNull()
      // malformed manifest → treated as SIMPLE, never throws
      writeFileSync(join(dir, 'iapeer.json'), '{ broken')
      expect(readSetupDescriptor(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
