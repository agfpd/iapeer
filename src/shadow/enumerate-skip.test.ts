// Spawn-flip cutover Block 2, Ф0b-3 slice 3b — the fidelity observer SKIPS supervisor-hosted peers.
//
// The observer compares the pty-model vs LIVE TMUX. pty-hosting is now the DEFAULT, so a normal
// (unmarked) peer has no tmux to compare against — and during a flip a lingering tmux socket for it
// would surface FALSE divergences. This proves the skip fires IN enumerate even in that race (a live
// tmux session + a pane-log present): the default peer is NOT enrolled, while a `.no-pty-host` opt-out
// (tmux) sibling IS. Real-tmux, guarded (a clean CI runner has no tmux; the release machine has it —
// same pattern as routesend-wake).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSocketPath } from '../core/socket.ts'
import { enumerate } from './index.ts'

const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0

let sockDir: string
let logDir: string
const KEEP = 'keepobs' // .no-pty-host opt-out (tmux) → observed
const SKIP = 'skipobs' // default (no marker) → pty-hosted → skipped
const addrOf = (p: string) => `codex-${p}`
const sockOf = (p: string) => buildSocketPath('codex', p, sockDir)

function startTmux(personality: string): void {
  const r = spawnSync(
    'tmux',
    ['-S', sockOf(personality), 'new-session', '-d', '-x', '80', '-y', '24', '-s', addrOf(personality), 'cat'],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`tmux new-session failed: ${r.stderr}`)
}
function killTmux(personality: string): void {
  spawnSync('tmux', ['-S', sockOf(personality), 'kill-server'], { stdio: 'ignore' })
}

beforeAll(() => {
  sockDir = mkdtempSync(join(tmpdir(), 'iapeer-obs-sock-'))
  logDir = mkdtempSync(join(tmpdir(), 'iapeer-obs-log-'))
  if (!tmuxAvailable) return
  // Both peers: a live tmux session + a pane-log (so enrolment is otherwise satisfied).
  for (const p of [KEEP, SKIP]) {
    startTmux(p)
    writeFileSync(join(logDir, `${addrOf(p)}.log`), '')
  }
  // KEEP carries the `.no-pty-host` opt-OUT → it is on tmux, so the observer MUST compare it. SKIP is a
  // DEFAULT (unmarked) peer → pty-hosted → skipped even WITH a lingering live tmux session (the
  // flip-transition race the skip guards against).
  writeFileSync(join(logDir, `${addrOf(KEEP)}.no-pty-host`), '')
})

afterAll(() => {
  if (tmuxAvailable) for (const p of [KEEP, SKIP]) killTmux(p)
  rmSync(sockDir, { recursive: true, force: true })
  rmSync(logDir, { recursive: true, force: true })
})

describe.if(tmuxAvailable)('observer enumerate skips pty-default peers, compares .no-pty-host (tmux) peers', () => {
  test('a default (unmarked, pty-hosted) peer is NOT enrolled despite a live tmux session; a .no-pty-host opt-out one IS', () => {
    const models = new Map<string, any>()
    enumerate(models, { sockDir, logDir, eventLogDir: logDir })
    expect(models.has(addrOf(KEEP))).toBe(true) // .no-pty-host opt-out (tmux) → observed (live tmux + log)
    expect(models.has(addrOf(SKIP))).toBe(false) // default pty-hosted → skipped despite lingering live tmux
    for (const o of models.values()) { try { if (o.fd != null) closeSync(o.fd) } catch { /* */ } }
  })
})
