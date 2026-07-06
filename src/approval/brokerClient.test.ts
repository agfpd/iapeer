import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pluginStateDir } from '../storage/index.ts'
import { APPROVAL_FETCH_TIMEOUT_MS, requestApproval, resolveFleetBase } from './brokerClient.ts'

// Hermetic: an isolated IAPEER_ROOT so resolveFleetBase never reads the live host's router.json.
const roots: string[] = []
function isolatedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'iapeer-brokerclient-'))
  roots.push(root)
  return { IAPEER_ROOT: root, IAPEER_TEST_SANDBOX: '1', ...extra } as unknown as NodeJS.ProcessEnv
}
afterAll(() => {
  for (const r of roots) try { rmSync(r, { recursive: true, force: true }) } catch { /* */ }
})

const body = { personality: 'boris', runtime: 'claude', kind: 'circuit-breaker', tool: 'dangerous-rm', content: 'cmd="rm -rf /x"', summary: 'dangerous-rm' }

describe('resolveFleetBase', () => {
  test('no router.json → well-known loopback default', () => {
    expect(resolveFleetBase(isolatedEnv())).toBe('http://127.0.0.1:8765')
  })
  test('IAPEER_PORT overrides the default port', () => {
    expect(resolveFleetBase(isolatedEnv({ IAPEER_PORT: '8799' }))).toBe('http://127.0.0.1:8799')
  })
  test('router.json tcp wins, /mcp suffix stripped to origin-form', () => {
    const env = isolatedEnv()
    const dir = pluginStateDir('iapeer', { env })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'router.json'), JSON.stringify({ tcp: 'http://127.0.0.1:9001/mcp' }))
    expect(resolveFleetBase(env)).toBe('http://127.0.0.1:9001')
  })
})

describe('requestApproval', () => {
  const env = { IAPEER_TEST_SANDBOX: '1' } as unknown as NodeJS.ProcessEnv

  test('allow → { decision: allow } with no reason; body + endpoint sent verbatim', async () => {
    let sentUrl = ''
    let sentInit: { method: string; headers: Record<string, string>; body: string } | undefined
    const spy = (async (url: string, init: typeof sentInit) => {
      sentUrl = url
      sentInit = init
      return { ok: true, status: 200, json: async () => ({ id: 'a1', decision: 'allow' }) }
    }) as unknown as typeof fetch
    const d = await requestApproval('http://127.0.0.1:8765', body, { env, fetch: spy })
    expect(d).toEqual({ decision: 'allow' })
    expect(sentUrl).toBe('http://127.0.0.1:8765/fleet/v1/approvals')
    expect(sentInit?.method).toBe('POST')
    expect(JSON.parse(sentInit!.body)).toEqual(body)
    expect(sentInit?.headers['content-type']).toBe('application/json')
    expect(sentInit?.headers.authorization).toBeUndefined() // no bearer in env → no auth header
  })

  test('deny → carries the reason; a reason-less deny defaults to "denied"', async () => {
    const denyWithReason = (async () => ({ ok: true, status: 200, json: async () => ({ id: 'a2', decision: 'deny', reason: 'nope' }) })) as unknown as typeof fetch
    expect(await requestApproval('http://x', body, { env, fetch: denyWithReason })).toEqual({ decision: 'deny', reason: 'nope' })
    const bareDeny = (async () => ({ ok: true, status: 200, json: async () => ({ id: 'a3', decision: 'deny' }) })) as unknown as typeof fetch
    expect(await requestApproval('http://x', body, { env, fetch: bareDeny })).toEqual({ decision: 'deny', reason: 'denied' })
  })

  test('non-200 → THROWS (caller owns the fail-safe)', async () => {
    const err500 = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
    await expect(requestApproval('http://x', body, { env, fetch: err500 })).rejects.toThrow('daemon returned 500')
  })

  test('bearer header included when IAPEER_BEARER_TOKEN is set', async () => {
    let auth: string | undefined
    const spy = (async (_url: string, init: { headers: Record<string, string> }) => {
      auth = init.headers.authorization
      return { ok: true, status: 200, json: async () => ({ decision: 'allow' }) }
    }) as unknown as typeof fetch
    await requestApproval('http://x', body, { env: { IAPEER_BEARER_TOKEN: 'sekret', IAPEER_TEST_SANDBOX: '1' } as unknown as NodeJS.ProcessEnv, fetch: spy })
    expect(auth).toBe('Bearer sekret')
  })

  test('the client timeout ceiling sits above the broker default-deny (300s)', () => {
    expect(APPROVAL_FETCH_TIMEOUT_MS).toBeGreaterThan(300_000)
  })
})
