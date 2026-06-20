// Registry — the global peers-profiles.json index. THE single locked writer.
// Consolidated from inter-agent-protocol/src/lib/peers.ts (wins) +
// schema-migrations.ts (inlined), with the H1 blueprint-v2 fix applied to
// upsertPeer (merge-with-existing, not full-replace).
//
// Structural invariant (#3): the ONLY function that writes peers-profiles.json
// is the module-private `writePeersIndexAtomic`, reached ONLY through
// `withPeersLock`. storage.writeFileAtomic refuses the peers basename, so there
// is no unlocked path to the registry file anywhere in the package.

import * as lockfile from 'proper-lockfile'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import {
  IAPEER_DIR,
  MAX_DESCRIPTION_LEN,
  PEERS_PROFILES_FILE,
  PEERS_SCHEMA_VERSION,
  defaultIntelligenceForRuntime,
  isIntelligence,
  isRuntime,
  isValidName,
  normalizeIntelligenceValue,
  type Intelligence,
  type Runtime,
} from '../core/constants.ts'
import { IapError } from '../core/errors.ts'
import { resolvePeersPaths, type PeersPaths, type StorageOptions } from '../storage/index.ts'

export interface PeerRecord {
  personality: string
  runtime: Runtime
  runtimes: Runtime[]
  description: string
  /** NORMALIZED intelligence (contract artificial/natural/absent) — for foundation
   *  logic (the launch nature-gate, publicPeerSummary projection, …). NOT what is
   *  persisted: the raw on-disk value is preserved via intelligenceRaw. */
  intelligence: Intelligence
  /**
   * The RAW on-disk intelligence string, preserved VERBATIM so a read→write round-trip
   * never mutates the live registry's vocabulary (the foundation read-compat maps
   * legacy human→natural / scripted→absent IN MEMORY, but persisting the mapped value
   * would corrupt the legacy IAP, which only knows human/artificial/scripted — that is
   * exactly how a foundation registry write broke the live transport). writePeersIndex
   * Atomic persists `intelligenceRaw ?? intelligence`. Symmetric to the peer-profile H1
   * preserve-verbatim write. Absent ⇒ a healed default is persisted.
   */
  intelligenceRaw?: string
  cwd: string
  interfaces?: PeerInterfaces
}

export type PeerInterfaces = Record<string, unknown>

export interface PeersIndex {
  version: number
  peers: PeerRecord[]
}

export interface PeersUpdateOptions extends StorageOptions {
  warn?: (message: string) => void
}

/**
 * The normalized PUBLIC projection of a peer — exactly the five discovery fields
 * (personality / runtime / runtimes / description / intelligence). NO cwd,
 * interfaces, or audit fields. This is the ONE shared normalizer the contract
 * mandates ("форма — общая функция нормализации `publicPeerSummary`"): it feeds
 * BOTH the send_to_peer tool description (daemon) AND the registry layer (Слой 3)
 * of the composed system prompt, so the two can never drift.
 */
export interface PublicPeerSummary {
  personality: string
  runtime: Runtime
  runtimes: Runtime[]
  description: string
  intelligence: Intelligence
}

