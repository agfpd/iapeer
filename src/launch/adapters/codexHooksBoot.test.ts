// The invariant «a codex peer boots to its input with no human» (incident 18.10): hooks trust is
// re-asserted on every launch, and the verbs that wipe trust under a cwd restore what must stay.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexAdapter } from './codex.ts'
import { checkCodexHooksTrust, removeCodexHooksTrustUnder } from '../codexHooksTrust.ts'
import { removeCodexApproval } from '../../approval/install.ts'

let root: string
let cwd: string
let env: NodeJS.ProcessEnv
const memoryHooks = {
  hooks: {
    PostToolUse: [{ hooks: [{ type: 'command', command: '/x/iapeer-memory.post-write.sh' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: '/x/iapeer-memory.session-start.sh' }] }],
  },
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cxhooks-')))
  cwd = join(root, 'peer')
  mkdirSync(join(cwd, '.codex'), { recursive: true })
  mkdirSync(join(root, 'codex-home'), { recursive: true })
  env = { HOME: root, CODEX_HOME: join(root, 'codex-home') }
  writeFileSync(join(cwd, '.codex', 'hooks.json'), JSON.stringify(memoryHooks))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const states = () => checkCodexHooksTrust(join(cwd, '.codex', 'hooks.json'), env).checks.map(c => c.status)

describe('codex boot — hooks trust re-asserted on every launch', () => {
  test('trust wiped (rename round-trip / hand edit) → the next launch restores it; idempotent', () => {
    removeCodexHooksTrustUnder(cwd, env)
    expect(states()).toEqual(['missing', 'missing'])
    const spec = { personality: 'peer', runtime: 'codex', cwd, identity: 'codex-peer' } as never
    const p = codexAdapter.prepareLaunch!(spec, {}, { claudeBin: 'c', codexBin: 'x', env })
    expect(p.warnings).toBeUndefined()
    expect(states()).toEqual(['trusted', 'trusted'])
    codexAdapter.prepareLaunch!(spec, {}, { claudeBin: 'c', codexBin: 'x', env })
    expect(states()).toEqual(['trusted', 'trusted'])
  })
  test('no hooks.json → nothing to do, no warning', () => {
    rmSync(join(cwd, '.codex', 'hooks.json'))
    const p = codexAdapter.prepareLaunch!({ personality: 'peer', runtime: 'codex', cwd, identity: 'codex-peer' } as never, {}, { claudeBin: 'c', codexBin: 'x', env })
    expect(p).toEqual({ env: {} })
  })
  test('approval-mode → yolo removes OUR gated hook but the memory hooks stay trusted', () => {
    const withGate = { hooks: { ...memoryHooks.hooks, PreToolUse: [{ hooks: [{ type: 'command', command: '/Users/x/.local/bin/iapeer approval-hook' }] }] } }
    writeFileSync(join(cwd, '.codex', 'hooks.json'), JSON.stringify(withGate))
    removeCodexApproval(cwd, env)
    expect(states()).toEqual(['trusted', 'trusted'])
  })
})
