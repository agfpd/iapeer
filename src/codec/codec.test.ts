import { describe, expect, test } from 'bun:test'
import { buildEnvelope, decodeEnvelope, extractEnvelopes, type EnvelopeInput } from './index.ts'

// ─────────────────────────────────────────────────────────────────────────────
// WITNESS: faithful copy of the OLD telegram-runtime decoder (cli.ts:867-935).
// These reproduce the pre-fix behaviour so each adversarial test shows a real
// delta: the witness FAILS the assertion the new codec PASSES. (Brief: "тест,
// падающий ДО фикса и проходящий ПОСЛЕ".)
// ─────────────────────────────────────────────────────────────────────────────

function oldUnescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
function oldDecodeCdata(inner: string): string {
  if (!inner.startsWith('<![CDATA[') || !inner.endsWith(']]>')) return inner
  return inner.slice('<![CDATA['.length, -']]>'.length).replaceAll(']]]]><![CDATA[>', ']]>')
}
function oldTagContent(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
  const m = re.exec(xml)
  return m ? oldDecodeCdata(m[1]) : undefined
}
function oldParseMessage(xml: string): string | undefined {
  xml = xml.replace(/\r\n?/g, '\n') // the CR→LF fold the codec must NOT do
  return oldTagContent(xml, 'message')
}
function oldExtractEnvelopes(buffer: string): { envelopes: string[]; rest: string } {
  const envelopes: string[] = []
  let rest = buffer
  while (true) {
    const start = rest.indexOf('<iap ')
    if (start < 0) return { envelopes, rest: rest.slice(Math.max(0, rest.length - 8)) }
    if (start > 0) rest = rest.slice(start)
    const end = rest.indexOf('</iap>') // naive: not CDATA-aware
    if (end < 0) return { envelopes, rest }
    const envelopeEnd = end + '</iap>'.length
    envelopes.push(rest.slice(0, envelopeEnd))
    rest = rest.slice(envelopeEnd)
  }
}

const base: Omit<EnvelopeInput, 'message'> = {
  fromPersonality: 'nova',
  fromRuntime: 'telegram',
  fromIntelligence: 'natural',
  topic: 'Ф0 фундамента',
}

function roundTripMessage(message: string, extra: Partial<EnvelopeInput> = {}): string {
  const xml = buildEnvelope({ ...base, ...extra, message })
  const { envelopes, rest } = extractEnvelopes(xml)
  expect(envelopes).toHaveLength(1)
  expect(rest).toBe('')
  return decodeEnvelope(envelopes[0]).message
}

