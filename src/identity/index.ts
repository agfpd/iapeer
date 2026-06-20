// Identity — peer-profile.json R/W with field preservation, per-process identity
// resolution (resolveIdentity, for runtime adapters) and per-REQUEST identity
// resolution (resolveCallerIdentity, for the always-on daemon — NO process.cwd()).
// Consolidated from inter-agent-protocol/src/lib/identity.ts (wins), with the H1
// blueprint-v2 fix on writePeerProfileAtomic (never downgrade intelligence /
// wipe description without an explicit new value). Path helpers moved to storage.

import { basename, join, resolve } from 'path'
import { existsSync, readFileSync, realpathSync } from 'fs'
import {
  IAPEER_DIR,
  PEER_PROFILE_FILE,
  NAME_RE,
  defaultIntelligenceForRuntime,
  isInfraRuntime,
  isRuntime,
  isValidName,
  normalizeIntelligenceValue,
  normalizeNameCandidate,
  type Intelligence,
  type Runtime,
} from '../core/constants.ts'
// Provision-time only: an INFRA peer (notifier/telegram) is held live by launchd
// KeepAlive, so creating one installs its always-on plist. Imported from the
// launchd module directly (not the launch barrel) to keep the dependency surface
// minimal — launchd.ts pulls only core/*, so identity → launch introduces no cycle.
import { installAlwaysOnPlist } from '../launch/launchd.ts'
import { buildProcessAddress } from '../core/socket.ts'
import { IapError } from '../core/errors.ts'
import {
  ensureLocalIapScaffold,
  ensureLocalRuntimeScopes,
  listRuntimeScopeNames,
  peerProfilePath,
  writeFileAtomic,
} from '../storage/index.ts'
import {
  findPeer,
  readPeersIndex,
  updatePeersIndex,
  type PeerInterfaces,
  type PeerRecord,
  type PeersIndex,
  type PeersUpdateOptions,
} from '../registry/index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Per-peer wake policy. `ephemeral` = stateless worker: every delivery is handled in
 *  a FRESH session, the peer dies after its turn, and a delivery to a still-live session
 *  is QUEUED (serial) rather than injected — so each task gets a clean context window.
 *  Lifecycle-owned (resolveWakeMode forces fresh; superviseTick reaps post-turn; the
 *  daemon drains the queue on death). Absent = normal warm-on-demand (resume-eligible).
 *  Enum (not bool) to leave room for future policies. */
export type WakePolicy = 'ephemeral'

export interface PeerProfile {
  personality: string
  runtime: Runtime
  runtimes: Runtime[]
  description: string
  intelligence: Intelligence
  /** C2 — launch-seed (contract ЖЦ §initial_prompt, iapeer/lifecycle-owned). Opt;
   *  default empty. Injected as the FIRST turn on ANY fresh session (not resume/
   *  warm). Carries an opening directive and/or a "I'm up" report. */
  initial_prompt?: string
  interfaces?: PeerInterfaces
  /** Per-peer wake policy (lifecycle-owned). Absent = normal warm-on-demand. */
  wake_policy?: WakePolicy
}

// Write shape: intelligence/description optional so a caller can write a profile
// WITHOUT asserting an intelligence (→ existing on-disk value is preserved). A
// full PeerProfile is assignable to this, so existing callers keep working.
export type PeerProfileWrite = Omit<PeerProfile, 'intelligence' | 'description'> & {
  intelligence?: Intelligence
  description?: string
}

export interface KnownPeerForProfile {
  personality: string
  cwd: string
}

export interface Identity {
  personality: string
  runtime: Runtime
  address: `${Runtime}-${string}`
  description: string
  intelligence: Intelligence
  cwd: string
  profilePath: string
  profile: PeerProfile
}

export interface CallerIdentity {
  personality: string
  runtime: Runtime
}

export interface ResolveIdentityOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  profile?: PeerProfile
}

