// Layer 3 (registry) + Layer 4 (other domains) tests for composeSystemPrompt,
// plus the FS-discovery gatherPromptInput. The golden file (composeSystemPrompt
// .test.ts) proves layers 1+2 stay byte-for-byte; THIS file proves the new
// layers render correctly, in order (general → specific), and that empty/absent
// inputs add nothing (backward-compat with the legacy bytes).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { composeSystemPrompt, gatherPromptInput } from './composeSystemPrompt.ts'
import type { ComposePromptInput, PromptDomainBlock, PublicPeerSummary } from './types.ts'

const base: Omit<ComposePromptInput, 'peers' | 'pluginDomains'> = {
  personality: 'iapeer',
  description: 'impl',
  cwd: '/tmp/iapeer-peers/iapeer',
  platform: 'darwin',
  osVersion: '15.5',
  user: 'alice',
  hostname: 'devbox',
  today: '2026-06-06',
  peerDoctrine: 'Be the implementer.\n',
  globalDoctrine: 'GLOBAL\n',
}

const peerA: PublicPeerSummary = {
  personality: 'boris',
  runtime: 'claude',
  runtimes: ['claude'],
  description: 'PM partner',
  intelligence: 'artificial',
}
const peerB: PublicPeerSummary = {
  personality: 'nova',
  runtime: 'telegram',
  runtimes: ['telegram', 'claude'],
  description: '',
  intelligence: 'natural',
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure renderer — Layers 3 + 4
// ─────────────────────────────────────────────────────────────────────────────

describe('composeSystemPrompt — layer 3 (registry)', () => {
  test('empty/omitted peers add NOTHING (legacy bytes preserved)', () => {
    const legacy = composeSystemPrompt(base)
    expect(composeSystemPrompt({ ...base, peers: [] })).toBe(legacy)
    expect(composeSystemPrompt({ ...base, peers: undefined })).toBe(legacy)
    expect(legacy).not.toContain('## Known peers')
  })

  test('renders WITH descriptions + all 5 normalized fields (boris refinement #1)', () => {
    const out = composeSystemPrompt({ ...base, peers: [peerA] })
    expect(out).toContain('## Known peers')
    expect(out).toContain('- boris — PM partner')
    expect(out).toContain('  runtime: claude')
    expect(out).toContain('  runtimes: claude')
    expect(out).toContain('  intelligence: artificial')
  })

  test('a peer with an empty description renders no " — " suffix', () => {
    const out = composeSystemPrompt({ ...base, peers: [peerB] })
    expect(out).toContain('- nova\n')
    expect(out).not.toContain('- nova — ')
    expect(out).toContain('  runtimes: telegram, claude')
  })

  test('layer 3 sits AFTER the doctrine (layer 2), separated by a blank line', () => {
    const out = composeSystemPrompt({ ...base, peers: [peerA] })
    expect(out.indexOf('Be the implementer.')).toBeLessThan(out.indexOf('## Known peers'))
    expect(out).toContain('Be the implementer.\n\n## Known peers')
  })
})

describe('composeSystemPrompt — layer 4 (other domains)', () => {
  const dom = (over: Partial<PromptDomainBlock>): PromptDomainBlock => ({ domain: 'X', ...over })

  test('empty/omitted domains add NOTHING (legacy bytes preserved)', () => {
    const legacy = composeSystemPrompt(base)
    expect(composeSystemPrompt({ ...base, pluginDomains: [] })).toBe(legacy)
    expect(composeSystemPrompt({ ...base, pluginDomains: undefined })).toBe(legacy)
  })

  test('a presence-marker domain (empty halves) emits no text and no dangling separator (boris refinement #2)', () => {
    const legacy = composeSystemPrompt(base)
    // a 0-byte marker → both halves '' → contributes nothing
    expect(composeSystemPrompt({ ...base, pluginDomains: [dom({ local: '' })] })).toBe(legacy)
    expect(composeSystemPrompt({ ...base, pluginDomains: [dom({ global: '', local: '' })] })).toBe(legacy)
    // a marker next to a real domain must not inject a blank block between them
    const out = composeSystemPrompt({
      ...base,
      pluginDomains: [dom({ domain: 'MARKER', local: '' }), dom({ domain: 'REAL', global: 'real-content\n' })],
    })
    expect(out).toContain('real-content')
    expect(out).not.toMatch(/\n{4,}/) // no 3+ blank lines = no empty block injected
  })

  test('within a domain, global precedes local (general → specific), each its own section', () => {
    const out = composeSystemPrompt({
      ...base,
      pluginDomains: [dom({ domain: 'MM', global: 'mm-global', local: 'mm-local' })],
    })
    // per-file now: global and local are SEPARATE sections (blank line between),
    // not a tight single-newline merge
    expect(out).toContain('mm-global\n\nmm-local')
    expect(out.indexOf('mm-global')).toBeLessThan(out.indexOf('mm-local'))
  })

  test('per-file path markers: each half carries its <!-- path --> marker', () => {
    const out = composeSystemPrompt({
      ...base,
      pluginDomains: [
        dom({ domain: 'MM', global: 'mm-global\n', globalPath: '~/.iapeer/MEMORY.md', local: 'mm-local\n', localPath: '~/p/.iapeer/MEMORY.md' }),
      ],
    })
    expect(out).toContain('<!-- ~/.iapeer/MEMORY.md -->\nmm-global')
    expect(out).toContain('<!-- ~/p/.iapeer/MEMORY.md -->\nmm-local')
  })

  test('layer 4 sits after layer 3; domains kept in the order given', () => {
    const out = composeSystemPrompt({
      ...base,
      peers: [peerA],
      pluginDomains: [dom({ domain: 'AAA', global: 'aaa' }), dom({ domain: 'ZZZ', local: 'zzz' })],
    })
    expect(out.indexOf('## Known peers')).toBeLessThan(out.indexOf('aaa'))
    expect(out.indexOf('aaa')).toBeLessThan(out.indexOf('zzz'))
    expect(out).toContain('aaa\n\nzzz')
  })

  test('full 4-layer ordering: YAML → doctrine → registry → domains', () => {
    const out = composeSystemPrompt({ ...base, peers: [peerA], pluginDomains: [dom({ global: 'domain-text' })] })
    const iYaml = out.indexOf('personality:')
    const iDoctrine = out.indexOf('Be the implementer.')
    const iReg = out.indexOf('## Known peers')
    const iDom = out.indexOf('domain-text')
    expect(iYaml).toBeGreaterThanOrEqual(0)
    expect(iYaml).toBeLessThan(iDoctrine)
    expect(iDoctrine).toBeLessThan(iReg)
    expect(iReg).toBeLessThan(iDom)
  })
})

describe('composeSystemPrompt — layer 5 (doctrine fragments)', () => {
  const frag = (over: Partial<PromptDomainBlock>): PromptDomainBlock => ({ domain: 'F', ...over })

  test('empty/omitted fragments add NOTHING (legacy bytes preserved)', () => {
    const legacy = composeSystemPrompt(base)
    expect(composeSystemPrompt({ ...base, promptFragments: [] })).toBe(legacy)
    expect(composeSystemPrompt({ ...base, promptFragments: undefined })).toBe(legacy)
  })

  test('a presence-marker fragment (empty halves) emits no text and no dangling separator', () => {
    const legacy = composeSystemPrompt(base)
    expect(composeSystemPrompt({ ...base, promptFragments: [frag({ local: '' })] })).toBe(legacy)
    expect(composeSystemPrompt({ ...base, promptFragments: [frag({ global: '', local: '' })] })).toBe(legacy)
    const out = composeSystemPrompt({
      ...base,
      promptFragments: [frag({ domain: 'EMPTY', local: '' }), frag({ domain: 'REAL', local: 'idx-content\n' })],
    })
    expect(out).toContain('idx-content')
    expect(out).not.toMatch(/\n{4,}/)
  })

  test('within a fragment stem, global (host-wide guide) precedes local (per-peer index)', () => {
    const out = composeSystemPrompt({
      ...base,
      promptFragments: [frag({ domain: 'MEM', global: 'mem-guide', local: 'mem-index' })],
    })
    expect(out).toContain('mem-guide\n\nmem-index') // per-file: separate sections
    expect(out.indexOf('mem-guide')).toBeLessThan(out.indexOf('mem-index'))
  })

  test('layer 5 sits AFTER layer 4 (most-volatile last), separated by a blank line', () => {
    const out = composeSystemPrompt({
      ...base,
      pluginDomains: [{ domain: 'D', global: 'domain-text' }],
      promptFragments: [{ domain: 'MEM', local: 'fragment-text' }],
    })
    expect(out.indexOf('domain-text')).toBeLessThan(out.indexOf('fragment-text'))
    expect(out).toContain('domain-text\n\nfragment-text')
  })

  test('full 5-layer ordering: YAML → doctrine → registry → domains → fragments', () => {
    const out = composeSystemPrompt({
      ...base,
      peers: [peerA],
      pluginDomains: [{ domain: 'D', global: 'domain-text' }],
      promptFragments: [{ domain: 'MEM', global: 'fragment-text' }],
    })
    const order = [
      out.indexOf('personality:'),
      out.indexOf('Be the implementer.'),
      out.indexOf('## Known peers'),
      out.indexOf('domain-text'),
      out.indexOf('fragment-text'),
    ]
    expect(order.every(i => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// gatherPromptInput — FS discovery over ~/.iapeer + <cwd>/.iapeer
// ─────────────────────────────────────────────────────────────────────────────

describe('gatherPromptInput — FS discovery of all 4 layers', () => {
  let root: string
  let globalRoot: string
  let cwd: string
  let localRoot: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'iapeer-gather-'))
    globalRoot = join(root, 'home', '.iapeer')
    cwd = join(root, 'peer')
    localRoot = join(cwd, '.iapeer')
    mkdirSync(globalRoot, { recursive: true })
    mkdirSync(localRoot, { recursive: true })

    // Layer 2 — IAPEER.md, global + local
    writeFileSync(join(globalRoot, 'IAPEER.md'), 'GLOBAL DOCTRINE\n')
    writeFileSync(join(localRoot, 'IAPEER.md'), 'LOCAL ROLE\n')

    // Layer 4 — domains: both halves / global-only / local-only / 0-byte marker
    writeFileSync(join(globalRoot, 'MEMORY.md'), 'mm-global\n')
    writeFileSync(join(localRoot, 'MEMORY.md'), 'mm-local\n')
    writeFileSync(join(globalRoot, 'AAA.md'), 'aaa-global-only\n')
    writeFileSync(join(localRoot, 'ZZZ.md'), 'zzz-local-only\n')
    writeFileSync(join(localRoot, 'MARKER.md'), '') // presence marker, must not merge
    // a non-.md file must be ignored
    writeFileSync(join(localRoot, 'peer-profile.json'), '{}')

    // Layer 5 — fragments/ subdir of both roots: a paired stem (host-wide guide +
    // per-peer index) and a global-only fragment; a non-.md file must be ignored.
    const globalFrags = join(globalRoot, 'fragments')
    const localFrags = join(localRoot, 'fragments')
    mkdirSync(globalFrags, { recursive: true })
    mkdirSync(localFrags, { recursive: true })
    writeFileSync(join(globalFrags, 'iapeer-memory.md'), 'mem-guide\n') // host-wide guide
    writeFileSync(join(localFrags, 'iapeer-memory.md'), 'mem-index\n') // per-peer index
    writeFileSync(join(globalFrags, 'other-primitive.md'), 'other-frag\n')
    writeFileSync(join(localFrags, 'notes.txt'), 'ignored') // non-.md, must be ignored

    // Layer 3 — registry at the global root (deliberately UNSORTED on disk)
    const index = {
      version: 2,
      peers: [
        { personality: 'boris', runtime: 'claude', runtimes: ['claude'], description: 'PM', intelligence: 'artificial', cwd: '/p/boris' },
        { personality: 'nova', runtime: 'telegram', runtimes: ['telegram', 'claude'], description: 'owner', intelligence: 'natural', cwd: '/p/nova' },
      ],
    }
    writeFileSync(join(globalRoot, 'peers-profiles.json'), JSON.stringify(index))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  function gather() {
    return gatherPromptInput({
      personality: 'iapeer',
      description: 'impl',
      cwd,
      platform: 'darwin',
      osVersion: '15.5',
      user: 'u',
      hostname: 'h',
      today: '2026-06-06',
      globalRoot,
    })
  }

  test('layer 2: IAPEER.md read as global + local', () => {
    const input = gather()
    expect(input.globalDoctrine).toBe('GLOBAL DOCTRINE\n')
    expect(input.peerDoctrine).toBe('LOCAL ROLE\n')
  })

  test('layer 4: IAPEER.md excluded; other domains discovered, sorted, non-.md ignored', () => {
    const input = gather()
    expect((input.pluginDomains ?? []).map(d => d.domain)).toEqual(['AAA', 'MARKER', 'MEMORY', 'ZZZ'])
  })

  test('layer 4: per-domain global/local halves resolved correctly, each with its display path', () => {
    const input = gather()
    const byName = Object.fromEntries((input.pluginDomains ?? []).map(d => [d.domain, d]))
    expect(byName.MEMORY).toEqual({
      domain: 'MEMORY',
      global: 'mm-global\n',
      globalPath: join(globalRoot, 'MEMORY.md'),
      local: 'mm-local\n',
      localPath: join(localRoot, 'MEMORY.md'),
    })
    expect(byName.AAA).toEqual({ domain: 'AAA', global: 'aaa-global-only\n', globalPath: join(globalRoot, 'AAA.md') })
    expect(byName.ZZZ).toEqual({ domain: 'ZZZ', local: 'zzz-local-only\n', localPath: join(localRoot, 'ZZZ.md') })
    expect(byName.MARKER).toEqual({ domain: 'MARKER', local: '', localPath: join(localRoot, 'MARKER.md') }) // present but empty
  })

  test('layer 5: fragments/ subdir scanned, paired by stem (guide global + index local), sorted', () => {
    const input = gather()
    const frags = input.promptFragments ?? []
    expect(frags.map(f => f.domain)).toEqual(['iapeer-memory', 'other-primitive'])
    const byName = Object.fromEntries(frags.map(f => [f.domain, f]))
    const gfrag = join(globalRoot, 'fragments')
    const lfrag = join(localRoot, 'fragments')
    expect(byName['iapeer-memory']).toEqual({
      domain: 'iapeer-memory',
      global: 'mem-guide\n',
      globalPath: join(gfrag, 'iapeer-memory.md'),
      local: 'mem-index\n',
      localPath: join(lfrag, 'iapeer-memory.md'),
    })
    expect(byName['other-primitive']).toEqual({ domain: 'other-primitive', global: 'other-frag\n', globalPath: join(gfrag, 'other-primitive.md') })
    // the non-.md notes.txt never became a fragment
    expect(frags.map(f => f.domain)).not.toContain('notes')
  })

  test('layer 5: fragments are NOT confused with the root-level Layer-4 domains', () => {
    const input = gather()
    // the fragments dir itself is a directory, not a `.md` file → never a Layer-4 domain
    expect((input.pluginDomains ?? []).map(d => d.domain)).not.toContain('fragments')
  })

  test('layer 3: registry projected to EXACTLY 5 fields, sorted by personality', () => {
    const input = gather()
    expect((input.peers ?? []).map(p => p.personality)).toEqual(['boris', 'nova'])
    for (const p of input.peers ?? []) {
      expect(Object.keys(p).sort()).toEqual(['description', 'intelligence', 'personality', 'runtime', 'runtimes'])
    }
    expect((input.peers ?? [])[1]).toEqual({
      personality: 'nova',
      runtime: 'telegram',
      runtimes: ['telegram', 'claude'],
      description: 'owner',
      intelligence: 'natural',
    })
  })

  test('CHECKPOINT — the assembled prompt of a real peer contains all 4 layers, in order', () => {
    const prompt = composeSystemPrompt(gather())
    // Layer 1
    expect(prompt).toContain('---\npersonality: "iapeer"')
    // Layer 2
    expect(prompt).toContain('GLOBAL DOCTRINE')
    expect(prompt).toContain('LOCAL ROLE')
    // Layer 3 (with descriptions)
    expect(prompt).toContain('## Known peers')
    expect(prompt).toContain('- nova — owner')
    expect(prompt).toContain('- boris — PM')
    // Layer 4 (presence-marker file excluded, others per-file with path markers, sorted)
    expect(prompt).toContain('aaa-global-only')
    expect(prompt).toContain('zzz-local-only')
    // global half then a fresh marker then the local half (each its own marked section)
    expect(prompt).toContain(`<!-- ${join(globalRoot, 'MEMORY.md')} -->\nmm-global`)
    expect(prompt).toContain(`mm-global\n\n<!-- ${join(localRoot, 'MEMORY.md')} -->\nmm-local`)
    // Layer 5 (fragments: guide+index paired as separate marked sections, global-only fragment)
    expect(prompt).toContain(`<!-- ${join(globalRoot, 'fragments', 'iapeer-memory.md')} -->\nmem-guide`)
    expect(prompt).toContain(`mem-guide\n\n<!-- ${join(localRoot, 'fragments', 'iapeer-memory.md')} -->\nmem-index`)
    expect(prompt).toContain('other-frag')

    const order = [
      prompt.indexOf('personality: "iapeer"'),
      prompt.indexOf('LOCAL ROLE'),
      prompt.indexOf('## Known peers'),
      prompt.indexOf('aaa-global-only'),
      prompt.indexOf('mem-guide'), // Layer 5 — after every Layer-4 domain
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(prompt.indexOf('zzz-local-only')).toBeLessThan(prompt.indexOf('mem-guide'))
    // marker file produced no content and no blank-block artifact
    expect(prompt).not.toContain('MARKER')
    expect(prompt).not.toMatch(/\n{4,}/)
  })

  test('absent IAPEER.md → peerDoctrine "" (does not throw); empty dirs → no domains/peers', () => {
    const bareCwd = join(root, 'bare')
    const bareGlobal = join(root, 'bareglobal', '.iapeer')
    mkdirSync(join(bareCwd, '.iapeer'), { recursive: true })
    mkdirSync(bareGlobal, { recursive: true })
    const input = gatherPromptInput({
      personality: 'bare', description: '', cwd: bareCwd,
      platform: 'darwin', osVersion: '1', user: 'u', hostname: 'h', today: '2026-06-06',
      globalRoot: bareGlobal,
    })
    expect(input.peerDoctrine).toBe('')
    expect(input.globalDoctrine).toBeUndefined()
    expect(input.pluginDomains).toEqual([])
    expect(input.promptFragments).toEqual([]) // no fragments/ subdir → empty layer
    expect(input.peers).toEqual([])
    // composes to just the YAML block (no doctrine, no layers); the per-file
    // assembly normalizes the single section's trailing newlines to exactly one.
    const prompt = composeSystemPrompt(input)
    expect(prompt).not.toContain('## Known peers')
    expect(prompt).not.toContain('<!--') // no files → no markers
    expect(prompt.endsWith('---\n')).toBe(true)
    expect(prompt.endsWith('---\n\n')).toBe(false)
  })

  test('doctrine excluded from Layer 4 case-INSENSITIVELY; .MD ext picked up (verify edge-lens fix)', () => {
    // A separate tree so a lowercase iapeer.md cannot collide with the uppercase
    // IAPEER.md of the main fixture on a case-insensitive volume.
    const ciCwd = join(root, 'ci')
    const ciLocal = join(ciCwd, '.iapeer')
    const ciGlobal = join(root, 'ciglobal', '.iapeer')
    mkdirSync(ciLocal, { recursive: true })
    mkdirSync(ciGlobal, { recursive: true })
    writeFileSync(join(ciLocal, 'iapeer.md'), 'lowercase doctrine\n') // doctrine, lowercase name
    writeFileSync(join(ciLocal, 'OTHER.md'), 'other domain\n')
    writeFileSync(join(ciLocal, 'UP.MD'), 'upper ext domain\n') // uppercase extension

    const input = gatherPromptInput({
      personality: 'ci', description: '', cwd: ciCwd,
      platform: 'darwin', osVersion: '1', user: 'u', hostname: 'h', today: '2026-06-06',
      globalRoot: ciGlobal, peers: [],
    })
    const domains = (input.pluginDomains ?? []).map(d => d.domain)
    // The doctrine (whatever its on-disk case) must NEVER be a Layer-4 domain —
    // before the fix, on a case-sensitive FS 'iapeer' would leak in here.
    expect(domains).not.toContain('iapeer')
    expect(domains).toContain('OTHER')
    expect(domains).toContain('UP') // .MD upper-ext now included

    // And the doctrine text is never duplicated: at most once (Layer 2 on a
    // case-insensitive FS; zero on a case-sensitive FS where IAPEER.md is absent).
    const prompt = composeSystemPrompt(input)
    expect(prompt.split('lowercase doctrine').length - 1).toBeLessThanOrEqual(1)
  })

  test('gatherPromptInput honors a passed-in peers projection without a second registry read', () => {
    // Point globalRoot at a dir with NO peers-profiles.json — if gather tried to
    // read the registry it would just get []. We pass peers explicitly and expect
    // them through (sorted), proving the thread-through path works.
    const provided: PublicPeerSummary[] = [
      { personality: 'zeta', runtime: 'claude', runtimes: ['claude'], description: 'z', intelligence: 'artificial' },
      { personality: 'alpha', runtime: 'codex', runtimes: ['codex'], description: 'a', intelligence: 'artificial' },
    ]
    const input = gatherPromptInput({
      personality: 'x', description: '', cwd: join(root, 'noreg'),
      platform: 'darwin', osVersion: '1', user: 'u', hostname: 'h', today: '2026-06-06',
      globalRoot: join(root, 'noreg-global'), peers: provided,
    })
    expect((input.peers ?? []).map(p => p.personality)).toEqual(['alpha', 'zeta']) // sorted, not mutated input
    expect(provided.map(p => p.personality)).toEqual(['zeta', 'alpha']) // caller array untouched
  })
})
