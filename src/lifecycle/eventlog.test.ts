// eventlog — the daemon's durable, rotated lifecycle decision log. Tests the pure
// logfmt formatter, the append path (into an explicit temp logDir — never the real
// ~/.iapeer), and the size-rotation chain. No daemon, no tmux — pure FS.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendLifecycleEvent,
  fmtValue,
  formatEventLine,
  lifecycleLogPath,
} from './eventlog.ts'

const TS = 1_749_470_400_000 // fixed epoch-ms → a stable ISO for golden lines
const ISO = new Date(TS).toISOString()

describe('fmtValue (logfmt escaping)', () => {
  test('bare token stays bare', () => {
    expect(fmtValue('reaped-idle')).toBe('reaped-idle')
    expect(fmtValue('claude-boris')).toBe('claude-boris')
    expect(fmtValue(42)).toBe('42')
  })
  test('empty string → ""', () => {
    expect(fmtValue('')).toBe('""')
  })
  test('whitespace / = / " force quoting and escape', () => {
    expect(fmtValue('session no longer live')).toBe('"session no longer live"')
    expect(fmtValue('a=b')).toBe('"a=b"')
    expect(fmtValue('say "hi"')).toBe('"say \\"hi\\""')
    expect(fmtValue('back\\slash here')).toBe('"back\\\\slash here"')
  })
})

describe('formatEventLine', () => {
  test('ts is first; fields keep insertion order; undefined skipped', () => {
    const line = formatEventLine(TS, {
      ev: 'supervise',
      identity: 'claude-boris',
      action: 'reaped-gone',
      reason: 'session no longer live',
      ref: undefined, // dropped
      outcome: 'fresh-next-msg',
    })
    expect(line).toBe(
      `ts=${ISO} ev=supervise identity=claude-boris action=reaped-gone reason="session no longer live" outcome=fresh-next-msg`,
    )
  })
  test('age field renders as a bare token', () => {
    const line = formatEventLine(TS, { ev: 'supervise', identity: 'claude-x', action: 'reaped-idle', age: '4230s' })
    expect(line).toBe(`ts=${ISO} ev=supervise identity=claude-x action=reaped-idle age=4230s`)
  })
})

describe('appendLifecycleEvent', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iapeer-eventlog-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('falsy logDir → no-op (a partial cfg never writes / never resolves a real path)', () => {
    expect(() => appendLifecycleEvent(undefined, { ev: 'supervise', identity: 'x' }, { nowMs: TS })).not.toThrow()
    expect(() => appendLifecycleEvent('', { ev: 'supervise', identity: 'x' }, { nowMs: TS })).not.toThrow()
  })

  test('writes one logfmt line per call, appended in order', () => {
    appendLifecycleEvent(dir, { ev: 'wake', personality: 'boris', mode: 'fresh', cause: 'crash-or-self-close' }, { nowMs: TS })
    appendLifecycleEvent(dir, { ev: 'supervise', identity: 'claude-doc', action: 'reaped-gone' }, { nowMs: TS + 1000 })
    const body = readFileSync(lifecycleLogPath(dir), 'utf8')
    const lines = body.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(`ts=${ISO} ev=wake personality=boris mode=fresh cause=crash-or-self-close`)
    expect(lines[1]).toContain('ev=supervise identity=claude-doc action=reaped-gone')
  })

  test('creates the log dir if absent', () => {
    const nested = join(dir, 'logs', 'iapeer')
    appendLifecycleEvent(nested, { ev: 'supervise', identity: 'x' }, { nowMs: TS })
    expect(existsSync(lifecycleLogPath(nested))).toBe(true)
  })

  test('size rotation: base → .1, oldest dropped past keep', () => {
    const env = { IAPEER_LIFECYCLE_LOG_MAX_BYTES: '120', IAPEER_LIFECYCLE_LOG_KEEP: '2' }
    const path = lifecycleLogPath(dir)
    for (let i = 0; i < 6; i++) {
      appendLifecycleEvent(dir, { ev: 'supervise', identity: `claude-peer${i}`, action: 'reaped-gone', n: i }, { env, nowMs: TS + i })
    }
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(true)
    expect(existsSync(`${path}.3`)).toBe(false) // keep=2 → never a .3
    expect(statSync(path).size).toBeLessThanOrEqual(200)
    expect(readFileSync(path, 'utf8')).toContain('claude-peer5') // newest in the live base file
  })

  test('rotation preserves chronological order across files (.N oldest, base newest)', () => {
    const env = { IAPEER_LIFECYCLE_LOG_MAX_BYTES: '90', IAPEER_LIFECYCLE_LOG_KEEP: '3' }
    const path = lifecycleLogPath(dir)
    for (let i = 0; i < 4; i++) {
      appendLifecycleEvent(dir, { ev: 'supervise', identity: `claude-p${i}` }, { env, nowMs: TS + i })
    }
    const ordered = ['.3', '.2', '.1', '']
      .map(suf => (existsSync(path + suf) ? readFileSync(path + suf, 'utf8') : ''))
      .join('')
    const seen = [...ordered.matchAll(/identity=claude-p(\d)/g)].map(m => Number(m[1]))
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(seen[seen.length - 1]).toBe(3) // newest line is p3, in the base file
  })
})
