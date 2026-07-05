// tray/install — idempotent lifecycle of the SwiftBar plugin that hosts the fleet
// dashboard. The plugin FILE is a thin shim: it execs the installed `iapeer` binary
// (`iapeer tray render --stream`), so ALL rendering/streaming logic lives in the
// binary (TypeScript, tested) rather than in brittle shell — the .sh is stable and
// carries only SwiftBar metadata.
//
// SwiftBar facts (verified against SwiftBar/PreferencesStore.swift):
//   • PluginDirectory is a PLAIN String default (read via expandingTildeInPath), NOT
//     a security-scoped bookmark — `defaults write com.ameba.SwiftBar PluginDirectory
//     -string <dir>` set BEFORE first launch is honored and skips the folder picker.
//   • SwiftBar is not sandboxed (it runs arbitrary scripts), so a hidden ~/.iapeer
//     path is readable without a TCC prompt.
//
// Packaging (owner decision 05.07.2026): the tray ships WITH the foundation (same
// class as the `iapeer list` TUI — another face of the daemon). `iapeer install`
// drops the plugin file (inert without SwiftBar); `iapeer tray install [--app]` is
// the activation verb that also installs SwiftBar.app when absent (owner-sanctioned)
// and launches it. Tearing down the GUI layer NEVER touches the fleet.
//
// Paths route through cfg/env (the dedicated plugin dir is under resolveGlobalRoot,
// so IAPEER_ROOT isolates it in tests); every external side-effect (defaults / brew /
// open) goes through an injectable Runner so tests stay hermetic.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { resolveGlobalRoot } from '../storage/index.ts'
import { iapeerBinPath } from '../install/index.ts'
import { resolveFleetAddress } from './client.ts'

/** Streamable plugin: the `.10s.` token is the RESPAWN cadence SwiftBar uses if the
 *  streaming process exits (daemon-down backoff); while the stream is alive it is
 *  ignored. The basename is stable — install rewrites the same file (idempotent). */
export const PLUGIN_BASENAME = 'iapeer.10s.sh'
const SWIFTBAR_DOMAIN = 'com.ameba.SwiftBar'
const SWIFTBAR_APP_PATHS = ['/Applications/SwiftBar.app', join(homedir(), 'Applications', 'SwiftBar.app')]

export type RunResult = { status: number | null; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[]) => RunResult

const defaultRun: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** The dedicated iapeer-owned plugin dir under ~/.iapeer (IAPEER_ROOT-isolated). */
export function dedicatedPluginDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalRoot(env), 'tray', 'plugins')
}

/** Is SwiftBar.app installed? (either /Applications or ~/Applications). */
export function swiftBarInstalled(): boolean {
  return SWIFTBAR_APP_PATHS.some(p => existsSync(p))
}

/** The plugin-dir SwiftBar is currently configured with (plain-string default,
 *  ~-expanded), or undefined when unset/unreadable. */
export function readSwiftBarPluginDir(run: Runner = defaultRun): string | undefined {
  const r = run('defaults', ['read', SWIFTBAR_DOMAIN, 'PluginDirectory'])
  if (r.status !== 0) return undefined
  const raw = r.stdout.trim()
  if (!raw) return undefined
  return raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
}

function setSwiftBarPluginDir(dir: string, run: Runner): RunResult {
  return run('defaults', ['write', SWIFTBAR_DOMAIN, 'PluginDirectory', '-string', dir])
}

function installSwiftBarApp(run: Runner): RunResult {
  // --no-quarantine: an automated install has no one to click through the Gatekeeper
  // "app downloaded from the Internet" dialog — quarantine would stall first launch.
  return run('brew', ['install', '--cask', '--no-quarantine', 'swiftbar'])
}

/** Strip any residual quarantine xattr from the app (belt-and-suspenders: an already
 *  brew-installed SwiftBar, or a brew that quarantined despite the flag, would else
 *  block first launch on a headless / no-click box). Best-effort. */
function dequarantineApp(run: Runner): void {
  const app = SWIFTBAR_APP_PATHS.find(p => existsSync(p))
  if (app) run('xattr', ['-dr', 'com.apple.quarantine', app])
}

