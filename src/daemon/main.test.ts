// Daemon production main — the daemon's OWN launchd plist (com.agfpd.iapeer),
// the composition smoke (startConfiguredDaemon returns a live TCP handle), and the
// DORMANT H8 bearer seam (off by default → no auth; on only when a token is set).
// All plist writes go under IAPEER_LAUNCHAGENTS_DIR so the suite never touches the
// real ~/Library/LaunchAgents.

import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildDaemonPlistSpec,
  daemonPlistPath,
  ensureDaemonStarted,
  installDaemonPlist,
  makeArmEphemeralOnDelivered,
  makeEphemeralRouteDeps,
  makeNoteLiveTopic,
  startConfiguredDaemon,
  DEFAULT_DAEMON_PORT,
} from './main.ts'
import { daemonDiscoveryPath, defaultDaemonSocketPath, startDaemon, type DaemonHandle } from './index.ts'
import {
  ephemeralQueueDepth,
  hasEphemeralArmed,
  peekEphemeralTask,
  readTopic,
  resolveWakeMode,
  setIdleReaped,
  addTopic,
  type LifecycleConfig,
} from '../lifecycle/index.ts'
import type { ResolvedCaller } from '../identity/index.ts'
import { isFoundationOwnedPlist } from '../launch/index.ts'
import { DAEMON_PLIST_LABEL } from '../core/constants.ts'

const tmpDirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-daemon-main-'))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function plutilLint(path: string): boolean {
  return spawnSync('plutil', ['-lint', path], { encoding: 'utf8' }).status === 0
}

describe('buildDaemonPlistSpec / installDaemonPlist (com.agfpd.iapeer)', () => {
  test('spec carries the daemon label, default port env, and the INSTALLED iapeer entrypoint (Ф-F)', () => {
    const spec = buildDaemonPlistSpec({ env: { HOME: '/Users/x' } as NodeJS.ProcessEnv })
    expect(spec.label).toBe(DAEMON_PLIST_LABEL) // com.agfpd.iapeer — NOT com.iapeer.*
    expect(spec.environment.IAPEER_PORT).toBe(String(DEFAULT_DAEMON_PORT))
    // Ф-F: runs the INSTALLED binary `iapeer daemon`, NOT `bun <src>/main.ts` — prod
    // decoupled from the mutable src tree.
    expect(spec.programArguments).toEqual(['/Users/x/.local/bin/iapeer', 'daemon'])
  })

  test('NO bearer token in the plist env by default (H8 seam dormant)', () => {
    expect(buildDaemonPlistSpec({ env: {} as NodeJS.ProcessEnv }).environment.IAPEER_BEARER_TOKEN).toBeUndefined()
  })

  test('bearer token is baked into the plist env only when explicitly provided', () => {
    const spec = buildDaemonPlistSpec({ bearerToken: 's3cret', env: {} as NodeJS.ProcessEnv })
    expect(spec.environment.IAPEER_BEARER_TOKEN).toBe('s3cret')
  })

  test('installs a valid, foundation-owned plist under IAPEER_LAUNCHAGENTS_DIR', () => {
    const root = mkTmp()
    const env = {
      IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'),
      IAPEER_ROOT: join(root, 'iapeer'),
      HOME: root,
      PATH: '/usr/bin:/bin',
    } as NodeJS.ProcessEnv
    const r = installDaemonPlist({ env, port: 8765, throttleIntervalSecs: 10 })
    expect(r.path).toBe(daemonPlistPath(env))
    expect(r.changed).toBe(true) // first install on a clean host writes
    expect(existsSync(r.path)).toBe(true)
    expect(isFoundationOwnedPlist(r.path)).toBe(true)
    expect(plutilLint(r.path)).toBe(true) // live plutil: valid plist
    const xml = readFileSync(r.path, 'utf8')
    expect(xml).toContain(`<string>${DAEMON_PLIST_LABEL}</string>`)
    expect(xml).toContain('<key>RunAtLoad</key>')
    expect(xml).toContain('<key>KeepAlive</key>')
  })

  test('idempotent by content: a re-install of the SAME plist does NOT rewrite the file (changed:false, mtime stable) — no BTM notification spam (owner-caught 11.06)', () => {
    const root = mkTmp()
    const env = {
      IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'),
      IAPEER_ROOT: join(root, 'iapeer'),
      HOME: root,
      PATH: '/usr/bin:/bin',
    } as NodeJS.ProcessEnv
    const opts = { env, port: 8765, throttleIntervalSecs: 10 }
    const first = installDaemonPlist(opts)
    expect(first.changed).toBe(true)
    const mtime1 = statSync(first.path).mtimeMs
    // second identical install — must be a pure no-op (no write → BTM not tripped)
    const second = installDaemonPlist(opts)
    expect(second.changed).toBe(false)
    expect(second.path).toBe(first.path)
    expect(statSync(second.path).mtimeMs).toBe(mtime1) // file untouched, not just byte-equal
    // a CHANGED spec (different port → different rendered plist) DOES rewrite
    const third = installDaemonPlist({ env, port: 9999, throttleIntervalSecs: 10 })
    expect(third.changed).toBe(true)
  })

  test('REFUSES to overwrite a foreign com.agfpd.iapeer.plist (collision guard)', () => {
    const root = mkTmp()
    const laDir = join(root, 'LaunchAgents')
    mkdirSync(laDir, { recursive: true })
    const env = { IAPEER_LAUNCHAGENTS_DIR: laDir, IAPEER_ROOT: join(root, 'iapeer'), HOME: root } as NodeJS.ProcessEnv
    const path = daemonPlistPath(env)
    const foreign = '<?xml version="1.0"?>\n<plist><dict><key>Label</key><string>com.agfpd.iapeer</string></dict></plist>\n'
    writeFileSync(path, foreign)
    expect(() => installDaemonPlist({ env })).toThrow(/foundation-managed|refus/i)
    expect(readFileSync(path, 'utf8')).toBe(foreign) // untouched
    // (the throw must fire BEFORE the write-if-changed read, so the foreign file
    //  is never even compared — the guard is the first gate.)
  })
})