// ─────────────────────────────────────────────────────────────────────────────
// Basic round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('codec round-trip (field-semantic equivalence)', () => {
  test('preserves all fields', () => {
    const input: EnvelopeInput = {
      fromPersonality: 'boris',
      fromRuntime: 'claude',
      fromIntelligence: 'artificial',
      topic: 'checkpoint',
      attachments: ['/tmp/a.txt', '/tmp/b with space.png'],
      message: 'plain multi\nline\nmessage',
    }
    const decoded = decodeEnvelope(buildEnvelope(input))
    expect(decoded.fromPersonality).toBe(input.fromPersonality)
    expect(decoded.fromRuntime).toBe(input.fromRuntime)
    expect(decoded.fromIntelligence).toBe(input.fromIntelligence)
    expect(decoded.topic).toBe(input.topic)
    expect(decoded.attachments).toEqual([...input.attachments!])
    expect(decoded.message).toBe(input.message)
  })

  test('attr special chars (<, >, &, ") survive in personality and topic', () => {
    const xml = buildEnvelope({
      fromPersonality: 'nova',
      fromRuntime: 'telegram',
      fromIntelligence: 'natural',
      topic: 'a < b & c > d "quoted"',
      message: 'hi',
    })
    const d = decodeEnvelope(xml)
    expect(d.topic).toBe('a < b & c > d "quoted"')
  })

  test('empty message round-trips', () => {
    expect(roundTripMessage('')).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial: message contains </iap>  → extractEnvelopes must not truncate
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial: </iap> in message', () => {
  const message = 'see the closing tag </iap> right here'

  test('NEW codec: single envelope, message intact', () => {
    expect(roundTripMessage(message)).toBe(message)
  })

  test('WITNESS: old naive indexOf truncates the envelope', () => {
    const xml = buildEnvelope({ ...base, message })
    const oldFirst = oldExtractEnvelopes(xml).envelopes[0]
    // old splits at the inner </iap>, producing a shorter, broken envelope
    expect(oldFirst.length).toBeLessThan(xml.length)
    // ...and the new extractor produces the full envelope
    expect(extractEnvelopes(xml).envelopes[0]).toBe(xml)
  })

  test('NEW codec: two real envelopes, first message holds a fake </iap>', () => {
    const e1 = buildEnvelope({ ...base, message: 'fake </iap> inside' })
    const e2 = buildEnvelope({ ...base, fromPersonality: 'darwin', message: 'second' })
    const { envelopes, rest } = extractEnvelopes(e1 + '\n' + e2)
    expect(envelopes).toHaveLength(2)
    expect(rest).toBe('')
    expect(decodeEnvelope(envelopes[0]).message).toBe('fake </iap> inside')
    expect(decodeEnvelope(envelopes[1]).message).toBe('second')
    // witness: old truncates the first envelope at the inner </iap>, so its
    // first fragment is NOT the real e1 (and no longer decodes to a message)
    const oldFirst = oldExtractEnvelopes(e1 + '\n' + e2).envelopes[0]
    expect(oldFirst).not.toBe(e1)
    expect(oldTagContent(oldFirst, 'message')).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial: message contains </message>  → tag-content must not truncate
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial: </message> in message', () => {
  const message = 'a </message> b </message> c'

  test('NEW codec: message intact', () => {
    expect(roundTripMessage(message)).toBe(message)
  })

  test('WITNESS: old non-greedy regex truncates at inner </message>', () => {
    const xml = buildEnvelope({ ...base, message })
    expect(oldParseMessage(xml)).not.toBe(message)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial: message contains ]]>  → CDATA split must reconstruct
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial: ]]> in message', () => {
  test('NEW codec: literal ]]> reconstructed', () => {
    expect(roundTripMessage('a]]>b')).toBe('a]]>b')
    expect(roundTripMessage('edge ]]> at ]]> several ]]> places')).toBe(
      'edge ]]> at ]]> several ]]> places',
    )
    expect(roundTripMessage(']]>')).toBe(']]>')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial: literal CR  → codec must NOT fold (transport's job)
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial: literal CR is preserved (no fold in codec)', () => {
  const message = 'line1\rline2\r\nline3'

  test('NEW codec: CR survives round-trip', () => {
    expect(roundTripMessage(message)).toBe(message)
  })

  test('WITNESS: old decoder folds CR→LF and loses it', () => {
    const xml = buildEnvelope({ ...base, message })
    const folded = oldParseMessage(xml)
    expect(folded).not.toBe(message)
    expect(folded).toBe('line1\nline2\nline3') // proof of the lossy fold
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Headline: all four adversarial features at once
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial: combined </iap> </message> ]]> CR', () => {
  const message = 'X </iap> Y </message> Z ]]> W\rtail\nend'

  test('NEW codec: full round-trip by field semantics', () => {
    const input: EnvelopeInput = {
      ...base,
      attachments: ['/path/with ]]> weird', '/second </iap> path'],
      message,
    }
    const xml = buildEnvelope(input)
    const { envelopes, rest } = extractEnvelopes(xml)
    expect(envelopes).toHaveLength(1)
    expect(rest).toBe('')
    const d = decodeEnvelope(envelopes[0])
    expect(d.message).toBe(message)
    expect(d.attachments).toEqual(['/path/with ]]> weird', '/second </iap> path'])
    expect(d.fromPersonality).toBe('nova')
    expect(d.fromIntelligence).toBe('natural')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// extractEnvelopes streaming semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('extractEnvelopes streaming', () => {
  test('incomplete envelope kept in rest, completed on next chunk', () => {
    const xml = buildEnvelope({ ...base, message: 'streamed' })
    const cut = Math.floor(xml.length / 2)
    const first = extractEnvelopes(xml.slice(0, cut))
    expect(first.envelopes).toHaveLength(0)
    const second = extractEnvelopes(first.rest + xml.slice(cut))
    expect(second.envelopes).toHaveLength(1)
    expect(decodeEnvelope(second.envelopes[0]).message).toBe('streamed')
  })

  test('mid-CDATA cut does not falsely close on inner </iap>', () => {
    const xml = buildEnvelope({ ...base, message: 'pre </iap> post' })
    // cut right after the inner </iap> but before the CDATA terminator
    const innerIap = xml.indexOf('</iap>')
    const cut = innerIap + 3
    const first = extractEnvelopes(xml.slice(0, cut))
    expect(first.envelopes).toHaveLength(0) // must NOT emit a truncated envelope
    const second = extractEnvelopes(first.rest + xml.slice(cut))
    expect(second.envelopes).toHaveLength(1)
    expect(decodeEnvelope(second.envelopes[0]).message).toBe('pre </iap> post')
  })

  test('leading noise before <iap is discarded', () => {
    const xml = buildEnvelope({ ...base, message: 'm' })
    const { envelopes } = extractEnvelopes('garbage text\n' + xml)
    expect(envelopes).toHaveLength(1)
    expect(decodeEnvelope(envelopes[0]).message).toBe('m')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Decoder error surface
// ─────────────────────────────────────────────────────────────────────────────

describe('decodeEnvelope errors', () => {
  test('missing <iap throws', () => {
    expect(() => decodeEnvelope('no envelope here')).toThrow()
  })
  test('missing message throws', () => {
    expect(() => decodeEnvelope('<iap from-personality="a" from-runtime="claude"></iap>')).toThrow()
  })
  test('unknown from-intelligence is dropped, not invented', () => {
    const xml =
      '<iap from-personality="a" from-runtime="claude" from-intelligence="bogus">\n<message><![CDATA[x]]></message>\n</iap>'
    const d = decodeEnvelope(xml)
    expect(d.fromIntelligence).toBeUndefined()
    expect(d.message).toBe('x')
  })

  test('READ-COMPAT: legacy from-intelligence="human" decodes to natural', () => {
    const xml =
      '<iap from-personality="nova" from-runtime="telegram" from-intelligence="human">\n<message><![CDATA[hi]]></message>\n</iap>'
    expect(decodeEnvelope(xml).fromIntelligence).toBe('natural')
  })
})