export interface EnsurePeerProfileOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  runtime: Runtime
  peers?: readonly KnownPeerForProfile[]
  warn?: (message: string) => void
  /** Explicit personality (validated/normalized) instead of deriving from
   *  basename(cwd). A collision with another cwd throws (no silent suffixing —
   *  the caller named it deliberately). */
  personality?: string
  /** For an INFRA runtime: absolute path to the runtime launcher, baked into the
   *  always-on plist so launchd's minimal PATH resolves it. Forwarded to
   *  installAlwaysOnPlist; ignored for warm-on-demand runtimes. */
  runtimeBin?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

function validatePersonality(raw: string, source: string): string {
  const value = normalizeNameCandidate(raw)
  if (!isValidName(value)) {
    throw new IapError(`${source} must match /^[a-z][a-z0-9-]{0,31}$/, got "${raw}"`)
  }
  return value
}

function validateRuntime(raw: unknown, source: string): Runtime {
  if (!isRuntime(raw)) {
    throw new IapError(
      `${source} must be a runtime id matching /^[a-z][a-z0-9]{0,31}$/, got "${String(raw ?? '')}"`,
    )
  }
  return raw
}

function uniqueRuntimes(values: readonly Runtime[]): Runtime[] {
  const out: Runtime[] = []
  for (const value of values) if (!out.includes(value)) out.push(value)
  return out
}

function normalizeRuntimes(raw: unknown, runtime: Runtime): Runtime[] {
  if (!Array.isArray(raw)) return [runtime]
  const runtimes = raw.map(item => validateRuntime(item, 'peer-profile runtimes item'))
  return uniqueRuntimes([runtime, ...runtimes])
}

function normalizeInterfaces(raw: unknown, source: string): PeerInterfaces | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IapError(`${source} interfaces must be a JSON object`)
  }
  return raw as PeerInterfaces
}

function normalizeIntelligence(raw: unknown, runtime: Runtime): Intelligence {
  if (raw === undefined || raw === null || raw === '') return defaultIntelligenceForRuntime(runtime)
  // READ-COMPAT: accept contract artificial/natural/absent and legacy
  // human→natural / scripted→absent off a live profile (no rewrite of the fleet).
  const normalized = normalizeIntelligenceValue(raw)
  if (!normalized) {
    throw new IapError(
      `peer-profile intelligence must be one of artificial|natural|absent (legacy human|scripted accepted), got "${String(raw)}"`,
    )
  }
  return normalized
}

// ─────────────────────────────────────────────────────────────────────────────
// Read / write peer-profile.json
// ─────────────────────────────────────────────────────────────────────────────

export function discoverPeerRuntimes(cwd: string, currentRuntime: Runtime): Runtime[] {
  const discovered: Runtime[] = [currentRuntime]
  if (existsSync(join(cwd, '.claude'))) discovered.push('claude')
  if (existsSync(join(cwd, '.codex'))) discovered.push('codex')
  discovered.push(...listRuntimeScopeNames(cwd))
  return uniqueRuntimes(discovered)
}

