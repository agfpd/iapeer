// Profile standard — the CODE-formalized schema of peer-profile.json, the source
// of truth being the contract zone "Идентичность пира — модель, профиль, реестр".
//
// Two classes of fields (contract §"структура — два класса полей, не плоская каша"):
//   • CORE identity (foundation-owned, validated here): personality (system mirror,
//     self-heal = normalize(basename(cwd))), default_runtime (contract field; legacy
//     `runtime` accepted during the staged migration), runtimes[] (incl. the default,
//     ORDER = preference, first = primary), description, intelligence ∈
//     {artificial|natural|absent}. Optional lifecycle: initial_prompt, wake_policy.
//   • OWNER sections (validated only as well-typed, NEVER restructured here): interfaces
//     (telegram/capability passport — PASSPORT ONLY: aliases are misfiled there and the
//     contract relocates them to `expansion.aliases`, the runtime-agnostic plugin-config
//     section owned by the chat-runtime — telegram-runtime today, future discord/matrix
//     read the SAME section per the expansion design), notifier (notifier-runtime),
//     expansion (chat-runtime aliases), <plugin> sections — each plugin writes only its
//     own field via atomic merge. Plugin-config sections are NOT projected into the
//     registry index (private config is read from the LOCAL profile by its owner).
//
// peers-profiles.json is a regenerable self-heal PROJECTION of the local profiles —
// projectProfileToRecord builds the record the index SHOULD hold; verify compares the
// live index against it, reindex rewrites it. The index is never the source of truth.

import { basename } from 'path'
import { existsSync, readFileSync } from 'fs'
import { isRuntime, normalizeIntelligenceValue, normalizeNameCandidate } from '../core/constants.ts'
import {
  clampDescription,
  readPeersIndex,
  updatePeersIndex,
  type PeerRecord,
  type PeersUpdateOptions,
} from '../registry/index.ts'
import { peerProfilePath } from '../storage/index.ts'
import { readPeerProfile, writePeerProfileAtomic } from './index.ts'

export type IssueSeverity = 'error' | 'warn'
export interface ProfileIssue {
  severity: IssueSeverity
  field: string
  message: string
}

/**
 * Validate a RAW peer-profile.json object (already JSON-parsed) against the standard.
 * `cwd` is required for the personality self-heal check (the mirror must equal
 * normalize(basename(cwd))). Returns every issue found; an `error` means the profile
 * is non-conformant, a `warn` is a transition/owner note that self-heal or a later
 * owner migration resolves (a profile with only warnings still PASSES — `isConformant`).
 */
