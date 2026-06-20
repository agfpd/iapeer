import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paneLogViewport } from './readyGateModel.ts'
import { claudeAdapter } from './adapters/claude.ts'

// The Ф1 ready-gate source swap is DARK by default and falls back to capture-pane UNCONDITIONALLY,
// so the flip can never make readiness worse than tmux today. These prove exactly that contract.
const tmps: string[] = []
const mkLogDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-rgm-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true })
})
const FALLBACK = '<<capture-pane-fallback>>'

describe('paneLogViewport session-start boundary (premature-ready race fix)', () => {
  // The pane-log is a SHARED append-only file across a peer's session lineage. A prior session almost
  // always ended idle at a claude `❯ ready` frame (prompt + bypass banner). On a FRESH wake the hosted
  // ready-gate must NOT see that stale frame as ready before the new runtime paints — else it delivers
  // into a booting session and the first message is lost. `startByte` (the log size at this session's
  // spawn) confines the render to THIS session's bytes. These prove the race AND the fix.
  const READY = '\x1b[2J\x1b[H❯ \r\n⏵⏵ bypass permissions on (shift+tab to cycle)' // a complete claude ready frame
  const BOOT = '\x1b[2J\x1b[Hbooting…\r\nLoading plugins…' // a fresh, NOT-ready boot frame

  test('THE RACE: a prior session ready frame at the tail → isInputReady TRUE with startByte=0 (would deliver prematurely)', async () => {
    const d = mkLogDir()
    const log = join(d, 'claude-x.log')
    writeFileSync(log, READY)
    const v = await paneLogViewport(log, 220, 50, 0) // default offset = pre-fix behavior
    expect(v).not.toBeNull()
    expect(claudeAdapter.isInputReady(v!)).toBe(true) // the bug: the stale frame reads as ready
  })

  test('THE FIX: render from the session-start boundary → prior frame invisible → NOT ready until the fresh runtime paints', async () => {
    const d = mkLogDir()
    const log = join(d, 'claude-x.log')
    writeFileSync(log, READY) // the PRIOR session's trailing ready frame
    const startByte = statSync(log).size // boundary captured at the fresh spawn (new session wrote nothing yet)

    // race window — fresh session spawned, has emitted nothing: the gate must NOT see the stale ready
    const vGate = await paneLogViewport(log, 220, 50, startByte)
    expect(vGate === null || !claudeAdapter.isInputReady(vGate)).toBe(true)

    // fresh session paints a boot (not-ready) frame: still not ready (correct — keep waiting)
    appendFileSync(log, BOOT)
    const vBoot = await paneLogViewport(log, 220, 50, startByte)
    expect(claudeAdapter.isInputReady(vBoot!)).toBe(false)

    // fresh session reaches its OWN ready frame: NOW ready → deliver correctly into a session that can take it
    appendFileSync(log, READY)
    const vReady = await paneLogViewport(log, 220, 50, startByte)
    expect(claudeAdapter.isInputReady(vReady!)).toBe(true)
  })

  test('trim-safety: a boundary BEYOND the current size (file shrank since capture) → SEED-tail fallback, no crash/hang', async () => {
    const d = mkLogDir()
    const log = join(d, 'claude-x.log')
    writeFileSync(log, READY)
    const bogus = statSync(log).size + 10_000 // boundary > size → capPaneLogs-mid-boot shape
    const v = await paneLogViewport(log, 220, 50, bogus)
    expect(v).not.toBeNull() // falls back to the SEED tail rather than a 0-length read
    expect(claudeAdapter.isInputReady(v!)).toBe(true) // renders the whole small file (no worse than pre-fix)
  })
})
