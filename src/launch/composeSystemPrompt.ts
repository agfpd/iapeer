// composeSystemPrompt — GOLDEN-equivalent TS reimplementation of the jq
// doctrine-merge in Persistent-Peer/bin/claude-start.sh:264-290. Produces the
// merged peer system prompt that --system-prompt-file / model_instructions_file
// consume: a YAML identity block (dynamic facts) + global doctrine (optional) +
// per-peer doctrine. Byte-for-byte equivalent to the bash/jq output — see the
// byte-layout notes below.
//
// Ownership: launch (HOW to bring up ONE session); NO currency on this path.
// Contract is FROZEN in ./types.ts (ComposePromptInput / ComposeSystemPrompt).

import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { FRAGMENTS_DIR, IAPEER_DIR } from '../core/constants.ts'
import { publicPeerSummary, readPeersIndex, type PublicPeerSummary } from '../registry/index.ts'
import { resolveGlobalRoot } from '../storage/index.ts'
import type { ComposePromptInput, PromptDomainBlock } from './types.ts'

const IAPEER_DOCTRINE_FILE = 'IAPEER.md'

// The bash builds $MERGED as the concatenation of two streams in a `{ … }` group:
//
//   1. jq --raw-output over a 10-element string array. --raw-output prints each
//      array element on its own line, every line terminated by '\n' (including
//      the LAST element). The array is:
//        "---", 8×"<key>: <value | @json>", "---", ""
//      so the final "" element emits a line that is just '\n' → the blank line
//      after the closing '---'. Net jq output (each line '\n'-terminated):
//        "---\n" + 8 yaml lines + "---\n" + "\n"
//      i.e. the YAML block ALWAYS ends with "---\n\n".
//
//   2a. if the global doctrine file exists:  cat "$GLOBAL"  then  printf "\n".
//       `cat` emits the file verbatim; `printf "\n"` appends exactly ONE '\n'.
//       In TS the file content is `input.globalDoctrine`, so this contributes
//       `globalDoctrine + "\n"` — the trailing "\n" is added UNCONDITIONALLY,
//       whether or not globalDoctrine already ends in a newline (it mirrors the
//       always-on `printf "\n"`). Omitted entirely when global is absent/empty.
//
//   2b. cat "$DOCTRINE":  the per-peer doctrine verbatim, NO added newline.
//
// jq @json renders each value as a JSON string literal. It equals JSON.stringify
// byte-for-byte across the realistic field domain (empty string, tab/CR/LF/FF/BS,
// C0 control chars, unicode passthrough, '"'/'\\' escaping, '/' left unescaped) —
// verified by enumerating every codepoint U+0001..U+0100. The ONE divergence: jq
// escapes U+007F (DEL) as a \u007f sequence, whereas JSON.stringify emits the raw
// byte (the JSON spec only mandates escaping U+0000..U+001F, so DEL passes
// through). jqJson() reproduces jq exactly by post-escaping DEL (and NUL — the
// same class; unreachable through the bash `--arg` origin, but escaped for total
// faithfulness). A JSON string literal is also a valid YAML double-quoted scalar,
// so the YAML stays safe against colons/quotes/newlines in description / paths.
function jqJson(value: string): string {
  // JSON.stringify, then bring the two control chars jq escapes but the
  // spec-minimal JSON.stringify leaves literal (DEL, NUL) into line with jq.
  return JSON.stringify(value)
    .replace(new RegExp(String.fromCharCode(0x7f), 'g'), '\\u007f')
    .replace(new RegExp(String.fromCharCode(0x00), 'g'), '\\u0000')
}

/** A per-file section: a path marker line, then the file content. The marker is an
 *  HTML comment — inert in rendered markdown yet plainly visible in the raw system-
 *  prompt the model reads (verified: the model's context surfaces HTML comments) —
 *  so a reader (human or agent) can tell, per file, exactly which path each chunk of
 *  the assembled prompt came from. No marker when `path` is absent (a pure-renderer
 *  caller, or the synthesized Layer-1 YAML / Layer-3 registry which are not files). */
function markedSection(path: string | undefined, content: string): string {
  return path ? `<!-- ${path} -->\n${content}` : content
}

/** Trailing-newline-trimmed length test: a 0-byte or newline-only file is "empty"
 *  and contributes no section (and so no dangling marker). */
