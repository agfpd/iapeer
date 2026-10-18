// Spawn-flip Ф0b-3 — transport liveness/resolution is HOST-AWARE. The canary exposed it: a genuinely
// supervisor-HOSTED peer (live supervisor .pid, NO tmux) was seen as OFFLINE by resolveDeliveryTarget/
// isPeerLive (transport had its OWN tmux-only sessionAlive, separate from the Ф0b-1 lifecycle fix), so
// routeSend mis-routed a warm hit to a wake and the post-wake verify-before-act false-failed. This
// binds the fix: a live supervisor .pid → live, even with no tmux.
//
// K3 (cfg-isolation): env is INJECTED — isPeerLive/listOnlinePeers/hostRunDir take env, so these tests
// resolve the run-dir from a per-test sandbox env and NEVER mutate the global process.env (which,
// before the fix, could read/expose the real fleet's liveness on a name collision).
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostRunDir } from '../launch/ptyHost.ts'
import { isPeerLive, listOnlinePeers } from './index.ts'

describe('isPeerLive — host-aware (spawn-flip Ф0b-3), env-isolated', () => {
  function sandbox(): { env: NodeJS.ProcessEnv; runDir: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-hostlive-'))
    const env = { ...process.env, IAPEER_ROOT: root }
    const runDir = hostRunDir(env) // resolves under the INJECTED root, not process.env
    mkdirSync(runDir, { recursive: true })
    return { env, runDir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }

  test('a LIVE supervisor .pid → live, with NO tmux session (the canary fix)', () => {
    const { env, runDir, cleanup } = sandbox()
    try {
      writeFileSync(join(runDir, 'codex-hostpeer.pid'), String(process.pid)) // a live pid = a live hosted daemon
      expect(isPeerLive('codex', 'hostpeer', undefined, env)).toBe(true)
    } finally {
      cleanup()
    }
  })

  test('no supervisor .pid and no tmux → offline', () => {
    const { env, cleanup } = sandbox()
    try {
      expect(isPeerLive('codex', 'ghostpeer', undefined, env)).toBe(false)
    } finally {
      cleanup()
    }
  })

  test('listOnlinePeers includes a live HOSTED peer (no tmux socket)', () => {
    const { env, runDir, cleanup } = sandbox()
    try {
      // supervisor listSessions enumerates by `<identity>.sock`; alive = a live `<identity>.pid`.
      writeFileSync(join(runDir, 'codex-hostpeer.sock'), '')
      writeFileSync(join(runDir, 'codex-hostpeer.pid'), String(process.pid))
      const online = listOnlinePeers(undefined, env)
      expect(online.some(p => p.runtime === 'codex' && p.personality === 'hostpeer')).toBe(true)
    } finally {
      cleanup()
    }
  })
})

describe('resolveControlTarget — an operator command addresses the DIALOGUE (default_runtime), not «specify runtime»', () => {
  async function sandbox(defaultRt: string, runtimes: string[], live: string[]) {
    const root = mkdtempSync(join(tmpdir(), 'iapeer-ctl-'))
    const env = { ...process.env, IAPEER_ROOT: root }
    const { upsertPeer } = await import('../registry/index.ts')
    await upsertPeer({ personality: 'duo', runtime: defaultRt, runtimes, cwd: join(root, 'duo'), intelligence: 'artificial' } as never, { rootDir: root })
    const runDir = hostRunDir(env)
    mkdirSync(runDir, { recursive: true })
    for (const rt of live) {
      writeFileSync(join(runDir, `${rt}-duo.sock`), '')
      writeFileSync(join(runDir, `${rt}-duo.pid`), String(process.pid))
    }
    return { env, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }
  test('two live runtimes, no runtime given → the live default (the incident: /stop answered «specify runtime»)', async () => {
    const { resolveControlTarget } = await import('./index.ts')
    const { env, cleanup } = await sandbox('opencode', ['opencode', 'claude'], ['opencode', 'claude'])
    try {
      const t = resolveControlTarget('duo', undefined, env)
      expect(t.ok && t.value.runtime).toBe('opencode')
      const explicit = resolveControlTarget('duo', 'claude', env)
      expect(explicit.ok && explicit.value.runtime).toBe('claude') // explicit stays exact
    } finally {
      cleanup()
    }
  })
  test('default asleep, exactly one other live → that session; default asleep + several live → explicit refusal', async () => {
    const { resolveControlTarget } = await import('./index.ts')
    const a = await sandbox('codex', ['codex', 'opencode'], ['opencode'])
    try {
      const t = resolveControlTarget('duo', undefined, a.env)
      expect(t.ok && t.value.runtime).toBe('opencode')
    } finally {
      a.cleanup()
    }
    const b = await sandbox('codex', ['codex', 'opencode', 'claude'], ['opencode', 'claude'])
    try {
      expect(resolveControlTarget('duo', undefined, b.env).ok).toBe(false)
    } finally {
      b.cleanup()
    }
  })
})
