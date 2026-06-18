// update-runtime — the runtime-package update story (design «Onboard костяка» §(г),
// FINAL 10.06; owner facts: NO state migrations on either package — notifier is
// stateless-by-design (registrations live durable in the OWNING peers' profiles),
// telegram's bots/.env is a stable ABI, its lock is transient self-healing).
//
//   version-gate (npm) → re-install the package → IDEMPOTENT re-provision through
//   the SAME path install-runtime uses (npx self-deploy + declared-set deploy:
//   PEER_BLURB registry sync, re-self-config, manifest refresh; live peers are
//   never clobbered — the notifier owner's point: without the re-provision a
//   version with a new blurb/self-doc leaves stale descriptions) → restart the
//   runtime's infra peers via the REGULAR stop/start verbs.
//
// The core's own `iapeer update` deliberately does NOT touch runtimes (foundation-
// only — the standing contract; the symmetry is conscious).
//
// Version-gate honesty: the installed version comes from the manifest's `version`
// stamp (the owners' self-install obligation, telegram 10.06). A manifest WITHOUT
// the stamp cannot be gated — the update proceeds idempotently and says so.

import { spawnSync } from 'child_process'
import { type Runtime } from '../core/constants.ts'
import { readPeersIndex } from '../registry/index.ts'
import { readRuntimeManifest } from './index.ts'
import {
  deployRuntime,
  installRuntimePackage,
  resolveRuntimePackage,
  RUNTIME_PACKAGES,
  type DeployedPeer,
  type NpxRunner,
} from './deploy.ts'

/** Injectable npm-version resolver (tests). Default: `npm view <pkg> version`. */
export type NpmVersionFn = (pkg: string, env: NodeJS.ProcessEnv) => string | null

const defaultNpmVersion: NpmVersionFn = (pkg, env) => {
  const r = spawnSync('npm', ['view', pkg, 'version'], { encoding: 'utf8', env: env as Record<string, string>, timeout: 60_000 })
  const v = (r.stdout ?? '').trim()
  return r.status === 0 && v ? v : null
}

export interface RestartedPeer {
  personality: string
  state: 'restarted' | 'refused-foreign-launchd' | 'failed'
  detail?: string
}

export interface UpdateRuntimeResult {
  runtime: Runtime
  package?: string
  state:
    | 'updated' // re-installed + re-provisioned + peers restarted
    | 'already-latest' // version-gate: the manifest stamp equals npm latest
    | 'not-installed' // no manifest — nothing to update (install-runtime first)
    | 'npm-unreachable' // npm view failed — cannot resolve the target version
    | 'install-failed' // the forced re-npx failed — nothing was touched further
    | 'deploy-failed' // re-provision broke (per-peer detail in `peers`)
  from?: string
  to?: string
  peers: DeployedPeer[]
  restarted: RestartedPeer[]
  detail?: string
}

export interface UpdateRuntimeOptions {
  runtime: Runtime
  /** Re-install even when the version-gate says already-latest. */
  force?: boolean
  env?: NodeJS.ProcessEnv
  runNpx?: NpxRunner
  npmVersion?: NpmVersionFn
  /** Injectable restart (tests). Default: the regular stop→start verbs, strictly
   *  sequential per peer. */
  restartPeer?: (personality: string, runtime: Runtime, env: NodeJS.ProcessEnv) => RestartedPeer
  warn?: (message: string) => void
}

/** Default per-peer restart: the REGULAR stop→start verbs (infra → launchctl
 *  bootout/bootstrap), strictly sequential. H4 stays intact: a PP-managed peer is
 *  refused by the verbs themselves and reported, never forced. */
