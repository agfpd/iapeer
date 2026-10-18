// The MCP servers a peer's runtime ACTUALLY sees at launch — the peer's own declarations PLUS the
// servers its enabled plugins bring (boris 18.10: verify read only <cwd>/.codex/config.toml, so
// voice-connect, whose server reaches codex through the enabled host plugin voice-connect@agfpd,
// was a false ✗ — and a false ✗ is worse than no check: owners start duplicating servers).
//
// Normalized to one shape so the two consumers agree by construction:
//   • verify's MCP parity compares the NAMES per runtime;
//   • add-runtime / launch / `verify --fix` project the SPECS into OpenCode (docs/20 §Peer MCP).
//
// Sources (read-only; nothing here writes):
//   claude — <cwd>/.mcp.json `mcpServers`; plugins enabled in ~/.claude/settings.json,
//            <cwd>/.claude/settings.json, <cwd>/.claude/settings.local.json (`enabledPlugins`,
//            later wins), installed per ~/.claude/plugins/installed_plugins.json (fallback: newest
//            ~/.claude/plugins/cache/<market>/<name>/<version>); servers from the plugin's
//            .claude-plugin/plugin.json `mcpServers` (object or relative path) else <root>/.mcp.json.
//            `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin root.
//   codex  — <cwd>/.codex/config.toml `[mcp_servers.*]`; plugins `[plugins."<name>@<market>"]
//            enabled` in $CODEX_HOME/config.toml, overridden by the peer's own config; installed at
//            $CODEX_HOME/plugins/cache/<market>/<name>/<newest version>/; servers from
//            .codex-plugin/plugin.json `mcpServers` else <root>/.mcp.json.
// `codex mcp list` would be the authoritative read, but it was measured to hang > 2 min on this
// host — unusable inside verify. The same files it reads are read here instead.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** `peer` — declared by the peer itself (its own files, or a plugin enabled in the peer's own
 *  settings); `host` — reaches every peer of that runtime through a HOST-wide plugin enable. A host
 *  server is real for the runtime (it satisfies a peer declaration) but is not a fact about the
 *  peer: its absence on another runtime is a host decision, not peer drift, and it is not projected. */
export type McpScope = 'peer' | 'host'

export type McpSpec = { scope: McpScope } & (
  | { kind: 'local'; command: string; args: string[]; env: Record<string, string>; source: string }
  | { kind: 'remote'; url: string; headers: Record<string, string>; source: string }
)

type Obj = Record<string, unknown>

function readJson(path: string): Obj | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null
  } catch {
    return null
  }
}

function readToml(path: string): Obj | null {
  try {
    return Bun.TOML.parse(readFileSync(path, 'utf8')) as Obj
  } catch {
    return null
  }
}

function strMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'string' || typeof x === 'number') out[k] = String(x)
  return out
}

/** A claude-style `${VAR}` / `${VAR:-default}` reference → OpenCode's `{env:VAR}`. The default is
 *  dropped (OpenCode has no default syntax) — the caller records it as a lossy conversion. */
export function claudeVarsToOpencode(s: string, pluginRoot?: string): string {
  let out = pluginRoot ? s.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot) : s
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g, (_m, v: string) => `{env:${v}}`)
  return out
}

/** One claude `.mcp.json` server entry → spec. */
export function specFromClaude(entry: unknown, source: string, pluginRoot?: string, scope: McpScope = 'peer'): McpSpec | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Obj
  const sub = (s: string): string => claudeVarsToOpencode(s, pluginRoot)
  if (typeof e.url === 'string' || e.type === 'http' || e.type === 'sse') {
    if (typeof e.url !== 'string') return null
    const headers = strMap(e.headers)
    for (const k of Object.keys(headers)) headers[k] = sub(headers[k]!)
    return { scope, kind: 'remote', url: sub(e.url), headers, source }
  }
  if (typeof e.command !== 'string' || !e.command) return null
  const env = strMap(e.env)
  for (const k of Object.keys(env)) env[k] = sub(env[k]!)
  return { scope, kind: 'local', command: sub(e.command), args: Array.isArray(e.args) ? e.args.map(a => sub(String(a))) : [], env, source }
}

/** One codex `[mcp_servers.<name>]` table → spec. */
export function specFromCodex(entry: unknown, source: string, scope: McpScope = 'peer'): McpSpec | null {
  if (!entry || typeof entry !== 'object') return null
  const e = entry as Obj
  if (typeof e.url === 'string') {
    const headers = strMap(e.http_headers)
    for (const [h, v] of Object.entries(strMap(e.env_http_headers))) headers[h] = `{env:${v}}`
    if (typeof e.bearer_token_env_var === 'string' && e.bearer_token_env_var) headers.Authorization = `Bearer {env:${e.bearer_token_env_var}}`
    return { scope, kind: 'remote', url: e.url, headers, source }
  }
  if (typeof e.command !== 'string' || !e.command) return null
  return { scope, kind: 'local', command: e.command, args: Array.isArray(e.args) ? e.args.map(String) : [], env: strMap(e.env), source }
}

function newestDir(dir: string): string | null {
  try {
    const subs = readdirSync(dir)
      .map(n => join(dir, n))
      .filter(p => {
        try {
          return statSync(p).isDirectory()
        } catch {
          return false
        }
      })
    if (!subs.length) return null
    return subs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!
  } catch {
    return null
  }
}

/** A plugin's declared servers: manifest `mcpServers` (object, or a path relative to the root),
 *  else <root>/.mcp.json. */
