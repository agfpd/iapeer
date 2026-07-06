// client — the fleet-API client's pure parts: router.json discovery (address + tcp
// origin derivation + fleet marker) and SSE frame parsing. The transport itself
// (unix-first fetch) is exercised live in the deploy proof, not here.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fleetGetJson, fleetPostJson, parseSseFrame, resolveFleetAddress, type FleetAddress } from './client.ts'
import { trayResolveApproval } from './index.ts'

describe('parseSseFrame', () => {
  test('parses event/id/data', () => {
    const e = parseSseFrame('event: wake\nid: 1751731100123\ndata: {"src":"lifecycle","ev":"wake","personality":"boris"}')
    expect(e).toEqual({ event: 'wake', id: 1751731100123, data: { src: 'lifecycle', ev: 'wake', personality: 'boris' } })
  })
  test('comment-only frame (: connected / : hb) → null', () => {
    expect(parseSseFrame(': connected')).toBeNull()
    expect(parseSseFrame(': hb')).toBeNull()
  })
  test('frame without a data line → null', () => {
    expect(parseSseFrame('event: wake\nid: 123')).toBeNull()
  })
  test('malformed data JSON → null (never throws)', () => {
    expect(parseSseFrame('event: x\ndata: {not json')).toBeNull()
  })
  test('multi-line data is joined with newlines', () => {
    const e = parseSseFrame('event: x\ndata: {"a":\ndata: 1}')
    expect(e?.data).toEqual({ a: 1 })
  })
  test('CRLF line endings tolerated', () => {
    const e = parseSseFrame('event: wake\r\ndata: {"ev":"wake"}\r')
    expect(e?.event).toBe('wake')
    expect(e?.data).toEqual({ ev: 'wake' })
  })
})

describe('resolveFleetAddress', () => {
  let root: string
  let env: NodeJS.ProcessEnv
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'iapeer-client-'))
    env = { HOME: process.env.HOME, IAPEER_ROOT: root }
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const writeRouter = (obj: unknown): void => {
    const dir = join(root, 'state', 'iapeer')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'router.json'), JSON.stringify(obj))
  }

  test('parses sock + tcp origin (strips /mcp) + fleet marker + version', () => {
    writeRouter({ sock: '/tmp/router.sock', tcp: 'http://127.0.0.1:8765/mcp', version: '0.4.64', fleet: 1 })
    const a = resolveFleetAddress({ env })
    expect(a.sock).toBe('/tmp/router.sock')
    expect(a.tcp).toBe('http://127.0.0.1:8765') // origin only — the fleet path is appended by the client
    expect(a.fleet).toBe(1)
    expect(a.version).toBe('0.4.64')
  })

  test('a pre-fleet daemon (no fleet key) yields no fleet marker → caller degrades', () => {
    writeRouter({ sock: '/tmp/router.sock', tcp: 'http://127.0.0.1:8765/mcp', version: '0.3.0' })
    expect(resolveFleetAddress({ env }).fleet).toBeUndefined()
  })

  test('missing router.json → empty address (daemon down)', () => {
    expect(resolveFleetAddress({ env })).toEqual({})
  })

  test('malformed tcp url is dropped, sock still resolves', () => {
    writeRouter({ sock: '/tmp/router.sock', tcp: 'not a url', fleet: 1 })
    const a = resolveFleetAddress({ env })
    expect(a.sock).toBe('/tmp/router.sock')
    expect(a.tcp).toBeUndefined()
  })
})

describe('transport fallback (fleetGetJson / fleetPostJson)', () => {
  const ADDR: FleetAddress = { sock: '/tmp/r.sock', tcp: 'http://127.0.0.1:8765', fleet: 1 }
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** Mock fetch: unix attempt (init.unix present) → `unixStatus`; tcp → `tcpStatus`. */
  function mockFetch(unixStatus: number, tcpStatus: number): { calls: string[] } {
    const calls: string[] = []
    globalThis.fetch = (async (url: string, init: { unix?: string } = {}) => {
      const transport = init.unix ? 'unix' : 'tcp'
      calls.push(transport)
      const status = transport === 'unix' ? unixStatus : tcpStatus
      return new Response(status < 400 ? JSON.stringify({ ok: transport }) : JSON.stringify({ error: 'nope' }), { status })
    }) as unknown as typeof fetch
    return { calls }
  }

  test('GET: a bad unix status falls back to TCP (a proxied/misrouting transport cannot sink it)', async () => {
    const { calls } = mockFetch(406, 200)
    const r = await fleetGetJson<{ ok: string }>(ADDR, '/fleet/v1/snapshot', {})
    expect(r.ok).toBe('tcp') // fell back to TCP
    expect(calls).toEqual(['unix', 'tcp'])
  })

  test('GET: both transports bad → throws with the actual URL + transport', async () => {
    mockFetch(406, 406)
    await expect(fleetGetJson(ADDR, '/fleet/v1/snapshot', {})).rejects.toThrow(/406/)
  })

  test('POST: a bad status does NOT fall back (a command must never re-execute)', async () => {
    const { calls } = mockFetch(502, 200)
    const r = await fleetPostJson(ADDR, '/fleet/v1/peers/x/wake', {}, {})
    expect(r.status).toBe(502) // returned the first (unix) response, no retry
    expect(calls).toEqual(['unix'])
  })
})

describe('trayResolveApproval (Ф2 — resolve a pending approval over the unix-first client)', () => {
  let root: string
  let env: NodeJS.ProcessEnv
  const realFetch = globalThis.fetch
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'iapeer-trayapp-'))
    const dir = join(root, 'state', 'iapeer')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'router.json'), JSON.stringify({ sock: '/tmp/r.sock', tcp: 'http://127.0.0.1:8765/mcp', fleet: 1 }))
    env = { HOME: process.env.HOME, IAPEER_ROOT: root }
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(root, { recursive: true, force: true })
  })

  test('approve → POST /approvals/<id>/approve with via:tray; ok on 200', async () => {
    let captured: { url: string; body: unknown } = { url: '', body: undefined }
    globalThis.fetch = (async (url: string, init: { body?: string }) => {
      captured = { url, body: init.body ? JSON.parse(init.body) : undefined }
      return new Response(JSON.stringify({ id: 'a1', action: 'approve', ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    const r = await trayResolveApproval(env, 'approve', 'a1')
    expect(r.ok).toBe(true)
    expect(captured.url).toContain('/fleet/v1/approvals/a1/approve')
    expect(captured.body).toEqual({ via: 'tray' })
  })

  test('deny carries the reason; a 404 (already resolved elsewhere) → ok=false, no throw', async () => {
    let body: unknown
    globalThis.fetch = (async (_url: string, init: { body?: string }) => {
      body = init.body ? JSON.parse(init.body) : undefined
      return new Response(JSON.stringify({ error: 'no pending approval "a9"' }), { status: 404 })
    }) as unknown as typeof fetch
    const r = await trayResolveApproval(env, 'deny', 'a9', 'too risky')
    expect(body).toEqual({ via: 'tray', reason: 'too risky' })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })

  test('daemon unreachable (no router.json) → ok=false, never throws', async () => {
    rmSync(join(root, 'state', 'iapeer', 'router.json'))
    const r = await trayResolveApproval(env, 'approve', 'a1')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(0)
  })
})
