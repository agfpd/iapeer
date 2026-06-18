// Memory-slot onboard step (docs/Слот памяти — контракт memory provider.md).
// Host-phase, optional, DEFAULT-YES:
// install the default memory provider package and run ITS OWN init-verb — the
// provider writes the slot declaration and deploys its surfaces; the core never
// writes the slot itself. The provider OWNS the install questions (two-mode
// init): we run it with INHERITED stdio so its tty interactive happens inside
// the onboard host phase, exactly once. The core passes as flags ONLY facts it
// owns by its own contracts — v1 list is exactly one: `--human <personality>`
// when EXACTLY ONE natural peer is registered.
//
// Outcome semantics: this step NEVER fails the onboard exit code — an empty
// slot is a fully valid state regardless of why (skipped / package not yet
// published / provider refused non-tty). Outcomes are reported, not enforced.

import { spawnSync } from 'child_process'
import { normalizeIntelligenceValue } from '../core/constants.ts'
import { readPeersIndex } from '../registry/index.ts'
import { readMemoryProvider, type MemoryProvider } from '../status/index.ts'

/** The distribution default provider (memory is a first-class core option). */
export const DEFAULT_MEMORY_PACKAGE = '@agfpd/iapeer-memory'

export interface MemoryOnboardOptions {
  /** --no-memory: skip the step entirely. */
  skip?: boolean
  /** --memory <pkg>: override the provider package (default @agfpd/iapeer-memory). */
  package?: string
  /** Host agentic runtime to thread to the provider init (`--runtime <rt>`) — the
   *  onboard↔init contract: the provider provisions its role-peers (index/watcher/
   *  timer) on THIS runtime instead of guessing. Omitted on a no-runtime host →
   *  the provider degrades (base+BM25, role-peers skipped). */
  runtime?: string
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  /** Wall-clock backstop (ms) for the provider-init subprocess — a hung provider
   *  (e.g. a stalled native build) must NEVER wedge onboard (memory is optional).
   *  The interactive wizard passes a generous value; the linear path leaves it
   *  unset (no timeout). */
  timeoutMs?: number
  /** Injectable runner (tests). Default: availability probe + `npx -y <pkg> init …`
   *  with inherited stdio. */
  runInit?: (
    pkg: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs?: number,
  ) => { status: number | null; unavailable: boolean }
}

export interface MemoryOnboardResult {
  state:
    | 'installed' // provider init succeeded and declared the slot
    | 'already' // slot already occupied by the SAME package — idempotent no-op
    | 'skipped-flag' // --no-memory
    | 'skipped-unavailable' // package not published / no network — soft skip (contract)
    | 'refused-foreign' // slot occupied by ANOTHER provider — explicit refusal
    | 'provider-init-failed' // provider init ran and exited non-zero / declared nothing
    | 'dry-run'
  provider: MemoryProvider | null
  detail?: string
}

function defaultRunInit(
  pkg: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): { status: number | null; unavailable: boolean } {
  // Availability probe FIRST (cheap, side-effect-free): an unpublished package /
  // no network → soft-skip per the contract (the provider's release order must
  // never block the core's onboard). Bounded so the probe itself cannot hang.
  const probe = spawnSync('npm', ['view', `${pkg}@latest`, 'version'], { encoding: 'utf8', env, timeout: 60_000 })
  if (probe.status !== 0) return { status: probe.status, unavailable: true }
  // INHERITED stdio — the provider owns its install questions (tty interactive
  // happens here, once). npx bin-name nuance (cf. the 0.2.9 update pitfall): with
  // the provider bin already on PATH npx runs the INSTALLED one — acceptable for
  // an idempotent init (unlike the self-update case where it was a structural bug).
  // timeout: a generous wall-clock backstop so a hung provider can't wedge onboard
  // (the caller also makes Ctrl-C skip just this step).
  const r = spawnSync('npx', ['-y', pkg, ...args], {
    stdio: 'inherit',
    env,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  })
  return { status: r.status, unavailable: false }
}

/** The exhaustive v1 list of core-known facts passed to the provider init:
 *  `--human <personality>` iff EXACTLY ONE natural peer is registered (the core
 *  has no separate owner-name config — the owner IS the natural peer). */
export function coreKnownInitArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const naturals = readPeersIndex({ env }).peers.filter(
      p => normalizeIntelligenceValue(p.intelligence) === 'natural',
    )
    return naturals.length === 1 ? ['--human', naturals[0]!.personality] : []
  } catch {
    return [] // no registry / unreadable → pass nothing, the provider asks itself
  }
}

