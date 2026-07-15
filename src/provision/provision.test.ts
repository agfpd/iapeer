// provisionPeer — one-call peer creation: profile + registry (+ infra plist with a
// PINNED launcher). All registry/plist writes go under IAPEER_ROOT /
// IAPEER_LAUNCHAGENTS_DIR temp dirs so the suite never touches the live fleet.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { provisionPeer } from './index.ts'
import { peerProfilePath } from '../storage/index.ts'
import { readPeerProfile } from '../identity/index.ts'
import { findPeer, readPeersIndex } from '../registry/index.ts'
import { existingAlwaysOnPlists, isFoundationOwnedPlist, resolveAlwaysOnTarget } from '../launch/index.ts'

const roots: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-prov-'))
  roots.push(d)
  return d
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function fakeBinDir(name = 'notifier-runtime'): { dir: string; bin: string } {
  const dir = mkTmp()
  const bin = join(dir, name)
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return { dir, bin }
}
function envFor(root: string, path?: string): NodeJS.ProcessEnv {
  return {
    IAPEER_ROOT: join(root, 'iapeer'),
    IAPEER_LAUNCHAGENTS_DIR: join(root, 'LA'),
    HOME: root,
    ...(path ? { PATH: path } : {}),
  } as NodeJS.ProcessEnv
}

