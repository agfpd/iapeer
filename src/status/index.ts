// Status — the host-snapshot verb: installed-binary version, daemon health, and
// the MEMORY SLOT line (docs/Слот памяти — контракт memory provider.md). The slot
// is DECLARATIVE: a root file `~/.iapeer/memory-provider.json` written (atomically)
// by the PROVIDER's own init/uninstall — the core only ever READS it. An absent or
// unreadable file is the EMPTY slot — a fully valid state (bare core), never an
// error (fail-open). The core never acts on heartbeat staleness — it only REPORTS
// it (healing the provider's daemon is the provider's job).

import { closeSync, openSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { IAPEER_VERSION } from '../core/version.ts'
import { resolveGlobalRoot } from '../storage/index.ts'
import { daemonDiscoveryPath } from '../daemon/index.ts'
import { waitForDaemonHealthy } from '../update/index.ts'
import { iapeerBinPath } from '../install/index.ts'

/** The slot-declaration filename in the storage root (next to peers-profiles.json). */
export const MEMORY_PROVIDER_FILE = 'memory-provider.json'

// NB: the v1.1 `plugin` block (MemoryProviderPlugin + its parser) was REMOVED
// (the plugin form was retired ecosystem-wide; contract §Плагин провайдера is a
// tombstone). An unknown `plugin` key in a legacy
// declaration is simply ignored — the same fail-open as any unknown block.

/** The provider's provision command (declaration v1.2, контракт §Provision
 *  провайдера — inversion of the surface-list model). The slot declares not
 *  surfaces but a COMMAND the core shells into at the lifecycle joints (birth /
 *  verb sweeps / remove); surface forms and their uninstall accounting live
 *  entirely with the provider. The `command` must be ABSOLUTE (the daemon runs
 *  under launchd's minimal PATH); `args` get PER-ARG placeholder substitution
 *  ({cwd}/{runtime}/{personality}/{occasion}) and are spawned WITHOUT a shell
 *  (injection/quoting class). */
export interface MemoryProviderProvision {
  /** Absolute path to the provider's executable. */
  command: string
  /** Argv tail; placeholders are substituted per-argument, never shell-parsed. */
  args: string[]
}

export interface MemoryProvider {
  /** Provider name occupying the slot (e.g. "iapeer-memory"). */
  provider: string
  /** npm package of the provider (e.g. "@agfpd/iapeer-memory"). */
  package: string
  version: string
  registeredAt: string
  /** Optional liveness proxy: an absolute path whose mtime the provider's daemon
   *  refreshes. status reports its age; the core takes NO action on staleness. */
  heartbeat?: string
  /** Optional v1.2 provision command (the peer-birth joint). */
  provision?: MemoryProviderProvision
  /** Optional v1.2 unprovision command (the remove joint). */
  unprovision?: MemoryProviderProvision
}

/** Parse an optional v1.2 `provision`/`unprovision` block. Fail-open like the
 *  whole file: anything short of an ABSOLUTE command string + an array of
 *  strings → undefined (treated as absent). A relative command is INVALID by
 *  contract (launchd minimal PATH would resolve it differently per caller). */
function parseProvisionBlock(raw: unknown): MemoryProviderProvision | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.command !== 'string' || !o.command.trim().startsWith('/')) return undefined
  if (!Array.isArray(o.args) || o.args.some(a => typeof a !== 'string')) return undefined
  return { command: o.command.trim(), args: (o.args as string[]).slice() }
}

export function memoryProviderPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalRoot(env), MEMORY_PROVIDER_FILE)
}

/**
 * Read the memory-slot declaration. null = EMPTY slot (absent / unreadable /
 * schema-invalid file) — a valid state, so this NEVER throws (fail-open to bare).
 */
