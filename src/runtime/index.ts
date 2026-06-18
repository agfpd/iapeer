// runtime — the PACKAGE-FACING contract for an iapeer runtime package (telegram,
// notifier, …): the runtime MANIFEST a package declares, and the PER-PEER self-config
// hook the foundation invokes. This is the Волна-2 gate (contract Протокол iapeer
// рантайма / Стандарт iapeer плагина): a runtime package implements against THIS
// surface; the foundation orchestrates without knowing the package's internals.
//
// TWO PROVISION MODES, ONE HOOK (the key shape):
//   (a) declared-set  — a package whose peers are FIXED FUNCTIONS (notifier: timer +
//       watcher) lists them in manifest.peers; `deployRuntime` provisions the whole
//       declared set. Static.
//   (b) operator-add  — a package whose peers are PEOPLE the package can't know ahead
//       (telegram: a human) declares NO peers; the operator adds one dynamically with
//       `iapeer create alice --runtime telegram`. Dynamic.
// BOTH converge on the SAME per-peer self-config hook ("configure runtime state for
// peer X", idempotent). The hook is per-peer; only the enumeration/trigger differs.
// So manifest.peers is OPTIONAL (mode b omits it); manifest.selfConfig is the shared
// contract both modes call. (Mirror of the capability `setup` descriptor in enable.)
//
// The manifest lives at ~/.iapeer/runtimes/<runtime>/runtime.json — the runtime's own
// namespace (zone Хранение). The package writes it at npx-install (self-deploy); the
// foundation reads it at create / deploy.

import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { isRuntime, type Intelligence, type Runtime } from '../core/constants.ts'
import { IapError } from '../core/errors.ts'
import { runtimeRoot, writeFileAtomic, type StorageOptions } from '../storage/index.ts'

/** The runtime manifest filename inside ~/.iapeer/runtimes/<runtime>/. */
export const RUNTIME_MANIFEST_FILE = 'runtime.json'

/** A self-config hook descriptor: a bare command (PATH-resolvable or absolute), or
 *  {command, args}. Same shape as the capability `setup` descriptor (enable). */
export type SelfConfigDescriptor = string | { command: string; args?: string[] }

/** One declared peer in a package's FIXED set (mode a). personality is required; the
 *  rest default (intelligence → the runtime's zone default; cwd → ~/.iapeer/peers/<p>). */
export interface RuntimePeerDecl {
  personality: string
  intelligence?: Intelligence
  description?: string
  /** Explicit cwd; default ~/.iapeer/peers/<personality>. */
  path?: string
  /** Abs path / PATH name of the runtime launcher for THIS peer's plist (rarely
   *  needed — the default `<runtime>-runtime` on PATH resolves it). */
  runtimeBin?: string
}

/** The package-declared runtime manifest (~/.iapeer/runtimes/<runtime>/runtime.json). */
export interface RuntimeManifest {
  /** The runtime id this manifest describes (must match the folder it lives in). */
  runtime: Runtime
  /** OPTIONAL installed package version (the package's self-install stamp).
   *  `update-runtime` version-gates on it; absent → no gate, the update
   *  re-installs idempotently. */
  version?: string
  /** OPTIONAL per-peer self-config hook (the shared contract both modes call). */
  selfConfig?: SelfConfigDescriptor
  /** OPTIONAL fixed peer-set (mode a). Omitted by an operator-add runtime (mode b). */
  peers?: RuntimePeerDecl[]
}

/** Path to a runtime's manifest: ~/.iapeer/runtimes/<runtime>/runtime.json. */
export function runtimeManifestPath(runtime: Runtime, options: StorageOptions = {}): string {
  return join(runtimeRoot(runtime, options), RUNTIME_MANIFEST_FILE)
}

// ─────────────────────────────────────────────────────────────────────────────
// Read / write the manifest
// ─────────────────────────────────────────────────────────────────────────────

