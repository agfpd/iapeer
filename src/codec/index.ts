// IAP envelope codec — encoder + decoder, both halves in one module.
//
// Encoder: inter-agent-protocol/src/lib/preamble.ts buildEnvelope (wins as-is).
// Decoder: telegram-runtime/src/cli.ts parseIapEnvelope/extractIapEnvelopes,
//   rewritten CDATA-AWARE (blueprint-v2 codec-fixes) so that an envelope whose
//   message contains `</iap>`, `</message>`, `]]>` or a literal CR round-trips
//   by FIELD-semantic equivalence, not byte-equality.
//
// Deliberately NO CR→LF fold here. The old telegram decoder did
// `xml.replace(/\r\n?/g, '\n')` to repair tmux paste (which rewrites LF→CR).
// That is a TRANSPORT concern: folding inside the codec silently destroys a
// literal CR that a caller legitimately put in the message, breaking round-trip.
// The fold lives in the transport / telegram pane-adapter, not here
// (blueprint §0.5-ish, brief: "CR→LF fold — в transport/telegram-адаптере, НЕ в codec").

import {
  IAP_INSTRUCTION,
  MAX_TOPIC_LEN,
  normalizeIntelligenceValue,
  type Intelligence,
  type Runtime,
} from '../core/constants.ts'
import { IapError } from '../core/errors.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Encoder (canon)
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvelopeInput {
  fromPersonality: string
  fromRuntime: Runtime
  fromIntelligence: Intelligence
  topic?: string
  attachments?: readonly string[]
  message: string
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function cdata(value: string): string {
  // A literal `]]>` would terminate the CDATA early. Split it across two
  // sections; the decoder reconstructs it by concatenating adjacent sections.
  return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`
}

export function buildEnvelope(input: EnvelopeInput): string {
  const attrs = [
    `from-personality="${escapeAttr(input.fromPersonality)}"`,
    `from-runtime="${escapeAttr(input.fromRuntime)}"`,
    `from-intelligence="${escapeAttr(input.fromIntelligence)}"`,
  ]
  const topic = input.topic?.trim()
  if (topic) {
    attrs.push(`topic="${escapeAttr(topic.slice(0, MAX_TOPIC_LEN))}"`)
  }
  return [
    `<iap ${attrs.join(' ')}>`,
    IAP_INSTRUCTION,
    ...(input.attachments?.length
      ? [`<attachments>${cdata(input.attachments.join('\n'))}</attachments>`]
      : []),
    `<message>${cdata(input.message)}</message>`,
    '</iap>',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// CDATA-aware low-level scan
// ─────────────────────────────────────────────────────────────────────────────

const CDATA_OPEN = '<![CDATA['
const CDATA_CLOSE = ']]>'

/**
 * Scan from `start` and return the index of the first occurrence of `needle`
 * that lies OUTSIDE any CDATA section, or -1 if none (or if an unterminated
 * CDATA section is hit — meaning the buffer is incomplete and the caller should
 * wait for more input). CDATA sections are skipped wholesale: `]]>` inside them
 * is the section terminator, never a match for `needle`.
 */
function indexOfOutsideCdata(buffer: string, needle: string, start: number): number {
  let i = start
  while (i < buffer.length) {
    if (buffer.startsWith(CDATA_OPEN, i)) {
      const term = buffer.indexOf(CDATA_CLOSE, i + CDATA_OPEN.length)
      if (term < 0) return -1 // unterminated CDATA → incomplete buffer
      i = term + CDATA_CLOSE.length
      continue
    }
    if (buffer.startsWith(needle, i)) return i
    i++
  }
  return -1
}

/**
 * Extract and decode the content of `<tag>…</tag>`, treating the body as a
 * sequence of CDATA sections (and any stray raw text) and concatenating them.
 * Concatenating adjacent CDATA sections is exactly what reverses the
 * `]]>` → `]]]]><![CDATA[>` split the encoder performs, so this both
 * (a) ignores `</tag>` / `</iap>` that appear inside CDATA, and
 * (b) reconstructs a literal `]]>` in the original payload.
 * Returns undefined when the open tag is absent or the close tag is never
 * reached outside CDATA.
 */
function readTagContent(xml: string, tag: string): string | undefined {
  const open = `<${tag}>`
  const close = `</${tag}>`
  const openIdx = xml.indexOf(open)
  if (openIdx < 0) return undefined
  let i = openIdx + open.length
  let out = ''
  while (i < xml.length) {
    if (xml.startsWith(CDATA_OPEN, i)) {
      const term = xml.indexOf(CDATA_CLOSE, i + CDATA_OPEN.length)
      if (term < 0) {
        // Unterminated CDATA — malformed; treat the remainder as raw content.
        out += xml.slice(i + CDATA_OPEN.length)
        return out
      }
      out += xml.slice(i + CDATA_OPEN.length, term)
      i = term + CDATA_CLOSE.length
      continue
    }
    if (xml.startsWith(close, i)) return out
    out += xml[i]
    i++
  }
  return undefined // close tag never found
}

// ─────────────────────────────────────────────────────────────────────────────
// Decoder
// ─────────────────────────────────────────────────────────────────────────────

export interface IapEnvelope {
  fromPersonality: string
  fromRuntime: Runtime
  fromIntelligence?: Intelligence
  topic?: string
  attachments: string[]
  message: string
}

function attrValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(`${name}="([^"]*)"`)
  const m = re.exec(attrs)
  return m ? unescapeAttr(m[1]) : undefined
}