export function readPeerProfile(cwd: string = process.cwd()): PeerProfile | null {
  const path = peerProfilePath(cwd)
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new IapError(
      `${IAPEER_DIR}/${PEER_PROFILE_FILE} is invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IapError(`${IAPEER_DIR}/${PEER_PROFILE_FILE} must be a JSON object`)
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.personality !== 'string' || !obj.personality.trim()) {
    throw new IapError(`${IAPEER_DIR}/${PEER_PROFILE_FILE} personality is required`)
  }
  // personality is a SYSTEM MIRROR (contract Идентичность): the canonical value is
  // normalize(basename(cwd)). The stored field is read+normalized here; a mismatch
  // with the cwd-derived name is SURFACED by validateProfileStandard (a self-heal WARN)
  // rather than silently overridden on read — the read-time override conflicts with
  // the `iapeer init --personality` override (a deliberately-named peer in a folder
  // whose basename differs), so the heal stays a flagged drift, not a silent rewrite.
  const personality = validatePersonality(obj.personality, 'peer-profile personality')
  // default_runtime is the contract field name (the routing/wake/first-launch default). Phase-3:
  // foundation no longer WRITES the legacy `runtime` mirror (see writePeerProfileAtomic), but the
  // read-fallback is KEPT as a dormant defensive net — it tolerates a legacy-shaped profile (restored
  // backup / hand-edit) at a 1-token cost. All real writers emit default_runtime (foundation +
  // telegram-runtime 0.19.4). Consistent with the registry read-fallback (§3 defensive keep).
  const runtime = validateRuntime(obj.default_runtime ?? obj.runtime, 'peer-profile default_runtime')
  const interfaces = normalizeInterfaces(obj.interfaces, `${IAPEER_DIR}/${PEER_PROFILE_FILE}`)
  const intelligence = normalizeIntelligence(obj.intelligence, runtime)
  return {
    personality,
    runtime,
    runtimes: normalizeRuntimes(obj.runtimes, runtime),
    description: typeof obj.description === 'string' ? obj.description.trim() : '',
    intelligence,
    // C2 — initial_prompt (launch-seed). A non-string/absent value → omitted (empty).
    ...(typeof obj.initial_prompt === 'string' && obj.initial_prompt
      ? { initial_prompt: obj.initial_prompt }
      : {}),
    ...(interfaces ? { interfaces } : {}),
    // Wake policy — only the known enum value is honored; anything else → omitted
    // (treated as normal warm-on-demand, never throws on an unknown future value).
    ...(obj.wake_policy === 'ephemeral' ? { wake_policy: 'ephemeral' as const } : {}),
  }
}

/**
 * Atomically write peer-profile.json, preserving fields the foundation does not
 * own (e.g. persistent-peer's initial_prompt/aliases section) via a raw read-
 * before-write merge.
 *
 * H1 (blueprint-v2): the write NEVER lowers intelligence nor wipes a non-empty
 * description without an explicit new value:
 *  - intelligence absent in the write input → inherit existing on-disk value
 *    (only a brand-new profile falls to the runtime default).
 *  - description absent/empty in the write input → keep existing.
 * The profile file (basename peer-profile.json) is allowed through
 * storage.writeFileAtomic; only peers-profiles.json is guarded there.
 */
export function writePeerProfileAtomic(cwd: string, profile: PeerProfileWrite): void {
  ensureLocalIapScaffold(cwd)
  const path = peerProfilePath(cwd)

  let existing: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch {
    // absent or invalid — only known fields are written; no unknown loss
  }

  // H1 + NO-MIGRATION: when the write does not assert an intelligence, preserve
  // the existing on-disk value VERBATIM — including a legacy human/scripted value.
  // Normalizing-then-writing would silently migrate the live fleet; read-compat
  // happens on READ (readPeerProfile), the write must not rewrite live data. Only
  // a brand-new profile (no recognizable existing value) falls to the default.
  const existingNormalized =
    typeof existing.intelligence === 'string' ? normalizeIntelligenceValue(existing.intelligence) : undefined
  const existingIntelligenceRaw = existingNormalized !== undefined ? (existing.intelligence as string) : undefined
  // Raw-preserve symmetrically to the registry boundary: an asserted intelligence adopts
  // a NEW raw ONLY when it changes the NATURE. If it re-asserts the existing nature (e.g.
  // ensurePeerProfile's merge-runtimes rewrite or renamePeer, both carrying the
  // read-normalized value), keep the existing legacy raw verbatim — the write must never
  // migrate live data; read-compat happens on READ (readPeerProfile).
  const assertedNormalized =
    profile.intelligence !== undefined ? normalizeIntelligenceValue(profile.intelligence) : undefined
  const intelligence: string =
    assertedNormalized !== undefined
      ? existingIntelligenceRaw !== undefined && assertedNormalized === existingNormalized
        ? existingIntelligenceRaw
        : (profile.intelligence as string)
      : existingIntelligenceRaw ?? defaultIntelligenceForRuntime(profile.runtime)

  const explicitDescription = profile.description?.trim() ? profile.description.trim() : undefined
  const existingDescription =
    typeof existing.description === 'string' ? existing.description : undefined
  const description = explicitDescription ?? existingDescription ?? ''

  const merged: Record<string, unknown> = {
    ...existing,
    personality: profile.personality,
    // Phase-3 (default_runtime migration complete): emit ONLY the contract field `default_runtime` —
    // the legacy `runtime` mirror is removed. All readers switched: telegram-runtime 0.19.4 reads
    // default_runtime and no longer re-seeds the mirror on mutation; foundation reads default_runtime.
    default_runtime: profile.runtime,
    runtimes: profile.runtimes,
    description,
    intelligence,
    ...(profile.interfaces ? { interfaces: profile.interfaces } : {}),
  }
  // Phase-3: actively STRIP the legacy `runtime` mirror — it is a CONTRACT field superseded by
  // default_runtime (not an owner field to preserve via `...existing`). This removes a lingering mirror
  // on the next write of any already-migrated profile AND heals a diverged `runtime` (default_runtime
  // governs). Owner sections (initial_prompt, wake_policy, expansion, notifier, …) stay preserved.
  delete merged.runtime
  // C2 — initial_prompt: an explicit value in the write wins; otherwise the existing
  // on-disk value is preserved verbatim by `...existing` (a caller that doesn't own
  // it never wipes it). Only a non-empty string sets it.
  if (typeof profile.initial_prompt === 'string' && profile.initial_prompt) {
    merged.initial_prompt = profile.initial_prompt
  }
  writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`)
}

