// Hermetic tests for the DESTRUCTIVE uninstall verb. Everything runs against an
// injected temp "host" (IAPEER_ROOT / IAPEER_BIN_DIR / IAPEER_LAUNCHAGENTS_DIR /
// HOME) with IAPEER_TEST_SANDBOX=1 and an injected sys-runner (no real launchctl /
// security). The sandbox guard guarantees a test can never touch the real install.
//
// В56 — bootout is followed by a wait-for-gone (`launchctl print` poll): the default
// test runner answers print with non-zero (= job gone). The stuck-job test answers 0
// forever and asserts the plist is KEPT and ~/.iapeer is NOT removed.
// В55 — live pty sessions (REAL process + real pidfile+token in the supervisor
// run-dir) are stopped before ~/.iapeer is removed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { executeUninstall, planUninstall, type SysRunner } from './index.ts'
import { defaultRunDir, writePidFile } from '../supervisor/paths.ts'

let root: string
let env: NodeJS.ProcessEnv

const FOUNDATION_PLIST = '<plist><dict><key>com.iapeer.managed</key><true/></dict></plist>'
const FOREIGN_PLIST = '<plist><dict><key>Label</key><string>com.iapeer.boris</string></dict></plist>'

function writeHost(opts: { foreign?: boolean } = {}): void {
  const binDir = join(root, '.local', 'bin')
  const la = join(root, 'LaunchAgents')
  const iroot = join(root, '.iapeer')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(la, { recursive: true })
  mkdirSync(iroot, { recursive: true })
  writeFileSync(join(binDir, 'iapeer'), 'BIN')
  writeFileSync(join(binDir, 'iapeer.prev'), 'PREV')
  writeFileSync(join(iroot, 'peers-profiles.json'), '{}')
  writeFileSync(join(la, 'com.agfpd.iapeer.plist'), FOUNDATION_PLIST)
  writeFileSync(join(la, 'com.iapeer.timer.plist'), FOUNDATION_PLIST) // foundation-owned infra
  if (opts.foreign) writeFileSync(join(la, 'com.iapeer.boris.plist'), FOREIGN_PLIST) // persistent-peer fleet
  writeFileSync(
    join(root, '.zshrc'),
    'export EDITOR=vim\n\n# Added by the iapeer installer\nexport PATH="$HOME/.local/bin:$PATH"\nalias ll="ls -la"\n',
  )
}

