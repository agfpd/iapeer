// tray onboard-step — HERMETIC: a temp IAPEER_ROOT (never the real ~/.iapeer), an
// injected Runner (no real brew/defaults/open), injected app-presence + brew probes.
// Covers: skip, dry-run variants, present→activate (no reinstall), absent+brew→install,
// brew-failure soft path, and the no-brew soft skip (plugin still dropped inert).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { onboardTrayStep } from './tray.ts'
import type { RunResult, Runner } from '../tray/install.ts'

let root: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-onboard-tray-'))
  env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    IAPEER_TEST_SANDBOX: '1',
    IAPEER_ROOT: root,
    IAPEER_BIN_DIR: join(root, 'bin'),
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A recording runner; `responses` maps a substring of "<cmd> <args…>" to a result. */
function makeRunner(responses: Array<[string, RunResult]> = []): { run: Runner; calls: string[] } {
  const calls: string[] = []
  const run: Runner = (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push(key)
    for (const [pat, res] of responses) if (key.includes(pat)) return res
    return { status: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

describe('onboardTrayStep', () => {
  test('--no-tray → skipped-flag, zero side effects', async () => {
    const { run, calls } = makeRunner()
    const r = await onboardTrayStep({ skip: true, env, run, probeApp: () => false, brewAvailable: () => true })
    expect(r.state).toBe('skipped-flag')
    expect(calls).toEqual([]) // never touched brew/defaults/open
  })

  test('dry-run reflects present / brew / no-brew without mutating', async () => {
    const { run, calls } = makeRunner()
    const present = await onboardTrayStep({ dryRun: true, env, run, probeApp: () => true, brewAvailable: () => true })
    expect(present.state).toBe('dry-run')
    expect(present.detail).toMatch(/present/i)

    const brew = await onboardTrayStep({ dryRun: true, env, run, probeApp: () => false, brewAvailable: () => true })
    expect(brew.detail).toMatch(/install SwiftBar/i)

    const noBrew = await onboardTrayStep({ dryRun: true, env, run, probeApp: () => false, brewAvailable: () => false })
    expect(noBrew.detail).toMatch(/no Homebrew/i)
    expect(calls).toEqual([]) // dry-run performs no side effects
  })

  test('SwiftBar present → activated (launched), NEVER reinstalls (no brew call)', async () => {
    const { run, calls } = makeRunner()
    const r = await onboardTrayStep({ env, run, probeApp: () => true, brewAvailable: () => true })
    expect(r.state).toBe('activated')
    expect(r.detail).toMatch(/launched/i)
    expect(calls.some(c => c.startsWith('brew '))).toBe(false) // idempotent: present → no reinstall
    expect(calls.some(c => c.startsWith('open '))).toBe(true) // launched + refreshed
    expect(existsSync(r.pluginFile!)).toBe(true)
  })

  test('absent + brew → installed (brew cask ran) + plugin activated', async () => {
    const { run, calls } = makeRunner([['brew install', { status: 0, stdout: '', stderr: '' }]])
    const r = await onboardTrayStep({ env, run, probeApp: () => false, brewAvailable: () => true })
    expect(r.state).toBe('installed')
    expect(calls.some(c => c.includes('brew install --cask --no-quarantine swiftbar'))).toBe(true)
    expect(existsSync(r.pluginFile!)).toBe(true)
  })

  test('absent + brew, brew FAILS → install-failed (soft), plugin still dropped', async () => {
    const { run } = makeRunner([['brew install', { status: 1, stdout: '', stderr: 'No such cask' }]])
    const r = await onboardTrayStep({ env, run, probeApp: () => false, brewAvailable: () => true })
    expect(r.state).toBe('install-failed')
    expect(r.detail).toMatch(/brew failed/i)
    expect(existsSync(r.pluginFile!)).toBe(true) // plugin file lands regardless (inert)
  })

  test('absent + NO brew → skipped-no-brew (soft), plugin dropped inert, no brew call', async () => {
    const { run, calls } = makeRunner()
    const r = await onboardTrayStep({ env, run, probeApp: () => false, brewAvailable: () => false })
    expect(r.state).toBe('skipped-no-brew')
    expect(r.detail).toMatch(/Homebrew not found/i)
    expect(calls.some(c => c.startsWith('brew '))).toBe(false) // never attempts brew
    expect(existsSync(r.pluginFile!)).toBe(true) // inert plugin still present for later activation
  })
})
