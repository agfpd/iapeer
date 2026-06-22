// iapeer CLI verbs — list / stop / start (C1 + fleet guard) / send validation.
// No tmux: killSession on a non-existent session is a no-op, the C1 flag is the
// observable. The FLEET GUARD (H4) is the safety-critical case — a foreign
// persistent-peer launchd plist must be refused.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { addRuntime, compactPeer, defaultRuntime, formatListTable, listPeers, newPeer, parseArgs, refreshPeer, removePeerCli, renamePeerCli, runCli, sendMessage, startPeer, stopPeer } from './index.ts'
import { findPeer, readPeersIndex, upsertPeer } from '../registry/index.ts'
import { transcriptSlug } from '../launch/adapters/claude.ts'
import { hasFreshNext, hasIdleReaped, isStopped, loadLifecycleConfig, setIdleReaped, setStopped } from '../lifecycle/index.ts'
import { launchdPlistPath } from '../launch/launchd.ts'
import { err, ok } from '../core/errors.ts'

let root: string
let laDir: string
function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    IAPEER_ROOT: root,
    IAPEER_LAUNCHAGENTS_DIR: laDir,
    IAPEER_SOCK_DIR: join(root, 'socks'),
  }
  delete e.PEER_PERSONALITY
  delete e.PEER_IDENTITY
  delete e.PEER_RUNTIME
  return e
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-cli-root-'))
  laDir = mkdtempSync(join(tmpdir(), 'iapeer-cli-la-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(laDir, { recursive: true, force: true })
})

async function register(personality: string, runtime = 'claude', intelligence: 'artificial' | 'natural' | 'absent' = 'artificial'): Promise<void> {
  await upsertPeer({ personality, runtime, cwd: `/tmp/${personality}`, intelligence }, { rootDir: root })
}

// ─── v1.2 provision-инверсия at the CLI joints (remove → unprovision) ─────────
// NB: the memory-plugin verb was REMOVED 11.06 (ADR-017 — the plugin form is
// retired ecosystem-wide; fleet sweeps are the provider's side). The core's
// remaining v1.2 joints are birth (provision.test.ts) and remove (below).

describe('remove with a v1.2 provision slot', () => {
  function declareV12Slot(): string {
    const journal = join(root, 'journal.txt')
    const script = join(root, 'fake-provider.sh')
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${journal}'\n`, { mode: 0o755 })
    writeFileSync(
      join(root, 'memory-provider.json'),
      JSON.stringify({
        provider: 'fake-mem',
        package: '@x/fake',
        version: '0.0.1',
        registeredAt: 'x',
        provision: { command: script, args: ['provision-peer', '--occasion', '{occasion}'] },
        unprovision: { command: script, args: ['unprovision-peer', '--cwd', '{cwd}', '--occasion', '{occasion}'] },
      }),
    )
    return journal
  }

  test('memory-plugin verb is GONE — unknown verb exits with usage (removal 11.06)', async () => {
    const code = await runCli(['memory-plugin', 'on', '--all'], env())
    expect(code).toBe(2) // usage exit — the verb no longer exists
  })

  test('remove: unprovision runs with occasion=remove BEFORE the purge, outcome reported', async () => {
    const journal = declareV12Slot()
    await register('beta')
    const o = await removePeerCli('beta', { env: env() })
    expect(o.action).toBe('removed')
    expect(o.unprovision).toEqual(['claude:ok'])
    const { readFileSync } = await import('fs')
    const j = readFileSync(journal, 'utf8')
    expect(j).toContain('unprovision-peer')
    expect(j).toContain('--cwd\n/tmp/beta')
    expect(j).toContain('remove')
  })
})

describe('list', () => {
  test('lists registered peers with per-runtime liveness (asleep / stopped)', async () => {
    await register('alpha')
    await register('beta')
    const e = env()
    setStopped(loadLifecycleConfig(e), 'claude-beta')
    const rows = listPeers({ env: e })
    const alpha = rows.find(r => r.personality === 'alpha')!
    const beta = rows.find(r => r.personality === 'beta')!
    expect(alpha.runtimes[0]).toEqual({ runtime: 'claude', status: 'asleep' })
    expect(beta.runtimes[0]).toEqual({ runtime: 'claude', status: 'stopped' })
    expect(formatListTable(rows)).toContain('alpha')
    expect(formatListTable(rows)).toContain('✕ claude') // stopped glyph for beta
  })
  test('empty registry → friendly message', () => {
    expect(formatListTable(listPeers({ env: env() }))).toBe('no peers registered\n')
  })
})