function launchSwiftBar(run: Runner): void {
  run('open', ['-g', '-a', 'SwiftBar'])
}

function refreshSwiftBar(run: Runner): void {
  run('open', ['-g', 'swiftbar://refreshallplugins'])
}

/** The plugin shim: SwiftBar metadata + exec of the streaming renderer. binPath is
 *  embedded absolute (SwiftBar's PATH is minimal, like launchd). */
export function buildPluginShim(binPath: string): string {
  return [
    '#!/bin/bash',
    '# <xbar.title>iapeer fleet</xbar.title>',
    '# <xbar.version>v1</xbar.version>',
    '# <xbar.author>iapeer</xbar.author>',
    '# <xbar.desc>iapeer multi-agent fleet — live peer dashboard over the daemon fleet API.</xbar.desc>',
    '# <swiftbar.type>streamable</swiftbar.type>',
    '# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>',
    '# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>',
    '# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>',
    // The dashboard ONLY ever talks to the local daemon (unix socket / loopback), so it
    // must never route through an HTTP proxy. Bun's fetch caches proxy config at process
    // start and ignores NO_PROXY for loopback, so clearing the vars must happen in the
    // ENV before the binary launches (a runtime delete is too late). unset here.
    'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy',
    `exec "${binPath}" tray render --stream`,
    '',
  ].join('\n')
}

/** Fail-closed sandbox guard (in spirit with install/scaffoldHostDocs): never write
 *  into the REAL ~/.iapeer under a sandboxed test that forgot to set IAPEER_ROOT. */
function assertTraySandboxIsolated(env: NodeJS.ProcessEnv): void {
  if (env.IAPEER_TEST_SANDBOX === '1' && resolveGlobalRoot(env) === join(homedir(), '.iapeer')) {
    throw new Error('refusing to install the tray plugin into the REAL ~/.iapeer under IAPEER_TEST_SANDBOX=1 — set IAPEER_ROOT')
  }
}

export interface InstallTrayOptions {
  env?: NodeJS.ProcessEnv
  /** Install SwiftBar.app via brew when absent (owner-sanctioned). Default false. */
  installApp?: boolean
  /** Launch + refresh SwiftBar after writing the plugin. Default false. */
  launch?: boolean
  run?: Runner
  /** Injectable app-presence probe (tests). Default: swiftBarInstalled(). */
  probeApp?: () => boolean
}

export interface InstallTrayResult {
  pluginFile: string
  pluginDir: string
  /** Whether the plugin file bytes changed (false = already current). */
  wrote: boolean
  /** How the plugin dir was chosen. */
  dir: 'existing-swiftbar' | 'dedicated-configured' | 'dedicated-only'
  app: 'present' | 'installed' | 'install-failed' | 'absent'
  appReason?: string
  launched: boolean
}

/**
 * Idempotently install the tray plugin. Steps (each safe to repeat):
 *   1. install SwiftBar.app if absent && installApp (best-effort — a brew failure is
 *      reported, not thrown; the plugin file still lands so it activates later).
 *   2. resolve the target dir: an already-configured SwiftBar PluginDirectory is
 *      RESPECTED (install into the user's dir); otherwise the dedicated ~/.iapeer dir,
 *      and — only when SwiftBar is present — point SwiftBar at it via defaults.
 *   3. write the plugin shim (skip if byte-identical; always ensure +x).
 *   4. launch + refresh SwiftBar when launch && SwiftBar present.
 */
