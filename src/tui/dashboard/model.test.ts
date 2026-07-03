// Pure-model tests for the management dashboard (Фаза 3) — no Ink, no I/O.
import { describe, expect, test } from 'bun:test'
import {
  assemblePeerLog,
  attachFailureMessage,
  clampCursor,
  ellipsize,
  eventConcernsPeer,
  filterRows,
  formatAge,
  formatEvent,
  parseEventLine,
  scrollWindow,
} from './model.ts'
import type { PeerListing } from '../../cli/index.ts'

const row = (personality: string, description = ''): PeerListing => ({
  personality,
  default_runtime: 'claude',
  intelligence: 'artificial',
  description,
  cwd: `/tmp/${personality}`,
  runtimes: [{ runtime: 'claude', status: 'asleep' }],
})

describe('filterRows / cursor / window', () => {
  test('filter matches personality and description, case-insensitive', () => {
    const rows = [row('boris', 'PM'), row('linus', 'кодер'), row('doc', 'SRE дежурный')]
    expect(filterRows(rows, 'BOR').map(r => r.personality)).toEqual(['boris'])
    expect(filterRows(rows, 'дежур').map(r => r.personality)).toEqual(['doc'])
    expect(filterRows(rows, '')).toHaveLength(3)
  })
  test('clampCursor stays in bounds incl. empty set', () => {
    expect(clampCursor(5, 3)).toBe(2)
    expect(clampCursor(-1, 3)).toBe(0)
    expect(clampCursor(0, 0)).toBe(0)
  })
  test('scrollWindow keeps the cursor visible and never overflows', () => {
    expect(scrollWindow(0, 5, 10)).toEqual({ start: 0, end: 5 }) // fits
    const w = scrollWindow(19, 20, 5)
    expect(w.end).toBe(20)
    expect(w.end - w.start).toBe(5)
    const mid = scrollWindow(10, 20, 5)
    expect(10).toBeGreaterThanOrEqual(mid.start)
    expect(10).toBeLessThan(mid.end)
  })
})

describe('formatAge', () => {
  const now = Date.parse('2026-07-02T12:00:00Z')
  test('compact units', () => {
    expect(formatAge(now - 5_000, now)).toBe('5s')
    expect(formatAge(now - 5 * 60_000, now)).toBe('5m')
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3h')
    expect(formatAge(now - 72 * 3_600_000, now)).toBe('3d')
  })
  test('unknown → em-dash', () => {
    expect(formatAge(undefined, now)).toBe('—')
    expect(formatAge(0, now)).toBe('—')
  })
})

describe('event-log parsing', () => {
  const line =
    'ts=2026-07-02T09:42:26.245Z ev=delivery caller=claude-boris to=iapeer ok=true via=claude-iapeer woke=false ms=491 len=326'
  test('parses ts= ev= k=v lines; rejects garbage', () => {
    const e = parseEventLine(line)
    expect(e).not.toBeNull()
    expect(e!.ev).toBe('delivery')
    expect(e!.fields.to).toBe('iapeer')
    expect(parseEventLine('')).toBeNull()
    expect(parseEventLine('garbage no fields')).toBeNull()
    expect(parseEventLine('ts=notadate ev=x')).toBeNull()
  })
  test('eventConcernsPeer matches bare personality and identity suffix, not substrings', () => {
    const e = parseEventLine(line)!
    expect(eventConcernsPeer(e, 'iapeer')).toBe(true) // to= bare + via=claude-iapeer
    expect(eventConcernsPeer(e, 'boris')).toBe(true) // caller=claude-boris
    expect(eventConcernsPeer(e, 'ape')).toBe(false) // substring must NOT match
  })
  test('formatEvent: delivery ok/fail tone', () => {
    const ok = formatEvent(parseEventLine(line)!)
    expect(ok.tone).toBe('ok')
    expect(ok.text).toContain('claude-boris → iapeer ok 491ms')
    const fail = formatEvent(parseEventLine(line.replace('ok=true', 'ok=false'))!)
    expect(fail.tone).toBe('fail')
    expect(fail.text).toContain('FAIL')
  })
  test('assemblePeerLog merges both tails by timestamp and honors the limit', () => {
    const t1 = 'ts=2026-07-02T09:00:01.000Z ev=wake personality=boris runtime=claude mode=fresh'
    const t2 = 'ts=2026-07-02T09:00:02.000Z ev=delivery caller=claude-iapeer to=boris ok=true ms=10'
    const t3 = 'ts=2026-07-02T09:00:03.000Z ev=delivery caller=claude-iapeer to=linus ok=true ms=10' // other peer
    const out = assemblePeerLog([t2 + '\n' + t3, t1], 'boris', 10)
    expect(out).toHaveLength(2)
    expect(out[0]!.text).toContain('wake') // merged in ts order across files
    expect(out[1]!.text).toContain('→ boris ok')
    expect(assemblePeerLog([t2, t1], 'boris', 1)).toHaveLength(1)
  })
})

describe('attachFailureMessage (Enter-attach live incident 03.07)', () => {
  test('clean exit → null (no interruption)', () => {
    expect(attachFailureMessage({ status: 0 })).toBeNull()
  })
  test('spawn error surfaces its message', () => {
    expect(attachFailureMessage({ error: new Error('ENOENT'), status: null })).toBe('ENOENT')
  })
  test('non-zero exit surfaces — a failed child must never be silently remounted over', () => {
    expect(attachFailureMessage({ status: 1 })).toBe('iapeer attach exited with 1')
  })
  test('signal death (status null, no error) surfaces', () => {
    expect(attachFailureMessage({ status: null })).toBe('iapeer attach exited with a signal')
  })
})

describe('ellipsize', () => {
  test('truncates by code points with … tail', () => {
    expect(ellipsize('abcdef', 4)).toBe('abc…')
    expect(ellipsize('abc', 4)).toBe('abc')
    expect(ellipsize('привет-мир', 7)).toBe('привет…')
    expect(ellipsize('x', 0)).toBe('')
  })
})
