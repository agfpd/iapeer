// normalize — the SINGLE shared name normalizer (zone Идентичность):
//   normalize(s) = slug(transliterate(s))
//
// The whole transliteration engine is isolated behind this one module so it can
// be swapped (e.g. to a literal WASM-ICU binding) without touching any call site:
// identity uses `normalizeNameCandidate` exclusively (re-exported from constants).
//
// ENGINE CHOICE (see _planning/normalizer-plan.md for the empirical comparison of
// six engines against the zone goldens). The contract mandates ICU
// `Any-Latin; Latin-ASCII`. Node/Bun `Intl` does NOT expose an ICU Transliterator,
// and system `uconv`/`iconv` are forbidden by the zone (OS-nondeterministic) and
// absent here. `transliteration` is the one pure-JS engine that reproduces ICU
// across WRITING SYSTEMS — CJK → pinyin WITH syllable spacing (项目 → "Xiang Mu"),
// Cyrillic (Привет → "Privet"), Greek (Ω → "O"), Latin diacritics (Köln → "Koln") —
// and it bundles its own CLDR/unidecode-derived tables, so it is deterministic
// across OSes (exactly the property the zone's iconv ban is protecting). It is the
// deterministic CLDR-EQUIVALENT of ICU, NOT a literal ICU engine.
//
// Where `transliteration` UNDER-maps a SYMBOL versus literal ICU `Latin-ASCII`,
// `ICU_LATIN_ASCII_SYMBOLS` realigns it (applied BEFORE transliterate). Seeded by
// the golden `№`: the package maps it to "no" (and "№2" → "no2", GLUING the digit);
// rewriting to ICU's literal "No." inserts a non-[a-z0-9] char that slug turns into
// the required separator → "no-2". So the align fixes a missing SEPARATOR, not a
// dropped punctuation mark (the package never emits one to "lose"). KNOWN LIMITATION:
// only the writing systems listed above (CJK / Cyrillic / Greek / Latin-diacritics)
// are verified-faithful to literal ICU; other scripts (Arabic / Hebrew / Korean …)
// may diverge — no ICU oracle on host to measure — and symbols outside this map may
// differ too. The map is extend-on-discovery; an unmapped symbol that transliterates
// to nothing safely drops (→ fail-to-explicit downstream).

import { transliterate } from 'transliteration'

/**
 * ICU `Latin-ASCII` alignment for the symbols where `transliteration` diverges
 * from literal ICU. Deterministic CLDR-equivalent, NOT literal ICU; this map fills
 * the symbol gaps. Extend by adding `<symbol>: <ICU Latin-ASCII output>` as
 * divergences surface.
 */
const ICU_LATIN_ASCII_SYMBOLS: Record<string, string> = {
  // № NUMERO SIGN. Package → "no" (and "№2" → "no2", gluing the digit). The literal
  // ICU `Latin-ASCII` value is "No."; what makes the golden pass is the non-[a-z0-9]
  // char between "no" and the digit (slug turns it into the separator → "no-2"). The
  // trailing "." itself is dropped by slug — kept here only because it is ICU's exact
  // output (mapping to "No-" or "no " would normalize identically).
  '№': 'No.',
}

function alignIcuSymbols(value: string): string {
  let out = value
  for (const [symbol, ascii] of Object.entries(ICU_LATIN_ASCII_SYMBOLS)) {
    if (out.includes(symbol)) out = out.split(symbol).join(ascii)
  }
  return out
}

// NAME_RE = /^[a-z][a-z0-9-]{0,31}$/ → at most 32 chars. slug bounds the length so a
// long basename truncates deterministically. The LEADING-LETTER constraint is NOT
// enforced here (a leading digit/hyphen result is returned as-is and the caller
// fails-to-explicit) — the normalizer must never mangle a name to force validity.
const MAX_NAME_LEN = 32

/** slug: lowercase → every non-[a-z0-9] run → a single hyphen → trim edge hyphens
 *  → cap length → drop a hyphen the length-cap may have left dangling. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_LEN)
    .replace(/-+$/, '')
}

/**
 * normalize(s) = slug(transliterate(s)) — the shared primitive every name
 * derivation/comparison routes through (basename(cwd) → personality, PEER_*
 * comparisons, profile re-validation).
 *
 * IDEMPOTENT on already-valid names: normalize("alice") === "alice",
 * normalize("notifier-timer") === "notifier-timer" — required because
 * validatePersonality re-normalizes stored profile names.
 *
 * A non-transliterable / empty / leading-digit result is returned AS-IS (e.g.
 * "①②③" → "", "2nd" → "2nd"); it will not match NAME_RE, and the caller
 * fails-to-explicit ("create peer-profile.json explicitly") rather than the
 * normalizer silently inventing a name.
 */
export function normalizeNameCandidate(value: string): string {
  return slug(transliterate(alignIcuSymbols(value)))
}
