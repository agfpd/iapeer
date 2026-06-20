// `updateIapeer` — the FOUNDATION leg of the deploy: pull the latest published
// foundation from npm (the cloud) and restart the daemon onto it. There is deliberately
// NO "deploy from a working tree" — every host, including the dev host, activates a
// release the same way: `npm run release` (publish) → `iapeer update` (pull + restart).
//
// NB the `iapeer update` VERB cascades the whole stack (FU12): it runs this foundation
// leg FIRST (aborting on a hard failure), then `updateAllRuntimes` + the memory provider
// (best-effort) via cascadeTail (below). updateIapeer itself stays foundation-scoped —
// the cascade is composed in the CLI verb.
//
// Flow:
//   1. latest = `npm view @agfpd/iapeer version`           (the cloud's truth)
//   2. installed == latest && !--force → "already latest"  (no needless rebuild/restart)
//   3. fetch the published tarball + build from its SOURCE (defaultRunInstall) — the
//      COMPILED binary can't rebuild itself, so we pull the freshly-published package
//      and run ITS own source installer. DELIBERATELY NOT `npx … install` (see
//      defaultRunInstall for why npx is unsafe here).
//   4. cycle com.agfpd.iapeer IF loaded (bootout+bootstrap) (activate the new binary; kickstart hits the LWCR EX_CONFIG(78) bomb)
//   5. recycle loaded FOUNDATION-OWNED infra jobs (com.iapeer.* with the sentinel)
//      because their plists also run the just-replaced `iapeer run-infra` binary.
//
// Scope: the foundation ONLY (the @agfpd/iapeer binary + its daemon + launchd
// registrations of foundation-owned infra jobs that point at that binary). It never
// rewrites those plists, never updates runtime packages (telegram-runtime /
// notifier-runtime / capability plugins), and never touches foreign / persistent-peer fleet
// plists — only sentinel-marked foundation-owned com.iapeer.* jobs are recycled.
//
// updateIapeer takes its three side-effects as INJECTED deps so the version-gate is
// unit-testable with no network and no launchctl; the defaults are the real impls.

