// launchd plist generation + the install↔isLaunchdManaged round-trip + the notifier
// runtime classification. Validates the rendered plist with the REAL macOS
// `plutil -lint` (a live check that the XML is a well-formed plist), exercises XML
// escaping of hostile cwd characters, and proves the generator and the H4 detector
// agree on the label/dir scheme.

import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  bootstrapJobCore,
  cycleDaemonCore,
  getAdapter,
  installAlwaysOnPlist,
  isFoundationOwnedPlist,
  launchAgentsDir,
  launchdLabel,
  launchdPlistPath,
  renderLaunchdPlist,
  resolveExecutable,
  type LaunchdPlistSpec,
} from './index.ts'
import { isLaunchdManaged } from '../lifecycle/index.ts'
import { buildAlwaysOnSpec, runAlwaysOn } from './launchdRun.ts'
import { defaultIntelligenceForRuntime, isInfraRuntime } from '../core/constants.ts'

const tmpDirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-launchd-'))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function plutilLint(path: string): { ok: boolean; out: string } {
  const r = spawnSync('plutil', ['-lint', path], { encoding: 'utf8' })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
}

const baseSpec: LaunchdPlistSpec = {
  label: 'com.iapeer.timer',
  programArguments: ['/path/to/bun', '/pkg/src/launch/launchdRun.ts', 'timer', 'notifier'],
  workingDirectory: '/Users/x/Peers/timer',
  environment: {
    PEER_PERSONALITY: 'timer',
    PEER_RUNTIME: 'notifier',
    PEER_IDENTITY: 'notifier-timer',
    PATH: '/usr/bin:/bin',
  },
  stdoutPath: '/Users/x/Peers/timer/.iapeer/logs/notifier/launchd-stdout.log',
  stderrPath: '/Users/x/Peers/timer/.iapeer/logs/notifier/launchd-stderr.log',
}

describe('runtime classification', () => {
  test('notifier → intelligence absent (zone)', () => {
    expect(defaultIntelligenceForRuntime('notifier')).toBe('absent')
  })
  test('isInfraRuntime: notifier + telegram infra; claude/codex not', () => {
    expect(isInfraRuntime('notifier')).toBe(true)
    expect(isInfraRuntime('telegram')).toBe(true)
    expect(isInfraRuntime('claude')).toBe(false)
    expect(isInfraRuntime('codex')).toBe(false)
  })
  test('every infra runtime resolves to a router adapter (isInfraRuntime ↔ getAdapter can not drift)', () => {
    for (const rt of ['notifier', 'telegram']) {
      expect(isInfraRuntime(rt)).toBe(true)
      expect(getAdapter(rt).kind).toBe('router') // always-on bring-up needs the launch-primitive adapter
    }
  })
})

describe('launchdLabel / launchAgentsDir', () => {
  test('label = com.iapeer.<personality>', () => {
    expect(launchdLabel('timer')).toBe('com.iapeer.timer')
    expect(launchdLabel('watcher')).toBe('com.iapeer.watcher')
  })
  test('launchAgentsDir honors IAPEER_LAUNCHAGENTS_DIR', () => {
    expect(launchAgentsDir({ IAPEER_LAUNCHAGENTS_DIR: '/tmp/la' })).toBe('/tmp/la')
  })
})

