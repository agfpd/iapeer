// Static prerequisite check, not an MCP connectivity probe. OpenCode injects its
// core server at launch; Claude and Codex need persistent daemon wiring.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StorageOptions } from '../storage/index.ts'
import { codexConfigPath } from '../init/index.ts'

type Obj = Record<string, unknown>
function server(path: string, toml = false): Obj | false | null {
  try {
    const text = readFileSync(path, 'utf8')
    const cfg = (toml ? Bun.TOML.parse(text) : JSON.parse(text)) as Obj
    const servers = cfg[toml ? 'mcp_servers' : 'mcpServers'] as Obj | undefined
    const value = servers?.iapeer
    return value === undefined ? null : value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : false
  } catch (e) {
    // A broken override is not an absent override: do not bless it with the host fallback.
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : false
  }
}

export interface RuntimeWiringIssue { runtime: string; detail: string }

export function runtimeWiringIssues(cwd: string, runtimes: readonly string[], options: StorageOptions = {}): RuntimeWiringIssue[] {
  const issues: RuntimeWiringIssue[] = []
  for (const runtime of runtimes) {
    let s: Obj | false | null
    if (runtime === 'claude') s = server(join(cwd, '.mcp.json'))
    else if (runtime === 'codex') {
      // Config tables merge; a peer can override only headers or enabled. A broken
      // document must not be blessed by otherwise healthy inherited configuration.
      const host = server(codexConfigPath(options), true)
      const peer = server(join(cwd, '.codex', 'config.toml'), true)
      s = host === false || peer === false ? false : { ...host, ...peer }
    } else continue
    if (!s || s.enabled === false || typeof s.url !== 'string' || !s.url.trim()) {
      issues.push({ runtime, detail: 'core iapeer MCP server is missing, disabled or has no URL' })
    }
  }
  return issues
}
