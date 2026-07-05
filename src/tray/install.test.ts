// install — HERMETIC tray-install tests: a temp IAPEER_ROOT (never the real ~/.iapeer),
// an injected Runner (no real defaults/brew/open) and an injected app-presence probe.
// Covers: idempotent plugin-file write, dir selection (dedicated vs existing SwiftBar),
// the app-install path, uninstall leaving the fleet untouched, and the sandbox guard.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildPluginShim,
  dedicatedPluginDir,
  installTray,
  PLUGIN_BASENAME,
  trayAttachTerm,
  trayStatus,
  uninstallTray,
  type RunResult,
  type Runner,
} from './install.ts'

let root: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-tray-'))
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

const binPath = (e: NodeJS.ProcessEnv) => join(e.IAPEER_BIN_DIR!, 'iapeer')

describe('buildPluginShim', () => {
  test('is a streamable shim that execs the binary renderer', () => {
    const shim = buildPluginShim('/x/iapeer')
    expect(shim.startsWith('#!/bin/bash')).toBe(true)
    expect(shim).toContain('<swiftbar.type>streamable</swiftbar.type>')
    expect(shim).toContain('exec "/x/iapeer" tray render --stream')
  })

  test('clears proxy env before exec (loopback must not route through a VPN proxy)', () => {
    const shim = buildPluginShim('/x/iapeer')
    expect(shim).toContain('unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy')
    // the unset must come BEFORE the exec (env cleared before the binary starts)
    expect(shim.indexOf('unset HTTP_PROXY')).toBeLessThan(shim.indexOf('exec '))
  })
})

describe('installTray — plugin-only (SwiftBar absent)', () => {
  test('writes the shim into the dedicated dir; no shell touched', () => {
    const { run, calls } = makeRunner()
    const r = installTray({ env, run, probeApp: () => false })
    expect(r.app).toBe('absent')
    expect(r.dir).toBe('dedicated-only')
    expect(r.wrote).toBe(true)
    expect(r.pluginDir).toBe(dedicatedPluginDir(env))
    expect(r.pluginFile).toBe(join(dedicatedPluginDir(env), PLUGIN_BASENAME))
    const content = readFileSync(r.pluginFile, 'utf8')
    expect(content).toContain(`exec "${binPath(env)}" tray render --stream`)
    // absent + no installApp + no launch ⇒ zero external commands
    expect(calls).toEqual([])
  })

  test('is idempotent — a second run rewrites nothing', () => {
    installTray({ env, run: makeRunner().run, probeApp: () => false })
    const r2 = installTray({ env, run: makeRunner().run, probeApp: () => false })
    expect(r2.wrote).toBe(false)
    expect(existsSync(r2.pluginFile)).toBe(true)
  })
})

describe('installTray — SwiftBar present with a configured dir', () => {
  test('respects the existing plugin dir (does not hijack it)', () => {
    const existing = join(root, 'their-swiftbar-plugins')
    mkdirSync(existing, { recursive: true })
    const { run, calls } = makeRunner([['defaults read', { status: 0, stdout: existing, stderr: '' }]])
    const r = installTray({ env, run, probeApp: () => true })
    expect(r.dir).toBe('existing-swiftbar')
    expect(r.pluginDir).toBe(existing)
    expect(existsSync(join(existing, PLUGIN_BASENAME))).toBe(true)
    // read the dir, but never WRITE the default (we respect their choice)
    expect(calls.some(c => c.startsWith('defaults write'))).toBe(false)
  })
})

