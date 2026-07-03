import { describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { CODEX_BEARER_ENV_VAR, CODEX_DUMMY_BEARER } from '../core/constants.ts'
import { readLaunchEnv, peerLaunchEnvPath } from '../storage/index.ts'
import { claudeAdapter } from './adapters/claude.ts'
import { codexAdapter } from './adapters/codex.ts'
import { buildLaunchInvocation } from './invocation.ts'
import type { LaunchAdapterConfig, LaunchSpec, RuntimeAdapter } from './types.ts'

// NON-CIRCULAR GOLDEN (boris's bar): the ORACLE is the PRE-extraction inline build copied VERBATIM
// from launch/index.ts @595b0f4 — the source of truth is the OLD code, NOT buildLaunchInvocation.
// The differential test asserts the extracted function reproduces the oracle byte-for-byte; the
// independent contract assertions (hardcoded from the contract, not from the function's output) catch
// the case where oracle and function are wrong together. Two anchors: differential catches a
// reorganization drift, contract catches a shared error.
function oracleInline(
  spec: LaunchSpec,
  adapter: RuntimeAdapter,
  cfg: LaunchAdapterConfig & { env?: NodeJS.ProcessEnv },
): { argv: string[]; env: NodeJS.ProcessEnv } {
  const env = cfg.env ?? process.env
  const cwd = spec.cwd
  const identity = spec.identity
  const launchEnv = readLaunchEnv(cwd, spec.runtime)
  const specWithArgs: LaunchSpec =
    launchEnv.startArgs.length > 0
      ? { ...spec, extraArgs: [...(spec.extraArgs ?? []), ...launchEnv.startArgs] }
      : spec
  const runtimeArgv = adapter.buildArgv(specWithArgs, cfg)
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    ...launchEnv.env,
    ...(spec.runtime === 'codex' ? { [CODEX_BEARER_ENV_VAR]: CODEX_DUMMY_BEARER } : {}),
    PEER_PERSONALITY: spec.personality,
    PEER_RUNTIME: spec.runtime,
    PEER_IDENTITY: identity,
    // В45 mirrored in the oracle: a per-peer launch.env PATH override wins over the base env.
    PATH:
      launchEnv.env.PATH ??
      env.PATH ??
      `${homedir()}/.bun/bin:${homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`,
  }
  return { argv: runtimeArgv, env: childEnv }
}

const CFG: LaunchAdapterConfig & { env: NodeJS.ProcessEnv } = {
  claudeBin: '/bin/claude',
  codexBin: '/bin/codex',
  env: { PATH: '/test/path', BASE_VAR: 'base' },
}

function spec(over: Partial<LaunchSpec>): LaunchSpec {
  return {
    personality: 'p',
    runtime: 'claude',
    cwd: '/nonexistent-cwd-no-launchenv',
    identity: 'claude-p',
    socketPath: '/tmp/s.sock',
    extraArgs: [],
    ...over,
  }
}

const adapterFor = (s: LaunchSpec): RuntimeAdapter => (s.runtime === 'codex' ? codexAdapter : claudeAdapter)

// Representative specs: both runtimes × {bare, with system-prompt, with resume + extraArgs}.
const SPECS: Array<{ name: string; spec: LaunchSpec }> = [
  { name: 'claude bare', spec: spec({ runtime: 'claude', identity: 'claude-p' }) },
  {
    name: 'claude + system-prompt + resume + extras',
    spec: spec({ runtime: 'claude', identity: 'claude-p', systemPromptFile: '/sp.md', resume: true, resumeRef: 'uuid-9', extraArgs: ['--foo'] }),
  },
  { name: 'codex bare', spec: spec({ runtime: 'codex', identity: 'codex-p' }) },
  {
    name: 'codex + system-prompt + resume',
    spec: spec({ runtime: 'codex', identity: 'codex-p', systemPromptFile: '/sp.md', resume: true }),
  },
]

