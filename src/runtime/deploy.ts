// deployRuntime — the onboard INFRA-DEPLOY orchestration (contract Установка §2 /
// Фаза §4). The foundation ORCHESTRATES; the package self-configures. This covers
// provision MODE (a) "declared-set": read the runtime package's manifest and provision
// the WHOLE declared peer-set (notifier → timer + watcher), each via `createPeer` —
// so each peer gets profile + registry + plist (installAlwaysOnPlist + H4 guard) +
// per-peer self-config hook + auto-bootstrap, uniformly.
//
// MODE (b) "operator-add" (telegram human) does NOT come through here — it is a direct
// `iapeer create alice --runtime telegram`. Both modes share the SAME per-peer
// self-config hook (invoked inside createPeer→initPeer); deployRuntime is just the
// enumeration of the declared set. "1 always-on infra peer = 1 plist", idempotent
// (re-deploy of an existing peer does not duplicate or clobber).
//
// The package's host-wide self-INSTALL (npx — puts the `<runtime>-runtime` bin on PATH
// and writes the manifest) is the package's job (self-deploy). The foundation invokes
// that installer (onboard delegates) and THEN calls deployRuntime; this module owns the
// second half (read manifest → provision the declared set).

import { spawnSync } from 'child_process'
import { homedir } from 'os'
import { type Runtime } from '../core/constants.ts'
import { IapError } from '../core/errors.ts'
import { createPeer, type CreatePeerResult } from '../create/index.ts'
import { readRuntimeManifest, type RuntimeManifest, type RuntimePeerDecl } from './index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Built-in runtime → npm package registry (§6): onboard AUTO-resolves
// the package for a known infra runtime and `npx`-installs it (the package self-
// deploys its bin + manifest). The operator overrides per-runtime with --package.
// FROZEN map; a runtime absent here needs an explicit --package.
// ─────────────────────────────────────────────────────────────────────────────
export const RUNTIME_PACKAGES: Readonly<Record<string, string>> = {
  telegram: '@agfpd/telegram-runtime',
  notifier: '@agfpd/notifier-runtime',
}

/** Resolve the npm package for a runtime: explicit override wins, else the built-in
 *  registry, else undefined (no mapping → caller must pass --package). */
export function resolveRuntimePackage(runtime: Runtime, override?: string): string | undefined {
  return override?.trim() || RUNTIME_PACKAGES[runtime]
}

export interface DeployRuntimeOptions {
  runtime: Runtime
  /** Override the on-disk manifest (tests / a package handing it in directly). */
  manifest?: RuntimeManifest
  /** Override the peer-set to provision (default: manifest.peers). */
  peers?: RuntimePeerDecl[]
  /** Auto-bootstrap each provisioned plist (default true; per-peer, infra). */
  bootstrap?: boolean
  env?: NodeJS.ProcessEnv
  warn?: (message: string) => void
}

export interface DeployedPeer {
  personality: string
  location: string
  /** self-config hook state for this peer (configured / failed / absent). */
  selfConfig?: string
  /** bootstrap state for this peer (loaded / already-loaded / skipped-sandbox / …). */
  bootstrap?: string
  result: CreatePeerResult
}

export interface DeployRuntimeResult {
  runtime: Runtime
  /** The peers provisioned (the declared set, or the explicit override). */
  peers: DeployedPeer[]
  /** True when the runtime declares no fixed set (mode b — operator-add only). */
  operatorAddOnly: boolean
}

/**
 * Deploy a runtime's DECLARED peer-set (mode a). Reads the package's manifest from
 * ~/.iapeer/runtimes/<runtime>/runtime.json (unless one is handed in), then provisions
 * each declared peer via createPeer (provision + per-peer self-config + auto-bootstrap).
 * A runtime with no declared peers (mode b — telegram) is `operatorAddOnly` (nothing
 * to deploy here; humans are added with `iapeer create`). Throws when no manifest is
 * found at all (the package is not installed — `npx <package>` runs first).
 */
