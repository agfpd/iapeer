// Shared acceptance driver. Product operations go through the supplied CLI, not source functions.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function findSurfaceTool(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if ('name' in value && typeof value.name === 'string' && value.name.includes('surface_ping')) return value.name
  for (const v of Object.values(value)) { const found = findSurfaceTool(v); if (found) return found }
  return undefined
}
/** Every offered tool-ish name that mentions a surface-proof server (claude flat names, codex namespaces). */
export function surfaceNames(value: unknown, out: Set<string> = new Set()): string[] {
  if (value && typeof value === 'object') {
    if ('name' in value && typeof value.name === 'string' && /surface/i.test(value.name)) out.add(value.name)
    for (const v of Object.values(value)) surfaceNames(v, out)
  }
  return [...out]
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
  probe: () => Promise<{ offered: boolean; calls: number; names?: string[] }>
  beginBusy: () => Promise<void>
  finishBusy: () => Promise<void>
  restartDaemon: () => Promise<void>
  hosting: () => { pid?: number; ready: string }
  session: () => string | undefined | null
  record: (check: string, detail: unknown) => void
  /** Registry runtimes of the stand peer (read from the isolated root, not the CLI). */
  peerRuntimes?: () => string[]
  /** Stand-owned files a re-added endpoint needs again (opencode: its provider config lives in the
   *  private dir, which remove-runtime deletes by design). */
  afterReAdd?: () => void
  /** Run the stand's native runtime CLI with the stand env (enable mode: local marketplace). */
  nativeRun?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
}
export async function proveReload(d: ReloadProofDriver, url: string, legacy = false, mode: 'capability' | 'provider' | 'remove' | 'enable' | 'hand-edit' = 'capability'): Promise<void> {
  const fixture = join(d.root, 'reload-surface.ts'), declaration = join(d.root, 'reload-surface.json')
  writeFileSync(fixture, `import {mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';import {join,dirname} from 'node:path';
const [kind,cwd,rt,personality]=process.argv.slice(2);if(!personality)throw new Error('personality required');
if(rt==='opencode'){const path=join(process.env.IAPEER_PRIVATE_DIR!,(process.argv[6]||'surface-proof')+'.json');if(kind==='off')rmSync(path,{force:true});else writeFileSync(path,JSON.stringify({mcp:{surfaceproof:{type:'remote',url:${JSON.stringify(url)},enabled:true,oauth:false}}}));}
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
  if (mode === 'provider') return proveProviderWrites(d, fixture, verify, until)
  if (mode === 'remove') return proveRemoveRuntime(d, until)
  if (mode === 'enable') return proveEnable(d, url, until)
  if (mode === 'hand-edit') return proveHandEdit(d, until)
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

type Until = (what: string, f: () => unknown, ms?: number) => Promise<void>

/** A writer OUTSIDE the core — exactly how the memory provider's provision-peer / update sweep lands
 *  surfaces (claude .mcp.json, codex .codex/config.toml, opencode <privateDir>/iapeer-memory.json).
 *  No core verb runs: the live endpoint must still converge at its next turn boundary. */
async function proveProviderWrites(d: ReloadProofDriver, fixture: string, verify: (on: boolean) => Promise<unknown>, until: Until): Promise<void> {
  const personality = d.cwd.split('/').pop()!
  let privateDir = ''
  if (d.runtime === 'opencode') {
    const r = await d.cli('private-dir', personality, '--runtime', 'opencode')
    if (r.code) throw new Error(`private-dir: ${JSON.stringify(r)}`)
    privateDir = r.stdout.trim()
  }
  const write = async (on: boolean) => {
    const p = Bun.spawn([process.execPath, fixture, on ? 'on' : 'off', d.cwd, d.runtime, personality, 'iapeer-memory'], {
      env: { ...process.env, ...(privateDir ? { IAPEER_PRIVATE_DIR: privateDir } : {}) }, stdout: 'pipe', stderr: 'pipe' })
    if (await p.exited) throw new Error(`provider writer failed: ${await new Response(p.stderr).text()}`)
  }
  for (const busy of [false, true]) for (const on of [true, false]) {
    const before = d.hosting()
    if (busy) await d.beginBusy()
    await write(on)
    if (busy) {
      await Bun.sleep(6000) // two watch periods: the change is seen, the busy turn must hold it pending
      if (d.hosting().pid !== before.pid) throw new Error('busy hosting replaced mid-turn after a provider write')
      await d.finishBusy()
    }
    await until(`automatic replacement after provider write (${busy ? 'busy' : 'idle'})`, () => d.hosting().pid && d.hosting().pid !== before.pid && !!d.hosting().ready, 60000)
    const result = await verify(on)
    d.record(`provider-write-${on ? 'on' : 'off'}-${busy ? 'busy' : 'idle'}`, { before, after: d.hosting(), sessionID: d.session(), result })
  }
}

/** remove-runtime on a LIVE endpoint: busy → pending, turn completes, endpoint then removed by the daemon;
 *  idle → removed in the call. The default runtime is moved to another declared runtime first (the
 *  verb refuses the default by design); that runtime is only provisioned, never launched. */
async function proveRemoveRuntime(d: ReloadProofDriver, until: Until): Promise<void> {
  const personality = d.cwd.split('/').pop()!
  const other = d.runtime === 'claude' ? 'codex' : 'claude'
  const must = async (...a: string[]) => { const r = await d.cli(...a); if (r.code) throw new Error(JSON.stringify(r)); return r }
  await must('add-runtime', other, '--peer', personality)
  await must('default-runtime', other, '--peer', personality)
  const declared = () => d.peerRuntimes!().includes(d.runtime)
  for (const busy of [true, false]) {
    if (!declared()) { await must('add-runtime', d.runtime, '--peer', personality); d.afterReAdd?.() }
    if (!d.hosting().pid) await d.turn('REMOVE_RUNTIME_WAKE')
    const before = d.hosting()
    if (!before.pid) throw new Error('endpoint not live before remove-runtime')
    if (busy) await d.beginBusy()
    const r = await must('remove-runtime', d.runtime, '--peer', personality)
    if (busy) {
      if (!r.stdout.includes(`${d.runtime} pending`) || d.hosting().pid !== before.pid || !declared()) throw new Error(`busy remove-runtime not pending: ${JSON.stringify(r)}`)
      await Bun.sleep(4000)
      if (d.hosting().pid !== before.pid) throw new Error('busy hosting killed mid-turn by remove-runtime')
      await d.finishBusy() // the turn completes natively (asserted by the driver), not aborted
      await until('endpoint removed after the turn', () => !declared() && !d.hosting().pid, 60000)
    } else if (!r.stdout.includes(`${d.runtime} removed`) || d.hosting().pid || declared()) throw new Error(`idle remove-runtime not removed: ${JSON.stringify(r)}`)
    d.record(`remove-runtime-${busy ? 'busy' : 'idle'}`, { before, after: d.hosting(), runtimes: d.peerRuntimes!(), stdout: r.stdout })
  }
}

/** `iapeer enable` (the core verb; codex installs host-wide, outside the fingerprint) on a live endpoint.
 *  A local git marketplace named `agfpd` in the isolated HOME stands in for the real one. Idle: plugin 1 →
 *  `runtime=applied`, its tool called. Busy: plugin 2 → `runtime=pending`, hosting untouched until the
 *  turn completes, then replaced and plugin 2's server offered. */
async function proveEnable(d: ReloadProofDriver, url: string, until: Until): Promise<void> {
  const mkt = join(d.root, 'mkt')
  const plugins = [['surface-proof', 'surfaceproof'], ['surface-proof-two', 'surfaceprooftwo']] as const
  const { mkdirSync } = await import('node:fs')
  for (const [name, server] of plugins) {
    const dir = join(mkt, 'plugins', name)
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true }); mkdirSync(join(dir, '.codex-plugin'), { recursive: true })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'reload proof' }))
    writeFileSync(join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'reload proof', mcpServers: './.mcp.json', interface: { displayName: name, shortDescription: 'reload proof' } }))
    // Distinct URL per plugin: Claude Code drops a second MCP server with an identical URL (dedup).
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { [server]: { type: 'http', url: `${url}/${server}` } } }))
  }
  mkdirSync(join(mkt, '.claude-plugin'), { recursive: true }); mkdirSync(join(mkt, '.agents', 'plugins'), { recursive: true })
  writeFileSync(join(mkt, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'agfpd', owner: { name: 'proof' }, plugins: plugins.map(([name]) => ({ name, source: `./plugins/${name}`, version: '1.0.0', description: 'reload proof' })) }))
  writeFileSync(join(mkt, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'agfpd', interface: { displayName: 'agfpd proof' }, plugins: plugins.map(([name]) => ({ name, source: { source: 'local', path: `./plugins/${name}` }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity', version: '1.0.0' })) }))
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=proof@local', '-c', 'user.name=proof', 'commit', '-qm', 'proof']]) {
    if (await Bun.spawn(['git', ...args], { cwd: mkt }).exited) throw new Error(`git ${args[0]} failed`)
  }
  const reg = await d.nativeRun!(['plugin', 'marketplace', 'add', mkt])
  if (reg.code) throw new Error(`marketplace add: ${JSON.stringify(reg)}`)
  const personality = d.cwd.split('/').pop()!
  for (const [i, busy] of [false, true].entries()) {
    const [plugin, server] = plugins[i]!
    const before = d.hosting()
    if (busy) await d.beginBusy()
    const r = await d.cli('enable', plugin, personality, '--no-setup')
    if (r.code) throw new Error(`enable: ${JSON.stringify(r)}`)
    if (busy) {
      if (!r.stdout.includes('runtime=pending') || d.hosting().pid !== before.pid) throw new Error(`busy enable not pending: ${JSON.stringify(r)}`)
      await Bun.sleep(4000)
      if (d.hosting().pid !== before.pid) throw new Error('busy hosting replaced mid-turn by enable')
      await d.finishBusy()
      await until('automatic replacement after the busy turn', () => d.hosting().pid && d.hosting().pid !== before.pid && !!d.hosting().ready, 60000)
    } else if (!r.stdout.includes('runtime=applied') || d.hosting().pid === before.pid) throw new Error(`idle enable not applied: ${JSON.stringify(r)}`)
    const result = await d.probe()
    if (!result.offered || result.calls !== 1 || !(result.names ?? []).some(n => n.includes(server))) { const { readFileSync } = await import('node:fs'); let settings = ''; try { settings = readFileSync(join(d.cwd, '.claude', 'settings.json'), 'utf8') } catch { /* codex */ } throw new Error(`enabled plugin tool not live: ${JSON.stringify({ ...result, settings })}`) }
    d.record(`enable-${busy ? 'busy' : 'idle'}`, { plugin, before, after: d.hosting(), sessionID: d.session(), result, stdout: r.stdout })
  }
}

/** An operator's hand edit of a live endpoint's surface: a SERIES of three writes during a busy turn owes
 *  exactly ONE reload, applied after the turn — and nothing more in the quiet period that follows. Counted
 *  from the stand daemon's own lifecycle.log, not inferred. */
async function proveHandEdit(d: ReloadProofDriver, until: Until): Promise<void> {
  const { appendFileSync, mkdirSync, readFileSync } = await import('node:fs')
  const log = join(d.root, 'iapeer', 'logs', 'iapeer', 'lifecycle.log')
  const identity = `${d.runtime}-${d.cwd.split('/').pop()}`
  const file = d.runtime === 'codex' ? join(d.cwd, '.codex', 'config.toml') : join(d.cwd, '.mcp.json')
  const events = (since: number) => {
    let text = ''; try { text = readFileSync(log, 'utf8') } catch { /* none yet */ }
    const rows = text.split('\n').filter(l => l.includes(`identity=${identity}`) && Date.parse(l.slice(3, 27)) >= since)
    return { changed: rows.filter(l => l.includes('ev=capability-surfaces-changed')).length, replacing: rows.filter(l => l.includes('ev=capability-reload') && l.includes('state=replacing')).length }
  }
  mkdirSync(join(file, '..'), { recursive: true })
  const before = d.hosting(), start = Date.now()
  await d.beginBusy()
  for (let i = 0; i < 3; i++) {
    if (file.endsWith('.toml')) appendFileSync(file, `\n# hand edit ${i}\n`)
    else { let c: any = {}; try { c = JSON.parse(readFileSync(file, 'utf8')) } catch { /* new */ } c.mcpServers ??= {}; c.handEdit = i; writeFileSync(file, JSON.stringify(c, null, 2)) }
    await Bun.sleep(1000)
  }
  await Bun.sleep(5000)
  if (d.hosting().pid !== before.pid) throw new Error('busy hosting replaced mid-turn by a hand edit')
  const duringBusy = events(start)
  await d.finishBusy()
  await until('one replacement after the turn', () => d.hosting().pid && d.hosting().pid !== before.pid && !!d.hosting().ready, 60000)
  const after = d.hosting()
  await Bun.sleep(15000) // quiet period: five watch periods with no further write
  const total = events(start)
  if (total.changed !== 1 || total.replacing !== 1 || d.hosting().pid !== after.pid) throw new Error(`hand edit did not give exactly one reload: ${JSON.stringify({ duringBusy, total, after, now: d.hosting() })}`)
  d.record('hand-edit-series-one-reload', { file, edits: 3, before, after, duringBusy, total, sessionID: d.session() })
}
