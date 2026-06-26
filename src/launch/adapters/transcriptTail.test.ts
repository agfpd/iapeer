// lastTimestampedEntryMs — the content-time idle signal (immune to file re-touch + statusline ticks).
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { lastTimestampedEntryMs } from './transcriptTail.ts'

const tmps: string[] = []
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})
function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'iap-ttail-'))
  tmps.push(dir)
  const f = join(dir, 'session.jsonl')
  writeFileSync(f, content)
  return f
}

describe('lastTimestampedEntryMs — last meaningful transcript entry content-time', () => {
  test('returns the LAST entry that carries a timestamp', () => {
    const f = tmpFile(
      [
        JSON.stringify({ type: 'user', timestamp: '2026-06-23T08:00:00.000Z' }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-06-23T08:26:20.000Z' }),
        JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: '2026-06-23T08:26:20.300Z' }),
      ].join('\n') + '\n',
    )
    expect(lastTimestampedEntryMs(f)).toBe(Date.parse('2026-06-23T08:26:20.300Z'))
  })

  test('THE FIX: IGNORES trailing metadata entries WITHOUT a timestamp (re-touch / statusline-era churn)', () => {
    // The real last turn is 08:26; afterwards only metadata records (no `timestamp`) are appended —
    // exactly what makes the FILE-mtime falsely fresh while the session is idle. content-time must still
    // report the real last turn, not the churn (else the session never matures to idleSecs — the bug).
    const f = tmpFile(
      [
        JSON.stringify({ type: 'assistant', timestamp: '2026-06-23T08:26:20.000Z' }),
        JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: '2026-06-23T08:26:20.300Z' }),
        JSON.stringify({ type: 'mode' }), // no timestamp
        JSON.stringify({ type: 'bridge-session' }), // no timestamp
        JSON.stringify({ type: 'ai-title' }), // no timestamp
      ].join('\n') + '\n',
    )
    expect(lastTimestampedEntryMs(f)).toBe(Date.parse('2026-06-23T08:26:20.300Z'))
  })

  test('numeric timestamp accepted; null when no timestamped entry / unreadable file', () => {
    expect(lastTimestampedEntryMs(tmpFile(JSON.stringify({ type: 'x', timestamp: 1782200000000 }) + '\n'))).toBe(1782200000000)
    const meta = tmpFile(JSON.stringify({ type: 'mode' }) + '\n' + JSON.stringify({ type: 'ai-title' }) + '\n')
    expect(lastTimestampedEntryMs(meta)).toBeNull()
    expect(lastTimestampedEntryMs('/nonexistent/iap-ttail/path.jsonl')).toBeNull()
  })

  test('a partial leading line in the tail window is skipped (tailBytes truncation safe)', () => {
    const f = tmpFile(
      '{"type":"assistant","huge":"' + 'x'.repeat(100) + '" INCOMPLETE\n' +
        JSON.stringify({ type: 'assistant', timestamp: '2026-06-23T09:00:00.000Z' }) + '\n',
    )
    // tiny tail window starts mid-first-line → that fragment must be skipped, the complete last line wins
    expect(lastTimestampedEntryMs(f, 80)).toBe(Date.parse('2026-06-23T09:00:00.000Z'))
  })

  test('THE GIANT-TAIL FIX: a tail record LARGER than the window grows the window, never returns null', () => {
    // A browser peer appends base64-screenshot records that dwarf the tail window (observed 368 KB,
    // 5.6× the 64 KB default). When such a record is the TAIL, a fixed window holds only a fragment of
    // ONE line → no complete JSON → the old reader returned null, the supervisor floored at wokeAt and
    // idle-reaped the LIVE session. The adaptive window must grow and surface the giant record's real ts.
    const huge = 'A'.repeat(200_000) // a single record well beyond the small window below
    const f = tmpFile(
      [
        JSON.stringify({ type: 'user', timestamp: '2026-06-26T18:00:00.000Z' }),
        JSON.stringify({ type: 'assistant', payload: huge, timestamp: '2026-06-26T18:21:14.634Z' }),
      ].join('\n') + '\n',
    )
    // window = 1 KB ≪ the 200 KB tail record → without growth this is null (the bug); with growth → real ts
    expect(lastTimestampedEntryMs(f, 1024)).toBe(Date.parse('2026-06-26T18:21:14.634Z'))
    expect(lastTimestampedEntryMs(f, 1024)).not.toBeNull()
  })

  test('giant tail record followed by metadata WITHOUT a timestamp still reports the giant turn', () => {
    // The real last TIMESTAMPED turn is the oversized record; trailing metadata (no timestamp) sits after
    // it. The window must grow past the giant record and return ITS timestamp, not null.
    const huge = 'B'.repeat(200_000)
    const f = tmpFile(
      [
        JSON.stringify({ type: 'assistant', payload: huge, timestamp: '2026-06-26T18:21:14.634Z' }),
        JSON.stringify({ type: 'mode' }), // no timestamp
        JSON.stringify({ type: 'ai-title' }), // no timestamp
      ].join('\n') + '\n',
    )
    expect(lastTimestampedEntryMs(f, 1024)).toBe(Date.parse('2026-06-26T18:21:14.634Z'))
  })
})
