// codex hooks trust pre-seed — the deterministic replacement for the "Hooks
// need review" modal. The HARD anchor here: the GOLDEN hashes — three values
// codex-cli 0.138.0 itself granted live ("Trust all and continue", smoke
// 11.06, isolated CODEX_HOME). If the re-implemented algorithm drifts from
// these, we would seed state codex ignores → hooks silently skipped fleet-wide.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { realpathSync } from 'fs'
import {
  checkCodexHooksTrust,
  commandHookHash,
  computeHooksTrustEntries,
  preSeedCodexHooksTrust,
  removeCodexHooksTrustUnder,
} from './codexHooksTrust.ts'
import { codexGlobalConfigPath } from './nativeMemory.ts'

const dirs: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-hookstrust-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** Env pointing the codex global config into an isolated CODEX_HOME. */
function isolatedEnv(): { env: NodeJS.ProcessEnv; configPath: string } {
  const home = mkTmp()
  const env = { CODEX_HOME: home } as NodeJS.ProcessEnv
  return { env, configPath: codexGlobalConfigPath(env) }
}

function writeHooksJson(dir: string, content: unknown): string {
  const path = join(dir, 'hooks.json')
  writeFileSync(path, JSON.stringify(content, null, 2))
  return path
}

// ─── golden hashes (granted LIVE by codex-cli 0.138.0) ──────────────────────

describe('commandHookHash — golden values from live-granted trust', () => {
  test('session_start, no matcher, default timeout (V1 smoke hook)', () => {
    expect(
      commandHookHash('session_start', undefined, {
        command: '/tmp/iapeer-codex-hooks-smoke/bin/stamp.sh user-hooks-json-sessionstart',
      }),
    ).toBe('sha256:c21b34240dd15d7184bf391f13e820399cb4b8e97c22347689316f8d02207391')
  })

  test('session_start, no matcher, default timeout (V2 smoke hook)', () => {
    expect(
      commandHookHash('session_start', undefined, {
        command: '/tmp/iapeer-codex-hooks-smoke/bin/stamp.sh user-hooks-json-sessionstart-V2',
      }),
    ).toBe('sha256:5727103dc6b7409ae2a811561e28de70b625a2bdd28f8715a73e6542836f34fe')
  })

  test('post_tool_use, no matcher, default timeout (project-local smoke hook)', () => {
    expect(
      commandHookHash('post_tool_use', undefined, {
        command: '/tmp/iapeer-codex-hooks-smoke/bin/stamp.sh proj-hooks-json-posttooluse',
      }),
    ).toBe('sha256:86f96ab754e05851c6f2f9b162bd99c70359099cdb6c93c114d0e6df42971030')
  })

  test('normalization knobs shift the hash: timeout, matcher, statusMessage', () => {
    const base = commandHookHash('post_tool_use', undefined, { command: 'x' })
    expect(commandHookHash('post_tool_use', undefined, { command: 'x', timeout: 30 })).not.toBe(base)
    expect(commandHookHash('post_tool_use', 'Write|Edit', { command: 'x' })).not.toBe(base)
    expect(commandHookHash('post_tool_use', undefined, { command: 'x', statusMessage: 's' })).not.toBe(base)
    // explicit default timeout hashes the SAME as omitted (both normalize to 600)
    expect(commandHookHash('post_tool_use', undefined, { command: 'x', timeout: 600 })).toBe(base)
    // timeout 0 clamps to 1 (upstream .max(1)), distinct from the default
    expect(commandHookHash('post_tool_use', undefined, { command: 'x', timeout: 0 })).toBe(
      commandHookHash('post_tool_use', undefined, { command: 'x', timeout: 1 }),
    )
  })
})

// ─── hooks.json → entries ────────────────────────────────────────────────────

describe('computeHooksTrustEntries', () => {
  test('keys carry source:event_snake:group:handler; matcher passes through', () => {
    const entries = computeHooksTrustEntries(
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: 'Write', hooks: [{ type: 'command', command: 'a' }] },
            { hooks: [{ type: 'command', command: 'b' }, { type: 'command', command: 'c' }] },
          ],
        },
      }),
      '/some/hooks.json',
    )
    expect(entries.map(e => e.key)).toEqual([
      '/some/hooks.json:post_tool_use:0:0',
      '/some/hooks.json:post_tool_use:1:0',
      '/some/hooks.json:post_tool_use:1:1',
    ])
    expect(entries[0]!.hash).toBe(commandHookHash('post_tool_use', 'Write', { command: 'a' }))
    expect(entries[1]!.hash).toBe(commandHookHash('post_tool_use', undefined, { command: 'b' }))
  })

  test('skipped handlers (async / prompt / empty) consume their index, get no entry', () => {
    const entries = computeHooksTrustEntries(
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: 'first', async: true }, // h=0 skipped
                { type: 'prompt' }, // h=1 skipped
                { type: 'command', command: '  ' }, // h=2 skipped (empty)
                { type: 'command', command: 'real' }, // h=3 KEPT
              ],
            },
          ],
        },
      }),
      '/p/hooks.json',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.key).toBe('/p/hooks.json:session_start:0:3')
  })

  test('UserPromptSubmit/Stop force the matcher OFF (upstream matcher_pattern_for_event)', () => {
    const entries = computeHooksTrustEntries(
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: 'ignored', hooks: [{ type: 'command', command: 'x' }] }],
        },
      }),
      '/p/hooks.json',
    )
    expect(entries[0]!.hash).toBe(commandHookHash('stop', undefined, { command: 'x' }))
  })

  test('unknown event / malformed shapes are loud errors', () => {
    expect(() => computeHooksTrustEntries(JSON.stringify({ hooks: { NotAnEvent: [] } }), '/p')).toThrow(
      /unknown hook event/,
    )
    expect(() => computeHooksTrustEntries('not json', '/p')).toThrow(/not valid JSON/)
    expect(() => computeHooksTrustEntries(JSON.stringify({}), '/p')).toThrow(/"hooks" object/)
  })
})

