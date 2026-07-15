import { describe, expect, test } from 'bun:test'
import { confirmNeedles, envelopeHasAttachments, transcriptCarriesEnvelope } from './index.ts'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// REAL BYTES from the 15.07.2026 incident. `LANDED_HEAD` is the verbatim opening of what a
// claude receiver actually STORED in its transcript when mrbrowser sent it 4 PNGs — note the
// hoisted `[Image #108] [Image #109]` prefix, the EATEN opening `<attachments>` tag, and the
// single surviving path followed by an orphan `</attachments>`. The delivery was reported
// ok=false three times and each retry duplicated the message in the receiver's context.
// ─────────────────────────────────────────────────────────────────────────────
const LANDED_HEAD =
  '[Image #108] [Image #109]<iap from="mrbrowser" runtime="claude" intelligence="artificial" ts="22:14:31" topic="web-console-notices-390">\nReply via send_to_peer.\n/Users/macmini/Peers/mrbrowser/390-chat-open.png</attachments>\n<msg>Верификация 0.14.1 @ 390×844, dev ('

const BODY = 'Верификация 0.14.1 @ 390×844, dev (127.0.0.1:8787 — тот же код что прод)'

/** The envelope as deliverWarm rendered and pasted it (the pre-mutation form). */
const SENT =
  '<iap from="mrbrowser" runtime="claude" intelligence="artificial" ts="22:14:31" topic="web-console-notices-390">\n' +
  'Reply via send_to_peer.\n' +
  '<attachments>/Users/macmini/Peers/mrbrowser/a.png\n' +
  '/Users/macmini/Peers/mrbrowser/b.png\n' +
  '/Users/macmini/Peers/mrbrowser/c.png\n' +
  '/Users/macmini/Peers/mrbrowser/390-chat-open.png</attachments>\n' +
  `<msg>${BODY}</msg>\n` +
  '</iap>'

/** What the receiver stored: images hoisted out, opening tag + consumed paths gone. */
const LANDED =
  '[Image #108] [Image #109]<iap from="mrbrowser" runtime="claude" intelligence="artificial" ts="22:14:31" topic="web-console-notices-390">\n' +
  'Reply via send_to_peer.\n' +
  '/Users/macmini/Peers/mrbrowser/390-chat-open.png</attachments>\n' +
  `<msg>${BODY}</msg>\n` +
  '</iap>'

const NO_ATT =
  '<iap from="boris" runtime="claude" intelligence="artificial" ts="22:14:31">\nReply via send_to_peer.\n<msg>plain</msg>\n</iap>'

describe('confirmNeedles', () => {
  test('no attachments → the WHOLE envelope stays the needle (strongest, unforgeable)', () => {
    expect(confirmNeedles(NO_ATT)).toEqual([NO_ATT])
  })

  test('with attachments → head + tail, split around the region the receiver rewrites', () => {
    const n = confirmNeedles(SENT)
    expect(n).toHaveLength(2)
    expect(n[0]).toBe(
      '<iap from="mrbrowser" runtime="claude" intelligence="artificial" ts="22:14:31" topic="web-console-notices-390">\nReply via send_to_peer.',
    )
    expect(n[1]).toBe(`<msg>${BODY}</msg>\n</iap>`)
    // No needle may carry any attachment path — that is the mutated region.
    for (const needle of n) expect(needle).not.toContain('.png')
  })

  test('both needles are found in the REAL stored text (the whole envelope is NOT)', () => {
    expect(LANDED.includes(SENT)).toBe(false) // ← the bug: the old needle cannot match
    for (const needle of confirmNeedles(SENT)) expect(LANDED).toContain(needle)
  })

  test('the real captured record prefix carries the head needle verbatim', () => {
    const head = confirmNeedles(SENT)[0]!
    expect(LANDED_HEAD).toContain(head)
  })

  test('malformed attachments (no closing tag) → fall back to the whole envelope, never guess', () => {
    const broken = '<iap …>\n<attachments>/a.png\n<msg>x</msg>\n</iap>'
    expect(confirmNeedles(broken)).toEqual([broken])
  })

  test('CR-normalised on the needle side', () => {
    expect(confirmNeedles('a\r\nb')).toEqual(['a\nb'])
  })
})

describe('transcriptCarriesEnvelope — the false-FAIL this fixes', () => {
  function transcript(records: unknown[]): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'iapeer-confirm-'))
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n')
    return { dir, path }
  }
  const baselineFor = (path: string) => ({ runtime: 'claude', cwd: '/nonexistent-cwd', files: [{ path, size: 0 }] }) as never

  test('CONFIRMS the attachment delivery the old matcher declared undelivered', () => {
    const { path } = transcript([{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: LANDED }] } }])
    expect(transcriptCarriesEnvelope(baselineFor(path), SENT)).toBe(true)
  })

  test('still confirms a plain (no-attachment) delivery', () => {
    const { path } = transcript([{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: NO_ATT }] } }])
    expect(transcriptCarriesEnvelope(baselineFor(path), NO_ATT)).toBe(true)
  })

  test('an UNRELATED record is not a confirm (no false-OK)', () => {
    const { path } = transcript([{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }])
    expect(transcriptCarriesEnvelope(baselineFor(path), SENT)).toBe(false)
  })

  // The reason head+tail must land in ONE string value: otherwise a receiver that merely
  // quoted the header somewhere and the body elsewhere would forge a confirm.
  test('head and tail scattered across DIFFERENT records do NOT confirm', () => {
    const [head, tail] = confirmNeedles(SENT)
    const { path } = transcript([
      { type: 'assistant', message: { content: [{ type: 'text', text: head }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: tail }] } },
    ])
    expect(transcriptCarriesEnvelope(baselineFor(path), SENT)).toBe(false)
  })

  test('a receiver quoting ONLY the header does not forge a confirm', () => {
    const head = confirmNeedles(SENT)[0]!
    const { path } = transcript([
      { type: 'assistant', message: { content: [{ type: 'text', text: `Got this: ${head} — replying now` }] } },
    ])
    expect(transcriptCarriesEnvelope(baselineFor(path), SENT)).toBe(false)
  })
})

describe('envelopeHasAttachments — which grace applies', () => {
  test('an attachment envelope is recognised (it will make the receiver ingest files first)', () => {
    expect(envelopeHasAttachments(SENT)).toBe(true)
  })

  test('a plain envelope is not', () => {
    expect(envelopeHasAttachments(NO_ATT)).toBe(false)
  })

  // A body that merely QUOTES the machinery must not buy the long grace by accident.
  test('a half-tag does not count', () => {
    expect(envelopeHasAttachments('<iap>…<attachments>oops')).toBe(false)
  })

  // The marker must agree with the needle split — otherwise one could see attachments and the
  // other not, and the confirm would use the wrong grace for the wrong needles.
  test('agrees with confirmNeedles: attachments ⇔ head+tail split', () => {
    expect(envelopeHasAttachments(SENT)).toBe(confirmNeedles(SENT).length === 2)
    expect(envelopeHasAttachments(NO_ATT)).toBe(confirmNeedles(NO_ATT).length === 2)
  })
})