function pluginServers(root: string, manifestRel: string): Obj {
  const manifest = readJson(join(root, manifestRel))
  const m = manifest?.mcpServers
  if (m && typeof m === 'object' && !Array.isArray(m)) return m as Obj
  const file = typeof m === 'string' ? (isAbsolute(m) ? m : resolve(root, m)) : join(root, '.mcp.json')
  const o = readJson(file)
  const servers = o?.mcpServers ?? o
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? (servers as Obj) : {}
}

function splitKey(key: string): { name: string; market: string } | null {
  const i = key.lastIndexOf('@')
  return i > 0 ? { name: key.slice(0, i), market: key.slice(i + 1) } : null
}

export interface PeerServerOptions {
  env?: NodeJS.ProcessEnv
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir()
}

export function claudeServers(cwd: string, opts: PeerServerOptions = {}): Map<string, McpSpec> {
  const env = opts.env ?? process.env
  const home = homeOf(env)
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude')
  const out = new Map<string, McpSpec>()
  const direct = readJson(join(cwd, '.mcp.json'))?.mcpServers
  if (direct && typeof direct === 'object') {
    for (const [n, e] of Object.entries(direct as Obj)) {
      const s = specFromClaude(e, '.mcp.json')
      if (s) out.set(n, s)
    }
  }
  const enabled = new Map<string, { on: boolean; scope: McpScope }>()
  const layers: Array<[string, McpScope]> = [
    [join(claudeDir, 'settings.json'), 'host'],
    [join(cwd, '.claude', 'settings.json'), 'peer'],
    [join(cwd, '.claude', 'settings.local.json'), 'peer'],
  ]
  for (const [f, scope] of layers) {
    const ep = readJson(f)?.enabledPlugins
    if (ep && typeof ep === 'object') for (const [k, v] of Object.entries(ep as Obj)) enabled.set(k, { on: v === true, scope })
  }
  const installed = (readJson(join(claudeDir, 'plugins', 'installed_plugins.json'))?.plugins ?? {}) as Obj
  for (const [key, { on, scope }] of enabled) {
    if (!on) continue
    const kv = splitKey(key)
    if (!kv) continue
    const rec = installed[key]
    const first = Array.isArray(rec) ? (rec[0] as Obj | undefined) : (rec as Obj | undefined)
    const root =
      (typeof first?.installPath === 'string' && existsSync(first.installPath) ? first.installPath : null) ??
      newestDir(join(claudeDir, 'plugins', 'cache', kv.market, kv.name))
    if (!root) continue
    for (const [n, e] of Object.entries(pluginServers(root, join('.claude-plugin', 'plugin.json')))) {
      if (out.has(n)) continue // the peer's own declaration wins
      const s = specFromClaude(e, `plugin ${key}`, root, scope)
      if (s) out.set(n, s)
    }
  }
  return out
}

export function codexServers(cwd: string, opts: PeerServerOptions = {}): Map<string, McpSpec> {
  const env = opts.env ?? process.env
  const codexHome = env.CODEX_HOME?.trim() || join(homeOf(env), '.codex')
  const out = new Map<string, McpSpec>()
  const peer = readToml(join(cwd, '.codex', 'config.toml'))
  const direct = peer?.mcp_servers
  if (direct && typeof direct === 'object') {
    for (const [n, e] of Object.entries(direct as Obj)) {
      if ((e as Obj | undefined)?.enabled === false) continue
      const s = specFromCodex(e, '.codex/config.toml')
      if (s) out.set(n, s)
    }
  }
  const enabled = new Map<string, { on: boolean; scope: McpScope }>()
  const layers: Array<[Obj | null, McpScope]> = [[readToml(join(codexHome, 'config.toml')), 'host'], [peer, 'peer']]
  for (const [cfg, scope] of layers) {
    const pl = cfg?.plugins
    if (pl && typeof pl === 'object') for (const [k, v] of Object.entries(pl as Obj)) enabled.set(k, { on: (v as Obj | undefined)?.enabled === true, scope })
  }
  for (const [key, { on, scope }] of enabled) {
    if (!on) continue
    const kv = splitKey(key)
    if (!kv) continue
    const root = newestDir(join(codexHome, 'plugins', 'cache', kv.market, kv.name))
    if (!root) continue
    for (const [n, e] of Object.entries(pluginServers(root, join('.codex-plugin', 'plugin.json')))) {
      if (out.has(n)) continue
      // Plugin manifests use the claude-style JSON shape even on the codex side.
      const s = specFromClaude(e, `plugin ${key}`, root, scope)
      if (s) out.set(n, s)
    }
  }
  return out
}

/** OpenCode's own MCP entry for a spec (docs: `type local|remote`). */
export function toOpencodeMcp(s: McpSpec): Obj {
  // (scope is ours, not OpenCode's — never emitted)
  // oauth:false — a headless peer must never stall in an interactive OAuth flow (the core's own
  // iapeer entry does the same). timeout 30 s on local servers: a first `npx -y` start fetches the
  // package and blows OpenCode's 5 s tool-listing default.
  if (s.kind === 'remote') return { type: 'remote', url: s.url, enabled: true, oauth: false, ...(Object.keys(s.headers).length ? { headers: s.headers } : {}) }
  return {
    type: 'local',
    command: [s.command, ...s.args],
    enabled: true,
    timeout: 30_000,
    ...(Object.keys(s.env).length ? { environment: s.env } : {}),
  }
}