// ─── pre-seed (state surgery) ────────────────────────────────────────────────

describe('preSeedCodexHooksTrust', () => {
  test('absent config → sections appended; second run → already', () => {
    const { env, configPath } = isolatedEnv()
    const proj = mkTmp()
    const hooksPath = writeHooksJson(proj, {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/x/stamp.sh' }] }] },
    })
    const first = preSeedCodexHooksTrust(hooksPath, env)
    expect(first.state).toBe('written')
    expect(first.entries).toHaveLength(1)
    const real = realpathSync(hooksPath)
    const text = readFileSync(configPath, 'utf8')
    expect(text).toContain(`[hooks.state."${real}:session_start:0:0"]`)
    expect(text).toContain(`trusted_hash = "${first.entries[0]!.hash}"`)
    expect(preSeedCodexHooksTrust(hooksPath, env).state).toBe('already')
  })

  test('NO-CLOBBER: foreign sections survive; changed hook updates IN PLACE', () => {
    const { env, configPath } = isolatedEnv()
    const proj = mkTmp()
    const hooksPath = writeHooksJson(proj, {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'one' }] }] },
    })
    mkdirSync(join(env.CODEX_HOME!), { recursive: true })
    const foreign = '[projects."/keep/me"]\ntrust_level = "trusted"\n\n[features]\nmemories = false\n'
    writeFileSync(configPath, foreign)
    preSeedCodexHooksTrust(hooksPath, env)
    // change the command → hash changes → same section updated, not duplicated
    writeHooksJson(proj, { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'two' }] }] } })
    const second = preSeedCodexHooksTrust(hooksPath, env)
    expect(second.state).toBe('written')
    const text = readFileSync(configPath, 'utf8')
    expect(text).toContain('[projects."/keep/me"]')
    expect(text).toContain('memories = false')
    const real = realpathSync(hooksPath)
    const headers = text.split('\n').filter(l => l.includes(`${real}:session_start:0:0`))
    expect(headers).toHaveLength(1) // updated in place — no duplicate section
    expect(text).toContain(`trusted_hash = "${second.entries[0]!.hash}"`)
  })

  test('missing hooks.json → failed (loud), config untouched', () => {
    const { env, configPath } = isolatedEnv()
    const o = preSeedCodexHooksTrust('/nonexistent/hooks.json', env)
    expect(o.state).toBe('failed')
    expect(existsSync(configPath)).toBe(false)
  })
})

// ─── check (read-only drift detector) ────────────────────────────────────────

describe('checkCodexHooksTrust', () => {
  test('missing → trusted after seed → drift after edit without re-seed', () => {
    const { env } = isolatedEnv()
    const proj = mkTmp()
    const hooksPath = writeHooksJson(proj, {
      hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'stamp' }] }] },
    })
    expect(checkCodexHooksTrust(hooksPath, env).checks[0]!.status).toBe('missing')
    preSeedCodexHooksTrust(hooksPath, env)
    expect(checkCodexHooksTrust(hooksPath, env).checks[0]!.status).toBe('trusted')
    writeHooksJson(proj, { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'edited' }] }] } })
    const drifted = checkCodexHooksTrust(hooksPath, env).checks[0]!
    expect(drifted.status).toBe('drift')
    expect(drifted.found).toBeDefined()
  })
})

// ─── remove (reap-side cleanup) ──────────────────────────────────────────────

describe('removeCodexHooksTrustUnder', () => {
  test('drops sections under the cwd, keeps everything else', () => {
    const { env, configPath } = isolatedEnv()
    const peerCwd = mkTmp()
    const hooksPath = writeHooksJson(peerCwd, {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] },
    })
    preSeedCodexHooksTrust(hooksPath, env)
    // a foreign hooks.state entry from ANOTHER peer must survive
    const foreign = '[hooks.state."/other/peer/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:keep"\n'
    writeFileSync(configPath, readFileSync(configPath, 'utf8') + foreign)
    const o = removeCodexHooksTrustUnder(peerCwd, env)
    expect(o.state).toBe('written')
    expect(o.removed).toHaveLength(1)
    const text = readFileSync(configPath, 'utf8')
    expect(text).not.toContain(realpathSync(hooksPath))
    expect(text).toContain('/other/peer/hooks.json')
    // idempotent
    expect(removeCodexHooksTrustUnder(peerCwd, env).state).toBe('already')
  })

  test('no config / no matches → already', () => {
    const { env } = isolatedEnv()
    expect(removeCodexHooksTrustUnder('/nope', env).state).toBe('already')
  })
})