export function validateProfileStandard(raw: unknown, cwd: string): ProfileIssue[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return [{ severity: 'error', field: '<root>', message: 'peer-profile.json must be a JSON object' }]
  }
  const obj = raw as Record<string, unknown>
  const issues: ProfileIssue[] = []

  // personality — system mirror, self-healed from the cwd (never a source). A stored
  // value that disagrees is a WARN (self-heal rewrites it), not an error.
  const expected = normalizeNameCandidate(basename(cwd))
  if (typeof obj.personality !== 'string' || obj.personality !== expected) {
    issues.push({
      severity: 'warn',
      field: 'personality',
      message: `mirror "${String(obj.personality ?? '')}" ≠ normalize(basename(cwd)) "${expected}" — self-heal will rewrite`,
    })
  }

  // default_runtime (contract) / runtime (legacy, staged migration). Since the Phase-2
  // write-flip the writer emits BOTH (legacy `runtime` as an in-sync mirror); a profile
  // carrying only the legacy name, or a DIVERGED mirror (a legacy writer updated
  // `runtime` behind the contract field — dual-read ignores it), is a migration WARN.
  const dr = obj.default_runtime ?? obj.runtime
  if (!isRuntime(dr)) {
    issues.push({ severity: 'error', field: 'default_runtime', message: `must be a valid runtime id, got "${String(dr ?? '')}"` })
  } else if (obj.default_runtime === undefined) {
    issues.push({ severity: 'warn', field: 'default_runtime', message: 'legacy field name `runtime` — standard is `default_runtime` (staged migration)' })
  } else if (obj.runtime !== undefined && obj.runtime !== obj.default_runtime) {
    issues.push({
      severity: 'warn',
      field: 'default_runtime',
      message: `legacy mirror \`runtime\`="${String(obj.runtime)}" diverged from default_runtime="${String(obj.default_runtime)}" — default_runtime governs; re-run \`iapeer verify --fix\` to re-sync the mirror`,
    })
  }

  // runtimes[] — array of valid runtime ids that includes the default_runtime.
  if (!Array.isArray(obj.runtimes)) {
    issues.push({ severity: 'error', field: 'runtimes', message: 'must be an array of runtime ids' })
  } else {
    for (const r of obj.runtimes) {
      if (!isRuntime(r)) issues.push({ severity: 'error', field: 'runtimes', message: `invalid runtime "${String(r)}"` })
    }
    if (isRuntime(dr) && !(obj.runtimes as unknown[]).includes(dr)) {
      issues.push({ severity: 'error', field: 'runtimes', message: `must include the default_runtime "${dr}"` })
    }
  }

  // description — string (may be empty).
  if (obj.description !== undefined && typeof obj.description !== 'string') {
    issues.push({ severity: 'error', field: 'description', message: 'must be a string' })
  }

  // intelligence — artificial|natural|absent (legacy human|scripted accepted on read).
  if (obj.intelligence !== undefined && !normalizeIntelligenceValue(obj.intelligence)) {
    issues.push({
      severity: 'error',
      field: 'intelligence',
      message: `must be artificial|natural|absent (legacy human|scripted accepted), got "${String(obj.intelligence)}"`,
    })
  }

  // Optional lifecycle fields (foundation-owned).
  if (obj.initial_prompt !== undefined && typeof obj.initial_prompt !== 'string') {
    issues.push({ severity: 'error', field: 'initial_prompt', message: 'must be a string' })
  }
  if (obj.wake_policy !== undefined && obj.wake_policy !== 'ephemeral') {
    issues.push({ severity: 'warn', field: 'wake_policy', message: `unknown value "${String(obj.wake_policy)}" — only 'ephemeral' is honored` })
  }

  // Owner sections — well-typed only; foundation never restructures them.
  if (obj.interfaces !== undefined && (typeof obj.interfaces !== 'object' || obj.interfaces === null || Array.isArray(obj.interfaces))) {
    issues.push({ severity: 'error', field: 'interfaces', message: 'must be a JSON object' })
  }
  // Legacy top-level aliases — contract relocates to the `expansion.aliases` plugin-
  // config section with the /alias_* namespace (clean slash-keys are reserved for the
  // control layer). telegram-runtime owns that migration; flagged, not an error.
  if (obj.aliases !== undefined) {
    issues.push({
      severity: 'warn',
      field: 'aliases',
      message: 'legacy top-level `aliases` — contract relocates to expansion.aliases (/alias_* namespace); owner migration pending',
    })
  }
  // aliases misfiled in the PASSPORT (interfaces.telegram) — an interim home.
  // Taxonomy: aliases are PRIVATE plugin config (one reader, the chat-runtime at
  // expansion), not a public passport attribute — the contract relocates them to the
  // runtime-agnostic `expansion.aliases` section (future discord/matrix runtimes read
  // the SAME aliases). Transition observability: this warn goes silent once the owner
  // migration moves the data.
  const interfacesObj =
    obj.interfaces && typeof obj.interfaces === 'object' && !Array.isArray(obj.interfaces)
      ? (obj.interfaces as Record<string, unknown>)
      : undefined
  const telegramSection =
    interfacesObj?.telegram && typeof interfacesObj.telegram === 'object' && !Array.isArray(interfacesObj.telegram)
      ? (interfacesObj.telegram as Record<string, unknown>)
      : undefined
  if (telegramSection?.aliases !== undefined) {
    issues.push({
      severity: 'warn',
      field: 'interfaces.telegram.aliases',
      message: 'aliases are plugin config, not passport — contract relocates to expansion.aliases; owner migration pending',
    })
  }

  return issues
}

/** A profile passes the standard when it has no `error`-severity issues. */
export function isConformant(issues: readonly ProfileIssue[]): boolean {
  return !issues.some(i => i.severity === 'error')
}

/**
 * Phase-2 DATA migration of the staged default_runtime story: rewrite the LOCAL
 * profile at `cwd` so it carries the contract field `default_runtime` with the legacy
 * `runtime` kept as an in-sync mirror (writePeerProfileAtomic emits both since the
 * write-flip). Heals BOTH legacy shapes: a profile with only `runtime`, and a DIVERGED
 * mirror — the rewrite goes through readPeerProfile's dual-read, so default_runtime
 * wins divergence (the contract: default_runtime governs the primary). Owner sections
 * (interfaces / notifier / expansion / …), initial_prompt, wake_policy and the raw
 * legacy intelligence vocab are preserved verbatim by the H1 merge-write. Returns true
 * when the file was rewritten; false when already in shape, absent, or unparseable
 * (verify reports those as errors — migration never guesses).
 */
export function migrateProfileRuntimeField(cwd: string): boolean {
  const path = peerProfilePath(cwd)
  if (!existsSync(path)) return false
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const obj = raw as Record<string, unknown>
  // Phase-3: in-shape = default_runtime present AND NO legacy `runtime` field at all. An in-sync mirror
  // (runtime === default_runtime) is NO LONGER in shape — it must be stripped (writePeerProfileAtomic
  // drops it), so `verify --fix` cleans every profile still carrying the mirror.
  const inShape = isRuntime(obj.default_runtime) && obj.runtime === undefined
  if (inShape) return false
  const profile = readPeerProfile(cwd)
  if (!profile) return false
  writePeerProfileAtomic(cwd, profile)
  return true
}

