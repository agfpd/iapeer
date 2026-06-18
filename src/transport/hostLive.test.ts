// Spawn-flip Ф0b-3 — transport liveness/resolution is HOST-AWARE. The canary exposed it: a genuinely
// supervisor-HOSTED peer (live supervisor .pid, NO tmux) was seen as OFFLINE by resolveDeliveryTarget/
// isPeerLive (transport had its OWN tmux-only sessionAlive, separate from the Ф0b-1 lifecycle fix), so
// routeSend mis-routed a warm hit to a wake and the post-wake verify-before-act false-failed. This
// binds the fix: a live supervisor .pid → live, even with no tmux.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostRunDir } from '../launch/ptyHost.ts'
import { isPeerLive, listOnlinePeers } from './index.ts'

describe('isPeerLive — host-aware (spawn-flip Ф0b-3)', () => {
  const savedRoot = process.env.IAPEER_ROOT
  let root: string | null = null
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.IAPEER_ROOT
    else process.env.IAPEER_ROOT = savedRoot
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
  })

  test('a LIVE supervisor .pid → live, with NO tmux session (the canary fix)', () => {
    root = mkdtempSync(join(tmpdir(), 'iapeer-hostlive-'))
    process.env.IAPEER_ROOT = root
    const runDir = hostRunDir() // resolves under IAPEER_ROOT
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, 'codex-hostpeer.pid'), String(process.pid)) // a live pid = a live hosted daemon
    expect(isPeerLive('codex', 'hostpeer')).toBe(true) // host-aware: no tmux, but the supervisor session is alive
  })

  test('no supervisor .pid and no tmux → offline', () => {
    root = mkdtempSync(join(tmpdir(), 'iapeer-hostlive-'))
    process.env.IAPEER_ROOT = root
    mkdirSync(hostRunDir(), { recursive: true })
    expect(isPeerLive('codex', 'ghostpeer')).toBe(false)
  })

  test('listOnlinePeers includes a live HOSTED peer (no tmux socket)', () => {
    root = mkdtempSync(join(tmpdir(), 'iapeer-hostlive-'))
    process.env.IAPEER_ROOT = root
    const runDir = hostRunDir()
    mkdirSync(runDir, { recursive: true })
    // supervisor listSessions enumerates by `<identity>.sock`; alive = a live `<identity>.pid`.
    writeFileSync(join(runDir, 'codex-hostpeer.sock'), '')
    writeFileSync(join(runDir, 'codex-hostpeer.pid'), String(process.pid))
    const online = listOnlinePeers()
    expect(online.some(p => p.runtime === 'codex' && p.personality === 'hostpeer')).toBe(true)
  })
})