describe('buildLaunchInvocation — differential vs the verbatim pre-extraction oracle', () => {
  for (const { name, spec: s } of SPECS) {
    test(`byte-identical to the inline build: ${name}`, () => {
      const got = buildLaunchInvocation(s, adapterFor(s), CFG)
      const want = oracleInline(s, adapterFor(s), CFG)
      expect(got.argv).toEqual(want.argv)
      // В59 pins claude to the classic renderer — an INTENTIONAL addition BEYOND the pre-extraction
      // oracle. Assert it here, then exclude it from the byte-identity check so the differential still
      // guards everything the extraction was responsible for.
      if (s.runtime === 'claude') {
        expect(got.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1')
        delete got.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
      } else {
        expect(got.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined()
      }
      expect(got.env).toEqual(want.env)
    })
  }

  test('the launch.env merge branch (non-empty startArgs + extra env) is byte-identical too', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'inv-launchenv-'))
    try {
      const p = peerLaunchEnvPath(cwd, 'codex')
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, 'PEER_START_ARGS=--from-env-a --from-env-b\nEXTRA_VAR=xyz\n')
      const s = spec({ runtime: 'codex', identity: 'codex-p', cwd, extraArgs: ['--explicit'] })
      const got = buildLaunchInvocation(s, codexAdapter, CFG)
      const want = oracleInline(s, codexAdapter, CFG)
      expect(got.argv).toEqual(want.argv)
      expect(got.env).toEqual(want.env)
      // sanity on the branch itself: explicit extras precede launch.env startArgs, both after base flags
      expect(got.argv).toContain('--explicit')
      expect(got.argv).toContain('--from-env-a')
      expect(got.env.EXTRA_VAR).toBe('xyz')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('В45 — a launch.env PATH override WINS over the base env PATH (was silently clobbered)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'inv-path-'))
    try {
      const p = peerLaunchEnvPath(cwd, 'claude')
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, 'PATH=/peer/override/bin:/usr/bin\n')
      const s = spec({ runtime: 'claude', identity: 'claude-p', cwd })
      const got = buildLaunchInvocation(s, claudeAdapter, CFG)
      expect(got.env.PATH).toBe('/peer/override/bin:/usr/bin') // NOT CFG.env.PATH ('/test/path')
      // and without an override the base env PATH still applies
      const plain = mkdtempSync(join(tmpdir(), 'inv-path-plain-'))
      try {
        const s2 = spec({ runtime: 'claude', identity: 'claude-p', cwd: plain })
        expect(buildLaunchInvocation(s2, claudeAdapter, CFG).env.PATH).toBe('/test/path')
      } finally {
        rmSync(plain, { recursive: true, force: true })
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// Silent-loss guard — the claude-hosting canary caught a warm-deliver false-fail: a launch INITIATED
// from inside a claude session leaked CLAUDE_CODE_SESSION_ID + CLAUDE_CODE_CHILD_SESSION into the
// child, which then wrote no own transcript → newestActivityMtime null → landed-confirm blind while
// the message landed. buildLaunchInvocation must strip the claude-code-internal namespace so a
// launched claude is always a FRESH top-level session, regardless of initiator env.
describe('buildLaunchInvocation — strips the claude-code-internal session namespace', () => {
  const DIRTY: LaunchAdapterConfig & { env: NodeJS.ProcessEnv } = {
    claudeBin: '/bin/claude',
    codexBin: '/bin/codex',
    env: {
      PATH: '/test/path',
      BASE_VAR: 'base',
      CLAUDE_CODE_SESSION_ID: 'spawner-session-uuid', // the corruptor (pins the child to the spawner's session)
      CLAUDE_CODE_CHILD_SESSION: '1', // the corruptor (marks a child sub-session → suppresses own transcript)
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: '/v/2.1.177',
      CLAUDE_EFFORT: 'xhigh', // NOT in the claude-code namespace → must survive (scoped strip, not a wipe)
    },
  }
  test('claude launch: the whole CLAUDE_CODE_* namespace + CLAUDECODE is removed', () => {
    const { env } = buildLaunchInvocation(spec({ runtime: 'claude', identity: 'claude-p' }), claudeAdapter, DIRTY)
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.CLAUDE_CODE_EXECPATH).toBeUndefined()
    // scoped: non-namespace vars (incl. a CLAUDE_-prefixed-but-not-CLAUDE_CODE_ one) survive
    expect(env.BASE_VAR).toBe('base')
    expect(env.CLAUDE_EFFORT).toBe('xhigh')
    expect(env.PEER_IDENTITY).toBe('claude-p')
  })
  test('codex launch: same strip applies (harmless — codex ignores CLAUDE_*) and the bearer stub stays', () => {
    const { env } = buildLaunchInvocation(spec({ runtime: 'codex', identity: 'codex-p' }), codexAdapter, DIRTY)
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env[CODEX_BEARER_ENV_VAR]).toBe(CODEX_DUMMY_BEARER)
  })
  // В59 — the classic-renderer pin is a CLAUDE_CODE_* var, so it must be set AFTER the namespace strip
  // (else the strip loop would delete it). This guards that ordering: even with a DIRTY env full of
  // CLAUDE_CODE_* corruptors that get wiped, the pin survives on claude and is absent on codex.
  test('В59: claude is pinned to the classic renderer (survives the CLAUDE_CODE_* strip); codex has no such var', () => {
    const claudeEnv = buildLaunchInvocation(spec({ runtime: 'claude', identity: 'claude-p' }), claudeAdapter, DIRTY).env
    expect(claudeEnv.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1')
    const codexEnv = buildLaunchInvocation(spec({ runtime: 'codex', identity: 'codex-p' }), codexAdapter, DIRTY).env
    expect(codexEnv.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined()
  })
})

// Independent contract anchors — expectations come from the CONTRACT, not from the function output.
describe('buildLaunchInvocation — identity ABI + system-prompt swap (contract values)', () => {
  test('codex carries the non-secret IAPEER_BEARER stub; claude does NOT (identity in .mcp.json)', () => {
    expect(buildLaunchInvocation(spec({ runtime: 'codex', identity: 'codex-p' }), codexAdapter, CFG).env[CODEX_BEARER_ENV_VAR]).toBe(
      CODEX_DUMMY_BEARER,
    )
    expect(
      buildLaunchInvocation(spec({ runtime: 'claude', identity: 'claude-p' }), claudeAdapter, CFG).env[CODEX_BEARER_ENV_VAR],
    ).toBeUndefined()
  })

  test('the identity ABI is present and matches the spec', () => {
    const { env } = buildLaunchInvocation(spec({ runtime: 'codex', personality: 'boris', identity: 'codex-boris' }), codexAdapter, CFG)
    expect(env.PEER_PERSONALITY).toBe('boris')
    expect(env.PEER_RUNTIME).toBe('codex')
    expect(env.PEER_IDENTITY).toBe('codex-boris')
  })

  test('the per-session system-prompt swap rides in argv (codex -c, claude --system-prompt-file)', () => {
    const codexArgv = buildLaunchInvocation(spec({ runtime: 'codex', identity: 'codex-p', systemPromptFile: '/sp.md' }), codexAdapter, CFG).argv
    expect(codexArgv).toContain('model_instructions_file=/sp.md')
    const claudeArgv = buildLaunchInvocation(spec({ runtime: 'claude', identity: 'claude-p', systemPromptFile: '/sp.md' }), claudeAdapter, CFG).argv
    expect(claudeArgv.join(' ')).toContain('--system-prompt-file /sp.md')
  })
})