describe('ensureDaemonStarted (onboard step 0 — start the daemon)', () => {
  const mkEnv = (root: string) =>
    ({
      IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'),
      IAPEER_ROOT: join(root, 'iapeer'),
      HOME: root,
      PATH: '/usr/bin:/bin',
    }) as NodeJS.ProcessEnv

  test('dryRun reports would-start and touches nothing', async () => {
    const env = mkEnv(mkTmp())
    const r = await ensureDaemonStarted({ env, dryRun: true })
    expect(r.state).toBe('would-start')
    expect(existsSync(daemonPlistPath(env))).toBe(false) // dry-run writes no plist
  })

  test('non-dry: ensures the plist, never loads a real job under IAPEER_TEST_SANDBOX', async () => {
    const env = mkEnv(mkTmp())
    const r = await ensureDaemonStarted({ env })
    // The process-level IAPEER_TEST_SANDBOX guard forces bootstrapDaemon to skip the
    // host-global launchctl — so a test never loads a real com.agfpd.iapeer job.
    expect(r.state).toBe('skipped-sandbox')
    // …but the plist IS ensured (idempotent install) even when the load is skipped.
    expect(existsSync(daemonPlistPath(env))).toBe(true)
    expect(isFoundationOwnedPlist(daemonPlistPath(env))).toBe(true)
  })
})

