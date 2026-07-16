import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_FIRST_LINE_BYTES, readFirstLine, readSessionSlices } from './sessionfiles.ts'

function tmp(content: string | Buffer): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'iapeer-sessionfiles-'))
  const path = join(dir, 's.jsonl')
  writeFileSync(path, content)
  return { path, dir }
}

describe('readFirstLine', () => {
  test('returns the first line without its newline', () => {
    const { path, dir } = tmp('first line here\nsecond\nthird')
    try {
      expect(readFirstLine(path)).toBe('first line here')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // THE REGRESSION. session_meta carries the peer's composed doctrine, so its single line can
  // exceed any fixed head slice. Measured live 16.07.2026: 79 KB on the peer with the biggest
  // doctrine, which then VANISHED from every cwd-attributed detector reading a 64 KB slice.
  test('reads a first line LARGER than the old 64 KB head slice (the bug)', () => {
    const cwd = '/Users/x/Peers/linus'
    // A realistic session_meta: one JSON line whose body is ~120 KB of doctrine, cwd inside it.
    const meta = JSON.stringify({ type: 'session_meta', payload: { cwd, doctrine: 'д'.repeat(120_000) } })
    const { path, dir } = tmp(meta + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }))
    try {
      const line = readFirstLine(path)
      expect(line.length).toBeGreaterThan(64 * 1024) // the old slice would have cut here
      const parsed = JSON.parse(line) // and the whole line is valid JSON, not a fragment
      expect(parsed.payload.cwd).toBe(cwd)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a single line with no newline before EOF is still returned in full', () => {
    const { path, dir } = tmp('only line, no newline')
    try {
      expect(readFirstLine(path)).toBe('only line, no newline')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('refuses a fragment: a line longer than the bound yields empty, never a truncation', () => {
    const { path, dir } = tmp('x'.repeat(5000)) // no newline
    try {
      expect(readFirstLine(path, 1000)).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('empty / missing file → empty string, never a throw', () => {
    const { path, dir } = tmp('')
    try {
      expect(readFirstLine(path)).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(readFirstLine('/no/such/file/xyz')).toBe('')
  })

  test('the default bound is generous (megabytes), not the old fixed slice', () => {
    expect(MAX_FIRST_LINE_BYTES).toBeGreaterThanOrEqual(1024 * 1024)
  })
})

describe('readSessionSlices', () => {
  test('a small file: tail is the whole file, head is empty (start already in tail)', () => {
    const { path, dir } = tmp('line1\nline2\n')
    try {
      const s = readSessionSlices(path, 128 * 1024)
      expect(s?.tail).toBe('line1\nline2\n')
      expect(s?.head).toBe('') // no separate head read needed
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a big file: tail is the last N bytes, head recovers the full first line', () => {
    const cwd = '/Users/x/Peers/linus'
    const meta = JSON.stringify({ type: 'session_meta', payload: { cwd, doctrine: 'д'.repeat(120_000) } })
    const filler = Array.from({ length: 5000 }, (_, i) => `{"type":"event_msg","i":${i}}`).join('\n')
    const marker = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })
    const { path, dir } = tmp(`${meta}\n${filler}\n${marker}`)
    try {
      const s = readSessionSlices(path, 64 * 1024) // tail smaller than the meta line
      expect(s).not.toBeNull()
      expect(s!.tail).toContain('task_started') // evidence is in the tail
      expect(s!.tail).not.toContain('session_meta') // meta is NOT in the tail (cut away)
      expect(JSON.parse(s!.head).payload.cwd).toBe(cwd) // …but head recovered it whole
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('empty / unreadable → null', () => {
    const { path, dir } = tmp('')
    try {
      expect(readSessionSlices(path, 1024)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(readSessionSlices('/no/such/file/xyz', 1024)).toBeNull()
  })
})
