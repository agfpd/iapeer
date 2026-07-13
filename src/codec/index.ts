// IAP envelope codec — wire encoder + read-both decoder + agent-facing render.
//
// Three halves (envelope-compaction F, 0.4.86):
//   buildEnvelope          → the WIRE form (legacy attr names, always-CDATA, full-ISO ts) —
//                            what bridges parse and durable stores hold; never slims.
//   decodeEnvelope         → READ-BOTH (legacy + compact names, <message>/<msg>, ts),
//                            CDATA-AWARE so a body containing `</iap>`, `</message>`,
//                            `]]>` or a literal CR round-trips by FIELD-semantic
//                            equivalence, not byte-equality.
//   renderEnvelopeForAgent → the compact presentation for LLM-context hops (bottom).
//
// Historic origin: encoder from inter-agent-protocol preamble.ts; decoder from
// telegram-runtime parseIapEnvelope/extractIapEnvelopes. The sibling runtimes run
// their own copies of the decoder, SYNCED to this canon 14.07.2026 (telegram-runtime
// 0.26.0, notifier-runtime 0.3.6, voicetalk-runtime 0.1.1 — anchored attrValue, В37/В38,
// read-both); a decoder-behavior change here should be mirrored there (or flagged to
// their implementers). The wire form stays compatible with all of them regardless.
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
  /** ISO-8601 LOCAL instant with offset (formatSentAt) — the moment the router
   *  ACCEPTED the send; the same string is returned to the sender as the `ts`
   *  field of its send_to_peer result, so recipient-side `ts` and sender-side
   *  `ts` correspond literally. Rendered as the `ts` open-tag attribute.
   *  ADDITIVE and optional: every known envelope consumer reads attributes by
   *  NAME and ignores unknown ones; absent on legacy envelopes. On the WIRE this
   *  is always the FULL date-time (durable stores — disk queues, pane logs —
   *  must be unambiguous); the agent-facing render compacts it (see
   *  renderEnvelopeForAgent). */
  sentAt?: string
  topic?: string
  attachments?: readonly string[]
  message: string
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Format a Date as ISO-8601 LOCAL time with numeric offset, second precision:
 *  `2026-07-14T01:23:45+03:00`. Local (not UTC-Z) on purpose: the fleet's agents
 *  compare envelope timestamps against their LOCAL statusline clock — a Z-form
 *  invites silent off-by-offset misreads by an LLM reader. */
export function formatSentAt(date: Date): string {
  const offMin = -date.getTimezoneOffset() // minutes EAST of UTC
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  )
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

/** WIRE encoder — the canonical durable form (disk queues, bridge deliveries,
 *  pane logs): legacy attribute names + always-CDATA body, so every deployed
 *  sibling parser (telegram-/notifier-/voicetalk-runtime) keeps working
 *  unchanged. `ts` is the only additive attribute (envelope-compaction F).
 *  Agent-bound deliveries are re-rendered compactly at the LAST hop — see
 *  renderEnvelopeForAgent; the wire form itself never slims (its bytes cost no
 *  tokens; only the LLM-context presentation does). */
export function buildEnvelope(input: EnvelopeInput): string {
  const attrs = [
    `from-personality="${escapeAttr(input.fromPersonality)}"`,
    `from-runtime="${escapeAttr(input.fromRuntime)}"`,
    `from-intelligence="${escapeAttr(input.fromIntelligence)}"`,
  ]
  if (input.sentAt) attrs.push(`ts="${escapeAttr(input.sentAt)}"`)
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
  // В37 — the OPEN tag must be located CDATA-aware too (the close-side already was): a
  // message whose CDATA body QUOTES `<attachments>…</attachments>` otherwise minted
  // phantom attachments, and a quoted `<message>` corrupted the decoded message.
  const openIdx = indexOfOutsideCdata(xml, open, 0)
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
  /** The sender's dispatch instant (`ts` attribute) — full local ISO on the wire;
   *  absent on legacy envelopes. */
  sentAt?: string
  topic?: string
  attachments: string[]
  message: string
}

/** NAME-ANCHORED attribute lookup. The anchor `(^|\s)` is load-bearing: the old
 *  unanchored regex made `runtime="` match the TAIL of `from-runtime="…"` (and
 *  `intelligence="` the tail of `from-intelligence="…"`) — a latent mine that the
 *  read-both decoder below would have stepped on (the short-name lookup must NOT
 *  be satisfied by a legacy long-name attribute). */
