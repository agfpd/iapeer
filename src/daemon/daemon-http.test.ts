// HTTP integration test: the daemon driven by a REAL MCP client
// (@modelcontextprotocol/sdk Client + StreamableHTTPClientTransport) over a TCP
// loopback listener. Because both ends use the canonical SDK transport, this is
// the on-wire equivalent of a real claude/codex http MCP client connecting — it
// is what makes the hand-rolled-handshake H2 risk moot.
//
// No delivery to a live peer here (boris/nova are only used as CALLERS; the
// only send_to_peer target is the offline fixture peer), so the test has no side
// effects on the live fleet.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CALLER_HEADER, startDaemon, type DaemonHandle } from './index.ts'

let root: string
let daemon: DaemonHandle
const prevRoot = process.env.IAPEER_ROOT

const FIXTURE = {
  version: 2,
  peers: [
    { personality: 'boris', runtime: 'claude', runtimes: ['claude'], description: 'Напарник', intelligence: 'artificial', cwd: '/tmp/boris' },
    { personality: 'nova', runtime: 'telegram', runtimes: ['telegram', 'claude'], description: 'Нова', intelligence: 'human', cwd: '/tmp/nova' },
    { personality: 'offlinepeer', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial', cwd: '/tmp/offlinepeer' },
  ],
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-http-'))
  writeFileSync(join(root, 'peers-profiles.json'), JSON.stringify(FIXTURE))
  process.env.IAPEER_ROOT = root
  daemon = await startDaemon({ port: 0, host: '127.0.0.1' }) // TCP loopback for real http MCP clients
})
afterAll(async () => {
  await daemon.close()
  if (prevRoot === undefined) delete process.env.IAPEER_ROOT
  else process.env.IAPEER_ROOT = prevRoot
  rmSync(root, { recursive: true, force: true })
})

async function connect(identity?: string): Promise<Client> {
  const headers: Record<string, string> = {}
  if (identity) headers['X-IAPeer-Identity'] = identity
  const transport = new StreamableHTTPClientTransport(new URL(daemon.url!), { requestInit: { headers } })
  const client = new Client({ name: 'iapeer-test-client', version: '0.0.0' })
  await client.connect(transport)
  return client
}

describe('daemon over SDK StreamableHTTP (real MCP client)', () => {
  test('a real SDK client completes the initialize handshake and lists the tool-set', async () => {
    const client = await connect('claude-boris')
    const { tools } = await client.listTools()
    // ONLY send_to_peer — list_online_peers is deprecated by contract (no extra
    // agent-facing tool; liveness is the CLI `list` verb).
    expect(tools.map(t => t.name).sort()).toEqual(['send_to_peer'])
    await client.close()
  })

  test('PER-REQUEST identity: the header decides the caller, not a per-process default', async () => {
    // Caller resolution runs BEFORE tool dispatch, so send_to_peer exercises it.
    // A KNOWN caller (boris) is accepted → routing proceeds and fails with the
    // OFFLINE error (not an identity rejection): the target offlinepeer is dead.
    const ok = await connect('claude-boris')
    const okRes = await ok.callTool({ name: 'send_to_peer', arguments: { personality: 'offlinepeer', message: 'hi' } })
    expect(okRes.isError).toBe(true)
    expect((okRes.content as any)[0].text).not.toMatch(/unknown caller/)
    expect((okRes.content as any)[0].text).toMatch(/offline/)
    await ok.close()

    // a different client with an UNKNOWN caller header → rejected at identity
    const ghost = await connect('claude-ghost')
    const ghostRes = await ghost.callTool({ name: 'send_to_peer', arguments: { personality: 'offlinepeer', message: 'hi' } })
    expect(ghostRes.isError).toBe(true)
    expect((ghostRes.content as any)[0].text).toMatch(/unknown caller/)
    await ghost.close()
  })

  test('CallTool WITHOUT identity header → rejected (no silent default)', async () => {
    const client = await connect(undefined)
    const res = await client.callTool({ name: 'send_to_peer', arguments: { personality: 'offlinepeer', message: 'hi' } })
    expect(res.isError).toBe(true)
    expect((res.content as any)[0].text).toMatch(new RegExp(CALLER_HEADER))
    await client.close()
  })

  test('send_to_peer to an offline fixture peer → explicit offline error (no wake in Ф1)', async () => {
    const client = await connect('claude-boris')
    const res = await client.callTool({
      name: 'send_to_peer',
      arguments: { personality: 'offlinepeer', message: 'hi' },
    })
    expect(res.isError).toBe(true)
    expect((res.content as any)[0].text).toMatch(/offline/)
    await client.close()
  })
})

describe('daemon over unix socket (H8 base)', () => {
  test('binds a 0600 unix socket', async () => {
    const sockRoot = mkdtempSync(join(tmpdir(), 'iapeer-sock-'))
    const h = await startDaemon({ socketPath: join(sockRoot, 'router.sock') })
    try {
      expect((statSync(h.socketPath!).mode & 0o777).toString(8)).toBe('600')
    } finally {
      await h.close()
      rmSync(sockRoot, { recursive: true, force: true })
    }
  })

  test('В28: a second daemon REFUSES to start on a live socket (does not unlink it out from under the first)', async () => {
    const sockRoot = mkdtempSync(join(tmpdir(), 'iapeer-sock2-'))
    const sockPath = join(sockRoot, 'router.sock')
    const first = await startDaemon({ socketPath: sockPath })
    try {
      // a second instance on the SAME live socket must refuse, NOT unlink+rebind (which would break the
      // first daemon's unix callers).
      await expect(startDaemon({ socketPath: sockPath })).rejects.toThrow(/already listening/i)
      // the first daemon's socket is intact and still serving
      expect(statSync(sockPath).isSocket()).toBe(true)
    } finally {
      await first.close()
      rmSync(sockRoot, { recursive: true, force: true })
    }
  })

  test('В28: a STALE socket file (no live listener) is removed and the daemon starts', async () => {
    const sockRoot = mkdtempSync(join(tmpdir(), 'iapeer-sock3-'))
    const sockPath = join(sockRoot, 'router.sock')
    writeFileSync(sockPath, '') // a leftover file from a crashed predecessor — not a live listener
    const h = await startDaemon({ socketPath: sockPath })
    try {
      expect(statSync(sockPath).isSocket()).toBe(true) // the stale file was replaced by a real socket
    } finally {
      await h.close()
      rmSync(sockRoot, { recursive: true, force: true })
    }
  })
})
