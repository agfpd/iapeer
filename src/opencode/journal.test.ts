import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastJournalSeq, readJournalFrom, readJournalTail, readOpencodeState, recordOpencodeStopped, rotateJournalIfNeeded } from './journal.ts'

let dir: string
let paths: { state: string; events: string }
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ocj-'))
  paths = { state: join(dir, 'state.json'), events: join(dir, 'events.jsonl') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const line = (seq: number, type = 'x') => JSON.stringify({ schema: 1, seq, time: seq, identity: 'opencode-a', launchID: 'l1', sessionID: 's', type, properties: {}, nativeID: null }) + '\n'

describe('opencode journal', () => {
  test('lastJournalSeq reads the tail; absent → 0', () => {
    expect(lastJournalSeq(paths.events)).toBe(0)
    for (let i = 1; i <= 300; i++) appendFileSync(paths.events, line(i))
    expect(lastJournalSeq(paths.events)).toBe(300)
  })
  test('readJournalFrom skips a partial trailing line and resumes from end', () => {
    writeFileSync(paths.events, line(1) + line(2) + '{"seq":3')
    const a = readJournalFrom(paths.events, 0)
    expect(a.lines.map(l => l.seq)).toEqual([1, 2])
    appendFileSync(paths.events, ',"type":"y"}\n')
    expect(readJournalFrom(paths.events, a.end).lines.map(l => l.seq)).toEqual([3])
  })
  test('recordOpencodeStopped: one runtime.stopped continuing seq, state fenced; idempotent', () => {
    writeFileSync(paths.events, line(1) + line(2))
    writeFileSync(paths.state, JSON.stringify({ schema: 1, identity: 'opencode-a', cwd: '/c', sessionID: 's', launchID: 'l1', startedAt: 1, lastEventSeq: 2, lastActivityMs: 2, status: 'busy' }))
    expect(recordOpencodeStopped(paths, { reason: 'child-exit', signal: 'SIGKILL' }, 99)).toBe(true)
    const last = JSON.parse(readFileSync(paths.events, 'utf8').trim().split('\n').pop()!)
    expect(last).toMatchObject({ seq: 3, type: 'runtime.stopped', launchID: 'l1', sessionID: 's', properties: { reason: 'child-exit', signal: 'SIGKILL' } })
    expect(readOpencodeState(paths.state)).toMatchObject({ status: 'stopped', lastEventSeq: 3 })
    expect(recordOpencodeStopped(paths, { reason: 'again' })).toBe(false)
    expect(lastJournalSeq(paths.events)).toBe(3)
  })
  test('no state (never launched) → no record', () => {
    expect(recordOpencodeStopped(paths, { reason: 'x' })).toBe(false)
  })
  describe('rotation (incident 12.11: 284 MB unrotated journal)', () => {
    const append = (seq: number, rotate = 300) => { rotateJournalIfNeeded(paths.events, line(seq).length, rotate, 3); appendFileSync(paths.events, line(seq)) }
    const seqs = (text: string) => text.split('\n').filter(Boolean).map(l => JSON.parse(l).seq)
    test('live file stays bounded; generations shift and the oldest drops; newest line always live', () => {
      for (let i = 1; i <= 40; i++) append(i)
      expect(statSync(paths.events).size).toBeLessThanOrEqual(300)
      expect(existsSync(`${paths.events}.3`)).toBe(true)
      expect(existsSync(`${paths.events}.4`)).toBe(false)
      expect(lastJournalSeq(paths.events)).toBe(40)
      const all = [`${paths.events}.3`, `${paths.events}.2`, `${paths.events}.1`, paths.events].flatMap(p => seqs(readFileSync(p, 'utf8')))
      expect(all).toEqual([...all].sort((a, b) => a - b)) // order preserved across generations
      expect(all.at(-1)).toBe(40)
    })
    test('an empty live file never rotates; a single oversized line is still written', () => {
      writeFileSync(paths.events, '')
      expect(rotateJournalIfNeeded(paths.events, 10_000, 300)).toBe(false)
      expect(rotateJournalIfNeeded(join(dir, 'absent.jsonl'), 10, 1)).toBe(false)
    })
    test('lastJournalSeq falls back to .1 right after a rotation (seq stays monotonic)', () => {
      for (let i = 1; i <= 5; i++) appendFileSync(paths.events, line(i))
      rotateJournalIfNeeded(paths.events, 10_000, 100)
      expect(existsSync(paths.events)).toBe(false)
      expect(lastJournalSeq(paths.events)).toBe(5)
    })
    test('recordOpencodeStopped continues seq after a rotation (fenced by state.lastEventSeq too)', () => {
      for (let i = 1; i <= 5; i++) appendFileSync(paths.events, line(i))
      rotateJournalIfNeeded(paths.events, 10_000, 100)
      writeFileSync(paths.events, '')
      writeFileSync(paths.state, JSON.stringify({ schema: 1, identity: 'opencode-a', cwd: '/c', sessionID: 's', launchID: 'l1', startedAt: 1, lastEventSeq: 5, lastActivityMs: 5, status: 'busy' }))
      recordOpencodeStopped(paths, { reason: 'x' }, 9)
      expect(lastJournalSeq(paths.events)).toBe(6)
    })
    test('readJournalTail spans .1 + live, line-aligned; complete only when nothing older is cut', () => {
      for (let i = 1; i <= 40; i++) append(i)
      const whole = readJournalTail(paths.events, 10_000)
      const expected = [`${paths.events}.1`, paths.events].flatMap(p => seqs(readFileSync(p, 'utf8')))
      expect(seqs(whole.text)).toEqual(expected)
      expect(whole.complete).toBe(true)
      const cut = readJournalTail(paths.events, 400)
      expect(cut.complete).toBe(false)
      expect(seqs(cut.text).at(-1)).toBe(40) // every line parses: starts at a line boundary
      expect(cut.text.endsWith('\n')).toBe(true)
    })
    test('no rotation: identical to a bounded tail of the live file', () => {
      for (let i = 1; i <= 10; i++) appendFileSync(paths.events, line(i))
      expect(readJournalTail(paths.events, 10_000)).toEqual({ text: readFileSync(paths.events, 'utf8'), complete: true })
    })
  })
})