function attrValue(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}="([^"]*)"`)
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

/** READ-BOTH decoder: accepts the legacy wire names (`from-personality` /
 *  `from-runtime` / `from-intelligence`, `<message>`) AND the compact
 *  presentation names (`from` / `runtime` / `intelligence`, `<msg>`) — so any
 *  envelope form ever emitted on this host (wire, agent-facing render, historic
 *  transcripts) decodes. Short names win when both are present. */
export function decodeEnvelope(xml: string): IapEnvelope {
  const open = /^<iap\s+([^>]*)>/.exec(xml.trim())
  if (!open) throw new IapError('invalid IAP envelope: missing <iap ...>')
  const fromPersonality = attrValue(open[1], 'from') ?? attrValue(open[1], 'from-personality')
  const fromRuntime = attrValue(open[1], 'runtime') ?? attrValue(open[1], 'from-runtime')
  if (!fromPersonality || !fromRuntime) {
    throw new IapError('invalid IAP envelope: missing from-personality/from-runtime')
  }
  // READ-COMPAT: a legacy peer (live telegram) may stamp from-intelligence="human";
  // normalize human→natural / scripted→absent, drop a genuinely unknown value.
  const fromIntelligence = normalizeIntelligenceValue(
    attrValue(open[1], 'intelligence') ?? attrValue(open[1], 'from-intelligence'),
  )
  const message = readTagContent(xml, 'message') ?? readTagContent(xml, 'msg')
  if (message === undefined) throw new IapError('invalid IAP envelope: missing message')
  const attachmentsRaw = readTagContent(xml, 'attachments')
  const topic = attrValue(open[1], 'topic')
  const sentAt = attrValue(open[1], 'ts')
  return {
    fromPersonality,
    fromRuntime,
    ...(fromIntelligence ? { fromIntelligence } : {}),
    ...(sentAt ? { sentAt } : {}),
    ...(topic ? { topic } : {}),
    attachments: attachmentsRaw
      ? attachmentsRaw.split('\n').map(item => item.trim()).filter(Boolean)
      : [],
    message,
  }
}

// В38 — a real envelope's open tag is bounded: personality/runtime ≤32 chars each,
// topic ≤200, intelligence one word, plus attr names and escaping. 1 KiB is far above
// any legitimate open tag; a longer '>'-less run after `<iap ` is prose, not a tag.
const MAX_OPEN_TAG_LEN = 1024

/** Classify the text at a `<iap ` occurrence: a complete VALID open tag (required attrs
 *  present), a complete-but-INVALID one / overlong tagless run (prose that merely contains
 *  the marker), or INCOMPLETE (no '>' yet within bounds — wait for the next chunk). */
function openTagVerdict(candidate: string): 'valid' | 'invalid' | 'incomplete' {
  const m = /^<iap\s+([^>]*)>/.exec(candidate)
  if (!m) {
    const unclosed = candidate.indexOf('>') < 0
    return unclosed && candidate.length <= MAX_OPEN_TAG_LEN ? 'incomplete' : 'invalid'
  }
  if (m[0].length > MAX_OPEN_TAG_LEN) return 'invalid'
  // Read-both (envelope-compaction F): a real open tag carries the required pair
  // under EITHER naming — legacy wire (from-personality/from-runtime) or compact
  // presentation (from/runtime, name-anchored so a legacy tail never satisfies it).
  const hasPersonality = m[1].includes('from-personality="') || /(?:^|\s)from="/.test(m[1])
  const hasRuntime = m[1].includes('from-runtime="') || /(?:^|\s)runtime="/.test(m[1])
  return hasPersonality && hasRuntime ? 'valid' : 'invalid'
}

