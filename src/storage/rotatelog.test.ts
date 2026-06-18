// rotatelog — the generic rotated-logfmt-append primitive (promoted from
// lifecycle/eventlog.ts when the daemon's delivery.log became the second
// producer). The logfmt formatting (fmtValue/formatEventLine) is pinned in
// lifecycle/eventlog.test.ts (its historical home, re-exported); these tests
// cover what is NEW at this layer: the path-parameterized append + rotation.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { appendRotatedEvent } from './rotatelog.ts'

const dirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-rotatelog-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('appendRotatedEvent', () => {
  test('creates the parent dir and appends one ts-stamped logfmt line', () => {
    const path = join(mkTmp(), 'deep', 'nested', 'some.log')
    appendRotatedEvent(path, { ev: 'delivery', ok: 'true', note: 'two words' }, { nowMs: 1750000000000 })
    const text = readFileSync(path, 'utf8')
    expect(text).toBe('ts=2025-06-15T15:06:40.000Z ev=delivery ok=true note="two words"\n')
  })

  test('rotates base → .1 at maxBytes and drops beyond keep', () => {
    const path = join(mkTmp(), 'r.log')
    const line = { ev: 'x', pad: 'a'.repeat(50) } // ~65 bytes/line
    // maxBytes 100 → every second append rotates; keep 1 → no .2 ever exists.
    for (let i = 0; i < 6; i++) appendRotatedEvent(path, line, { maxBytes: 100, keep: 1 })
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(false)
  })

  test('never throws on an unwritable path (best-effort observability)', () => {
    expect(() => appendRotatedEvent('/dev/null/impossible/x.log', { ev: 'x' })).not.toThrow()
  })
})