describe('stop / start (C1 durable flag, warm runtime)', () => {
  test('stop sets the durable flag; start clears it', async () => {
    await register('gamma')
    const e = env()
    const cfg = loadLifecycleConfig(e)
    expect(isStopped(cfg, 'claude-gamma')).toBe(false)
    expect(stopPeer('gamma', undefined, { env: e })[0].action).toBe('stopped')
    expect(isStopped(cfg, 'claude-gamma')).toBe(true)
    expect(startPeer('gamma', undefined, { env: e })[0].action).toBe('started')
    expect(isStopped(cfg, 'claude-gamma')).toBe(false)
  })
  test('stop an unregistered peer → throws', () => {
    expect(() => stopPeer('nobody', undefined, { env: env() })).toThrow(/not registered/)
  })
  test('stop is a CLEAN PARK: leaves the resume marker and drops the session-state (boris 10.06)', async () => {
    await register('parked')
    const e = env()
    const cfg = loadLifecycleConfig(e)
    // a live session-state the daemon would otherwise tag as a death post-kill
    mkdirSync(cfg.stateDir, { recursive: true })
    writeFileSync(
      join(cfg.stateDir, 'claude-parked.session'),
      JSON.stringify({ identity: 'claude-parked', runtime: 'claude', personality: 'parked', cwd: '/tmp/parked', wokeAt: Date.now() }),
    )
    stopPeer('parked', undefined, { env: e })
    expect(hasIdleReaped(cfg, 'claude-parked')).toBe(true) // park marker → post-start wake RESUMES
    expect(existsSync(join(cfg.stateDir, 'claude-parked.session'))).toBe(false) // not a death for supervise
    // start clears only the stop flag — the park marker survives for the wake
    startPeer('parked', undefined, { env: e })
    expect(isStopped(cfg, 'claude-parked')).toBe(false)
    expect(hasIdleReaped(cfg, 'claude-parked')).toBe(true)
  })
  test('start --all clears the flag of EVERY registered peer; unregistered garbage untouched (incident 11.06)', async () => {
    await register('p1')
    await register('p2')
    const e = env()
    const cfg = loadLifecycleConfig(e)
    // a stopped fleet …
    setStopped(cfg, 'claude-p1')
    setStopped(cfg, 'claude-p2')
    // … plus a stray stop-flag for an identity NO registry record claims
    setStopped(cfg, 'claude-ghost')
    expect(await runCli(['start', '--all'], e)).toBe(0)
    expect(isStopped(cfg, 'claude-p1')).toBe(false)
    expect(isStopped(cfg, 'claude-p2')).toBe(false)
    expect(isStopped(cfg, 'claude-ghost')).toBe(true) // unregistered → never enumerated, never touched
  })
  test('start without a peer and without --all → usage, nothing executed', async () => {
    await register('p3')
    const e = env()
    const cfg = loadLifecycleConfig(e)
    setStopped(cfg, 'claude-p3')
    expect(await runCli(['start'], e)).toBe(2)
    expect(isStopped(cfg, 'claude-p3')).toBe(true) // flag untouched — usage only
  })
})

describe('refresh (lazy soft-reload — fresh-on-next-wake marker)', () => {
  test('arms .fresh-next for an agentic peer; NOT a stop (peer stays wakeable)', async () => {
    await register('delta')
    const e = env()
    const cfg = loadLifecycleConfig(e)
    expect(refreshPeer('delta', undefined, { env: e })).toEqual([{ personality: 'delta', runtime: 'claude', action: 'refresh-armed' }])
    expect(hasFreshNext(cfg, 'claude-delta')).toBe(true)
    expect(isStopped(cfg, 'claude-delta')).toBe(false) // refresh ≠ stop — never sets the stop-flag
  })
  test('skips a non-agentic runtime (a router carries no doctrine) — no marker written', async () => {
    await register('rtr', 'notifier', 'absent')
    const e = env()
    const cfg = loadLifecycleConfig(e)
    expect(refreshPeer('rtr', undefined, { env: e })).toEqual([{ personality: 'rtr', runtime: 'notifier', action: 'skipped-non-agentic' }])
    expect(hasFreshNext(cfg, 'notifier-rtr')).toBe(false)
  })
  test('refresh --all arms every agentic peer, skips routers, returns 0', async () => {
    await register('a1')
    await register('rtr2', 'notifier', 'absent')
    const e = env()
    const cfg = loadLifecycleConfig(e)
    expect(await runCli(['refresh', '--all'], e)).toBe(0)
    expect(hasFreshNext(cfg, 'claude-a1')).toBe(true)
    expect(hasFreshNext(cfg, 'notifier-rtr2')).toBe(false)
  })
  test('refresh an unregistered peer → throws', () => {
    expect(() => refreshPeer('nobody', undefined, { env: env() })).toThrow(/not registered/)
  })
})

describe('FLEET GUARD (H4) — foreign persistent-peer launchd plist is off-limits', () => {
  test('stop refuses a peer whose com.iapeer.<p>.plist is NOT foundation-owned', async () => {
    await register('boris')
    // a live PP peer owns com.iapeer.boris.plist WITHOUT the foundation sentinel
    writeFileSync(launchdPlistPath('boris', env()), '<?xml version="1.0"?>\n<plist><dict><key>Label</key><string>com.iapeer.boris</string></dict></plist>\n')
    const e = env()
    const out = stopPeer('boris', undefined, { env: e })
    expect(out[0].action).toBe('refused-foreign-launchd')
    // the durable flag was NOT set — the foundation did not touch the PP peer
    expect(isStopped(loadLifecycleConfig(e), 'claude-boris')).toBe(false)
    // start likewise refuses
    expect(startPeer('boris', undefined, { env: e })[0].action).toBe('refused-foreign-launchd')
  })
})

