// Voice-slot onboard step (the voice provider = @agfpd/voice-connect).
// Host-phase, optional, DEFAULT-YES: install the voice provider package and run ITS
// OWN init-verb — the provider deploys its HOST BACKEND (a self-managed launchd HTTP
// service), writes the slot declaration, and prompts for any TTS keys over our
// inherited tty. The core never writes the slot itself.
//
// SCOPE — host backend ONLY (the PIN, confirmed with voice-connect): init wires NO
// host MCP server. Per-peer voice tooling (the voice_create / tts MCP surface) is the
// SEPARATE explicit `iapeer enable voice-connect <peer>` (a marketplace capability
// plugin whose per-peer identity resolves from the MCP stdio child's cwd — a single
// host-wide server cannot resolve per-peer voices). So onboard ≠ per-peer wiring; the
// backend it installs is independently valuable (telegram-STT / voicetalk consume the
// HTTP facade with no MCP at all). Unlike memory there is therefore NO per-peer birth
// hook and the slot carries NO provision/unprovision.
//
// Outcome semantics: this step NEVER fails the onboard exit code — an empty slot is a
// fully valid state regardless of why (skipped / not yet published / non-tty refusal).
// Outcomes are reported, not enforced. Mirrors onboard/memory.ts deliberately (same
// vocabulary), minus memory's --human/--runtime init args (voice init takes none).

import { spawnSync } from 'child_process'
import { readVoiceProvider, type VoiceProvider } from '../status/index.ts'

/** The distribution default voice provider. */
export const DEFAULT_VOICE_PACKAGE = '@agfpd/voice-connect'

export interface VoiceOnboardOptions {
  /** --no-voice: skip the step entirely. */
  skip?: boolean
  /** --voice <pkg>: override the provider package (default @agfpd/voice-connect). */
  package?: string
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  /** Wall-clock backstop (ms) for the provider-init subprocess — a hung provider must
   *  NEVER wedge onboard (voice is optional). The interactive wizard passes a generous
   *  value; the linear path leaves it unset (no timeout). */
  timeoutMs?: number
  /** Injectable runner (tests). Default: availability probe + `npx -y <pkg> init`
   *  with inherited stdio. */
  runInit?: (
    pkg: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs?: number,
  ) => { status: number | null; unavailable: boolean }
}

export interface VoiceOnboardResult {
  state:
    | 'installed' // provider init succeeded and declared the slot
    | 'already' // slot already occupied by the SAME package — idempotent no-op
    | 'skipped-flag' // --no-voice
    | 'skipped-unavailable' // package not published / no network — soft skip (contract)
    | 'refused-foreign' // slot occupied by ANOTHER provider — explicit refusal
    | 'provider-init-failed' // provider init ran and exited non-zero / declared nothing
    | 'dry-run'
  provider: VoiceProvider | null
  detail?: string
}

function defaultRunInit(
  pkg: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): { status: number | null; unavailable: boolean } {
  // Availability probe FIRST (cheap, side-effect-free, bounded): an unpublished package
  // / no network → soft-skip per the contract (the provider's release order must never
  // block the core's onboard).
  const probe = spawnSync('npm', ['view', `${pkg}@latest`, 'version'], { encoding: 'utf8', env, timeout: 60_000 })
  if (probe.status !== 0) return { status: probe.status, unavailable: true }
  // INHERITED stdio — the provider owns its install questions (TTS-key prompts happen
  // here, once). The provider bin (`voice-connect`) is an ARG-DISPATCHER: a subcommand
  // (`init`) routes to its lifecycle path, NOT the backward-compatible MCP-stdio path
  // (no-subcommand) — so `npx -y <pkg> init` correctly hits init.
  const r = spawnSync('npx', ['-y', pkg, ...args], {
    stdio: 'inherit',
    env,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  })
  return { status: r.status, unavailable: false }
}

