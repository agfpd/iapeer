// readLaunchEnv — the per-peer per-runtime launch.env parser (Ф-A #5, zone
// Хранение / Рантайм-адаптеры). Pure FS parser, no tmux: PEER_START_ARGS
// word-splits (faithful to the legacy unquoted ${PEER_START_ARGS} expansion),
// other KEY=VALUE lines become child env, quotes are stripped, comments/blanks
// are ignored, and a missing file → empty.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { peerLaunchEnvPath, readLaunchEnv } from './index.ts'

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
})
