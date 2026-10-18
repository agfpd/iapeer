// MCP parity across a peer's agent runtimes (verify). One personality is one agent with several
// endpoints; a tool server the peer has on one runtime but not on another makes the SAME peer silently
// weaker there (incident 17.10: after a claude-side redeploy impact-finder / mrmechanic /
// company-checker had their domain MCP servers only in .codex/config.toml — the claude session ran
// without its tools and nobody noticed). This reads each runtime's PEER-LEVEL MCP declarations and
// reports every server present on some runtime and missing on another.
//
// Sources (peer level only — host-wide runtime config is shared by all peers and not a peer fact):
//   claude   — <cwd>/.mcp.json            mcpServers.<name>
//   codex    — <cwd>/.codex/config.toml   [mcp_servers.<name>]
//   opencode — host-default + per-peer opencode.json `mcp` and the registered fragments (docs/20)
// The core's own `iapeer` server is excluded: it is wired by the core on every runtime by
// construction (host-wide for codex), so comparing it would only produce false alarms.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { opencodeHostConfigPath, type StorageOptions } from '../storage/index.ts'
import { OPENCODE_MEMORY_FRAGMENT, opencodePaths } from '../opencode/config.ts'
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

export function peerMcpServers(runtime: string, personality: string, cwd: string, options: StorageOptions = {}): string[] | null {
  let names: string[]
  if (runtime === 'claude') {
    names = jsonKeys(join(cwd, '.mcp.json'), o => o.mcpServers)
  } else if (runtime === 'codex') {
    const p = join(cwd, '.codex', 'config.toml')
    names = existsSync(p) ? codexMcpNames(readFileSync(p, 'utf8')) : []
  } else if (runtime === 'opencode') {
    const paths = opencodePaths(personality, options)
    const stems = [OPENCODE_MEMORY_FRAGMENT, ...listCapabilities(options).declarations.map(d => d.capability)]
    names = [
      ...jsonKeys(opencodeHostConfigPath(options), o => o.mcp),
      ...jsonKeys(paths.config, o => o.mcp),
      ...stems.flatMap(s => jsonKeys(join(paths.dir, `${s}.json`), o => o.mcp)),
    ]
  } else {
    return null // not an agent runtime with an MCP client
  }
  return [...new Set(names)].filter(n => n !== CORE_SERVER).sort()
}

export interface McpParityIssue {
  server: string
  presentIn: string[]
  missingIn: string[]
}

/** Every server some agent runtime of the peer declares and another lacks. */
export function mcpParity(personality: string, cwd: string, runtimes: readonly string[], options: StorageOptions = {}): McpParityIssue[] {
  const sets = new Map<string, Set<string>>()
  for (const rt of runtimes) {
    const names = peerMcpServers(rt, personality, cwd, options)
    if (names) sets.set(rt, new Set(names))
  }
  if (sets.size < 2) return []
  const all = new Set([...sets.values()].flatMap(s => [...s]))
  const issues: McpParityIssue[] = []
  for (const server of [...all].sort()) {
    const presentIn = [...sets].filter(([, s]) => s.has(server)).map(([rt]) => rt)
    const missingIn = [...sets].filter(([, s]) => !s.has(server)).map(([rt]) => rt)
    if (missingIn.length) issues.push({ server, presentIn, missingIn })
  }
  return issues
}