function unescapeAttr(value: string): string {
  // Reverse escapeAttr. Order matters: &amp; LAST so an escaped "&amp;lt;"
  // in the source does not get double-decoded.
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function decodeEnvelope(xml: string): IapEnvelope {
  const open = /^<iap\s+([^>]*)>/.exec(xml.trim())
  if (!open) throw new IapError('invalid IAP envelope: missing <iap ...>')
  const fromPersonality = attrValue(open[1], 'from-personality')
  const fromRuntime = attrValue(open[1], 'from-runtime')
  if (!fromPersonality || !fromRuntime) {
    throw new IapError('invalid IAP envelope: missing from-personality/from-runtime')
  }
  // READ-COMPAT: a legacy peer (live telegram) may stamp from-intelligence="human";
  // normalize human→natural / scripted→absent, drop a genuinely unknown value.
  const fromIntelligence = normalizeIntelligenceValue(attrValue(open[1], 'from-intelligence'))
  const message = readTagContent(xml, 'message')
  if (message === undefined) throw new IapError('invalid IAP envelope: missing message')
  const attachmentsRaw = readTagContent(xml, 'attachments')
  const topic = attrValue(open[1], 'topic')
  return {
    fromPersonality,
    fromRuntime,
    ...(fromIntelligence ? { fromIntelligence } : {}),
    ...(topic ? { topic } : {}),
    attachments: attachmentsRaw
      ? attachmentsRaw.split('\n').map(item => item.trim()).filter(Boolean)
      : [],
    message,
  }
}

/**
 * Pull complete `<iap …>…</iap>` envelopes out of a streaming buffer.
 * The closing `</iap>` is located CDATA-aware, so an envelope whose message
 * body contains the literal text `</iap>` is not truncated. `rest` holds the
 * trailing bytes that do not yet form a complete envelope (incl. an envelope
 * still mid-CDATA), to be prepended to the next chunk.
 */
export function extractEnvelopes(buffer: string): { envelopes: string[]; rest: string } {
  const envelopes: string[] = []
  let rest = buffer
  while (true) {
    const start = rest.indexOf('<iap ')
    if (start < 0) {
      // Keep a small tail in case `<iap ` is split across chunk boundaries.
      return { envelopes, rest: rest.slice(Math.max(0, rest.length - '<iap '.length)) }
    }
    if (start > 0) rest = rest.slice(start)
    const close = indexOfOutsideCdata(rest, '</iap>', '<iap '.length)
    if (close < 0) return { envelopes, rest } // incomplete (or mid-CDATA) → wait
    const envelopeEnd = close + '</iap>'.length
    envelopes.push(rest.slice(0, envelopeEnd))
    rest = rest.slice(envelopeEnd)
  }
}