describe('startConfiguredDaemon (composition smoke — TCP loopback)', () => {
  test('returns a live http handle and closes cleanly', async () => {
    const root = mkTmp()
    const env = { IAPEER_ROOT: join(root, 'iapeer'), HOME: root, PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv
    const handle = await startConfiguredDaemon({ port: 0, host: '127.0.0.1', env })
    try {
      expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    } finally {
      await handle.close()
    }
  })
})

// The H8 bearer seam: a validator LAYER on the listener, OFF unless a token is set
// (Нова 07.06 — H8 DEFERRED, no token provisioning yet). These tests prove the
// seam is dormant by default and would gate every request once a token is wired.
describe('H8 bearer seam (dormant by default)', () => {
  const INIT = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  })
  const headers = (auth?: string): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(auth ? { authorization: auth } : {}),
  })

  async function withDaemon(opts: Parameters<typeof startDaemon>[0], fn: (h: DaemonHandle) => Promise<void>) {
    const h = await startDaemon(opts)
    try {
      await fn(h)
    } finally {
      await h.close()
    }
  }

  test('NO token → request is NOT 401 (auth layer off)', async () => {
    await withDaemon({ port: 0, host: '127.0.0.1' }, async h => {
      const res = await fetch(h.url!, { method: 'POST', headers: headers(), body: INIT })
      expect(res.status).not.toBe(401)
    })
  })

  test('token set → no Authorization is 401, correct Bearer passes the layer', async () => {
    await withDaemon({ port: 0, host: '127.0.0.1', bearerToken: 'secret' }, async h => {
      const noAuth = await fetch(h.url!, { method: 'POST', headers: headers(), body: INIT })
      expect(noAuth.status).toBe(401)
      const wrong = await fetch(h.url!, { method: 'POST', headers: headers('Bearer nope'), body: INIT })
      expect(wrong.status).toBe(401)
      const ok = await fetch(h.url!, { method: 'POST', headers: headers('Bearer secret'), body: INIT })
      expect(ok.status).not.toBe(401) // passed the auth layer (MCP handles the rest)
      await ok.body?.cancel()
    })
  })
})

// Dual-listen (Ф2 consolidation): the daemon serves a 0600 unix socket (local
// same-uid callers: notifier/telegram/CLI) AND TCP (agent MCP) over ONE handler,
// and writes router.json (both addresses) for daemon-aware `iap send`.
describe('dual-listen + router.json discovery', () => {
  const INIT = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
  })
  const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }

  test('binds socket + TCP over one handler; router.json carries both; close cleans up', async () => {
    const root = mkTmp()
    const env = { IAPEER_ROOT: join(root, 'iapeer') } as NodeJS.ProcessEnv
    const sockExpected = defaultDaemonSocketPath({ env })
    const h = await startDaemon({ port: 0, host: '127.0.0.1', socketPath: sockExpected, discovery: true, env })
    try {
      // TCP listener answers the MCP handler
      const tcp = await fetch(h.url!, { method: 'POST', headers: mcpHeaders, body: INIT })
      expect(tcp.ok).toBe(true)
      await tcp.body?.cancel()
      // unix-socket listener answers the SAME handler (bun fetch `unix` option)
      const unixInit = { unix: h.socketPath!, method: 'POST', headers: mcpHeaders, body: INIT } as unknown as RequestInit
      const sock = await fetch('http://localhost/mcp', unixInit)
      expect(sock.ok).toBe(true)
      await sock.body?.cancel()
      // socket is 0600 (same-uid)
      expect((statSync(h.socketPath!).mode & 0o777).toString(8)).toBe('600')
      // router.json carries BOTH addresses
      const rj = JSON.parse(readFileSync(daemonDiscoveryPath({ env }), 'utf8'))
      expect(rj.sock).toBe(sockExpected)
      expect(rj.tcp).toBe(h.url)
    } finally {
      await h.close()
    }
    // clean shutdown removed the socket file AND router.json
    expect(existsSync(sockExpected)).toBe(false)
    expect(existsSync(daemonDiscoveryPath({ env }))).toBe(false)
  })

  test('port-only stays TCP-only — no socket, no router.json (backward compat)', async () => {
    const root = mkTmp()
    const env = { IAPEER_ROOT: join(root, 'iapeer') } as NodeJS.ProcessEnv
    const h = await startDaemon({ port: 0, host: '127.0.0.1', env })
    try {
      expect(h.socketPath).toBeUndefined()
      expect(existsSync(daemonDiscoveryPath({ env }))).toBe(false)
    } finally {
      await h.close()
    }
  })
})

