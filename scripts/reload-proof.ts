// Shared acceptance driver. Product operations go through the supplied CLI, not source functions.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function findSurfaceTool(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if ('name' in value && typeof value.name === 'string' && value.name.includes('surface_ping')) return value.name
  for (const v of Object.values(value)) { const found = findSurfaceTool(v); if (found) return found }
  return undefined
}
/** Codex ≥0.160 nests MCP tools in a Responses `namespace` tool (`mcp__<server>`); the call must name it. */
export function findSurfaceNamespace(tools: unknown): string | undefined {
  if (!Array.isArray(tools)) return undefined
  return tools.find((t: any) => t?.type === 'namespace' && findSurfaceTool(t.tools))?.name
}

export function surfaceProofServer() {
  let calls = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (req.method !== 'POST') return new Response(null, { status: 405 })
    const b: any = await req.json()
    if (b.id === undefined) return new Response(null, { status: 202 })
    let result: unknown
    if (b.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'surface-proof', version: '1' } }
    else if (b.method === 'tools/list') result = { tools: [{ name: 'surface_ping', description: 'Isolated reload proof', inputSchema: { type: 'object', properties: {} } }] }
    else if (b.method === 'tools/call' && b.params?.name === 'surface_ping') { calls++; result = { content: [{ type: 'text', text: 'SURFACE_PONG' }] } }
    else return Response.json({ jsonrpc: '2.0', id: b.id, error: { code: -32601, message: 'not found' } })
    return Response.json({ jsonrpc: '2.0', id: b.id, result })
  } })
  return { url: server.url.origin, calls: () => calls, stop: () => server.stop(true) }
}
export interface ReloadProofDriver {
  root: string; cwd: string; runtime: string
  cli: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  turn: (text: string) => Promise<void>
  probe: () => Promise<{ offered: boolean; calls: number }>
  beginBusy: () => Promise<void>
  finishBusy: () => Promise<void>
  restartDaemon: () => Promise<void>
  hosting: () => { pid?: number; ready: string }
  session: () => string | undefined | null
  record: (check: string, detail: unknown) => void
}
export async function proveReload(d: ReloadProofDriver, url: string, legacy = false): Promise<void> {
  const fixture = join(d.root, 'reload-surface.ts'), declaration = join(d.root, 'reload-surface.json')
  writeFileSync(fixture, `import {mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';import {join,dirname} from 'node:path';
const [kind,cwd,rt,personality]=process.argv.slice(2);if(!personality)throw new Error('personality required');
if(rt==='opencode'){const path=join(process.env.IAPEER_PRIVATE_DIR!,'surface-proof.json');if(kind==='off')rmSync(path,{force:true});else writeFileSync(path,JSON.stringify({mcp:{surfaceproof:{type:'remote',url:${JSON.stringify(url)},enabled:true,oauth:false}}}));}
else if(rt==='claude'){const path=join(cwd,'.mcp.json');let c:any={};try{c=JSON.parse(readFileSync(path,'utf8'))}catch{};c.mcpServers??={};if(kind==='off')delete c.mcpServers.surfaceproof;else c.mcpServers.surfaceproof={type:'http',url:${JSON.stringify(url)}};writeFileSync(path,JSON.stringify(c));}
else{const path=join(cwd,'.codex/config.toml');let c='';try{c=readFileSync(path,'utf8')}catch{};c=c.replace(/\\n\\[mcp_servers\\.surfaceproof\\][\\s\\S]*?(?=\\n\\[|$)/g,'');if(kind!=='off')c+='\\n[mcp_servers.surfaceproof]\\nurl = '+${JSON.stringify(JSON.stringify(url))}+'\\n';mkdirSync(dirname(path),{recursive:true});writeFileSync(path,c);}`)
  writeFileSync(declaration, JSON.stringify({ schema: 1, capability: 'surface-proof', runtimes: [d.runtime],
    provision: { command: process.execPath, args: [fixture, 'on', '{cwd}', '{runtime}', '{personality}'] },
    unprovision: { command: process.execPath, args: [fixture, 'off', '{cwd}', '{runtime}', '{personality}'] },
  }))
  const until = async (what: string, f: () => unknown, ms = 60000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (f()) return; await Bun.sleep(100) }
    throw new Error(`timeout: ${what}`)
  }
  const original = d.session()
  const operation = (on: boolean) => d.cli('capability', on ? 'register' : 'unregister', on ? declaration : 'surface-proof')
  const verify = async (on: boolean) => {
    const r = await d.probe()
    if (r.offered !== on || r.calls !== (on ? 1 : 0)) throw new Error(`MCP application failed: ${JSON.stringify({ on, ...r })}`)
    if (d.session() !== original) throw new Error('reload changed native conversation identity')
    return r
  }
  if (legacy) {
    await d.restartDaemon() // Upgrade the router only. The old hosting remains untouched.
    const before = d.hosting(), r = await operation(true)
    if (r.code || !r.stdout.includes('runtime=pending') || d.hosting().pid !== before.pid) throw new Error(`legacy pending failed: ${JSON.stringify(r)}`)
    await until('natural idle-reap of legacy hosting', () => !d.hosting().pid, 75000)
    await d.turn('AFTER_NATURAL_LEGACY_RESTART')
    d.record('legacy-pending-natural-restart-native-tool', { before, after: d.hosting(), result: await verify(true) })
    return
  }
  for (const busy of [false, true]) for (const on of [true, false]) {
    const before = d.hosting()
    if (busy) await d.beginBusy()
    const r = await operation(on)
    if (r.code) throw new Error(JSON.stringify(r))
    if (busy) {
      if (!r.stdout.includes('runtime=pending') || d.hosting().pid !== before.pid) throw new Error('busy turn was interrupted / falsely applied')
      if (on) await d.restartDaemon() // Durable pending, without killing the hosted native turn.
      await Bun.sleep(500)
      if (d.hosting().pid !== before.pid) throw new Error('busy hosting changed before turn finished')
      await d.finishBusy()
      await until('automatic ready replacement after busy turn', () => d.hosting().pid && d.hosting().pid !== before.pid && !!d.hosting().ready)
    } else if (!r.stdout.includes('runtime=applied') || d.hosting().pid === before.pid) throw new Error(`idle not applied synchronously: ${JSON.stringify(r)}`)
    const result = await verify(on)
    d.record(`reload-${on ? 'register' : 'unregister'}-${busy ? 'busy' : 'idle'}`, { before, after: d.hosting(), sessionID: d.session(), result, stdout: r.stdout })
  }
}