describe('renderLaunchdPlist', () => {
  test('valid plist (live plutil -lint) with always-on keys + throttle default 10', () => {
    const xml = renderLaunchdPlist(baseSpec)
    expect(xml).toContain('<key>Label</key>\n    <string>com.iapeer.timer</string>')
    expect(xml).toContain('<key>RunAtLoad</key>\n    <true/>')
    expect(xml).toContain('<key>KeepAlive</key>\n    <true/>')
    expect(xml).toContain('<key>ThrottleInterval</key>\n    <integer>10</integer>')
    expect(xml).toContain('<key>PEER_IDENTITY</key>\n        <string>notifier-timer</string>')
    expect(xml).toContain('<string>/pkg/src/launch/launchdRun.ts</string>')

    const dir = mkTmp()
    const f = join(dir, 'r.plist')
    writeFileSync(f, xml)
    const lint = plutilLint(f)
    expect(lint.ok).toBe(true) // plutil parsed it as a valid plist
  })

  test('explicit throttle is honored', () => {
    expect(renderLaunchdPlist({ ...baseSpec, throttleIntervalSecs: 30 })).toContain(
      '<key>ThrottleInterval</key>\n    <integer>30</integer>',
    )
  })

  test('XML-escapes hostile cwd/personality and STAYS plutil-valid', () => {
    const hostile = '/Users/x/Peers/a & b <weird>'
    const xml = renderLaunchdPlist({ ...baseSpec, workingDirectory: hostile })
    expect(xml).toContain('<string>/Users/x/Peers/a &amp; b &lt;weird&gt;</string>')
    expect(xml).not.toContain('a & b <weird>') // raw unescaped must not appear
    const dir = mkTmp()
    const f = join(dir, 'h.plist')
    writeFileSync(f, xml)
    expect(plutilLint(f).ok).toBe(true)
  })

  test('drops XML-1.0-illegal control chars (NUL/C0) and stays valid', () => {
    const xml = renderLaunchdPlist({ ...baseSpec, workingDirectory: '/a\x00b\x01c\x1ftab\tkeep' })
    expect(xml).toContain('<string>/abctab\tkeep</string>') // controls gone, tab preserved
    expect(xml).not.toContain('\x00')
    const dir = mkTmp()
    const f = join(dir, 'c.plist')
    writeFileSync(f, xml)
    expect(plutilLint(f).ok).toBe(true)
  })
})

