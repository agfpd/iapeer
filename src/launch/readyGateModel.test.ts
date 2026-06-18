import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logReadyGateCrossCheck, paneLogViewport, readyGatePtyFlipEnabled, readyGateViewport } from './readyGateModel.ts'
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

describe('readyGatePtyFlipEnabled (per-peer flip flag, canary-first)', () => {
  test('absent marker → off; present marker → on', () => {
    const d = mkLogDir()
    expect(readyGatePtyFlipEnabled(d, 'codex-x')).toBe(false)
    writeFileSync(join(d, 'codex-x.pty-readygate'), '')
    expect(readyGatePtyFlipEnabled(d, 'codex-x')).toBe(true)
  })
})

describe('readyGateViewport (Ф1 viewport-source swap, tmux-fallback)', () => {
  test('flag OFF → the capture-pane fallback VERBATIM (byte-identical to today, no model built)', async () => {
    const d = mkLogDir()
    expect(await readyGateViewport({ logDir: d, identity: 'codex-x', fallback: FALLBACK, cols: 80, rows: 24 })).toBe(FALLBACK)
  })

  test('flag ON + a pane-log → the MODEL viewport (source swapped), not the fallback', async () => {
    const d = mkLogDir()
    writeFileSync(join(d, 'codex-x.pty-readygate'), '')
    writeFileSync(join(d, 'codex-x.log'), '\x1b[24;1H› ready prompt here') // render a codex '›' prompt row
    const v = await readyGateViewport({ logDir: d, identity: 'codex-x', fallback: FALLBACK, cols: 80, rows: 24 })
    expect(v).not.toBe(FALLBACK) // the source was swapped to the model
    expect(v).toContain('› ready prompt here') // the model rendered the prompt the predicate keys on
  })

  test('flag ON but the pane-log is MISSING → fallback (never worse than tmux)', async () => {
    const d = mkLogDir()
    writeFileSync(join(d, 'codex-x.pty-readygate'), '')
    expect(await readyGateViewport({ logDir: d, identity: 'codex-x', fallback: FALLBACK, cols: 80, rows: 24 })).toBe(FALLBACK)
  })

  test('flag ON but geometry is unknown (0x0) → fallback', async () => {
    const d = mkLogDir()
    writeFileSync(join(d, 'codex-x.pty-readygate'), '')
    writeFileSync(join(d, 'codex-x.log'), '\x1b[24;1H› ready')
    expect(await readyGateViewport({ logDir: d, identity: 'codex-x', fallback: FALLBACK, cols: 0, rows: 0 })).toBe(FALLBACK)
  })
})

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

describe('logReadyGateCrossCheck (serving-path soak observability)', () => {
  test('appends a record with diverged computed; agreement → false, mismatch → true', () => {
    const d = mkLogDir()
    logReadyGateCrossCheck(d, { identity: 'codex-x', modelReady: true, captureReady: false, geom: '220x50', nowISO: '2026-06-14T00:00:00Z' })
    logReadyGateCrossCheck(d, { identity: 'codex-x', modelReady: true, captureReady: true, geom: '220x50', nowISO: '2026-06-14T00:00:05Z' })
    const lines = readFileSync(join(d, 'readygate-flip.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines[0].diverged).toBe(true) // model ahead of capture
    expect(lines[0].modelReady).toBe(true)
    expect(lines[0].captureReady).toBe(false)
    expect(lines[1].diverged).toBe(false) // agreement
  })
  test('no event-log dir → no-op (never blocks the ready-gate)', () => {
    expect(() => logReadyGateCrossCheck(undefined, { identity: 'x', modelReady: true, captureReady: true, geom: '1x1', nowISO: 't' })).not.toThrow()
  })
})
