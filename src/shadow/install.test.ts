import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isFoundationOwnedPlist } from '../launch/launchd.ts'
import {
  SHADOW_PERSONALITY,
  SHADOW_PLIST_LABEL,
  buildShadowPlistSpec,
  cycleShadowJob,
  installShadowJob,
  installShadowPlist,
  shadowPlistPath,
  uninstallShadowJob,
} from './install.ts'

// Hermetic: every plist write lands under IAPEER_LAUNCHAGENTS_DIR / IAPEER_ROOT overrides, and
// the suite runs with IAPEER_TEST_SANDBOX=1 (process.env) so the launchctl-touching paths
// (installShadowJob / cycleShadowJob / uninstallShadowJob) fail-CLOSED to skipped-sandbox — they
// NEVER load/unload a real launchd job. No tmux, no @xterm (install.ts is pure plumbing).

const tmpDirs: string[] = []
function mkEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'iapeer-shadow-install-'))
  tmpDirs.push(root)
  return {
    IAPEER_LAUNCHAGENTS_DIR: join(root, 'LaunchAgents'),
    IAPEER_ROOT: join(root, 'iapeer'),
    HOME: root,
    PATH: '/usr/bin:/bin',
    ...extra,
  } as NodeJS.ProcessEnv
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})
const plutilLint = (path: string): boolean => spawnSync('plutil', ['-lint', path], { encoding: 'utf8' }).status === 0

describe('buildShadowPlistSpec', () => {
  test('label is com.iapeer.shadow-fidelity and runs the INSTALLED `iapeer shadow`', () => {
    const spec = buildShadowPlistSpec({ HOME: '/Users/x' } as NodeJS.ProcessEnv)
    expect(spec.label).toBe(SHADOW_PLIST_LABEL)
    expect(SHADOW_PLIST_LABEL).toBe('com.iapeer.shadow-fidelity')
    expect(spec.programArguments).toEqual(['/Users/x/.local/bin/iapeer', 'shadow'])
  })
  test('launchd-minimal PATH includes /opt/homebrew/bin (tmux lives there — the observer shells read-only tmux)', () => {
    expect(buildShadowPlistSpec({ HOME: '/Users/x' } as NodeJS.ProcessEnv).environment.PATH).toContain('/opt/homebrew/bin')
  })
  test('stdout/stderr land under ~/.iapeer/logs/iapeer', () => {
    const spec = buildShadowPlistSpec(mkEnv())
    expect(spec.stdoutPath).toContain(join('logs', 'iapeer', 'shadow-fidelity.launchd-stdout.log'))
    expect(spec.stderrPath).toContain(join('logs', 'iapeer', 'shadow-fidelity.launchd-stderr.log'))
  })
})

describe('installShadowPlist', () => {
  test('writes a valid, foundation-owned (sentinel) always-on plist under the override dir', () => {
    const env = mkEnv()
    const r = installShadowPlist(env)
    expect(r.path).toBe(shadowPlistPath(env))
    expect(r.changed).toBe(true)
    expect(existsSync(r.path)).toBe(true)
    expect(isFoundationOwnedPlist(r.path)).toBe(true) // carries the ownership sentinel
    expect(plutilLint(r.path)).toBe(true)
    const xml = readFileSync(r.path, 'utf8')
    expect(xml).toContain(`<string>${SHADOW_PLIST_LABEL}</string>`)
    expect(xml).toContain('<string>shadow</string>')
    expect(xml).toContain('<key>RunAtLoad</key>')
    expect(xml).toContain('<key>KeepAlive</key>')
  })

  test('idempotent by content: an unchanged re-install does NOT rewrite (changed:false, mtime stable); a changed PATH DOES', () => {
    const env = mkEnv()
    const first = installShadowPlist(env)
    expect(first.changed).toBe(true)
    const mtime1 = statSync(first.path).mtimeMs
    const second = installShadowPlist(env)
    expect(second.changed).toBe(false)
    expect(statSync(second.path).mtimeMs).toBe(mtime1) // file untouched (no BTM spam)
    // a different rendered plist (PATH override) rewrites
    const third = installShadowPlist(mkEnv({ IAPEER_SHADOW_PATH: '/opt/homebrew/bin:/usr/bin:/bin', IAPEER_LAUNCHAGENTS_DIR: env.IAPEER_LAUNCHAGENTS_DIR!, IAPEER_ROOT: env.IAPEER_ROOT!, HOME: env.HOME! }))
    expect(third.changed).toBe(true)
  })

  test('collision guard: REFUSES to overwrite a foreign (no-sentinel) plist at the label', () => {
    const env = mkEnv()
    const laDir = env.IAPEER_LAUNCHAGENTS_DIR!
    mkdirSync(laDir, { recursive: true })
    const path = shadowPlistPath(env)
    const foreign = '<?xml version="1.0"?>\n<plist><dict><key>Label</key><string>com.iapeer.shadow-fidelity</string></dict></plist>\n'
    writeFileSync(path, foreign)
    expect(() => installShadowPlist(env)).toThrow(/foundation-managed|refus/i)
    expect(readFileSync(path, 'utf8')).toBe(foreign) // untouched — guard fires before any write
  })
})

