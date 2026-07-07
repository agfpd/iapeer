// Status — the host-snapshot verb: installed-binary version, daemon health, and
// the provider-SLOT lines (docs/Слот памяти — контракт memory provider.md). A slot
// is DECLARATIVE: a root file (`~/.iapeer/memory-provider.json`, `voice-provider.json`)
// written (atomically) by the PROVIDER's own init/uninstall — the core only ever
// READS it. An absent or unreadable file is the EMPTY slot — a fully valid state
// (bare core), never an error (fail-open). The core never acts on heartbeat
// staleness — it only REPORTS it (healing the provider's daemon is the provider's
// job). Two slots share the same declarative contract: MEMORY (auto-at-birth, carries
// provision/unprovision) and VOICE (host-level backend only; per-peer voice tooling is
// the separate `iapeer enable voice-connect <peer>` — the voice slot carries NO
// provision/unprovision, and adds an `endpoint` for HTTP-facade discovery).

import { closeSync, openSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { IAPEER_VERSION } from '../core/version.ts'
import { resolveGlobalRoot, pluginInstallDir } from '../storage/index.ts'
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

/** Age (s) of a provider's heartbeat file, or null (none declared / unreadable).
 *  Generic over any slot carrying an optional `heartbeat` path (memory + voice). */
export function heartbeatAgeSecs(provider: { heartbeat?: string }, nowMs: number = Date.now()): number | null {
  if (!provider.heartbeat) return null
  try {
    return Math.max(0, Math.floor((nowMs - statSync(provider.heartbeat).mtimeMs) / 1000))
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sandbox writable roots for a gated codex peer (docs/17). A gated codex session
// launches under `sandbox_mode=workspace-write`: writes to its own cwd (+ /tmp,
// $TMPDIR) are silent, but a write OUTSIDE those — a memory note into the shared
// vault, which lives in iCloud OUTSIDE every peer cwd — is BLOCKED and pops codex's
// native approval modal. Routine memory writes must not prompt, so the vault is added
// to `sandbox_workspace_write.writable_roots` at launch. This resolves those extra
// writable root(s) for the host (empty when the host has no memory provider).
// ─────────────────────────────────────────────────────────────────────────────

/** config.env key the memory provider records its vault path under. */
const MEMORY_VAULT_ENV_KEY = 'IAPEER_MEMORY_VAULT_PATH'

/**
 * Extra sandbox-writable roots a gated codex peer needs beyond its cwd — the memory vault
 * on a host that has a memory provider, else empty.
 *
 * INTERIM TECHDEBT (v1 — a durable, tracked debt, NOT a permanent design): the vault path is
 * read from the provider's OPERATOR-OWNED `config.env` (`IAPEER_MEMORY_VAULT_PATH`), located via
 * the provider name the memory SLOT declares. This deliberately BYPASSES the slot contract — the
 * slot (`memory-provider.json`) is the ONLY declarative foundation↔provider boundary; `config.env`
 * is the provider's PRIVATE surface. It is read-only and fail-open, but it IS a side-coupling that a
 * future change to the slot contract must be aware of. Why the bypass: the slot is single-writer
 * (the provider), so foundation cannot populate a vault field itself, and adding one is a cross-repo
 * change to `@agfpd/iapeer-memory` + its release — a disproportionate cost that would block delivery
 * on a foreign deploy. FOLLOW-UP (the way out of the debt): promote the data root INTO the slot (a
 * `MemoryProvider.dataRoots` field the provider writes) so foundation reads it from the declared
 * contract and this `config.env` read is retired.
 *
 * Fail-open at every step: no memory slot / no config.env / no key / a non-absolute value → `[]`. A
 * gated codex peer still works with an empty result — only a cross-vault write would then prompt (a
 * safe degraded state, never a break). Uses the injected `env` for path resolution (IAPEER_ROOT-aware
 * → sandbox-isolated in tests, exactly like the rest of the storage layer).
 */
export function resolveMemoryWritableRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const slot = readMemoryProvider(env)
  if (!slot) return [] // no memory provider on this host → no vault to grant
  try {
    const cfgPath = join(pluginInstallDir(slot.provider, { env }), 'config.env')
    const text = readFileSync(cfgPath, 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (!m || m[1] !== MEMORY_VAULT_ENV_KEY) continue
      let value = m[2].trim()
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1)
      }
      // Absolute path only — a relative writable_root is meaningless to codex's sandbox.
      return value.startsWith('/') ? [value] : []
    }
    return [] // key absent from config.env
  } catch {
    return [] // unreadable config.env — fail-open to bare
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VOICE slot — the voice-connect provider declaration (the same declarative
// contract as memory, two differences by design: NO provision/unprovision (voice
// is opt-in PER-PEER via `iapeer enable`, not auto-at-birth), and an `endpoint`
// (+ a named `routes` object the core does NOT parse) for the HTTP-facade that
// telegram-STT / voicetalk consume with no MCP at all). The core only READS it.
// ─────────────────────────────────────────────────────────────────────────────

/** The voice-slot declaration filename in the storage root. */
export const VOICE_PROVIDER_FILE = 'voice-provider.json'

export interface VoiceProvider {
  /** Provider name occupying the slot (e.g. "voice-connect"). */
  provider: string
  /** npm package of the provider (e.g. "@agfpd/voice-connect"). */
  package: string
  version: string
  registeredAt: string
  /** Optional liveness proxy: an absolute path whose mtime the provider's HTTP
   *  daemon refreshes. status reports its age; the core takes NO action on staleness. */
  heartbeat?: string
  /** Base URL of the provider's HTTP facade (e.g. "http://127.0.0.1:PORT") — shown
   *  in status for discovery. Opaque to the core. */
  endpoint?: string
}

export function voiceProviderPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalRoot(env), VOICE_PROVIDER_FILE)
}

/**
 * Read the voice-slot declaration. null = EMPTY slot (absent / unreadable /
 * schema-invalid file) — a valid state, so this NEVER throws (fail-open to bare).
 * Self-management extras the provider may add (label/managed/host/port/routes) are
 * ignored — the core reads only the contract fields it acts/reports on.
 */
export function readVoiceProvider(env: NodeJS.ProcessEnv = process.env): VoiceProvider | null {
  try {
    const raw = JSON.parse(readFileSync(voiceProviderPath(env), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    if (typeof o.provider !== 'string' || !o.provider.trim()) return null
    if (typeof o.package !== 'string' || !o.package.trim()) return null
    if (typeof o.version !== 'string' || !o.version.trim()) return null
    return {
      provider: o.provider.trim(),
      package: o.package.trim(),
      version: o.version.trim(),
      registeredAt: typeof o.registeredAt === 'string' ? o.registeredAt : '',
      ...(typeof o.heartbeat === 'string' && o.heartbeat.trim() ? { heartbeat: o.heartbeat.trim() } : {}),
      ...(typeof o.endpoint === 'string' && o.endpoint.trim() ? { endpoint: o.endpoint.trim() } : {}),
    }
  } catch {
    return null // empty slot — bare core is valid
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
  voice: { provider: VoiceProvider | null; heartbeatAgeSecs: number | null }
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
  const voice = readVoiceProvider(env)
  const fda = (opts.fdaProbe ?? (() => probeFullDiskAccess(env)))()
  return {
    version: IAPEER_VERSION,
    daemon: { healthy: health.healthy, url, sock },
    memory: { provider, heartbeatAgeSecs: provider ? heartbeatAgeSecs(provider) : null },
    voice: { provider: voice, heartbeatAgeSecs: voice ? heartbeatAgeSecs(voice) : null },
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
  // Voice slot — same heartbeat semantics as memory; also show the HTTP endpoint
  // (discovery target for telegram-STT / voicetalk). 'none' when the slot is empty.
  let vhb = ''
  if (s.voice.provider?.heartbeat) {
    vhb = s.voice.heartbeatAgeSecs !== null
      ? ` (heartbeat ${s.voice.heartbeatAgeSecs}s ago)`
      : ' (daemon not running — no heartbeat file)'
  }
  const voice = s.voice.provider
    ? `${s.voice.provider.provider} ${s.voice.provider.version}${s.voice.provider.endpoint ? ` @ ${s.voice.provider.endpoint}` : ''}${vhb}`
    : 'none'
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
  return `iapeer ${s.version}\ndaemon: ${daemon}\nmemory: ${memory}\nvoice: ${voice}\n${fda}\n`
}
