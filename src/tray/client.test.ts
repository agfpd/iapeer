// client — the fleet-API client's pure parts: router.json discovery (address + tcp
// origin derivation + fleet marker) and SSE frame parsing. The transport itself
// (unix-first fetch) is exercised live in the deploy proof, not here.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fleetGetJson, fleetPostJson, parseSseFrame, resolveFleetAddress, type FleetAddress } from './client.ts'

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
