// Hermetic tests for the DESTRUCTIVE uninstall verb. Everything runs against an
// injected temp "host" (IAPEER_ROOT / IAPEER_BIN_DIR / IAPEER_LAUNCHAGENTS_DIR /
// HOME) with IAPEER_TEST_SANDBOX=1 and an injected sys-runner (no real launchctl /
// security). The sandbox guard guarantees a test can never touch the real install.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { executeUninstall, planUninstall, type SysRunner } from './index.ts'

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
})

describe('executeUninstall', () => {
  test('clean host → removes binary/.prev/~.iapeer/plists, strips PATH lines, bootouts jobs', () => {
    writeHost()
    const calls: string[] = []
    const run: SysRunner = (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`)
      return { status: 0, stderr: '' }
    }
    const res = executeUninstall({ env, run })
    expect(res.refused).toBeUndefined()
    expect(res.failed).toEqual([])
    // files gone
    expect(existsSync(join(root, '.local', 'bin', 'iapeer'))).toBe(false)
    expect(existsSync(join(root, '.local', 'bin', 'iapeer.prev'))).toBe(false)
    expect(existsSync(join(root, '.iapeer'))).toBe(false)
    expect(existsSync(join(root, 'LaunchAgents', 'com.agfpd.iapeer.plist'))).toBe(false)
    expect(existsSync(join(root, 'LaunchAgents', 'com.iapeer.timer.plist'))).toBe(false)
    // launchctl bootout invoked for the foundation jobs
    expect(calls.some(c => c.startsWith('launchctl bootout') && c.includes('com.agfpd.iapeer'))).toBe(true)
    expect(calls.some(c => c.startsWith('launchctl bootout') && c.includes('com.iapeer.timer'))).toBe(true)
    // profile: installer lines stripped, the user's own lines kept
    const zshrc = readFileSync(join(root, '.zshrc'), 'utf8')
    expect(zshrc).not.toContain('# Added by the iapeer installer')
    expect(zshrc).not.toContain('.local/bin:$PATH')
    expect(zshrc).toContain('export EDITOR=vim')
    expect(zshrc).toContain('alias ll=')
    // keychain conservative: NOT removed without the flag
    expect(calls.some(c => c.startsWith('security delete-identity'))).toBe(false)
  })

  test('--remove-codesign-identity → security delete-identity invoked', () => {
    writeHost()
    const calls: string[] = []
    executeUninstall({ env, removeCodesignIdentity: true, run: (c, a) => (calls.push(`${c} ${a.join(' ')}`), { status: 0, stderr: '' }) })
    expect(calls.some(c => c.includes('security delete-identity') && c.includes('iapeer Local Codesign'))).toBe(true)
  })

  test('foreign fleet → refused, NOTHING removed', () => {
    writeHost({ foreign: true })
    const res = executeUninstall({ env, run: () => ({ status: 0, stderr: '' }) })
    expect(res.refused).toBeDefined()
    expect(res.removed).toEqual([])
    expect(existsSync(join(root, '.iapeer'))).toBe(true) // fleet state untouched
    expect(existsSync(join(root, 'LaunchAgents', 'com.iapeer.boris.plist'))).toBe(true)
  })

  test('sandbox guard: refuses the REAL install paths under IAPEER_TEST_SANDBOX=1', () => {
    // Real HOME + no IAPEER_ROOT/BIN_DIR overrides → resolves to the real
    // ~/.iapeer / ~/.local/bin → must throw BEFORE touching anything.
    expect(() =>
      executeUninstall({ env: { HOME: homedir(), IAPEER_TEST_SANDBOX: '1' } as NodeJS.ProcessEnv, run: () => ({ status: 0, stderr: '' }) }),
    ).toThrow(/refusing to uninstall the REAL install/)
  })
})
