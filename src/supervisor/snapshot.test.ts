import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { readGeometry, writeGeometry, geometryPath } from './paths.ts'

// The attach catch-up is `SerializeAddon.serialize()` of the resolved model (the emulate-then-rerender
// architecture of tmux/zellij). Two things must hold and are pinned here: (1) serialize carries SGR COLOUR
// (the monochrome bug was using translateToString, which is text-only); (2) the geometry sidecar round-trips
// so the warm-deliver readers can follow a detached session's real pty size instead of assuming serve.

const feed = (t: Terminal, data: string): Promise<void> => new Promise(res => t.write(data, () => res()))

describe('attach snapshot via SerializeAddon — colour is preserved (no monochrome regression)', () => {
  test('serialize() output carries SGR colour for coloured scrollback', async () => {
    const term = new Terminal({ cols: 40, rows: 5, scrollback: 5000, allowProposedApi: true })
    const sa = new SerializeAddon()
    term.loadAddon(sa)
    // a red word, then enough lines to push it into scrollback (so it's in the serialized history, not just viewport)
    await feed(term, '\x1b[31mRED-WORD\x1b[0m normal\r\n')
    for (let i = 1; i <= 10; i++) await feed(term, `filler ${i}\r\n`)

    const snap = sa.serialize({ scrollback: term.buffer.active.baseY })
    expect(snap).toContain('\x1b[') // contains SGR escapes — NOT plain text
    expect(snap).toMatch(/\x1b\[(?:[0-9;]*;)?(?:31|38;2;|38;5;)/) // red encoded (basic / truecolor / 256)
    expect(snap).toContain('RED-WORD') // the content survives too
  })

  test('serialize() round-trips into a fresh terminal of the same size', async () => {
    const a = new Terminal({ cols: 30, rows: 4, scrollback: 5000, allowProposedApi: true })
    const sa = new SerializeAddon()
    a.loadAddon(sa)
    for (let i = 1; i <= 12; i++) await feed(a, `LINE-${i}\r\n`) // scroll some into history
    const snap = sa.serialize({ scrollback: a.buffer.active.baseY })

    const b = new Terminal({ cols: 30, rows: 4, scrollback: 5000, allowProposedApi: true })
    await feed(b, snap)
    const buf = b.buffer.active
    const rows: string[] = []
    for (let y = 0; y < buf.baseY + 4; y++) rows.push(buf.getLine(y)?.translateToString(true) ?? '')
    const joined = rows.join('\n')
    for (let i = 1; i <= 12; i++) expect(joined).toContain(`LINE-${i}`) // full history reconstructed
    // no consecutive duplicate non-empty rows (the duplication signature)
    let dup = 0
    for (let i = 1; i < rows.length; i++) if (rows[i].trim() !== '' && rows[i] === rows[i - 1]) dup++
    expect(dup).toBe(0)
  })
})

describe('geometry sidecar — follows the detached session pty size', () => {
  test('write/read round-trip; absent → null (caller falls back to HOST)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iapeer-geo-'))
    try {
      expect(readGeometry(dir, 'sess')).toBeNull() // absent → null
      writeGeometry(dir, 'sess', 90, 30)
      expect(readGeometry(dir, 'sess')).toEqual({ cols: 90, rows: 30 })
      writeGeometry(dir, 'sess', 200, 50) // a later real resize updates it
      expect(readGeometry(dir, 'sess')).toEqual({ cols: 200, rows: 50 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('malformed sidecar → null (fail-safe to HOST fallback)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iapeer-geo-'))
    try {
      writeGeometry(dir, 'sess', 0, 0) // invalid (non-positive) → write happens but read rejects
      expect(readGeometry(dir, 'sess')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