export function publicPeerSummary(peer: PeerRecord): PublicPeerSummary {
  return {
    personality: peer.personality,
    runtime: peer.runtime,
    runtimes: peer.runtimes,
    description: peer.description,
    intelligence: peer.intelligence,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema migration (was schema-migrations.ts)
// ─────────────────────────────────────────────────────────────────────────────

export function migratePeersIndex(index: PeersIndex): PeersIndex {
  if (index.version === PEERS_SCHEMA_VERSION) return index
  if (index.version < PEERS_SCHEMA_VERSION) {
    return { ...index, version: PEERS_SCHEMA_VERSION }
  }
  return index
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation / normalization
// ─────────────────────────────────────────────────────────────────────────────

export function emptyPeersIndex(): PeersIndex {
  return { version: PEERS_SCHEMA_VERSION, peers: [] }
}

export function clampDescription(value: string): { description: string; truncated: boolean } {
  if (value.length <= MAX_DESCRIPTION_LEN) return { description: value, truncated: false }
  return { description: value.slice(0, MAX_DESCRIPTION_LEN), truncated: true }
}

function ensurePersonality(personality: string): void {
  if (!isValidName(personality)) {
    throw new IapError(
      `invalid personality "${personality}" — must match /^[a-z][a-z0-9-]{0,31}$/`,
    )
  }
}

function ensureRuntime(runtime: string): Runtime {
  if (!isRuntime(runtime)) {
    throw new IapError(`invalid runtime "${runtime}" — must match /^[a-z][a-z0-9]{0,31}$/`)
  }
  return runtime
}

function ensureRuntimes(runtimes: readonly string[], runtime: Runtime): Runtime[] {
  const out: Runtime[] = []
  for (const value of [runtime, ...runtimes]) {
    const checked = ensureRuntime(value)
    if (!out.includes(checked)) out.push(checked)
  }
  return out
}

function normalizeInterfaces(raw: unknown, peerName: string): PeerInterfaces | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IapError(`peers-profiles.json corrupted: peer "${peerName}" interfaces must be an object`)
  }
  return raw as PeerInterfaces
}

function normalizePeer(raw: unknown): PeerRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IapError('peers-profiles.json corrupted: peer entry is not an object')
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.personality !== 'string' || !isValidName(obj.personality)) {
    throw new IapError(
      `peers-profiles.json corrupted: peer personality must match /^[a-z][a-z0-9-]{0,31}$/, got "${String(
        obj.personality ?? '',
      )}"`,
    )
  }
  // default_runtime is the contract field. Phase-3 (registry): foundation no longer WRITES the legacy
  // `runtime` mirror (see writePeersIndexAtomic), but the read-fallback is KEPT as a dormant defensive
  // net — it tolerates a legacy-shaped entry (restored backup / hand-edit) at a 1-token cost. All real
  // readers switched (telegram → default_runtime, notifier → cwd-only); registry is single-writer so
  // new entries are default_runtime-only. Full fallback removal is a future final cleanup.
  const defaultRuntime = obj.default_runtime ?? obj.runtime
  if (!isRuntime(defaultRuntime)) {
    throw new IapError(
      `peers-profiles.json corrupted: peer "${obj.personality}" default_runtime must match /^[a-z][a-z0-9]{0,31}$/`,
    )
  }
  const runtimes = Array.isArray(obj.runtimes)
    ? ensureRuntimes(obj.runtimes.filter(item => typeof item === 'string') as string[], defaultRuntime)
    : [defaultRuntime]
  const { description } = clampDescription(typeof obj.description === 'string' ? obj.description : '')
  if (typeof obj.cwd !== 'string' || !obj.cwd.trim()) {
    throw new IapError(`peers-profiles.json corrupted: peer "${obj.personality}" cwd is required`)
  }
  // Legacy/soft pre-migration: a missing/empty intelligence is healed to the
  // runtime default. A present value is READ-COMPAT normalized (contract
  // artificial/natural/absent, legacy human→natural / scripted→absent) so the
  // foundation reads the live registry correctly before the data migration.
  let intelligence: Intelligence
  let intelligenceRaw: string | undefined
  if (obj.intelligence === undefined || obj.intelligence === null || obj.intelligence === '') {
    intelligence = defaultIntelligenceForRuntime(defaultRuntime)
    // no raw on disk → a healed default will be persisted
  } else {
    const normalized = normalizeIntelligenceValue(obj.intelligence)
    if (!normalized) {
      throw new IapError(
        `peers-profiles.json corrupted: peer "${obj.personality}" intelligence must be one of artificial|natural|absent (legacy human|scripted accepted), got "${String(obj.intelligence)}"`,
      )
    }
    intelligence = normalized
    intelligenceRaw = obj.intelligence as string // PRESERVE the on-disk vocab verbatim (legacy-safe)
  }
  const interfaces = normalizeInterfaces(obj.interfaces, obj.personality)
  return {
    personality: obj.personality,
    runtime: defaultRuntime,
    runtimes,
    description,
    intelligence,
    ...(intelligenceRaw !== undefined ? { intelligenceRaw } : {}),
    cwd: obj.cwd,
    ...(interfaces ? { interfaces } : {}),
  }
}

export function normalizePeersIndex(raw: unknown): PeersIndex {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IapError('peers-profiles.json corrupted, restore from backup or delete to start fresh')
  }
  const obj = raw as Record<string, unknown>
  const version =
    typeof obj.version === 'number' && Number.isInteger(obj.version) ? obj.version : PEERS_SCHEMA_VERSION
  const peersRaw = Array.isArray(obj.peers) ? obj.peers : []
  const personalities = new Set<string>()
  const peers = peersRaw.map(normalizePeer)
  for (const peer of peers) {
    if (personalities.has(peer.personality)) {
      throw new IapError(`peers-profiles.json corrupted: duplicate peer "${peer.personality}"`)
    }
    personalities.add(peer.personality)
  }
  return migratePeersIndex({ version, peers })
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