function normalizeManifest(raw: unknown, runtime: Runtime): RuntimeManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IapError(`runtime manifest for "${runtime}" is not a JSON object`)
  }
  const obj = raw as Record<string, unknown>
  const declaredRuntime = typeof obj.runtime === 'string' ? obj.runtime : runtime
  if (!isRuntime(declaredRuntime)) {
    throw new IapError(`runtime manifest "runtime" is invalid: "${String(obj.runtime)}"`)
  }
  if (declaredRuntime !== runtime) {
    throw new IapError(
      `runtime manifest at runtimes/${runtime}/ declares runtime "${declaredRuntime}" — mismatch`,
    )
  }
  let selfConfig: SelfConfigDescriptor | undefined
  if (typeof obj.selfConfig === 'string' && obj.selfConfig.trim()) {
    selfConfig = obj.selfConfig
  } else if (
    obj.selfConfig &&
    typeof obj.selfConfig === 'object' &&
    typeof (obj.selfConfig as { command?: unknown }).command === 'string'
  ) {
    const sc = obj.selfConfig as { command: string; args?: unknown }
    selfConfig = { command: sc.command, args: Array.isArray(sc.args) ? sc.args.map(String) : undefined }
  }
  let peers: RuntimePeerDecl[] | undefined
  if (Array.isArray(obj.peers)) {
    peers = obj.peers.flatMap(p => {
      if (!p || typeof p !== 'object') return []
      const o = p as Record<string, unknown>
      if (typeof o.personality !== 'string' || !o.personality.trim()) return []
      return [
        {
          personality: o.personality,
          intelligence: typeof o.intelligence === 'string' ? (o.intelligence as Intelligence) : undefined,
          description: typeof o.description === 'string' ? o.description : undefined,
          path: typeof o.path === 'string' ? o.path : undefined,
          runtimeBin: typeof o.runtimeBin === 'string' ? o.runtimeBin : undefined,
        },
      ]
    })
  }
  const version = typeof obj.version === 'string' && obj.version.trim() ? obj.version.trim() : undefined
  return { runtime: declaredRuntime, ...(version ? { version } : {}), ...(selfConfig ? { selfConfig } : {}), ...(peers ? { peers } : {}) }
}

/** Read a runtime's manifest (~/.iapeer/runtimes/<runtime>/runtime.json), or null when
 *  absent (the package is not installed). Throws on a present-but-malformed manifest —
 *  it is the package's declared contract, a corruption should surface, not silently
 *  degrade an always-on deploy. */
export function readRuntimeManifest(runtime: Runtime, options: StorageOptions = {}): RuntimeManifest | null {
  const path = runtimeManifestPath(runtime, options)
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new IapError(`runtime manifest ${path} is invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  return normalizeManifest(raw, runtime)
}

/** Write a runtime's manifest atomically (the helper a package uses at npx-install to
 *  self-deploy its declaration; also used by tests/foundation registration). */
export function writeRuntimeManifest(manifest: RuntimeManifest, options: StorageOptions = {}): string {
  if (!isRuntime(manifest.runtime)) {
    throw new IapError(`writeRuntimeManifest: invalid runtime "${manifest.runtime}"`)
  }
  const path = runtimeManifestPath(manifest.runtime, options)
  writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`, 0o644)
  return path
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-peer self-config hook invocation (the shared contract both modes call)
// ─────────────────────────────────────────────────────────────────────────────

export type SelfConfigState =
  | 'absent' // no manifest / no selfConfig declared → nothing to run (no-op)
  | 'configured' // the hook ran and exited 0
  | 'failed' // the hook ran and exited non-zero (or could not be spawned)

export interface SelfConfigResult {
  state: SelfConfigState
  detail?: string
}

export interface SelfConfigPeer {
  personality: string
  cwd: string
  runtime: Runtime
  intelligence: Intelligence
}

/**
 * Invoke a runtime package's PER-PEER self-config hook (the shared contract for both
 * provision modes). Looks up the runtime's manifest; if it declares `selfConfig`, runs
 * it with cwd = the peer cwd and the peer context in NAMESPACED env (IAPEER_PEER_* —
 * NOT the bare PEER_* the identity gate keys on, same lesson as enable's setup). The
 * package's hook is expected to be IDEMPOTENT ("ensure runtime state for this peer").
 * No manifest / no hook → `absent` (a no-op — e.g. an agentic runtime, or a runtime
 * package not installed). A non-zero exit → `failed` (the caller decides fail-closed).
 */
export function runtimeSelfConfig(peer: SelfConfigPeer, options: StorageOptions = {}): SelfConfigResult {
  const env = options.env ?? process.env
  const manifest = readRuntimeManifest(peer.runtime, { env })
  const descriptor = manifest?.selfConfig
  if (!descriptor) return { state: 'absent' }

  const [command, ...preArgs] =
    typeof descriptor === 'string' ? [descriptor] : [descriptor.command, ...(descriptor.args ?? [])]
  const hookEnv: NodeJS.ProcessEnv = {
    ...env,
    IAPEER_PEER_PERSONALITY: peer.personality,
    IAPEER_PEER_CWD: peer.cwd,
    IAPEER_PEER_RUNTIME: peer.runtime,
    IAPEER_PEER_INTELLIGENCE: peer.intelligence,
  }
  const r = spawnSync(command, preArgs, { cwd: peer.cwd, encoding: 'utf8', env: hookEnv as Record<string, string> })
  if (r.error || (r.status ?? 1) !== 0) {
    return { state: 'failed', detail: (r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim() }
  }
  return { state: 'configured' }
}
