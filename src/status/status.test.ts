// Memory slot — the DECLARATIVE provider slot (docs/Слот памяти — контракт
// memory provider.md): the core only READS the root declaration; absent /
// unreadable / invalid → EMPTY slot (bare core, valid state, never an error).
// Plus the host-status assembly + rendering (memory: <provider> | none).

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  formatHostStatus,
  heartbeatAgeSecs,
  hostStatus,
  memoryProviderPath,
  readMemoryProvider,
  readVoiceProvider,
  voiceProviderPath,
  type HostStatus,
  type MemoryProvider,
} from './index.ts'

const dirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-slot-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function envFor(root: string): NodeJS.ProcessEnv {
  return { IAPEER_ROOT: root } as NodeJS.ProcessEnv
}

const VALID = {
  provider: 'iapeer-memory',
  package: '@agfpd/iapeer-memory',
  version: '0.1.0',
  registeredAt: '2026-06-10T00:00:00Z',
}

describe('readMemoryProvider (slot declaration, fail-open)', () => {
  test('absent file → null (EMPTY slot — valid bare state)', () => {
    expect(readMemoryProvider(envFor(mkTmp()))).toBeNull()
  })

  test('valid declaration → parsed provider; heartbeat optional', () => {
    const root = mkTmp()
    writeFileSync(memoryProviderPath(envFor(root)), JSON.stringify({ ...VALID, heartbeat: '/tmp/hb' }))
    const p = readMemoryProvider(envFor(root))
    expect(p).toMatchObject({ ...VALID, heartbeat: '/tmp/hb' })
    // without heartbeat — field absent, not empty-string
    writeFileSync(memoryProviderPath(envFor(root)), JSON.stringify(VALID))
    expect(readMemoryProvider(envFor(root))?.heartbeat).toBeUndefined()
  })

  test('garbage / wrong shape / missing required fields → null, NEVER throws', () => {
    const root = mkTmp()
    const env = envFor(root)
    for (const bad of ['NOT JSON {{{', '[]', '{}', JSON.stringify({ provider: 'x' }), JSON.stringify({ ...VALID, version: 42 })]) {
      writeFileSync(memoryProviderPath(env), bad)
      expect(readMemoryProvider(env)).toBeNull()
    }
  })

  test('LEGACY v1.1 plugin block (any shape) → ignored as unknown noise; the declaration itself stays valid (form removed 11.06, ADR-017)', () => {
    const root = mkTmp()
    const env = envFor(root)
    for (const legacy of [
      { name: 'iapeer-memory', marketplace: 'agfpd', marketplaceRef: 'agfpd/agfpd-marketplace' }, // a complete v1.1 block
      { name: 'x', marketplace: 'agfpd' },
      'iapeer-memory',
      ['x'],
    ]) {
      writeFileSync(memoryProviderPath(env), JSON.stringify({ ...VALID, plugin: legacy }))
      const p = readMemoryProvider(env)
      expect(p).not.toBeNull()
      expect((p as Record<string, unknown> | null)?.plugin).toBeUndefined() // not parsed at all
    }
  })

  test('v1.2 provision/unprovision blocks: parsed when valid; relative command or bad args = absent (fail-open)', () => {
    const root = mkTmp()
    const env = envFor(root)
    const provision = { command: '/usr/local/bin/iapeer-memory', args: ['provision-peer', '--cwd', '{cwd}'] }
    const unprovision = { command: '/usr/local/bin/iapeer-memory', args: ['unprovision-peer'] }
    writeFileSync(memoryProviderPath(env), JSON.stringify({ ...VALID, provision, unprovision }))
    const p = readMemoryProvider(env)
    expect(p?.provision).toEqual(provision)
    expect(p?.unprovision).toEqual(unprovision)
    // empty args array is VALID (command alone)
    writeFileSync(memoryProviderPath(env), JSON.stringify({ ...VALID, provision: { command: '/x/y', args: [] } }))
    expect(readMemoryProvider(env)?.provision).toEqual({ command: '/x/y', args: [] })
    // invalid shapes → block absent, declaration itself stays valid
    for (const bad of [
      { command: 'iapeer-memory', args: [] }, // RELATIVE command (launchd minimal PATH) — contract-invalid
      { command: '/x/y' }, // args missing
      { command: '/x/y', args: ['ok', 42] }, // non-string arg
      { args: ['provision-peer'] }, // command missing
      'provision-me', // not an object
    ]) {
      writeFileSync(memoryProviderPath(env), JSON.stringify({ ...VALID, provision: bad }))
      const r = readMemoryProvider(env)
      expect(r).not.toBeNull()
      expect(r?.provision).toBeUndefined()
    }
  })
})