describe('installShadowJob (sandbox fail-closed)', () => {
  test('writes the plist FILE but NEVER touches launchctl under IAPEER_TEST_SANDBOX → skipped-sandbox', () => {
    const env = mkEnv()
    const r = installShadowJob(env)
    expect(r.action).toBe('skipped-sandbox')
    expect(r.path).toBe(shadowPlistPath(env))
    expect(r.changed).toBe(true)
    expect(existsSync(r.path)).toBe(true) // file written to the override dir
    expect(isFoundationOwnedPlist(r.path)).toBe(true)
  })
})

describe('cycleShadowJob (deploy re-cycle hook)', () => {
  test('returns null when no plist exists (nothing to recycle)', () => {
    expect(cycleShadowJob(mkEnv())).toBeNull()
  })
  test('a written foundation plist recycles to skipped-sandbox under the test flag (never a real launchctl cycle)', () => {
    const env = mkEnv()
    installShadowPlist(env)
    expect(cycleShadowJob(env)?.state).toBe('skipped-sandbox')
  })
  test('a foreign plist at the label is NOT recycled (ownership guard) → null', () => {
    const env = mkEnv()
    mkdirSync(env.IAPEER_LAUNCHAGENTS_DIR!, { recursive: true })
    writeFileSync(shadowPlistPath(env), '<?xml version="1.0"?>\n<plist><dict/></plist>\n')
    expect(cycleShadowJob(env)).toBeNull()
  })
})

describe('uninstallShadowJob', () => {
  test('absent plist → absent (no-op)', () => {
    expect(uninstallShadowJob(mkEnv()).action).toBe('absent')
  })
  test('foundation plist under sandbox → skipped-sandbox, plist left in place (no real bootout)', () => {
    const env = mkEnv()
    installShadowPlist(env)
    const r = uninstallShadowJob(env)
    expect(r.action).toBe('skipped-sandbox')
    expect(existsSync(shadowPlistPath(env))).toBe(true)
  })
  test('foreign plist → refused-foreign, untouched', () => {
    const env = mkEnv()
    mkdirSync(env.IAPEER_LAUNCHAGENTS_DIR!, { recursive: true })
    const path = shadowPlistPath(env)
    writeFileSync(path, '<?xml version="1.0"?>\n<plist><dict/></plist>\n')
    expect(uninstallShadowJob(env).action).toBe('refused-foreign')
    expect(existsSync(path)).toBe(true)
  })
})

describe('exports wire to the running job', () => {
  test('SHADOW_PERSONALITY/LABEL match the live burn-in job naming', () => {
    expect(SHADOW_PERSONALITY).toBe('shadow-fidelity')
    expect(SHADOW_PLIST_LABEL).toBe('com.iapeer.shadow-fidelity')
  })
})
