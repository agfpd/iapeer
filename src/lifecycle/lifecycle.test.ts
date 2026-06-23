import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { defaultRunDir, pidPath } from '../supervisor/paths.ts'
import {
  attachPeer,
  classifyGoneSession,
  clearEphemeralArmed,
  clearNewEager,
  clearStopped,
  composeFirstMessage,
  countRecentDeaths,
  folderLaunch,
  hasEphemeralArmed,
  hasIdleReaped,
  hasNewEager,
  isEphemeralPeer,
  isLaunchdManaged,
  isStopped,
  lastActiveRuntime,
  resolvePeerRuntime,
  loadLifecycleConfig,
  readDeaths,
  readTopic,
  readTopics,
  hasTopic,
  resetTopics,
  recordDeath,
  resolveWakeMode,
  resolveWakeRuntime,
  hasFreshNext,
  setFreshNext,
  setEphemeralArmed,
  setIdleReaped,
  setNewEager,
  setStopped,
  superviseTick,
  wakeOrSpawn,
  withWakeLock,
  addTopic,
  type LifecycleConfig,
} from './index.ts'
import { spawnSync } from 'child_process'
import { upsertPeer, type PeerRecord } from '../registry/index.ts'

function peer(over: Partial<PeerRecord>): PeerRecord {
  return {
    personality: 'p',
    runtime: 'claude',
    runtimes: ['claude'],
    description: '',
    intelligence: 'artificial',
    cwd: '/tmp/p',
    ...over,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// H5 — resolveWakeRuntime (registry-based, no live-socket scan)
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveWakeRuntime (H5)', () => {
  test('explicit declared caller runtime wins', () => {
    const r = resolveWakeRuntime('codex', peer({ runtimes: ['claude', 'codex'] }))
    expect(r.ok && r.value).toBe('codex')
  })

  test('explicit UNDECLARED caller runtime → fail-loud (no silent claude)', () => {
    const r = resolveWakeRuntime('codex', peer({ runtime: 'claude', runtimes: ['claude'] }))
    expect(r.ok).toBe(false)
  })

  test('no caller runtime → peer.runtime (registry default)', () => {
    const r = resolveWakeRuntime(undefined, peer({ runtime: 'codex', runtimes: ['codex', 'claude'] }))
    expect(r.ok && r.value).toBe('codex')
  })

  test('no caller runtime, no peer.runtime → first of runtimes[]', () => {
    const r = resolveWakeRuntime(undefined, peer({ runtime: '' as never, runtimes: ['codex'] }))
    expect(r.ok && r.value).toBe('codex')
  })

  test('nothing to pick → fail-loud', () => {
    const r = resolveWakeRuntime(undefined, peer({ runtime: '' as never, runtimes: [] }))
    expect(r.ok).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// H4 — isLaunchdManaged on the LIVE fleet (read-only)
// ─────────────────────────────────────────────────────────────────────────────

describe('isLaunchdManaged (H4 detector)', () => {
  // HERMETIC: point the detector at a TEMP LaunchAgents dir (IAPEER_LAUNCHAGENTS_DIR),
  // never the live ~/Library/LaunchAgents — so the test fires identically on CI and any
  // host, not just one where the timer peer happens to be installed.
  let laDir: string
  beforeEach(() => {
    laDir = mkdtempSync(join(tmpdir(), 'iapeer-h4-'))
  })
  afterEach(() => {
    rmSync(laDir, { recursive: true, force: true })
  })

  test('a com.iapeer.<p>.plist present in the LaunchAgents dir → true (read-only managed)', () => {
    writeFileSync(join(laDir, 'com.iapeer.timer.plist'), '')
    expect(isLaunchdManaged('timer', { IAPEER_LAUNCHAGENTS_DIR: laDir } as NodeJS.ProcessEnv)).toBe(true)
  })

  test('no plist in the dir → false (daemon-owned, not launchd-managed)', () => {
    expect(isLaunchdManaged('iapeer-throwaway-no-plist-xyz', { IAPEER_LAUNCHAGENTS_DIR: laDir } as NodeJS.ProcessEnv)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// withWakeLock — serializes per identity (concurrent = one at a time)
// ─────────────────────────────────────────────────────────────────────────────

describe('withWakeLock', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'iapeer-wakelock-'))
  })
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  const cfg = (): LifecycleConfig =>
    ({
      claudeBin: 'claude',
      codexBin: 'codex',
      sockDir: '/tmp',
      stateDir,
      logDir: stateDir,
      bootDeadlineSecs: 1,
      readyGateSecs: 1,
      idleSecs: 1,
    }) as LifecycleConfig

  test('two concurrent locks on the same identity run strictly serialized', async () => {
    const order: string[] = []
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const p1 = withWakeLock(cfg(), 'claude-x', async () => {
      order.push('1-start')
      await sleep(150)
      order.push('1-end')
    })
    // ensure p1 grabs the lock first
    await sleep(20)
    const p2 = withWakeLock(cfg(), 'claude-x', async () => {
      order.push('2-start')
      order.push('2-end')
    })
    await Promise.all([p1, p2])
    expect(order).toEqual(['1-start', '1-end', '2-start', '2-end'])
  })

  test('locks on DIFFERENT identities do not block each other', async () => {
    const order: string[] = []
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const a = withWakeLock(cfg(), 'claude-a', async () => {
      order.push('a-start')
      await sleep(120)
      order.push('a-end')
    })
    await sleep(20)
    const b = withWakeLock(cfg(), 'claude-b', async () => {
      order.push('b-start') // must interleave — different lock
    })
    await Promise.all([a, b])
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('a-end'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// superviseTick — H4 guard FIRST (safe: temp LaunchAgents dir, no real fleet)
// ─────────────────────────────────────────────────────────────────────────────

describe('superviseTick H4 guard', () => {
  let stateDir: string
  let laDir: string
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'iapeer-sup-state-'))
    laDir = mkdtempSync(join(tmpdir(), 'iapeer-sup-la-'))
  })
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(laDir, { recursive: true, force: true })
  })

  const cfg = (): LifecycleConfig =>
    ({
      claudeBin: 'claude',
      codexBin: 'codex',
      sockDir: '/tmp',
      stateDir,
      logDir: stateDir,
      eventLogDir: stateDir, // isolate the decision log into the temp dir (no real-root leak)
      bootDeadlineSecs: 1,
      readyGateSecs: 1,
      idleSecs: 1,
    }) as LifecycleConfig

  function writeState(personality: string): string {
    const identity = `claude-${personality}`
    writeFileSync(
      join(stateDir, `${identity}.session`),
      JSON.stringify({ identity, runtime: 'claude', personality, cwd: '/tmp/none', wokeAt: 0 }),
    )
    return identity
  }
  const env = () => ({ ...process.env, IAPEER_LAUNCHAGENTS_DIR: laDir })

  test('a launchd-managed peer (plist present) is SKIPPED first — never reaped', () => {
    // a fake plist in the TEMP LaunchAgents dir (real ~/Library is untouched)
    writeFileSync(join(laDir, 'com.iapeer.iapeer-fakelaunchd.plist'), '')
    const id = writeState('iapeer-fakelaunchd')
    const out = superviseTick(cfg(), { env: env(), nowMs: Date.now() })
    const o = out.find(x => x.identity === id)
    expect(o?.action).toBe('skipped-launchd')
    // read-only: its session-state is NOT removed
    expect(existsSync(join(stateDir, `${id}.session`))).toBe(true)
  })

  test('a STOPPED peer with a dead session → skipped-stopped: no death record, park marker ensured', () => {
    // boris repro (10.06): `iapeer stop` → next tick used to tag reaped-gone
    // death=server-dead + recordDeath → post-start wake came up FRESH. A deliberate
    // stop is a clean park the daemon knows 100% — never a death.
    const c = cfg()
    const id = writeState('iapeer-supstopped')
    setStopped(c, id)
    const out = superviseTick(c, { env: env(), nowMs: Date.now() })
    const o = out.find(x => x.identity === id)
    expect(o?.action).toBe('skipped-stopped')
    expect(existsSync(join(stateDir, `${id}.session`))).toBe(false) // state dropped quietly
    expect(readDeaths(c, id).length).toBe(0) // NOT a death — crash-loop ring untouched
    expect(hasIdleReaped(c, id)).toBe(true) // clean park → post-start wake resumes
    const logged = readFileSync(join(c.eventLogDir, 'lifecycle.log'), 'utf8')
    expect(logged).toContain(`identity=${id} action=skipped-stopped`)
    expect(logged).not.toContain('death=') // no death class for a deliberate stop
  })

  test('a no-plist peer with a dead session → reaped-gone, state removed', () => {
    const c = cfg()
    const id = writeState('iapeer-supgone') // no plist, no live tmux session
    const out = superviseTick(c, { env: env(), nowMs: Date.now() })
    const o = out.find(x => x.identity === id)
    expect(o?.action).toBe('reaped-gone')
    expect(existsSync(join(stateDir, `${id}.session`))).toBe(false)
    // the decision leaves a DURABLE trace line (the observability contract) — and it
    // lands in the SANDBOXED eventLogDir, never the real ~/.iapeer.
    const logged = readFileSync(join(c.eventLogDir, 'lifecycle.log'), 'utf8')
    expect(logged).toContain(`ev=supervise identity=${id} action=reaped-gone`)
    expect(logged).toContain('outcome=fresh-next-msg')
    // death-class tag: no socket file at all in this sandbox → the server is gone
    expect(logged).toContain('death=server-dead')
  })

  test('empty state dir → no outcomes', () => {
    expect(superviseTick(cfg(), { env: env() })).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// superviseTick — per-peer ISOLATION (one throwing peer must not abort the sweep)
// ─────────────────────────────────────────────────────────────────────────────

describe('superviseTick per-peer isolation', () => {
  let stateDir: string
  let laDir: string
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'iapeer-sup-iso-state-'))
    laDir = mkdtempSync(join(tmpdir(), 'iapeer-sup-iso-la-'))
  })
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(laDir, { recursive: true, force: true })
  })
  const cfg = (): LifecycleConfig =>
    ({
      claudeBin: 'claude',
      codexBin: 'codex',
      sockDir: '/tmp',
      stateDir,
      logDir: stateDir,
      eventLogDir: stateDir,
      bootDeadlineSecs: 1,
      readyGateSecs: 1,
      idleSecs: 1,
    }) as LifecycleConfig
  function writeState(personality: string): string {
    const identity = `claude-${personality}`
    writeFileSync(
      join(stateDir, `${identity}.session`),
      JSON.stringify({ identity, runtime: 'claude', personality, cwd: '/tmp/none', wokeAt: 0 }),
    )
    return identity
  }
  const env = () => ({ ...process.env, IAPEER_LAUNCHAGENTS_DIR: laDir })

  test('a peer whose evaluation THROWS is isolated (skipped-error, logged loudly) — the rest are still swept', () => {
    // The fleet-wide-reap-outage class: before per-peer isolation, ONE peer whose evaluation threw
    // aborted the ENTIRE sweep (and the daemon timer swallowed the error → no reap for ANYONE, silently
    // for hours). Now the throw is caught per-peer: the bad peer becomes skipped-error and the sweep
    // continues. Order-independent (readdirSync order is unspecified) — we assert on identities.
    const c = cfg()
    const bad = writeState('iapeer-isobad')
    const g1 = writeState('iapeer-isogone1')
    const g2 = writeState('iapeer-isogone2')
    const out = superviseTick(c, {
      env: env(),
      nowMs: Date.now(),
      // sessionAlive throws ONLY for the bad peer; the others read dead → reaped-gone.
      sessionAlive: (_sock, identity) => {
        if (identity === bad) throw new Error('synthetic per-peer fault')
        return false
      },
    })
    const byId = (id: string) => out.find(x => x.identity === id)
    expect(byId(bad)?.action).toBe('skipped-error')
    expect(byId(bad)?.reason).toContain('synthetic per-peer fault')
    // the OTHER peers were STILL processed — the sweep did not abort on the bad one
    expect(byId(g1)?.action).toBe('reaped-gone')
    expect(byId(g2)?.action).toBe('reaped-gone')
    expect(out.length).toBe(3)
    // the isolated fault is LOUD in lifecycle.log (no longer silently swallowed)
    const logged = readFileSync(join(c.eventLogDir, 'lifecycle.log'), 'utf8')
    expect(logged).toContain(`identity=${bad} action=skipped-error`)
    expect(logged).toContain('outcome=peer-error-isolated')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// wakeOrSpawn H4 — REFUSES to wake a launchd-managed peer (no spawn at all)
// ─────────────────────────────────────────────────────────────────────────────

describe('wakeOrSpawn H4 refusal', () => {
  test('a launchd-managed peer is NOT woken (returns FAILED before any spawn)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-h4-root-'))
    const laDir = mkdtempSync(join(tmpdir(), 'iapeer-h4-la-'))
    try {
      // a registered peer that ALSO has a (fake) launchd plist → launchd domain
      writeFileSync(join(laDir, 'com.iapeer.iapeer-h4ld.plist'), '')
      await upsertPeer(
        { personality: 'iapeer-h4ld', runtime: 'claude', cwd: '/tmp/none', intelligence: 'artificial' },
        { rootDir: root },
      )
      const env = { ...process.env, IAPEER_ROOT: root, IAPEER_LAUNCHAGENTS_DIR: laDir }
      const r = await wakeOrSpawn({ personality: 'iapeer-h4ld', runtime: 'claude', task: 'must not spawn' }, { env })
      expect(r.status).toBe('FAILED')
      expect(r.woke).toBe(false)
      expect(r.reason).toMatch(/launchd-managed/)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// wakeOrSpawn live-session fast path — marks the caller's task as NOT delivered
// (the concurrent-sender envelope-loss seam: routeSend redelivers on this flag)
// ─────────────────────────────────────────────────────────────────────────────

describe('wakeOrSpawn live-session fast path', () => {
  test('READY with taskDelivered:false — the winning wake delivered only ITS envelope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-fpl-root-'))
    const laDir = mkdtempSync(join(tmpdir(), 'iapeer-fpl-la-')) // empty → not launchd-managed
    const prevRoot = process.env.IAPEER_ROOT
    const child = Bun.spawn(['sleep', '300']) // a live pid for the faked hosted session
    try {
      // pty-only: a live session = a live supervisor pid. hostSessionAlive reads the run dir from
      // process.env, so set IAPEER_ROOT for this test and drop a live pid there.
      process.env.IAPEER_ROOT = root
      await upsertPeer(
        { personality: 'fpl', runtime: 'claude', cwd: root, intelligence: 'artificial' },
        { rootDir: root },
      )
      // a live hosted session already up — what a WINNING concurrent wake leaves behind
      const runDir = defaultRunDir(process.env)
      mkdirSync(runDir, { recursive: true })
      writeFileSync(pidPath(runDir, 'claude-fpl'), String(child.pid))
      const env = { ...process.env, IAPEER_ROOT: root, IAPEER_LAUNCHAGENTS_DIR: laDir }
      const r = await wakeOrSpawn({ personality: 'fpl', runtime: 'claude', task: 'second sender envelope' }, { env })
      expect(r.status).toBe('READY')
      expect(r.woke).toBe(false)
      // the contract under test: the fast path NEVER delivers the caller's task
      expect(r.taskDelivered).toBe(false)
    } finally {
      child.kill()
      if (prevRoot === undefined) delete process.env.IAPEER_ROOT
      else process.env.IAPEER_ROOT = prevRoot
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C1 — durable stopped flag (stop/start; daemon refuses to wake a stopped peer)
// ─────────────────────────────────────────────────────────────────────────────

describe('C1 durable stopped flag', () => {
  test('isStopped/setStopped/clearStopped round-trip', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'iapeer-stopped-'))
    const cfg = { stateDir } as LifecycleConfig
    try {
      expect(isStopped(cfg, 'claude-x')).toBe(false)
      setStopped(cfg, 'claude-x')
      expect(isStopped(cfg, 'claude-x')).toBe(true)
      clearStopped(cfg, 'claude-x')
      expect(isStopped(cfg, 'claude-x')).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('wakeOrSpawn REFUSES a stopped peer (FAILED stopped:true, before any spawn)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-stp-root-'))
    const laDir = mkdtempSync(join(tmpdir(), 'iapeer-stp-la-')) // empty → not launchd-managed
    try {
      await upsertPeer(
        { personality: 'stp', runtime: 'claude', cwd: '/tmp/none', intelligence: 'artificial' },
        { rootDir: root },
      )
      const env = { ...process.env, IAPEER_ROOT: root, IAPEER_LAUNCHAGENTS_DIR: laDir }
      const cfg = loadLifecycleConfig(env)
      setStopped(cfg, 'claude-stp')
      const r = await wakeOrSpawn({ personality: 'stp', runtime: 'claude', task: 'must not wake' }, { env })
      expect(r.status).toBe('FAILED')
      expect(r.stopped).toBe(true)
      expect(r.reason).toMatch(/stopped/)
      // cleared → wakeable again (it will then FAIL later for the missing cwd, NOT stopped)
      clearStopped(cfg, 'claude-stp')
      const r2 = await wakeOrSpawn({ personality: 'stp', runtime: 'claude', task: 'x' }, { env })
      expect(r2.stopped).toBeFalsy()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 — initial_prompt launch-seed (composeFirstMessage)
// ─────────────────────────────────────────────────────────────────────────────

describe('C2 initial_prompt (composeFirstMessage)', () => {
  function withProfile(initial_prompt?: string): string {
    const cwd = mkdtempSync(join(tmpdir(), 'iapeer-seed-'))
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      join(cwd, '.iapeer', 'peer-profile.json'),
      JSON.stringify({
        personality: 'p',
        runtime: 'claude',
        runtimes: ['claude'],
        intelligence: 'artificial',
        ...(initial_prompt ? { initial_prompt } : {}),
      }),
    )
    return cwd
  }

  test('fresh wake + initial_prompt → seed THEN task (both, seed first)', () => {
    const cwd = withProfile('First, read STATE.md.')
    try {
      expect(composeFirstMessage(cwd, '<iap>msg</iap>', true)).toBe('First, read STATE.md.\n\n<iap>msg</iap>')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('resume (fresh=false) → task only, no seed', () => {
    const cwd = withProfile('First, read STATE.md.')
    try {
      expect(composeFirstMessage(cwd, 'TASK', false)).toBe('TASK')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('fresh wake, NO initial_prompt → task only', () => {
    const cwd = withProfile(undefined)
    try {
      expect(composeFirstMessage(cwd, 'TASK', true)).toBe('TASK')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('fresh with seed but EMPTY task (eager /new) → seed alone (no trailing)', () => {
    const cwd = withProfile('Report you are up.')
    try {
      expect(composeFirstMessage(cwd, '', true)).toBe('Report you are up.')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolveWakeMode — TARGET redesign (daemon decides fresh-vs-resume by DEATH CAUSE
// = .idle-reaped marker, plus peer-type/topic; NO agent-dropped fresh mark).
// ─────────────────────────────────────────────────────────────────────────────

/** A temp cwd with a peer-profile; interfaces.telegram present → human-conversational;
 *  ephemeral → wake_policy "ephemeral". */
function profileCwd(human: boolean, ephemeral = false): string {
  const cwd = mkdtempSync(join(tmpdir(), 'iapeer-wm-cwd-'))
  mkdirSync(join(cwd, '.iapeer'), { recursive: true })
  writeFileSync(
    join(cwd, '.iapeer', 'peer-profile.json'),
    JSON.stringify({
      personality: 'p',
      runtime: 'claude',
      runtimes: ['claude'],
      intelligence: human ? 'natural' : 'artificial',
      ...(human ? { interfaces: { telegram: { user_id: 1 } } } : {}),
      ...(ephemeral ? { wake_policy: 'ephemeral' } : {}),
    }),
  )
  return cwd
}

describe('resolveWakeMode (TARGET: death-cause + peer-type/topic)', () => {
  let stateDir: string
  let cwds: string[]
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'iapeer-wakemode-'))
    cwds = []
  })
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
    for (const c of cwds) rmSync(c, { recursive: true, force: true })
  })
  const cfg = () => ({ stateDir } as LifecycleConfig)
  const cwd = (human = false, ephemeral = false) => {
    const c = profileCwd(human, ephemeral)
    cwds.push(c)
    return c
  }
  const hasTranscript = () => ({ ok: true, ref: 'uuid-1' })
  const noTranscript = () => ({ ok: false, reason: 'no transcript to resume' })

  // ── branch 1/2: explicit fresh / explicit resume (unchanged) ────────────────
  test('argsResume=false (folder-launch) → FRESH', () => {
    expect(resolveWakeMode(cfg(), 'claude-p', cwd(), false, hasTranscript)).toEqual({ resume: false, cause: 'folder-launch' })
  })
  test('argsResume=true (attach) + transcript → RESUME', () => {
    expect(resolveWakeMode(cfg(), 'claude-p', cwd(), true, hasTranscript)).toEqual({ resume: true, resumeRef: 'uuid-1', cause: 'attach' })
  })
  test('argsResume=true + nothing to resume → FAIL-LOUD (failReason, no silent fresh)', () => {
    const m = resolveWakeMode(cfg(), 'claude-p', cwd(), true, noTranscript)
    expect(m.resume).toBe(false)
    expect(m.failReason).toMatch(/nothing to resume|no transcript/)
  })

  // ── branch 3a: default + NOT idle-reaped → it died on its own → FRESH ────────
  test('DEFAULT + NOT idle-reaped (crash/self-close) → FRESH even when a transcript exists', () => {
    // INVERSION of the old polarity: absence of the daemon's idle-reaped marker = died
    // on its own = clean fresh, NOT a resume of a possibly-broken context.
    expect(resolveWakeMode(cfg(), 'claude-p', cwd(), undefined, hasTranscript)).toEqual({ resume: false, cause: 'crash-or-self-close' })
  })

  test('DEFAULT + NOT idle-reaped + NO transcript at all → FRESH with cause=first-wake (not a crash)', () => {
    // boris finding (10.06): the first-ever wake of a freshly created peer used to
    // read crash-or-self-close — a mis-classification. No transcript = never ran.
    expect(resolveWakeMode(cfg(), 'claude-p', cwd(), undefined, noTranscript)).toEqual({ resume: false, cause: 'first-wake' })
  })

  // ── stop→start is a CLEAN PARK (boris 10.06): the park marker → RESUME ────────
  test('stop→start path: clean-park marker set by stop + NO topic → FRESH (resume is opt-in via topic; fresh-after-stop is fine)', () => {
    const c = cfg()
    setIdleReaped(c, 'claude-p') // what the stop verb writes before killing (clean-park)
    expect(resolveWakeMode(c, 'claude-p', cwd(false), undefined, hasTranscript)).toEqual({ resume: false, cause: 'idle-reaped-no-topic' })
  })

  // ── branch 3b: default + idle-reaped → resume-eligible, CONSUME the marker ───
  test('DEFAULT + idle-reaped + human-conversational (interfaces.telegram) → RESUME, marker consumed', () => {
    const c = cfg()
    setIdleReaped(c, 'claude-p')
    const human = cwd(true)
    expect(resolveWakeMode(c, 'claude-p', human, undefined, hasTranscript)).toEqual({ resume: true, resumeRef: 'uuid-1', cause: 'idle-reaped-human' })
    expect(hasIdleReaped(c, 'claude-p')).toBe(false) // consumed
  })

  // ── soft-reload (`iapeer refresh`): LAZY fresh-on-next-wake, overrides resume for ALL peer types ──
  test('DEFAULT + .fresh-next OVERRIDES human-conversational RESUME → FRESH, BOTH markers consumed', () => {
    const c = cfg()
    setIdleReaped(c, 'claude-p') // clean-park: a telegram peer would otherwise RESUME (idle-reaped-human)
    setFreshNext(c, 'claude-p') // operator armed a soft-reload
    const human = cwd(true)
    expect(resolveWakeMode(c, 'claude-p', human, undefined, hasTranscript)).toEqual({ resume: false, cause: 'soft-reload' })
    expect(hasFreshNext(c, 'claude-p')).toBe(false) // consumed
    expect(hasIdleReaped(c, 'claude-p')).toBe(false) // ALSO consumed (ephemeral-hygiene: no stale park marker left to mis-read a later crash)
  })
  test('.fresh-next does NOT override an explicit attach (argsResume=true) → RESUME; soft-reload is lazy/natural only', () => {
    const c = cfg()
    setFreshNext(c, 'claude-p')
    expect(resolveWakeMode(c, 'claude-p', cwd(), true, hasTranscript)).toEqual({ resume: true, resumeRef: 'uuid-1', cause: 'attach' })
    expect(hasFreshNext(c, 'claude-p')).toBe(true) // NOT consumed — attach returns before the soft-reload branch
  })
  test('DEFAULT + idle-reaped + executor + NO incoming topic → FRESH (resume is opt-in via a matching topic)', () => {
    const c = cfg()
    setIdleReaped(c, 'claude-p')
    expect(resolveWakeMode(c, 'claude-p', cwd(false), undefined, hasTranscript)).toEqual({ resume: false, cause: 'idle-reaped-no-topic' })
    expect(hasIdleReaped(c, 'claude-p')).toBe(false) // marker consumed
  })
  test('DEFAULT + idle-reaped + executor + SAME topic → RESUME', () => {
    const c = cfg()
    setIdleReaped(c, 'claude-p')
    addTopic(c, 'claude-p', 'deploy')
    expect(resolveWakeMode(c, 'claude-p', cwd(false), undefined, hasTranscript, 'deploy')).toEqual({ resume: true, resumeRef: 'uuid-1', cause: 'idle-reaped-resume' })
  })
  test('DEFAULT + idle-reaped + executor + DIFFERENT topic → FRESH (new work), marker consumed', () => {
    const c = cfg()
    setIdleReaped(c, 'claude-p')
    addTopic(c, 'claude-p', 'deploy')
    expect(resolveWakeMode(c, 'claude-p', cwd(false), undefined, hasTranscript, 'unrelated-bug')).toEqual({ resume: false, cause: 'idle-reaped-new-topic' })
    expect(hasIdleReaped(c, 'claude-p')).toBe(false) // consumed even on the fresh executor branch
  })
  test('DEFAULT + idle-reaped + executor + topic from EARLIER in the set (not the last) → RESUME (multi-thread)', () => {
    const c = cfg()
    setIdleReaped(c, 'claude-p')
    addTopic(c, 'claude-p', 'thread-a')
    addTopic(c, 'claude-p', 'thread-b') // most-recent is now thread-b; thread-a still in the set
    // a later ping on the EARLIER thread (thread-a) continues that context, not a fresh session
    expect(resolveWakeMode(c, 'claude-p', cwd(false), undefined, hasTranscript, 'thread-a')).toEqual({ resume: true, resumeRef: 'uuid-1', cause: 'idle-reaped-resume' })
  })

  // ── M1: wake_policy "ephemeral" → ALWAYS fresh on delivery, overrides resume ──
  test('DEFAULT + ephemeral → FRESH (ephemeral-policy), even with a resumable transcript', () => {
    expect(resolveWakeMode(cfg(), 'claude-p', cwd(false, true), undefined, hasTranscript)).toEqual({ resume: false, cause: 'ephemeral-policy' })
  })
  test('DEFAULT + ephemeral + idle-reaped → FRESH (overrides idle-reaped-resume), marker consumed', () => {
    const c = cfg()
    setIdleReaped(c, 'claude-p')
    expect(resolveWakeMode(c, 'claude-p', cwd(false, true), undefined, hasTranscript)).toEqual({ resume: false, cause: 'ephemeral-policy' })
    expect(hasIdleReaped(c, 'claude-p')).toBe(false) // stray marker consumed
  })
  test('DEFAULT + ephemeral + telegram (human) → FRESH (ephemeral WINS over human type)', () => {
    const c = cfg()
    setIdleReaped(c, 'claude-p')
    expect(resolveWakeMode(c, 'claude-p', cwd(true, true), undefined, hasTranscript)).toEqual({ resume: false, cause: 'ephemeral-policy' })
  })
  test('ephemeral does NOT hijack explicit attach (argsResume=true still resumes)', () => {
    // attach is an operator action; ephemeral only governs the delivery path.
    expect(resolveWakeMode(cfg(), 'claude-p', cwd(false, true), true, hasTranscript)).toEqual({ resume: true, resumeRef: 'uuid-1', cause: 'attach' })
  })
})

describe('idle-reaped marker round-trip', () => {
  test('set/has/clear', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'iapeer-idlereap-'))
    const cfg = { stateDir } as LifecycleConfig
    try {
      expect(hasIdleReaped(cfg, 'claude-y')).toBe(false)
      setIdleReaped(cfg, 'claude-y')
      expect(hasIdleReaped(cfg, 'claude-y')).toBe(true)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

describe('new-eager marker round-trip', () => {
  test('set/has/clear', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'iapeer-neweager-'))
    const cfg = { stateDir } as LifecycleConfig
    try {
      expect(hasNewEager(cfg, 'claude-y')).toBe(false)
      setNewEager(cfg, 'claude-y')
      expect(hasNewEager(cfg, 'claude-y')).toBe(true)
      clearNewEager(cfg, 'claude-y')
      expect(hasNewEager(cfg, 'claude-y')).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// superviseTick — death-cause accounting (TARGET redesign)
//  • idle-reap is the ONLY place .idle-reaped is written
//  • a crash/self-close death writes NO marker (lazy fresh on next message)
//  • a dead session carrying .new-eager → needs-eager-fresh (mark LEFT for relaunch)
//  • every dead session records a death (crash-loop accounting)
// ─────────────────────────────────────────────────────────────────────────────

describe('superviseTick death-cause accounting (TARGET)', () => {
  function deadSessionEnv(personality: string): { env: NodeJS.ProcessEnv; cfg: LifecycleConfig; root: string; laDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-sup-tgt-root-'))
    const laDir = mkdtempSync(join(tmpdir(), 'iapeer-sup-tgt-la-')) // empty → not launchd-managed
    const env = { ...process.env, IAPEER_ROOT: root, IAPEER_LAUNCHAGENTS_DIR: laDir, IAPEER_SOCK_DIR: join(root, 'socks') }
    const cfg = loadLifecycleConfig(env)
    mkdirSync(cfg.stateDir, { recursive: true })
    writeFileSync(
      join(cfg.stateDir, `claude-${personality}.session`),
      JSON.stringify({ identity: `claude-${personality}`, runtime: 'claude', personality, cwd: `/tmp/${personality}`, wokeAt: Date.now() }),
    )
    return { env, cfg, root, laDir }
  }

  test('a DEAD session carrying .new-eager → needs-eager-fresh (mark LEFT for relaunch), death recorded', () => {
    const { env, cfg, root, laDir } = deadSessionEnv('z')
    try {
      setNewEager(cfg, 'claude-z')
      const out = superviseTick(cfg, { env })
      const o = out.find(x => x.identity === 'claude-z')
      expect(o?.action).toBe('needs-eager-fresh')
      expect(o?.personality).toBe('z')
      expect(o?.runtime).toBe('claude')
      // the eager mark is LEFT for processEagerRelaunches to consume
      expect(hasNewEager(cfg, 'claude-z')).toBe(true)
      // every dead session records a death for the crash-loop ring
      expect(readDeaths(cfg, 'claude-z').length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })

  test('eager relaunch does NOT pin the dead session runtime — re-resolves from the registry (H5 fleet-switch)', async () => {
    // Live incident 12.06: `default-runtime codex` + `self-fresh` resurrected the peer
    // on the OLD runtime — the relaunch passed the dead session's runtime EXPLICITLY,
    // so resolveWakeRuntime never consulted the just-flipped registry default.
    const { env, cfg, root, laDir } = deadSessionEnv('rt')
    try {
      setNewEager(cfg, 'claude-rt')
      const outcomes = superviseTick(cfg, { env })
      const o = outcomes.find(x => x.identity === 'claude-rt')
      expect(o?.action).toBe('needs-eager-fresh')
      const seen: Array<{ personality: string; runtime?: string; resume?: boolean; task: string }> = []
      const { processEagerRelaunches } = await import('./index.ts')
      await processEagerRelaunches(cfg, outcomes, {
        env,
        wakeFn: async args => {
          seen.push({ personality: args.personality, runtime: args.runtime, resume: args.resume, task: args.task })
          return { status: 'READY', woke: true }
        },
      })
      expect(seen.length).toBe(1)
      expect(seen[0].personality).toBe('rt')
      expect(seen[0].runtime).toBeUndefined() // ← the fix: wakeOrSpawn re-resolves from the registry
      expect(seen[0].resume).toBe(false)
      expect(seen[0].task).toBe('')
      // the mark was consumed by the relaunch
      expect(hasNewEager(cfg, 'claude-rt')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })

  test('a DEAD session with NO .new-eager → reaped-gone, NO .idle-reaped written (crash leaves no marker)', () => {
    const { env, cfg, root, laDir } = deadSessionEnv('w')
    try {
      const out = superviseTick(cfg, { env })
      expect(out.find(x => x.identity === 'claude-w')?.action).toBe('reaped-gone')
      // a crash/self-close is NOT daemon-initiated → no idle-reaped marker → next wake FRESH
      expect(hasIdleReaped(cfg, 'claude-w')).toBe(false)
      expect(readDeaths(cfg, 'claude-w').length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })

  test('a DEAD session clears a stale .ephemeral-armed (the mark dies with its session)', () => {
    // The mark armed on the dead session's outbound; were it to survive, the NEXT
    // session would be quiet-reap eligible BEFORE answering its own task.
    const { env, cfg, root, laDir } = deadSessionEnv('q')
    try {
      setEphemeralArmed(cfg, 'claude-q')
      const out = superviseTick(cfg, { env })
      expect(out.find(x => x.identity === 'claude-q')?.action).toBe('reaped-gone')
      expect(hasEphemeralArmed(cfg, 'claude-q')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// wake_policy:ephemeral M2 — armed marker + quiet-reap (die-after-reply)
// ─────────────────────────────────────────────────────────────────────────────

describe('ephemeral-armed marker + config', () => {
  test('set/has/clear round-trip; clear is idempotent', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'iapeer-eph-mark-'))
    const cfg = { stateDir } as LifecycleConfig
    try {
      expect(hasEphemeralArmed(cfg, 'claude-e')).toBe(false)
      setEphemeralArmed(cfg, 'claude-e')
      expect(hasEphemeralArmed(cfg, 'claude-e')).toBe(true)
      clearEphemeralArmed(cfg, 'claude-e')
      clearEphemeralArmed(cfg, 'claude-e') // idempotent
      expect(hasEphemeralArmed(cfg, 'claude-e')).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('ephemeralQuietSecs: default 20, env-tunable', () => {
    expect(loadLifecycleConfig({ HOME: '/tmp' } as NodeJS.ProcessEnv).ephemeralQuietSecs).toBe(20)
    expect(
      loadLifecycleConfig({ HOME: '/tmp', IAPEER_EPHEMERAL_QUIET_SECS: '45' } as NodeJS.ProcessEnv)
        .ephemeralQuietSecs,
    ).toBe(45)
  })

  test('isEphemeralPeer keys on the cwd profile; read hiccup → false (safe default)', () => {
    const eph = profileCwd(false, true)
    const plain = profileCwd(false, false)
    try {
      expect(isEphemeralPeer(eph)).toBe(true)
      expect(isEphemeralPeer(plain)).toBe(false)
      expect(isEphemeralPeer('/tmp/definitely-no-such-peer-cwd')).toBe(false)
    } finally {
      rmSync(eph, { recursive: true, force: true })
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ephemeral armed quiet-reap — pane-log render-liveness (the mid-turn-kill fix)
//  The transcript proxy goes QUIET during a long model generation (no JSONL write
//  until the message completes), so the 20s armed-quiet window used to reap a STILL-
//  WORKING armed session mid-turn (live incident: Index reaped age=29s while
//  generating after a tool_result). Folding the pane-log (TUI render-stream) mtime
//  into the activity proxy makes "quiet" = transcript AND pane-log both silent = the
//  turn truly ended — a working session is never killed, an idle one still reaps fast.
// ─────────────────────────────────────────────────────────────────────────────

describe('ephemeral armed quiet-reap — pane-log render-liveness', () => {
  function ephemeralLiveEnv(personality: string): {
    env: NodeJS.ProcessEnv
    cfg: LifecycleConfig
    root: string
    laDir: string
  } {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-eph-pl-root-'))
    const laDir = mkdtempSync(join(tmpdir(), 'iapeer-eph-pl-la-')) // empty → not launchd-managed
    const env = { ...process.env, IAPEER_ROOT: root, IAPEER_LAUNCHAGENTS_DIR: laDir, IAPEER_SOCK_DIR: join(root, 'socks') }
    const cfg = loadLifecycleConfig(env)
    mkdirSync(cfg.stateDir, { recursive: true })
    const cwd = join(root, 'peers', personality)
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      join(cwd, '.iapeer', 'peer-profile.json'),
      JSON.stringify({ personality, default_runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial', wake_policy: 'ephemeral' }),
    )
    // a LIVE session woken 10 min ago (so the wokeAt floor never masks the quiet age)
    writeFileSync(
      join(cfg.stateDir, `claude-${personality}.session`),
      JSON.stringify({ identity: `claude-${personality}`, runtime: 'claude', personality, cwd, wokeAt: Date.now() - 600_000 }),
    )
    setEphemeralArmed(cfg, `claude-${personality}`) // it sent its outbound reply
    return { env, cfg, root, laDir }
  }

  test('armed + last-turn FRESH (the turn is still writing entries) → NOT reaped mid-turn', () => {
    const { env, cfg, root, laDir } = ephemeralLiveEnv('w')
    try {
      const now = Date.now()
      const out = superviseTick(cfg, {
        env,
        nowMs: now,
        sessionAlive: () => true,
        lastTurnMtime: () => now - 1_000, // a transcript entry 1s ago — the turn is actively writing
      })
      expect(out.find(x => x.identity === 'claude-w')?.action).toBe('alive') // NOT reaped
      expect(hasEphemeralArmed(cfg, 'claude-w')).toBe(true) // session lives on, still armed
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })

  test('armed + last-turn QUIET past the quiet window (idle at the prompt) → reaped (conveyor drains)', () => {
    const { env, cfg, root, laDir } = ephemeralLiveEnv('i')
    try {
      const now = Date.now()
      const out = superviseTick(cfg, {
        env,
        nowMs: now,
        sessionAlive: () => true,
        lastTurnMtime: () => now - 120_000, // no transcript entry for 2 min → the turn ended, idle
      })
      expect(out.find(x => x.identity === 'claude-i')?.action).toBe('reaped-ephemeral')
      expect(hasEphemeralArmed(cfg, 'claude-i')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })

  test('no readable transcript (null last-turn) → the wokeAt floor governs the quiet age → reaped', () => {
    const { env, cfg, root, laDir } = ephemeralLiveEnv('m') // wokeAt = now - 600_000 (10 min)
    try {
      const now = Date.now()
      const out = superviseTick(cfg, {
        env,
        nowMs: now,
        sessionAlive: () => true,
        lastTurnMtime: () => null, // unreadable/absent transcript → age from wokeAt (10 min ≫ quiet)
      })
      expect(out.find(x => x.identity === 'claude-m')?.action).toBe('reaped-ephemeral')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// generic idle-reap — content-time (last meaningful transcript ENTRY) is the idle
//  proxy, NOT the transcript FILE mtime and NOT the pane-log mtime. BOTH raw mtimes
//  report false freshness for an idle session: claude re-saves its .jsonl without a
//  new entry (file-mtime fresh), and a statusline / footer re-render ticks the pane-log
//  at the prompt (incident 23.06 — real peers lived idle 3-5h unreaped). The transcript
//  ENTRY stream only advances on real turn activity → adapter.lastTurnMtime governs.
//  Floored at wokeAt so a freshly-woken session (old prior-session last-turn) is safe.
// ─────────────────────────────────────────────────────────────────────────────

describe('generic idle-reap — content-time idle proxy (statusline-tick fix)', () => {
  function liveEnv(personality: string, wokeMsAgo: number): { env: NodeJS.ProcessEnv; cfg: LifecycleConfig; root: string; laDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-idle-pl-root-'))
    const laDir = mkdtempSync(join(tmpdir(), 'iapeer-idle-pl-la-')) // empty → not launchd-managed
    const env = { ...process.env, IAPEER_ROOT: root, IAPEER_LAUNCHAGENTS_DIR: laDir, IAPEER_SOCK_DIR: join(root, 'socks') }
    const cfg = loadLifecycleConfig(env)
    mkdirSync(cfg.stateDir, { recursive: true })
    const cwd = join(root, 'peers', personality)
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      join(cwd, '.iapeer', 'peer-profile.json'),
      JSON.stringify({ personality, default_runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial' }), // NOT ephemeral
    )
    writeFileSync(
      join(cfg.stateDir, `claude-${personality}.session`),
      JSON.stringify({ identity: `claude-${personality}`, runtime: 'claude', personality, cwd, wokeAt: Date.now() - wokeMsAgo }),
    )
    return { env, cfg, root, laDir }
  }

  test('THE FIX: last real turn stale (file-mtime + pane-log would be falsely fresh) → reaped-idle', () => {
    const { env, cfg, root, laDir } = liveEnv('w', 7_200_000) // woke 2h ago
    try {
      const now = Date.now()
      const out = superviseTick(cfg, {
        env,
        nowMs: now,
        sessionAlive: () => true,
        lastTurnMtime: () => now - 7_200_000, // last meaningful transcript entry 2h ago → genuinely idle
      })
      expect(out.find(x => x.identity === 'claude-w')?.action).toBe('reaped-idle')
      expect(hasIdleReaped(cfg, 'claude-w')).toBe(true) // daemon-initiated park → resume-eligible
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })

  test('active: a recent real turn → alive (content-time keeps it warm)', () => {
    const { env, cfg, root, laDir } = liveEnv('a', 7_200_000)
    try {
      const now = Date.now()
      const out = superviseTick(cfg, {
        env,
        nowMs: now,
        sessionAlive: () => true,
        lastTurnMtime: () => now - 30_000, // a transcript entry 30s ago → active, not idle
      })
      expect(out.find(x => x.identity === 'claude-a')?.action).toBe('alive')
      expect(hasIdleReaped(cfg, 'claude-a')).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })

  test('a recent turn protects a session woken long ago (content-time, not wokeAt, governs)', () => {
    const { env, cfg, root, laDir } = liveEnv('x', 100_000_000) // woke ~28h ago
    try {
      const now = Date.now()
      const out = superviseTick(cfg, {
        env,
        nowMs: now,
        sessionAlive: () => true,
        lastTurnMtime: () => now - 60_000, // genuinely active (a real turn 1 min ago)
      })
      expect(out.find(x => x.identity === 'claude-x')?.action).toBe('alive')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })

  test('wokeAt FLOOR: a freshly-woken session with no NEW turn (stale prior last-turn) is NOT reaped', () => {
    const { env, cfg, root, laDir } = liveEnv('f', 30_000) // woke 30s ago
    try {
      const now = Date.now()
      const out = superviseTick(cfg, {
        env,
        nowMs: now,
        sessionAlive: () => true,
        lastTurnMtime: () => now - 7_200_000, // a PRIOR session's last turn (2h old, resumed)
      })
      // the wokeAt floor (30s) governs → a just-woken peer is not reaped out from under itself
      expect(out.find(x => x.identity === 'claude-f')?.action).toBe('alive')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// classifyGoneSession — the death-class tag for reaped-gone (server-dead vs
// session-gone). Live case: iapeer-memory 10.06 — the whole tmux server died
// (SIGKILL class), exits.log stayed empty; lifecycle.log must carry the class.
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyGoneSession (death-class tag, pty-only)', () => {
  // pty-only: a gone peer is a supervisor session that ended — its cause lives in the supervisor
  // exits.log (death-EVENT). The tag is observability-only (lifecycle.log trace), always server-dead;
  // there is no tmux server to distinguish session-gone from server-dead.
  test('a gone peer → server-dead, pty-host framed (not tmux)', () => {
    const r = classifyGoneSession(join(tmpdir(), 'iapeer-no-such-sock-ever.sock'))
    expect(r.death).toBe('server-dead')
    expect(r.reason).toContain('pty host')
    expect(r.reason).not.toContain('tmux server')
  })
})

// Regression (live incident 16.06): an attach-WOKEN session was idle-reaped ~47s after
// the wake. Cause: idle-age was measured from the activity proxy (transcript/rollout
// mtime), and a wake that produced no model turn (attach-only resume) leaves the proxy
// at its PRE-wake value. For codex the rollout does NOT advance on resume → the stale
// proxy made a 47-s-old session look idle for its entire prior life → reaped out from
// under the attaching operator. Fix: floor idle-age at wokeAt (max, not ??).
// HERMETIC — liveness + activity-proxy are seamed (no tmux/pty needed; the prod path is
// pty now, tmux is fallback-only — a live-tmux test would assert against a legacy path).
describe('superviseTick idle-age floor (freshly-woken session)', () => {
  function floorEnv(): { env: NodeJS.ProcessEnv; cfg: LifecycleConfig; root: string; laDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-floor-root-'))
    const laDir = mkdtempSync(join(tmpdir(), 'iapeer-floor-la-')) // empty → not launchd-managed
    const env = { ...process.env, IAPEER_ROOT: root, IAPEER_LAUNCHAGENTS_DIR: laDir, IAPEER_SOCK_DIR: join(root, 'socks') }
    const cfg = loadLifecycleConfig(env) // idleSecs 3600
    return { env, cfg, root, laDir }
  }

  test('JUST-woken + STALE proxy → alive (mt floored at wokeAt); both old → reaped-idle', () => {
    const { env, cfg, root, laDir } = floorEnv()
    const identity = 'claude-floor'
    const STALE = Date.now() - 99_999_000 // ≫ idleSecs ago
    const writeState = (wokeAt: number) => {
      mkdirSync(cfg.stateDir, { recursive: true })
      writeFileSync(
        join(cfg.stateDir, `${identity}.session`),
        JSON.stringify({ identity, runtime: 'claude', personality: 'floor', cwd: '/tmp/floor', wokeAt }),
      )
    }
    // Seam liveness TRUE + a STALE last-turn proxy → exercise the idle branch hermetically.
    const deps = { env, sessionAlive: () => true, lastTurnMtime: () => STALE }
    try {
      // 1) Freshly woken (wokeAt = now) but the proxy is STALE (pre-wake): idle-age MUST
      //    floor at wokeAt → age ~0 → NOT reaped. (Old `?? wokeAt` used the stale proxy
      //    and reaped this session ~47s after an attach-wake — the incident.)
      writeState(Date.now())
      expect(superviseTick(cfg, deps).find(x => x.identity === identity)?.action).toBe('alive')

      // 2) Control: BOTH wokeAt and proxy old → genuinely idle → reaped-idle.
      writeState(STALE)
      expect(superviseTick(cfg, deps).find(x => x.identity === identity)?.action).toBe('reaped-idle')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
    }
  })
})

describe('superviseTick quiet-reap (M2 die-after-reply, hermetic via sessionAlive seam)', () => {
  test('ARMED + quiet → reaped-ephemeral (marks cleared, NO death/idle-reaped); unarmed/not-quiet → alive', () => {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-eq-root-'))
    const laDir = mkdtempSync(join(tmpdir(), 'iapeer-eq-la-')) // empty → not launchd-managed
    const cwd = profileCwd(false, true) // ephemeral worker profile
    const env = {
      ...process.env,
      IAPEER_ROOT: root,
      IAPEER_LAUNCHAGENTS_DIR: laDir,
      IAPEER_SOCK_DIR: join(root, 'socks'),
    }
    const cfg = loadLifecycleConfig(env) // ephemeralQuietSecs 20 ≪ idleSecs 3600
    const identity = 'claude-eq'
    const deps = { env, sessionAlive: () => true } // pty-only: liveness seamed (no tmux/supervisor spawn)
    const writeState = (wokeAt: number) => {
      mkdirSync(cfg.stateDir, { recursive: true })
      writeFileSync(
        join(cfg.stateDir, `${identity}.session`),
        JSON.stringify({ identity, runtime: 'claude', personality: 'eq', cwd, wokeAt }),
      )
    }
    try {
      // no transcript in the temp cwd → activity proxy = wokeAt fallback (quiet age set via .session).
      // 1) NOT armed + quiet-aged → alive (silent long tool-run protection; only the idle bound applies).
      writeState(Date.now() - 60_000) // age ~60s > quiet 20s, ≪ idle 3600s
      expect(superviseTick(cfg, deps).find(x => x.identity === identity)?.action).toBe('alive')

      // 2) ARMED but NOT quiet → alive (post-reply housekeeping keeps it alive).
      setEphemeralArmed(cfg, identity)
      writeState(Date.now()) // age ~0 < quiet
      expect(superviseTick(cfg, deps).find(x => x.identity === identity)?.action).toBe('alive')

      // 3) ARMED + quiet → reaped-ephemeral, with the M3 drain fields + marker cleanup.
      writeState(Date.now() - 60_000)
      const o = superviseTick(cfg, deps).find(x => x.identity === identity)
      expect(o?.action).toBe('reaped-ephemeral')
      expect(o?.personality).toBe('eq')
      expect(o?.runtime).toBe('claude')
      expect(hasEphemeralArmed(cfg, identity)).toBe(false) // mark consumed
      expect(existsSync(join(cfg.stateDir, `${identity}.session`))).toBe(false) // state cleared by the reap
      // deliberate policy death: never resume-eligible, never a crash-loop count
      expect(hasIdleReaped(cfg, identity)).toBe(false)
      expect(readDeaths(cfg, identity).length).toBe(0)
      // durable decision trace
      const logged = readFileSync(join(cfg.eventLogDir, 'lifecycle.log'), 'utf8')
      expect(logged).toContain(`action=reaped-ephemeral`)
      expect(logged).toContain('outcome=ephemeral-done')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('UNARMED ephemeral past the unarmed idle bound → reaped-ephemeral (silent-finish backstop; live case scriber 10.06)', () => {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-eu-root-'))
    const laDir = mkdtempSync(join(tmpdir(), 'iapeer-eu-la-'))
    const cwd = profileCwd(false, true) // ephemeral worker profile
    const env = {
      ...process.env,
      IAPEER_ROOT: root,
      IAPEER_LAUNCHAGENTS_DIR: laDir,
      IAPEER_SOCK_DIR: join(root, 'socks'),
      IAPEER_EPHEMERAL_UNARMED_IDLE_SECS: '30', // ≪ the 60s age below, ≫ quiet 20s
    }
    const cfg = loadLifecycleConfig(env)
    const identity = 'claude-eu'
    const deps = { env, sessionAlive: () => true } // pty-only: liveness seamed
    try {
      mkdirSync(cfg.stateDir, { recursive: true })
      writeFileSync(
        join(cfg.stateDir, `${identity}.session`),
        JSON.stringify({ identity, runtime: 'claude', personality: 'eu', cwd, wokeAt: Date.now() - 60_000 }),
      )
      // NOT armed (the worker ended silently) — past the unarmed bound → policy reap
      const o = superviseTick(cfg, deps).find(x => x.identity === identity)
      expect(o?.action).toBe('reaped-ephemeral')
      expect(o?.reason).toContain('unarmed idle')
      expect(o?.personality).toBe('eu') // M3 drain fields present → queue feeds next
      // policy death: no resume-eligibility, no crash-loop count
      expect(hasIdleReaped(cfg, identity)).toBe(false)
      expect(readDeaths(cfg, identity).length).toBe(0)
      const logged = readFileSync(join(cfg.eventLogDir, 'lifecycle.log'), 'utf8')
      expect(logged).toContain('outcome=ephemeral-unarmed-bound')
      // a NON-ephemeral peer with the same age is untouched by this bound
      const plainCwd = profileCwd(false, false)
      try {
        writeFileSync(
          join(cfg.stateDir, `claude-eup.session`),
          JSON.stringify({ identity: 'claude-eup', runtime: 'claude', personality: 'eup', cwd: plainCwd, wokeAt: Date.now() - 60_000 }),
        )
        expect(superviseTick(cfg, deps).find(x => x.identity === 'claude-eup')?.action).toBe('alive')
      } finally {
        rmSync(plainCwd, { recursive: true, force: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Crash-loop guard — wakeOrSpawn refuses to (re)launch after N deaths in the window
// ─────────────────────────────────────────────────────────────────────────────

describe('crash-loop guard', () => {
  test('countRecentDeaths windows correctly; recordDeath rings', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'iapeer-deaths-'))
    const cfg = { stateDir } as LifecycleConfig
    try {
      const now = 1_000_000
      recordDeath(cfg, 'claude-d', now - 400_000) // outside a 300s window
      recordDeath(cfg, 'claude-d', now - 10_000)
      recordDeath(cfg, 'claude-d', now - 5_000)
      expect(countRecentDeaths(cfg, 'claude-d', 300, now)).toBe(2)
      expect(countRecentDeaths(cfg, 'claude-d', 600, now)).toBe(3)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  test('wakeOrSpawn REFUSES after crashLoopMax deaths within the window (FAILED, no launch)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-clg-root-'))
    const laDir = mkdtempSync(join(tmpdir(), 'iapeer-clg-la-')) // empty → not launchd-managed
    const peerCwd = mkdtempSync(join(tmpdir(), 'iapeer-clg-cwd-')) // REAL cwd so the cwd-existence check passes and the guard is what fires
    try {
      await upsertPeer(
        { personality: 'clg', runtime: 'claude', cwd: peerCwd, intelligence: 'artificial' },
        { rootDir: root },
      )
      const env = { ...process.env, IAPEER_ROOT: root, IAPEER_LAUNCHAGENTS_DIR: laDir, IAPEER_SOCK_DIR: join(root, 'socks'), IAPEER_CRASHLOOP_MAX: '3', IAPEER_CRASHLOOP_WINDOW_SECS: '300' }
      const cfg = loadLifecycleConfig(env)
      const now = Date.now()
      recordDeath(cfg, 'claude-clg', now)
      recordDeath(cfg, 'claude-clg', now)
      recordDeath(cfg, 'claude-clg', now)
      const r = await wakeOrSpawn({ personality: 'clg', runtime: 'claude', task: 'must not launch' }, { env })
      expect(r.status).toBe('FAILED')
      expect(r.woke).toBe(false)
      expect(r.reason).toMatch(/crash-loop guard/)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(laDir, { recursive: true, force: true })
      rmSync(peerCwd, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// .topic — executor discriminator round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('topic marker round-trip', () => {
  test('topic SET: addTopic accumulates (dedup, most-recent-last); readTopic=last; hasTopic=membership; resetTopics clears', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'iapeer-topic-'))
    const cfg = { stateDir } as LifecycleConfig
    try {
      expect(readTopic(cfg, 'claude-t')).toBe('')
      expect(readTopics(cfg, 'claude-t')).toEqual([])
      addTopic(cfg, 'claude-t', 'deploy-pipeline')
      addTopic(cfg, 'claude-t', 'flaky-test')
      addTopic(cfg, 'claude-t', 'deploy-pipeline') // dedup → promoted to most-recent
      expect(readTopics(cfg, 'claude-t')).toEqual(['flaky-test', 'deploy-pipeline'])
      expect(readTopic(cfg, 'claude-t')).toBe('deploy-pipeline') // last = most-recent
      expect(hasTopic(cfg, 'claude-t', 'flaky-test')).toBe(true) // earlier thread still a member
      expect(hasTopic(cfg, 'claude-t', 'never')).toBe(false)
      addTopic(cfg, 'claude-t', '') // empty → no-op
      expect(readTopics(cfg, 'claude-t')).toEqual(['flaky-test', 'deploy-pipeline'])
      resetTopics(cfg, 'claude-t')
      expect(readTopics(cfg, 'claude-t')).toEqual([])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Ф-D launch / attach — operator verbs (error paths; success paths are live-verified)
// ─────────────────────────────────────────────────────────────────────────────

describe('lastActiveRuntime', () => {
  test('a peer with no transcript anywhere → undefined (never run)', () => {
    const cfg = { sockDir: '/tmp' } as LifecycleConfig
    const rt = lastActiveRuntime(peer({ personality: 'np', runtimes: ['claude', 'codex'], cwd: '/tmp/does-not-exist-xyz' }), cfg)
    expect(rt).toBeUndefined()
  })
})

describe('resolvePeerRuntime — predictable omitted-runtime default (new/attach/compact agree)', () => {
  // sockDir points at an empty dir so NO runtime reads as live → the no-live branches
  // (precedence 1 + 4) are deterministic. The live branches are liveness-gated and
  // live-verified (success paths are live-verified, per this section's note).
  const tmpDirs: string[] = []
  const noLiveCfg = () => {
    const dir = mkdtempSync(join(tmpdir(), 'iapeer-rpr-'))
    tmpDirs.push(dir)
    return { sockDir: dir } as LifecycleConfig
  }
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test('sole declared runtime → that runtime', () => {
    const rt = resolvePeerRuntime(peer({ personality: 'solo', runtime: 'claude', runtimes: ['claude'] }), noLiveCfg())
    expect(rt).toBe('claude')
  })

  test('multi-runtime, nothing live → default_runtime (NOT last-active-by-mtime)', () => {
    const rt = resolvePeerRuntime(peer({ personality: 'mr', runtime: 'claude', runtimes: ['claude', 'codex'] }), noLiveCfg())
    expect(rt).toBe('claude')
  })

  test('multi-runtime with default_runtime=codex, nothing live → codex (the config lever drives the naive flow)', () => {
    const rt = resolvePeerRuntime(peer({ personality: 'mr', runtime: 'codex', runtimes: ['claude', 'codex'] }), noLiveCfg())
    expect(rt).toBe('codex')
  })

  test('deterministic — repeated calls agree (new/attach/compact share this resolver)', () => {
    const p = peer({ personality: 'mr', runtime: 'codex', runtimes: ['claude', 'codex'] })
    const cfg = noLiveCfg()
    expect(resolvePeerRuntime(p, cfg)).toBe(resolvePeerRuntime(p, cfg))
  })
})

describe('attachPeer (error paths)', () => {
  test('an unregistered peer → ok:false', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-att-'))
    try {
      const r = await attachPeer({ personality: 'ghost', env: { ...process.env, IAPEER_ROOT: root } })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/not registered/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test('an explicit UNDECLARED runtime → ok:false (fail-loud)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-att2-'))
    try {
      await upsertPeer({ personality: 'solo', runtime: 'claude', cwd: '/tmp/solo', intelligence: 'artificial' }, { rootDir: root })
      const r = await attachPeer({ personality: 'solo', runtime: 'codex', env: { ...process.env, IAPEER_ROOT: root } })
      expect(r.ok).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('folderLaunch (error path)', () => {
  test('a cwd without a peer-profile → throws (resolveIdentity fail-loud)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'iapeer-fl-'))
    try {
      await expect(folderLaunch({ cwd, env: { ...process.env } })).rejects.toThrow()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
