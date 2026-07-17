// readLaunchEnv — the per-peer per-runtime launch.env parser (Ф-A #5, zone
// Хранение / Рантайм-адаптеры). Pure FS parser, no tmux: PEER_START_ARGS
// word-splits (faithful to the legacy unquoted ${PEER_START_ARGS} expansion),
// other KEY=VALUE lines become child env, quotes are stripped, comments/blanks
// are ignored, and a missing file → empty.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  LAUNCH_ENV_TEMPLATE,
  ensureLaunchEnv,
  ensureLocalRuntimeScopes,
  peerLaunchEnvPath,
  readLaunchEnv,
} from './index.ts'

let cwd: string
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'iapeer-launchenv-'))
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

function writeLaunchEnv(runtime: string, body: string): void {
  const p = peerLaunchEnvPath(cwd, runtime)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

describe('readLaunchEnv', () => {
  test('missing file → empty (no flags, no env)', () => {
    expect(readLaunchEnv(cwd, 'claude')).toEqual({ startArgs: [], env: {} })
  })

  test('PEER_START_ARGS word-splits on whitespace; surrounding quotes stripped', () => {
    writeLaunchEnv('claude', 'PEER_START_ARGS="--dangerously-load-development-channels --foo bar"\n')
    expect(readLaunchEnv(cwd, 'claude').startArgs).toEqual([
      '--dangerously-load-development-channels',
      '--foo',
      'bar',
    ])
  })

  test('single arg, no quotes', () => {
    writeLaunchEnv('codex', 'PEER_START_ARGS=--no-alt-screen\n')
    expect(readLaunchEnv(cwd, 'codex').startArgs).toEqual(['--no-alt-screen'])
  })

  test('other KEY=VALUE lines become child env; PEER_START_ARGS is consumed (not in env)', () => {
    writeLaunchEnv('claude', '# a comment\nexport FOO=bar\nBAZ="q u x"\nPEER_START_ARGS="--x"\n\n')
    const { startArgs, env } = readLaunchEnv(cwd, 'claude')
    expect(startArgs).toEqual(['--x'])
    expect(env).toEqual({ FOO: 'bar', BAZ: 'q u x' })
    expect(env.PEER_START_ARGS).toBeUndefined()
  })

  test('blank lines, comments, and non-assignment lines are ignored', () => {
    writeLaunchEnv('claude', '\n  # comment\nnot an assignment line\nKEY=value\n')
    expect(readLaunchEnv(cwd, 'claude').env).toEqual({ KEY: 'value' })
  })

  test('empty PEER_START_ARGS → no args', () => {
    writeLaunchEnv('claude', 'PEER_START_ARGS=""\nFOO=bar\n')
    const { startArgs, env } = readLaunchEnv(cwd, 'claude')
    expect(startArgs).toEqual([])
    expect(env).toEqual({ FOO: 'bar' })
  })

  // docs/17 — PEER_DISALLOWED_TOOLS: the ABSENT vs PRESENT-EMPTY distinction is the opt-in gate.
  test('PEER_DISALLOWED_TOOLS ABSENT → disallowedTools undefined (fleet default; key omitted)', () => {
    writeLaunchEnv('claude', 'FOO=bar\n')
    const le = readLaunchEnv(cwd, 'claude')
    expect(le.disallowedTools).toBeUndefined()
    expect('disallowedTools' in le).toBe(false) // omitted, so a differential oracle stays byte-identical
  })
  test('PEER_DISALLOWED_TOOLS explicit EMPTY → disallowedTools "" (opt-in: omit the flag) + consumed from env', () => {
    writeLaunchEnv('claude', 'PEER_DISALLOWED_TOOLS=\nFOO=bar\n')
    const { disallowedTools, env } = readLaunchEnv(cwd, 'claude')
    expect(disallowedTools).toBe('') // present-empty ≠ absent
    expect(env.PEER_DISALLOWED_TOOLS).toBeUndefined() // consumed as a launch directive, not a child env var
    expect(env).toEqual({ FOO: 'bar' })
  })
  test('PEER_DISALLOWED_TOOLS with a value → that verbatim list (quotes stripped)', () => {
    writeLaunchEnv('claude', 'PEER_DISALLOWED_TOOLS="Edit,Write"\n')
    expect(readLaunchEnv(cwd, 'claude').disallowedTools).toBe('Edit,Write')
  })
})

// ensureLaunchEnv — the default skeleton scaffold (owner decision 17.07: every
// agentic runtime scope carries launch.env from birth, so fleet-wide launch.env
// operations never skip a peer for lack of the file).
describe('ensureLaunchEnv', () => {
  test('creates the skeleton when missing', () => {
    ensureLaunchEnv(cwd, 'claude')
    expect(readFileSync(peerLaunchEnvPath(cwd, 'claude'), 'utf8')).toBe(LAUNCH_ENV_TEMPLATE)
  })

  test('the skeleton is semantically identical to no file at all (the neutrality invariant)', () => {
    const noFile = readLaunchEnv(cwd, 'claude')
    ensureLaunchEnv(cwd, 'claude')
    const skeleton = readLaunchEnv(cwd, 'claude')
    expect(skeleton).toEqual(noFile)
    // the opt-in gate specifically: the KEY must be absent, not present-empty
    expect('disallowedTools' in skeleton).toBe(false)
  })

  test('an existing operator-edited file is NEVER overwritten', () => {
    writeLaunchEnv('claude', 'PEER_START_ARGS="--keep-me"\n')
    ensureLaunchEnv(cwd, 'claude')
    expect(readLaunchEnv(cwd, 'claude').startArgs).toEqual(['--keep-me'])
  })

  test('ensureLocalRuntimeScopes scaffolds launch.env for agentic scopes only', () => {
    ensureLocalRuntimeScopes(cwd, ['claude', 'codex', 'telegram', 'notifier'])
    expect(existsSync(peerLaunchEnvPath(cwd, 'claude'))).toBe(true)
    expect(existsSync(peerLaunchEnvPath(cwd, 'codex'))).toBe(true)
    expect(existsSync(peerLaunchEnvPath(cwd, 'telegram'))).toBe(false)
    expect(existsSync(peerLaunchEnvPath(cwd, 'notifier'))).toBe(false)
  })
})