describe('installAlwaysOnPlist ↔ isLaunchdManaged round-trip', () => {
  test('installs a valid notifier plist that isLaunchdManaged then detects', () => {
    const root = mkTmp()
    const laDir = join(root, 'LaunchAgents')
    const cwd = join(root, 'peer-timer')
    // IAPEER_ROOT keeps the now-GLOBAL infra log dir (~/.iapeer/logs/<p>) under the
    // sandbox, not the real home (Фаза §8 moved infra logs out of the per-peer cwd).
    const env = { IAPEER_LAUNCHAGENTS_DIR: laDir, IAPEER_ROOT: join(root, 'iapeer') } as NodeJS.ProcessEnv

    const path = installAlwaysOnPlist({
      personality: 'timer',
      runtime: 'notifier',
      cwd,
      entrypointArgv: ['/path/to/bun', '/pkg/src/launch/launchdRun.ts'],
      path: '/usr/bin:/bin',
      env,
    })

    expect(path).toBe(launchdPlistPath('timer', env))
    expect(existsSync(path)).toBe(true)
    // generator and H4 detector agree (shared launchdLabel/launchAgentsDir)
    expect(isLaunchdManaged('timer', env)).toBe(true)
    expect(isLaunchdManaged('nobody', env)).toBe(false)
    // the installed file is a valid plist
    expect(plutilLint(path).ok).toBe(true)
  })

  test('DEFAULT entrypoint (Ф-F) = the installed `iapeer run-infra <p> <r>` binary, not bun src', () => {
    const root = mkTmp()
    // HOME=/Users/x exercises the default binary path (~/.local/bin/iapeer); IAPEER_ROOT
    // keeps the global infra log dir under the sandbox (not the fake /Users/x).
    const env = {
      IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'),
      HOME: '/Users/x',
      IAPEER_ROOT: join(root, 'iapeer'),
    } as NodeJS.ProcessEnv
    // no entrypointArgv → the default must be the installed binary + run-infra verb
    const path = installAlwaysOnPlist({ personality: 'timer', runtime: 'notifier', cwd: join(root, 'c'), env })
    const xml = readFileSync(path, 'utf8')
    expect(xml).toContain('<string>/Users/x/.local/bin/iapeer</string>')
    expect(xml).toContain('<string>run-infra</string>')
    expect(xml).toContain('<string>timer</string>')
    expect(xml).toContain('<string>notifier</string>')
    expect(xml).not.toContain('launchdRun.ts') // decoupled from the src tree
  })

  test('refuses a non-infra (warm-on-demand) runtime', () => {
    const root = mkTmp()
    expect(() =>
      installAlwaysOnPlist({
        personality: 'boris',
        runtime: 'claude',
        cwd: join(root, 'p'),
        env: { IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents') } as NodeJS.ProcessEnv,
      }),
    ).toThrow(/not an always-on infra runtime/)
  })
})

// The launchd Label com.iapeer.<personality> is keyed on PERSONALITY and SHARED
// with the live persistent-peer fleet (com.iapeer.nova, com.iapeer.boris — real
// people/agents, launchd-held RIGHT NOW). A personality collision would point the
// installer at a PP-managed plist. H4 invariant: the foundation must NEVER clobber
// a plist it does not own. The guard tells "ours" from "theirs" by a sentinel the
// foundation renderer embeds — a PP/foreign plist lacks it → refuse, do not write.
describe('installAlwaysOnPlist collision guard (H4 — shared com.iapeer.* namespace)', () => {
  // A persistent-peer start.sh plist for `boris` — same com.iapeer.boris Label, but
  // NOT foundation-rendered (no sentinel). This stands in for a live PP-managed file.
  const foreignPpPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.iapeer.boris</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/x/.iapeer/plugins/persistent-peer/start.sh</string>
        <string>boris</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
`

  test('REFUSES to overwrite a foreign (PP-managed) com.iapeer.* plist — no silent clobber', () => {
    const root = mkTmp()
    const laDir = join(root, 'LaunchAgents')
    mkdirSync(laDir, { recursive: true })
    const env = { IAPEER_LAUNCHAGENTS_DIR: laDir, IAPEER_ROOT: join(root, 'iapeer') } as NodeJS.ProcessEnv
    const path = launchdPlistPath('boris', env)
    writeFileSync(path, foreignPpPlist) // a live PP peer's plist already sits here

    expect(() =>
      installAlwaysOnPlist({
        personality: 'boris',
        runtime: 'notifier',
        cwd: join(root, 'peer-boris'),
        entrypointArgv: ['/path/to/bun', '/pkg/src/launch/launchdRun.ts'],
        path: '/usr/bin:/bin',
        env,
      }),
    ).toThrow(/foundation-managed|refus/i)

    // the foreign plist MUST be byte-for-byte untouched (the live PP peer survives)
    expect(readFileSync(path, 'utf8')).toBe(foreignPpPlist)
  })

  test('isFoundationOwnedPlist: own (rendered) → true, foreign → false, absent → false', () => {
    const dir = mkTmp()
    const own = join(dir, 'own.plist')
    writeFileSync(own, renderLaunchdPlist(baseSpec)) // foundation renderer → sentinel
    expect(isFoundationOwnedPlist(own)).toBe(true)

    const foreign = join(dir, 'foreign.plist')
    writeFileSync(foreign, foreignPpPlist) // PP start.sh plist → no sentinel
    expect(isFoundationOwnedPlist(foreign)).toBe(false)

    expect(isFoundationOwnedPlist(join(dir, 'nope.plist'))).toBe(false) // absent
  })

  test('re-installing the foundation OWN plist is idempotent (sentinel present → allowed)', () => {
    const root = mkTmp()
    const laDir = join(root, 'LaunchAgents')
    const env = { IAPEER_LAUNCHAGENTS_DIR: laDir, IAPEER_ROOT: join(root, 'iapeer') } as NodeJS.ProcessEnv
    const opts = {
      personality: 'timer',
      runtime: 'notifier' as const,
      cwd: join(root, 'peer-timer'),
      entrypointArgv: ['/path/to/bun', '/pkg/src/launch/launchdRun.ts'],
      path: '/usr/bin:/bin',
      env,
    }
    const path = installAlwaysOnPlist(opts) // first install — writes OUR plist
    expect(isFoundationOwnedPlist(path)).toBe(true)
    // second install over our own plist must NOT throw (idempotent re-provision)
    expect(() => installAlwaysOnPlist(opts)).not.toThrow()
    expect(plutilLint(path).ok).toBe(true)
  })
})

// launchd gives a job a MINIMAL PATH (no ~/.local/bin, ~/.bun/bin), so an infra
// peer's always-on plist must PIN its launcher to an absolute path or the session
// crash-loops. installAlwaysOnPlist resolves the bin against the rich provisioning
// PATH and bakes NOTIFIER_RUNTIME_BIN / TELEGRAM_RUNTIME_BIN.
describe('resolveExecutable + runtime-bin pinning', () => {
  function fakeExec(dir: string, name: string): string {
    const p = join(dir, name)
    writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    return p
  }

  test('resolveExecutable: finds on PATH, abs passthrough, undefined when absent', () => {
    const dir = mkTmp()
    const bin = fakeExec(dir, 'notifier-runtime')
    expect(resolveExecutable('notifier-runtime', { PATH: dir } as NodeJS.ProcessEnv)).toBe(bin)
    expect(resolveExecutable(bin, {} as NodeJS.ProcessEnv)).toBe(bin) // abs path, exists+exec
    expect(resolveExecutable('no-such-bin', { PATH: dir } as NodeJS.ProcessEnv)).toBeUndefined()
    expect(resolveExecutable('/nope/notifier-runtime', {} as NodeJS.ProcessEnv)).toBeUndefined()
  })

  test('explicit runtimeBin (abs) is baked into the plist env', () => {
    const root = mkTmp()
    const env = { IAPEER_LAUNCHAGENTS_DIR: join(root, 'LA'), IAPEER_ROOT: join(root, 'iapeer') } as NodeJS.ProcessEnv
    const path = installAlwaysOnPlist({
      personality: 'timer', runtime: 'notifier', cwd: join(root, 'p'),
      runtimeBin: '/opt/iapeer/notifier-runtime',
      entrypointArgv: ['/bun', '/run.ts'], path: '/usr/bin:/bin', env,
    })
    const xml = readFileSync(path, 'utf8')
    expect(xml).toContain('<key>NOTIFIER_RUNTIME_BIN</key>')
    expect(xml).toContain('<string>/opt/iapeer/notifier-runtime</string>')
    expect(plutilLint(path).ok).toBe(true)
  })

  test('runtimeBin omitted → default bin resolved from env.PATH and pinned', () => {
    const root = mkTmp()
    const bindir = mkTmp()
    const bin = fakeExec(bindir, 'notifier-runtime')
    const env = { IAPEER_LAUNCHAGENTS_DIR: join(root, 'LA'), PATH: bindir, IAPEER_ROOT: join(root, 'iapeer') } as NodeJS.ProcessEnv
    const path = installAlwaysOnPlist({
      personality: 'timer', runtime: 'notifier', cwd: join(root, 'p'),
      entrypointArgv: ['/bun', '/run.ts'], env,
    })
    expect(readFileSync(path, 'utf8')).toContain(`<string>${bin}</string>`)
  })

  test('unresolvable launcher → NOT baked (no crash; bare name + plist PATH remain)', () => {
    const root = mkTmp()
    const env = { IAPEER_LAUNCHAGENTS_DIR: join(root, 'LA'), PATH: join(root, 'empty'), IAPEER_ROOT: join(root, 'iapeer') } as NodeJS.ProcessEnv
    const path = installAlwaysOnPlist({
      personality: 'timer', runtime: 'notifier', cwd: join(root, 'p'),
      entrypointArgv: ['/bun', '/run.ts'], path: '/usr/bin:/bin', env,
    })
    expect(readFileSync(path, 'utf8')).not.toContain('NOTIFIER_RUNTIME_BIN')
  })
})

// NOTIFIER_FALLBACK_TARGET — the notifier alarm-chain backstop, host-resolved at
// plist generation (NEVER a hardcoded literal — that would ship in the public
// package and break foreign installs). env when set, else preserved from this
// host's existing plist; absent → not baked (the notifier package's own default).
describe('NOTIFIER_FALLBACK_TARGET host-resolved injection', () => {
  function notifierEnv(root: string, extra: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
    return { IAPEER_LAUNCHAGENTS_DIR: join(root, 'LA'), IAPEER_ROOT: join(root, 'iapeer'), ...extra } as NodeJS.ProcessEnv
  }
  function install(env: NodeJS.ProcessEnv, root: string, runtime: 'notifier' | 'telegram' = 'notifier'): string {
    return installAlwaysOnPlist({
      personality: 'timer', runtime, cwd: join(root, 'p'),
      entrypointArgv: ['/bun', '/run.ts'], path: '/usr/bin:/bin', env,
    })
  }

  test('env NOTIFIER_FALLBACK_TARGET → baked into the notifier plist', () => {
    const root = mkTmp()
    const xml = readFileSync(install(notifierEnv(root, { NOTIFIER_FALLBACK_TARGET: 'boris' }), root), 'utf8')
    expect(xml).toContain('<key>NOTIFIER_FALLBACK_TARGET</key>')
    expect(xml).toContain('<string>boris</string>')
    expect(plutilLint(install(notifierEnv(root, { NOTIFIER_FALLBACK_TARGET: 'boris' }), root)).ok).toBe(true)
  })

  test('no env, no existing plist → NOT baked (fresh/foreign host stays clean)', () => {
    const root = mkTmp()
    expect(readFileSync(install(notifierEnv(root), root), 'utf8')).not.toContain('NOTIFIER_FALLBACK_TARGET')
  })

  test('no env but existing plist HAS it → PRESERVED across regeneration', () => {
    const root = mkTmp()
    install(notifierEnv(root, { NOTIFIER_FALLBACK_TARGET: 'boris' }), root) // first: baked from env
    const path = install(notifierEnv(root), root) // regenerate WITHOUT the env var
    expect(readFileSync(path, 'utf8')).toContain('<string>boris</string>')
  })

  test('env wins over the existing plist value', () => {
    const root = mkTmp()
    install(notifierEnv(root, { NOTIFIER_FALLBACK_TARGET: 'boris' }), root)
    const path = install(notifierEnv(root, { NOTIFIER_FALLBACK_TARGET: 'doc' }), root)
    const xml = readFileSync(path, 'utf8')
    expect(xml).toContain('<string>doc</string>')
    expect(xml).not.toContain('<string>boris</string>')
  })

  test('non-notifier infra (telegram) never bakes it', () => {
    const root = mkTmp()
    const xml = readFileSync(install(notifierEnv(root, { NOTIFIER_FALLBACK_TARGET: 'boris' }), root, 'telegram'), 'utf8')
    expect(xml).not.toContain('NOTIFIER_FALLBACK_TARGET')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// bootstrapJobCore — the undead-job-safe bootstrap (boris's connect-acceptance
// find 10.06: bootout → immediate bootstrap → exit 5 I/O error → the whole
// fleet's telegram router stayed DOWN). Pure DI core: run/sleep injected.
// ─────────────────────────────────────────────────────────────────────────────

describe('bootstrapJobCore (undead-job race)', () => {
  type Call = { args: string[] }
  function harness(script: { printStatuses: number[]; bootstrapStatuses: number[] }) {
    const calls: Call[] = []
    const sleeps: number[] = []
    let printI = 0
    let bootI = 0
    const run = (args: string[]) => {
      calls.push({ args })
      if (args[0] === 'print') {
        const status = script.printStatuses[Math.min(printI, script.printStatuses.length - 1)]!
        printI++
        return { status, stderr: '' }
      }
      const status = script.bootstrapStatuses[Math.min(bootI, script.bootstrapStatuses.length - 1)]!
      bootI++
      return { status, stderr: status === 0 ? '' : 'Bootstrap failed: 5: Input/output error' }
    }
    return { calls, sleeps, deps: { run, sleepMs: (ms: number) => void sleeps.push(ms) } }
  }

  test('clean path: job not listed, first bootstrap succeeds — zero sleeps', () => {
    const h = harness({ printStatuses: [1], bootstrapStatuses: [0] })
    const r = bootstrapJobCore('501', 'com.iapeer.x', '/p.plist', h.deps)
    expect(r).toEqual({ state: 'loaded', attempts: 1 })
    expect(h.sleeps).toEqual([])
  })

  test("boris's repro: undead job vanishes after polls, first bootstrap exit 5, retry succeeds", () => {
    // print: listed, listed, gone (the bootout dismantle window) → bootstrap:
    // exit 5 once (still racy), success on the retry after backoff.
    const h = harness({ printStatuses: [0, 0, 1, 1, 1], bootstrapStatuses: [5, 0] })
    const r = bootstrapJobCore('501', 'com.iapeer.nova', '/p.plist', h.deps)
    expect(r.state).toBe('loaded')
    expect(r.attempts).toBe(2)
    expect(h.sleeps.length).toBeGreaterThan(0) // waited for gone + backoff before retry
  })

  test('genuinely LIVE job (stays listed through the gone budget) → already-loaded, bootstrap NEVER called', () => {
    const h = harness({ printStatuses: [0], bootstrapStatuses: [0] }) // always listed
    const r = bootstrapJobCore('501', 'com.iapeer.x', '/p.plist', { ...h.deps, goneTimeoutMs: 2_000 })
    expect(r).toEqual({ state: 'already-loaded', attempts: 0 })
    expect(h.calls.some(c => c.args[0] === 'bootstrap')).toBe(false)
  })

  test('every attempt fails → failed with the attempt count and the last stderr (LOUD, not silent)', () => {
    const h = harness({ printStatuses: [1], bootstrapStatuses: [5] })
    const r = bootstrapJobCore('501', 'com.iapeer.x', '/p.plist', h.deps)
    expect(r.state).toBe('failed')
    expect(r.attempts).toBe(4)
    expect(r.detail).toContain('Input/output error')
    expect(r.detail).toContain('4 bootstrap attempts')
  })

  test('a racing load between attempts reads already-loaded (idempotent success)', () => {
    // first bootstrap fails; before the retry the job shows up listed (raced in)
    const h = harness({ printStatuses: [1, 0], bootstrapStatuses: [5] })
    const r = bootstrapJobCore('501', 'com.iapeer.x', '/p.plist', h.deps)
    expect(r.state).toBe('already-loaded')
  })
})

describe('runAlwaysOn guard', () => {
  test('a non-infra runtime is rejected with exit code 1 (no tmux touched)', async () => {
    expect(await runAlwaysOn('boris', 'claude', '/tmp/whatever')).toBe(1)
  })
})

// REGRESSION (Ф-A #3 adversarial-verify find): the always-on launch path MUST carry
// the peer's intelligence onto the spec, or the launch primitive's telegram nature
// gate (requires natural) fails `natural !== undefined` → exit 1 → launchd KeepAlive
// crash-loop on EVERY telegram bot. buildAlwaysOnSpec reads it from the local profile.
describe('buildAlwaysOnSpec carries intelligence (telegram crash-loop guard)', () => {
  test('a provisioned telegram peer (intelligence=natural) → spec.intelligence=natural (clears the gate)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'iapeer-alwayson-'))
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      join(cwd, '.iapeer', 'peer-profile.json'),
      JSON.stringify({ personality: 'mybot', runtime: 'telegram', runtimes: ['telegram'], description: '', intelligence: 'natural' }),
    )
    const spec = buildAlwaysOnSpec('mybot', 'telegram', cwd, '/tmp')
    expect(spec.intelligence).toBe('natural')
    // and the gate it feeds would pass: telegram + natural is not refused
    rmSync(cwd, { recursive: true, force: true })
  })

  test('legacy human profile self-heals to natural on read → still clears the gate', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'iapeer-alwayson-'))
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      join(cwd, '.iapeer', 'peer-profile.json'),
      JSON.stringify({ personality: 'mybot', runtime: 'telegram', runtimes: ['telegram'], description: '', intelligence: 'human' }),
    )
    expect(buildAlwaysOnSpec('mybot', 'telegram', cwd, '/tmp').intelligence).toBe('natural')
    rmSync(cwd, { recursive: true, force: true })
  })
})

// ─── cycleDaemonCore — the LWCR-safe deploy restart (bootout+bootstrap) ───────
// Proven live 12.06 twice: a kickstart after a binary replacement respawns into
// an EX_CONFIG(78) crash-loop when launchd's managed Launch Constraint still
// pins the OLD binary's signature (com.iapeer.nova, then com.agfpd.iapeer
// itself on the 0.2.43 deploy). The cure — and now the ONLY restart form the
// update pipeline uses — is a full re-registration.

describe('cycleDaemonCore (LWCR-safe bootout+bootstrap)', () => {
  function harness(script: { printStatuses: number[]; bootoutStatus?: number; bootstrapStatuses?: number[] }) {
    const calls: string[][] = []
    let printI = 0
    let bootI = 0
    const run = (args: string[]) => {
      calls.push(args)
      if (args[0] === 'print') {
        const status = script.printStatuses[Math.min(printI, script.printStatuses.length - 1)]!
        printI++
        return { status, stderr: '' }
      }
      if (args[0] === 'bootout') return { status: script.bootoutStatus ?? 0, stderr: script.bootoutStatus ? 'boom' : '' }
      const status = (script.bootstrapStatuses ?? [0])[Math.min(bootI, (script.bootstrapStatuses ?? [0]).length - 1)]!
      bootI++
      return { status, stderr: status === 0 ? '' : 'Bootstrap failed' }
    }
    return { calls, deps: { run, sleepMs: () => {} } }
  }

  test('loaded job: bootout → gone → bootstrap → restarted', () => {
    // print: loaded (pre-check) → gone (core wait) → bootstrap ok
    const h = harness({ printStatuses: [0, 1], bootstrapStatuses: [0] })
    expect(cycleDaemonCore('501', '/p.plist', h.deps)).toEqual({ state: 'restarted' })
    expect(h.calls.some(c => c[0] === 'bootout')).toBe(true)
    expect(h.calls.some(c => c[0] === 'bootstrap')).toBe(true)
  })

  test('not loaded → not-loaded, NOTHING booted out', () => {
    const h = harness({ printStatuses: [1] })
    expect(cycleDaemonCore('501', '/p.plist', h.deps)).toEqual({ state: 'not-loaded' })
    expect(h.calls.some(c => c[0] === 'bootout')).toBe(false)
  })

  test('bootout fails → failed loud, no bootstrap attempt', () => {
    const h = harness({ printStatuses: [0], bootoutStatus: 9 })
    const r = cycleDaemonCore('501', '/p.plist', h.deps)
    expect(r.state).toBe('failed')
    expect(r.detail).toContain('bootout failed')
    expect(h.calls.some(c => c[0] === 'bootstrap')).toBe(false)
  })

  test('job never unloads after bootout (undead beyond budget) → failed with the manual recipe', () => {
    // print: loaded (pre-check), then loaded FOREVER (the core wait + retries see it listed)
    const h = harness({ printStatuses: [0, 0] })
    const r = cycleDaemonCore('501', '/p.plist', h.deps)
    expect(r.state).toBe('failed')
    expect(r.detail).toContain('manual rescue')
  })

  test('bootstrap retries exhausted → failed with rescue hint', () => {
    // pre-check loaded → gone for the wait → every bootstrap attempt fails, re-checks stay gone
    const h = harness({ printStatuses: [0, 1], bootstrapStatuses: [5, 5, 5, 5] })
    const r = cycleDaemonCore('501', '/p.plist', h.deps)
    expect(r.state).toBe('failed')
    expect(r.detail).toContain('manual rescue')
  })
})