export function readPeersIndex(options: StorageOptions = {}): PeersIndex {
  const { peersFile } = resolvePeersPaths(options)
  if (!existsSync(peersFile)) return emptyPeersIndex()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(peersFile, 'utf8'))
  } catch (e) {
    throw new IapError(
      `peers-profiles.json corrupted, restore from backup or delete to start fresh: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }
  const index = normalizePeersIndex(raw)
  if (index.version > PEERS_SCHEMA_VERSION) {
    process.stderr.write(
      `iapeer: warning: peers-profiles.json version ${index.version} is newer than supported ${PEERS_SCHEMA_VERSION}; reading known fields only\n`,
    )
  }
  return index
}

export function findPeer(index: PeersIndex, personality: string): PeerRecord | null {
  return index.peers.find(peer => peer.personality === personality) ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// Locked write (THE single writer)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fail-closed test/sandbox isolation (incident 2026-06-08): a test or sandbox
 * run that resolves the registry to the REAL `~/.iapeer` would normalize the
 * live fleet's vocab on the next write (the incident that broke legacy IAP).
 * When IAPEER_TEST_SANDBOX=1, refuse to write the real root — the harness MUST
 * target an isolated IAPEER_ROOT. The real root is recomputed here from HOME
 * (ignoring the IAPEER_ROOT override) precisely so an unset/forgotten override
 * cannot silently fall through to it.
 */
function assertSandboxIsolated(rootDir: string, env: NodeJS.ProcessEnv): void {
  if (env.IAPEER_TEST_SANDBOX !== '1') return
  const realRoot = join(env.HOME?.trim() || homedir(), IAPEER_DIR)
  if (rootDir === realRoot) {
    throw new IapError(
      `refusing to write the REAL registry (${realRoot}) under IAPEER_TEST_SANDBOX=1 — ` +
        'a test/sandbox must set IAPEER_ROOT to an isolated path',
    )
  }
}

export async function withPeersLock<T>(
  options: StorageOptions,
  fn: (paths: PeersPaths) => T | Promise<T>,
): Promise<T> {
  if (process.platform === 'win32') {
    throw new IapError('POSIX tmux transport required, Windows support deferred')
  }
  const paths = resolvePeersPaths(options)
  assertSandboxIsolated(paths.rootDir, options.env ?? process.env)
  mkdirSync(paths.rootDir, { recursive: true, mode: 0o700 })
  writeFileSync(paths.lockTarget, '', { flag: 'a', mode: 0o600 })
  const release = await lockfile.lock(paths.lockTarget, {
    realpath: false,
    stale: 10_000,
    update: 1_000,
    retries: { retries: 13, factor: 1.4, minTimeout: 50, maxTimeout: 500 },
  })
  try {
    return await fn(paths)
  } finally {
    await release()
  }
}

/**
 * PRIVATE registry writer for peers-profiles.json. Not exported. Reached ONLY
 * from `updatePeersIndex` inside `withPeersLock`. Does its own atomic rename
 * (tmp alongside target) and deliberately does NOT route through
 * storage.writeFileAtomic (which refuses this basename) — this is the single
 * sanctioned write path for the registry file (#3).
 */
function writePeersIndexAtomic(paths: PeersPaths, index: PeersIndex): void {
  const tmp = join(paths.tmpDir, `.${PEERS_PROFILES_FILE}.${process.pid}.${randomUUID()}.tmp`)
  // Persist the RAW intelligence verbatim (legacy-safe round-trip) and DROP the
  // intelligenceRaw shadow field from the on-disk shape — the file carries the
  // legacy vocab the live IAP reads, never the foundation's in-memory normalization.
  // Phase-3 (registry): the disk shape carries ONLY the contract field `default_runtime` — the legacy
  // `runtime` mirror is removed (all registry readers switched: telegram → default_runtime, notifier →
  // cwd-only, foundation → default_runtime). Local per-peer profiles keep their mirror until the paired
  // telegram writePeerProfile follow-up.
  const peersForDisk = [...index.peers]
    .sort((a, b) => a.personality.localeCompare(b.personality))
    .map(peer => ({
      personality: peer.personality,
      default_runtime: peer.runtime,
      runtimes: peer.runtimes,
      description: peer.description,
      intelligence: peer.intelligenceRaw ?? peer.intelligence,
      cwd: peer.cwd,
      ...(peer.interfaces ? { interfaces: peer.interfaces } : {}),
    }))
  const normalized = { version: PEERS_SCHEMA_VERSION, peers: peersForDisk }
  writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, paths.peersFile)
}

export async function updatePeersIndex(
  updater: (index: PeersIndex) => PeersIndex,
  options: PeersUpdateOptions = {},
): Promise<PeersIndex> {
  return withPeersLock(options, paths => {
    const current = readPeersIndex({ ...options, rootDir: paths.rootDir })
    const next = updater(current)
    writePeersIndexAtomic(paths, next)
    return next
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// upsertPeer — H1 merge-with-existing (blueprint-v2 §H1)
// ─────────────────────────────────────────────────────────────────────────────

export interface UpsertPeerArgs {
  personality: string
  runtime: string
  runtimes?: readonly string[]
  description?: string
  intelligence?: Intelligence
  interfaces?: PeerInterfaces
  cwd: string
}

export async function upsertPeer(
  args: UpsertPeerArgs,
  options: PeersUpdateOptions = {},
): Promise<PeersIndex> {
  ensurePersonality(args.personality)
  const runtime = ensureRuntime(args.runtime)

  // Validate an explicitly-supplied intelligence eagerly (fail before locking). Accept
  // BOTH the contract vocab (artificial/natural/absent) AND the legacy vocab the READ
  // path accepts (human/scripted): a caller forwarding a raw legacy value must not be
  // rejected. normalizeIntelligenceValue maps it to the contract value (used for the
  // `intelligence` field); the raw is preserved verbatim below.
  let argsIntelligence: Intelligence | undefined
  let argsIntelligenceRaw: string | undefined
  if (args.intelligence !== undefined) {
    const normalized = normalizeIntelligenceValue(args.intelligence)
    if (!normalized) {
      throw new IapError(
        `invalid intelligence "${String(args.intelligence)}" — must be one of artificial|natural|absent (legacy human|scripted accepted)`,
      )
    }
    argsIntelligence = normalized
    argsIntelligenceRaw = String(args.intelligence)
  }

  // Clamp an explicitly-supplied description (and warn) before the lock. An
  // empty / whitespace-only description is treated as "not provided" so a boot
  // upsert carrying an empty profile.description does NOT wipe a meaningful
  // existing registry description (blueprint-v2 §H1 note). To deliberately clear
  // a description, a caller removes the peer and re-adds it — not by passing ''.
  let argsDescription: string | undefined
  if (args.description !== undefined && args.description.trim()) {
    const { description, truncated } = clampDescription(args.description)
    if (truncated) options.warn?.(`description exceeded ${MAX_DESCRIPTION_LEN} chars and was truncated`)
    argsDescription = description
  }

  return updatePeersIndex(index => {
    const existing = index.peers.find(peer => peer.personality === args.personality)

    // H1 merge-with-existing: a field ABSENT from args inherits from `existing`,
    // NOT from a runtime default. The runtime default applies ONLY to a brand-new
    // peer (no existing). This is what stops a claude-boot upsert (no intelligence)
    // from downgrading a human telegram peer to artificial.
    const intelligence: Intelligence =
      argsIntelligence !== undefined
        ? argsIntelligence
        : existing?.intelligence ?? defaultIntelligenceForRuntime(runtime)
    // Preserve the on-disk vocab. An explicit args value adopts a NEW raw ONLY when it
    // changes the NATURE; if it merely re-asserts the existing peer's nature (e.g.
    // provisionPeer forwarding the read-normalized 'natural' for a legacy 'human' peer
    // on a routine re-init), keep the existing legacy raw verbatim. This makes the
    // registry boundary self-defending: no caller can silently migrate a legacy peer's
    // vocab (the exact incident that broke legacy-IAP). An upsert with no intelligence
    // inherits the existing raw unchanged.
    const intelligenceRaw: string | undefined =
      argsIntelligence !== undefined
        ? existing?.intelligenceRaw !== undefined &&
          normalizeIntelligenceValue(existing.intelligenceRaw) === argsIntelligence
          ? existing.intelligenceRaw
          : argsIntelligenceRaw
        : existing?.intelligenceRaw

    const description =
      argsDescription !== undefined ? argsDescription : existing?.description ?? ''

    const interfaces = args.interfaces ?? existing?.interfaces

    // runtimes: union of existing ∪ args ∪ {runtime} (never a replace — a peer
    // already declared on telegram+claude must not lose either on a claude upsert).
    const runtimes = ensureRuntimes(
      [...(existing?.runtimes ?? []), ...(args.runtimes ?? [])],
      runtime,
    )

    const record: PeerRecord = {
      personality: args.personality,
      runtime, // args.runtime wins — caller knows the current runtime
      runtimes,
      description,
      intelligence,
      ...(intelligenceRaw !== undefined ? { intelligenceRaw } : {}),
      cwd: args.cwd, // args.cwd wins
      ...(interfaces ? { interfaces } : {}),
    }

    if (!existing) {
      return { ...index, peers: [...index.peers, record] }
    }
    return {
      ...index,
      peers: index.peers.map(peer => (peer.personality === args.personality ? record : peer)),
    }
  }, options)
}

export async function removePeer(
  personality: string,
  options: PeersUpdateOptions = {},
): Promise<PeersIndex> {
  ensurePersonality(personality)
  return updatePeersIndex(
    index => ({ ...index, peers: index.peers.filter(peer => peer.personality !== personality) }),
    options,
  )
}