/**
 * The PeerRecord the index SHOULD hold for the peer at `cwd`, projected from its LOCAL
 * profile (the self-heal source of truth) — readPeerProfile already self-heals the
 * personality mirror and dual-reads default_runtime/runtime. null when the cwd has no
 * profile. Used by verify (compare against the live index) and reindex (rewrite it).
 */
export function projectProfileToRecord(cwd: string): PeerRecord | null {
  const profile = readPeerProfile(cwd)
  if (!profile) return null
  return {
    personality: profile.personality,
    runtime: profile.runtime,
    runtimes: profile.runtimes,
    // The registry clamps the description to MAX_DESCRIPTION_LEN on read; project the
    // SAME clamp so a long local description (timer/watcher run ~1000 chars) does not
    // read back as a perpetual drift the index can never physically close.
    description: clampDescription(profile.description).description,
    intelligence: profile.intelligence,
    cwd,
    ...(profile.interfaces ? { interfaces: profile.interfaces } : {}),
  }
}

/** Order-insensitive structural serialization for comparing the projected OWNER
 *  passport (`interfaces`) — a nested object whose key ORDER is not semantically
 *  meaningful. A plain JSON.stringify would flag an order-only difference as drift
 *  (a legacy upsertPeer write may have stored keys in a different order); canonicalize
 *  first so only real content divergence is reported — a key added, removed, or changed,
 *  e.g. a field dropped from the source of truth after a cutover that the derived index
 *  never re-projected. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`
}

/** The index↔local drift for one peer: the fields where the live registry record
 *  disagrees with the projection from the local profile (the self-heal source). Empty
 *  array = in sync. cwd is the registry pointer, never compared. */
export function recordDrift(indexRecord: PeerRecord, projected: PeerRecord): string[] {
  const drift: string[] = []
  if (indexRecord.personality !== projected.personality) drift.push('personality')
  if (indexRecord.runtime !== projected.runtime) drift.push('default_runtime')
  if (indexRecord.runtimes.join(',') !== projected.runtimes.join(',')) drift.push('runtimes')
  if (indexRecord.description !== projected.description) drift.push('description')
  if (indexRecord.intelligence !== projected.intelligence) drift.push('intelligence')
  // The OWNER passport (`interfaces`) is projected into the registry, so a divergence
  // here is real drift — the class that hid the bot_username cutover (source dropped
  // `interfaces.telegram.bot`, the derived index kept it because nothing compared it).
  // projectProfileToRecord already replaces interfaces wholesale; comparing it here makes
  // the desync VISIBLE to verify/reconcile so it can never silently persist again.
  if (canonicalJson(indexRecord.interfaces) !== canonicalJson(projected.interfaces)) drift.push('interfaces')
  return drift
}

export interface ReconcileEntry {
  personality: string
  cwd: string
  /** null when the local profile is absent (the registry points at a gone cwd). */
  drift: string[] | null
}

/** READ-ONLY index↔local reconciliation: per registry entry, the drift vs its local
 *  profile projection (drift=null → local profile missing). The read-only half of the
 *  self-heal invariant — verify reports it, reindex repairs it. */
export function reconcileIndex(options: PeersUpdateOptions = {}): ReconcileEntry[] {
  const index = readPeersIndex(options)
  return index.peers.map(rec => {
    const projected = projectProfileToRecord(rec.cwd)
    return {
      personality: rec.personality,
      cwd: rec.cwd,
      drift: projected ? recordDrift(rec, projected) : null,
    }
  })
}

/**
 * Self-heal the index: REPLACE every registry record with the projection from its
 * local profile (the source of truth). Unlike upsertPeer (which UNIONs runtimes so a
 * boot never drops one), reindex is a deliberate REWRITE — it is how a local profile's
 * narrowed runtimes (e.g. dropped to [telegram]) propagate to the index. A peer
 * whose local profile is missing is left untouched (and surfaced in `missing`). The
 * legacy-safe intelligenceRaw is preserved when the nature is unchanged (never silently
 * migrate the live vocab — the human→natural incident class).
 */
export async function reindexFromLocals(
  options: PeersUpdateOptions = {},
): Promise<{ healed: string[]; missing: string[] }> {
  const healed: string[] = []
  const missing: string[] = []
  await updatePeersIndex(index => {
    const peers = index.peers.map(rec => {
      const projected = projectProfileToRecord(rec.cwd)
      if (!projected) {
        missing.push(rec.personality)
        return rec
      }
      const drift = recordDrift(rec, projected)
      if (drift.length > 0) healed.push(`${rec.personality}: ${drift.join(', ')}`)
      const intelligenceRaw =
        rec.intelligenceRaw !== undefined && normalizeIntelligenceValue(rec.intelligenceRaw) === projected.intelligence
          ? rec.intelligenceRaw
          : undefined
      return { ...projected, ...(intelligenceRaw !== undefined ? { intelligenceRaw } : {}) }
    })
    return { ...index, peers }
  }, options)
  return { healed, missing }
}
