// Profile-standard validator + index↔local self-heal (reconcile / reindex).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isConformant, migrateProfileRuntimeField, recordDrift, reconcileIndex, reindexFromLocals, validateProfileStandard } from './profileStandard.ts'
import { readFileSync } from 'fs'
import { readPeersIndex } from '../registry/index.ts'

describe('validateProfileStandard', () => {
  const cwd = '/Users/x/Peers/boris' // basename normalizes to "boris"

  test('a conformant profile (contract field default_runtime) has no issues', () => {
    const issues = validateProfileStandard(
      { personality: 'boris', default_runtime: 'claude', runtimes: ['claude'], description: 'PM', intelligence: 'artificial' },
      cwd,
    )
    expect(issues).toEqual([])
    expect(isConformant(issues)).toBe(true)
  })

  test('legacy `runtime` field → WARN (not error), still conformant', () => {
    const issues = validateProfileStandard(
      { personality: 'boris', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial' },
      cwd,
    )
    expect(isConformant(issues)).toBe(true)
    expect(issues.find(i => i.field === 'default_runtime')?.severity).toBe('warn')
  })

  test('default_runtime + in-sync legacy mirror (Phase-2 write shape) → NO issues', () => {
    const issues = validateProfileStandard(
      { personality: 'boris', default_runtime: 'claude', runtime: 'claude', runtimes: ['claude'], description: 'PM', intelligence: 'artificial' },
      cwd,
    )
    expect(issues).toEqual([])
  })

  test('DIVERGED legacy mirror → WARN on default_runtime, still conformant', () => {
    const issues = validateProfileStandard(
      { personality: 'boris', default_runtime: 'codex', runtime: 'claude', runtimes: ['codex', 'claude'], description: '', intelligence: 'artificial' },
      cwd,
    )
    expect(isConformant(issues)).toBe(true)
    const warn = issues.find(i => i.field === 'default_runtime')
    expect(warn?.severity).toBe('warn')
    expect(warn?.message).toContain('diverged')
  })

  test('aliases misfiled in interfaces.telegram → WARN (owner migration to expansion.aliases pending)', () => {
    const issues = validateProfileStandard(
      {
        personality: 'boris', default_runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial',
        interfaces: { telegram: { bot: 'k', aliases: { '/alias_new': 'txt' } } },
      },
      cwd,
    )
    expect(isConformant(issues)).toBe(true)
    expect(issues.some(i => i.field === 'interfaces.telegram.aliases' && i.severity === 'warn')).toBe(true)
    // passport-only telegram section → silent
    const clean = validateProfileStandard(
      {
        personality: 'boris', default_runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial',
        interfaces: { telegram: { bot: 'k' } },
        expansion: { aliases: { '/alias_new': 'txt' } },
      },
      cwd,
    )
    expect(clean).toEqual([])
  })

  test('top-level aliases → WARN (owner migration pending), still conformant', () => {
    const issues = validateProfileStandard(
      { personality: 'boris', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial', aliases: { '/new': 'x' } },
      cwd,
    )
    expect(isConformant(issues)).toBe(true)
    expect(issues.some(i => i.field === 'aliases' && i.severity === 'warn')).toBe(true)
  })

  test('personality mirror disagreeing with cwd → WARN (self-heal), not error', () => {
    const issues = validateProfileStandard(
      { personality: 'WRONG', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial' },
      cwd,
    )
    expect(isConformant(issues)).toBe(true)
    expect(issues.some(i => i.field === 'personality' && i.severity === 'warn')).toBe(true)
  })

  test('ERRORS: bad runtime, runtimes missing the default, bad intelligence', () => {
    // runtime ids carry NO hyphen (/^[a-z][a-z0-9]{0,31}$/) → a hyphenated value is an error
    expect(isConformant(validateProfileStandard({ default_runtime: 'no-dash', runtimes: ['claude'], intelligence: 'artificial' }, cwd))).toBe(false)
    const e1 = validateProfileStandard({ default_runtime: 'claude', runtimes: ['codex'], intelligence: 'artificial' }, cwd)
    expect(isConformant(e1)).toBe(false) // runtimes does not include the default
    const e2 = validateProfileStandard({ default_runtime: 'claude', runtimes: ['claude'], intelligence: 'bogus' }, cwd)
    expect(isConformant(e2)).toBe(false)
    const e3 = validateProfileStandard({ runtimes: ['claude'], intelligence: 'artificial' }, cwd)
    expect(isConformant(e3)).toBe(false) // no runtime/default_runtime at all
  })

  test('intelligence accepts the live vocab + legacy on read', () => {
    for (const v of ['artificial', 'natural', 'absent', 'human', 'scripted']) {
      const issues = validateProfileStandard({ default_runtime: 'claude', runtimes: ['claude'], intelligence: v }, cwd)
      expect(issues.some(i => i.field === 'intelligence')).toBe(false)
    }
  })
})

describe('reconcileIndex / reindexFromLocals (self-heal)', () => {
  let root: string
  const prevRoot = process.env.IAPEER_ROOT
  let borisCwd: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'iapeer-ps-'))
    process.env.IAPEER_ROOT = root
    // a local profile (source of truth) with a FRESH description + narrowed runtimes
    borisCwd = join(root, 'peers', 'boris')
    mkdirSync(join(borisCwd, '.iapeer'), { recursive: true })
    writeFileSync(
      join(borisCwd, '.iapeer', 'peer-profile.json'),
      JSON.stringify({ personality: 'boris', runtime: 'claude', runtimes: ['claude'], description: 'FRESH local desc', intelligence: 'artificial' }),
    )
    // a STALE index: old description + an extra runtime the local no longer declares
    writeFileSync(
      join(root, 'peers-profiles.json'),
      JSON.stringify({
        version: 2,
        peers: [{ personality: 'boris', runtime: 'claude', runtimes: ['claude', 'codex'], description: 'STALE index desc', intelligence: 'artificial', cwd: borisCwd }],
      }),
    )
  })
  afterEach(() => {
    if (prevRoot === undefined) delete process.env.IAPEER_ROOT
    else process.env.IAPEER_ROOT = prevRoot
    rmSync(root, { recursive: true, force: true })
  })

  test('reconcile DETECTS the drift (description + runtimes) read-only', () => {
    const r = reconcileIndex({ env: process.env })
    const boris = r.find(e => e.personality === 'boris')
    expect(boris?.drift).toContain('description')
    expect(boris?.drift).toContain('runtimes')
    // read-only: the index file is untouched
    expect(readPeersIndex({ env: process.env }).peers[0].description).toBe('STALE index desc')
  })

  test('reindex SELF-HEALS the index from the local profile (REPLACE, not union)', async () => {
    const { healed } = await reindexFromLocals({ env: process.env })
    expect(healed.some(h => h.startsWith('boris:'))).toBe(true)
    const rec = readPeersIndex({ env: process.env }).peers[0]
    expect(rec.description).toBe('FRESH local desc')
    expect(rec.runtimes).toEqual(['claude']) // codex DROPPED (reindex replaces, unlike upsert union)
    // after the heal, reconcile is clean
    expect(reconcileIndex({ env: process.env }).find(e => e.personality === 'boris')?.drift).toEqual([])
  })

  test('reindex writes the Phase-3 registry disk shape: default_runtime ONLY (legacy mirror dropped)', async () => {
    await reindexFromLocals({ env: process.env })
    const disk = JSON.parse(readFileSync(join(root, 'peers-profiles.json'), 'utf8'))
    expect(disk.peers[0].default_runtime).toBe('claude')
    expect(disk.peers[0].runtime).toBeUndefined() // Phase-3: registry no longer writes the legacy mirror
  })

  test('migrateProfileRuntimeField: legacy-only profile → rewritten with default_runtime + mirror, owner fields preserved, idempotent', () => {
    const profilePath = join(borisCwd, '.iapeer', 'peer-profile.json')
    // enrich the legacy profile with owner-section + lifecycle fields that MUST survive
    writeFileSync(
      profilePath,
      JSON.stringify({
        personality: 'boris', runtime: 'claude', runtimes: ['claude'], description: 'd', intelligence: 'human',
        initial_prompt: 'boot', wake_policy: 'ephemeral',
        interfaces: { telegram: { bot: 'k' } },
        expansion: { aliases: { '/alias_new': 'txt' } },
        notifier: { triggers: [] },
      }),
    )
    expect(migrateProfileRuntimeField(borisCwd)).toBe(true)
    const after = JSON.parse(readFileSync(profilePath, 'utf8'))
    expect(after.default_runtime).toBe('claude')
    expect(after.runtime).toBeUndefined() // Phase-3: legacy `runtime` mirror stripped on write
    expect(after.intelligence).toBe('human') // legacy vocab preserved VERBATIM (no silent migration)
    expect(after.initial_prompt).toBe('boot')
    expect(after.wake_policy).toBe('ephemeral')
    expect(after.interfaces).toEqual({ telegram: { bot: 'k' } })
    expect(after.expansion).toEqual({ aliases: { '/alias_new': 'txt' } })
    expect(after.notifier).toEqual({ triggers: [] })
    // idempotent: already in shape → untouched
    expect(migrateProfileRuntimeField(borisCwd)).toBe(false)
  })

  test('migrateProfileRuntimeField: DIVERGED mirror heals to default_runtime (the contract side wins)', () => {
    const profilePath = join(borisCwd, '.iapeer', 'peer-profile.json')
    writeFileSync(
      profilePath,
      JSON.stringify({ personality: 'boris', default_runtime: 'codex', runtime: 'claude', runtimes: ['codex', 'claude'], description: '', intelligence: 'artificial' }),
    )
    expect(migrateProfileRuntimeField(borisCwd)).toBe(true)
    const after = JSON.parse(readFileSync(profilePath, 'utf8'))
    expect(after.default_runtime).toBe('codex') // contract side governs
    expect(after.runtime).toBeUndefined() // Phase-3: diverged legacy mirror stripped (default_runtime wins)
  })

  test('reconcile DETECTS interfaces drift (bot_username cutover class) + reindex drops the stale field', async () => {
    // source of truth (local): post-cutover clean telegram passport — NO `bot`
    writeFileSync(
      join(borisCwd, '.iapeer', 'peer-profile.json'),
      JSON.stringify({
        personality: 'boris', default_runtime: 'claude', runtimes: ['claude'], description: 'd', intelligence: 'artificial',
        interfaces: { telegram: { activity: true, bot_username: 'boris_claudecode_bot' } },
      }),
    )
    // derived index: STALE — still carries the removed `bot` field (the desync class)
    writeFileSync(
      join(root, 'peers-profiles.json'),
      JSON.stringify({
        version: 2,
        peers: [{
          personality: 'boris', default_runtime: 'claude', runtimes: ['claude'], description: 'd', intelligence: 'artificial', cwd: borisCwd,
          interfaces: { telegram: { bot: 'boris', activity: true, bot_username: 'boris_claudecode_bot' } },
        }],
      }),
    )
    // reconcile now SEES the interfaces drift (the bug: recordDrift never compared interfaces)
    expect(reconcileIndex({ env: process.env }).find(e => e.personality === 'boris')?.drift).toContain('interfaces')
    // reindex heals: the derived index drops the stale `bot`, matching the source of truth
    await reindexFromLocals({ env: process.env })
    expect(readPeersIndex({ env: process.env }).peers[0].interfaces).toEqual({
      telegram: { activity: true, bot_username: 'boris_claudecode_bot' },
    })
    // afterwards reconcile is clean
    expect(reconcileIndex({ env: process.env }).find(e => e.personality === 'boris')?.drift).toEqual([])
  })

  test('recordDrift: key-order-only difference in interfaces is NOT drift (canonical compare)', () => {
    const a = {
      personality: 'boris', runtime: 'claude', runtimes: ['claude'], description: 'd', intelligence: 'artificial', cwd: '/x',
      interfaces: { telegram: { activity: true, bot_username: 'b' } },
    } as never
    const b = {
      personality: 'boris', runtime: 'claude', runtimes: ['claude'], description: 'd', intelligence: 'artificial', cwd: '/y',
      interfaces: { telegram: { bot_username: 'b', activity: true } }, // same content, different key order
    } as never
    expect(recordDrift(a, b)).toEqual([])
  })
})