export function installTray(opts: InstallTrayOptions = {}): InstallTrayResult {
  const env = opts.env ?? process.env
  const run = opts.run ?? defaultRun
  const probeApp = opts.probeApp ?? swiftBarInstalled
  assertTraySandboxIsolated(env)
  const binPath = iapeerBinPath(env)

  // 1 — app
  let app: InstallTrayResult['app'] = probeApp() ? 'present' : 'absent'
  let appReason: string | undefined
  if (app === 'absent' && opts.installApp) {
    const r = installSwiftBarApp(run)
    if (r.status === 0 || probeApp()) app = 'installed'
    else {
      app = 'install-failed'
      appReason = (r.stderr || r.stdout || `brew exit ${r.status}`).trim().slice(0, 300)
    }
  }
  const present = app === 'present' || app === 'installed'

  // 2 — target dir
  const existing = present ? readSwiftBarPluginDir(run) : undefined
  let pluginDir: string
  let dir: InstallTrayResult['dir']
  if (existing && existsSync(existing)) {
    pluginDir = existing
    dir = 'existing-swiftbar'
  } else {
    pluginDir = dedicatedPluginDir(env)
    if (present) {
      setSwiftBarPluginDir(pluginDir, run)
      dir = 'dedicated-configured'
    } else {
      dir = 'dedicated-only'
    }
  }
  mkdirSync(pluginDir, { recursive: true })

  // 3 — plugin file (idempotent write; always +x)
  const pluginFile = join(pluginDir, PLUGIN_BASENAME)
  const content = buildPluginShim(binPath)
  let wrote = false
  if (!existsSync(pluginFile) || readFileSync(pluginFile, 'utf8') !== content) {
    writeFileSync(pluginFile, content, { mode: 0o755 })
    wrote = true
  } else {
    try {
      chmodSync(pluginFile, 0o755)
    } catch {
      /* best-effort */
    }
  }

  // 4 — launch + refresh
  let launched = false
  if (opts.launch && present) {
    dequarantineApp(run)
    launchSwiftBar(run)
    refreshSwiftBar(run)
    launched = true
  }

  return { pluginFile, pluginDir, wrote, dir, app, appReason, launched }
}

export interface UninstallTrayResult {
  removed: string[]
  /** SwiftBar was refreshed to drop the now-missing plugin. */
  refreshed: boolean
}

/**
 * Remove the tray plugin file from EVERY dir it could live in (the dedicated dir and
 * a configured SwiftBar dir) and refresh SwiftBar. DELIBERATELY leaves SwiftBar.app
 * installed (the user may run other plugins) and NEVER touches the fleet — the daemon,
 * TUI and delivery keep running (acceptance criterion: GUI teardown ≠ fleet teardown).
 */
export function uninstallTray(
  opts: { env?: NodeJS.ProcessEnv; launch?: boolean; run?: Runner; probeApp?: () => boolean } = {},
): UninstallTrayResult {
  const env = opts.env ?? process.env
  const run = opts.run ?? defaultRun
  assertTraySandboxIsolated(env)
  const present = (opts.probeApp ?? swiftBarInstalled)()
  const dirs = new Set<string>([dedicatedPluginDir(env)])
  if (present) {
    const existing = readSwiftBarPluginDir(run)
    if (existing) dirs.add(existing)
  }
  const removed: string[] = []
  for (const d of dirs) {
    const f = join(d, PLUGIN_BASENAME)
    if (existsSync(f)) {
      rmSync(f, { force: true })
      removed.push(f)
    }
  }
  let refreshed = false
  if (opts.launch && present) {
    refreshSwiftBar(run)
    refreshed = true
  }
  return { removed, refreshed }
}

export interface TrayStatus {
  daemon: { fleet: boolean; version?: string; sock?: string; tcp?: string }
  swiftbar: { installed: boolean; pluginDir?: string }
  plugin: { installed: boolean; path?: string }
}

/** Read-only diagnostics — never repairs anything. */
export function trayStatus(opts: { env?: NodeJS.ProcessEnv; run?: Runner; probeApp?: () => boolean } = {}): TrayStatus {
  const env = opts.env ?? process.env
  const run = opts.run ?? defaultRun
  const addr = resolveFleetAddress({ env })
  const installed = (opts.probeApp ?? swiftBarInstalled)()
  const cfgDir = installed ? readSwiftBarPluginDir(run) : undefined
  const searchDirs = [cfgDir, dedicatedPluginDir(env)].filter(Boolean) as string[]
  const found = searchDirs.map(d => join(d, PLUGIN_BASENAME)).find(f => existsSync(f))
  return {
    daemon: { fleet: addr.fleet === 1, version: addr.version, sock: addr.sock, tcp: addr.tcp },
    swiftbar: { installed, pluginDir: cfgDir },
    plugin: { installed: Boolean(found), path: found },
  }
}