const VALID_VOICE = {
  provider: 'voice-connect',
  package: '@agfpd/voice-connect',
  version: '0.1.11',
  registeredAt: '2026-06-20T00:00:00Z',
}

describe('readVoiceProvider (voice slot — same declarative contract, no provision)', () => {
  test('absent file → null (EMPTY slot — valid bare state)', () => {
    expect(readVoiceProvider(envFor(mkTmp()))).toBeNull()
  })

  test('valid declaration → parsed; heartbeat + endpoint optional', () => {
    const root = mkTmp()
    const env = envFor(root)
    writeFileSync(voiceProviderPath(env), JSON.stringify({ ...VALID_VOICE, heartbeat: '/tmp/vhb', endpoint: 'http://127.0.0.1:8088' }))
    expect(readVoiceProvider(env)).toMatchObject({ ...VALID_VOICE, heartbeat: '/tmp/vhb', endpoint: 'http://127.0.0.1:8088' })
    // without optionals — fields absent, not empty-string
    writeFileSync(voiceProviderPath(env), JSON.stringify(VALID_VOICE))
    const p = readVoiceProvider(env)
    expect(p?.heartbeat).toBeUndefined()
    expect(p?.endpoint).toBeUndefined()
  })

  test('self-management extras (label/managed/host/port/routes) → IGNORED; declaration stays valid', () => {
    const root = mkTmp()
    const env = envFor(root)
    writeFileSync(
      voiceProviderPath(env),
      JSON.stringify({ ...VALID_VOICE, label: 'com.voice-connect.http', managed: true, host: '127.0.0.1', port: 8088, routes: { tts: '/v1/audio/speech' } }),
    )
    const p = readVoiceProvider(env) as Record<string, unknown> | null
    expect(p).not.toBeNull()
    expect(p?.routes).toBeUndefined()
    expect(p?.managed).toBeUndefined()
    expect(p?.port).toBeUndefined()
  })

  test('garbage / missing required fields → null, NEVER throws', () => {
    const root = mkTmp()
    const env = envFor(root)
    for (const bad of ['NOT JSON {{{', '[]', '{}', JSON.stringify({ provider: 'x' }), JSON.stringify({ ...VALID_VOICE, version: 42 })]) {
      writeFileSync(voiceProviderPath(env), bad)
      expect(readVoiceProvider(env)).toBeNull()
    }
  })
})

describe('voice slot rendering (formatHostStatus)', () => {
  test('occupied voice slot → "voice: <provider> <version> @ <endpoint>"', async () => {
    const root = mkTmp()
    const env = envFor(root)
    writeFileSync(voiceProviderPath(env), JSON.stringify({ ...VALID_VOICE, endpoint: 'http://127.0.0.1:8088' }))
    const s = await hostStatus({ env, probe: async () => true, fdaProbe: () => null })
    expect(formatHostStatus(s)).toContain('voice: voice-connect 0.1.11 @ http://127.0.0.1:8088')
  })

  test('voice heartbeat declared but file ABSENT → "daemon not running"', () => {
    const s: HostStatus = {
      version: '0.0.0',
      daemon: { healthy: true, url: null, sock: null },
      memory: { provider: null, heartbeatAgeSecs: null },
      voice: { provider: { ...VALID_VOICE, heartbeat: '/nope/vhb' }, heartbeatAgeSecs: null },
      fda: null,
    }
    expect(formatHostStatus(s)).toContain('voice: voice-connect 0.1.11 (daemon not running — no heartbeat file)')
  })
})