export async function onboardMemoryProvider(opts: MemoryOnboardOptions = {}): Promise<MemoryOnboardResult> {
  const env = opts.env ?? process.env
  const pkg = opts.package?.trim() || DEFAULT_MEMORY_PACKAGE
  const existing = readMemoryProvider(env)
  if (opts.skip) return { state: 'skipped-flag', provider: existing }
  if (existing) {
    if (existing.package === pkg) return { state: 'already', provider: existing }
    // Never silently install over an occupied slot (contract: FORBIDDEN).
    return {
      state: 'refused-foreign',
      provider: existing,
      detail: `slot is occupied by "${existing.provider}" (${existing.package}) — uninstall it first`,
    }
  }
  const args = ['init', ...coreKnownInitArgs(env), ...(opts.runtime ? ['--runtime', opts.runtime] : [])]
  if (opts.dryRun) {
    return { state: 'dry-run', provider: null, detail: `would run: npx -y ${pkg} ${args.join(' ')}` }
  }
  const run = opts.runInit ?? defaultRunInit
  const r = run(pkg, args, env, opts.timeoutMs)
  if (r.unavailable) {
    return {
      state: 'skipped-unavailable',
      provider: null,
      detail: `${pkg} is not available (not published yet / no network) — install later: npx ${pkg} init`,
    }
  }
  if (r.status !== 0) {
    return {
      state: 'provider-init-failed',
      provider: readMemoryProvider(env),
      detail: `provider init exited ${r.status ?? 'null'}`,
    }
  }
  // The PROVIDER declares the slot; verify it actually did (its contract duty).
  const after = readMemoryProvider(env)
  if (!after) {
    return {
      state: 'provider-init-failed',
      provider: null,
      detail: 'provider init succeeded but did not declare the slot (memory-provider.json missing)',
    }
  }
  return { state: 'installed', provider: after }
}

// ─────────────────────────────────────────────────────────────────────────────
// updateMemoryProvider — the memory leg of the cascade `iapeer update` (FU12)
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryUpdateResult {
  state:
    | 'updated' // provider update ran and the slot version advanced
    | 'already-latest' // ran but the slot version is unchanged
    | 'no-slot' // no provider claimed — nothing to update
    | 'skipped-unavailable' // package not published / no network — soft skip
    | 'failed' // provider update exited non-zero
  package?: string
  from?: string
  to?: string
  detail?: string
}

/** The provider's CLI bin name = the unscoped package name (`@agfpd/iapeer-memory` →
 *  `iapeer-memory`). */
function memoryBinName(pkg: string): string {
  return pkg.replace(/^@[^/]+\//, '')
}

function defaultRunMemoryUpdate(pkg: string, env: NodeJS.ProcessEnv): { status: number | null; unavailable: boolean } {
  // Availability probe FIRST (cheap, bounded): unpublished / no network → soft-skip.
  const probe = spawnSync('npm', ['view', `${pkg}@latest`, 'version'], { encoding: 'utf8', env, timeout: 60_000 })
  if (probe.status !== 0) return { status: probe.status, unavailable: true }
  // The provider ships a COMPILED bin on PATH (~/.local/bin/<bin>), NOT an npm package,
  // so a bare `npx <bin>` / `npx <pkg>@latest` re-runs the STALE installed binary —
  // verified by the provider: it reports the OLD version, "running FROM the installed
  // binary", a SILENT non-update (fatal for the upgrade case). `npm exec
  // --package=<pkg>@latest -- <bin> update` fetches latest + rebuilds, bypassing the PATH
  // name-shadow. The provider OWNS update + slot-write + its own daemon (memoryd) restart.
  const r = spawnSync(
    'npm',
    ['exec', '--yes', `--package=${pkg}@latest`, '--', memoryBinName(pkg), 'update'],
    { stdio: 'inherit', env },
  )
  return { status: r.status, unavailable: false }
}

/**
 * Update the CLAIMED memory provider via ITS OWN npx update verb (slot contract: the
 * provider owns install/update + slot-write + peer restart; the core only invokes +
 * reads the slot). No slot → nothing to update. Reports from→to by reading the slot
 * version before/after. BEST-EFFORT by the caller (the cascade never aborts on it).
 */
export function updateMemoryProvider(opts: {
  env?: NodeJS.ProcessEnv
  dryRun?: boolean
  runUpdate?: (pkg: string, env: NodeJS.ProcessEnv) => { status: number | null; unavailable: boolean }
} = {}): MemoryUpdateResult {
  const env = opts.env ?? process.env
  const slot = readMemoryProvider(env)
  if (!slot) return { state: 'no-slot', detail: 'no memory provider claimed — nothing to update' }
  const pkg = slot.package
  const from = slot.version
  if (opts.dryRun) {
    return { state: 'updated', package: pkg, from, detail: `would run: npm exec --package=${pkg}@latest -- ${memoryBinName(pkg)} update` }
  }
  const run = opts.runUpdate ?? defaultRunMemoryUpdate
  const r = run(pkg, env)
  if (r.unavailable) {
    return { state: 'skipped-unavailable', package: pkg, from, detail: `${pkg}@latest not reachable (no network / unpublished)` }
  }
  if (r.status !== 0) return { state: 'failed', package: pkg, from, detail: `provider update exited ${r.status ?? 'null'}` }
  const to = readMemoryProvider(env)?.version
  if (from && to && from === to) return { state: 'already-latest', package: pkg, from, to }
  return { state: 'updated', package: pkg, from, to }
}
