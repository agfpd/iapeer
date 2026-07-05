// render — PURE SwiftBar formatter tests: golden structure from a fixed snapshot, the
// degraded down-block, sorting, badges, and the submenu-separator regression. No IO.

import { describe, expect, test } from 'bun:test'
import { fmtAge, fmtUptime, renderDaemonDown, renderSwiftBar, type TraySnapshot } from './render.ts'

const BIN = '/Users/me/.local/bin/iapeer'
const NOW = 1_751_731_200_000

const SNAP: TraySnapshot = {
  version: '0.4.64',
  host: {
    version: '0.4.64',
    uptimeSecs: 7565, // 2h 6m
    memory: { provider: 'iapeer-memory', version: '0.4.17', heartbeatAgeSecs: 11 },
    voice: { provider: 'voice-connect', version: '0.2.0', heartbeatAgeSecs: null },
    fda: true,
  },
  peers: [
    // deliberately out of order: an asleep-only peer first, a live one second
    { personality: 'zeno', runtimes: [{ runtime: 'claude', status: 'asleep' }], attached: false, launchd_managed: false, wake_policy: 'warm' },
    {
      personality: 'boris',
      runtimes: [
        { runtime: 'claude', status: 'live', attached: true },
        { runtime: 'codex', status: 'asleep' },
      ],
      last_active_ms: NOW - 7 * 60_000,
      attached: true,
      launchd_managed: false,
      wake_policy: 'warm',
    },
    { personality: 'timer', runtimes: [{ runtime: 'notifier', status: 'live' }], attached: false, launchd_managed: true, wake_policy: 'warm' },
    {
      personality: 'scriber',
      runtimes: [{ runtime: 'claude', status: 'asleep' }],
      attached: false,
      launchd_managed: false,
      wake_policy: 'ephemeral',
      queue_depth: 3,
    },
    { personality: 'aida', runtimes: [{ runtime: 'claude', status: 'stopped' }], attached: false, launchd_managed: false, wake_policy: 'warm' },
    // an UNKNOWN future field must be ignored, not throw (client obligation 2)
    { personality: 'nova', runtimes: [{ runtime: 'claude', status: 'live' }], attached: false, launchd_managed: false, wake_policy: 'warm', model: 'opus' } as unknown as TraySnapshot['peers'][number],
  ],
}

describe('renderSwiftBar', () => {
  const out = renderSwiftBar(SNAP, { binPath: BIN, now: NOW })
  const lines = out.split('\n')

  test('menu-bar title = live-peer count + antenna icon', () => {
    // live peers: boris, timer, nova → 3
    expect(lines[0]).toBe('3 | sfimage=antenna.radiowaves.left.and.right')
    expect(lines[1]).toBe('---')
  })

  test('host header + providers line', () => {
    expect(out).toContain('iapeer 0.4.64 · up 2h 6m | color=#8b949e')
    // mem heartbeat fresh (11s) → ●; voice heartbeat null → ○
    expect(out).toContain('mem ● 0.4.17 · voice ○ 0.2.0 | color=#8b949e')
  })

  test('attachable row is a DIRECT attach action (terminal=false, no submenu) — click → attach', () => {
    const row = lines.find(l => l.startsWith('boris '))!
    expect(row).toContain('claude● codex○')
    expect(row).toContain('color=#3fb950')
    // routed through tray attach-term (opens a .command via `open`), terminal=false
    expect(row).toContain(`bash=${BIN} param1=tray param2=attach-term param3=boris terminal=false`)
    expect(row).toContain('👤') // a human is attached
    // the row must NOT be a submenu parent (the line right after is another top-level row)
    const i = lines.indexOf(row)
    expect(lines[i + 1]!.startsWith('--')).toBe(false)
  })

  test('NO row uses terminal=true (SwiftBar Cmd-T keystroke needs Accessibility — avoided)', () => {
    expect(out).not.toContain('terminal=true')
  })

  test('launchd/infra peers are NOT attachable (plain status row, no bash action)', () => {
    const timerRow = lines.find(l => l.startsWith('timer '))!
    expect(timerRow).toContain('🔒')
    expect(timerRow).not.toContain('bash=')
    expect(timerRow).not.toContain('attach-term')
  })

  test('badges: ephemeral queue depth on an attachable peer', () => {
    expect(lines.find(l => l.startsWith('scriber '))!).toContain('⏳3')
  })

  test('Manage submenu carries per-peer lifecycle commands (kept off the rows)', () => {
    expect(lines.some(l => l.startsWith('Manage'))).toBe(true)
    expect(out).toContain('\n--boris\n') // a peer sub-submenu parent at depth 1
    // no refresh=true — the SSE stream reflects the outcome (streamable is always fresh)
    expect(out).toContain(`----Wake | bash=${BIN} param1=tray param2=cmd param3=wake param4=boris terminal=false`)
    expect(out).not.toContain('refresh=true')
    expect(out).toContain('param3=interrupt param4=boris')
  })

  test('sorting: live peers first, then asleep, then stopped; alpha within a group', () => {
    const peerRows = lines.filter(l => /^[a-z]+ {2}/.test(l)).map(l => l.split(' ')[0])
    // live: boris, nova, timer | asleep: scriber, zeno | stopped: aida
    expect(peerRows).toEqual(['boris', 'nova', 'timer', 'scriber', 'zeno', 'aida'])
  })

  test('no explicit Refresh item in the reachable-daemon menu (streamable is always fresh)', () => {
    expect(out).not.toContain('Refresh | refresh=true')
  })

  test('unknown snapshot fields do not break rendering', () => {
    expect(out).toContain('nova ')
  })
})

describe('renderSwiftBar edge cases', () => {
  test('empty fleet renders a placeholder, still valid', () => {
    const out = renderSwiftBar({ version: '0.4.64', peers: [] }, { binPath: BIN, now: NOW })
    expect(out.split('\n')[0]).toBe('0 | sfimage=antenna.radiowaves.left.and.right')
    expect(out).toContain('no peers registered')
  })
})

describe('renderDaemonDown', () => {
  const out = renderDaemonDown('no daemon address (router.json missing)', { binPath: BIN })
  test('distinct red icon + reason + retry', () => {
    expect(out.split('\n')[0]).toBe(' | sfimage=exclamationmark.triangle.fill color=#f85149')
    expect(out).toContain('iapeer daemon unreachable | color=#f85149')
    expect(out).toContain('no daemon address (router.json missing) | color=#8b949e')
    expect(out).toContain('Refresh | refresh=true sfimage=arrow.clockwise')
  })
})

describe('time helpers', () => {
  test('fmtUptime', () => {
    expect(fmtUptime(45)).toBe('45s')
    expect(fmtUptime(90)).toBe('1m')
    expect(fmtUptime(3660)).toBe('1h 1m')
    expect(fmtUptime(90000)).toBe('1d 1h')
    expect(fmtUptime(-1)).toBe('?')
  })
  test('fmtAge', () => {
    expect(fmtAge(NOW - 10_000, NOW)).toBe('now')
    expect(fmtAge(NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(fmtAge(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
    expect(fmtAge(NOW - 2 * 86_400_000, NOW)).toBe('2d ago')
  })
})