describe('remove (registry record via the locked writer)', () => {
  test('removes a registered peer through registry.removePeer', async () => {
    await register('zombie')
    const e = env()
    expect(findPeer(readPeersIndex({ env: e }), 'zombie')).not.toBeNull()
    const o = await removePeerCli('zombie', { env: e })
    expect(o.action).toBe('removed')
    expect(findPeer(readPeersIndex({ env: e }), 'zombie')).toBeNull()
    // the folder is deliberately KEPT; the outcome carries the cwd so the verb can
    // say so instead of leaving silent orphans (boris 10.06)
    expect(o.cwd).toBe('/tmp/zombie')
  })
  test('removing an absent peer is an idempotent no-op (not an error)', async () => {
    const o = await removePeerCli('never-existed', { env: env() })
    expect(o.action).toBe('absent')
  })
  test('a second remove of the same peer is also a no-op', async () => {
    await register('twice')
    const e = env()
    expect((await removePeerCli('twice', { env: e })).action).toBe('removed')
    expect((await removePeerCli('twice', { env: e })).action).toBe('absent')
  })
  test('self-done arms the caller\'s own quiet-reap (non-waking silent finish); refuses without PEER_IDENTITY', async () => {
    const e = env()
    // no PEER_IDENTITY → self-call refusal
    expect(await runCli(['self-done'], e)).toBe(1)
    // with PEER_IDENTITY → marker set, exit 0, nobody contacted
    const e2 = { ...e, PEER_IDENTITY: 'claude-silentworker' }
    expect(await runCli(['self-done'], e2)).toBe(0)
    const { hasEphemeralArmed } = await import('../lifecycle/index.ts')
    expect(hasEphemeralArmed(loadLifecycleConfig(e2), 'claude-silentworker')).toBe(true)
  })

  test('self-done ephemeral check keys on the CANONICAL registry cwd, not process.cwd() (live false-warning, scriber 11.06)', async () => {
    // an ephemeral peer registered with a cwd carrying wake_policy:ephemeral
    const cwd = join(root, 'worker')
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(join(cwd, '.iapeer', 'peer-profile.json'), JSON.stringify({ personality: 'worker', runtime: 'claude', wake_policy: 'ephemeral' }))
    await upsertPeer({ personality: 'worker', runtime: 'claude', cwd, intelligence: 'artificial' }, { rootDir: root })
    const e = { ...env(), PEER_IDENTITY: 'claude-worker' }
    let captured = ''
    const origWrite = process.stdout.write
    process.stdout.write = ((s: string | Uint8Array) => {
      captured += typeof s === 'string' ? s : Buffer.from(s).toString('utf8')
      return true
    }) as typeof process.stdout.write
    try {
      // invoked from THIS test process's cwd (≠ peer cwd) — the warning must NOT fire
      expect(await runCli(['self-done'], e)).toBe(0)
      expect(captured).toContain('armed claude-worker')
      expect(captured).not.toContain('marker is inert')
    } finally {
      process.stdout.write = origWrite
    }
  })

  test('purges identity-keyed lifecycle state with the record — a namesake newborn must not inherit a dead peer\'s parking (boris 10.06)', async () => {
    await register('reborn')
    const e = env()
    const cfg = loadLifecycleConfig(e)
    // the dead peer left the full marker cemetery behind (the live-defect shape:
    // .stopped + .idle-reaped → a namesake newborn is REFUSED its wake)
    setStopped(cfg, 'claude-reborn')
    setIdleReaped(cfg, 'claude-reborn')
    writeFileSync(join(cfg.stateDir, 'claude-reborn.topic'), 'old-topic')
    mkdirSync(join(cfg.stateDir, 'claude-reborn.queue'), { recursive: true })
    // a NEIGHBOR identity sharing the name as a PREFIX must survive untouched
    setStopped(cfg, 'claude-reborn2')

    const o = await removePeerCli('reborn', { env: e })
    expect(o.action).toBe('removed')
    expect(o.purgedState?.sort()).toEqual([
      'claude-reborn.idle-reaped',
      'claude-reborn.queue',
      'claude-reborn.stopped',
      'claude-reborn.topic',
    ])
    expect(isStopped(cfg, 'claude-reborn')).toBe(false) // the newborn namesake wakes
    expect(existsSync(join(cfg.stateDir, 'claude-reborn.queue'))).toBe(false)
    expect(isStopped(cfg, 'claude-reborn2')).toBe(true) // dot-delimited: no prefix bleed
  })

  // PLIST TEARDOWN (boris 22.06): removing an always-on peer WITHOUT booting out + rm-ing
  // its com.iapeer.<p> plist left an ORPHAN → launchd KeepAlive crash-looped run-infra
  // against the deleted record. remove now tears down a FOUNDATION-OWNED plist, with the
  // H4 fleet-guard refusing a FOREIGN persistent-peer plist.
  const writePlist = (personality: string, e: NodeJS.ProcessEnv, foundationOwned: boolean): string => {
    const p = launchdPlistPath(personality, e)
    const sentinel = foundationOwned ? '<key>com.iapeer.managed</key><true/>' : '<key>SomeForeignOwner</key><true/>'
    writeFileSync(p, `<?xml version="1.0"?><plist><dict>${sentinel}</dict></plist>`)
    return p
  }

  test('always-on peer (foundation-owned plist) → bootout + plist removed (no orphan crash-loop)', async () => {
    await register('voicebot', 'voicetalk', 'natural')
    const e = env()
    const plist = writePlist('voicebot', e, true)
    expect(existsSync(plist)).toBe(true)
    const o = await removePeerCli('voicebot', { env: e })
    expect(o.action).toBe('removed')
    expect(o.plistTeardown).toContain('skipped-sandbox') // sandbox: no real launchctl bootout
    expect(o.plistTeardown).toContain('plist removed')
    expect(existsSync(plist)).toBe(false) // the orphan-causing plist is gone
    expect(findPeer(readPeersIndex({ env: e }), 'voicebot')).toBeNull()
  })

  test('a warm peer with NO plist → plistTeardown absent (nothing to tear down)', async () => {
    await register('warmonly')
    const o = await removePeerCli('warmonly', { env: env() })
    expect(o.action).toBe('removed')
    expect(o.plistTeardown).toBeUndefined()
  })

  test('FLEET GUARD (H4): a FOREIGN launchd plist → refused without --force (registry + foreign plist intact)', async () => {
    await register('ppfleet')
    const e = env()
    const plist = writePlist('ppfleet', e, false) // NO foundation sentinel
    const o = await removePeerCli('ppfleet', { env: e })
    expect(o.action).toBe('refused-foreign-launchd')
    expect(findPeer(readPeersIndex({ env: e }), 'ppfleet')).not.toBeNull() // registry untouched
    expect(existsSync(plist)).toBe(true) // foreign plist NEVER touched
  })

  test('FLEET GUARD (H4): --force drops the registry record but LEAVES the foreign plist intact', async () => {
    await register('ppfleet2')
    const e = env()
    const plist = writePlist('ppfleet2', e, false)
    const o = await removePeerCli('ppfleet2', { env: e, force: true })
    expect(o.action).toBe('removed')
    expect(o.plistTeardown).toContain('skipped-foreign')
    expect(existsSync(plist)).toBe(true) // foreign plist left intact even under --force (H4)
    expect(findPeer(readPeersIndex({ env: e }), 'ppfleet2')).toBeNull()
  })
})