export async function onboardVoiceProvider(opts: VoiceOnboardOptions = {}): Promise<VoiceOnboardResult> {
  const env = opts.env ?? process.env
  const pkg = opts.package?.trim() || DEFAULT_VOICE_PACKAGE
  const existing = readVoiceProvider(env)
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
  // voice init takes NO core-known facts (no --human/--runtime — the host backend is
  // peer-agnostic; per-peer voice is a separate `iapeer enable`).
  const args = ['init']
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
      provider: readVoiceProvider(env),
      detail: `provider init exited ${r.status ?? 'null'}`,
    }
  }
  // The PROVIDER declares the slot; verify it actually did (its contract duty).
  const after = readVoiceProvider(env)
  if (!after) {
    return {
      state: 'provider-init-failed',
      provider: null,
      detail: 'provider init succeeded but did not declare the slot (voice-provider.json missing)',
    }
  }
  return { state: 'installed', provider: after }
}

// ─────────────────────────────────────────────────────────────────────────────
// updateVoiceProvider — the voice leg of the cascade `iapeer update` (FU12)
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceUpdateResult {
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

/** The provider's CLI bin name = the unscoped package name (`@agfpd/voice-connect` →
 *  `voice-connect`). That bin is the arg-dispatcher; `<bin> update` routes to its
 *  lifecycle update path. */
function voiceBinName(pkg: string): string {
  return pkg.replace(/^@[^/]+\//, '')
}

function defaultRunVoiceUpdate(pkg: string, env: NodeJS.ProcessEnv): { status: number | null; unavailable: boolean } {
  // Availability probe FIRST (cheap, bounded): unpublished / no network → soft-skip.
  const probe = spawnSync('npm', ['view', `${pkg}@latest`, 'version'], { encoding: 'utf8', env, timeout: 60_000 })
  if (probe.status !== 0) return { status: probe.status, unavailable: true }
  // `npm exec --package=<pkg>@latest -- <bin> update` fetches the latest published
  // package into a fresh temp and runs ITS update verb from there — bypassing any
  // PATH name-shadow (the 0.2.9 pitfall: a bare `npx <bin>` could re-run a stale
  // installed binary). voice-connect's update then re-copies its runtime tree into the
  // STABLE provider home (~/.iapeer/providers/voice-connect/, never the GC'd npx cache),
  // bootout→bootstraps its HTTP service, and bumps slot.version — so the before/after
  // version-gate this leg reads is real. The provider OWNS update + slot-write + its own
  // service restart.
  const r = spawnSync(
    'npm',
    ['exec', '--yes', `--package=${pkg}@latest`, '--', voiceBinName(pkg), 'update'],
    { stdio: 'inherit', env },
  )
  return { status: r.status, unavailable: false }
}

/**
 * Update the CLAIMED voice provider via ITS OWN update verb (slot contract: the
 * provider owns install/update + slot-write + service restart; the core only invokes +
 * reads the slot). No slot → nothing to update. Reports from→to by reading the slot
 * version before/after. BEST-EFFORT by the caller (the cascade never aborts on it).
 */
export function updateVoiceProvider(opts: {
  env?: NodeJS.ProcessEnv
  dryRun?: boolean
  runUpdate?: (pkg: string, env: NodeJS.ProcessEnv) => { status: number | null; unavailable: boolean }
} = {}): VoiceUpdateResult {
  const env = opts.env ?? process.env
  const slot = readVoiceProvider(env)
  if (!slot) return { state: 'no-slot', detail: 'no voice provider claimed — nothing to update' }
  const pkg = slot.package
  const from = slot.version
  if (opts.dryRun) {
    return { state: 'updated', package: pkg, from, detail: `would run: npm exec --package=${pkg}@latest -- ${voiceBinName(pkg)} update` }
  }
  const run = opts.runUpdate ?? defaultRunVoiceUpdate
  const r = run(pkg, env)
  if (r.unavailable) {
    return { state: 'skipped-unavailable', package: pkg, from, detail: `${pkg}@latest not reachable (no network / unpublished)` }
  }
  if (r.status !== 0) return { state: 'failed', package: pkg, from, detail: `provider update exited ${r.status ?? 'null'}` }
  const to = readVoiceProvider(env)?.version
  if (from && to && from === to) return { state: 'already-latest', package: pkg, from, to }
  return { state: 'updated', package: pkg, from, to }
}
