// onboardMemoryProvider — the host-phase memory-slot step (контракт «Слот
// памяти»). Default-YES, report-only for the exit code; the PROVIDER writes the
// slot declaration (the step verifies it did). All writes under a temp
// IAPEER_ROOT — never the live host.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { coreKnownInitArgs, onboardMemoryProvider, updateMemoryProvider, DEFAULT_MEMORY_PACKAGE } from './memory.ts'
import { memoryProviderPath } from '../status/index.ts'

const dirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-memstep-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function envFor(root: string): NodeJS.ProcessEnv {
  return { IAPEER_ROOT: root } as NodeJS.ProcessEnv
}

const SLOT = {
  provider: 'iapeer-memory',
  package: DEFAULT_MEMORY_PACKAGE,
  version: '0.1.0',
  registeredAt: '2026-06-10T00:00:00Z',
}

function registry(root: string, naturals: string[]): void {
  writeFileSync(
    join(root, 'peers-profiles.json'),
    JSON.stringify({
      version: 2,
      peers: [
        ...naturals.map(p => ({ personality: p, runtime: 'telegram', runtimes: ['telegram'], description: '', intelligence: 'natural', cwd: `/tmp/${p}` })),
        { personality: 'bot', runtime: 'claude', runtimes: ['claude'], description: '', intelligence: 'artificial', cwd: '/tmp/bot' },
      ],
    }),
  )
}

describe('coreKnownInitArgs (the EXHAUSTIVE v1 passthrough list)', () => {
  test('exactly one natural peer → --human <personality>', () => {
    const root = mkTmp()
    registry(root, ['nova'])
    expect(coreKnownInitArgs(envFor(root))).toEqual(['--human', 'nova'])
  })
  test('zero or many naturals → pass NOTHING (the provider asks itself)', () => {
    const none = mkTmp()
    registry(none, [])
    expect(coreKnownInitArgs(envFor(none))).toEqual([])
    const many = mkTmp()
    registry(many, ['nova', 'maria'])
    expect(coreKnownInitArgs(envFor(many))).toEqual([])
  })
  test('legacy intelligence "human" normalizes to natural (read-compat)', () => {
    const root = mkTmp()
    writeFileSync(
      join(root, 'peers-profiles.json'),
      JSON.stringify({ version: 2, peers: [{ personality: 'nova', runtime: 'telegram', runtimes: ['telegram'], description: '', intelligence: 'human', cwd: '/tmp/a' }] }),
    )
    expect(coreKnownInitArgs(envFor(root))).toEqual(['--human', 'nova'])
  })
  test('no registry at all → [] (never throws)', () => {
    expect(coreKnownInitArgs(envFor(mkTmp()))).toEqual([])
  })
})

