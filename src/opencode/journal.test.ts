import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastJournalSeq, readJournalFrom, readOpencodeState, recordOpencodeStopped } from './journal.ts'

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
})
