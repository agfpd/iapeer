import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPeersIndex } from '../registry/index.ts'
import { profileSyncTick, startProfileSync } from './profilesync.ts'

// ─────────────────────────────────────────────────────────────────────────────
// The invariant under test (identity/profileStandard.ts): the local peer-profile.json is
// the SOURCE OF TRUTH, the registry a projection. These tests pin the CONTINUOUS half:
// the daemon sweep that makes a source edit propagate without anyone running a verb.
// Incident anchor (17.07.2026): linus's local profile said default_runtime=claude for
// days, the index said codex, the router kept delivering into a mute codex session.
// ─────────────────────────────────────────────────────────────────────────────

describe('profileSyncTick — the mtime/set gate', () => {
  function seams(paths: string[]): {
    deps: Parameters<typeof profileSyncTick>[0]
    calls: { reindex: number; healed: Array<{ healed: string[]; missing: string[] }>; errors: unknown[] }
    setResult: (r: { healed: string[]; missing: string[] }) => void
  } {
    const calls = { reindex: 0, healed: [] as Array<{ healed: string[]; missing: string[] }>, errors: [] as unknown[] }
    let result = { healed: [] as string[], missing: [] as string[] }
    return {
      deps: {
        listProfilePaths: () => paths,
        reindex: async () => {
          calls.reindex += 1
          return result
        },
        onHealed: r => calls.healed.push(r),
        onError: e => calls.errors.push(e),
      },
      calls,
      setResult: r => {
        result = r
      },
    }
  }

  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iapeer-profilesync-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('the boot tick ALWAYS reconciles once — offline drift heals at startup, not on the next verb', async () => {
    const { deps, calls } = seams([])
    await profileSyncTick(deps, '')
    expect(calls.reindex).toBe(1)
  })

  test('an unchanged gate is stats-only: no reindex, no index rewrite', async () => {
    const p = join(dir, 'peer-profile.json')
    writeFileSync(p, '{}')
    const { deps, calls } = seams([p])
    const gate = await profileSyncTick(deps, '')
    expect(calls.reindex).toBe(1)
    const gate2 = await profileSyncTick(deps, gate)
    expect(gate2).toBe(gate)
    expect(calls.reindex).toBe(1) // steady state: zero writes
  })

  test('a touched profile (mtime advanced) re-triggers the reconcile', async () => {
    const p = join(dir, 'peer-profile.json')
    writeFileSync(p, '{}')
    const { deps, calls } = seams([p])
    const gate = await profileSyncTick(deps, '')
    const later = new Date(Date.now() + 5_000)
    utimesSync(p, later, later) // the owner edited the source of truth
    await profileSyncTick(deps, gate)
    expect(calls.reindex).toBe(2)
  })

  test('a change in the profile SET (new peer / dropped profile) flips the gate', async () => {
    const a = join(dir, 'a.json')
    writeFileSync(a, '{}')
    const paths = [a]
    const { deps, calls } = seams(paths)
    const gate = await profileSyncTick(deps, '')
    const b = join(dir, 'b.json')
    writeFileSync(b, '{}')
    // even with identical mtimes the sorted path-set differs → reconcile
    utimesSync(b, new Date(0), new Date(0))
    paths.push(b)
    await profileSyncTick(deps, gate)
    expect(calls.reindex).toBe(2)
  })

  test('a missing profile path does not throw — it participates via the set only', async () => {
    const { deps, calls } = seams([join(dir, 'never-written.json')])
    await profileSyncTick(deps, '')
    expect(calls.reindex).toBe(1)
    expect(calls.errors).toHaveLength(0)
  })

  test('onHealed fires ONLY when the reconcile changed/flagged something', async () => {
    const p = join(dir, 'peer-profile.json')
    writeFileSync(p, '{}')
    const { deps, calls, setResult } = seams([p])
    const gate = await profileSyncTick(deps, '') // quiet reconcile: healed/missing empty
    expect(calls.healed).toHaveLength(0)
    setResult({ healed: ['linus: default_runtime'], missing: [] })
    const later = new Date(Date.now() + 5_000)
    utimesSync(p, later, later)
    await profileSyncTick(deps, gate)
    expect(calls.healed).toHaveLength(1)
    expect(calls.healed[0]!.healed[0]).toBe('linus: default_runtime')
  })

  test('a reindex throw is REPORTED and the gate is NOT advanced — the next tick retries', async () => {
    const p = join(dir, 'peer-profile.json')
    writeFileSync(p, '{}')
    const calls = { reindex: 0, errors: [] as unknown[] }
    const deps: Parameters<typeof profileSyncTick>[0] = {
      listProfilePaths: () => [p],
      reindex: async () => {
        calls.reindex += 1
        throw new Error('lock contention')
      },
      onError: e => calls.errors.push(e),
    }
    const gate = await profileSyncTick(deps, '')
    expect(gate).toBe('') // unchanged → the same edit is retried
    expect(calls.errors).toHaveLength(1)
    await profileSyncTick(deps, gate)
    expect(calls.reindex).toBe(2)
  })
})

describe('profile-sync end-to-end — the 17.07 incident shape heals without a verb', () => {
  let root: string
  const prevRoot = process.env.IAPEER_ROOT
  let linusCwd: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'iapeer-profilesync-e2e-'))
    process.env.IAPEER_ROOT = root
    linusCwd = join(root, 'peers', 'linus')
    mkdirSync(join(linusCwd, '.iapeer'), { recursive: true })
    // The SOURCE says claude — the owner's edit, made while nothing was watching.
    writeFileSync(
      join(linusCwd, '.iapeer', 'peer-profile.json'),
      JSON.stringify({ personality: 'linus', default_runtime: 'claude', runtimes: ['codex', 'claude'], description: 'd', intelligence: 'artificial' }),
    )
    // The INDEX (what the router reads per-request) still says codex.
    writeFileSync(
      join(root, 'peers-profiles.json'),
      JSON.stringify({
        version: 2,
        peers: [{ personality: 'linus', runtime: 'codex', runtimes: ['codex', 'claude'], description: 'd', intelligence: 'artificial', cwd: linusCwd }],
      }),
    )
  })
  afterEach(() => {
    if (prevRoot === undefined) delete process.env.IAPEER_ROOT
    else process.env.IAPEER_ROOT = prevRoot
    rmSync(root, { recursive: true, force: true })
  })

  test('one tick heals the routing anchor from the source of truth', async () => {
    const healed: Array<{ healed: string[] }> = []
    await profileSyncTick({ env: process.env, onHealed: r => healed.push(r) }, '')
    expect(readPeersIndex({ env: process.env }).peers[0]!.runtime).toBe('claude')
    expect(healed).toHaveLength(1)
    expect(healed[0]!.healed.some(h => h.startsWith('linus:') && h.includes('default_runtime'))).toBe(true)
  })

  test('startProfileSync boot sweep heals with no interval elapsed, and stop() tears down', async () => {
    const stop = startProfileSync({ env: process.env, intervalMs: 3_600_000 })
    // the boot sweep is async — poll briefly for the healed index
    for (let i = 0; i < 100 && readPeersIndex({ env: process.env }).peers[0]!.runtime !== 'claude'; i++) {
      await new Promise(r => setTimeout(r, 10))
    }
    stop()
    expect(readPeersIndex({ env: process.env }).peers[0]!.runtime).toBe('claude')
  })
})
