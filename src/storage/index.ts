// Storage — the single authority over the ~/.iapeer/ (global) and
// <cwd>/.iapeer/ (per-peer) path trees: resolution, idempotent scaffold
// (mode 0o700), and atomic file write. Consolidated from inter-agent-protocol
// peers.ts (resolveGlobalRoot/resolvePeersPaths/ensureGlobalIapScaffold) +
// identity.ts (ensureLocalIapScaffold/ensureLocalRuntimeScopes/peerProfilePath).
//
// Structural invariant (#3): peers-profiles.json is
// the registry's exclusive, locked write target. `writeFileAtomic` REFUSES that
// basename so no module can write the registry file out from under the lock by
// reaching for the generic atomic-write primitive. The registry keeps its own
// private writer (see registry/index.ts) used only inside withPeersLock.

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { writeFileAtomicRaw } from './atomicWrite.ts'
import {
  CACHE_DIR,
  IAPEER_DIR,
  IAPEER_ROOT_ENV,
  IAP_PLUGIN_DIR,
  LOGS_DIR,
  PEERS_HOME_DIR,
  PEERS_PROFILES_FILE,
  PEERS_PROFILES_LOCK_FILE,
  PEER_PROFILE_FILE,
  PLUGINS_DIR,
  RUNTIMES_DIR,
  STATE_DIR,
  SUPPORTED_LOCAL_RUNTIMES,
  isRuntime,
  type Runtime,
  type SupportedLocalRuntime,
} from '../core/constants.ts'
import { IapError } from '../core/errors.ts'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export interface StorageOptions {
  rootDir?: string
  env?: NodeJS.ProcessEnv
}

