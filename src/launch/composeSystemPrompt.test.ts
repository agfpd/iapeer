// composeSystemPrompt — the YAML identity block (Layer 1) stays byte-for-byte the
// claude-start.sh:264-290 jq layout (the durable golden); the file-sourced layers
// (2/4/5) are now rendered PER FILE, each prefixed by a `<!-- <path> -->` marker.
// This test pins BOTH: the jq-equivalent YAML prefix, and the marker format /
// empty-file-drops rules of the per-file assembly.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { composeSystemPrompt } from './composeSystemPrompt.ts'
import type { ComposePromptInput } from './types.ts'

let dir: string
let jqProg: string

// The jq program verbatim from claude-start.sh:274-284 — the YAML identity block.
const JQ_PROGRAM = `"---",
"personality: \\($personality | @json)",
"description: \\($description | @json)",
"peer-cwd: \\($peer_cwd | @json)",
"platform: \\($platform | @json)",
"os_version: \\($os_version | @json)",
"user: \\($user | @json)",
"hostname: \\($hostname | @json)",
"today: \\($today | @json)",
"---",
""`

function shq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'iapeer-csp-'))
  jqProg = join(dir, 'prog.jq')
  writeFileSync(jqProg, JQ_PROGRAM)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The jq YAML identity block alone (no doctrine appended) — the byte-for-byte
 *  Layer-1 golden every composed prompt must START with. */
function jqYamlBlock(input: ComposePromptInput): string {
  const script = `set -e
jq -n --raw-output \
  --arg personality ${shq(input.personality)} \
  --arg description ${shq(input.description)} \
  --arg peer_cwd ${shq(input.cwd)} \
  --arg platform ${shq(input.platform)} \
  --arg os_version ${shq(input.osVersion)} \
  --arg user ${shq(input.user)} \
  --arg hostname ${shq(input.hostname)} \
  --arg today ${shq(input.today)} \
  -f ${shq(jqProg)}`
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`bash reference failed: ${r.stderr}`)
  return r.stdout
}

const base = {
  personality: 'nova',
  cwd: '/tmp/iapeer-peers/nova',
  platform: 'darwin',
  osVersion: '15.5',
  user: 'alice',
  hostname: 'devbox',
  today: '2026-06-06',
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — the YAML identity block is byte-for-byte the jq layout
// ─────────────────────────────────────────────────────────────────────────────

describe('composeSystemPrompt — Layer 1 YAML block is byte-for-byte the jq layout', () => {
  const cases: Array<{ name: string; input: ComposePromptInput }> = [
    { name: 'basic', input: { ...base, description: 'owner', peerDoctrine: 'Be helpful.\n' } },
    { name: 'hostile description: colon + quote + newline', input: { ...base, description: 'a: "b"\nc', peerDoctrine: 'doc\n' } },
    { name: 'unicode + emoji description', input: { ...base, description: 'Нова 🦊 №2', peerDoctrine: 'док\n' } },
    { name: 'description with backslash and slash', input: { ...base, description: 'a\\b/c', peerDoctrine: 'x\n' } },
    { name: 'empty description', input: { ...base, description: '', peerDoctrine: 'x\n' } },
  ]
  for (const c of cases) {
    test(c.name, () => {
      const yaml = jqYamlBlock(c.input)
      // the composed prompt opens with the exact jq YAML block (the `---…---\n\n`)
      expect(composeSystemPrompt(c.input).startsWith(yaml)).toBe(true)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — IAPEER.md doctrine is rendered per-file with a path marker
// ─────────────────────────────────────────────────────────────────────────────

describe('composeSystemPrompt — per-file path markers (Layer 2 doctrine)', () => {
  const input: ComposePromptInput = {
    ...base,
    description: 'owner',
    peerDoctrine: 'Be the implementer.\n',
    peerDoctrinePath: '~/Peers/nova/.iapeer/IAPEER.md',
    globalDoctrine: 'Host rules.\n',
    globalDoctrinePath: '~/.iapeer/IAPEER.md',
  }

  test('each doctrine file is prefixed by its <!-- path --> marker, global before local', () => {
    const out = composeSystemPrompt(input)
    expect(out).toContain('<!-- ~/.iapeer/IAPEER.md -->\nHost rules.')
    expect(out).toContain('<!-- ~/Peers/nova/.iapeer/IAPEER.md -->\nBe the implementer.')
    expect(out.indexOf('<!-- ~/.iapeer/IAPEER.md -->')).toBeLessThan(
      out.indexOf('<!-- ~/Peers/nova/.iapeer/IAPEER.md -->'),
    )
  })

  test('marker sits AFTER the YAML block (one blank line between)', () => {
    const out = composeSystemPrompt(input)
    expect(out).toContain('---\n\n<!-- ~/.iapeer/IAPEER.md -->')
  })

  test('a path-less content (pure-renderer caller) renders WITHOUT a marker', () => {
    const out = composeSystemPrompt({ ...base, description: 'd', peerDoctrine: 'no marker here\n' })
    expect(out).toContain('no marker here')
    expect(out).not.toContain('<!--')
  })

  test('an EMPTY doctrine file contributes no section and no dangling marker', () => {
    const out = composeSystemPrompt({
      ...base,
      description: 'd',
      peerDoctrine: 'real\n',
      peerDoctrinePath: '~/p/IAPEER.md',
      globalDoctrine: '', // present but empty → dropped
      globalDoctrinePath: '~/.iapeer/IAPEER.md',
    })
    expect(out).not.toContain('~/.iapeer/IAPEER.md') // empty global marker absent
    expect(out).toContain('<!-- ~/p/IAPEER.md -->\nreal')
  })

  test('output ends with exactly one newline; no 3+ blank-line gaps', () => {
    const out = composeSystemPrompt(input)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
    expect(out).not.toMatch(/\n{3,}/)
  })
})
