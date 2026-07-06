import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  approvalModeOf,
  ensurePeerProfile,
  readPeerProfile,
  writePeerProfileAtomic,
  resolveCallerIdentity,
  type PeerProfileWrite,
} from './index.ts'
import { peerProfilePath } from '../storage/index.ts'
import { isFoundationOwnedPlist, launchdPlistPath } from '../launch/index.ts'
import { defaultIntelligenceForRuntime } from '../core/constants.ts'
import type { PeersIndex } from '../registry/index.ts'

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'iapeer-identity-'))
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

function readDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(peerProfilePath(cwd), 'utf8'))
}

// WITNESS: old writePeerProfileAtomic merged-builder (identity.ts:247-263) wrote
// `intelligence: profile.intelligence` UNCONDITIONALLY. Reproduce the merge so a
// call site that lost the existing intelligence (passing the runtime default)
// would clobber a human profile.
function oldMerged(existing: Record<string, unknown>, profile: {
  personality: string; runtime: string; runtimes: string[]; description: string; intelligence: string
}): Record<string, unknown> {
  return {
    ...existing,
    personality: profile.personality,
    runtime: profile.runtime,
    runtimes: profile.runtimes,
    description: profile.description, // empty wipes
    intelligence: profile.intelligence, // unconditional overwrite
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// approval_mode — the human-approval toggle field (docs/17-approval)
// ─────────────────────────────────────────────────────────────────────────────

describe('approval_mode profile field', () => {
  const seed = (extra: Record<string, unknown> = {}): void => {
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      peerProfilePath(cwd),
      JSON.stringify({
        personality: 'tester',
        default_runtime: 'claude',
        runtimes: ['claude'],
        description: 'Test peer.',
        intelligence: 'artificial',
        ...extra,
      }),
    )
  }

  test('absent approval_mode ⇒ default yolo (approvalModeOf + read omit it)', () => {
    seed()
    const p = readPeerProfile(cwd)!
    expect(p.approval_mode).toBeUndefined()
    expect(approvalModeOf(p)).toBe('yolo')
    expect(approvalModeOf(null)).toBe('yolo')
  })

  test('gated is honored on read; an unknown/yolo on-disk value is treated as default yolo', () => {
    seed({ approval_mode: 'gated' })
    expect(approvalModeOf(readPeerProfile(cwd))).toBe('gated')
    seed({ approval_mode: 'yolo' })
    expect(readPeerProfile(cwd)!.approval_mode).toBeUndefined() // yolo is the default → not stored
    seed({ approval_mode: 'nonsense' })
    expect(approvalModeOf(readPeerProfile(cwd))).toBe('yolo') // unknown never throws → default
  })

  test('write gated persists the field; write yolo REMOVES it; repeated flips are byte-identical each way (toggle idempotency invariant)', () => {
    seed()

    // → gated
    writePeerProfileAtomic(cwd, { ...readPeerProfile(cwd)!, approval_mode: 'gated' })
    expect(readDisk().approval_mode).toBe('gated')
    expect(approvalModeOf(readPeerProfile(cwd))).toBe('gated')
    const gatedBytes = readFileSync(peerProfilePath(cwd), 'utf8')

    // gated → yolo REMOVES the field (returns to the default = absence)
    writePeerProfileAtomic(cwd, { ...readPeerProfile(cwd)!, approval_mode: 'yolo' })
    expect(readDisk().approval_mode).toBeUndefined()
    expect(approvalModeOf(readPeerProfile(cwd))).toBe('yolo')
    const yoloBytes = readFileSync(peerProfilePath(cwd), 'utf8')

    // gated→yolo→gated→yolo lands byte-identical to the first gated / first yolo respectively
    writePeerProfileAtomic(cwd, { ...readPeerProfile(cwd)!, approval_mode: 'gated' })
    expect(readFileSync(peerProfilePath(cwd), 'utf8')).toBe(gatedBytes)
    writePeerProfileAtomic(cwd, { ...readPeerProfile(cwd)!, approval_mode: 'yolo' })
    expect(readFileSync(peerProfilePath(cwd), 'utf8')).toBe(yoloBytes)
  })

  test('a non-toggle write (approval_mode absent) preserves an existing gated value verbatim', () => {
    seed({ approval_mode: 'gated' })
    // a runtimes-only update that does NOT own the toggle must never flip it
    writePeerProfileAtomic(cwd, { personality: 'tester', runtime: 'claude', runtimes: ['claude'] })
    expect(readDisk().approval_mode).toBe('gated')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// writePeerProfileAtomic — H1 preserve + unknown-field preservation
// ─────────────────────────────────────────────────────────────────────────────

describe('writePeerProfileAtomic H1 preserve', () => {
  test('write WITHOUT intelligence does NOT downgrade a human profile on disk', () => {
    // seed a human profile with a foreign (persistent-peer) section + interfaces
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      peerProfilePath(cwd),
      JSON.stringify({
        personality: 'nova',
        runtime: 'telegram',
        runtimes: ['telegram', 'claude'],
        description: 'Owner peer (test fixture).',
        intelligence: 'human',
        'persistent-peer': { initial_prompt: 'hi', aliases: { '/new': 'x' } },
        interfaces: { telegram: { user_id: '100000001' } },
      }),
    )

    // a runtimes-only update built WITHOUT re-asserting intelligence
    const update: PeerProfileWrite = {
      personality: 'nova',
      runtime: 'claude',
      runtimes: ['telegram', 'claude'],
    }
    writePeerProfileAtomic(cwd, update)

    const disk = readDisk()
    // H1 + NO-MIGRATION: the legacy on-disk value is preserved VERBATIM (not
    // downgraded, and NOT silently rewritten to 'natural' — that migration is a
    // separate coordinated step that must not happen on a routine write).
    expect(disk.intelligence).toBe('human')
    // READ-COMPAT: but reading it back normalizes legacy human → contract natural
    expect(readPeerProfile(cwd)!.intelligence).toBe('natural')
    // WITNESS: old builder fed the claude runtime-default would write artificial
    expect(oldMerged(disk, {
      personality: 'nova', runtime: 'claude', runtimes: ['claude'],
      description: '', intelligence: defaultIntelligenceForRuntime('claude'),
    }).intelligence).toBe('artificial')
    // unknown foreign section preserved
    expect(disk['persistent-peer']).toEqual({ initial_prompt: 'hi', aliases: { '/new': 'x' } })
    // interfaces preserved
    expect(disk.interfaces).toEqual({ telegram: { user_id: '100000001' } })
    // empty description not written over the existing one
    expect(disk.description).toBe('Owner peer (test fixture).')
  })

  test('В31: a STALE profile lock is reclaimed — the write still lands and the lock is released', () => {
    const lockDir = join(cwd, '.iapeer', '.peer-profile.lock')
    mkdirSync(lockDir, { recursive: true }) // a crashed writer left this behind
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockDir, old, old) // stale (past the 10s reclaim threshold)
    writePeerProfileAtomic(cwd, { personality: 'p', runtime: 'claude', runtimes: ['claude'], intelligence: 'artificial' })
    expect(readDisk().default_runtime).toBe('claude') // the write reclaimed the stale lock and landed
    expect(existsSync(lockDir)).toBe(false) // released after the write
  })

  test('explicit intelligence in write IS applied', () => {
    writePeerProfileAtomic(cwd, {
      personality: 'p', runtime: 'webhook', runtimes: ['webhook'], intelligence: 'absent',
    })
    expect(readDisk().intelligence).toBe('absent')
  })

  test('new profile (no disk) without intelligence → runtime default', () => {
    writePeerProfileAtomic(cwd, { personality: 'p', runtime: 'telegram', runtimes: ['telegram'] })
    expect(readDisk().intelligence).toBe('natural') // telegram default
  })

  test('round-trips through readPeerProfile preserving foreign fields', () => {
    writePeerProfileAtomic(cwd, {
      personality: 'p', runtime: 'claude', runtimes: ['claude'],
      description: 'desc', intelligence: 'artificial',
    })
    // inject a foreign field, then a second write must keep it
    const disk = readDisk()
    disk['persistent-peer'] = { initial_prompt: 'keep me' }
    writeFileSync(peerProfilePath(cwd), JSON.stringify(disk))
    writePeerProfileAtomic(cwd, { personality: 'p', runtime: 'claude', runtimes: ['claude', 'codex'] })
    const after = readDisk()
    expect(after['persistent-peer']).toEqual({ initial_prompt: 'keep me' })
    expect(after.intelligence).toBe('artificial') // still preserved
    expect(after.runtimes).toEqual(['claude', 'codex'])
    const parsed = readPeerProfile(cwd)!
    expect(parsed.intelligence).toBe('artificial')
  })

  test('wake_policy "ephemeral" parsed; unknown/absent → omitted (never throws)', () => {
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    // honored enum value
    writeFileSync(peerProfilePath(cwd), JSON.stringify({
      personality: 'p', runtime: 'claude', runtimes: ['claude'], wake_policy: 'ephemeral',
    }))
    expect(readPeerProfile(cwd)!.wake_policy).toBe('ephemeral')
    // absent → undefined
    writeFileSync(peerProfilePath(cwd), JSON.stringify({ personality: 'p', runtime: 'claude', runtimes: ['claude'] }))
    expect(readPeerProfile(cwd)!.wake_policy).toBeUndefined()
    // unknown value → omitted (forward-compatible, no throw)
    writeFileSync(peerProfilePath(cwd), JSON.stringify({
      personality: 'p', runtime: 'claude', runtimes: ['claude'], wake_policy: 'persistent-future',
    }))
    expect(readPeerProfile(cwd)!.wake_policy).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolveCallerIdentity — per-request, NO process.cwd()
// ─────────────────────────────────────────────────────────────────────────────

const index: PeersIndex = {
  version: 2,
  peers: [
    {
      personality: 'nova',
      runtime: 'telegram',
      runtimes: ['telegram', 'claude'],
      description: 'Owner peer (test fixture).',
      intelligence: 'natural',
      cwd: '/tmp/iapeer-peers/nova',
      interfaces: { telegram: { user_id: '100000001' } },
    },
    {
      personality: 'boris',
      runtime: 'claude',
      runtimes: ['claude'],
      description: 'Напарник.',
      intelligence: 'artificial',
      cwd: '/tmp/iapeer-peers/boris',
    },
  ],
}

describe('resolveCallerIdentity (per-request)', () => {
  test('resolves caller from registry record, builds address', () => {
    const r = resolveCallerIdentity({ personality: 'boris', runtime: 'claude' }, index)
    expect(r.address).toBe('claude-boris')
    expect(r.cwd).toBe('/tmp/iapeer-peers/boris')
    expect(r.intelligence).toBe('artificial')
  })

  test('multi-runtime peer resolves each declared runtime to a distinct address', () => {
    expect(resolveCallerIdentity({ personality: 'nova', runtime: 'telegram' }, index).address).toBe(
      'telegram-nova',
    )
    expect(resolveCallerIdentity({ personality: 'nova', runtime: 'claude' }, index).address).toBe(
      'claude-nova',
    )
  })

  test('does NOT depend on process.cwd() — chdir does not change the result', () => {
    const before = resolveCallerIdentity({ personality: 'nova', runtime: 'claude' }, index)
    const original = process.cwd()
    const elsewhere = mkdtempSync(join(tmpdir(), 'iapeer-chdir-'))
    try {
      process.chdir(elsewhere)
      const after = resolveCallerIdentity({ personality: 'nova', runtime: 'claude' }, index)
      expect(after).toEqual(before)
      expect(after.cwd).toBe('/tmp/iapeer-peers/nova') // from registry, not process.cwd()
    } finally {
      process.chdir(original)
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  test('unknown caller → throws (spoofing guard)', () => {
    expect(() => resolveCallerIdentity({ personality: 'ghost', runtime: 'claude' }, index)).toThrow(
      /unknown caller/,
    )
  })

  test('undeclared runtime for a known caller → throws', () => {
    // boris declares only claude; codex must be rejected
    expect(() => resolveCallerIdentity({ personality: 'boris', runtime: 'codex' }, index)).toThrow(
      /not declared/,
    )
  })

  test('invalid personality format → throws', () => {
    expect(() => resolveCallerIdentity({ personality: 'Bad Name', runtime: 'claude' }, index)).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ensurePeerProfile — create-peer path installs the always-on plist for INFRA
// runtimes (and ONLY those). Always under IAPEER_LAUNCHAGENTS_DIR so the suite
// never writes into the real ~/Library/LaunchAgents.
// ─────────────────────────────────────────────────────────────────────────────

describe('ensurePeerProfile create-peer → always-on plist (infra only)', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'iapeer-provision-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
  const laEnv = () =>
    // IAPEER_ROOT isolates the now-GLOBAL infra log dir (~/.iapeer/logs/<p>, Фаза §8)
    // under the sandbox — without it installAlwaysOnPlist's log mkdir resolves to the
    // real home.
    ({ IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'), IAPEER_ROOT: join(root, 'iapeer') }) as NodeJS.ProcessEnv

  test('provisioning a NEW infra (notifier) peer installs a foundation-owned plist', () => {
    const env = laEnv()
    const peerCwd = join(root, 'timer') // basename → personality "timer"
    const profile = ensurePeerProfile({ cwd: peerCwd, env, runtime: 'notifier' })
    expect(profile.personality).toBe('timer')
    expect(profile.intelligence).toBe('absent') // notifier zone default

    const plist = launchdPlistPath('timer', env)
    expect(existsSync(plist)).toBe(true)
    expect(isFoundationOwnedPlist(plist)).toBe(true)
    // and the profile was written (full provision)
    expect(existsSync(peerProfilePath(peerCwd))).toBe(true)
  })

  test('provisioning a NEW warm-on-demand (claude) peer installs NO plist (unchanged)', () => {
    const env = laEnv()
    const peerCwd = join(root, 'worker') // personality "worker"
    ensurePeerProfile({ cwd: peerCwd, env, runtime: 'claude' })
    expect(existsSync(launchdPlistPath('worker', env))).toBe(false)
    expect(existsSync(peerProfilePath(peerCwd))).toBe(true) // profile still created
  })

  test('infra provision whose Label collides with a FOREIGN plist is refused — no profile written', () => {
    const env = laEnv()
    const laDir = join(root, 'LaunchAgents')
    mkdirSync(laDir, { recursive: true })
    // a live persistent-peer "boris" already owns com.iapeer.boris.plist (no sentinel)
    const foreign = '<?xml version="1.0"?>\n<plist><dict><key>Label</key><string>com.iapeer.boris</string></dict></plist>\n'
    const plist = launchdPlistPath('boris', env)
    writeFileSync(plist, foreign)

    const peerCwd = join(root, 'boris') // would derive personality "boris" → collision
    expect(() => ensurePeerProfile({ cwd: peerCwd, env, runtime: 'notifier' })).toThrow(
      /foundation-managed|refus/i,
    )
    // the live PP plist is untouched, and the half-provision left NO peer-profile.json
    expect(readFileSync(plist, 'utf8')).toBe(foreign)
    expect(existsSync(peerProfilePath(peerCwd))).toBe(false)
  })
})