/**
 * Pull complete `<iap …>…</iap>` envelopes out of a streaming buffer.
 * The closing `</iap>` is located CDATA-aware, so an envelope whose message
 * body contains the literal text `</iap>` is not truncated. `rest` holds the
 * trailing bytes that do not yet form a complete envelope (incl. an envelope
 * still mid-CDATA), to be prepended to the next chunk.
 *
 * В38 — a FALSE start (prose that merely contains `<iap `, e.g. a quoted tool
 * description) is never committed to: the open tag is validated first, and a
 * candidate whose decode fails RESYNCS one char forward instead of being kept
 * (which used to either swallow the NEXT real envelope into a mis-attributed
 * blob, or park the buffer forever waiting for a close that never comes).
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
    const verdict = openTagVerdict(rest)
    if (verdict === 'incomplete') return { envelopes, rest } // open tag split across chunks → wait
    if (verdict === 'invalid') {
      rest = rest.slice(1) // false start: skip past this '<' and rescan for the next '<iap '
      continue
    }
    const close = indexOfOutsideCdata(rest, '</iap>', '<iap '.length)
    if (close < 0) return { envelopes, rest } // incomplete (or mid-CDATA) → wait
    const envelopeEnd = close + '</iap>'.length
    const candidate = rest.slice(0, envelopeEnd)
    try {
      decodeEnvelope(candidate)
    } catch {
      // Structurally envelope-shaped but undecodable → a false start after all;
      // resync so a REAL envelope inside/behind the candidate is still found.
      rest = rest.slice(1)
      continue
    }
    envelopes.push(candidate)
    rest = rest.slice(envelopeEnd)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent-facing presentation render (envelope-compaction F)
// ─────────────────────────────────────────────────────────────────────────────

/** Presentation-hybrid gate: a body that itself contains envelope machinery
 *  (a quoted envelope, tag markers, CDATA syntax) or a literal CR keeps its
 *  CDATA wrapping in the presentation too — the cost of the gate firing is
 *  purely COSMETIC (the agent sees today's CDATA form), whereas rendering such
 *  a body raw would show the agent a "broken" nested envelope. Plain `<` (code
 *  snippets etc.) renders raw: nothing parses the presentation. */
const PRESENTATION_CDATA_MARKERS = [
  '<iap ',
  '</iap>',
  '<message>',
  '</message>',
  '<msg>',
  '</msg>',
  '<attachments>',
  '</attachments>',
  '<![CDATA[',
  ']]>',
  '\r',
] as const

function presentBody(value: string): string {
  return PRESENTATION_CDATA_MARKERS.some(marker => value.includes(marker)) ? cdata(value) : value
}

/** Compact the wire `ts` (full local ISO with offset) for the agent's eyes:
 *  time-only `01:23:45` when the send happened on the SAME local calendar day
 *  as the render (the normal case), date-prefixed `2026-07-13 01:23:45` when it
 *  did not (queue drains, long sleeps, midnight crossings) — so a stale message
 *  can never masquerade as fresh. Renders happen at the LAST delivery hop, so
 *  "today" is delivery-time local. An unparseable ts passes through verbatim. */
function renderTsForAgent(sentAt: string, now: Date): string {
  const d = new Date(sentAt)
  if (Number.isNaN(d.getTime())) return sentAt
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  const sameLocalDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameLocalDay ? time : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`
}

/**
 * Render a WIRE envelope into the compact agent-facing presentation:
 *
 *   <iap from="boris" runtime="claude" intelligence="artificial" ts="01:23:45">
 *   Reply via send_to_peer.
 *   <msg>raw body…</msg>
 *   </iap>
 *
 * Short attribute names, time-only `ts` (cross-day rule above), raw body
 * (hybrid CDATA when the body quotes envelope machinery). Called ONLY at the
 * two hops where text enters an LLM context (composeFirstMessage — wake boot +
 * ephemeral drain; deliverWarm — live paths, gated on agent runtimes); bridge
 * targets always receive the wire form their parsers expect.
 *
 * FAIL-OPEN: any decode/render problem returns the wire text unchanged — a
 * presentation hiccup must never lose or mangle a delivery.
 */
export function renderEnvelopeForAgent(wire: string, now: Date = new Date()): string {
  try {
    const env = decodeEnvelope(wire)
    const attrs = [`from="${escapeAttr(env.fromPersonality)}"`, `runtime="${escapeAttr(env.fromRuntime)}"`]
    if (env.fromIntelligence) attrs.push(`intelligence="${escapeAttr(env.fromIntelligence)}"`)
    if (env.sentAt) attrs.push(`ts="${escapeAttr(renderTsForAgent(env.sentAt, now))}"`)
    if (env.topic) attrs.push(`topic="${escapeAttr(env.topic)}"`)
    return [
      `<iap ${attrs.join(' ')}>`,
      IAP_INSTRUCTION,
      ...(env.attachments.length
        ? [`<attachments>${presentBody(env.attachments.join('\n'))}</attachments>`]
        : []),
      `<msg>${presentBody(env.message)}</msg>`,
      '</iap>',
    ].join('\n')
  } catch {
    return wire // fail-open: deliver the wire form rather than risk the message
  }
}
