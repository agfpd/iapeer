// Hermetic tests for `iapeer help` rendering — pure width math, no host access.
// Guards the FU3 fix: the old static USAGE ran long descriptions off the right edge
// and they collided with the next row on a narrow terminal. renderUsage now wraps
// the right column to the given width with a continuation indent.

import { describe, expect, test } from 'bun:test'
import { renderUsage, renderVerbHelp, helpTargetVerb, wrapText } from './index.ts'

describe('wrapText', () => {
  test('wraps to width; lines of fitting words never exceed width', () => {
    const lines = wrapText('the quick brown fox jumps over the lazy dog', 12)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(12)
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog')
  })

  test('a token longer than width keeps its own line (never split mid-token)', () => {
    const lines = wrapText('short superlongunbreakabletoken end', 10)
    expect(lines).toContain('superlongunbreakabletoken')
  })

  test('blank / whitespace input → a single empty line', () => {
    expect(wrapText('   ', 10)).toEqual([''])
    expect(wrapText('', 10)).toEqual([''])
  })
})

describe('renderUsage', () => {
  test('starts with the header and lists every important verb', () => {
    const out = renderUsage(100)
    expect(out.startsWith('usage: iapeer <verb> [args]')).toBe(true)
    for (const v of ['install', 'onboard', 'uninstall', 'verify', 'supervisor', 'default-runtime', 'send'])
      expect(out).toContain(v)
  })

  test('at width 100 no rendered line exceeds the width (overflow bug fixed)', () => {
    for (const l of renderUsage(100).split('\n')) expect(l.length).toBeLessThanOrEqual(100)
  })

  test('on a narrow terminal long descriptions WRAP instead of overflowing', () => {
    const W = 56
    const lines = renderUsage(W).split('\n')
    for (const l of lines) {
      // The only allowed overflow is a single unbreakable token (a path / identifier
      // with no internal whitespace) — never a multi-word description running long.
      if (l.length > W) expect(l.trim().split(/\s+/).length).toBe(1)
    }
    // `verify` (short sig → inline) has a long description, so it spills onto at
    // least one indented continuation line rather than overflowing its row.
    const vi = lines.findIndex(l => l.startsWith('  verify '))
    expect(vi).toBeGreaterThanOrEqual(0)
    expect(lines[vi + 1].startsWith('  ')).toBe(true)
    expect(lines[vi + 1].trim().length).toBeGreaterThan(0)
  })

  test('inline rows share one aligned description column', () => {
    const lines = renderUsage(100).split('\n')
    const col = (head: string, descWord: string): number =>
      lines.find(l => l.startsWith(`  ${head} `))!.indexOf(descWord)
    const a = col('install', 'build')
    expect(a).toBeGreaterThan(0)
    expect(col('status', 'host')).toBe(a)
    expect(col('list', 'registered')).toBe(a)
  })

  test('an over-long signature wraps onto its own line(s) before the description', () => {
    const lines = renderUsage(100).split('\n')
    // `onboard` has a signature far wider than the left column → it occupies its own
    // line and the description follows on a later (indented) line, not beside it.
    const i = lines.findIndex(l => l.startsWith('  onboard '))
    expect(i).toBeGreaterThanOrEqual(0)
    expect(lines[i]).not.toContain('backbone host-phase') // desc NOT crammed beside the long sig
    const di = lines.findIndex(l => l.includes('backbone host-phase'))
    expect(di).toBeGreaterThan(i)
  })
})

describe('renderVerbHelp + helpTargetVerb (per-verb help routing)', () => {
  test('renderVerbHelp: a known verb → its OWN focused usage, not the whole list', () => {
    const out = renderVerbHelp('connect', 100)!
    expect(out.startsWith('usage: iapeer connect telegram <peer>')).toBe(true)
    expect(out).toContain('attach a telegram bot') // its description
    expect(out).not.toContain('rollback') // NOT other verbs
  })

  test('renderVerbHelp: matches by leading token (supervisor subcommands collapse to one entry)', () => {
    expect(renderVerbHelp('supervisor', 100)).toContain('usage: iapeer supervisor up|start|attach|list|kill')
  })

  test('renderVerbHelp: unknown verb → null (caller falls back to the full usage)', () => {
    expect(renderVerbHelp('bogusverb', 100)).toBeNull()
  })

  test('helpTargetVerb: <verb> --help → the verb; help <verb> → argv[1]; bare → null', () => {
    expect(helpTargetVerb(['connect', 'telegram', '--help'])).toBe('connect')
    expect(helpTargetVerb(['connect', '--help'])).toBe('connect')
    expect(helpTargetVerb(['help', 'connect'])).toBe('connect')
    expect(helpTargetVerb(['--help'])).toBeNull()
    expect(helpTargetVerb(['-h'])).toBeNull()
    expect(helpTargetVerb(['help'])).toBeNull()
  })
})
