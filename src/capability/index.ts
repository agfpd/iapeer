// Capability-plugin lifecycle (docs/21-capabilities.md).
//
// A capability plugin (statusline-injector, totp-presence, …) puts per-peer
// surfaces into a peer's runtime: hooks, a private config fragment, an MCP entry.
// Like the memory slot (ADR-009 inversion), the CORE owns WHEN and FOR WHOM —
// every agent endpoint of every peer, at birth, at a new runtime, at removal, and
// on registration — and the PLUGIN owns WHAT: it declares two commands and the
// core shells into them. The core knows nothing about surface forms.
//
// Declaration: <IAPEER_ROOT>/capabilities/<name>.json, written ONLY through
// `iapeer capability register` (validated), removed through `unregister`.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isSupportedLocalRuntime, isValidName } from '../core/constants.ts'
import { resolveGlobalRoot, writeFileAtomic, type StorageOptions } from '../storage/index.ts'
import { runProvisionCommand, type ProvisionCommandOutcome, type ProvisionOccasion } from '../enable/provisionCommand.ts'

export const CAPABILITY_SCHEMA = 1

export interface CapabilityCommand {
  /** Absolute path to the plugin's executable (launchd's minimal PATH resolves nothing). */
  command: string
  /** Argv tail; {cwd} {runtime} {personality} {occasion} are substituted per argument, no shell. */
  args: string[]
}

export interface CapabilityDeclaration {
  schema: 1
  /** The capability name = the declaration file stem. */
  capability: string
  package?: string
  version?: string
  /** Agent runtimes the plugin provisions for. Endpoints of other runtimes are skipped. */
  runtimes: string[]
  provision: CapabilityCommand
  unprovision: CapabilityCommand
}

export function capabilitiesDir(options: StorageOptions = {}): string {
  return join(options.rootDir ?? resolveGlobalRoot(options.env), 'capabilities')
}

function command(value: unknown, where: string): CapabilityCommand {
  const v = value as Partial<CapabilityCommand> | null
  if (!v || typeof v !== 'object') throw new Error(`${where}: expected {command, args}`)
  if (typeof v.command !== 'string' || !isAbsolute(v.command)) throw new Error(`${where}.command must be an absolute path`)
  if (!Array.isArray(v.args) || v.args.some(a => typeof a !== 'string')) throw new Error(`${where}.args must be an array of strings`)
  if (!v.args.some(a => a.includes('{personality}'))) {
    // Several personalities can share one cwd: a command that cannot tell them apart
    // would provision or tear down the wrong peer's surfaces.
    throw new Error(`${where}.args must carry {personality}`)
  }
  return { command: v.command, args: [...v.args] }
}

/** Validate an untrusted declaration. Throws with the first violation. */
export function parseCapabilityDeclaration(raw: unknown): CapabilityDeclaration {
  const d = raw as Record<string, unknown> | null
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('declaration must be a JSON object')
  if (d.schema !== CAPABILITY_SCHEMA) throw new Error(`unsupported schema ${JSON.stringify(d.schema)} (expected ${CAPABILITY_SCHEMA})`)
  if (!isValidName(d.capability)) throw new Error(`invalid capability name ${JSON.stringify(d.capability)}`)
  if (!Array.isArray(d.runtimes) || d.runtimes.length === 0 || d.runtimes.some(r => typeof r !== 'string')) {
    throw new Error('runtimes must be a non-empty array of runtime names')
  }
  for (const k of ['package', 'version'] as const) {
    if (d[k] !== undefined && typeof d[k] !== 'string') throw new Error(`${k} must be a string`)
  }
  return {
    schema: CAPABILITY_SCHEMA,
    capability: d.capability as string,
    ...(d.package ? { package: d.package as string } : {}),
    ...(d.version ? { version: d.version as string } : {}),
    runtimes: [...new Set(d.runtimes as string[])],
    provision: command(d.provision, 'provision'),
    unprovision: command(d.unprovision, 'unprovision'),
  }
}

export interface CapabilityListing {
  declarations: CapabilityDeclaration[]
  /** Files that exist but do not validate — reported, never silently skipped. */
  invalid: { file: string; error: string }[]
}

export function listCapabilities(options: StorageOptions = {}): CapabilityListing {
  const dir = capabilitiesDir(options)
  const out: CapabilityListing = { declarations: [], invalid: [] }
  if (!existsSync(dir)) return out
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    try {
      const decl = parseCapabilityDeclaration(JSON.parse(readFileSync(join(dir, f), 'utf8')))
      if (`${decl.capability}.json` !== f) throw new Error(`file name must be ${decl.capability}.json`)
      out.declarations.push(decl)
    } catch (e) {
      out.invalid.push({ file: join(dir, f), error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

export function writeCapabilityDeclaration(decl: CapabilityDeclaration, options: StorageOptions = {}): string {
  const dir = capabilitiesDir(options)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${decl.capability}.json`)
  writeFileAtomic(path, JSON.stringify(decl, null, 2) + '\n', 0o600)
  return path
}

export function removeCapabilityDeclaration(name: string, options: StorageOptions = {}): boolean {
  if (!isValidName(name)) throw new Error(`invalid capability name ${JSON.stringify(name)}`)
  const path = join(capabilitiesDir(options), `${name}.json`)
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}

/** The (runtime) endpoints of a peer a capability applies to: declared by the peer,
 *  hostable as an agent by this core, and listed by the capability. */
export function capabilityEndpoints(decl: CapabilityDeclaration, peerRuntimes: readonly string[]): string[] {
  return peerRuntimes.filter(r => isSupportedLocalRuntime(r) && decl.runtimes.includes(r))
}

export interface CapabilityRun {
  capability: string
  runtime: string
  outcome: ProvisionCommandOutcome
}

/**
 * Run one lifecycle command of every applicable capability for ONE peer. Never
 * throws; callers decide how loud a failure is (birth/remove: warn and continue).
 * `only` narrows to one capability (register/unregister sweeps).
 */
export function runCapabilityLifecycle(args: {
  kind: 'provision' | 'unprovision'
  personality: string
  cwd: string
  runtimes: readonly string[]
  occasion: ProvisionOccasion
  env?: NodeJS.ProcessEnv
  only?: CapabilityDeclaration
  rootDir?: string
}): CapabilityRun[] {
  const decls = args.only ? [args.only] : listCapabilities({ env: args.env, rootDir: args.rootDir }).declarations
  const runs: CapabilityRun[] = []
  for (const decl of decls) {
    for (const runtime of capabilityEndpoints(decl, args.runtimes)) {
      const outcome = runProvisionCommand({
        block: args.kind === 'provision' ? decl.provision : decl.unprovision,
        cwd: args.cwd,
        runtime,
        personality: args.personality,
        occasion: args.occasion,
        env: args.env,
      })
      runs.push({ capability: decl.capability, runtime, outcome })
    }
  }
  return runs
}