async function defaultRestartPeer(personality: string, runtime: Runtime, env: NodeJS.ProcessEnv): Promise<RestartedPeer> {
  const { stopPeer, startPeer } = await import('../cli/index.ts')
  try {
    const stops = stopPeer(personality, runtime, { env })
    if (stops.some(o => o.action === 'refused-foreign-launchd')) {
      return { personality, state: 'refused-foreign-launchd', detail: 'persistent-peer-managed (H4) — restart it yourself' }
    }
    const starts = startPeer(personality, runtime, { env })
    const bad = starts.find(o => o.action === 'bootstrap' && o.reason)
    return bad ? { personality, state: 'failed', detail: bad.reason } : { personality, state: 'restarted' }
  } catch (e) {
    return { personality, state: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}

export async function updateRuntime(opts: UpdateRuntimeOptions): Promise<UpdateRuntimeResult> {
  const env = opts.env ?? process.env
  const runtime = opts.runtime
  const manifest = readRuntimeManifest(runtime, { env })
  if (!manifest) {
    return {
      runtime,
      state: 'not-installed',
      peers: [],
      restarted: [],
      detail: `no manifest for "${runtime}" — install first: iapeer install-runtime ${runtime}`,
    }
  }
  const pkg = resolveRuntimePackage(runtime)
  if (!pkg) {
    return { runtime, state: 'not-installed', peers: [], restarted: [], detail: `no package mapping for "${runtime}"` }
  }

  // Version-gate: npm latest vs the manifest stamp. No stamp → no gate (proceed
  // idempotently — the owners' stamp obligation closes this once shipped).
  const latest = (opts.npmVersion ?? defaultNpmVersion)(pkg, env)
  if (!latest) {
    return { runtime, package: pkg, state: 'npm-unreachable', peers: [], restarted: [], detail: `npm view ${pkg} version failed — cannot resolve the target` }
  }
  const installed = manifest.version
  if (installed && installed === latest && !opts.force) {
    return { runtime, package: pkg, state: 'already-latest', from: installed, to: latest, peers: [], restarted: [] }
  }

  // Re-install (forced npx — the package self-deploys its new bin + manifest).
  const install = installRuntimePackage({ runtime, force: true, env, runNpx: opts.runNpx })
  if (install.state !== 'ran') {
    return { runtime, package: pkg, state: 'install-failed', from: installed, to: latest, peers: [], restarted: [], detail: install.detail ?? install.state }
  }

  // IDEMPOTENT re-provision via the SAME deploy path install-runtime uses: blurb
  // sync, re-self-config, no-clobber on live peers. Mode-b (telegram) declares no
  // peers — the deploy is an empty pass, by design.
  let peers: DeployedPeer[]
  try {
    const d = await deployRuntime({ runtime, env, warn: opts.warn })
    peers = d.peers
  } catch (e) {
    return { runtime, package: pkg, state: 'deploy-failed', from: installed, to: latest, peers: [], restarted: [], detail: e instanceof Error ? e.message : String(e) }
  }
  if (peers.some(p => p.selfConfig === 'failed' || p.bootstrap === 'failed')) {
    return { runtime, package: pkg, state: 'deploy-failed', from: installed, to: latest, peers, restarted: [], detail: 'a declared peer failed re-provision — see the per-peer lines' }
  }

  // Restart THIS runtime's registered peers so the new baked code runs (notifier
  // semantics per the owner: cron wall-clock unaffected, @every re-anchors,
  // watcher children relaunch, heartbeat windows reset). Strictly sequential.
  const registered = readPeersIndex({ env }).peers.filter(
    p => p.runtime === runtime || p.runtimes.includes(runtime),
  )
  const restarted: RestartedPeer[] = []
  for (const p of registered) {
    restarted.push(
      opts.restartPeer
        ? opts.restartPeer(p.personality, runtime, env)
        : await defaultRestartPeer(p.personality, runtime, env),
    )
  }

  return {
    runtime,
    package: pkg,
    state: 'updated',
    from: installed,
    to: latest,
    peers,
    restarted,
    detail: installed ? undefined : 'no version stamp in the old manifest — gate skipped, re-installed idempotently',
  }
}

/** `--all`: update every KNOWN runtime that is actually installed (manifest present);
 *  the rest are reported as not-installed, never an error. */
export async function updateAllRuntimes(opts: Omit<UpdateRuntimeOptions, 'runtime'> = {}): Promise<UpdateRuntimeResult[]> {
  const env = opts.env ?? process.env
  const out: UpdateRuntimeResult[] = []
  for (const rt of Object.keys(RUNTIME_PACKAGES) as Runtime[]) {
    if (!readRuntimeManifest(rt, { env })) {
      out.push({ runtime: rt, state: 'not-installed', peers: [], restarted: [], detail: 'not installed — skipped' })
      continue
    }
    out.push(await updateRuntime({ ...opts, runtime: rt }))
  }
  return out
}