describe('heartbeatAgeSecs', () => {
  test('no heartbeat declared → null; declared but absent file → null; present → age', () => {
    const root = mkTmp()
    expect(heartbeatAgeSecs({ ...VALID } as MemoryProvider)).toBeNull()
    const hb = join(root, 'memoryd.heartbeat')
    expect(heartbeatAgeSecs({ ...VALID, heartbeat: hb } as MemoryProvider)).toBeNull() // not running
    writeFileSync(hb, '')
    const old = (Date.now() - 45_000) / 1000
    utimesSync(hb, old, old)
    const age = heartbeatAgeSecs({ ...VALID, heartbeat: hb } as MemoryProvider)
    expect(age).toBeGreaterThanOrEqual(44)
    expect(age).toBeLessThanOrEqual(60)
  })
})

describe('hostStatus + formatHostStatus', () => {
  test('empty slot → memory: none; daemon health from the injected probe', async () => {
    const root = mkTmp()
    const s = await hostStatus({ env: envFor(root), probe: async () => true, fdaProbe: () => null })
    expect(s.daemon.healthy).toBe(true)
    expect(s.memory.provider).toBeNull()
    expect(s.voice.provider).toBeNull()
    expect(formatHostStatus(s)).toContain('memory: none')
    expect(formatHostStatus(s)).toContain('voice: none')
  })

  test('occupied slot + fresh heartbeat → provider line with age', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const hb = join(root, 'memoryd.heartbeat')
    writeFileSync(hb, '')
    writeFileSync(memoryProviderPath(env), JSON.stringify({ ...VALID, heartbeat: hb }))
    const s = await hostStatus({ env, probe: async () => true, fdaProbe: () => null })
    expect(formatHostStatus(s)).toMatch(/memory: iapeer-memory 0\.1\.0 \(heartbeat \d+s ago\)/)
  })

  test('occupied slot, heartbeat declared but file ABSENT → "daemon not running" (graceful-shutdown semantics)', () => {
    const s: HostStatus = {
      version: '0.0.0',
      daemon: { healthy: false, url: null, sock: null },
      memory: {
        provider: { ...VALID, heartbeat: '/nope/hb' } as MemoryProvider,
        heartbeatAgeSecs: null,
      },
      voice: { provider: null, heartbeatAgeSecs: null },
      fda: null,
    }
    const text = formatHostStatus(s)
    expect(text).toContain('memory: iapeer-memory 0.1.0 (daemon not running — no heartbeat file)')
    expect(text).toContain('daemon: NOT healthy')
  })

  test('discovery file addresses surface in the daemon line', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const stateDir = join(root, 'state', 'iapeer')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, 'router.json'), JSON.stringify({ sock: '/x/router.sock', tcp: 'http://127.0.0.1:8765/mcp' }))
    const s = await hostStatus({ env, probe: async () => true, fdaProbe: () => null })
    const text = formatHostStatus(s)
    expect(text).toContain('@ http://127.0.0.1:8765/mcp')
    expect(text).toContain('+ /x/router.sock')
  })
})

describe('FDA detection (iapeer status — fresh-host observability)', () => {
  function base(fda: boolean | null): HostStatus {
    return {
      version: '0.0.0',
      daemon: { healthy: true, url: null, sock: null },
      memory: { provider: null, heartbeatAgeSecs: null },
      voice: { provider: null, heartbeatAgeSecs: null },
      fda,
    }
  }

  test('granted → terse OK line, no instruction', () => {
    const text = formatHostStatus(base(true))
    expect(text).toContain('fda: granted')
    expect(text).not.toContain('NOT granted')
    expect(text).not.toContain('Full Disk Access')
  })

  test('NOT granted → actionable hint with the binary path', () => {
    const text = formatHostStatus(base(false))
    expect(text).toContain('fda: NOT granted')
    expect(text).toContain('Full Disk Access')
    expect(text).toMatch(/iapeer$|iapeer\n/m) // the grant path ends at the binary
  })

  test('undeterminable → explicit unknown, never a false claim', () => {
    const text = formatHostStatus(base(null))
    expect(text).toContain('fda: unknown')
    expect(text).not.toContain('NOT granted')
    expect(text).not.toContain('granted\n') // not the bare "granted" either
  })

  test('hostStatus threads the injected fdaProbe verbatim', async () => {
    const root = mkTmp()
    const s = await hostStatus({ env: envFor(root), probe: async () => true, fdaProbe: () => false })
    expect(s.fda).toBe(false)
    expect(formatHostStatus(s)).toContain('fda: NOT granted')
  })
})
