// Backbone default-yes onboard steps (design «Onboard костяка» FINAL 10.06) —
// notifier (zero questions, soft-skip on unavailability) and telegram (human peer
// via TELEGRAM_USER_ID env → the package's self-config hook; idempotent vs an
// existing natural peer). All sandboxed: IAPEER_ROOT / IAPEER_LAUNCHAGENTS_DIR
// temp dirs, IAPEER_TEST_SANDBOX skips real launchctl, injected npx/ask.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findNaturalPeer, onboardNotifierStep, onboardTelegramStep } from './steps.ts'
import { writeRuntimeManifest, type RuntimeManifest } from '../runtime/index.ts'
import { findPeer, readPeersIndex, upsertPeer } from '../registry/index.ts'

const roots: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-steps-'))
  roots.push(d)
  return d
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function envFor(root: string, path?: string): NodeJS.ProcessEnv {
  return {
    IAPEER_ROOT: join(root, 'iapeer'),
    IAPEER_LAUNCHAGENTS_DIR: join(root, 'LA'),
    IAPEER_TEST_SANDBOX: '1',
    HOME: root,
    ...(path ? { PATH: path } : {}),
  } as NodeJS.ProcessEnv
}

/** Stub launcher + recording self-config hook on a PATH dir. */
function stubBins(bin: string): { dir: string; hook: string } {
  const dir = mkTmp()
  writeFileSync(join(dir, bin), '#!/bin/sh\nexec sleep 1\n', { mode: 0o755 })
  const hook = join(dir, 'sc.sh')
  // records personality + the TELEGRAM_USER_ID it received → proves env passthrough
  writeFileSync(
    hook,
    '#!/bin/sh\nprintf "%s|%s" "$IAPEER_PEER_PERSONALITY" "$TELEGRAM_USER_ID" > "$IAPEER_ROOT/sc-$IAPEER_PEER_PERSONALITY"\nexit 0\n',
    { mode: 0o755 },
  )
  return { dir, hook }
}

describe('onboardNotifierStep (а — default-yes, zero questions)', () => {
  test('npx self-deploy → declared set provisioned', async () => {
    const root = mkTmp()
    const { dir, hook } = stubBins('notifier-runtime')
    const env = envFor(root, dir)
    const runNpx = (_pkg: string, e: NodeJS.ProcessEnv) => {
      const m: RuntimeManifest = {
        runtime: 'notifier',
        selfConfig: hook,
        peers: [
          { personality: 'timer', intelligence: 'absent' },
          { personality: 'watcher', intelligence: 'absent' },
        ],
      }
      writeRuntimeManifest(m, { env: e })
      return { ok: true }
    }
    const r = await onboardNotifierStep({ env, runNpx })
    expect(r.state).toBe('deployed')
    expect(r.peers.map(p => p.personality).sort()).toEqual(['timer', 'watcher'])
    expect(findPeer(readPeersIndex({ env }), 'timer')).not.toBeNull()
  })

  test('npx failure (no bun / unpublished / no network) → SOFT skip, not a failure', async () => {
    const env = envFor(mkTmp())
    const r = await onboardNotifierStep({ env, runNpx: () => ({ ok: false, detail: 'bun: command not found' }) })
    expect(r.state).toBe('skipped-unavailable')
    expect(r.detail).toContain('bun: command not found')
    expect(r.detail).toContain('install later')
  })

  test('package installed but manifest missing → deploy-failed (REAL break, not unavailability)', async () => {
    const env = envFor(mkTmp())
    // npx "succeeds" but self-deploys nothing — the package broke its contract
    const r = await onboardNotifierStep({ env, runNpx: () => ({ ok: true }) })
    expect(r.state).toBe('deploy-failed')
    expect(r.detail).toContain('manifest')
  })

  test('--no-notifier → skipped-flag; dry-run reports intent without touching anything', async () => {
    const env = envFor(mkTmp())
    expect((await onboardNotifierStep({ skip: true, env })).state).toBe('skipped-flag')
    const dry = await onboardNotifierStep({ dryRun: true, env })
    expect(dry.state).toBe('dry-run')
    expect(dry.detail).toContain('@agfpd/notifier-runtime')
  })

  test('idempotent re-run: manifest present → install skipped, deploy no-clobber', async () => {
    const root = mkTmp()
    const { dir, hook } = stubBins('notifier-runtime')
    const env = envFor(root, dir)
    writeRuntimeManifest(
      { runtime: 'notifier', selfConfig: hook, peers: [{ personality: 'timer', intelligence: 'absent' }] },
      { env },
    )
    let npxCalled = false
    const first = await onboardNotifierStep({ env, runNpx: () => ((npxCalled = true), { ok: true }) })
    expect(first.state).toBe('deployed')
    expect(npxCalled).toBe(false) // manifest-gated — npx never re-ran
    const second = await onboardNotifierStep({ env, runNpx: () => ({ ok: true }) })
    expect(second.state).toBe('deployed') // no-clobber re-verify
    expect(readPeersIndex({ env }).peers.filter(p => p.personality === 'timer').length).toBe(1)
  })
})

