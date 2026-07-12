// utf8AtomicQuanta — the stream sink's split primitive. THE invariant under test: every
// quantum must independently be VALID UTF-8 (never ends mid-character) and ≤512 bytes
// (PIPE_BUF — atomic pipe write), because SwiftBar v2.0.1 decodes every pipe chunk in
// isolation (`String(data:, .utf8)`) and a nil decode hides the menu-bar icon.
import { describe, expect, test } from 'bun:test'
import { utf8AtomicQuanta } from './index.ts'

// fatal:true throws on any byte sequence that is not self-contained valid UTF-8 —
// exactly the check SwiftBar's per-chunk String(data:) performs (nil ⇒ icon hidden).
const strictDecode = (b: Buffer): string => new TextDecoder('utf-8', { fatal: true }).decode(b)

// A realistic menu block: emoji status dots, box glyphs, SF-symbol params, Cyrillic —
// the multi-byte-dense content the tray actually streams.
function sampleBlock(repeat: number): string {
  const rows: string[] = ['~~~', '6 | sfimage=antenna.radiowaves.left.and.right', '---']
  for (let i = 0; i < repeat; i++) {
    rows.push(`● peer-${i} 🛡 живой · ⚠ 🔴${i} | color=#3fb950`)
    rows.push(`○ спящий-${i} ✕ … │ префикс ${'x'.repeat(i % 37)}`)
  }
  return rows.join('\n') + '\n'
}

describe('utf8AtomicQuanta', () => {
  test('every quantum is ≤512 bytes AND independently valid UTF-8; concat is lossless', () => {
    const s = sampleBlock(400) // ~35 KB — the live block size that reproduced the bug
    expect(Buffer.byteLength(s)).toBeGreaterThan(30_000)
    const quanta = utf8AtomicQuanta(s)
    expect(quanta.length).toBeGreaterThan(50)
    for (const q of quanta) {
      expect(q.length).toBeLessThanOrEqual(512)
      expect(q.length).toBeGreaterThan(0)
      expect(() => strictDecode(q)).not.toThrow() // ← the icon-killer if it ever throws
    }
    expect(Buffer.concat(quanta).toString('utf8')).toBe(s)
  })

  test('ANY concatenation of consecutive quanta is valid UTF-8 (what a slow reader sees)', () => {
    // availableData may return several whole quanta glued together — every contiguous
    // run must decode too (it does iff no quantum ends mid-character).
    const quanta = utf8AtomicQuanta(sampleBlock(60))
    for (let i = 0; i + 1 < quanta.length; i += 2) {
      expect(() => strictDecode(Buffer.concat([quanta[i]!, quanta[i + 1]!]))).not.toThrow()
    }
  })

  test('boundary backoff: a 4-byte emoji straddling the max boundary moves whole into the next quantum', () => {
    // 510 ASCII bytes + 🛡 (4 bytes, U+1F6E1 needs surrogates in JS but 4 UTF-8 bytes):
    // a naive 512-byte cut would split it 2/2.
    const s = 'a'.repeat(510) + '🛡️end'
    const quanta = utf8AtomicQuanta(s)
    expect(quanta[0]!.toString('utf8')).toBe('a'.repeat(510))
    for (const q of quanta) expect(() => strictDecode(q)).not.toThrow()
    expect(Buffer.concat(quanta).toString('utf8')).toBe(s)
  })

  test('ASCII passes through in plain ≤512 slices; short input is a single quantum', () => {
    expect(utf8AtomicQuanta('~~~\nshort\n').length).toBe(1)
    const big = utf8AtomicQuanta('z'.repeat(2000))
    expect(big.map(q => q.length)).toEqual([512, 512, 512, 464])
  })

  test('custom max is honored (still character-aligned)', () => {
    const quanta = utf8AtomicQuanta('●●●●●●●●●●', 7) // each ● is 3 bytes → 7-byte max fits 2
    for (const q of quanta) {
      expect(q.length).toBeLessThanOrEqual(7)
      expect(() => strictDecode(q)).not.toThrow()
    }
    expect(Buffer.concat(quanta).toString('utf8')).toBe('●●●●●●●●●●')
  })
})
