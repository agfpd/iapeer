// proxy-routing — the RFC 7230 absolute-form request-target fix. A client behind an
// HTTP proxy (HTTP_PROXY set — Bun's fetch proxies loopback even with NO_PROXY) sends
// the daemon an absolute-form target ("GET http://host/fleet/..."); without
// normalization that misses the /fleet path check and falls to the MCP catch-all (a
// 406). Two layers: the pure normalizer (unit) and the live daemon routing a raw
// absolute-form request to the fleet branch (integration).

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { connect } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { normalizeRequestTarget, startDaemon, type DaemonHandle } from './index.ts'

describe('normalizeRequestTarget', () => {
  test('absolute-form → origin-form (path + query)', () => {
    expect(normalizeRequestTarget('http://127.0.0.1:8765/fleet/v1/snapshot')).toBe('/fleet/v1/snapshot')
    expect(normalizeRequestTarget('http://127.0.0.1:8765/fleet/v1/events?replay=5')).toBe('/fleet/v1/events?replay=5')
    expect(normalizeRequestTarget('https://host/mcp')).toBe('/mcp')
  })
  test('origin-form passes through unchanged', () => {
    expect(normalizeRequestTarget('/fleet/v1/snapshot')).toBe('/fleet/v1/snapshot')
    expect(normalizeRequestTarget('/mcp')).toBe('/mcp')
  })
  test('undefined / unparseable pass through', () => {
    expect(normalizeRequestTarget(undefined)).toBeUndefined()
    expect(normalizeRequestTarget('not a url but not absolute')).toBe('not a url but not absolute')
  })
})

// ── integration: a raw absolute-form request reaches the fleet branch ─────────────

/** Send a raw HTTP/1.1 request (verbatim target line) and resolve the status line +
 *  body — lets us forge the absolute-form request-target a proxy would emit, which
 *  fetch/http.request will not produce. */
function rawRequest(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
    })
    let buf = ''
    sock.setTimeout(4000, () => {
      sock.destroy()
      reject(new Error('raw request timed out'))
    })
    sock.on('data', c => (buf += c.toString('utf8')))
    sock.on('end', () => {
      const status = parseInt(buf.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? '0', 10)
      const body = buf.slice(buf.indexOf('\r\n\r\n') + 4)
      resolve({ status, body })
    })
    sock.on('error', reject)
  })
}

describe('daemon routes absolute-form (proxied) requests to /fleet', () => {
  let root: string
  let daemon: DaemonHandle
  let port: number
  const prevRoot = process.env.IAPEER_ROOT

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'iapeer-proxy-'))
    process.env.IAPEER_ROOT = root
    // A stub fleet handler — we only assert ROUTING reaches the fleet branch, not its
    // body. It answers 200 "fleet-ok" so a fleet hit is unmistakable vs an MCP 406.
    daemon = await startDaemon({
      port: 0,
      host: '127.0.0.1',
      fleet: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('fleet-ok')
      },
    })
    port = Number(new URL(daemon.url!).port)
  })
  afterAll(async () => {
    await daemon?.close()
    if (prevRoot === undefined) delete process.env.IAPEER_ROOT
    else process.env.IAPEER_ROOT = prevRoot
    rmSync(root, { recursive: true, force: true })
  })

  test('origin-form GET /fleet/v1/snapshot → fleet branch (regression)', async () => {
    const r = await rawRequest(port, '/fleet/v1/snapshot')
    expect(r.status).toBe(200)
    expect(r.body).toContain('fleet-ok')
  })

  test('absolute-form GET http://host/fleet/v1/snapshot → STILL fleet branch (the fix)', async () => {
    const r = await rawRequest(port, `http://127.0.0.1:${port}/fleet/v1/snapshot`)
    expect(r.status).toBe(200)
    expect(r.body).toContain('fleet-ok')
  })

  test('absolute-form with query is preserved', async () => {
    const r = await rawRequest(port, `http://127.0.0.1:${port}/fleet/v1/events?replay=0`)
    expect(r.status).toBe(200)
    expect(r.body).toContain('fleet-ok')
  })
})
