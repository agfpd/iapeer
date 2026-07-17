// Profile-sync — the daemon's CONTINUOUS half of the registry self-heal invariant.
//
// THE INVARIANT (identity/profileStandard.ts; contract zone «Идентичность пира — модель,
// профиль, реестр»): the per-cwd peer-profile.json is the SOURCE OF TRUTH and
// peers-profiles.json is a regenerable PROJECTION of it — "the index is never the source
// of truth". Before this module that sentence was true only lexically. reindexFromLocals
// ran on a handful of verbs (add-runtime / default-runtime / connect / verify --fix), so
// an edit of the source file ITSELF — the owner's legitimate edit, on the very file the
// contract names as the truth — propagated NEVER unless one of those verbs happened to
// run afterwards. Measured on the real fleet (17.07.2026): linus's local profile had said
// default_runtime=claude for days; the index still said codex; the router, which reads
// the INDEX per-request, kept delivering into a mute codex session until an operator ran
// the verb by hand. A projection invariant without a continuous reconciler is a promise
// the system does not keep.
//
// MECHANISM. Every tick (60 s default) stat each registered peer's peer-profile.json.
// Only when a profile mtime advanced past the previous sweep's maximum — or the set of
// profile paths changed — run reindexFromLocals: the SAME locked writer the verbs use,
// so the registry single-writer invariant is untouched. The steady state is N stats and
// ZERO writes; the index is rewritten only when a source actually changed. Reindex
// writes the index and never the profiles, so there is no feedback loop. A corrupt or
// missing profile is preserved-and-reported by reindexFromLocals itself (it treats both
// as "leave the record, surface in `missing`" — a half-saved editor buffer must never
// wipe a live record).
//
// The boot tick ALWAYS reconciles once (the gate starts empty): drift accumulated while
// the daemon was down — exactly the incident shape — heals on startup, not on the next
// hand-run verb.

import { statSync } from 'node:fs'
import { reindexFromLocals } from '../identity/profileStandard.ts'
import { readPeersIndex } from '../registry/index.ts'
import { peerProfilePath } from '../storage/index.ts'

export const DEFAULT_PROFILE_SYNC_INTERVAL_MS = 60_000

export interface ProfileSyncResult {
  healed: string[]
  missing: string[]
}

export interface ProfileSyncDeps {
  /** Registered peers' profile paths. Default: the live registry (readPeersIndex). */
  listProfilePaths?: () => string[]
  /** The locked self-heal writer. Default: reindexFromLocals({ env }). */
  reindex?: () => Promise<ProfileSyncResult>
  /** Fired ONLY when a reindex actually changed/flagged something (healed or missing
   *  non-empty) — the caller's audit hook; quiet reconciles stay quiet. */
  onHealed?: (r: ProfileSyncResult) => void
  /** Reported, never thrown — a reconciler must never take the daemon down. */
  onError?: (err: unknown) => void
  env?: NodeJS.ProcessEnv
}

/** The sweep gate: the profile set + the newest profile mtime, folded into one string.
 *  A changed gate = some source changed (edit, new peer, dropped profile) → reindex. */
function computeGate(paths: string[]): string {
  let maxMtime = 0
  const present: string[] = []
  for (const p of paths) {
    try {
      const m = statSync(p).mtimeMs
      present.push(p)
      if (m > maxMtime) maxMtime = m
    } catch {
      // Missing profile: participates via the PATH SET (its appearance/disappearance
      // flips the gate once), not via mtime. reindexFromLocals handles the rest.
    }
  }
  return `${maxMtime}|${present.sort().join(',')}`
}

/**
 * One sweep: reindex IFF the gate moved since `lastGate`. Returns the new gate.
 * Exported for tests; the timer below is just this on an interval.
 */
export async function profileSyncTick(deps: ProfileSyncDeps, lastGate: string): Promise<string> {
  try {
    const env = deps.env ?? process.env
    const paths = deps.listProfilePaths
      ? deps.listProfilePaths()
      : readPeersIndex({ env }).peers.map(rec => peerProfilePath(rec.cwd))
    const gate = computeGate(paths)
    if (gate === lastGate) return lastGate
    const reindex = deps.reindex ?? (() => reindexFromLocals({ env }))
    const result = await reindex()
    if (result.healed.length > 0 || result.missing.length > 0) deps.onHealed?.(result)
    return gate
  } catch (e) {
    deps.onError?.(e)
    return lastGate // a failed sweep retries the same gate next tick — never silently skips
  }
}

/** Start the profile-sync timer. Returns its stop function — the caller OWNS teardown. */
export function startProfileSync(opts: ProfileSyncDeps & { intervalMs?: number } = {}): () => void {
  let gate = '' // empty ≠ any computed gate → the FIRST tick always reconciles (boot heal)
  let running = false
  const sweep = async (): Promise<void> => {
    if (running) return // a slow reindex must never overlap itself
    running = true
    try {
      gate = await profileSyncTick(opts, gate)
    } finally {
      running = false
    }
  }
  void sweep() // boot heal — drift accumulated while the daemon was down heals NOW
  const timer = setInterval(() => void sweep(), opts.intervalMs ?? DEFAULT_PROFILE_SYNC_INTERVAL_MS)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