import { spawnSync } from 'child_process'
import { mkdtempSync, readdirSync, rmSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { isInfraRuntime } from '../core/constants.ts'
import { IapError } from '../core/errors.ts'
import { IAPEER_VERSION } from '../core/version.ts'
import { readPeersIndex } from '../registry/index.ts'
import {
  cycleDaemon,
  cycleLaunchdJob,
  isFoundationOwnedPlist,
  launchdLabel,
  launchdPlistPath,
  type DaemonRestartResult,
  type LaunchdJobCycleResult,
} from '../launch/launchd.ts'
import { defaultDaemonSocketPath } from '../daemon/index.ts'
// Type-only (erased at runtime → no import cycle): the cascade tail renders these
// shapes but receives the component-updaters as injected deps.
import type { UpdateRuntimeResult } from '../runtime/update.ts'
import type { MemoryUpdateResult } from '../onboard/memory.ts'

/** The npm package the foundation publishes / updates from. */
export const IAPEER_PACKAGE = '@agfpd/iapeer'

export interface UpdateDeps {
  env?: NodeJS.ProcessEnv
  /** Reinstall + restart even when already at the desired version. */
  force?: boolean
  /** The currently-installed version (default: this binary's baked IAPEER_VERSION). */
  currentVersion?: string
  /** Install this EXACT version instead of latest (one-shot pin / downgrade /
   *  recover-to-a-known-good deeper than the single .prev). Omit → latest. */
  targetVersion?: string
  /** Resolve a spec ('latest' or an exact 'X.Y.Z') to the concrete published version it
   *  names, or null on a miss / npm error (default: `npm view @agfpd/iapeer@<spec> version`). */
  resolveVersion?: (spec: string, env: NodeJS.ProcessEnv) => string | null
  /** Pull + rebuild the binary for `version` (default: npm pack → extract → source install).
   *  Returns true on success. */
  runInstall?: (version: string, env: NodeJS.ProcessEnv) => boolean
  /** Restart the daemon onto the new binary (default: cycleDaemon — bootout+bootstrap, the LWCR-safe cycle). */
  restartDaemon?: (env: NodeJS.ProcessEnv) => DaemonRestartResult
  /** Re-register loaded foundation-owned infra launchd jobs whose plists run the
   *  installed iapeer binary (default: registry scan + sentinel guard). */
  recycleInfraJobs?: (env: NodeJS.ProcessEnv) => InfraJobRecycleResult[]
}

export interface InfraJobRecycleResult {
  personality: string
  runtime: string
  label: string
  state: LaunchdJobCycleResult['state']
  detail?: string
}

export interface UpdateResult {
  status: 'updated' | 'already-latest' | 'failed'
  /** Version before the update (the running binary). */
  from: string
  /** Latest published version resolved from npm (undefined if it couldn't be resolved). */
  latest?: string
  /** Version installed by this run (set only on status 'updated'). */
  to?: string
  /** What happened to the live daemon (only on 'updated'). */
  daemon?: DaemonRestartResult['state']
  /** Foundation-owned infra jobs recycled after the binary swap (only on 'updated'). */
  infra?: InfraJobRecycleResult[]
  /** Human reason on 'failed' / extra detail on a daemon restart hiccup. */
  reason?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-restart health — verify the daemon actually came up, not just that
// the daemon job cycle exited 0. A new binary that fails to boot would otherwise
// be reported as a successful "restarted". The probe connects to the daemon's unix
// socket (the always-present same-uid listener it binds right before printing READY);
// a refused connection = not serving. Requires a short STREAK of successes so a
// bind-then-crash flap reads as unhealthy, not healthy.
// ─────────────────────────────────────────────────────────────────────────────

export interface HealthResult {
  healthy: boolean
  detail?: string
}

export interface HealthOptions {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  intervalMs?: number
  /** Consecutive successful probes required to call it healthy (flap guard). */
  needConsecutive?: number
  /** Injectable probe (tests). Default: connect to the daemon's unix socket. */
  probe?: () => Promise<boolean>
}

/** True iff a connection to the daemon's router socket is accepted (it is serving). */
function probeDaemonSocket(env: NodeJS.ProcessEnv): Promise<boolean> {
  const path = defaultDaemonSocketPath({ env })
  return new Promise(resolve => {
    let settled = false
    const done = (v: boolean): void => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* already gone */
      }
      resolve(v)
    }
    const sock = connect({ path })
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(1000, () => done(false))
  })
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * Poll the daemon until it is healthy (its socket accepts `needConsecutive`
 * connections in a row) or `timeoutMs` elapses. Under IAPEER_TEST_SANDBOX with no
 * injected probe it short-circuits healthy (never touches a real socket).
 */
export async function waitForDaemonHealthy(opts: HealthOptions = {}): Promise<HealthResult> {
  const env = opts.env ?? process.env
  if (env.IAPEER_TEST_SANDBOX === '1' && !opts.probe) return { healthy: true, detail: 'skipped-sandbox' }
  const probe = opts.probe ?? (() => probeDaemonSocket(env))
  const timeoutMs = opts.timeoutMs ?? 15_000
  const intervalMs = opts.intervalMs ?? 400
  const need = opts.needConsecutive ?? 2
  const deadline = Date.now() + timeoutMs
  let streak = 0
  for (;;) {
    streak = (await probe()) ? streak + 1 : 0
    if (streak >= need) return { healthy: true }
    if (Date.now() >= deadline) return { healthy: false, detail: `daemon did not become healthy within ${timeoutMs}ms (socket not accepting connections)` }
    await sleep(intervalMs)
  }
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/

/** Default version resolver: `npm view @agfpd/iapeer@<spec> version` (spec = 'latest'
 *  or an exact 'X.Y.Z'). Returns the concrete version, or null on a miss / npm error
 *  (a non-existent pinned version exits non-zero → null → a loud "not found"). */
function defaultResolveVersion(spec: string, env: NodeJS.ProcessEnv): string | null {
  const r = spawnSync('npm', ['view', `${IAPEER_PACKAGE}@${spec}`, 'version'], { encoding: 'utf8', env })
  if (r.status !== 0) return null
  const v = (r.stdout ?? '').trim()
  return SEMVER_RE.test(v) ? v : null
}

/**
 * Default installer — fetch the published tarball and build from its SOURCE,
 * DELIBERATELY bypassing `npx`. Pull from the cloud + rebuild ~/.local/bin/iapeer.
 *
 * Why not `npx -y @agfpd/iapeer@<v> install`: the package's bin is named `iapeer`,
 * and once `~/.local/bin/iapeer` is on PATH (true on every host AFTER the first
 * install) npx resolves that bin NAME to the COMPILED binary already on PATH and
 * runs ITS `install` — which cannot rebuild itself from source (`bun build --compile`
 * gets a `/$bunfs/root` entrypoint → FileNotFound) — instead of fetching + running the
 * freshly-published source. Verified reproducible: with NO
 * `iapeer` on PATH the same npx invocation prints `command not found` — it never
 * installs the package — so this is a structural bin-name collision, NOT the
 * publish-propagation transient (waiting/retry does not cure it).
 *
 * Deterministic path instead — no npx command-resolution in the loop:
 *   1. `npm pack <pkg>@<v>` → the published tarball (rooted at `package/`).
 *   2. `tar xzf` → extract.
 *   3. `npm install --omit=dev` in the extracted dir — the tarball ships only
 *      src/bin (no node_modules), and the source build imports prod deps
 *      (@modelcontextprotocol/sdk, …).
 *   4. run the package's OWN bin shim `bash <pkg>/bin/iapeer install` — that is
 *      `bun src/cli/index.ts install` from the REAL fetched source → builds the prod
 *      binary atomically (keeps `.prev`).
 * Needs npm + tar + bash + bun on PATH (the toolchain the bootstrap already assumes).
 */
function defaultRunInstall(version: string, env: NodeJS.ProcessEnv): boolean {
  if (env.IAPEER_TEST_SANDBOX === '1') {
    // A real install rebuilds the prod ~/.local/bin/iapeer — never under a test.
    throw new IapError('refusing a real install under IAPEER_TEST_SANDBOX=1 — inject runInstall in tests')
  }
  const tmp = mkdtempSync(join(tmpdir(), 'iapeer-deploy-'))
  try {
    const pack = spawnSync('npm', ['pack', '--silent', '--pack-destination', tmp, `${IAPEER_PACKAGE}@${version}`], { encoding: 'utf8', env })
    if (pack.status !== 0) return false
    const tgz = readdirSync(tmp).find(f => f.endsWith('.tgz'))
    if (!tgz) return false
    if (spawnSync('tar', ['xzf', join(tmp, tgz), '-C', tmp], { env }).status !== 0) return false
    const pkg = join(tmp, 'package') // npm-pack tarballs always root at `package/`
    const deps = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], { cwd: pkg, stdio: 'inherit', env })
    if (deps.status !== 0) return false
    const build = spawnSync('bash', [join(pkg, 'bin', 'iapeer'), 'install'], { stdio: 'inherit', env })
    return build.status === 0
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Re-register every loaded FOUNDATION-owned infra peer job after the installed
 * iapeer binary is replaced. These plists run `iapeer run-infra <peer> <runtime>`;
 * if launchd keeps the old managed launch constraint, a later KeepAlive respawn can
 * hit the same EX_CONFIG(78) LWCR crash-loop that bit the daemon. Full bootout →
 * bootstrap clears the registration. Foreign / persistent-peer plists are skipped
 * by the sentinel guard, preserving H4.
 */
export function recycleFoundationOwnedInfraJobs(env: NodeJS.ProcessEnv = process.env): InfraJobRecycleResult[] {
  if (env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1') return []
  const out: InfraJobRecycleResult[] = []
  const index = readPeersIndex({ env })
  for (const peer of index.peers) {
    const runtime = (isInfraRuntime(peer.runtime) ? peer.runtime : peer.runtimes.find(isInfraRuntime)) ?? ''
    if (!runtime) continue
    const plist = launchdPlistPath(peer.personality, env)
    if (!isFoundationOwnedPlist(plist)) continue
    const label = launchdLabel(peer.personality)
    const r = cycleLaunchdJob(label, plist, env)
    out.push({ personality: peer.personality, runtime, label, state: r.state, detail: r.detail })
  }
  return out
}

/**
 * Update the foundation to the latest published version (cloud-only) and restart
 * the daemon onto it. Idempotent + version-gated: a no-op "already-latest" when the
 * installed version equals the published one (unless `force`). Pure-ish — the three
 * effects are injected, so this is fully unit-testable.
 */
export function updateIapeer(deps: UpdateDeps = {}): UpdateResult {
  const env = deps.env ?? process.env
  const from = deps.currentVersion ?? IAPEER_VERSION
  const resolve = deps.resolveVersion ?? defaultResolveVersion
  const pinned = deps.targetVersion != null && deps.targetVersion !== ''
  const spec = pinned ? deps.targetVersion! : 'latest'

  // Resolve the DESIRED version (latest, or the exact pinned version) — and, for a pin,
  // VALIDATE it exists (a non-existent version → null → fail loud, never an npx error).
  const desired = resolve(spec, env)
  if (!desired) {
    return {
      status: 'failed',
      from,
      reason: pinned
        ? `version "${deps.targetVersion}" not found on npm`
        : `could not resolve the latest ${IAPEER_PACKAGE} version from npm (offline / registry error)`,
    }
  }
  if (desired === from && !deps.force) {
    return { status: 'already-latest', from, latest: desired }
  }

  const runInstall = deps.runInstall ?? defaultRunInstall
  if (!runInstall(desired, env)) {
    // NB: the installer is the DETERMINISTIC pack+build path (no npx — see
    // defaultRunInstall); the most common cause right after a publish is the npm
    // CDN tarball lagging the version metadata (`npm view` can already show the
    // version while `npm pack` still fails; a retry ~1 min later succeeds).
    return {
      status: 'failed',
      from,
      latest: desired,
      reason:
        `deterministic install of ${IAPEER_PACKAGE}@${desired} failed (npm pack/deps/build) — ` +
        `if just published, the registry tarball may still be propagating; retry in ~1 min`,
    }
  }

  const restart = deps.restartDaemon ?? cycleDaemon
  const d = restart(env)
  const recycleInfra = deps.recycleInfraJobs ?? recycleFoundationOwnedInfraJobs
  // If the daemon re-registration itself failed, do NOT widen the blast radius by
  // cycling infra jobs onto a binary whose daemon could not come up. Rollback will
  // re-cycle them after restoring `.prev`.
  const infra = d.state === 'failed' ? [] : recycleInfra(env)
  return {
    status: 'updated',
    from,
    to: desired,
    latest: desired,
    daemon: d.state,
    infra,
    reason: d.state === 'failed' ? `binary updated but daemon restart failed: ${d.detail ?? ''}`.trim() : undefined,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// cascadeTail — the runtimes + memory legs of the cascade `iapeer update` (FU12).
// Runs AFTER a healthy foundation update (the CLI owns that, abort-on-hard-fail);
// here we update every installed runtime then the memory provider, BEST-EFFORT — a
// component failure is reported, never aborts the rest. Pure orchestration over
// injected component-updaters (no value-import of runtime/onboard → no cycle), so it
// is hermetically testable. Returns whether anything failed (→ exit≠0).
// ─────────────────────────────────────────────────────────────────────────────

export interface CascadeTailDeps {
  /** = updateAllRuntimes (runtime/update.ts). */
  runtimes: () => Promise<UpdateRuntimeResult[]>
  /** = updateMemoryProvider (onboard/memory.ts). */
  memory: () => MemoryUpdateResult | Promise<MemoryUpdateResult>
  out: (s: string) => void
}

export async function cascadeTail(deps: CascadeTailDeps): Promise<{ failed: boolean }> {
  let failed = false

  deps.out('runtimes:\n')
  const rs = await deps.runtimes()
  if (rs.length === 0) deps.out('  (none installed)\n')
  for (const r of rs) {
    const ver = r.from || r.to ? ` ${r.from ?? '?'} → ${r.to ?? '?'}` : ''
    deps.out(`  ${r.runtime}: ${r.state}${ver}${r.detail ? ` — ${r.detail}` : ''}\n`)
    for (const p of r.restarted) deps.out(`    restart ${p.personality}: ${p.state}${p.detail ? ` — ${p.detail}` : ''}\n`)
    if (r.state === 'install-failed' || r.state === 'deploy-failed' || r.state === 'npm-unreachable') failed = true
    if (r.restarted.some(p => p.state === 'failed')) failed = true
  }

  const m = await deps.memory()
  const mver = m.from || m.to ? ` ${m.from ?? '?'} → ${m.to ?? '?'}` : ''
  deps.out(`memory: ${m.state}${m.package ? ` (${m.package}${mver})` : ''}${m.detail ? ` — ${m.detail}` : ''}\n`)
  if (m.state === 'failed') failed = true

  return { failed }
}