// ─────────────────────────────────────────────────────────────────────────────
// cwd canonicalization (identity comparison)
// ─────────────────────────────────────────────────────────────────────────────

function canonicalCwd(p: string): string {
  const resolved = resolve(p)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

export function sameCwd(a: string, b: string): boolean {
  const ca = canonicalCwd(a)
  const cb = canonicalCwd(b)
  if (ca === cb) return true
  return ca.toLowerCase() === cb.toLowerCase()
}

function peerCollision(
  personality: string,
  cwd: string,
  peers: readonly KnownPeerForProfile[],
): KnownPeerForProfile | null {
  return peers.find(peer => peer.personality === personality && !sameCwd(peer.cwd, cwd)) ?? null
}

/**
 * The personality derived from basename(cwd), validated and checked for collision
 * — FAIL-CLOSED, never silently suffixed. Contract (docs/Идентичность, Уникальность):
 * "занятое имя у ДРУГОГО живого cwd → fail closed (оператору «переименуй папку»),
 * без молчаливого авто-суффикса. Одна личность — одна папка." A silent `-2` suffix
 * would split one logical identity across two folders (the very "раздвоение" the
 * 1:1 personality↔cwd invariant forbids) and bind the peer to a name the operator
 * never chose. So a collision is surfaced LOUDLY: the operator renames the folder
 * (mv cwd → recompute) to resolve it deliberately.
 */
function chooseUniquePersonality(
  base: string,
  cwd: string,
  peers: readonly KnownPeerForProfile[],
): string {
  if (!NAME_RE.test(base)) {
    throw new IapError(
      `cannot derive peer personality from cwd basename "${basename(cwd)}"; create ${IAPEER_DIR}/${PEER_PROFILE_FILE} explicitly`,
    )
  }
  const collision = peerCollision(base, cwd, peers)
  if (collision) {
    throw new IapError(
      `personality "${base}" (from cwd basename) already belongs to ${collision.cwd}; ` +
        `personality ↔ cwd is 1:1 — rename this folder (mv) so its basename normalizes to a free name, then re-init. No silent auto-suffix.`,
    )
  }
  return base
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-process runtime / identity resolution (runtime adapters; cwd-bound)
// ─────────────────────────────────────────────────────────────────────────────

function detectRuntimeFromEnv(env: NodeJS.ProcessEnv): Runtime | null {
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX) return 'codex'
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_SESSION_ID) return 'claude'
  return null
}