describe('startDaemon composerQueue shutdown seam', () => {
  test('close() fails pending busy-composer queue before tearing listeners down', async () => {
    const reasons: string[] = []
    const h = await startDaemon({
      port: 0,
      host: '127.0.0.1',
      composerQueue: {
        tryEnqueue: async () => null,
        failAll: async reason => {
          reasons.push(reason)
        },
      },
    })
    await h.close()
    expect(reasons).toEqual(['daemon shutting down/restarting before queued delivery completed'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// wake_policy:ephemeral M2 — makeArmEphemeralOnDelivered (the arm-on-outbound
// composition: ephemeral caller's ok send ⇒ .ephemeral-armed for its identity)
// ─────────────────────────────────────────────────────────────────────────────

describe('makeArmEphemeralOnDelivered (M2 arm-on-outbound)', () => {
  function caller(cwd: string): ResolvedCaller {
    return {
      personality: 'w',
      runtime: 'claude',
      address: 'claude-w',
      description: '',
      intelligence: 'artificial',
      cwd,
      record: { personality: 'w', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial', cwd },
    } as ResolvedCaller
  }

  test('EPHEMERAL caller → armed for the CALLER identity; plain caller → no-op', () => {
    const stateDir = join(mkTmp(), 'lifecycle')
    const cfg = { stateDir } as LifecycleConfig
    const arm = makeArmEphemeralOnDelivered(cfg)
    // ephemeral worker cwd
    const eph = mkTmp()
    mkdirSync(join(eph, '.iapeer'), { recursive: true })
    writeFileSync(
      join(eph, '.iapeer', 'peer-profile.json'),
      JSON.stringify({ personality: 'w', runtime: 'claude', wake_policy: 'ephemeral' }),
    )
    arm(caller(eph))
    expect(hasEphemeralArmed(cfg, 'claude-w')).toBe(true)
    // plain peer cwd (no wake_policy) → never armed
    const plainCfg = { stateDir: join(mkTmp(), 'lifecycle') } as LifecycleConfig
    const plain = mkTmp()
    mkdirSync(join(plain, '.iapeer'), { recursive: true })
    writeFileSync(
      join(plain, '.iapeer', 'peer-profile.json'),
      JSON.stringify({ personality: 'w', runtime: 'claude' }),
    )
    makeArmEphemeralOnDelivered(plainCfg)(caller(plain))
    expect(hasEphemeralArmed(plainCfg, 'claude-w')).toBe(false)
  })

  test('missing profile / unreadable cwd → no-op, never throws (best-effort)', () => {
    const cfg = { stateDir: join(mkTmp(), 'lifecycle') } as LifecycleConfig
    const arm = makeArmEphemeralOnDelivered(cfg)
    expect(() => arm(caller('/tmp/no-such-peer-cwd-anywhere'))).not.toThrow()
    expect(hasEphemeralArmed(cfg, 'claude-w')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// wake_policy:"ephemeral" M3 — makeEphemeralRouteDeps (enqueue + async drain kick)
// ─────────────────────────────────────────────────────────────────────────────

describe('makeEphemeralRouteDeps (M3 serial-queue composition)', () => {
  const workerPeer = {
    personality: 'w',
    runtime: 'claude' as const,
    runtimes: ['claude' as const],
    description: '',
    intelligence: 'artificial' as const,
    cwd: '/tmp/w',
  }

  test('deliver = enqueue to disk + fast {queued, qd} ack + drain kick (NOT awaited wake)', async () => {
    const stateDir = join(mkTmp(), 'lifecycle')
    const cfg = { stateDir } as LifecycleConfig
    const kicks: string[] = []
    const deps = makeEphemeralRouteDeps(cfg, {} as NodeJS.ProcessEnv, (p, rt) => kicks.push(`${rt}-${p}`))

    const r1 = await deps.deliver({ peer: workerPeer, envelope: '<iap>task one</iap>', topic: 't1' })
    const r2 = await deps.deliver({ peer: workerPeer, envelope: '<iap>task two</iap>' })

    expect(r1.ok && r1.value.queued).toBe(true)
    expect(r1.ok && r1.value.queuedBy).toBe('ephemeral')
    expect(r1.ok && r1.value.queueDepth).toBe(1)
    expect(r1.ok && r1.value.woke).toBe(false)
    expect(r2.ok && r2.value.queueDepth).toBe(2)
    expect(kicks).toEqual(['claude-w', 'claude-w']) // drain kicked per enqueue
    // durable FIFO on disk, head intact
    expect(ephemeralQueueDepth(cfg, 'claude-w')).toBe(2)
    expect(peekEphemeralTask(cfg, 'claude-w')).toMatchObject({ task: '<iap>task one</iap>', topic: 't1' })
  })

  test('enqueue failure → fail-loud delivery error (never a false queued ack)', async () => {
    const root = mkTmp()
    const blocker = join(root, 'state-is-a-file')
    writeFileSync(blocker, 'not a dir')
    const cfg = { stateDir: join(blocker, 'lifecycle') } as LifecycleConfig // mkdir must fail
    const deps = makeEphemeralRouteDeps(cfg, {} as NodeJS.ProcessEnv, () => {})
    const r = await deps.deliver({ peer: workerPeer, envelope: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/enqueue failed/)
  })

  test('runtime override resolves through the registry gate (undeclared → fail-loud)', async () => {
    const cfg = { stateDir: join(mkTmp(), 'lifecycle') } as LifecycleConfig
    const deps = makeEphemeralRouteDeps(cfg, {} as NodeJS.ProcessEnv, () => {})
    const r = await deps.deliver({ peer: workerPeer, envelope: 'x', runtime: 'codex' })
    expect(r.ok).toBe(false) // 'codex' is not declared for this worker
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// makeNoteLiveTopic — the live-delivered-topic composition (fresh-vs-resume seam):
// the .topic marker must track the topic the session last WORKED ON, not the one
// it woke with (defect 11.06: a day-stale wake-time marker false-freshed the
// stop→start resume of a long-lived executor).
// ─────────────────────────────────────────────────────────────────────────────

describe('makeNoteLiveTopic (live-delivered topic → .topic marker)', () => {
  function noteCfg(): LifecycleConfig {
    const root = mkTmp()
    return { stateDir: join(root, 'state'), eventLogDir: join(root, 'logs') } as LifecycleConfig
  }

  test('topic SHIFT → marker updated + ev=topic-note logged; same topic → no churn, no log spam', () => {
    const cfg = noteCfg()
    const note = makeNoteLiveTopic(cfg, {} as NodeJS.ProcessEnv)
    addTopic(cfg, 'claude-x', 'topic-a') // the wake established topic A
    note('claude-x', 'topic-b') // a live delivery switches the work to B
    expect(readTopic(cfg, 'claude-x')).toBe('topic-b')
    const logPath = join(cfg.eventLogDir, 'lifecycle.log')
    const log = readFileSync(logPath, 'utf8')
    expect(log).toContain('ev=topic-note')
    expect(log).toContain('identity=claude-x')
    expect(log).toContain('topic=topic-b')
    // the common case — every further message continues topic B → strictly nothing
    note('claude-x', 'topic-b')
    note('claude-x', 'topic-b')
    expect(readFileSync(logPath, 'utf8').match(/ev=topic-note/g)?.length).toBe(1)
  })

  test('acceptance scenario (boris 11.06): woke with topic A → worked live-delivered topic B → clean stop-park → wake with topic B = RESUME, not fresh', () => {
    const cfg = noteCfg()
    const id = 'claude-x'
    // executor peer cwd: no telegram interface (not human-conversational), no wake_policy
    const cwd = mkTmp()
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(join(cwd, '.iapeer', 'peer-profile.json'), JSON.stringify({ personality: 'x', runtime: 'claude' }))
    addTopic(cfg, id, 'topic-a') // session woke with topic A (the stale pre-fix marker)
    makeNoteLiveTopic(cfg)(id, 'topic-b') // ...then took topic-B messages in the LIVE session all day
    setIdleReaped(cfg, id) // deliberate stop = clean park (stopPeer's promise)
    const hasTranscript = () => ({ ok: true, ref: 'uuid-1' })
    // pre-fix this read the stale 'topic-a' → cause=idle-reaped-new-topic → FRESH (context lost)
    expect(resolveWakeMode(cfg, id, cwd, undefined, hasTranscript, 'topic-b')).toEqual({
      resume: true,
      resumeRef: 'uuid-1',
      cause: 'idle-reaped-resume',
    })
  })

  test('marker/log failure → no-op, never throws (a delivered message must stand)', () => {
    const root = mkTmp()
    const blocker = join(root, 'state-is-a-file')
    writeFileSync(blocker, 'not a dir')
    const cfg = { stateDir: join(blocker, 'state'), eventLogDir: join(blocker, 'logs') } as LifecycleConfig // mkdir must fail
    expect(() => makeNoteLiveTopic(cfg)('claude-x', 'topic-b')).not.toThrow()
  })
})