describe('provisionPeer', () => {
  test('infra (notifier): writes profile + registry + plist with a pinned abs launcher', async () => {
    const root = mkTmp()
    const { dir: bindir, bin } = fakeBinDir()
    const env = envFor(root, bindir)
    const cwd = join(root, 'timer') // basename → personality 'timer'

    const r = await provisionPeer({ cwd, runtime: 'notifier', env })

    expect(r.personality).toBe('timer')
    expect(r.intelligence).toBe('absent') // notifier zone default
    expect(r.runtimeBin).toBe(bin)
    // local profile
    expect(existsSync(peerProfilePath(cwd))).toBe(true)
    expect(readPeerProfile(cwd)!.runtime).toBe('notifier')
    // registry entry (daemon reads this for tool-list / findPeer / wake)
    expect(findPeer(readPeersIndex({ env }), 'timer')?.cwd).toBe(cwd)
    // plist pins the launcher to an abs path (launchd minimal PATH safe);
    // multi-infra scheme: a fresh personality gets the per-runtime plist
    const plist = resolveAlwaysOnTarget('timer', 'notifier', env).path
    expect(plist.endsWith('com.iapeer.timer.notifier.plist')).toBe(true)
    expect(r.plistPath).toBe(plist)
    expect(existsSync(plist)).toBe(true)
    expect(isFoundationOwnedPlist(plist)).toBe(true)
    const xml = readFileSync(plist, 'utf8')
    expect(xml).toContain('<key>NOTIFIER_RUNTIME_BIN</key>')
    expect(xml).toContain(`<string>${bin}</string>`)
  })

  test('infra with unresolvable launcher → REFUSED (no profile, no registry, no plist)', async () => {
    const root = mkTmp()
    const env = envFor(root, join(root, 'empty')) // PATH dir without notifier-runtime
    const cwd = join(root, 'timer')

    await expect(provisionPeer({ cwd, runtime: 'notifier', env })).rejects.toThrow(/not found on PATH|launcher/i)

    expect(existsSync(peerProfilePath(cwd))).toBe(false)
    expect(findPeer(readPeersIndex({ env }), 'timer')).toBeNull()
    expect(existingAlwaysOnPlists('timer', env)).toEqual([]) // no plist of either scheme
  })

  test('warm-on-demand (claude): profile + registry, NO plist (no launcher needed)', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const cwd = join(root, 'worker')

    const r = await provisionPeer({ cwd, runtime: 'claude', env })

    expect(r.plistPath).toBeUndefined()
    expect(r.runtimeBin).toBeUndefined()
    expect(existsSync(peerProfilePath(cwd))).toBe(true)
    expect(findPeer(readPeersIndex({ env }), 'worker')?.runtime).toBe('claude')
    expect(existingAlwaysOnPlists('worker', env)).toEqual([]) // agentic → no plist of either scheme
  })

  test('В36 — description persists in the LOCAL profile and SURVIVES reindexFromLocals', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const cwd = join(root, 'described')

    await provisionPeer({ cwd, runtime: 'claude', env, description: 'спец по каталогам Volvo' })

    // (1) the local profile — the source of truth — carries it (was registry-only → wiped)
    expect(readPeerProfile(cwd)?.description).toBe('спец по каталогам Volvo')
    // (2) the registry row carries it
    expect(findPeer(readPeersIndex({ env }), 'described')?.description).toBe('спец по каталогам Volvo')
    // (3) the trigger that USED to wipe it: reindex projects locals over the registry
    const { reindexFromLocals } = await import('../identity/profileStandard.ts')
    await reindexFromLocals({ env })
    expect(findPeer(readPeersIndex({ env }), 'described')?.description).toBe('спец по каталогам Volvo')

    // (4) re-provision WITHOUT a description keeps it; WITH a new one updates it
    await provisionPeer({ cwd, runtime: 'claude', env })
    expect(readPeerProfile(cwd)?.description).toBe('спец по каталогам Volvo')
    await provisionPeer({ cwd, runtime: 'claude', env, description: 'обновлённое описание' })
    expect(readPeerProfile(cwd)?.description).toBe('обновлённое описание')
  })

  test('provisions an infra peer when personality === cwd basename; REJECTS a mismatch (1:1 invariant)', async () => {
    const root = mkTmp()
    const { dir: bindir } = fakeBinDir()
    const env = envFor(root, bindir)
    // matching basename → provisions (the only legitimate shape)
    const cwd = join(root, 'timer')
    const r = await provisionPeer({ cwd, runtime: 'notifier', personality: 'timer', env })
    expect(r.personality).toBe('timer')
    expect(existsSync(resolveAlwaysOnTarget('timer', 'notifier', env).path)).toBe(true)
    expect(findPeer(readPeersIndex({ env }), 'timer')?.cwd).toBe(cwd)
    // personality ≠ normalize(basename(cwd)) → rejected (no silent drift)
    await expect(
      provisionPeer({ cwd: join(root, 'some-dir'), runtime: 'notifier', personality: 'timer', env }),
    ).rejects.toThrow(/must equal the normalized cwd basename|1:1/)
  })

  // ─── A1: faceless absent service bot on a channel runtime ──────────────────
  test('A1: telegram + intelligence=absent → BOTH the local profile AND the registry are absent (no split-brain)', async () => {
    const root = mkTmp()
    const { dir: bindir } = fakeBinDir('telegram-runtime')
    const env = envFor(root, bindir)
    const cwd = join(root, 'approval')

    const r = await provisionPeer({ cwd, runtime: 'telegram', intelligence: 'absent', env })

    expect(r.intelligence).toBe('absent')
    expect(readPeerProfile(cwd)!.intelligence).toBe('absent') // LOCAL profile absent, not the telegram natural default
    expect(findPeer(readPeersIndex({ env }), 'approval')?.intelligence).toBe('absent') // registry agrees
  })

  test('A1: telegram WITHOUT an explicit nature stays natural (existing peers unchanged)', async () => {
    const root = mkTmp()
    const { dir: bindir } = fakeBinDir('telegram-runtime')
    const env = envFor(root, bindir)
    const cwd = join(root, 'arthur')
    const r = await provisionPeer({ cwd, runtime: 'telegram', env })
    expect(r.intelligence).toBe('natural')
    expect(readPeerProfile(cwd)!.intelligence).toBe('natural')
  })

  test('A1: an out-of-set nature fails LOUD (artificial on telegram = an LLM agent on a human channel)', async () => {
    const root = mkTmp()
    const { dir: bindir } = fakeBinDir('telegram-runtime')
    const env = envFor(root, bindir)
    const cwd = join(root, 'bot')
    await expect(provisionPeer({ cwd, runtime: 'telegram', intelligence: 'artificial', env })).rejects.toThrow(/not valid for runtime "telegram"/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// wake_policy:"ephemeral" provision warnings (M2 edge cases — warn, not refuse)
// ─────────────────────────────────────────────────────────────────────────────

describe('provisionPeer ephemeral warnings', () => {
  test('ephemeral + interfaces.telegram → WARN (ephemeral wins; human dialogue should not die-after-reply)', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const cwd = join(root, 'wtg')
    // pre-existing profile (provision returns it unchanged) carrying the bad combo
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      peerProfilePath(cwd),
      JSON.stringify({
        personality: 'wtg',
        runtime: 'claude',
        intelligence: 'natural',
        interfaces: { telegram: { user_id: 1 } },
        wake_policy: 'ephemeral',
      }),
    )
    const warns: string[] = []
    await provisionPeer({ cwd, runtime: 'claude', env, warn: m => warns.push(m) })
    expect(warns.some(w => /ephemeral/.test(w) && /telegram/.test(w))).toBe(true)
  })

  test('plain ephemeral worker (claude, no telegram) → NO ephemeral warn', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const cwd = join(root, 'weph')
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      peerProfilePath(cwd),
      JSON.stringify({ personality: 'weph', runtime: 'claude', wake_policy: 'ephemeral' }),
    )
    const warns: string[] = []
    await provisionPeer({ cwd, runtime: 'claude', env, warn: m => warns.push(m) })
    expect(warns.filter(w => /ephemeral/.test(w))).toEqual([])
  })

  test('ephemeral + always-on infra runtime → WARN (H4: launchd owns it, the policy is inert)', async () => {
    const root = mkTmp()
    const { dir: bindir } = fakeBinDir()
    const env = envFor(root, bindir)
    const cwd = join(root, 'winf')
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      peerProfilePath(cwd),
      JSON.stringify({ personality: 'winf', runtime: 'notifier', wake_policy: 'ephemeral' }),
    )
    const warns: string[] = []
    await provisionPeer({ cwd, runtime: 'notifier', env, warn: m => warns.push(m) })
    expect(warns.some(w => /ephemeral/.test(w) && /inert|launchd/i.test(w))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Birth-time native-memory lever (slot contract §Native-память): an OCCUPIED
// slot gates the automatic lever at provision; empty slot → untouched.
// ─────────────────────────────────────────────────────────────────────────────

describe('provisionPeer birth-time native-memory lever', () => {
  test('slot OCCUPIED → claude+codex levers written + codex cwd pre-trusted', async () => {
    const root = mkTmp()
    const env = envFor(root)
    // occupy the slot (as the provider's init would)
    mkdirSync(join(root, 'iapeer'), { recursive: true })
    writeFileSync(
      join(root, 'iapeer', 'memory-provider.json'),
      JSON.stringify({ provider: 'iapeer-memory', package: '@agfpd/iapeer-memory', version: '0.1.0', registeredAt: 'x' }),
    )
    const cwd = join(root, 'wnat')
    mkdirSync(join(cwd, '.iapeer'), { recursive: true })
    writeFileSync(
      peerProfilePath(cwd),
      JSON.stringify({ personality: 'wnat', runtime: 'claude', runtimes: ['claude', 'codex'] }),
    )
    await provisionPeer({ cwd, runtime: 'claude', env })
    expect(JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')).autoMemoryEnabled).toBe(false)
    expect(readFileSync(join(cwd, '.codex', 'config.toml'), 'utf8')).toContain('memories = false')
    // codex newborn pre-trusted in the GLOBAL codex config (HOME-scoped → temp root).
    // Codex keys trust on the RESOLVED real path (macOS /var → /private/var), so the
    // entry must carry realpath(cwd) — the literal-path miss was a live-caught bug.
    const { realpathSync } = await import('fs')
    expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')).toContain(`[projects."${realpathSync(cwd)}"]`)
  })

  test('slot EMPTY → native memory untouched (legitimate without a provider)', async () => {
    const root = mkTmp()
    const env = envFor(root)
    const cwd = join(root, 'wbare')
    await provisionPeer({ cwd, runtime: 'claude', env })
    expect(existsSync(join(cwd, '.claude', 'settings.json'))).toBe(false)
    expect(existsSync(join(cwd, '.codex', 'config.toml'))).toBe(false)
  })

  test('LEGACY v1.1 plugin block in the declaration → ignored entirely (form removed 11.06, ADR-017); native lever still applies', async () => {
    const root = mkTmp()
    const env = envFor(root)
    mkdirSync(join(root, 'iapeer'), { recursive: true })
    writeFileSync(
      join(root, 'iapeer', 'memory-provider.json'),
      JSON.stringify({
        provider: 'iapeer-memory',
        package: '@agfpd/iapeer-memory',
        version: '0.1.0',
        registeredAt: 'x',
        // a stale v1.1 declaration on a legacy host — the core no longer parses it
        plugin: { name: 'iapeer-memory', marketplace: 'agfpd', marketplaceRef: 'agfpd/agfpd-marketplace' },
      }),
    )
    const cwd = join(root, 'wplug')
    const warns: string[] = []
    const r = await provisionPeer({ cwd, runtime: 'claude', env, warn: m => warns.push(m) })
    expect(r.personality).toBe('wplug')
    expect(warns).toEqual([]) // no install attempt, no warn — the block is unknown noise
    // the native lever still applied (same slot-gated block)
    expect(JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8')).autoMemoryEnabled).toBe(false)
  })

  test('v1.2: slot with provision command → birth shells into it per runtime (occasion=birth); a legacy plugin block alongside is inert', async () => {
    const root = mkTmp()
    const env = envFor(root)
    mkdirSync(join(root, 'iapeer'), { recursive: true })
    const journal = join(root, 'journal.txt')
    const script = join(root, 'fake-provider.sh')
    const { chmodSync } = await import('fs')
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${journal}'\n`)
    chmodSync(script, 0o755)
    writeFileSync(
      join(root, 'iapeer', 'memory-provider.json'),
      JSON.stringify({
        provider: 'iapeer-memory',
        package: '@agfpd/iapeer-memory',
        version: '0.2.0',
        registeredAt: 'x',
        // legacy plugin block alongside (stale declaration) — must be inert
        plugin: { name: 'iapeer-memory', marketplace: 'agfpd', marketplaceRef: 'agfpd/agfpd-marketplace' },
        provision: {
          command: script,
          args: ['provision-peer', '--cwd', '{cwd}', '--runtime', '{runtime}', '--personality', '{personality}', '--occasion', '{occasion}'],
        },
      }),
    )
    const cwd = join(root, 'wprov')
    const warns: string[] = []
    const r = await provisionPeer({ cwd, runtime: 'claude', env, warn: m => warns.push(m) })
    expect(r.personality).toBe('wprov')
    expect(warns).toEqual([]) // provision ok → no warn at all
    const j = readFileSync(journal, 'utf8').split('\n')
    expect(j[0]).toBe('provision-peer')
    expect(j.slice(1, 9)).toEqual(['--cwd', cwd, '--runtime', 'claude', '--personality', 'wprov', '--occasion', 'birth'])
  })

  test('v1.2: provision command FAILS → LOUD warn (provider-side repair), provision of the peer still SUCCEEDS (best-effort)', async () => {
    const root = mkTmp()
    const env = envFor(root)
    mkdirSync(join(root, 'iapeer'), { recursive: true })
    const script = join(root, 'fake-provider.sh')
    const { chmodSync } = await import('fs')
    writeFileSync(script, `#!/bin/sh\necho 'vault offline' >&2\nexit 9\n`)
    chmodSync(script, 0o755)
    writeFileSync(
      join(root, 'iapeer', 'memory-provider.json'),
      JSON.stringify({
        provider: 'iapeer-memory',
        package: '@agfpd/iapeer-memory',
        version: '0.2.0',
        registeredAt: 'x',
        provision: { command: script, args: ['{occasion}'] },
      }),
    )
    const cwd = join(root, 'wfail')
    const warns: string[] = []
    const r = await provisionPeer({ cwd, runtime: 'claude', env, warn: m => warns.push(m) })
    expect(r.personality).toBe('wfail') // birth completed despite the provider hiccup
    const w = warns.find(x => x.includes('memory provision'))
    expect(w).toBeDefined()
    expect(w).toContain('FAILED')
    expect(w).toContain('vault offline')
    expect(w).toContain("re-run the provider's provision") // provider-side repair, no core verb named
  })
})