describe('send validation', () => {
  test('invalid --from identity → throws', async () => {
    await register('alpha')
    await expect(
      sendMessage({ from: 'notanidentity', target: 'alpha', message: 'hi', env: env() }),
    ).rejects.toThrow(/invalid/)
  })
  test('unknown --from caller → throws (not registered)', async () => {
    await register('alpha')
    await expect(
      sendMessage({ from: 'claude-ghost', target: 'alpha', message: 'hi', env: env() }),
    ).rejects.toThrow(/unknown caller|not registered/)
  })
  test('target not in registry → throws before any wake', async () => {
    await register('alpha')
    await expect(
      sendMessage({ from: 'claude-alpha', target: 'nobody', message: 'hi', env: env() }),
    ).rejects.toThrow(/not in the iapeer peers index|self/)
  })
})

describe('send → ephemeral target: M3 FIFO parity with the daemon path (iapeer-memory ask)', () => {
  test('a CLI send to a wake_policy:ephemeral peer ENQUEUES (queued ack), no live/miss bypass', async () => {
    // an ephemeral worker cwd (profile declares wake_policy) registered in the index
    const cwd = mkdtempSync(join(tmpdir(), 'iapeer-cli-eph-'))
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      join(cwd, '.iapeer', 'peer-profile.json'),
      JSON.stringify({ personality: 'ephw', runtime: 'claude', runtimes: ['claude'], intelligence: 'artificial', wake_policy: 'ephemeral' }),
    )
    const e = env()
    // routeSend resolves the peers index from the PROCESS env (transport reads
    // readPeersIndex() bare) — point the process-level root at the sandbox too.
    const prevRoot = process.env.IAPEER_ROOT
    process.env.IAPEER_ROOT = root
    try {
      await upsertPeer({ personality: 'ephw', runtime: 'claude', cwd, intelligence: 'artificial' }, { rootDir: root })
      await register('sender')
      const r = await sendMessage({ from: 'claude-sender', target: 'ephw', message: 'task', env: e })
      expect(r.queued).toBe(true) // serialized via the disk FIFO, exactly like the daemon path
      expect(r.queueDepth).toBe(1)
      // the task is durably on disk for the daemon tick to drain
      const qdir = join(loadLifecycleConfig(e).stateDir, 'claude-ephw.queue')
      expect(existsSync(qdir)).toBe(true)
    } finally {
      if (prevRoot !== undefined) process.env.IAPEER_ROOT = prevRoot
      else delete process.env.IAPEER_ROOT
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('--help/-h global intercept (CLI hygiene — usage printed, NOTHING executed)', () => {
  let captured: string
  let origWrite: typeof process.stdout.write
  beforeEach(() => {
    captured = ''
    origWrite = process.stdout.write
    process.stdout.write = ((s: string | Uint8Array) => {
      captured += typeof s === 'string' ? s : Buffer.from(s).toString('utf8')
      return true
    }) as typeof process.stdout.write
  })
  afterEach(() => {
    process.stdout.write = origWrite
  })

  test('every verb with --help prints usage to stdout and exits 0', async () => {
    // The full verb surface — including verbs with REAL side effects (onboard ran on
    // prod swallowing --help; stop would set a durable flag; remove would delete).
    const verbs = [
      'onboard', 'install', 'update', 'rollback', 'version', 'daemon', 'status', 'live-runtime',
      'install-runtime', 'init', 'create', 'list', 'stop', 'start', 'remove', 'send',
      'enable', 'attach', 'interrupt', 'compact', 'self-fresh', 'native-memory', 'run-infra',
    ]
    for (const v of verbs) {
      captured = ''
      const code = await runCli([v, '--help'], env())
      expect({ verb: v, code }).toEqual({ verb: v, code: 0 })
      expect(captured).toContain('usage: iapeer')
    }
  })
  test('-h works like --help, anywhere on the line', async () => {
    expect(await runCli(['stop', 'somebody', '-h'], env())).toBe(0)
    expect(captured).toContain('usage: iapeer')
  })
  test('bare `iapeer --help` / `-h` / `help` print usage', async () => {
    for (const a of [['--help'], ['-h'], ['help']]) {
      captured = ''
      expect(await runCli(a, env())).toBe(0)
      expect(captured).toContain('usage: iapeer')
    }
  })
  test('--help does NOT execute the verb: `stop <peer> --help` leaves no durable stop flag', async () => {
    await register('helpcheck')
    const e = env()
    expect(await runCli(['stop', 'helpcheck', '--help'], e)).toBe(0)
    expect(isStopped(loadLifecycleConfig(e), 'claude-helpcheck')).toBe(false)
  })
  test('--help does NOT execute the verb: `remove <peer> --help` keeps the registry record', async () => {
    await register('keepme')
    const e = env()
    expect(await runCli(['remove', 'keepme', '--help'], e)).toBe(0)
    expect(findPeer(readPeersIndex({ env: e }), 'keepme')).not.toBeNull()
  })
  test('version --help shows usage, not the version number', async () => {
    expect(await runCli(['version', '--help'], env())).toBe(0)
    expect(captured).toContain('usage: iapeer')
    expect(captured.trim().split('\n').length).toBeGreaterThan(3) // usage, not a bare semver line
  })
  test('a literal "--help" value stays expressible via --key=--help (not intercepted)', () => {
    expect(parseArgs(['boris', '--message=--help']).flags.message).toBe('--help')
  })
})

describe('parseArgs (audit #27 — value beginning with --)', () => {
  test('--key=value preserves a value that starts with --', () => {
    expect(parseArgs(['send', 'boris', '--message=--look', '--topic=re: x']).flags).toMatchObject({
      message: '--look',
      topic: 're: x',
    })
  })
  test('look-ahead --key value still works; a following --flag is not consumed as a value', () => {
    const { flags, positionals } = parseArgs(['send', 'boris', '--message', 'hi', '--json'])
    expect(positionals).toEqual(['send', 'boris'])
    expect(flags.message).toBe('hi')
    expect(flags.json).toBe(true)
  })
  test('empty value via = stays a string, not true', () => {
    expect(parseArgs(['x', '--description=']).flags.description).toBe('')
  })
})

// ─── new — the UNCONDITIONAL fresh-restart control (docs/Control-команды §new) ─

describe('new (unconditional fresh restart)', () => {
  test('happy path: fresh-slate (un-park + stale markers cleared) → fresh wake with resume:false task:"" → action fresh', async () => {
    await register('alpha')
    const e = env()
    const cfg = loadLifecycleConfig(e)
    // a parked peer with stale markers — /new must override ALL of it
    setStopped(cfg, 'claude-alpha')
    setIdleReaped(cfg, 'claude-alpha')
    const calls: Array<{ personality: string; runtime: string; task: string; resume: boolean }> = []
    const o = await newPeer('alpha', undefined, {
      env: e,
      wakeFn: async args => {
        calls.push(args)
        return { status: 'READY', woke: true, runtime: args.runtime, process_address: `${args.runtime}-${args.personality}`, taskDelivered: true }
      },
    })
    expect(o.action).toBe('fresh')
    expect(o.runtime).toBe('claude')
    expect(calls).toEqual([{ personality: 'alpha', runtime: 'claude', task: '', resume: false }])
    expect(isStopped(cfg, 'claude-alpha')).toBe(false) // un-parked: /new outranks the C1 stop
    expect(hasIdleReaped(cfg, 'claude-alpha')).toBe(false) // stale marker cleared
  })

  test('wake FAILED → action failed with the reason (exit-1 contract for the bot)', async () => {
    await register('beta2')
    const o = await newPeer('beta2', undefined, {
      env: env(),
      wakeFn: async () => ({ status: 'FAILED', woke: false, reason: 'boot hang' }),
    })
    expect(o.action).toBe('failed')
    expect(o.reason).toBe('boot hang')
  })

  test('refusals are explicit: foreign launchd / infra runtime / undeclared runtime / unknown peer', async () => {
    const e = env()
    // foreign PP plist → fleet guard
    await register('boris')
    writeFileSync(launchdPlistPath('boris', e), '<?xml version="1.0"?>\n<plist><dict><key>Label</key><string>com.iapeer.boris</string></dict></plist>\n')
    expect((await newPeer('boris', undefined, { env: e })).action).toBe('refused-foreign-launchd')
    // infra runtime → launchd-held, kickstart hint
    await register('tg', 'telegram', 'natural')
    const infra = await newPeer('tg', undefined, { env: e })
    expect(infra.action).toBe('refused-infra')
    expect(infra.reason).toContain('kickstart')
    // undeclared runtime → explicit refusal, no silent launch
    await register('gamma2')
    expect((await newPeer('gamma2', 'codex', { env: e })).action).toBe('refused-undeclared-runtime')
    // unknown peer → throws (same contract as stop/start)
    await expect(newPeer('ghost-nobody', undefined, { env: e })).rejects.toThrow('not registered')
  })
})

// ─── compact-resume — control addresses the dialogue, not just a live session ──

describe('compact (resume sleeping dialogue)', () => {
  test('clean idle-reaped asleep peer → explicit resume wake, then /compact control', async () => {
    await register('sleepy', 'codex')
    const e = env()
    const cfg = loadLifecycleConfig(e)
    setIdleReaped(cfg, 'codex-sleepy')
    const wakeCalls: unknown[] = []
    const controlCalls: unknown[] = []
    const doneCalls: unknown[] = []
    const o = await compactPeer('sleepy', 'codex', {
      env: e,
      wakeFn: async args => {
        wakeCalls.push(args)
        return { status: 'READY', woke: true, runtime: args.runtime, process_address: `${args.runtime}-${args.personality}`, taskDelivered: true }
      },
      controlFn: async (personality, runtime, command) => {
        controlCalls.push({ personality, runtime, command })
        return ok({ ok: true, controlled: { personality, runtime: runtime! }, command: command.name, ts: 't' })
      },
      compactDoneFn: (target, cwd, baseline) => {
        doneCalls.push({ target, cwd, runtime: baseline.runtime })
        return ok({ ok: true, ms: 42, signal: 'transcript+ready' })
      },
    })
    expect(o).toMatchObject({ action: 'compacted', runtime: 'codex', woke: true })
    expect(wakeCalls).toEqual([{ personality: 'sleepy', runtime: 'codex', task: '', resume: true }])
    expect(controlCalls).toEqual([{ personality: 'sleepy', runtime: 'codex', command: { name: 'compact' } }])
    expect(doneCalls).toHaveLength(1)
    expect(doneCalls[0]).toMatchObject({ cwd: '/tmp/sleepy', runtime: 'codex', target: { runtime: 'codex', personality: 'sleepy' } })
    expect(hasIdleReaped(cfg, 'codex-sleepy')).toBe(false)
  })

  test('compact done gate failure surfaces as failed (no false success)', async () => {
    await register('slow', 'codex')
    const e = env()
    const cfg = loadLifecycleConfig(e)
    setIdleReaped(cfg, 'codex-slow')
    const o = await compactPeer('slow', 'codex', {
      env: e,
      wakeFn: async args => ({ status: 'READY', woke: true, runtime: args.runtime, process_address: `${args.runtime}-${args.personality}`, taskDelivered: true }),
      controlFn: async (personality, runtime, command) => ok({ ok: true, controlled: { personality, runtime: runtime! }, command: command.name, ts: 't' }),
      compactDoneFn: () => err('compact did not complete within test'),
    })
    expect(o.action).toBe('failed')
    expect(o.reason).toContain('did not complete')
  })

  test('crashed / first-wake asleep peer (no clean idle marker) → nothing-to-compact, no fresh wake', async () => {
    await register('freshy', 'codex')
    let woke = false
    const o = await compactPeer('freshy', 'codex', {
      env: env(),
      wakeFn: async () => ((woke = true), { status: 'READY', woke: true }),
    })
    expect(o.action).toBe('nothing-to-compact')
    expect(o.reason).toContain('nothing to compact')
    expect(woke).toBe(false)
  })

  test('idle marker but no transcript/session to resume → nothing-to-compact (not fresh)', async () => {
    await register('empty', 'codex')
    const e = env()
    setIdleReaped(loadLifecycleConfig(e), 'codex-empty')
    const o = await compactPeer('empty', 'codex', {
      env: e,
      wakeFn: async args => ({ status: 'FAILED', woke: false, runtime: args.runtime, reason: 'no codex session to resume' }),
    })
    expect(o.action).toBe('nothing-to-compact')
    expect(o.reason).toContain('nothing to compact')
  })
})

// ─── add-runtime / default-runtime — the fleet-switch levers (codex-parity) ───

describe('add-runtime / default-runtime (fleet-switch levers)', () => {
  test('add-runtime merges the runtime into profile+registry; idempotent; infra peers skipped', async () => {
    const e = env()
    // a claude-only peer with a REAL cwd (initPeer scaffolds it)
    const cwd = join(root, 'peers', 'aud1')
    mkdirSync(cwd, { recursive: true })
    await upsertPeer({ personality: 'aud1', runtime: 'claude', cwd, intelligence: 'artificial' }, { rootDir: root })
    const { initPeer } = await import('../init/index.ts')
    await initPeer({ cwd, runtime: 'claude', env: e }) // give it a local profile (claude-only)
    // an infra peer in the registry — must be skipped by --all
    await register('tginfra', 'telegram', 'natural')
    const outcomes = await addRuntime('codex', { all: true, env: e })
    const aud1 = outcomes.find(o => o.personality === 'aud1')!
    expect(aud1.action).toBe('added')
    expect(outcomes.find(o => o.personality === 'tginfra')!.action).toBe('skipped-infra-peer')
    // profile + registry both carry codex now; default untouched
    const { readPeerProfile } = await import('../identity/index.ts')
    const prof = readPeerProfile(cwd)!
    expect(prof.runtimes).toContain('codex')
    expect(prof.runtime).toBe('claude') // default_runtime NOT flipped
    const rec = findPeer(readPeersIndex({ env: e }), 'aud1')!
    expect(rec.runtimes).toContain('codex')
    expect(rec.runtime).toBe('claude') // registry default NOT flipped (capability ≠ routing; live-caught: upsert's «args.runtime wins» needed the reindex heal)
    // idempotent
    expect((await addRuntime('codex', { peer: 'aud1', env: e }))[0].action).toBe('already')
  })

  test('add-runtime works from INSIDE another peer session (poisoned PEER_* env) — live-caught 12.06', async () => {
    const e = env()
    e.PEER_PERSONALITY = 'iapeer' // the caller's own identity must not poison the target's init
    e.PEER_RUNTIME = 'claude'
    e.PEER_IDENTITY = 'claude-iapeer'
    const cwd = join(root, 'peers', 'aud3')
    mkdirSync(cwd, { recursive: true })
    await upsertPeer({ personality: 'aud3', runtime: 'claude', cwd, intelligence: 'artificial' }, { rootDir: root })
    const { initPeer } = await import('../init/index.ts')
    const cleanE = { ...e }
    delete cleanE.PEER_PERSONALITY; delete cleanE.PEER_RUNTIME; delete cleanE.PEER_IDENTITY
    await initPeer({ cwd, runtime: 'claude', env: cleanE })
    const outcomes = await addRuntime('codex', { peer: 'aud3', env: e })
    expect(outcomes[0].action).toBe('added')
  })

  test('add-runtime refuses an infra runtime as the argument', async () => {
    await register('x1')
    await expect(addRuntime('telegram', { peer: 'x1', env: env() })).rejects.toThrow('infra runtime')
  })

  test('default-runtime flips the primary (profile + registry in one command); refuses undeclared; symmetric back', async () => {
    const e = env()
    const cwd = join(root, 'peers', 'aud2')
    mkdirSync(cwd, { recursive: true })
    await upsertPeer({ personality: 'aud2', runtime: 'claude', cwd, intelligence: 'artificial' }, { rootDir: root })
    const { initPeer } = await import('../init/index.ts')
    await initPeer({ cwd, runtime: 'claude', env: e })
    // undeclared codex → explicit refusal with the add-runtime hint
    const refused = await defaultRuntime('codex', { peer: 'aud2', env: e })
    expect(refused[0].action).toBe('refused-undeclared-runtime')
    expect(refused[0].detail).toContain('add-runtime')
    // declare codex, then flip
    await addRuntime('codex', { peer: 'aud2', env: e })
    expect((await defaultRuntime('codex', { peer: 'aud2', env: e }))[0].action).toBe('flipped')
    const { readPeerProfile } = await import('../identity/index.ts')
    expect(readPeerProfile(cwd)!.runtime).toBe('codex')
    expect(readPeerProfile(cwd)!.runtimes[0]).toBe('codex') // normalizeRuntimes prepends the default
    expect(findPeer(readPeersIndex({ env: e }), 'aud2')!.runtime).toBe('codex') // registry healed same-command
    // idempotent + symmetric revert
    expect((await defaultRuntime('codex', { peer: 'aud2', env: e }))[0].action).toBe('already')
    expect((await defaultRuntime('claude', { peer: 'aud2', env: e }))[0].action).toBe('flipped')
    expect(findPeer(readPeersIndex({ env: e }), 'aud2')!.runtime).toBe('claude')
  })
})

describe('init — FU5 parity with create: declares ALL installed agentic runtimes', () => {
  // Regression (Arthur clean-machine, 19.06): `iapeer init` on a both-installed host
  // declared the peer claude-ONLY → `iapeer codex` failed "runtime not declared" because
  // the launch dispatch reads the registry record, which init had populated with the
  // primary only. init now mirrors create's secondary-add. Sandbox makes both runtimes
  // read as installed; CODEX_HOME→temp keeps the codex birth chain (host-wide config.toml)
  // hermetic.
  function initEnv(): NodeJS.ProcessEnv {
    return { ...env(), CODEX_HOME: join(root, 'codex-home') }
  }
  test('no marker, both installed → registry runtimes = [claude, codex], default claude (capability add never flips)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'iapeer-init-fu5-'))
    try {
      expect(await runCli(['init', cwd, '--no-bootstrap'], initEnv())).toBe(0)
      const peers = readPeersIndex({ env: env() }).peers
      expect(peers.length).toBe(1)
      expect([...peers[0].runtimes].sort()).toEqual(['claude', 'codex'])
      expect(peers[0].runtime).toBe('claude')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
  test('--runtime codex → default codex, runtimes still [claude, codex] (default is one OF the runtimes)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'iapeer-init-fu5b-'))
    try {
      expect(await runCli(['init', cwd, '--runtime', 'codex', '--no-bootstrap'], initEnv())).toBe(0)
      const peers = readPeersIndex({ env: env() }).peers
      expect(peers.length).toBe(1)
      expect([...peers[0].runtimes].sort()).toEqual(['claude', 'codex'])
      expect(peers[0].runtime).toBe('codex')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('rename (full folder rename — personality = folder name, history moves)', () => {
  async function seedWithProfile(personality: string): Promise<string> {
    const cwd = join(root, personality)
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      join(cwd, '.iapeer', 'peer-profile.json'),
      JSON.stringify({ personality, default_runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial' }),
    )
    await upsertPeer({ personality, runtime: 'claude', cwd, intelligence: 'artificial' }, { rootDir: root })
    return cwd
  }

  test('moves the folder + registry cwd + profile personality (personality = new folder name)', async () => {
    const oldCwd = await seedWithProfile('old-name')
    const newCwd = join(root, 'new-name')
    const e = env()
    const o = await renamePeerCli('old-name', 'new-name', { env: e, claudeProjectsDir: join(root, 'fake-projects') })
    expect(o.action).toBe('renamed')
    expect(o.oldCwd).toBe(oldCwd)
    expect(o.newCwd).toBe(newCwd)
    expect(existsSync(oldCwd)).toBe(false) // old folder gone
    expect(existsSync(join(newCwd, '.iapeer', 'peer-profile.json'))).toBe(true) // folder (profile) moved
    expect(findPeer(readPeersIndex({ env: e }), 'old-name')).toBeNull()
    const rec = findPeer(readPeersIndex({ env: e }), 'new-name')
    expect(rec?.cwd).toBe(newCwd) // registry cwd updated
    expect(JSON.parse(readFileSync(join(newCwd, '.iapeer', 'peer-profile.json'), 'utf8')).personality).toBe('new-name')
  })

  test('moves the claude transcript slug dir (history preserved) via the projectsDir seam', async () => {
    const oldCwd = await seedWithProfile('tx-old')
    const newCwd = join(root, 'tx-new')
    const projectsDir = join(root, 'fake-projects')
    const oldSlug = transcriptSlug(oldCwd)
    mkdirSync(join(projectsDir, oldSlug), { recursive: true })
    writeFileSync(join(projectsDir, oldSlug, 's.jsonl'), '{"type":"x"}\n')
    const o = await renamePeerCli('tx-old', 'tx-new', { env: env(), claudeProjectsDir: projectsDir })
    expect(o.action).toBe('renamed')
    expect(o.transcriptMoved).toBe(true)
    const newSlug = transcriptSlug(newCwd)
    expect(existsSync(join(projectsDir, oldSlug))).toBe(false) // old slug dir gone
    expect(existsSync(join(projectsDir, newSlug, 's.jsonl'))).toBe(true) // transcript at the new slug
  })

  test('refuses when the target folder already exists (no clobber, source untouched)', async () => {
    await seedWithProfile('src-peer')
    mkdirSync(join(root, 'dst-peer'), { recursive: true }) // target folder pre-exists
    const o = await renamePeerCli('src-peer', 'dst-peer', { env: env(), claudeProjectsDir: join(root, 'fp') })
    expect(o.action).toBe('target-cwd-exists')
    expect(existsSync(join(root, 'src-peer'))).toBe(true) // source folder untouched
    expect(findPeer(readPeersIndex({ env: env() }), 'src-peer')).not.toBeNull()
  })

  test('absent old peer → no-op outcome (not an error)', async () => {
    expect((await renamePeerCli('ghost', 'whatever', { env: env() })).action).toBe('absent')
  })

  test('target personality already registered → refused (no clobber)', async () => {
    await seedWithProfile('a')
    await seedWithProfile('b')
    const o = await renamePeerCli('a', 'b', { env: env(), claudeProjectsDir: join(root, 'fp') })
    expect(o.action).toBe('target-exists')
    expect(findPeer(readPeersIndex({ env: env() }), 'a')).not.toBeNull()
    expect(findPeer(readPeersIndex({ env: env() }), 'b')).not.toBeNull()
  })

  test('runCli rename wires through (exit 0, folder + registry cwd moved)', async () => {
    await seedWithProfile('cli-old')
    expect(await runCli(['rename', 'cli-old', 'cli-new'], env())).toBe(0)
    expect(existsSync(join(root, 'cli-old'))).toBe(false)
    expect(findPeer(readPeersIndex({ env: env() }), 'cli-new')?.cwd).toBe(join(root, 'cli-new'))
  })

  test('runCli rename missing args → usage error (exit 2)', async () => {
    expect(await runCli(['rename', 'only-one'], env())).toBe(2)
  })
})
