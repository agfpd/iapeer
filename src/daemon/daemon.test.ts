import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CALLER_HEADER,
  SERVER_INSTRUCTIONS,
  callTool,
  createMcpServer,
  listTools,
  parseCallerHeader,
  resolveCallerFromHeader,
} from './index.ts'
import { readPeersIndex } from '../registry/index.ts'
import { decodeEnvelope } from '../codec/index.ts'

// Point the registry at a fixture root via IAPEER_ROOT so these unit tests are
// deterministic and never touch the live host registry.
let root: string
const prevRoot = process.env.IAPEER_ROOT

const FIXTURE = {
  version: 2,
  peers: [
    { personality: 'nova', runtime: 'telegram', runtimes: ['telegram', 'claude'], description: 'Нова', intelligence: 'human', cwd: '/tmp/iapeer-peers/nova', interfaces: { telegram: { user_id: '100000001' } } },
    { personality: 'boris', runtime: 'claude', runtimes: ['claude'], description: 'Напарник', intelligence: 'artificial', cwd: '/tmp/iapeer-peers/boris' },
    { personality: 'offlinepeer', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial', cwd: '/tmp/offlinepeer' },
  ],
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-daemon-'))
  writeFileSync(join(root, 'peers-profiles.json'), JSON.stringify(FIXTURE))
  process.env.IAPEER_ROOT = root
})
afterAll(() => {
  if (prevRoot === undefined) delete process.env.IAPEER_ROOT
  else process.env.IAPEER_ROOT = prevRoot
  rmSync(root, { recursive: true, force: true })
})

describe('caller identity from header', () => {
  test('parses <runtime>-<personality>', () => {
    expect(parseCallerHeader('claude-boris')).toEqual({ personality: 'boris', runtime: 'claude' })
    expect(parseCallerHeader('telegram-nova')).toEqual({ personality: 'nova', runtime: 'telegram' })
    expect(parseCallerHeader('claude-company-checker')).toEqual({ personality: 'company-checker', runtime: 'claude' })
  })

  test('rejects empty / malformed header', () => {
    expect(parseCallerHeader(undefined)).toBeNull()
    expect(parseCallerHeader('')).toBeNull()
    expect(parseCallerHeader('noseparator')).toBeNull()
  })

  test('PER-REQUEST: two different headers resolve to two different callers', () => {
    const index = readPeersIndex()
    const a = resolveCallerFromHeader('claude-boris', index)
    const b = resolveCallerFromHeader('telegram-nova', index)
    expect(a.address).toBe('claude-boris')
    expect(b.address).toBe('telegram-nova')
    // read-compat carried through: nova's legacy 'human' resolves to 'natural'
    expect(b.intelligence).toBe('natural')
  })

  test('missing header → throws (mentions the header name)', () => {
    expect(() => resolveCallerFromHeader(undefined, readPeersIndex())).toThrow(new RegExp(CALLER_HEADER))
  })

  test('unknown caller → throws (spoofing guard)', () => {
    expect(() => resolveCallerFromHeader('claude-ghost', readPeersIndex())).toThrow(/unknown caller/)
  })

  test('undeclared runtime for a known caller → throws', () => {
    expect(() => resolveCallerFromHeader('codex-boris', readPeersIndex())).toThrow(/not declared/)
  })
})

describe('listTools', () => {
  test('serves ONLY send_to_peer (list_online_peers deprecated) with alwaysLoad meta and NO embedded roster', () => {
    const tools = listTools() as any[]
    expect(tools.map(t => t.name).sort()).toEqual(['send_to_peer'])
    expect(tools.every(t => t._meta['anthropic/alwaysLoad'] === true)).toBe(true)
    const sendTool = tools.find(t => t.name === 'send_to_peer')
    // Regression guard: the peer roster lives ONLY in the system prompt
    // (composeSystemPrompt → "## Known peers"), NEVER in the tool description —
    // embedding it here duplicated the list into every agent's context per turn.
    expect(sendTool.description).not.toMatch(/Known peers/)
    expect(sendTool.description).not.toContain('nova')
    expect(sendTool.description).not.toMatch(/Runtimes:/)
    // Purpose + parameter semantics stay.
    expect(sendTool.description).toContain('Send a message to a known iapeer peer')
    expect(sendTool.description).toContain('wakes it and delivers there')
    expect(sendTool.description).toContain('parallel to the default runtime')
    expect(sendTool.inputSchema.properties.runtime.description).toContain('wakes it warm-on-demand')
    expect(sendTool.inputSchema.properties.runtime.description).toContain('parallel session')
    expect(sendTool.inputSchema.properties.attachments.description).toContain('copies each regular file')
    expect(sendTool.inputSchema.properties.attachments.description).toContain('sources may be deleted immediately')
  })
})