describe('installTray — installApp path', () => {
  test('brew-installs SwiftBar, points it at the dedicated dir, launches', () => {
    let installed = false
    const { run, calls } = makeRunner([
      ['brew install --cask', { status: 0, stdout: '', stderr: '' }],
      ['defaults read', { status: 1, stdout: '', stderr: '' }], // unset after fresh install
    ])
    const probeApp = () => installed
    // flip presence when brew runs
    const run2: Runner = (cmd, args) => {
      const res = run(cmd, args)
      if (cmd === 'brew') installed = true
      return res
    }
    const r = installTray({ env, run: run2, probeApp, installApp: true, launch: true })
    expect(r.app).toBe('installed')
    expect(r.dir).toBe('dedicated-configured')
    expect(r.launched).toBe(true)
    expect(calls.some(c => c.startsWith('brew install --cask') && c.includes('swiftbar'))).toBe(true)
    expect(calls.some(c => c.startsWith(`defaults write com.ameba.SwiftBar PluginDirectory -string ${dedicatedPluginDir(env)}`))).toBe(true)
    expect(calls.some(c => c.includes('swiftbar://refreshallplugins'))).toBe(true)
  })

  test('a brew failure is reported, not thrown; the plugin file still lands', () => {
    const { run } = makeRunner([['brew', { status: 1, stdout: '', stderr: 'network down' }]])
    const r = installTray({ env, run, probeApp: () => false, installApp: true })
    expect(r.app).toBe('install-failed')
    expect(r.appReason).toContain('network down')
    expect(existsSync(r.pluginFile)).toBe(true)
  })
})

describe('uninstallTray', () => {
  test('removes the plugin file and never touches the fleet', () => {
    const { pluginFile } = installTray({ env, run: makeRunner().run, probeApp: () => false })
    expect(existsSync(pluginFile)).toBe(true)
    const { run, calls } = makeRunner()
    const r = uninstallTray({ env, run, launch: true, probeApp: () => false })
    expect(r.removed).toContain(pluginFile)
    expect(existsSync(pluginFile)).toBe(false)
    // SwiftBar absent ⇒ nothing launched; and uninstall issues no daemon/fleet command ever
    expect(calls.every(c => !c.includes('fleet') && !c.startsWith('brew'))).toBe(true)
    expect(r.refreshed).toBe(false)
  })
})

describe('trayStatus', () => {
  test('reports plugin presence read-only', () => {
    const before = trayStatus({ env, run: makeRunner().run, probeApp: () => false })
    expect(before.plugin.installed).toBe(false)
    installTray({ env, run: makeRunner().run, probeApp: () => false })
    const after = trayStatus({ env, run: makeRunner().run, probeApp: () => false })
    expect(after.plugin.installed).toBe(true)
    expect(after.plugin.path).toBe(join(dedicatedPluginDir(env), PLUGIN_BASENAME))
  })
})

describe('trayAttachTerm', () => {
  test('writes a .command launcher (exec iapeer attach <peer>) and opens it — no TCC path', () => {
    const { run, calls } = makeRunner()
    const r = trayAttachTerm({ env, personality: 'boris', run })
    expect(r.cmdFile).toBe(join(root, 'tray', 'attach-boris.command'))
    const content = readFileSync(r.cmdFile, 'utf8')
    expect(content).toContain(`exec "${binPath(env)}" attach boris`)
    expect(content.startsWith('#!/bin/bash')).toBe(true)
    // launched via `open <file>.command` (Terminal handoff, no Automation/Accessibility)
    expect(calls).toContain(`open ${r.cmdFile}`)
  })

  test('threads an explicit runtime', () => {
    const r = trayAttachTerm({ env, personality: 'boris', runtime: 'codex', run: makeRunner().run })
    expect(readFileSync(r.cmdFile, 'utf8')).toContain(`attach boris codex`)
  })

  test('rejects an invalid peer name (shell-injection guard)', () => {
    expect(() => trayAttachTerm({ env, personality: 'boris; rm -rf ~', run: makeRunner().run })).toThrow(/invalid peer/)
  })
})

describe('sandbox guard', () => {
  test('refuses to install into the REAL ~/.iapeer under IAPEER_TEST_SANDBOX=1', () => {
    const unsafe = { HOME: process.env.HOME, IAPEER_TEST_SANDBOX: '1' } // no IAPEER_ROOT ⇒ resolves to ~/.iapeer
    expect(() => installTray({ env: unsafe, run: makeRunner().run, probeApp: () => false })).toThrow(/REAL ~\/\.iapeer/)
  })
})
