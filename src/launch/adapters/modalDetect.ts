// GENERIC numbered-SELECT modal detector (docs/17 — yolo-robustness / unknown-modal). Shared by the
// claude (`❯`) and codex (`›`) adapters' unknownBlockingModal: a modal that halts the pty on a keypress
// but matches NONE of the adapter's KNOWN signatures — a new modal Anthropic/OpenAI shipped that we did
// not foresee (the class that hung a live yolo peer). It is detected STRUCTURALLY, not by phrase, on the
// SAME invariant the known matchers rest on (an idle-ready TUI shows the composer at the bottom; a live
// modal REPLACES it with a numbered select), minus the phrase gate:
//
//   - the BOTTOM-MOST cursor-glyph row is a numbered option (`glyph … N. …`), not the composer
//     (`glyph <placeholder/text>` carries no leading digit-dot), and
//   - the contiguous non-blank block ending there carries ≥2 distinct numbered options (a real select,
//     not a lone printed `N.` line).
//
// A peer merely RENDERING/quoting a modal in its output fails this: the READY composer glyph renders
// BELOW the quote, so the bottom-most glyph row is the composer, not an option (the В40 class the known
// matchers already survive). The daemon's timing STUCK-gate composes on top (fires only on a frozen
// pane), so a working/streaming peer is excluded there.

/** Verbatim modal block (shown to the human) + the option-1 label (what an ALLOW presses). */
export interface NumberedModal {
  content: string
  option1: string
}

const CAP_LINES = 24
const CAP_BYTES = 8192
// Unicode box-drawing block (U+2500–U+257F) — modal borders/separators; stripped for PARSING only
// (the verbatim `content` keeps them).
const BOX_DRAWING = /[─-╿]/g

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Parse a numbered option row (`❯ 1. Yes` / `│  2. No │`) → {num, label}, else null. Box glyphs and a
 *  leading select glyph are stripped before matching so a boxed/selected row parses the same. */
function parseOption(raw: string, glyph: string): { num: number; label: string } | null {
  const s = raw.replace(BOX_DRAWING, ' ').split(glyph).join(' ').trim()
  const m = /^(\d+)[.)]\s+(\S.*)$/.exec(s)
  if (!m) return null
  return { num: parseInt(m[1], 10), label: m[2].replace(/\s+$/, '').trim() }
}

/** Cap the verbatim block: keep the LAST CAP_LINES rows (the options sit at the bottom, most load-
 *  bearing), each right-trimmed, then a hard byte ceiling. A leading marker notes any drop. */
function capBlock(block: string[]): string {
  let rows = block.map(l => l.replace(/\s+$/, ''))
  let dropped = false
  if (rows.length > CAP_LINES) {
    rows = rows.slice(rows.length - CAP_LINES)
    dropped = true
  }
  let out = rows.join('\n')
  if (Buffer.byteLength(out, 'utf8') > CAP_BYTES) {
    out = out.slice(-CAP_BYTES)
    dropped = true
  }
  return dropped ? `…\n${out}` : out
}

/**
 * Detect a generic numbered-select modal that has replaced the composer. `glyph` is the runtime's
 * cursor/select glyph (`❯` claude, `›` codex). Returns the verbatim block + option-1 label, or null.
 * The CALLER must first exclude its OWN known signatures (so this fires only for the unrecognized
 * residue) — this function is signature-agnostic by design.
 */
export function detectNumberedModal(pane: string, glyph: string): NumberedModal | null {
  const lines = pane.split(/\r?\n/)
  // bottom-most row carrying the select glyph.
  let selected = -1
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(glyph)) selected = i
  if (selected < 0) return null
  // it must be a SELECTED numbered option (`glyph … N. …`) — the composer (`glyph <text>`) carries no
  // leading digit-dot, so an idle/ready pane and a mere quote-with-composer-below both fail here.
  const selectedRe = new RegExp(`${escapeForRegex(glyph)}\\s*\\d+[.)]\\s`)
  if (!selectedRe.test(lines[selected])) return null
  // The select glyph sits only on the SELECTED option; siblings render WITHOUT it (above and below). Grow
  // the contiguous OPTION RUN in BOTH directions from the selected row while each line parses as a
  // numbered option (an interleaved blank / non-option line ends the run). This captures every option,
  // not just the ones above the cursor.
  let optTop = selected
  let optBottom = selected
  while (optTop - 1 >= 0 && parseOption(lines[optTop - 1], glyph)) optTop--
  while (optBottom + 1 < lines.length && parseOption(lines[optBottom + 1], glyph)) optBottom++
  // need ≥2 DISTINCT numbered options (a real select, not a lone printed `N.` line).
  const nums = new Set<number>()
  let option1 = ''
  for (let i = optTop; i <= optBottom; i++) {
    const opt = parseOption(lines[i], glyph)
    if (!opt) continue
    nums.add(opt.num)
    if (opt.num === 1 && !option1) option1 = opt.label
  }
  if (nums.size < 2) return null
  // Verbatim block shown to the human: the option run + a little context (the question above / a footer
  // below), then leading/trailing blank lines trimmed. Bounded by the caps.
  const start = Math.max(0, optTop - 3)
  const end = Math.min(lines.length - 1, optBottom + 2)
  const block = lines.slice(start, end + 1)
  while (block.length && block[0].trim() === '') block.shift()
  while (block.length && block[block.length - 1].trim() === '') block.pop()
  return { content: capBlock(block), option1: option1 || '(option 1)' }
}