function runtimeFromPeerIdentity(identity: string | undefined): Runtime | null {
  const value = identity?.trim()
  if (!value) return null
  const dash = value.indexOf('-')
  if (dash <= 0) return null
  const candidate = value.slice(0, dash)
  return isRuntime(candidate) ? candidate : null
}

export function resolveRuntime(
  profile: PeerProfile | null,
  env: NodeJS.ProcessEnv = process.env,
): Runtime {
  const identityRuntime = runtimeFromPeerIdentity(env.PEER_IDENTITY)
  if (identityRuntime) return identityRuntime
  if (profile?.runtime) return profile.runtime
  if (env.PEER_RUNTIME?.trim()) return validateRuntime(env.PEER_RUNTIME, 'PEER_RUNTIME')
  const detected = detectRuntimeFromEnv(env)
  if (detected) return detected
  throw new IapError(
    `cannot resolve runtime, set PEER_RUNTIME or create ${IAPEER_DIR}/${PEER_PROFILE_FILE}`,
  )
}

export function ensurePeerProfile(options: EnsurePeerProfileOptions): PeerProfile {
  const cwd = resolve(options.cwd ?? process.cwd())
  const peers = options.peers ?? []
  ensureLocalIapScaffold(cwd)
  const discoveredRuntimes = discoverPeerRuntimes(cwd, options.runtime)
  const existing = readPeerProfile(cwd)
  if (!existing) {
    let personality: string
    if (options.personality !== undefined) {
      personality = validatePersonality(options.personality, 'personality')
      // INVARIANT (personality ↔ folder is 1:1): an explicitly-supplied personality MUST
      // equal the normalized cwd basename. Otherwise the registry record (personality) and
      // a manual `cd <cwd>; <runtime>` session (which self-derives identity from the cwd
      // basename) would disagree. The only ways to reach a mismatch are a runtime manifest
      // `peers[].path` or `create --path <dir>` whose basename ≠ personality — both are
      // misconfigurations, surfaced loudly here rather than written as a latent drift.
      const expected = normalizeNameCandidate(basename(cwd))
      if (personality !== expected) {
        throw new IapError(
          `personality "${personality}" must equal the normalized cwd basename "${expected}" ` +
            `(personality ↔ folder is 1:1) — name the folder to match, or drop the explicit name. cwd: ${cwd}`,
        )
      }
      const collision = peerCollision(personality, cwd, peers)
      if (collision) {
        throw new IapError(
          `personality "${personality}" already belongs to ${collision.cwd}; choose another`,
        )
      }
    } else {
      // FAIL-CLOSED on collision (no silent auto-suffix) — chooseUniquePersonality
      // throws when basename(cwd) normalizes to a name another cwd already holds.
      personality = chooseUniquePersonality(normalizeNameCandidate(basename(cwd)), cwd, peers)
    }
    // Audit #20: honor the PEER_PERSONALITY env gate on the NEW-profile branch too (it
    // existed only on the existing-profile branch) — a mismatched env identity must not
    // silently create a profile under a different personality.
    if (
      options.env?.PEER_PERSONALITY?.trim() &&
      normalizeNameCandidate(options.env.PEER_PERSONALITY) !== personality
    ) {
      throw new IapError(
        `PEER_PERSONALITY "${options.env.PEER_PERSONALITY}" does not match the peer being initialized ("${personality}")`,
      )
    }
    const profile: PeerProfile = {
      personality,
      runtime: options.runtime,
      runtimes: discoveredRuntimes,
      description: '',
      intelligence: defaultIntelligenceForRuntime(options.runtime),
    }
    ensureLocalRuntimeScopes(cwd, profile.runtimes)
    // INFRA runtime → provision the always-on launchd plist that holds it live.
    // BEFORE writing the profile so a collision-guard refusal (the chosen
    // com.iapeer.<personality> Label already belongs to a foreign / PP-managed
    // plist) fails the provision LOUDLY and leaves no half-created peer-profile.json
    // behind — instead of silently clobbering a live persistent-peer's plist (H4).
    // Warm-on-demand runtimes (claude/codex) are daemon-managed → no plist (unchanged).
    if (isInfraRuntime(options.runtime)) {
      installAlwaysOnPlist({
        personality,
        runtime: options.runtime,
        cwd,
        runtimeBin: options.runtimeBin,
        env: options.env,
      })
    }
    writePeerProfileAtomic(cwd, profile)
    return profile
  }

  const collision = peerCollision(existing.personality, cwd, peers)
  if (collision) {
    throw new IapError(
      `personality collision: "${existing.personality}" already belongs to ${collision.cwd}; change ${IAPEER_DIR}/${PEER_PROFILE_FILE}`,
    )
  }
  if (
    options.env?.PEER_PERSONALITY?.trim() &&
    normalizeNameCandidate(options.env.PEER_PERSONALITY) !== existing.personality
  ) {
    throw new IapError(
      `PEER_PERSONALITY must match ${IAPEER_DIR}/${PEER_PROFILE_FILE} personality "${existing.personality}", got "${options.env.PEER_PERSONALITY}"`,
    )
  }
  const mergedRuntimes = uniqueRuntimes([...existing.runtimes, ...discoveredRuntimes])
  ensureLocalRuntimeScopes(cwd, mergedRuntimes)
  // RE-PROVISION parity with the new-profile branch: an EXISTING infra peer (a
  // migration / re-provision — e.g. `iapeer create alice --runtime telegram` to move
  // a live telegram human onto the foundation) must ALSO get its always-on plist
  // installed and its intelligence set to the runtime's foundation default
  // (telegram→natural, notifier→absent). The old code only merged runtimes here, so
  // re-provisioning an infra peer wrote NO plist (bootstrap → refused-foreign on the
  // missing plist) and left a stale legacy intelligence — the cutover had to
  // install the plist + flip vocab by hand. Install BEFORE the write so a
  // collision-guard refusal (a foreign plist still sitting at the label) fails loudly
  // and leaves no half-updated profile. Idempotent for our own (sentinel) plist.
  let intelligence = existing.intelligence
  if (isInfraRuntime(options.runtime)) {
    installAlwaysOnPlist({
      personality: existing.personality,
      runtime: options.runtime,
      cwd,
      runtimeBin: options.runtimeBin,
      env: options.env,
    })
    intelligence = defaultIntelligenceForRuntime(options.runtime)
  }
  if (mergedRuntimes.length !== existing.runtimes.length || intelligence !== existing.intelligence) {
    const updated = { ...existing, runtimes: mergedRuntimes, intelligence }
    writePeerProfileAtomic(cwd, updated)
    return updated
  }
  return existing
}