/** В56-aware default runner: bootout ok, `launchctl print` → non-zero (job GONE). */
const goneRunner = (calls?: string[]): SysRunner => (cmd, args) => {
  calls?.push(`${cmd} ${args.join(' ')}`)
  if (cmd === 'launchctl' && args[0] === 'print') return { status: 3, stderr: 'Could not find service' }
  return { status: 0, stderr: '' }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-uninstall-'))
  env = {
    HOME: root,
    IAPEER_ROOT: join(root, '.iapeer'),
    IAPEER_BIN_DIR: join(root, '.local', 'bin'),
    IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'),
    IAPEER_TEST_SANDBOX: '1',
  } as NodeJS.ProcessEnv
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('planUninstall', () => {
  test('clean host (no foreign fleet) → full plan, not refused', () => {
    writeHost()
    const plan = planUninstall({ env })
    expect(plan.refused).toBeUndefined()
    const present = plan.items.filter(i => i.present).map(i => i.what)
    expect(present.some(w => w.includes('binary'))).toBe(true)
    expect(present.some(w => w.includes('~/.iapeer'))).toBe(true)
    expect(present.some(w => w.includes('com.agfpd.iapeer'))).toBe(true)
    expect(present.some(w => w.includes('com.iapeer.timer'))).toBe(true) // foundation-owned infra
    expect(present.some(w => w.includes('PATH line'))).toBe(true)
    // В55 — the pty-sessions step is planned (absent on this host → not present)
    const pty = plan.items.find(i => i.action === 'stop-pty-sessions')
    expect(pty).toBeDefined()
    expect(pty!.present).toBe(false)
  })

  test('foreign persistent-peer fleet present → REFUSED (H4-safe), names the peer', () => {
    writeHost({ foreign: true })
    const plan = planUninstall({ env })
    expect(plan.refused).toBeDefined()
    expect(plan.refused!.foreignLabels).toContain('com.iapeer.boris')
    expect(plan.refused!.reason).toContain('iapeer remove')
  })

  test('codesign identity kept by default; planned for removal only with the flag', () => {
    writeHost()
    const kept = planUninstall({ env }).items.find(i => i.what.includes('codesign'))
    expect(kept?.present).toBe(false)
    const forced = planUninstall({ env, removeCodesignIdentity: true }).items.find(i => i.what.includes('codesign'))
    expect(forced?.present).toBe(true)
  })

  test('В55 — a live pty session shows up in the plan by identity', () => {
    writeHost()
    const runDir = defaultRunDir(env)
    mkdirSync(runDir, { recursive: true })
    const child = Bun.spawn(['sleep', '30'])
    try {
      writePidFile(runDir, 'claude-ghost', child.pid)
      writeFileSync(join(runDir, 'claude-ghost.sock'), '') // listSessions enumerates by .sock
      const plan = planUninstall({ env })
      const pty = plan.items.find(i => i.action === 'stop-pty-sessions')
      expect(pty?.present).toBe(true)
      expect(pty?.what).toContain('claude-ghost')
    } finally {
      child.kill()
    }
  })
})

describe('executeUninstall', () => {
  test('clean host → removes binary/.prev/~.iapeer/plists, strips PATH lines, bootouts jobs', async () => {
    writeHost()
    const calls: string[] = []
    const res = await executeUninstall({ env, run: goneRunner(calls) })
    expect(res.refused).toBeUndefined()
    expect(res.failed).toEqual([])
    // files gone
    expect(existsSync(join(root, '.local', 'bin', 'iapeer'))).toBe(false)
    expect(existsSync(join(root, '.local', 'bin', 'iapeer.prev'))).toBe(false)
    expect(existsSync(join(root, '.iapeer'))).toBe(false)
    expect(existsSync(join(root, 'LaunchAgents', 'com.agfpd.iapeer.plist'))).toBe(false)
    expect(existsSync(join(root, 'LaunchAgents', 'com.iapeer.timer.plist'))).toBe(false)
    // launchctl bootout invoked for the foundation jobs; В56 — wait-for-gone polled
    expect(calls.some(c => c.startsWith('launchctl bootout') && c.includes('com.agfpd.iapeer'))).toBe(true)
    expect(calls.some(c => c.startsWith('launchctl bootout') && c.includes('com.iapeer.timer'))).toBe(true)
    expect(calls.some(c => c.startsWith('launchctl print') && c.includes('com.agfpd.iapeer'))).toBe(true)
    // profile: installer lines stripped, the user's own lines kept
    const zshrc = readFileSync(join(root, '.zshrc'), 'utf8')
    expect(zshrc).not.toContain('# Added by the iapeer installer')
    expect(zshrc).not.toContain('.local/bin:$PATH')
    expect(zshrc).toContain('export EDITOR=vim')
    expect(zshrc).toContain('alias ll=')
    // keychain conservative: NOT removed without the flag
    expect(calls.some(c => c.startsWith('security delete-identity'))).toBe(false)
  })

  test('--remove-codesign-identity → security delete-identity invoked', async () => {
    writeHost()
    const calls: string[] = []
    await executeUninstall({ env, removeCodesignIdentity: true, run: goneRunner(calls) })
    expect(calls.some(c => c.includes('security delete-identity') && c.includes('iapeer Local Codesign'))).toBe(true)
  })

  test('foreign fleet → refused, NOTHING removed', async () => {
    writeHost({ foreign: true })
    const res = await executeUninstall({ env, run: goneRunner() })
    expect(res.refused).toBeDefined()
    expect(res.removed).toEqual([])
    expect(existsSync(join(root, '.iapeer'))).toBe(true) // fleet state untouched
    expect(existsSync(join(root, 'LaunchAgents', 'com.iapeer.boris.plist'))).toBe(true)
  })

  test('В56 — a job that survives bootout FAILS its item AND blocks the ~/.iapeer removal', async () => {
    writeHost()
    // `print` keeps answering 0 → the job never unloads within the (short) window.
    const stuckRunner: SysRunner = (cmd, args) =>
      cmd === 'launchctl' && args[0] === 'print' ? { status: 0, stderr: '' } : { status: 0, stderr: '' }
    const res = await executeUninstall({ env, run: stuckRunner, launchdWaitMs: 300 })
    // both launchd items failed (daemon + infra), remove-dir refused with the reason
    expect(res.failed.some(f => f.what.includes('com.agfpd.iapeer') && /still loaded/.test(f.detail))).toBe(true)
    expect(res.failed.some(f => f.what.includes('~/.iapeer') && /NOT removed/.test(f.detail))).toBe(true)
    // the plists are KEPT (operator boots them out manually, then re-runs) and the tree survives
    expect(existsSync(join(root, 'LaunchAgents', 'com.agfpd.iapeer.plist'))).toBe(true)
    expect(existsSync(join(root, '.iapeer'))).toBe(true)
  })

  test('В55 — a LIVE pty session is stopped (real process) before ~/.iapeer is removed', async () => {
    writeHost()
    const runDir = defaultRunDir(env)
    mkdirSync(runDir, { recursive: true })
    const child = Bun.spawn(['sleep', '30'])
    try {
      writePidFile(runDir, 'claude-ghost', child.pid)
      writeFileSync(join(runDir, 'claude-ghost.sock'), '') // listSessions enumerates by .sock
      const res = await executeUninstall({ env, run: goneRunner() })
      expect(res.failed).toEqual([])
      expect(res.removed.some(w => w.includes('claude-ghost'))).toBe(true)
      // the real process was SIGTERM'd
      const exited = await Promise.race([child.exited.then(() => true), new Promise(r => setTimeout(() => r(false), 2000))])
      expect(exited).toBe(true)
      expect(existsSync(join(root, '.iapeer'))).toBe(false)
    } finally {
      try {
        child.kill(9)
      } catch {
        /* already dead — expected */
      }
    }
  })

  test('sandbox guard: refuses the REAL install paths under IAPEER_TEST_SANDBOX=1', async () => {
    // Real HOME + no IAPEER_ROOT/BIN_DIR overrides → resolves to the real
    // ~/.iapeer / ~/.local/bin → must throw BEFORE touching anything.
    await expect(
      executeUninstall({ env: { HOME: homedir(), IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv, run: goneRunner() }),
    ).rejects.toThrow(/refusing to uninstall the REAL install/)
  })
})
