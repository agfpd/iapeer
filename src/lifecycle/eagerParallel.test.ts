// Eager relaunch with parallel endpoints (live parity run 18.10): a NON-default endpoint that
// self-freshes must come back on ITS runtime when the peer keeps another session; the H5
// fleet-switch (sole session, default flipped) still re-resolves to the registry default.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLifecycleConfig, processEagerRelaunches, type LifecycleConfig, type SuperviseOutcome } from './index.ts'
import { upsertPeer } from '../registry/index.ts'

let root: string
let env: NodeJS.ProcessEnv
let cfg: LifecycleConfig
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'eager-par-'))
  env = { ...process.env, IAPEER_ROOT: join(root, 'iapeer'), HOME: root }
  cfg = loadLifecycleConfig(env)
  mkdirSync(cfg.stateDir, { recursive: true })
  await upsertPeer({ personality: 'p', runtime: 'opencode', cwd: join(root, 'p'), intelligence: 'artificial' }, { rootDir: join(root, 'iapeer') })
  await upsertPeer({ personality: 'p', runtime: 'claude', cwd: join(root, 'p'), intelligence: 'artificial' }, { rootDir: join(root, 'iapeer') })
  await upsertPeer({ personality: 'p', runtime: 'opencode', cwd: join(root, 'p'), intelligence: 'artificial' }, { rootDir: join(root, 'iapeer') }) // default back to opencode
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const out = (rt: string): SuperviseOutcome => ({ identity: `${rt}-p`, action: 'needs-eager-fresh', personality: 'p', runtime: rt })

async function run(outcomes: SuperviseOutcome[], liveIds: string[]): Promise<Array<string | undefined>> {
  const seen: Array<string | undefined> = []
  await processEagerRelaunches(cfg, outcomes, {
    env,
    sessionAliveFn: id => liveIds.includes(id),
    wakeFn: async a => {
      seen.push(a.runtime)
      return { status: 'READY', woke: true }
    },
  })
  return seen
}

describe('eager relaunch — which endpoint comes back', () => {
  test('non-default claude self-freshes while opencode is live → claude is relaunched (was: default no-op, claude lost)', async () => {
    expect(await run([out('claude')], ['opencode-p'])).toEqual(['claude'])
  })
  test('both endpoints self-fresh in the same tick → each comes back on its own runtime', async () => {
    expect(await run([out('opencode'), out('claude')], [])).toEqual(['opencode', 'claude'])
  })
  test('H5 fleet-switch: the sole session on a now non-default runtime → re-resolved to the default', async () => {
    expect(await run([out('claude')], [])).toEqual([undefined])
  })
})
