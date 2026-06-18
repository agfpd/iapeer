// normalizeNameCandidate — the shared name normalizer (normalize = slug∘translit).
// Covers the zone goldens, ASCII non-regression, writing systems (Cyrillic / Greek
// / CJK), idempotency, the ICU `№` symbol-alignment, and the fail-to-explicit edge
// (a non-transliterable / leading-digit / empty result is returned AS-IS and does
// NOT satisfy NAME_RE, so the caller can reject it rather than invent a name).

import { describe, expect, test } from 'bun:test'
import { isValidName, NAME_RE, normalizeNameCandidate as normalize } from './constants.ts'

describe('normalizeNameCandidate — zone goldens', () => {
  test.each([
    ['Café №2', 'cafe-no-2'], // accents + ICU `№ → No.` symbol alignment
    ['项目', 'xiang-mu'], // Han → pinyin WITH syllable spacing
    ['My Project', 'my-project'],
  ])('%j → %j', (input, expected) => {
    expect(normalize(input)).toBe(expected)
  })
})

describe('normalizeNameCandidate — ASCII non-regression', () => {
  test.each([
    ['iapeer', 'iapeer'],
    ['boris', 'boris'],
    ['notifier-timer', 'notifier-timer'], // hyphen preserved, not collapsed
    ['darwin', 'darwin'],
  ])('%j → %j', (input, expected) => {
    expect(normalize(input)).toBe(expected)
  })
})

describe('normalizeNameCandidate — writing systems (ICU Any-Latin; Latin-ASCII)', () => {
  test.each([
    ['Нова', 'nova'], // Cyrillic
    ['Борис', 'boris'],
    ['Наталья', 'natalya'], // matches the live registered peer "natalya"
    ['東京', 'dong-jing'], // CJK with syllable spacing
    ['北京', 'bei-jing'],
    ['Ω', 'o'], // Greek
    ['naïve', 'naive'], // Latin diacritics
    ['Köln', 'koln'],
    ['Straße', 'strasse'],
  ])('%j → %j', (input, expected) => {
    expect(normalize(input)).toBe(expected)
  })
})

describe('normalizeNameCandidate — slug rules', () => {
  test('collapses non-alnum runs to a single hyphen and trims edges', () => {
    expect(normalize('  a   b  ')).toBe('a-b')
    expect(normalize('a___b...c')).toBe('a-b-c')
    expect(normalize('--lead-and-trail--')).toBe('lead-and-trail')
  })

  test('caps length at 32 with no dangling trailing hyphen', () => {
    const long = 'a'.repeat(40)
    expect(normalize(long)).toBe('a'.repeat(32))
    // a hyphen landing exactly at the cut must not survive as a trailing hyphen
    const cut = `${'a'.repeat(31)}-bbb`
    const out = normalize(cut)
    expect(out.length).toBeLessThanOrEqual(32)
    expect(out.endsWith('-')).toBe(false)
  })
})

describe('normalizeNameCandidate — idempotency (normalize∘normalize === normalize)', () => {
  test.each(['Café №2', '项目', 'My Project', 'Нова', 'boris', 'notifier-timer', '東京'])(
    '%j is a fixed point of a second pass',
    input => {
      const once = normalize(input)
      expect(normalize(once)).toBe(once)
    },
  )
})

describe('normalizeNameCandidate — fail-to-explicit edges (returned AS-IS, not mangled)', () => {
  test.each([
    ['', ''], // empty
    ['①②③', ''], // non-transliterable circled digits → drop
    ['😀', ''], // emoji → drop
    ['---', ''], // only separators
    ['2nd', '2nd'], // leading digit survives but is NOT a valid name
    ['42', '42'],
  ])('%j → %j', (input, expected) => {
    expect(normalize(input)).toBe(expected)
  })

  test('edge results do NOT satisfy NAME_RE → caller fails-to-explicit', () => {
    for (const bad of ['', '①②③', '😀', '---', '2nd', '42']) {
      expect(isValidName(normalize(bad))).toBe(false)
    }
  })

  test('valid goldens DO satisfy NAME_RE', () => {
    for (const good of ['cafe-no-2', 'xiang-mu', 'my-project', 'iapeer', 'nova']) {
      expect(NAME_RE.test(good)).toBe(true)
    }
  })
})
