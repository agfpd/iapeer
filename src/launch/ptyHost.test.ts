import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ptyHostEnabled } from './ptyHost.ts'
import { readyGatePtyFlipEnabled } from './readyGateModel.ts'

describe('ptyHostEnabled — pty-hosting is the DEFAULT, .no-pty-host opts out', () => {
  test('ON by default (no marker needed); OFF when the .no-pty-host opt-out marker exists; per-peer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptyhost-flag-'))
    try {
      expect(ptyHostEnabled(dir, 'codex-x')).toBe(true) // DEFAULT: hosted out of the box, no marker
      writeFileSync(join(dir, 'codex-x.no-pty-host'), '') // explicit opt-OUT → tmux
      expect(ptyHostEnabled(dir, 'codex-x')).toBe(false)
      expect(ptyHostEnabled(dir, 'codex-y')).toBe(true) // opt-out is per-peer, not global — y stays default-on
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('legacy .pty-host opt-in marker is REDUNDANT (ignored); .pty-readygate is orthogonal; only .no-pty-host flips to tmux', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ptyhost-distinct-'))
    try {
      // legacy opt-in marker no longer decides anything — pty is the default with or without it
      writeFileSync(join(dir, 'codex-perplex.pty-host'), '')
      expect(ptyHostEnabled(dir, 'codex-perplex')).toBe(true)
      // the ready-gate viewport-source marker is a SEPARATE concern — it does not decide pty-hosting
      writeFileSync(join(dir, 'codex-perplex.pty-readygate'), '')
      expect(readyGatePtyFlipEnabled(dir, 'codex-perplex')).toBe(true)
      expect(ptyHostEnabled(dir, 'codex-perplex')).toBe(true) // still hosted (default)
      // only the explicit opt-out marker flips it back to tmux
      writeFileSync(join(dir, 'codex-perplex.no-pty-host'), '')
      expect(ptyHostEnabled(dir, 'codex-perplex')).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
