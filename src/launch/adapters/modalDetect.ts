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
// How far above the footer to scan for the modal's options — the real AskUserQuestion box (question +
// pill + N options each with a DESCRIPTION line + an inter-option separator) is a dozen-plus rows.
const MODAL_MAX_LINES = 40

/**
 * Is `line` a claude/codex interactive-SELECT footer — the stable signature of a live numbered picker?
 * AskUserQuestion: "Enter to select · ↑/↓ to navigate · Esc to cancel"; a resume/boot select: "Enter to
 * confirm · Esc to cancel"; codex: "Press enter to confirm or esc to go back". Anchoring on this footer
 * (boris's guidance — устойчивее чем «❯ внизу») is layout-robust: it survives the cursor sitting on ANY
 * option and options being interleaved with description lines. The command-approval breaker's footer
 * ("Esc to cancel · Tab to amend · ctrl+e to explain") deliberately does NOT match (no select/navigate
 * hint) — it is a KNOWN class handled by its own taxonomy, and the structural guards below (a live
 * glyph-selected option + ≥2 options + nothing below the footer) keep this from firing on prose.
 */
export function isSelectFooter(line: string): boolean {
  return /esc to (?:cancel|go back)/i.test(line) && /(?:enter to |to navigate|to select|to confirm|press enter)/i.test(line)
}
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
  // 1. FOOTER anchor — the stable signature of a live interactive select (boris: устойчивее «❯ внизу»).
  //    The LAST footer line is THIS modal's (a scrolled-off older one sits above). Anchoring here is
  //    robust to the cursor sitting on ANY option and to options interleaved with DESCRIPTION lines /
  //    separators (the real AskUserQuestion layout — verified against a live 2.1.202 render).
  let footerIdx = -1
  for (let i = 0; i < lines.length; i++) if (isSelectFooter(lines[i])) footerIdx = i
  if (footerIdx < 0) return null
  // 2. COMPOSER-REPLACED guard — a LIVE blocking modal has NOTHING below its footer (the composer is
  //    gone). A mere QUOTE of a modal pasted into chat has the ready composer glyph rendered BELOW it, so
  //    ANY select glyph after the footer means "not a live block" → reject (the В40 quote class).
  for (let i = footerIdx + 1; i < lines.length; i++) if (lines[i].includes(glyph)) return null
  // 3. OPTIONS — scan a bounded WINDOW above the footer (NOT a contiguous run: the real modal interleaves
  //    each option with a wrapped description line and even an inter-option separator, and a blank can sit
  //    between the last option and the footer). Require a glyph-SELECTED option (a live cursor is on one)
  //    and ≥2 distinct numbered options. option1 = the "1." row CLOSEST to the footer (the modal's own —
  //    a stray transcript "1." further up loses to it).
  const windowTop = Math.max(0, footerIdx - MODAL_MAX_LINES)
  const selectedRe = new RegExp(`${escapeForRegex(glyph)}\\s*\\d+[.)]\\s`)
  const nums = new Set<number>()
  let option1 = ''
  let hasSelected = false
  let firstOptIdx = -1
  for (let i = windowTop; i < footerIdx; i++) {
    if (selectedRe.test(lines[i])) hasSelected = true
    const opt = parseOption(lines[i], glyph)
    if (!opt) continue
    if (firstOptIdx < 0) firstOptIdx = i
    nums.add(opt.num)
    if (opt.num === 1) option1 = opt.label // last (closest-to-footer) wins
  }
  if (!hasSelected) return null // no live cursor on an option → a printed list, not a live select
  if (nums.size < 2) return null // ≥2 options → a real select
  // 4. Verbatim block shown to the human: from a couple of lines above the first option (the question) to
  //    the footer, blanks trimmed + capped.
  const cTop = Math.max(windowTop, (firstOptIdx < 0 ? footerIdx : firstOptIdx) - 2)
  const block = lines.slice(cTop, footerIdx + 1)
  while (block.length && block[0].trim() === '') block.shift()
  while (block.length && block[block.length - 1].trim() === '') block.pop()
  return { content: capBlock(block), option1: option1 || '(option 1)' }
}