export function readMemoryProvider(env: NodeJS.ProcessEnv = process.env): MemoryProvider | null {
  try {
    const raw = JSON.parse(readFileSync(memoryProviderPath(env), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    if (typeof o.provider !== 'string' || !o.provider.trim()) return null
    if (typeof o.package !== 'string' || !o.package.trim()) return null
    if (typeof o.version !== 'string' || !o.version.trim()) return null
    const provision = parseProvisionBlock(o.provision)
    const unprovision = parseProvisionBlock(o.unprovision)
    return {
      provider: o.provider.trim(),
      package: o.package.trim(),
      version: o.version.trim(),
      registeredAt: typeof o.registeredAt === 'string' ? o.registeredAt : '',
      ...(typeof o.heartbeat === 'string' && o.heartbeat.trim() ? { heartbeat: o.heartbeat.trim() } : {}),
      ...(provision ? { provision } : {}),
      ...(unprovision ? { unprovision } : {}),
    }
  } catch {
    return null // empty slot — bare core is valid
  }
}

/** Age (s) of the provider's heartbeat file, or null (none declared / unreadable). */
export function heartbeatAgeSecs(provider: MemoryProvider, nowMs: number = Date.now()): number | null {
  if (!provider.heartbeat) return null
  try {
    return Math.max(0, Math.floor((nowMs - statSync(provider.heartbeat).mtimeMs) / 1000))
  } catch {
    return null
  }
}

/**
 * Probe whether the iapeer binary holds Full Disk Access (macOS TCC). Reads the
 * user TCC.db — a canonical FDA-gated resource that is NEVER promptable (silent
 * EPERM without the grant), so THE PROBE ITSELF raises no dialog (it must not be
 * the very noise it detects). Byte-free: open+close to prove access, no content
 * read. Returns:
 *   true  — readable → FDA granted
 *   false — EPERM/EACCES → FDA NOT granted (peers will hit TCC prompts on
 *           protected folders + foreign app containers — see onboard contract)
 *   null  — not macOS / no HOME / TCC.db absent → cannot determine (no claim)
 */
export function probeFullDiskAccess(env: NodeJS.ProcessEnv = process.env): boolean | null {
  if (process.platform !== 'darwin') return null
  const home = env.HOME
  if (!home) return null
  const marker = join(home, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db')
  try {
    closeSync(openSync(marker, 'r'))
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') return false
    return null // ENOENT / unexpected → undeterminable, never a false claim
  }
}

export interface HostStatus {
  version: string
  daemon: { healthy: boolean; url: string | null; sock: string | null }
  memory: { provider: MemoryProvider | null; heartbeatAgeSecs: number | null }
  /** Full Disk Access of the iapeer binary: true granted / false not-granted /
   *  null undeterminable (non-macOS or TCC.db unreadable for a non-TCC reason). */
  fda: boolean | null
}

export interface HostStatusOptions {
  env?: NodeJS.ProcessEnv
  /** Injectable daemon probe (tests). Default: the real socket probe. */
  probe?: () => Promise<boolean>
  /** Injectable FDA probe (tests — the default reads the real TCC.db, which a
   *  hermetic test must not touch). Default: probeFullDiskAccess(env). */
  fdaProbe?: () => boolean | null
}

/** Assemble the host snapshot: baked version + daemon probe + memory slot. */
export async function hostStatus(opts: HostStatusOptions = {}): Promise<HostStatus> {
  const env = opts.env ?? process.env
  let url: string | null = null
  let sock: string | null = null
  try {
    const d = JSON.parse(readFileSync(daemonDiscoveryPath({ env }), 'utf8')) as { tcp?: string | null; sock?: string | null }
    url = d.tcp ?? null
    sock = d.sock ?? null
  } catch {
    /* no discovery file → daemon down or never started; addresses stay null */
  }
  const health = await waitForDaemonHealthy({ env, timeoutMs: 2500, needConsecutive: 1, probe: opts.probe })
  const provider = readMemoryProvider(env)
  const fda = (opts.fdaProbe ?? (() => probeFullDiskAccess(env)))()
  return {
    version: IAPEER_VERSION,
    daemon: { healthy: health.healthy, url, sock },
    memory: { provider, heartbeatAgeSecs: provider ? heartbeatAgeSecs(provider) : null },
    fda,
  }
}

/** Render the human status block (one fact per line; `memory:` per the slot contract). */
export function formatHostStatus(s: HostStatus): string {
  const daemon = s.daemon.healthy
    ? `healthy${s.daemon.url ? ` @ ${s.daemon.url}` : ''}${s.daemon.sock ? ` + ${s.daemon.sock}` : ''}`
    : 'NOT healthy (socket not accepting connections)'
  // Heartbeat interpretation (slot contract, provider semantics):
  // file REMOVED on graceful shutdown → declared-but-absent = daemon not running;
  // present = age shown. The core only REPORTS — staleness healing is the
  // provider's own job (its verify/repair), never the core's.
  let hb = ''
  if (s.memory.provider?.heartbeat) {
    hb = s.memory.heartbeatAgeSecs !== null
      ? ` (heartbeat ${s.memory.heartbeatAgeSecs}s ago)`
      : ' (daemon not running — no heartbeat file)'
  }
  const memory = s.memory.provider ? `${s.memory.provider.provider} ${s.memory.provider.version}${hb}` : 'none'
  // FDA line: granted → terse OK; NOT granted → the actionable hint (a fresh host
  // without FDA silently meets TCC prompts on every new protected class — peers
  // read protected folders + foreign app containers, attributed to this binary;
  // see onboard contract §INSTALL). undeterminable → say so, never a false claim.
  let fda: string
  if (s.fda === true) {
    fda = 'fda: granted'
  } else if (s.fda === false) {
    fda =
      `fda: NOT granted — peers will hit TCC prompts on protected paths.\n` +
      `  grant: System Settings → Privacy & Security → Full Disk Access → + → ⇧⌘G → ${iapeerBinPath()}`
  } else {
    fda = 'fda: unknown (not macOS / undeterminable)'
  }
  return `iapeer ${s.version}\ndaemon: ${daemon}\nmemory: ${memory}\n${fda}\n`
}
