// Deterministic stdio process tree: peer -> launcher -> MCP server.
// No accounts, external services, or installed runtime binaries are used.
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [mode, dir, cli] = process.argv.slice(2)
const self = import.meta.path
const record = (event: string, extra = {}) => appendFileSync(`${dir}/events.jsonl`, JSON.stringify({ event, pid: process.pid, ppid: process.ppid, ...extra }) + '\n')
record(mode)

if (mode === 'server') {
  // Keep-alive handles after EOF model a server that cannot shut down by EOF alone.
  // The supervisor's hard session teardown must reclaim it, not rely on compliance.
  setInterval(() => {}, 1000)
  process.on('SIGHUP', () => record('server-hup-ignored'))
  process.on('SIGTERM', () => record('server-term-ignored'))
  const input = createInterface({ input: process.stdin })
  input.on('close', () => record('server-eof'))
  input.on('line', line => {
    const req = JSON.parse(line)
    record(req.method)
    if (req.id === undefined) return
    const result = req.method === 'initialize'
      ? { protocolVersion: req.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'owned-stdio', version: '1' } }
      : req.method === 'tools/list'
        ? { tools: [{ name: 'ping', description: 'Return the serving process ID', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: `pong:${process.pid}` }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n')
  })
} else if (mode === 'wrapper') {
  const server = spawn(process.execPath, [self, 'server', dir], { stdio: 'inherit' })
  process.on('SIGTERM', () => record('wrapper-term-ignored'))
  process.on('SIGHUP', () => record('wrapper-hup-ignored'))
  server.on('exit', () => process.exit(0))
} else if (mode === 'peer') {
  const sentinel = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
  sentinel.unref()
  record('detached-sentinel', { pid: sentinel.pid })
  const wrapper = spawn(process.execPath, [self, 'wrapper', dir], { stdio: ['pipe', 'pipe', 'inherit'] })
  const input = createInterface({ input: wrapper.stdout })
  const send = (id: number, method: string, params: unknown = {}) => wrapper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  input.on('line', line => {
    const response = JSON.parse(line)
    if (response.id === 1) send(2, 'tools/list')
    if (response.id === 2) send(3, 'tools/call', { name: 'ping', arguments: {} })
    if (response.id === 3) {
      writeFileSync(`${dir}/ready.json`, JSON.stringify({ peer: process.pid, wrapper: wrapper.pid, result: response.result }))
      console.log('› ready')
    }
  })
  send(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-peer', version: '1' } })
  // This is an actual child self-call to the source CLI, not killSession in disguise.
  createInterface({ input: process.stdin }).on('line', line => {
    if (line.replace(/\x1b\[20[01]~/g, '').trim() === 'fresh') spawn(process.execPath, [cli, 'self-fresh'], { stdio: 'inherit', env: process.env })
  })
}