function hasContent(s: string | undefined): s is string {
  return s !== undefined && s.replace(/\n+$/, '').length > 0
}

/**
 * Compose the merged system prompt: the YAML identity block (Layer 1) followed by
 * every file-sourced layer rendered PER FILE — each injected `.md` prefixed by a
 * path marker (`<!-- <path> -->`). Layers, general → specific:
 *   1. YAML identity block (synthesized, no marker) — byte-for-byte the jq layout.
 *   2. IAPEER.md doctrine: global then local, each its own marked section.
 *   3. Normalized peer registry (generated, no marker).
 *   4. Other `<DOMAIN>.md` at the .iapeer root — each half (global, local) marked.
 *   5. fragments/ `*.md` — each half marked. Most-volatile, sits LAST.
 * Empty files contribute nothing (no section, no marker). Sections are joined by a
 * single blank line and the output ends with exactly one newline.
 */
export function composeSystemPrompt(input: ComposePromptInput): string {
  // The eight identity lines, in the bash's exact key order. Keys verbatim:
  // hyphen `peer-cwd`, underscore `os_version`. Value = jqJson (= jq @json).
  const yaml =
    '---\n' +
    `personality: ${jqJson(input.personality)}\n` +
    `description: ${jqJson(input.description)}\n` +
    `peer-cwd: ${jqJson(input.cwd)}\n` +
    `platform: ${jqJson(input.platform)}\n` +
    `os_version: ${jqJson(input.osVersion)}\n` +
    `user: ${jqJson(input.user)}\n` +
    `hostname: ${jqJson(input.hostname)}\n` +
    `today: ${jqJson(input.today)}\n` +
    '---\n' +
    // jq's final "" array element → the bare blank line after the closing '---'.
    '\n'

  // The YAML identity block is the only Layer-1 section (synthesized, no marker).
  const sections: string[] = [yaml]

  // Host-context pointer to the on-host ecosystem docs (FU6). Each package's install
  // scaffolds its own contract docs to the stable, versioned, per-package path
  // ~/.iapeer/docs/<package>/, so an agent can read "how does iapeer do X" offline
  // instead of guessing. Synthesized Layer-1 fact (no marker). Wording: owner-approved.
  sections.push(
    'iapeer reference docs are on this host at ~/.iapeer/docs/ — one folder per package (start at iapeer/README.md). Consult them for how iapeer works instead of guessing.',
  )

  // Layer 2 — IAPEER.md doctrine, GLOBAL then LOCAL (general → specific), each its
  // OWN marked file-section. The bash existence-gate (present-but-empty global → a
  // bare "\n") is dropped deliberately: an empty doctrine file now contributes no
  // section (and no dangling marker), like every other empty file. IAPEER.md carries
  // the only FIXED semantics in the assembly (host = general peer rules, local = this
  // peer's rules — the CLAUDE.md analogue); its meaning is conveyed by the well-known
  // filename + path, so the marker stays a bare path like every other file's.
  if (hasContent(input.globalDoctrine)) {
    sections.push(markedSection(input.globalDoctrinePath, input.globalDoctrine))
  }
  if (hasContent(input.peerDoctrine)) {
    sections.push(markedSection(input.peerDoctrinePath, input.peerDoctrine))
  }

  // Layer 3 — normalized peer registry (generated from the index, not a file → no
  // marker). Empty list → nothing.
  const registry = renderRegistry(input.peers ?? [])
  if (registry.length > 0) sections.push(registry)

  // Layers 4 (other <DOMAIN>.md) then 5 (fragments/, most-volatile, LAST) — each
  // file half (global, local) is its own marked section. Empty halves drop out.
  pushMarkedBlocks(sections, input.pluginDomains ?? [])
  pushMarkedBlocks(sections, input.promptFragments ?? [])

  // Normalize every seam to exactly one blank line: strip each section's trailing
  // newlines, join with '\n\n', end with a single '\n'. Robust to whether source
  // files carried trailing newlines. A bare-doctrine peer is now [YAML, local
  // IAPEER.md] → two sections, so it always carries its doctrine's path marker.
  return sections.map(section => section.replace(/\n+$/, '')).join('\n\n') + '\n'
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — normalized peer registry (publicPeerSummary, exactly 5 fields). The
// behavioral driver for delegation: without a peer list an executor never enters
// the model's reasoning (contract §"Реестр пиров"). Empty list → empty layer.
// ─────────────────────────────────────────────────────────────────────────────

function renderRegistry(peers: readonly PublicPeerSummary[]): string {
  if (peers.length === 0) return ''
  const lines = ['## Known peers']
  for (const p of peers) {
    const desc = p.description ? ` — ${p.description}` : ''
    lines.push(`- ${p.personality}${desc}`)
    lines.push(`  runtime: ${p.runtime}`)
    lines.push(`  runtimes: ${p.runtimes.join(', ')}`)
    lines.push(`  intelligence: ${p.intelligence}`)
  }
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Layers 4 & 5 — per-file marked sections:
//   • Layer 4: every non-IAPEER `<DOMAIN>.md` pair at the .iapeer/ root (operator /
//     plugin user-settings; SPAWNER_INSTRUCTIONS.md, … flow in organically).
//   • Layer 5: every `<STEM>.md` pair in .iapeer/fragments/ (primitive-owned,
//     machine-regenerated doctrine fragments — e.g. a memory provider's guide +
//     note index).
// Each block contributes its GLOBAL half then its LOCAL half (general → specific),
// EACH as its own marked file-section (a 0-byte / newline-only file → no section,
// no dangling marker). Blocks are appended in the order given (the gatherer sorts
// by filename for determinism); the stem (`domain`) is used only for that ordering,
// never emitted.
// ─────────────────────────────────────────────────────────────────────────────

function pushMarkedBlocks(sections: string[], blocks: readonly PromptDomainBlock[]): void {
  for (const b of blocks) {
    if (hasContent(b.global)) sections.push(markedSection(b.globalPath, b.global))
    if (hasContent(b.local)) sections.push(markedSection(b.localPath, b.local))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// gatherPromptInput — the FS-discovery half: scan ~/.iapeer/*.md (global) and
// <cwd>/.iapeer/*.md (local), split IAPEER.md (Layer 2) from every other domain
// (Layer 4), scan the fragments/ subdir of both roots (Layer 5), and project the
// live registry through publicPeerSummary (Layer 3), into a ready-to-render
// ComposePromptInput. Layer-1 identity/host facts are supplied by the caller
// (lifecycle gathers them via sw_vers/hostname/etc). This is the ONLY FS-touching
// part; composeSystemPrompt itself stays pure.
// ─────────────────────────────────────────────────────────────────────────────

export interface GatherPromptOptions {
  /** Layer 1 — identity + host facts (caller-gathered). */
  personality: string
  description: string
  cwd: string
  platform: string
  osVersion: string
  user: string
  hostname: string
  today: string
  /** The global `.iapeer` root; defaults to resolveGlobalRoot(env) (= ~/.iapeer). */
  globalRoot?: string
  env?: NodeJS.ProcessEnv
  /** Layer 3 override (tests); defaults to the live-registry projection. */
  peers?: PublicPeerSummary[]
}

function readFileIfPresent(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** `*.md` files directly in `dir` (NOT recursing). Missing dir → []. The `.md`
 *  test is CASE-INSENSITIVE so an uppercase-extension `NOTES.MD` is picked up too. */
function listMdFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map(e => e.name)
  } catch {
    return []
  }
}

/** Layer-4 domain candidates: `*.md` directly at a `.iapeer` root, excluding
 *  IAPEER.md (Layer 2). The doctrine exclusion is CASE-INSENSITIVE: the Layer-2
 *  read (join(root,'IAPEER.md')) resolves a lowercase `iapeer.md` on a case-
 *  insensitive FS (macOS APFS), so a byte-exact exclusion here would let that same
 *  file ALSO surface as a Layer-4 domain and duplicate the doctrine. */
function listDomainFiles(root: string): string[] {
  const doctrineLower = IAPEER_DOCTRINE_FILE.toLowerCase()
  return listMdFiles(root).filter(name => name.toLowerCase() !== doctrineLower)
}

/** Display path for a marker: an absolute path with a leading HOME abbreviated to
 *  `~` (the form a human scanning the assembled prompt expects). HOME unset / path
 *  outside HOME → the absolute path verbatim. */
function displayPath(absPath: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim()
  if (home && (absPath === home || absPath.startsWith(home + '/'))) {
    return '~' + absPath.slice(home.length)
  }
  return absPath
}

/** Build a list of merged global/local blocks (Layer 4 OR Layer 5) from the
 *  union of `*.md` stems present in the global and/or local dir, sorted by
 *  filename (plain codepoint order) for a deterministic prompt. `lister` selects
 *  the candidate `.md` files — Layer 4 excludes the IAPEER.md doctrine, Layer 5
 *  takes every fragment. Each present half carries its display path for the marker.
 *  A read that races a rotation (file removed between listdir and read) → that half
 *  is undefined and drops out; a 0-byte file → '' and is dropped by the renderer. */
function gatherMergedBlocks(
  globalDir: string,
  localDir: string,
  env: NodeJS.ProcessEnv,
  lister: (dir: string) => string[] = listMdFiles,
): PromptDomainBlock[] {
  const names = new Set<string>([...lister(globalDir), ...lister(localDir)])
  return [...names].sort().map(name => {
    const block: PromptDomainBlock = { domain: name.slice(0, -3) } // strip ".md"
    const global = readFileIfPresent(join(globalDir, name))
    const local = readFileIfPresent(join(localDir, name))
    if (global !== undefined) {
      block.global = global
      block.globalPath = displayPath(join(globalDir, name), env)
    }
    if (local !== undefined) {
      block.local = local
      block.localPath = displayPath(join(localDir, name), env)
    }
    return block
  })
}

export function gatherPromptInput(opts: GatherPromptOptions): ComposePromptInput {
  const env = opts.env ?? process.env
  const globalRoot = opts.globalRoot ?? resolveGlobalRoot(env)
  const localRoot = join(opts.cwd, IAPEER_DIR)

  // Layer 2 — IAPEER.md merge. Each half carries its display path for the marker.
  // Existence-gated: undefined when absent, '' when present-but-empty (an empty
  // doctrine now contributes no section — no bare-"\n" legacy quirk).
  const globalDoctrineFile = join(globalRoot, IAPEER_DOCTRINE_FILE)
  const peerDoctrineFile = join(localRoot, IAPEER_DOCTRINE_FILE)
  const globalDoctrine = readFileIfPresent(globalDoctrineFile)
  const peerDoctrine = readFileIfPresent(peerDoctrineFile) ?? ''

  // Layer 4 — union of every non-IAPEER domain present globally and/or locally,
  // sorted by filename for a deterministic prompt. Empty (0-byte) files stay as
  // presence markers — readFileIfPresent returns '', and the renderer drops empty
  // halves, so a marker contributes no text/separator.
  const pluginDomains = gatherMergedBlocks(globalRoot, localRoot, env, listDomainFiles)

  // Layer 5 — doctrine fragments: every `*.md` in the fragments/ subdir of both
  // roots, merged per stem (global guide → per-peer specifics). Primitive-owned and
  // machine-regenerated; an atomic rotation that briefly removes/replaces a file is
  // tolerated (a racing read just drops that half — no partial bytes, no throw).
  const promptFragments = gatherMergedBlocks(
    join(globalRoot, FRAGMENTS_DIR),
    join(localRoot, FRAGMENTS_DIR),
    env,
  )

  // Layer 3 — peers projected through the shared normalizer, sorted by personality
  // (determinism even if the on-disk file was hand-edited). `opts.peers` lets a
  // caller that already read the registry (lifecycle's wake path) pass it in,
  // avoiding a second read+parse on the hot launch path; the sort applies either
  // way and `.slice()` keeps the caller's array untouched.
  const peers = (opts.peers ?? readPeersIndex({ env, rootDir: globalRoot }).peers.map(publicPeerSummary))
    .slice()
    .sort((a, b) => (a.personality < b.personality ? -1 : a.personality > b.personality ? 1 : 0))

  return {
    personality: opts.personality,
    description: opts.description,
    cwd: opts.cwd,
    platform: opts.platform,
    osVersion: opts.osVersion,
    user: opts.user,
    hostname: opts.hostname,
    today: opts.today,
    peerDoctrine,
    peerDoctrinePath: displayPath(peerDoctrineFile, env),
    ...(globalDoctrine !== undefined
      ? { globalDoctrine, globalDoctrinePath: displayPath(globalDoctrineFile, env) }
      : {}),
    peers,
    pluginDomains,
    promptFragments,
  }
}
