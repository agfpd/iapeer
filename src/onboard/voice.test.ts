// onboardVoiceProvider / updateVoiceProvider — the host-phase voice-slot step and
// its cascade-update leg. Default-YES, report-only for the exit code; the PROVIDER
// writes the slot declaration (the step verifies it did). Mirrors onboard/memory but
// with voice's simplifications: init takes NO args beyond `init` (no --human/--runtime),
// and the slot carries no provision/unprovision. All writes under a temp IAPEER_ROOT.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { onboardVoiceProvider, updateVoiceProvider, DEFAULT_VOICE_PACKAGE } from './voice.ts'
import { voiceProviderPath } from '../status/index.ts'

const dirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-voicestep-'))
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
  provider: 'voice-connect',
  package: DEFAULT_VOICE_PACKAGE,
  version: '0.1.11',
  registeredAt: '2026-06-20T00:00:00Z',
  endpoint: 'http://127.0.0.1:8088',
}

describe('onboardVoiceProvider', () => {
  test('--no-voice → skipped-flag, init never invoked', async () => {
    const root = mkTmp()
    let invoked = 0
    const r = await onboardVoiceProvider({
      skip: true,
      env: envFor(root),
      runInit: () => ((invoked++), { status: 0, unavailable: false }),
    })
    expect(r.state).toBe('skipped-flag')
    expect(invoked).toBe(0)
  })

  test('same package already in the slot → already (idempotent no-op, no init call)', async () => {
    const root = mkTmp()
    writeFileSync(voiceProviderPath(envFor(root)), JSON.stringify(SLOT))
    let invoked = 0
    const r = await onboardVoiceProvider({
      env: envFor(root),
      runInit: () => ((invoked++), { status: 0, unavailable: false }),
    })
    expect(r.state).toBe('already')
    expect(r.provider?.provider).toBe('voice-connect')
    expect(invoked).toBe(0)
  })

  test('slot occupied by ANOTHER provider → refused-foreign (never silent overwrite)', async () => {
    const root = mkTmp()
    writeFileSync(voiceProviderPath(envFor(root)), JSON.stringify({ ...SLOT, provider: 'other-voice', package: '@x/other' }))
    const r = await onboardVoiceProvider({ env: envFor(root), runInit: () => ({ status: 0, unavailable: false }) })
    expect(r.state).toBe('refused-foreign')
    expect(r.detail).toMatch(/occupied .*other-voice.*uninstall/)
  })

  test('dry-run → reports the exact would-be command (init, NO extra args)', async () => {
    const root = mkTmp()
    const r = await onboardVoiceProvider({ dryRun: true, env: envFor(root) })
    expect(r.state).toBe('dry-run')
    expect(r.detail).toBe(`would run: npx -y ${DEFAULT_VOICE_PACKAGE} init`)
  })

  test('package unavailable → skipped-unavailable (SOFT skip — release order never blocks onboard)', async () => {
    const root = mkTmp()
    const r = await onboardVoiceProvider({ env: envFor(root), runInit: () => ({ status: 1, unavailable: true }) })
    expect(r.state).toBe('skipped-unavailable')
    expect(r.detail).toMatch(/not available/)
  })

  test('init ok + provider declared the slot → installed; init called with exactly [init]', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const calls: string[][] = []
    const r = await onboardVoiceProvider({
      env,
      runInit: (pkg, args) => {
        calls.push([pkg, ...args])
        writeFileSync(voiceProviderPath(env), JSON.stringify(SLOT)) // the PROVIDER writes the slot
        return { status: 0, unavailable: false }
      },
    })
    expect(r.state).toBe('installed')
    expect(r.provider?.version).toBe('0.1.11')
    expect(r.provider?.endpoint).toBe('http://127.0.0.1:8088')
    expect(calls).toEqual([[DEFAULT_VOICE_PACKAGE, 'init']])
  })

  test('--voice <pkg> override is honored in the init call', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const calls: string[][] = []
    await onboardVoiceProvider({
      env,
      package: '@x/custom-voice',
      runInit: (pkg, args) => (calls.push([pkg, ...args]), { status: 0, unavailable: false }),
    })
    expect(calls[0]?.[0]).toBe('@x/custom-voice')
  })

  test('init ok but slot NOT declared → provider-init-failed (its contract duty, surfaced)', async () => {
    const root = mkTmp()
    const r = await onboardVoiceProvider({ env: envFor(root), runInit: () => ({ status: 0, unavailable: false }) })
    expect(r.state).toBe('provider-init-failed')
    expect(r.detail).toMatch(/did not declare/)
  })

  test('init non-zero (e.g. non-tty refusal) → provider-init-failed with the exit code', async () => {
    const root = mkTmp()
    const r = await onboardVoiceProvider({ env: envFor(root), runInit: () => ({ status: 2, unavailable: false }) })
    expect(r.state).toBe('provider-init-failed')
    expect(r.detail).toMatch(/exited 2/)
  })
})

describe('updateVoiceProvider (FU12 — the voice leg of cascade update)', () => {
  const seedSlot = (root: string, version: string): void =>
    writeFileSync(voiceProviderPath(envFor(root)), JSON.stringify({ ...SLOT, version }))

  test('no slot → no-slot (nothing to update)', () => {
    const root = mkTmp()
    expect(updateVoiceProvider({ env: envFor(root) }).state).toBe('no-slot')
  })

  test('provider update advances the slot version → updated (from→to)', () => {
    const root = mkTmp()
    seedSlot(root, '0.1.10')
    const r = updateVoiceProvider({
      env: envFor(root),
      runUpdate: () => (seedSlot(root, '0.1.11'), { status: 0, unavailable: false }),
    })
    expect(r.state).toBe('updated')
    expect(r.from).toBe('0.1.10')
    expect(r.to).toBe('0.1.11')
  })

  test('slot version unchanged after run → already-latest', () => {
    const root = mkTmp()
    seedSlot(root, '0.1.11')
    const r = updateVoiceProvider({ env: envFor(root), runUpdate: () => ({ status: 0, unavailable: false }) })
    expect(r.state).toBe('already-latest')
    expect(r.from).toBe('0.1.11')
    expect(r.to).toBe('0.1.11')
  })

  test('package unreachable → skipped-unavailable (soft, not a failure)', () => {
    const root = mkTmp()
    seedSlot(root, '0.1.10')
    const r = updateVoiceProvider({ env: envFor(root), runUpdate: () => ({ status: null, unavailable: true }) })
    expect(r.state).toBe('skipped-unavailable')
  })

  test('provider update exits non-zero → failed', () => {
    const root = mkTmp()
    seedSlot(root, '0.1.10')
    const r = updateVoiceProvider({ env: envFor(root), runUpdate: () => ({ status: 1, unavailable: false }) })
    expect(r.state).toBe('failed')
  })

  test('dry-run → describes the npm exec --package command (NOT a bare npx)', () => {
    const root = mkTmp()
    seedSlot(root, '0.1.11')
    const r = updateVoiceProvider({ env: envFor(root), dryRun: true })
    expect(r.detail).toContain('npm exec --package=')
    expect(r.detail).toContain('voice-connect update')
    expect(r.detail).not.toContain('npx')
  })
})