export interface PeersPaths {
  rootDir: string
  pluginDir: string
  peersFile: string
  lockTarget: string
  tmpDir: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Root + path resolution
// ─────────────────────────────────────────────────────────────────────────────

export function resolveGlobalRoot(env: NodeJS.ProcessEnv = process.env): string {
  // One env override for the whole tree (blueprint §1 storage): IAPEER_ROOT.
  const override = env[IAPEER_ROOT_ENV]?.trim()
  if (override) return override
  const home = env.HOME?.trim() || homedir()
  if (!home) throw new IapError('cannot resolve home directory for ~/.iapeer')
  return join(home, IAPEER_DIR)
}

export function resolvePeersPaths(options: StorageOptions = {}): PeersPaths {
  const rootDir = options.rootDir ?? resolveGlobalRoot(options.env)
  return {
    rootDir,
    pluginDir: join(rootDir, PLUGINS_DIR, IAP_PLUGIN_DIR),
    peersFile: join(rootDir, PEERS_PROFILES_FILE),
    lockTarget: join(rootDir, PEERS_PROFILES_LOCK_FILE),
    tmpDir: rootDir,
  }
}

export function peerProfilePath(cwd: string): string {
  return join(cwd, IAPEER_DIR, PEER_PROFILE_FILE)
}

export function localIapPluginDir(cwd: string): string {
  return join(cwd, IAPEER_DIR, PLUGINS_DIR, IAP_PLUGIN_DIR)
}

// Per-plugin namespaced category dirs (global scope). New API per blueprint §1.
export function pluginStateDir(plugin: string, options: StorageOptions = {}): string {
  return join(resolveGlobalRoot(options.env), STATE_DIR, plugin)
}
export function pluginLogsDir(plugin: string, options: StorageOptions = {}): string {
  return join(resolveGlobalRoot(options.env), LOGS_DIR, plugin)
}

/** GLOBAL log dir for an always-on INFRA peer — `~/.iapeer/logs/<personality>/`
 *  (zone Хранение / Фаза §8: infra logs are host-service logs, kept in the global
 *  log area, NOT buried per-peer under <cwd>/.iapeer/logs/ — doubly so now peers live
 *  under ~/.iapeer/peers/). Per-PERSONALITY (not per-runtime) so two peers of one
 *  runtime — notifier timer + watcher — never collide their stdout/stderr. */
export function peerLogsDir(personality: string, options: StorageOptions = {}): string {
  return join(resolveGlobalRoot(options.env), LOGS_DIR, personality)
}
export function pluginCacheDir(plugin: string, options: StorageOptions = {}): string {
  return join(resolveGlobalRoot(options.env), CACHE_DIR, plugin)
}
export function pluginInstallDir(plugin: string, options: StorageOptions = {}): string {
  return join(resolveGlobalRoot(options.env), PLUGINS_DIR, plugin)
}
export function runtimeRoot(runtime: Runtime, options: StorageOptions = {}): string {
  return join(resolveGlobalRoot(options.env), RUNTIMES_DIR, runtime)
}

/** The foundation-owned default home for provisioned peer cwds —
 *  `~/.iapeer/peers/` (IAPEER_ROOT-aware). `iapeer create <p>` lands a new peer at
 *  `<peersHome>/<p>` when no --path is given. */
export function peersHomeDir(options: StorageOptions = {}): string {
  return join(resolveGlobalRoot(options.env), PEERS_HOME_DIR)
}

/** The default cwd for a peer created without an explicit --path:
 *  `~/.iapeer/peers/<personality>`. */
export function defaultPeerCwd(personality: string, options: StorageOptions = {}): string {
  return join(peersHomeDir(options), personality)
}
export function runtimeScopeDir(
  runtime: Runtime,
  plugin: string,
  options: StorageOptions = {},
): string {
  return join(runtimeRoot(runtime, options), PLUGINS_DIR, plugin)
}

// ─────────────────────────────────────────────────────────────────────────────
// Scaffold (idempotent mkdir, 0o700)
// ─────────────────────────────────────────────────────────────────────────────

function resolveNativeHome(options: StorageOptions): string {
  const env = options.env ?? process.env
  if (env[IAPEER_ROOT_ENV]?.trim()) {
    // Under an explicit root (tests/sandbox) the parent of the root stands in
    // for $HOME so native-runtime detection still works deterministically.
    return dirname(env[IAPEER_ROOT_ENV]!.trim())
  }
  if (env.HOME?.trim()) return env.HOME.trim()
  if (options.rootDir && basename(options.rootDir) === IAPEER_DIR) {
    return dirname(options.rootDir)
  }
  return homedir()
}

function availableGlobalRuntimeScopes(options: StorageOptions): SupportedLocalRuntime[] {
  const home = resolveNativeHome(options)
  return SUPPORTED_LOCAL_RUNTIMES.filter(runtime => existsSync(join(home, `.${runtime}`)))
}

export function ensureGlobalIapScaffold(options: StorageOptions = {}): void {
  const paths = resolvePeersPaths(options)
  mkdirSync(paths.rootDir, { recursive: true, mode: DIR_MODE })
  mkdirSync(paths.pluginDir, { recursive: true, mode: DIR_MODE })
  mkdirSync(join(paths.rootDir, STATE_DIR), { recursive: true, mode: DIR_MODE })
  mkdirSync(join(paths.rootDir, LOGS_DIR), { recursive: true, mode: DIR_MODE })
  mkdirSync(join(paths.rootDir, CACHE_DIR), { recursive: true, mode: DIR_MODE })
  // The default home for foundation-provisioned peer cwds (`iapeer create`). Made
  // here so the directory exists before the first create, install or onboard.
  mkdirSync(join(paths.rootDir, PEERS_HOME_DIR), { recursive: true, mode: DIR_MODE })
  const runtimesRoot = join(paths.rootDir, RUNTIMES_DIR)
  mkdirSync(runtimesRoot, { recursive: true, mode: DIR_MODE })
  for (const runtime of availableGlobalRuntimeScopes(options)) {
    mkdirSync(join(runtimesRoot, runtime, PLUGINS_DIR, IAP_PLUGIN_DIR), {
      recursive: true,
      mode: DIR_MODE,
    })
  }
}

export function ensureLocalIapScaffold(cwd: string = process.cwd()): void {
  const root = join(cwd, IAPEER_DIR)
  mkdirSync(root, { recursive: true, mode: DIR_MODE })
  mkdirSync(join(root, PLUGINS_DIR, IAP_PLUGIN_DIR), { recursive: true, mode: DIR_MODE })
  mkdirSync(join(root, RUNTIMES_DIR), { recursive: true, mode: DIR_MODE })
  mkdirSync(join(root, STATE_DIR), { recursive: true, mode: DIR_MODE })
  mkdirSync(join(root, LOGS_DIR), { recursive: true, mode: DIR_MODE })
  mkdirSync(join(root, CACHE_DIR), { recursive: true, mode: DIR_MODE })
}

function supportedLocalRuntimeScopes(runtimes: readonly Runtime[]): SupportedLocalRuntime[] {
  const out: SupportedLocalRuntime[] = []
  for (const runtime of runtimes) {
    if ((SUPPORTED_LOCAL_RUNTIMES as readonly string[]).includes(runtime) &&
        !out.includes(runtime as SupportedLocalRuntime)) {
      out.push(runtime as SupportedLocalRuntime)
    }
  }
  return out
}

export function ensureLocalRuntimeScopes(cwd: string, runtimes: readonly Runtime[]): void {
  const root = join(cwd, IAPEER_DIR, RUNTIMES_DIR)
  mkdirSync(root, { recursive: true, mode: DIR_MODE })
  for (const runtime of supportedLocalRuntimeScopes(runtimes)) {
    mkdirSync(join(root, runtime, PLUGINS_DIR, IAP_PLUGIN_DIR), { recursive: true, mode: DIR_MODE })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// launch.env — per-peer per-runtime launch fragment
// ─────────────────────────────────────────────────────────────────────────────

export const LAUNCH_ENV_FILE = 'launch.env'

/** `<cwd>/.iapeer/runtimes/<runtime>/launch.env` — the per-peer per-runtime launch
 *  fragment (PEER_START_ARGS + extra peer env). Written by init, read at launch. */
export function peerLaunchEnvPath(cwd: string, runtime: Runtime): string {
  return join(cwd, IAPEER_DIR, RUNTIMES_DIR, runtime, LAUNCH_ENV_FILE)
}

export interface LaunchEnv {
  /** Tokens from PEER_START_ARGS, appended AFTER the adapter's base argv flags. */
  startArgs: string[]
  /** Other KEY=VALUE assignments — extra child-process env for the peer session. */
  env: Record<string, string>
}

/**
 * Read and parse `<cwd>/.iapeer/runtimes/<runtime>/launch.env` (zone Хранение /
 * Рантайм-адаптеры). The file is a small bash-style fragment of `KEY=VALUE` (and
 * `export KEY=VALUE`) lines; the legacy launcher sourced it and expanded
 * `${PEER_START_ARGS}` UNQUOTED, so PEER_START_ARGS word-splits on whitespace —
 * reproduced here with a whitespace split (faithful to that semantics; a value
 * with embedded spaces was never one arg in the bash either). Surrounding single/
 * double quotes around a value are stripped. Lines that are blank or start with
 * `#` are ignored. A missing/unreadable file → empty (no flags, no env). This is a
 * deliberately MINIMAL parser (assignments only — no command substitution, no
 * conditionals); init writes the file, so the format is controlled.
 */
export function readLaunchEnv(cwd: string, runtime: Runtime): LaunchEnv {
  let text: string
  try {
    text = readFileSync(peerLaunchEnvPath(cwd, runtime), 'utf8')
  } catch {
    return { startArgs: [], env: {} }
  }
  const env: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    env[m[1]] = value
  }
  const startArgsRaw = (env.PEER_START_ARGS ?? '').trim()
  delete env.PEER_START_ARGS // consumed as argv, not propagated as a child env var
  return {
    startArgs: startArgsRaw ? startArgsRaw.split(/\s+/) : [],
    env,
  }
}

export function listRuntimeScopeNames(cwd: string): Runtime[] {
  const root = join(cwd, IAPEER_DIR, RUNTIMES_DIR)
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  return entries.filter(isRuntime)
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic write (generic) — guards the registry file (#3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomic write: tmp file alongside the target (same directory → within-fs
 * rename, EXDEV-safe) then rename over the destination.
 *
 * STRUCTURAL GUARD (#3): refuses to write peers-profiles.json. That file is the
 * registry's locked-write target; routing it through this generic primitive
 * would let any module bypass withPeersLock and clobber the registry. There is
 * deliberately NO unguarded variant exported from storage — the ONLY writer of
 * peers-profiles.json is registry's own private function, called under
 * withPeersLock. The guard is therefore structural, not a discipline.
 */
export function writeFileAtomic(path: string, data: string, mode: number = FILE_MODE): void {
  if (basename(path) === PEERS_PROFILES_FILE) {
    throw new IapError(
      `refusing to write ${PEERS_PROFILES_FILE} via storage.writeFileAtomic — it is the registry's locked write target; use registry.upsertPeer/removePeer/renamePeer`,
    )
  }
  // The durability core (fsync-before-rename + looped writeSync) lives in ONE place — see atomicWrite.ts.
  writeFileAtomicRaw(path, data, mode)
}
