import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clampDescription,
  findPeer,
  readPeersIndex,
  removePeer,
  updatePeersIndex,
  upsertPeer,
  withPeersLock,
  type PeerRecord,
} from './index.ts'
import { MAX_DESCRIPTION_LEN, defaultIntelligenceForRuntime, type Intelligence } from '../core/constants.ts'
import { writeFileAtomic, resolvePeersPaths } from '../storage/index.ts'

let root: string
const opts = () => ({ rootDir: root })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-registry-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// The live nova record (from ~/.iapeer/peers-profiles.json): a human peer
// primarily on telegram, also present on claude, with a telegram interface.
async function seedNova(): Promise<void> {
  await upsertPeer(
    {
      personality: 'nova',
      runtime: 'telegram',
      runtimes: ['telegram', 'claude'],
      description: 'Owner peer (test fixture).',
      intelligence: 'natural',
      interfaces: { telegram: { user_id: '100000001' } },
      cwd: '/tmp/iapeer-peers/nova',
    },
    opts(),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// WITNESS: the OLD upsertPeer record-builder (peers.ts:342-358, full-replace).
// Pure reproduction so each H1 test shows a real delta — the witness produces
// the clobbered record, the new upsertPeer preserves the existing fields.
// ─────────────────────────────────────────────────────────────────────────────

function oldUpsertRecord(
  args: {
    personality: string
    runtime: string
    runtimes?: readonly string[]
    description?: string
    intelligence?: Intelligence
    interfaces?: Record<string, unknown>
    cwd: string
  },
): PeerRecord {
  const runtime = args.runtime
  const runtimes = [runtime, ...(args.runtimes ?? [])].filter((v, i, a) => a.indexOf(v) === i)
  const description = args.description ?? '' // empty wipes existing
  const intelligence =
    args.intelligence !== undefined ? args.intelligence : defaultIntelligenceForRuntime(runtime) // default, not existing
  return {
    personality: args.personality,
    runtime,
    runtimes,
    description,
    intelligence,
    cwd: args.cwd,
    ...(args.interfaces ? { interfaces: args.interfaces } : {}),
  }
}

// The claude-boot upsert (server.ts:266 path): no intelligence, empty
// description, single runtime claude, no interfaces.
const bootUpsertArgs = {
  personality: 'nova',
  runtime: 'claude',
  runtimes: ['claude'],
  description: '',
  cwd: '/tmp/iapeer-peers/nova',
} as const

// ─────────────────────────────────────────────────────────────────────────────
// H1: merge-with-existing
// ─────────────────────────────────────────────────────────────────────────────

describe('upsertPeer H1 merge-with-existing', () => {
  test('claude-boot upsert WITHOUT intelligence does NOT downgrade a natural peer', async () => {
    await seedNova()

    // WITNESS (before fix): old builder overwrites with the claude default (artificial)
    expect(oldUpsertRecord(bootUpsertArgs).intelligence).toBe('artificial')

    // NEW (after fix): registry preserves natural
    await upsertPeer(bootUpsertArgs, opts())
    const nova = findPeer(readPeersIndex(opts()), 'nova')!
    expect(nova.intelligence).toBe('natural')
  })

  test('runtimes are unioned, not replaced (telegram not dropped on claude boot)', async () => {
    await seedNova()

    // WITNESS: old builder drops telegram, leaving only claude
    expect(oldUpsertRecord(bootUpsertArgs).runtimes).toEqual(['claude'])

    // NEW: union → telegram + claude both present
    await upsertPeer(bootUpsertArgs, opts())
    const nova = findPeer(readPeersIndex(opts()), 'nova')!
    expect(nova.runtimes).toContain('telegram')
    expect(nova.runtimes).toContain('claude')
  })

  test('empty description does NOT wipe a meaningful existing description', async () => {
    await seedNova()

    // WITNESS: old builder wipes it to ''
    expect(oldUpsertRecord(bootUpsertArgs).description).toBe('')

    // NEW: existing description preserved
    await upsertPeer(bootUpsertArgs, opts())
    const nova = findPeer(readPeersIndex(opts()), 'nova')!
    expect(nova.description).toBe('Owner peer (test fixture).')
  })

  test('interfaces preserved when absent from args', async () => {
    await seedNova()

    // WITNESS: old builder drops interfaces (not in args)
    expect(oldUpsertRecord(bootUpsertArgs).interfaces).toBeUndefined()

    // NEW: telegram interface preserved
    await upsertPeer(bootUpsertArgs, opts())
    const nova = findPeer(readPeersIndex(opts()), 'nova')!
    expect(nova.interfaces).toEqual({ telegram: { user_id: '100000001' } })
  })

  test('explicit intelligence in args DOES override existing', async () => {
    await seedNova()
    await upsertPeer({ ...bootUpsertArgs, intelligence: 'artificial' }, opts())
    const nova = findPeer(readPeersIndex(opts()), 'nova')!
    expect(nova.intelligence).toBe('artificial')
  })

  test('explicit non-empty description in args DOES override', async () => {
    await seedNova()
    await upsertPeer({ ...bootUpsertArgs, description: 'new desc' }, opts())
    expect(findPeer(readPeersIndex(opts()), 'nova')!.description).toBe('new desc')
  })
})

// Regression — the audit's CRITICAL finding: the only production caller (provisionPeer
// from `iapeer init`) forwards the READ-NORMALIZED contract value (profile.intelligence
// = 'natural' for a legacy 'human' peer) as an explicit upsert intelligence. The write
// boundary must treat that as a re-assertion of the SAME nature and keep the legacy raw
// — NOT migrate the on-disk vocab the live legacy-IAP fleet reads.
describe('upsertPeer vocab-preservation (registry self-defends the legacy raw)', () => {
  const novaCwd = '/tmp/iapeer-peers/nova'
  async function seedLegacyHuman(): Promise<void> {
    await upsertPeer({ personality: 'nova', runtime: 'telegram', runtimes: ['telegram', 'claude'], intelligence: 'human' as never, cwd: novaCwd }, opts())
  }
  test('seeding a legacy human value persists the raw verbatim; read normalizes', async () => {
    await seedLegacyHuman()
    const p = findPeer(readPeersIndex(opts()), 'nova')!
    expect(p.intelligence).toBe('natural') // READ-normalized contract value
    expect(p.intelligenceRaw).toBe('human') // RAW on disk preserved
  })
  test('re-asserting the SAME nature (read-normalized natural) does NOT migrate human→natural', async () => {
    await seedLegacyHuman()
    // exactly what provisionPeer emits on a routine re-init (no explicit --intelligence):
    await upsertPeer({ personality: 'nova', runtime: 'telegram', intelligence: 'natural', cwd: novaCwd }, opts())
    expect(findPeer(readPeersIndex(opts()), 'nova')!.intelligenceRaw).toBe('human') // STILL human
  })
  test('a GENUINE nature change DOES adopt the new value as the raw', async () => {
    await seedLegacyHuman()
    await upsertPeer({ personality: 'nova', runtime: 'telegram', intelligence: 'artificial', cwd: novaCwd }, opts())
    expect(findPeer(readPeersIndex(opts()), 'nova')!.intelligenceRaw).toBe('artificial')
  })
  test('legacy vocab accepted by the write path (read-path symmetry); garbage rejected', async () => {
    await upsertPeer({ personality: 'srv', runtime: 'notifier', intelligence: 'scripted' as never, cwd: '/tmp/srv' }, opts())
    const s = findPeer(readPeersIndex(opts()), 'srv')!
    expect(s.intelligence).toBe('absent') // scripted → absent (normalized)
    expect(s.intelligenceRaw).toBe('scripted') // raw preserved
    await expect(upsertPeer({ personality: 'bad', runtime: 'claude', intelligence: 'sentient' as never, cwd: '/tmp/bad' }, opts())).rejects.toThrow(/artificial\|natural\|absent/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// New peer: runtime default DOES apply when there is no existing
// ─────────────────────────────────────────────────────────────────────────────

describe('upsertPeer new peer (no existing) — defaults apply', () => {
  test('new claude peer without intelligence → artificial (runtime default)', async () => {
    await upsertPeer({ personality: 'fresh', runtime: 'claude', cwd: '/tmp/fresh' }, opts())
    expect(findPeer(readPeersIndex(opts()), 'fresh')!.intelligence).toBe('artificial')
  })

  test('new telegram peer without intelligence → natural (runtime default)', async () => {
    await upsertPeer({ personality: 'someone', runtime: 'telegram', cwd: '/tmp/someone' }, opts())
    expect(findPeer(readPeersIndex(opts()), 'someone')!.intelligence).toBe('natural')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency: single locked writer — no lost update
// ─────────────────────────────────────────────────────────────────────────────

describe('registry locked writer — concurrent upsert does not clobber', () => {
  test('two parallel upserts of the same personality both survive (runtimes union)', async () => {
    await upsertPeer({ personality: 'p', runtime: 'claude', cwd: '/tmp/p' }, opts())

    // Both add a distinct runtime concurrently. Under the lock each reads the
    // other's write; an unlocked read-modify-write would lose one.
    await Promise.all([
      upsertPeer({ personality: 'p', runtime: 'claude', runtimes: ['codex'], cwd: '/tmp/p' }, opts()),
      upsertPeer({ personality: 'p', runtime: 'claude', runtimes: ['telegram'], cwd: '/tmp/p' }, opts()),
    ])

    const p = findPeer(readPeersIndex(opts()), 'p')!
    expect(p.runtimes).toContain('claude')
    expect(p.runtimes).toContain('codex')
    expect(p.runtimes).toContain('telegram')

    // exactly one record for the personality (no duplicate / no clobber)
    expect(readPeersIndex(opts()).peers.filter(x => x.personality === 'p')).toHaveLength(1)
  })

  test('many parallel upserts of distinct peers all land', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `peer-${i}`)
    await Promise.all(
      names.map(n => upsertPeer({ personality: n, runtime: 'claude', cwd: `/tmp/${n}` }, opts())),
    )
    const index = readPeersIndex(opts())
    for (const n of names) expect(findPeer(index, n)).not.toBeNull()
    expect(index.peers).toHaveLength(12)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Structural invariant #3: peers file is unreachable past the locked API
// ─────────────────────────────────────────────────────────────────────────────

describe('registry single-writer is structural (#3)', () => {
  test('storage.writeFileAtomic REFUSES the peers-profiles.json path', () => {
    const { peersFile } = resolvePeersPaths(opts())
    expect(() => writeFileAtomic(peersFile, '{"version":2,"peers":[]}')).toThrow(/registry/)
  })

  test('after a refused bypass, the registry file written by upsert is intact JSON', async () => {
    await seedNova()
    const { peersFile } = resolvePeersPaths(opts())
    expect(() => writeFileAtomic(peersFile, 'CLOBBER')).toThrow()
    const parsed = JSON.parse(readFileSync(peersFile, 'utf8'))
    expect(parsed.version).toBe(2)
    expect(parsed.peers[0].personality).toBe('nova')
  })

  test('removePeer also goes through the locked writer', async () => {
    await seedNova()
    await removePeer('nova', opts())
    expect(findPeer(readPeersIndex(opts()), 'nova')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// VOCAB read-compat: legacy human/scripted on disk → contract natural/absent
// ─────────────────────────────────────────────────────────────────────────────

describe('registry read-compat (legacy intelligence vocab)', () => {
  test('legacy registry file (human/scripted) reads as natural/absent, does not crash', () => {
    const { peersFile } = resolvePeersPaths(opts())
    // a legacy file as it exists on the live host today (pre-migration)
    writeFileSync(
      peersFile,
      JSON.stringify({
        version: 2,
        peers: [
          { personality: 'nova', runtime: 'telegram', runtimes: ['telegram', 'claude'], description: 'Нова', intelligence: 'human', cwd: '/tmp/iapeer-peers/nova' },
          { personality: 'cronjob', runtime: 'cron', runtimes: ['cron'], description: '', intelligence: 'scripted', cwd: '/tmp/cronjob' },
          { personality: 'boris', runtime: 'claude', runtimes: ['claude'], description: 'b', intelligence: 'artificial', cwd: '/tmp/boris' },
        ],
      }),
    )
    const index = readPeersIndex(opts())
    expect(findPeer(index, 'nova')!.intelligence).toBe('natural') // human → natural
    expect(findPeer(index, 'cronjob')!.intelligence).toBe('absent') // scripted → absent
    expect(findPeer(index, 'boris')!.intelligence).toBe('artificial') // pass-through
  })

  test('genuinely unknown intelligence value still throws', () => {
    const { peersFile } = resolvePeersPaths(opts())
    writeFileSync(
      peersFile,
      JSON.stringify({
        version: 2,
        peers: [{ personality: 'x', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'bogus', cwd: '/tmp/x' }],
      }),
    )
    expect(() => readPeersIndex(opts())).toThrow(/intelligence/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fix A — GOLDEN round-trip: a registry write PRESERVES every peer's RAW vocab
// verbatim (legacy-safe). The incident: removePeer rewrote the live registry,
// persisting the IN-MEMORY normalization (nova human→natural) → the legacy IAP
// (human/artificial/scripted only) read "natural" as corrupted → fleet transport
// down. The fix persists the raw on-disk vocab; normalization is in-memory only.
// ─────────────────────────────────────────────────────────────────────────────

describe('Fix A — registry write preserves raw intelligence vocab (legacy-safe)', () => {
  const seedFullVocab = () => {
    const { peersFile } = resolvePeersPaths(opts())
    writeFileSync(
      peersFile,
      JSON.stringify({
        version: 2,
        peers: [
          { personality: 'phuman', runtime: 'telegram', runtimes: ['telegram'], description: '', intelligence: 'human', cwd: '/a' },
          { personality: 'pscripted', runtime: 'notifier', runtimes: ['notifier'], description: '', intelligence: 'scripted', cwd: '/b' },
          { personality: 'partificial', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial', cwd: '/c' },
          { personality: 'pnatural', runtime: 'telegram', runtimes: ['telegram'], description: '', intelligence: 'natural', cwd: '/d' },
          { personality: 'pabsent', runtime: 'notifier', runtimes: ['notifier'], description: '', intelligence: 'absent', cwd: '/e' },
        ],
      }),
    )
  }
  const onDiskVocab = () => {
    const disk = JSON.parse(readFileSync(resolvePeersPaths(opts()).peersFile, 'utf8'))
    return Object.fromEntries((disk.peers as { personality: string; intelligence: string }[]).map(p => [p.personality, p.intelligence]))
  }

  test('in-memory read NORMALIZES (human→natural, scripted→absent) for foundation logic', () => {
    seedFullVocab()
    const idx = readPeersIndex(opts())
    expect(findPeer(idx, 'phuman')!.intelligence).toBe('natural')
    expect(findPeer(idx, 'pscripted')!.intelligence).toBe('absent')
    expect(findPeer(idx, 'partificial')!.intelligence).toBe('artificial')
  })

  test('GOLDEN: an upsert write preserves EVERY peer raw vocab (human→human, scripted→scripted, …)', async () => {
    seedFullVocab()
    await upsertPeer({ personality: 'trigger', runtime: 'claude', cwd: '/t', intelligence: 'artificial' }, opts())
    const v = onDiskVocab()
    expect(v.phuman).toBe('human') // NOT 'natural' — preserved
    expect(v.pscripted).toBe('scripted') // NOT 'absent' — preserved
    expect(v.partificial).toBe('artificial')
    expect(v.pnatural).toBe('natural')
    expect(v.pabsent).toBe('absent')
    expect(v.trigger).toBe('artificial')
    // the intelligenceRaw shadow field never leaks to disk
    const disk = JSON.parse(readFileSync(resolvePeersPaths(opts()).peersFile, 'utf8'))
    expect((disk.peers as Record<string, unknown>[]).every(p => p.intelligenceRaw === undefined)).toBe(true)
  })

  test('INCIDENT scenario: removePeer of one peer preserves the legacy vocab of the others', async () => {
    seedFullVocab()
    await removePeer('partificial', opts()) // the exact op that broke the live registry
    const v = onDiskVocab()
    expect(v.partificial).toBeUndefined() // removed
    expect(v.phuman).toBe('human') // nova-like human peer: vocab INTACT (the fix)
    expect(v.pscripted).toBe('scripted')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Companion fix — test/sandbox isolation is FAIL-CLOSED. The incident root cause
// (#1): a sandbox run resolved the registry to the REAL ~/.iapeer and rewrote it.
// Under IAPEER_TEST_SANDBOX=1, withPeersLock REFUSES to write the HOME-default
// root — a test/sandbox MUST divert via IAPEER_ROOT. (The whole `bun test` run is
// marked via package.json, so every locked write during tests is guarded.)
// ─────────────────────────────────────────────────────────────────────────────

describe('Companion fix — withPeersLock fail-closed sandbox isolation', () => {
  test('THROWS when IAPEER_TEST_SANDBOX=1 and the root falls through to HOME/.iapeer', async () => {
    // fake HOME, NO IAPEER_ROOT override → resolves to <fakeHome>/.iapeer (the
    // "forgot to divert" case the incident hit). Guard fires BEFORE any FS write.
    const fakeHome = mkdtempSync(join(tmpdir(), 'iapeer-guard-home-'))
    const env = { HOME: fakeHome, IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv
    await expect(withPeersLock({ env }, () => 'wrote')).rejects.toThrow(/refusing to write the REAL registry/i)
    rmSync(fakeHome, { recursive: true, force: true })
  })

  test('ALLOWS the same run when IAPEER_ROOT diverts the root away from HOME/.iapeer', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'iapeer-guard-home-'))
    const env = { HOME: fakeHome, IAPEER_ROOT: join(fakeHome, 'sbx'), IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv
    const out = await withPeersLock({ env }, () => 'ok')
    expect(out).toBe('ok')
    rmSync(fakeHome, { recursive: true, force: true })
  })

  test('NO guard when the sandbox flag is absent (rootDir-isolated tests are unaffected)', async () => {
    // opts() = { rootDir: <mkdtemp> }, env defaults to process.env (no flag in the
    // passed env object) → guard short-circuits, the normal locked write proceeds.
    const out = await withPeersLock({ rootDir: root, env: {} as NodeJS.ProcessEnv }, () => 'ok')
    expect(out).toBe('ok')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// clampDescription boundary — the limit was raised 250 → 450 so self-documenting
// API-peer descriptions (notifier timer/watcher, ~408 chars) survive intact. The
// boundary is exact: length == MAX passes untouched, length == MAX+1 truncates.
// ─────────────────────────────────────────────────────────────────────────────

describe('clampDescription — MAX_DESCRIPTION_LEN boundary (450)', () => {
  test('the limit is 450', () => {
    expect(MAX_DESCRIPTION_LEN).toBe(450)
  })
  test('a 450-char description passes through untouched', () => {
    const at = 'x'.repeat(450)
    const r = clampDescription(at)
    expect(r.truncated).toBe(false)
    expect(r.description).toBe(at)
    expect(r.description.length).toBe(450)
  })
  test('a 451-char description is truncated to 450', () => {
    const over = 'y'.repeat(451)
    const r = clampDescription(over)
    expect(r.truncated).toBe(true)
    expect(r.description.length).toBe(450)
    expect(r.description).toBe('y'.repeat(450))
  })
  test('upsertPeer persists a full 450-char description (no clamp at the boundary)', async () => {
    const desc = 'z'.repeat(450)
    await upsertPeer({ personality: 'verbose', runtime: 'claude', cwd: '/tmp/verbose', description: desc }, opts())
    expect(findPeer(readPeersIndex(opts()), 'verbose')!.description).toBe(desc)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Б6a — registry integrity: В35 cwd-collision under lock, В33 read-invariant guard
// ─────────────────────────────────────────────────────────────────────────────

describe('В35 upsertPeer refuses to re-point an existing personality to a DIFFERENT cwd', () => {
  const base = (over: Partial<{ cwd: string }> = {}) => ({
    personality: 'dup',
    runtime: 'claude' as const,
    intelligence: 'artificial' as const,
    cwd: '/tmp/iapeer-peers/dup-a',
    ...over,
  })
  test('same cwd re-provision is a no-op (allowed)', async () => {
    await upsertPeer(base(), opts())
    await upsertPeer(base(), opts()) // idempotent same-cwd
    expect(findPeer(readPeersIndex(opts()), 'dup')!.cwd).toBe('/tmp/iapeer-peers/dup-a')
  })
  test('a DIFFERENT cwd for the same personality THROWS (no silent identity split)', async () => {
    await upsertPeer(base(), opts())
    await expect(upsertPeer(base({ cwd: '/tmp/iapeer-peers/dup-b' }), opts())).rejects.toThrow(
      /already exists at .* refusing to re-point/,
    )
    expect(findPeer(readPeersIndex(opts()), 'dup')!.cwd).toBe('/tmp/iapeer-peers/dup-a') // original intact
  })
})

describe('В33 updatePeersIndex refuses to publish an unreadable index', () => {
  test('a DUPLICATE personality is rejected before write (registry stays readable)', async () => {
    await upsertPeer(
      { personality: 'p', runtime: 'claude', intelligence: 'artificial', cwd: '/tmp/iapeer-peers/p' },
      opts(),
    )
    await expect(
      updatePeersIndex(index => ({ ...index, peers: [...index.peers, { ...index.peers[0]! }] }), opts()),
    ).rejects.toThrow(/duplicate peer/)
    expect(readPeersIndex(opts()).peers).toHaveLength(1) // NOT corrupted — still one readable peer
  })
  test('an EMPTY cwd is rejected before write', async () => {
    await upsertPeer(
      { personality: 'q', runtime: 'claude', intelligence: 'artificial', cwd: '/tmp/iapeer-peers/q' },
      opts(),
    )
    await expect(
      updatePeersIndex(index => ({ ...index, peers: index.peers.map(p => ({ ...p, cwd: '' })) }), opts()),
    ).rejects.toThrow(/empty cwd/)
    expect(readPeersIndex(opts()).peers[0]!.cwd).toBe('/tmp/iapeer-peers/q') // unchanged
  })
})
