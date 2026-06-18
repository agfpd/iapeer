// Scrollback spinner strip (serve-side repaint snapshot). claude's TUI redraws its status block without
// a scroll-region, so stale spinner frames accumulate in the @xterm scrollback ring and pollute a
// reattaching operator's scroll-up. stripSpinnerScrollback drops those frames from the SCROLLBACK part
// of the serialized snapshot while keeping the live viewport (incl. the current spinner) verbatim,
// matched by STRUCTURE (gerund + … + elapsed/token or esc-to-interrupt tail), not a word-list.
import { describe, expect, test } from 'bun:test'
import { stripSpinnerScrollback } from './daemon.ts'

describe('stripSpinnerScrollback — drop stale spinner frames from served scrollback', () => {
  test('strips scrollback spinner-status lines (elapsed + tokens), keeps real history + the live viewport', () => {
    const lines = [
      'real history line 1',
      '\x1b[38;2;215;119;87m✶\x1b[39m Metamorphosing… (4m 24s · ↓ 18.4k tokens)', // scrollback spinner → drop
      'real history line 2',
      '· Quantumizing… (6m 57s · ↓ 30.0k tokens)', // scrollback spinner → drop
      // last 3 = viewport (the LIVE status block, kept verbatim incl. the current spinner)
      'real history line 3',
      '────────────',
      '✽ Brewing… (1m 59s · ↓ 6.5k tokens)',
    ].join('\r\n')
    const out = stripSpinnerScrollback(lines, 3).split('\r\n')
    expect(out).toContain('real history line 1')
    expect(out).toContain('real history line 2')
    expect(out).toContain('real history line 3')
    expect(out).toContain('✽ Brewing… (1m 59s · ↓ 6.5k tokens)') // viewport live spinner KEPT
    expect(out.some(l => /Metamorphosing/.test(l))).toBe(false)
    expect(out.some(l => /Quantumizing/.test(l))).toBe(false)
  })

  test('strips the (esc to interrupt) tail variant in scrollback', () => {
    const lines = ['history', '· Running… (esc to interrupt · 1.2k tokens)', 'vp1', 'vp2', 'vp3'].join('\r\n')
    const out = stripSpinnerScrollback(lines, 3)
    expect(out.includes('Running…')).toBe(false)
    expect(out.includes('history')).toBe(true)
  })

  test('does NOT over-strip — real content with … or (…) but no spinner tail is kept', () => {
    const lines = [
      'мы обсудили тайминг… он занял время', // … but no elapsed/token tail
      'итого вышло (5 долларов)', //          (…) but no elapsed/esc tail
      'vp1', 'vp2', 'vp3',
    ].join('\r\n')
    const out = stripSpinnerScrollback(lines, 3).split('\r\n')
    expect(out).toContain('мы обсудили тайминг… он занял время')
    expect(out).toContain('итого вышло (5 долларов)')
  })

  test('the LIVE spinner in the viewport is never stripped (no scrollback → unchanged)', () => {
    const lines = ['✶ Vibing… (3s · ↓ 1 tokens)', 'vp2', 'vp3'].join('\r\n')
    expect(stripSpinnerScrollback(lines, 3)).toBe(lines) // segs <= viewportRows → returned verbatim
  })
})
