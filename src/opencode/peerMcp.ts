// Peer MCP projection into OpenCode (docs/20 §Peer MCP). Invariant (boris 18.10): after add-runtime
// the peer on its new runtime sees the SAME MCP set as on its other runtimes, and verify is clean
// with no hand edit. The source of truth stays the peer's claude/codex declarations (+ their enabled
// plugins, src/mcp/peerServers.ts); OpenCode gets a core-owned PROJECTION of them — never a hand-kept
// copy. It is regenerated on add-runtime, on every OpenCode launch and by `verify --fix`, so a server
// added to `.mcp.json` later reaches OpenCode on the next launch instead of drifting.
//
// Ownership: `<private dir>/peer-mcp.json` is the core's; operator entries live in the peer's own
// opencode.json and win over the projection (merge order in composeOpencodeConfig). Names already
// supplied by another OpenCode source (host default, peer config, memory/capability fragments) are NOT
// projected — a deep merge of two definitions of one server would mix their fields. The core's own
// `iapeer` server is never projected.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { opencodeHostConfigPath, writeFileAtomic, type StorageOptions } from '../storage/index.ts'
import { OPENCODE_MEMORY_FRAGMENT, opencodePaths } from './config.ts'
import { listCapabilities } from '../capability/index.ts'
import { claudeServers, codexServers, toOpencodeMcp, type McpSpec } from '../mcp/peerServers.ts'

const CORE_SERVER = 'iapeer'

function mcpKeys(path: string): string[] {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as { mcp?: unknown }
    return o.mcp && typeof o.mcp === 'object' && !Array.isArray(o.mcp) ? Object.keys(o.mcp) : []
  } catch {
    return []
  }
}

/** Server names OpenCode already gets from a source OTHER than the projection. */
export function opencodeOwnServers(personality: string, options: StorageOptions = {}): Set<string> {
  const paths = opencodePaths(personality, options)
  const stems = [OPENCODE_MEMORY_FRAGMENT, ...listCapabilities(options).declarations.map(d => d.capability)]
  return new Set([
    ...mcpKeys(opencodeHostConfigPath(options)),
    ...mcpKeys(paths.config),
    ...stems.flatMap(s => mcpKeys(join(paths.dir, `${s}.json`))),
  ])
}

export interface PeerMcpSync {
  /** Servers now projected into OpenCode. */
  projected: string[]
  /** Servers deliberately not projected (already supplied by another OpenCode source). */
  ownedElsewhere: string[]
  changed: boolean
  path: string
}

/** The specs the peer declares on its claude/codex runtimes (claude's definition wins a name clash). */
export function peerSourceServers(cwd: string, runtimes: readonly string[], env: NodeJS.ProcessEnv): Map<string, McpSpec> {
  const out = new Map<string, McpSpec>()
  // PEER-scope only: a server a host-wide plugin gives every peer of one runtime is a host decision,
  // not this peer's — projecting it would silently widen OpenCode beyond what the peer declared.
  if (runtimes.includes('claude')) for (const [n, s] of claudeServers(cwd, { env })) if (s.scope === 'peer') out.set(n, s)
  if (runtimes.includes('codex')) for (const [n, s] of codexServers(cwd, { env })) if (s.scope === 'peer' && !out.has(n)) out.set(n, s)
  out.delete(CORE_SERVER)
  return out
}

/** Regenerate the projection. Idempotent: an unchanged result is not rewritten. */
export function syncOpencodePeerMcp(personality: string, cwd: string, runtimes: readonly string[], options: StorageOptions = {}): PeerMcpSync {
  const env = options.env ?? process.env
  const paths = opencodePaths(personality, options)
  const own = opencodeOwnServers(personality, options)
  const mcp: Record<string, unknown> = {}
  const ownedElsewhere: string[] = []
  for (const [name, spec] of [...peerSourceServers(cwd, runtimes, env)].sort(([a], [b]) => a.localeCompare(b))) {
    if (own.has(name)) {
      ownedElsewhere.push(name)
      continue
    }
    mcp[name] = toOpencodeMcp(spec)
  }
  const projected = Object.keys(mcp)
  const prior = existsSync(paths.peerMcp) ? readFileSync(paths.peerMcp, 'utf8') : null
  if (projected.length === 0) {
    if (prior !== null) rmSync(paths.peerMcp, { force: true })
    return { projected, ownedElsewhere, changed: prior !== null, path: paths.peerMcp }
  }
  const next = `${JSON.stringify({ mcp }, null, 2)}\n`
  if (prior === next) return { projected, ownedElsewhere, changed: false, path: paths.peerMcp }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  // 0600: the projected env carries the servers' own secrets, exactly as the source files do.
  writeFileAtomic(paths.peerMcp, next, 0o600)
  return { projected, ownedElsewhere, changed: true, path: paths.peerMcp }
}