export async function deployRuntime(opts: DeployRuntimeOptions): Promise<DeployRuntimeResult> {
  const env = opts.env ?? process.env
  const manifest = opts.manifest ?? readRuntimeManifest(opts.runtime, { env })
  if (!manifest) {
    throw new IapError(
      `no runtime manifest for "${opts.runtime}" at ~/.iapeer/runtimes/${opts.runtime}/runtime.json — ` +
        `install the runtime package first (npx <package> self-deploys it)`,
    )
  }
  const declared = opts.peers ?? manifest.peers ?? []
  const peers: DeployedPeer[] = []
  for (const decl of declared) {
    const result = await createPeer({
      personality: decl.personality,
      runtime: opts.runtime,
      intelligence: decl.intelligence,
      description: decl.description,
      path: decl.path,
      runtimeBin: decl.runtimeBin,
      bootstrap: opts.bootstrap,
      env,
      warn: opts.warn,
    })
    peers.push({
      personality: result.personality,
      location: result.location,
      selfConfig: result.selfConfig?.state,
      bootstrap: result.bootstrapped?.state,
      result,
    })
  }
  return { runtime: opts.runtime, peers, operatorAddOnly: declared.length === 0 }
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 — package self-install (npx) + onboardRuntime (npx → deploy)
// ─────────────────────────────────────────────────────────────────────────────

export type NpxState =
  | 'ran' // npx <package> ran and exited 0 (the package self-deployed)
  | 'skipped' // a manifest is already present → package installed, no re-npx
  | 'failed' // npx exited non-zero
  | 'no-package' // no built-in mapping and no --package, AND no manifest present

export interface InstallRuntimePackageResult {
  runtime: Runtime
  package?: string
  state: NpxState
  detail?: string
}

/** Injectable npx runner (so tests / a sandbox proof can simulate the package's
 *  self-deploy without a published npm package). Default: `npx -y <package>`. */
export type NpxRunner = (pkg: string, env: NodeJS.ProcessEnv) => { ok: boolean; detail?: string }

const defaultNpxRunner: NpxRunner = (pkg, env) => {
  // The package self-deploys on `npx` (puts its `<runtime>-runtime` bin on PATH and
  // writes ~/.iapeer/runtimes/<r>/runtime.json). IAPEER_ROOT in env steers it to the
  // right root (incl. a sandbox). cwd = HOME (the package is host-wide, cwd-agnostic).
  const r = spawnSync('npx', ['-y', pkg], {
    cwd: env.HOME?.trim() || homedir(),
    encoding: 'utf8',
    env: env as Record<string, string>,
  })
  if (r.error || (r.status ?? 1) !== 0) {
    return { ok: false, detail: (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim() }
  }
  return { ok: true }
}

export interface InstallRuntimePackageOptions {
  runtime: Runtime
  /** Override the built-in package mapping (--package). */
  package?: string
  /** Re-run npx even when a manifest is already present (force a package update). */
  force?: boolean
  env?: NodeJS.ProcessEnv
  /** Injected npx runner (tests / sandbox proof). */
  runNpx?: NpxRunner
}

/**
 * Ensure a runtime PACKAGE is installed (the package self-deploys its bin + manifest
 * via `npx`). IDEMPOTENT: when a manifest is already present (package installed) and
 * not forced, it is a no-op (`skipped`). Otherwise resolves the package (override →
 * built-in registry) and runs npx. No mapping + no --package + no manifest → `no-package`.
 */
export function installRuntimePackage(opts: InstallRuntimePackageOptions): InstallRuntimePackageResult {
  const env = opts.env ?? process.env
  const pkg = resolveRuntimePackage(opts.runtime, opts.package)
  const manifestPresent = readRuntimeManifest(opts.runtime, { env }) !== null
  if (manifestPresent && !opts.force) {
    return { runtime: opts.runtime, package: pkg, state: 'skipped' }
  }
  if (!pkg) {
    return { runtime: opts.runtime, state: 'no-package' }
  }
  const run = opts.runNpx ?? defaultNpxRunner
  const r = run(pkg, env)
  return { runtime: opts.runtime, package: pkg, state: r.ok ? 'ran' : 'failed', detail: r.detail }
}

export interface OnboardRuntimeOptions extends DeployRuntimeOptions {
  /** Override the built-in package mapping (--package). */
  package?: string
  /** Re-run npx even when the manifest is already present. */
  npx?: boolean
  /** Injected npx runner (tests / sandbox proof). */
  runNpx?: NpxRunner
}

export interface OnboardRuntimeResult {
  install: InstallRuntimePackageResult
  deploy?: DeployRuntimeResult
}

/**
 * §6 onboard a runtime END-TO-END: (1) ensure the package is installed (npx self-
 * deploy — auto-resolved from the built-in registry, or --package), THEN (2) deploy
 * its declared peer-set. FAIL-CLOSED: a failed npx (or no package AND no manifest)
 * aborts before deploy — never provision against a missing package. A telegram-style
 * runtime (manifest with no declared peers) installs the package and is then
 * operator-add (`iapeer create <human> --runtime telegram`).
 */
export async function onboardRuntime(opts: OnboardRuntimeOptions): Promise<OnboardRuntimeResult> {
  const env = opts.env ?? process.env
  const install = installRuntimePackage({
    runtime: opts.runtime,
    package: opts.package,
    force: opts.npx,
    env,
    runNpx: opts.runNpx,
  })
  if (install.state === 'failed') {
    throw new IapError(`npx install of runtime "${opts.runtime}" package ${install.package} failed: ${install.detail ?? ''}`)
  }
  if (install.state === 'no-package') {
    throw new IapError(
      `no package for runtime "${opts.runtime}" (no built-in mapping, no --package) and no manifest present — ` +
        `pass --package <npm-package>`,
    )
  }
  const deploy = await deployRuntime({
    runtime: opts.runtime,
    bootstrap: opts.bootstrap,
    env,
    warn: opts.warn,
  })
  return { install, deploy }
}