function assertPeerIdentity(env: NodeJS.ProcessEnv, address: string): void {
  if (!env.PEER_IDENTITY?.trim()) return
  if (env.PEER_IDENTITY !== address) {
    throw new IapError(
      `PEER_IDENTITY must equal PEER_RUNTIME + "-" + PEER_PERSONALITY (${address}), got "${env.PEER_IDENTITY}"`,
    )
  }
}

export function resolveIdentity(options: ResolveIdentityOptions = {}): Identity {
  const cwd = resolve(options.cwd ?? process.cwd())
  const env = options.env ?? process.env
  const profile = options.profile ?? readPeerProfile(cwd)
  if (!profile) {
    throw new IapError(
      `cannot resolve identity without ${IAPEER_DIR}/${PEER_PROFILE_FILE}; run from an initialized peer cwd`,
    )
  }
  if (
    env.PEER_PERSONALITY?.trim() &&
    normalizeNameCandidate(env.PEER_PERSONALITY) !== profile.personality
  ) {
    throw new IapError(
      `PEER_PERSONALITY must match ${IAPEER_DIR}/${PEER_PROFILE_FILE} personality "${profile.personality}", got "${env.PEER_PERSONALITY}"`,
    )
  }
  const runtime = resolveRuntime(profile, env)
  const personality = profile.personality
  const address = buildProcessAddress(runtime, personality)
  assertPeerIdentity(env, address)
  return {
    personality,
    runtime,
    address,
    description: profile.description,
    intelligence: profile.intelligence,
    cwd,
    profilePath: peerProfilePath(cwd),
    profile,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-REQUEST identity resolution (daemon) — NO process.cwd(), NO local profile
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedCaller {
  personality: string
  runtime: Runtime
  address: `${Runtime}-${string}`
  description: string
  intelligence: Intelligence
  cwd: string
  record: PeerRecord
}

/**
 * Resolve a caller identity carried IN THE REQUEST (X-IAPeer-Identity), against
 * the registry only. Deliberately does NOT read process.cwd(), process.env, or
 * the local peer-profile.json — the always-on daemon has no single cwd, so the
 * caller MUST carry its own identity (blueprint §0.2, §5.1). The registry record
 * is the authority for cwd/description/intelligence/runtimes.
 *
 * Spoofing guard (minimum, per blueprint §5.1): the personality must exist in
 * the registry and the runtime must be one it declares.
 */
export function resolveCallerIdentity(
  caller: CallerIdentity,
  index: PeersIndex = readPeersIndex(),
): ResolvedCaller {
  if (!isValidName(caller.personality)) {
    throw new IapError(
      `invalid caller personality "${caller.personality}" — must match /^[a-z][a-z0-9-]{0,31}$/`,
    )
  }
  const runtime = validateRuntime(caller.runtime, 'caller runtime')
  const record = findPeer(index, caller.personality)
  if (!record) {
    throw new IapError(`unknown caller "${caller.personality}" — not registered in peers-profiles.json`)
  }
  const declared = record.runtime === runtime || record.runtimes.includes(runtime)
  if (!declared) {
    throw new IapError(
      `runtime "${runtime}" is not declared for caller "${caller.personality}" (declared: ${record.runtimes.join(', ')})`,
    )
  }
  return {
    personality: record.personality,
    runtime,
    address: buildProcessAddress(runtime, record.personality),
    description: record.description,
    intelligence: record.intelligence,
    cwd: record.cwd,
    record,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// renamePeer — cross-cutting (profile + registry), orchestrated above registry
// so the registry layer stays free of an identity import. The profile rewrite
// happens INSIDE the registry lock for atomicity.
// ─────────────────────────────────────────────────────────────────────────────

export async function renamePeer(
  oldPersonality: string,
  newPersonality: string,
  options: PeersUpdateOptions = {},
): Promise<PeersIndex> {
  if (!isValidName(oldPersonality) || !isValidName(newPersonality)) {
    throw new IapError('peers rename requires valid personalities')
  }
  if (oldPersonality === newPersonality) {
    throw new IapError('peers rename requires distinct old and new personality')
  }
  return updatePeersIndex(index => {
    const target = index.peers.find(peer => peer.personality === oldPersonality)
    if (!target) throw new IapError(`peer "${oldPersonality}" not found`)
    if (index.peers.some(peer => peer.personality === newPersonality)) {
      throw new IapError(`peer "${newPersonality}" already exists`)
    }
    const sourceProfile = readPeerProfile(target.cwd)
    if (!sourceProfile) {
      throw new IapError(
        `peer "${oldPersonality}" cwd ${target.cwd} has no ${IAPEER_DIR}/${PEER_PROFILE_FILE}; restore the cwd or remove the registry entry`,
      )
    }
    if (sourceProfile.personality !== oldPersonality) {
      throw new IapError(
        `peer "${oldPersonality}" cwd ${target.cwd} profile has personality "${sourceProfile.personality}", not "${oldPersonality}"; registry out of sync`,
      )
    }
    writePeerProfileAtomic(target.cwd, { ...sourceProfile, personality: newPersonality })
    return {
      ...index,
      peers: index.peers.map(peer =>
        peer.personality === oldPersonality ? { ...peer, personality: newPersonality } : peer,
      ),
    }
  }, options)
}
