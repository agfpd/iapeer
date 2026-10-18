// MCP parity across a peer's agent runtimes (verify). One personality is one agent with several
// endpoints; a tool server the peer has on one runtime but not on another makes the SAME peer silently
// weaker there (incident 17.10: after a claude-side redeploy impact-finder / mrmechanic /
// company-checker had their domain MCP servers only in .codex/config.toml — the claude session ran
// without its tools and nobody noticed). This reads each runtime's PEER-LEVEL MCP declarations and
// reports every server present on some runtime and missing on another.
//
// Sources — what the runtime ACTUALLY sees at launch (src/mcp/peerServers.ts):
//   claude   — <cwd>/.mcp.json mcpServers + servers of the plugins enabled for the peer
//   codex    — <cwd>/.codex/config.toml [mcp_servers] + servers of the enabled codex plugins
//              (host config.toml, overridden by the peer's) — a plugin-delivered server is real
//              (boris 18.10: voice-connect was a false ✗ because only the peer file was read)
//   opencode — host-default + per-peer opencode.json `mcp`, the core's peer-mcp projection and the
//              registered fragments (docs/20)
// The core's own `iapeer` server is excluded: it is wired by the core on every runtime by
// construction (host-wide for codex), so comparing it would only produce false alarms.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { opencodeHostConfigPath, type StorageOptions } from '../storage/index.ts'
import { OPENCODE_MEMORY_FRAGMENT, OPENCODE_PEER_MCP_FRAGMENT, opencodePaths } from '../opencode/config.ts'
import { claudeServers, codexServers } from '../mcp/peerServers.ts'
import { listCapabilities } from '../capability/index.ts'

const CORE_SERVER = 'iapeer'

function jsonKeys(path: string, pick: (o: Record<string, unknown>) => unknown): string[] {
  try {
    const o = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const v = pick(o)
    return v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object) : []
  } catch {
    return []
  }
}

/** `[mcp_servers.<name>]` / `[mcp_servers."<name>"]` table headers (sub-tables like `.env` ignored). */
export function codexMcpNames(toml: string): string[] {
  const out = new Set<string>()
  for (const m of toml.matchAll(/^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]/gm)) out.add((m[1] ?? m[2])!)
  return [...out]
}

export interface RuntimeMcpView {
  /** Servers the PEER declares on this runtime (its own files / peer-level plugin enables). */
  declared: Set<string>
  /** Everything the runtime actually sees: declared ∪ host-wide plugin servers. */
  available: Set<string>
}

export function peerMcpView(runtime: string, personality: string, cwd: string, options: StorageOptions = {}): RuntimeMcpView | null {
  const env = options.env ?? process.env
  const drop = (names: Iterable<string>): Set<string> => new Set([...names].filter(n => n !== CORE_SERVER))
  if (runtime === 'claude' || runtime === 'codex') {
    const m = runtime === 'claude' ? claudeServers(cwd, { env }) : codexServers(cwd, { env })
    return { declared: drop([...m].filter(([, s]) => s.scope === 'peer').map(([n]) => n)), available: drop(m.keys()) }
  }
  if (runtime === 'opencode') {
    const paths = opencodePaths(personality, options)
    const stems = [OPENCODE_MEMORY_FRAGMENT, OPENCODE_PEER_MCP_FRAGMENT, ...listCapabilities(options).declarations.map(d => d.capability)]
    const peerLevel = [...jsonKeys(paths.config, o => o.mcp), ...stems.flatMap(s => jsonKeys(join(paths.dir, `${s}.json`), o => o.mcp))]
    const host = jsonKeys(opencodeHostConfigPath(options), o => o.mcp)
    return { declared: drop(peerLevel), available: drop([...peerLevel, ...host]) }
  }
  return null // not an agent runtime with an MCP client
}

/** Back-compat: the names a runtime sees (available set), sorted. */
export function peerMcpServers(runtime: string, personality: string, cwd: string, options: StorageOptions = {}): string[] | null {
  const v = peerMcpView(runtime, personality, cwd, options)
  return v ? [...v.available].sort() : null
}

export interface McpParityIssue {
  server: string
  presentIn: string[]
  missingIn: string[]
}

/**
 * Every server some agent runtime of the peer DECLARES and another runtime does not SEE. A server that
 * only a host-wide plugin supplies is never an issue on its own (host decision, not peer drift), but it
 * does satisfy a declaration elsewhere — voice-connect declares its server in .mcp.json and codex gets
 * the same server from the enabled host plugin: present on both, no ✗ (boris 18.10).
 */
export function mcpParity(personality: string, cwd: string, runtimes: readonly string[], options: StorageOptions = {}): McpParityIssue[] {
  const views = new Map<string, RuntimeMcpView>()
  for (const rt of runtimes) {
    const v = peerMcpView(rt, personality, cwd, options)
    if (v) views.set(rt, v)
  }
  if (views.size < 2) return []
  const declaredAnywhere = new Set([...views.values()].flatMap(v => [...v.declared]))
  const issues: McpParityIssue[] = []
  for (const server of [...declaredAnywhere].sort()) {
    const presentIn = [...views].filter(([, v]) => v.available.has(server)).map(([rt]) => rt)
    const missingIn = [...views].filter(([, v]) => !v.available.has(server)).map(([rt]) => rt)
    if (missingIn.length) issues.push({ server, presentIn, missingIn })
  }
  return issues
}