describe('callTool (no wake passed → Ф1 offline behaviour, never spawns)', () => {
  test('send_to_peer to an OFFLINE peer → explicit peer-offline error', async () => {
    const caller = resolveCallerFromHeader('claude-boris', readPeersIndex())
    const r = await callTool(caller, 'send_to_peer', { personality: 'offlinepeer', message: 'hi' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/offline/)
  })

  test('send_to_peer to a peer NOT in the registry → not-delivered error', async () => {
    const caller = resolveCallerFromHeader('claude-boris', readPeersIndex())
    const r = await callTool(caller, 'send_to_peer', { personality: 'nobody', message: 'hi' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/not in the iapeer peers index/)
  })

  test('unknown tool → error', async () => {
    const caller = resolveCallerFromHeader('claude-boris', readPeersIndex())
    expect((await callTool(caller, 'bogus', {})).isError).toBe(true)
  })
})

describe('per-delivery outcome log (Ф-#8a — delivery.log)', () => {
  test('with deliveryLogDir wired: ONE logfmt outcome line per attempt, metadata only', async () => {
    const logDir = join(root, 'logs', 'iapeer')
    const caller = resolveCallerFromHeader('claude-boris', readPeersIndex())
    await callTool(caller, 'send_to_peer', { personality: 'offlinepeer', message: 'hi' }, { deliveryLogDir: logDir })
    await callTool(
      caller,
      'send_to_peer',
      { personality: 'nobody', message: 'hello there', topic: 'probe topic' },
      { deliveryLogDir: logDir },
    )
    const lines = readFileSync(join(logDir, 'delivery.log'), 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    // attempt 1: known-but-offline peer (no wake wired → Ф1 explicit offline)
    expect(lines[0]).toContain('ev=delivery')
    expect(lines[0]).toContain('caller=claude-boris')
    expect(lines[0]).toContain('to=offlinepeer')
    expect(lines[0]).toContain('ok=false')
    expect(lines[0]).toMatch(/err=".*offline.*"/)
    expect(lines[0]).toContain('len=2') // body length, NEVER the body itself
    expect(lines[0]).not.toContain('hi"') // the message text must not leak
    // attempt 2: unknown peer — validation failures are recorded too
    expect(lines[1]).toContain('to=nobody')
    expect(lines[1]).toContain('ok=false')
    expect(lines[1]).toContain('topic="probe topic"')
    expect(lines[1]).toContain('len=11')
  })

  test('without deliveryLogDir (default): nothing is written — library/test daemons stay hermetic', async () => {
    const probeDir = join(root, 'logs', 'unwired')
    const caller = resolveCallerFromHeader('claude-boris', readPeersIndex())
    await callTool(caller, 'send_to_peer', { personality: 'offlinepeer', message: 'hi' })
    expect(existsSync(join(probeDir, 'delivery.log'))).toBe(false)
  })
})

describe('onDelivered hook (M2 arm-on-outbound seam)', () => {
  test('NOT fired on a FAILED delivery — a worker whose reply did not land must not be armed', async () => {
    const fired: string[] = []
    const caller = resolveCallerFromHeader('claude-boris', readPeersIndex())
    // offline target, no wake → routeSend fails → hook must stay silent
    const r = await callTool(
      caller,
      'send_to_peer',
      { personality: 'offlinepeer', message: 'hi' },
      { onDelivered: c => fired.push(c.address) },
    )
    expect(r.isError).toBe(true)
    expect(fired).toEqual([])
  })

  test('a throwing hook never fails the tool call (fail-safe)', async () => {
    const caller = resolveCallerFromHeader('claude-boris', readPeersIndex())
    // even on the error path nothing throws; the ok-path guard is the same try/catch
    const r = await callTool(
      caller,
      'send_to_peer',
      { personality: 'offlinepeer', message: 'hi' },
      {
        onDelivered: () => {
          throw new Error('hook boom')
        },
      },
    )
    expect(r.isError).toBe(true) // the routeSend offline error, NOT the hook's
    expect(r.content[0].text).toMatch(/offline/)
  })
})

describe('ephemeral serial-queue seam (M3)', () => {
  test('ephemeral TARGET → deliver() handles it (no live/miss routing); queued result + delivery.log queued/qd', async () => {
    const logDir = join(root, 'logs', 'm3')
    const caller = resolveCallerFromHeader('claude-boris', readPeersIndex())
    const delivered: string[] = []
    const source = join(root, 'mcp-source.txt')
    writeFileSync(source, 'MCP attachment bytes')
    let recipientCopy = ''
    const r = await callTool(
      caller,
      'send_to_peer',
      { personality: 'offlinepeer', message: 'job for the worker', topic: 'job-1', attachments: [source] },
      {
        deliveryLogDir: logDir,
        ephemeral: {
          isEphemeral: cwd => {
            delivered.push(`checked:${cwd}`)
            return true // offlinepeer plays an ephemeral worker
          },
          deliver: async ({ peer, envelope, topic }) => {
            delivered.push(`deliver:${peer.personality}:${topic}`)
            expect(envelope).toContain('job for the worker') // the routed envelope, not the raw body
            const decoded = decodeEnvelope(envelope)
            expect(decoded.attachments).toHaveLength(1)
            recipientCopy = decoded.attachments[0]!
            expect(recipientCopy).not.toBe(source)
            expect(recipientCopy).toContain('/state/iapeer/attachments/offlinepeer/')
            return {
              ok: true,
              value: {
                ok: true as const,
                delivered_to: { personality: peer.personality, runtime: 'claude' },
                woke: false,
                queued: true,
                queuedBy: 'ephemeral',
                queueDepth: 2,
                ts: 'now',
              },
            }
          },
        },
      },
    )
    expect(r.isError).toBeUndefined()
    rmSync(source)
    expect(readFileSync(recipientCopy, 'utf8')).toBe('MCP attachment bytes')
    expect(delivered).toEqual(['checked:/tmp/offlinepeer', 'deliver:offlinepeer:job-1'])
    const line = readFileSync(join(logDir, 'delivery.log'), 'utf8').trim()
    expect(line).toContain('queued=true')
    expect(line).toContain('qkind=ephemeral')
    expect(line).toContain('qd=2')
    expect(line).toContain('ok=true')
  })

  test('ephemeral self-send is refused up front (a worker enqueueing itself would deadlock its reap)', async () => {
    const caller = resolveCallerFromHeader('claude-boris', readPeersIndex())
    const r = await callTool(
      caller,
      'send_to_peer',
      { personality: 'boris', message: 'to myself' },
      {
        ephemeral: {
          isEphemeral: () => true,
          deliver: async () => {
            throw new Error('must not be reached')
          },
        },
      },
    )
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/cannot send to self/)
  })

  test('non-ephemeral target ignores the seam (normal offline path)', async () => {
    const caller = resolveCallerFromHeader('claude-boris', readPeersIndex())
    const r = await callTool(
      caller,
      'send_to_peer',
      { personality: 'offlinepeer', message: 'hi' },
      {
        ephemeral: {
          isEphemeral: () => false,
          deliver: async () => {
            throw new Error('must not be reached')
          },
        },
      },
    )
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/offline/) // took the ordinary miss path
  })
})

describe('server instructions (no-empty-acks, FU7)', () => {
  // VERBATIM owner-approved wording — a guard so a future edit can't silently drift
  // the text Arthur signed off on.
  test('SERVER_INSTRUCTIONS is the exact approved text', () => {
    expect(SERVER_INSTRUCTIONS).toBe(
      'Reply only when a message needs one — a question, task, request, or awaited result. Skip bare acks/FYIs/thanks; they just loop. Silence is the right reply when nothing is asked.',
    )
  })

  test('createMcpServer builds without throwing (instructions wired into ServerOptions)', () => {
    expect(() => createMcpServer()).not.toThrow()
  })
})