describe('onboardTelegramStep (б — human peer, идемпотентность, non-tty)', () => {
  test('flags path: creates the human peer; TELEGRAM_USER_ID reaches the self-config hook', async () => {
    const root = mkTmp()
    const { dir, hook } = stubBins('telegram-runtime')
    const env = envFor(root, dir)
    writeRuntimeManifest({ runtime: 'telegram', selfConfig: hook }, { env }) // installed (mode b — no declared peers)
    const r = await onboardTelegramStep({ human: 'Nova', userId: '123456789', env })
    expect(r.state).toBe('created')
    expect(r.personality).toBe('nova') // normalized
    const peer = findPeer(readPeersIndex({ env }), 'nova')!
    expect(peer.intelligence).toBe('natural')
    expect(peer.runtime).toBe('telegram')
    // the hook saw the user id via env (owner's contract: hook writes interfaces itself)
    expect(readFileSync(join(env.IAPEER_ROOT as string, 'sc-nova'), 'utf8')).toBe('nova|123456789')
  })

  test('IDEMPOTENT: an existing natural peer → already, NEVER a second human (boris check)', async () => {
    const env = envFor(mkTmp())
    await upsertPeer(
      { personality: 'nova', runtime: 'telegram', cwd: '/tmp/nova', intelligence: 'natural' },
      { env },
    )
    let asked = false
    const r = await onboardTelegramStep({
      env,
      ask: async () => ((asked = true), 'never'),
      isTty: true,
    })
    expect(r.state).toBe('already')
    expect(r.personality).toBe('nova')
    expect(r.detail).toContain('уже есть')
    expect(asked).toBe(false) // no questions, no install — the WHOLE step no-ops
  })

  test('non-tty without flags → refusal of the STEP (with the flag recipe), not of onboard', async () => {
    const root = mkTmp()
    const env = envFor(root)
    writeRuntimeManifest({ runtime: 'telegram' }, { env })
    const r = await onboardTelegramStep({ env, isTty: false })
    expect(r.state).toBe('refused-non-tty')
    expect(r.detail).toContain('--telegram-human')
  })

  test('tty prompt path: answers flow in; empty answer → soft refusal', async () => {
    const root = mkTmp()
    const { dir, hook } = stubBins('telegram-runtime')
    const env = envFor(root, dir)
    writeRuntimeManifest({ runtime: 'telegram', selfConfig: hook }, { env })
    const answers = ['leo', '42']
    const r = await onboardTelegramStep({ env, isTty: true, ask: async () => answers.shift() ?? '' })
    expect(r.state).toBe('created')
    expect(r.personality).toBe('leo')
    // empty answer → not now
    const env2 = envFor(mkTmp())
    writeRuntimeManifest({ runtime: 'telegram' }, { env: env2 })
    const r2 = await onboardTelegramStep({ env: env2, isTty: true, ask: async () => '' })
    expect(r2.state).toBe('refused-non-tty')
  })

  test('invalid explicit flags → invalid-input (hard): bad name / non-digit user id', async () => {
    const root = mkTmp()
    const env = envFor(root)
    writeRuntimeManifest({ runtime: 'telegram' }, { env })
    expect((await onboardTelegramStep({ human: '!!!', userId: '42', env })).state).toBe('invalid-input')
    const r = await onboardTelegramStep({ human: 'leo', userId: 'abc', env })
    expect(r.state).toBe('invalid-input')
    expect(r.detail).toContain('@userinfobot')
  })

  test('package unavailable → soft skip (step), with the install-later recipe', async () => {
    const env = envFor(mkTmp())
    const r = await onboardTelegramStep({
      human: 'leo',
      userId: '42',
      env,
      runNpx: () => ({ ok: false, detail: 'npm ERR 404' }),
    })
    expect(r.state).toBe('skipped-unavailable')
    expect(r.detail).toContain('install-runtime telegram')
  })

  test('findNaturalPeer: null on empty/no registry, found when present', async () => {
    const env = envFor(mkTmp())
    expect(findNaturalPeer(env)).toBeNull()
    await upsertPeer({ personality: 'h', runtime: 'telegram', cwd: '/tmp/h', intelligence: 'natural' }, { env })
    expect(findNaturalPeer(env)).toBe('h')
  })
})