describe('onboardMemoryProvider', () => {
  test('--no-memory → skipped-flag, init never invoked', async () => {
    const root = mkTmp()
    let invoked = 0
    const r = await onboardMemoryProvider({
      skip: true,
      env: envFor(root),
      runInit: () => ((invoked++), { status: 0, unavailable: false }),
    })
    expect(r.state).toBe('skipped-flag')
    expect(invoked).toBe(0)
  })

  test('same package already in the slot → already (idempotent no-op, no init call)', async () => {
    const root = mkTmp()
    writeFileSync(memoryProviderPath(envFor(root)), JSON.stringify(SLOT))
    let invoked = 0
    const r = await onboardMemoryProvider({
      env: envFor(root),
      runInit: () => ((invoked++), { status: 0, unavailable: false }),
    })
    expect(r.state).toBe('already')
    expect(r.provider?.provider).toBe('iapeer-memory')
    expect(invoked).toBe(0)
  })

  test('slot occupied by ANOTHER provider → refused-foreign (never silent overwrite)', async () => {
    const root = mkTmp()
    writeFileSync(memoryProviderPath(envFor(root)), JSON.stringify({ ...SLOT, provider: 'other-mem', package: '@x/other' }))
    const r = await onboardMemoryProvider({ env: envFor(root), runInit: () => ({ status: 0, unavailable: false }) })
    expect(r.state).toBe('refused-foreign')
    expect(r.detail).toMatch(/occupied .*other-mem.*uninstall/)
  })

  test('dry-run → reports the exact would-be command incl. --human passthrough', async () => {
    const root = mkTmp()
    registry(root, ['nova'])
    const r = await onboardMemoryProvider({ dryRun: true, env: envFor(root) })
    expect(r.state).toBe('dry-run')
    expect(r.detail).toBe(`would run: npx -y ${DEFAULT_MEMORY_PACKAGE} init --human nova`)
  })

  test('package unavailable → skipped-unavailable (SOFT skip — release order never blocks onboard)', async () => {
    const root = mkTmp()
    registry(root, [])
    const r = await onboardMemoryProvider({ env: envFor(root), runInit: () => ({ status: 1, unavailable: true }) })
    expect(r.state).toBe('skipped-unavailable')
    expect(r.detail).toMatch(/not available/)
  })

  test('init ok + provider declared the slot → installed (slot read back)', async () => {
    const root = mkTmp()
    registry(root, ['nova'])
    const env = envFor(root)
    const calls: string[][] = []
    const r = await onboardMemoryProvider({
      env,
      runInit: (pkg, args) => {
        calls.push([pkg, ...args])
        writeFileSync(memoryProviderPath(env), JSON.stringify(SLOT)) // the PROVIDER writes the slot
        return { status: 0, unavailable: false }
      },
    })
    expect(r.state).toBe('installed')
    expect(r.provider?.version).toBe('0.1.0')
    expect(calls).toEqual([[DEFAULT_MEMORY_PACKAGE, 'init', '--human', 'nova']])
  })

  test('init ok but slot NOT declared → provider-init-failed (its contract duty, surfaced)', async () => {
    const root = mkTmp()
    registry(root, [])
    const r = await onboardMemoryProvider({ env: envFor(root), runInit: () => ({ status: 0, unavailable: false }) })
    expect(r.state).toBe('provider-init-failed')
    expect(r.detail).toMatch(/did not declare/)
  })

  test('init non-zero (e.g. non-tty refusal) → provider-init-failed with the exit code', async () => {
    const root = mkTmp()
    registry(root, [])
    const r = await onboardMemoryProvider({ env: envFor(root), runInit: () => ({ status: 2, unavailable: false }) })
    expect(r.state).toBe('provider-init-failed')
    expect(r.detail).toMatch(/exited 2/)
  })
})

describe('updateMemoryProvider (FU12 — the memory leg of cascade update)', () => {
  const seedSlot = (root: string, version: string): void =>
    writeFileSync(memoryProviderPath(envFor(root)), JSON.stringify({ ...SLOT, version }))

  test('no slot → no-slot (nothing to update)', () => {
    const root = mkTmp()
    expect(updateMemoryProvider({ env: envFor(root) }).state).toBe('no-slot')
  })

  test('provider update advances the slot version → updated (from→to)', () => {
    const root = mkTmp()
    seedSlot(root, '0.1.0')
    const r = updateMemoryProvider({
      env: envFor(root),
      // simulate the provider stamping the new version into the slot
      runUpdate: () => (seedSlot(root, '0.2.0'), { status: 0, unavailable: false }),
    })
    expect(r.state).toBe('updated')
    expect(r.from).toBe('0.1.0')
    expect(r.to).toBe('0.2.0')
  })

  test('slot version unchanged after run → already-latest', () => {
    const root = mkTmp()
    seedSlot(root, '0.4.1')
    const r = updateMemoryProvider({ env: envFor(root), runUpdate: () => ({ status: 0, unavailable: false }) })
    expect(r.state).toBe('already-latest')
    expect(r.from).toBe('0.4.1')
    expect(r.to).toBe('0.4.1')
  })

  test('package unreachable → skipped-unavailable (soft, not a failure)', () => {
    const root = mkTmp()
    seedSlot(root, '0.1.0')
    const r = updateMemoryProvider({ env: envFor(root), runUpdate: () => ({ status: null, unavailable: true }) })
    expect(r.state).toBe('skipped-unavailable')
  })

  test('provider update exits non-zero → failed', () => {
    const root = mkTmp()
    seedSlot(root, '0.1.0')
    const r = updateMemoryProvider({ env: envFor(root), runUpdate: () => ({ status: 1, unavailable: false }) })
    expect(r.state).toBe('failed')
  })

  test('dry-run → describes the npm exec --package command (NOT a bare npx)', () => {
    const root = mkTmp()
    seedSlot(root, '0.1.0')
    const r = updateMemoryProvider({ env: envFor(root), dryRun: true })
    expect(r.detail).toContain('npm exec --package=')
    expect(r.detail).toContain('iapeer-memory update')
    expect(r.detail).not.toContain('npx')
  })
})
