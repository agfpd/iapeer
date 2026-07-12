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

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { resolveGlobalRoot } from '../storage/index.ts'
import { iapeerBinPath } from '../install/index.ts'
import {
  IAPEER_PLIST_OWNER_KEY,
  bootoutLaunchdJob,
  bootstrapLaunchdJob,
  cycleLaunchdJob,
  isFoundationOwnedPlist,
  launchAgentsDir,
} from '../launch/launchd.ts'
import { resolveFleetAddress } from './client.ts'

/** Streamable plugin: the `.10s.` token is the RESPAWN cadence SwiftBar uses if the
 *  streaming process exits (daemon-down backoff); while the stream is alive it is
 *  ignored. The basename is stable — install rewrites the same file (idempotent). */
export const PLUGIN_BASENAME = 'iapeer.10s.sh'
const SWIFTBAR_DOMAIN = 'com.ameba.SwiftBar'
// SwiftBar's `defaults` domain IS its bundle identifier — reuse it for the autostart
// LaunchAgent's `open -b <bundleid>` (bundle-id launch survives the app moving/renaming
// between /Applications and ~/Applications, unlike a baked absolute path or `-a <name>`).
const SWIFTBAR_BUNDLE_ID = SWIFTBAR_DOMAIN
// The login-autostart LaunchAgent's label. Foundation namespace (`com.agfpd.*` = the
// foundation's own jobs), DELIBERATELY not `com.iapeer.<personality>` — that namespace
// is the persistent-peer fleet keyed on personality, and the tray autostart is neither a
// peer nor daemon-managed. Distinct label ⇒ it can never be mistaken for a peer plist by
// the H4 launchd-owned sweep-guard.
const SWIFTBAR_AUTOSTART_LABEL = 'com.agfpd.iapeer.tray'
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
    // NB: deliberately NOT hiding SwiftBar's own service items (Run-in-Terminal /
    // Disable / Last-Updated / Preferences / Refresh). They are the right-click "do
    // stuff" menu the owner expects; hiding them made the icon feel dead. Minimalism is
    // for OUR content (status + peer rows), not SwiftBar's utility menu.
    // The dashboard ONLY ever talks to the local daemon (unix socket / loopback), so it
    // must never route through an HTTP proxy. Bun's fetch caches proxy config at process
    // start and ignores NO_PROXY for loopback, so clearing the vars must happen in the
    // ENV before the binary launches (a runtime delete is too late). unset here.
    'unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy',
    `exec "${binPath}" tray render --stream`,
    '',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Login autostart — a RunAtLoad LaunchAgent that brings SwiftBar up at login, so the
// fleet dashboard + approval badge survive a reboot without a manual `open -a SwiftBar`.
//
// MECHANISM CHOICE (owner-relevant): a user LaunchAgent, not a System Events "Login
// Item" and not SMAppService.
//   • System Events Login Item (osascript `make login item`) — the manual stop-gap —
//     requires the INVOKING process to hold Automation TCC over System Events; that
//     grant is attributed to whatever parent runs the activation verb (Terminal / the
//     daemon / an onboard run), so it silently no-ops or prompts in a headless / update
//     context. A LaunchAgent needs no TCC at all — pure filesystem + launchctl.
//   • SMAppService (macOS 13+) is the modern path, but it registers a helper the TARGET
//     app ships — we cannot register a THIRD-PARTY GUI app (SwiftBar) with it from a CLI.
//   • The LaunchAgent reuses the foundation's proven idempotent plist lifecycle
//     (write-if-changed + undead-safe bootstrap/cycle, sandbox-guarded) and carries the
//     ownership sentinel so uninstall can recognize + remove exactly our artifact.
//
// RunAtLoad-ONLY, no KeepAlive: the ProgramArguments launch SwiftBar via `open` (which
// exits immediately once SwiftBar is up), so KeepAlive would respawn-storm `open` every
// throttle window. A login-autostart only needs to fire once per session; keeping
// SwiftBar itself supervised (relaunch-on-quit) would fight the user quitting it and
// duplicate SwiftBar's own launch-at-login — out of scope for "start it at login".
// ─────────────────────────────────────────────────────────────────────────────

/** Absolute path of the tray autostart LaunchAgent plist (IAPEER_LAUNCHAGENTS_DIR
 *  isolates it under test/sandbox; else ~/Library/LaunchAgents). */
export function swiftBarAutostartPlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(launchAgentsDir(env), `${SWIFTBAR_AUTOSTART_LABEL}.plist`)
}

/** Render the RunAtLoad SwiftBar-autostart plist. PURE/deterministic (golden-testable).
 *  Launch is `open -g -b <bundleid>`: LaunchServices activates the app correctly as a
 *  menu-bar agent (`-g` = don't steal focus), and bundle-id targeting survives the app
 *  moving. Carries the foundation ownership sentinel (inert `<key>` launchd ignores). */
export function renderSwiftBarAutostartPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SWIFTBAR_AUTOSTART_LABEL}</string>
    <key>${IAPEER_PLIST_OWNER_KEY}</key>
    <true/>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/open</string>
        <string>-g</string>
        <string>-b</string>
        <string>${SWIFTBAR_BUNDLE_ID}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
`
}

export type AutostartState =
  | 'loaded' // bootstrapped now (was not loaded)
  | 'already-loaded' // job already in the gui domain → no-op
  | 'restarted' // plist changed → cycled (bootout+bootstrap) onto the new content
  | 'skipped-sandbox' // IAPEER_TEST_SANDBOX=1 → never touch a real plist / launchctl
  | 'failed' // launchctl bootstrap/cycle failed
export interface EnsureAutostartResult {
  plistPath: string
  /** Whether the plist bytes changed (false = already current). */
  wrote: boolean
  state: AutostartState
  detail?: string
}

/**
 * Idempotently register the SwiftBar login-autostart LaunchAgent (write the plist if its
 * bytes changed, then load/restart it). Safe to repeat — a changed plist is cycled, an
 * unloaded one is bootstrapped, an unchanged-and-loaded one is a no-op (never a dup).
 * SANDBOX FAIL-SAFE: under IAPEER_TEST_SANDBOX with no isolated IAPEER_LAUNCHAGENTS_DIR
 * it writes NOTHING (a leaked real autostart would outlive the test) and touches no
 * launchctl; with an isolated dir it writes there but still skips launchctl (host-global).
 */
export function ensureSwiftBarAutostart(env: NodeJS.ProcessEnv = process.env): EnsureAutostartResult {
  const plistPath = swiftBarAutostartPlistPath(env)
  const content = renderSwiftBarAutostartPlist()
  const sandbox = env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1'
  const realAgents = join(homedir(), 'Library', 'LaunchAgents')
  if (sandbox && plistPath.startsWith(`${realAgents}/`)) {
    return {
      plistPath,
      wrote: false,
      state: 'skipped-sandbox',
      detail: 'IAPEER_TEST_SANDBOX=1 without IAPEER_LAUNCHAGENTS_DIR — refusing to write a real LaunchAgents plist',
    }
  }
  mkdirSync(launchAgentsDir(env), { recursive: true })
  let wrote = false
  if (!existsSync(plistPath) || readFileSync(plistPath, 'utf8') !== content) {
    // atomic write (tmp+rename): an interrupted direct write could leave a sentinel-less
    // stub that the ownership guard then reads as foreign.
    const tmp = `${plistPath}.tmp-${process.pid}`
    writeFileSync(tmp, content, { mode: 0o644 })
    renameSync(tmp, plistPath)
    wrote = true
  }
  if (sandbox) return { plistPath, wrote, state: 'skipped-sandbox' }
  // Live: load / restart onto the plist now on disk.
  const bootstrap = (): EnsureAutostartResult => {
    const bs = bootstrapLaunchdJob(SWIFTBAR_AUTOSTART_LABEL, plistPath, env)
    const state: AutostartState =
      bs.state === 'loaded' ? 'loaded' : bs.state === 'already-loaded' ? 'already-loaded' : 'failed'
    return { plistPath, wrote, state, detail: bs.detail }
  }
  if (!wrote) return bootstrap()
  const cyc = cycleLaunchdJob(SWIFTBAR_AUTOSTART_LABEL, plistPath, env)
  if (cyc.state === 'restarted') return { plistPath, wrote, state: 'restarted' }
  if (cyc.state === 'not-loaded') return bootstrap() // first install: nothing to cycle → load it
  return { plistPath, wrote, state: 'failed', detail: cyc.detail }
}

export interface RemoveAutostartResult {
  plistPath: string
  removed: boolean
  state: 'removed' | 'not-present' | 'foreign' | 'skipped-sandbox'
}

/**
 * Tear down the SwiftBar login-autostart LaunchAgent (bootout the job, remove the plist)
 * — the symmetric counterpart of ensureSwiftBarAutostart, run on `tray uninstall`. Only
 * removes OUR plist (ownership sentinel present); a sentinel-less file at the label is
 * left untouched (`foreign`). Sandbox-safe.
 */
export function removeSwiftBarAutostart(env: NodeJS.ProcessEnv = process.env): RemoveAutostartResult {
  const plistPath = swiftBarAutostartPlistPath(env)
  const sandbox = env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1'
  const realAgents = join(homedir(), 'Library', 'LaunchAgents')
  if (sandbox && plistPath.startsWith(`${realAgents}/`)) return { plistPath, removed: false, state: 'skipped-sandbox' }
  if (!existsSync(plistPath)) return { plistPath, removed: false, state: 'not-present' }
  if (!isFoundationOwnedPlist(plistPath)) return { plistPath, removed: false, state: 'foreign' }
  bootoutLaunchdJob(SWIFTBAR_AUTOSTART_LABEL, env) // unload the running job (sandbox-safe no-op)
  rmSync(plistPath, { force: true })
  return { plistPath, removed: true, state: 'removed' }
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
  /** Login-autostart registration outcome (only when launched + SwiftBar present). */
  autostart?: EnsureAutostartResult
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

  // 4 — launch + refresh + register login autostart (so a reboot brings the tray back).
  let launched = false
  let autostart: EnsureAutostartResult | undefined
  if (opts.launch && present) {
    dequarantineApp(run)
    launchSwiftBar(run)
    refreshSwiftBar(run)
    launched = true
    // Idempotent: the plist is byte-stable and the bootstrap is a no-op when loaded, so
    // re-activation never plants a duplicate autostart.
    autostart = ensureSwiftBarAutostart(env)
  }

  return { pluginFile, pluginDir, wrote, dir, app, appReason, launched, autostart }
}

export interface UninstallTrayResult {
  removed: string[]
  /** SwiftBar was refreshed to drop the now-missing plugin. */
  refreshed: boolean
  /** Login-autostart teardown outcome (the GUI-face activation is being removed). */
  autostart: RemoveAutostartResult
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
  // Tear down the login-autostart LaunchAgent too — removing the GUI face should not
  // leave a reboot re-launching SwiftBar. Never touches the fleet (bootout of our own
  // com.agfpd.* label only).
  const autostart = removeSwiftBarAutostart(env)
  return { removed, refreshed, autostart }
}

/**
 * Open a system Terminal attached to a peer WITHOUT SwiftBar's `terminal=true`. SwiftBar
 * v2's Terminal.app launch drives a `Cmd-T` keystroke via System Events, which silently
 * no-ops unless SwiftBar holds Accessibility permission — so tray attach clicks appeared
 * dead even after the Automation→Terminal grant. Instead: write a per-peer `.command`
 * launcher and `open` it. `open <file>.command` hands the file to Terminal.app (its
 * default handler) and runs it — a document-open, needing NO Automation/Accessibility
 * TCC. This is the tray's terminal handoff (docs/15: attach is client-side). The peer
 * name is validated (it is interpolated into a shell script). Returns the launcher path.
 */
export function trayAttachTerm(opts: {
  env?: NodeJS.ProcessEnv
  personality: string
  runtime?: string
  run?: Runner
}): { cmdFile: string } {
  const env = opts.env ?? process.env
  const run = opts.run ?? defaultRun
  const p = opts.personality
  if (!/^[a-z][a-z0-9-]*$/.test(p)) throw new Error(`invalid peer name "${p}"`)
  const rt = opts.runtime && /^[a-z][a-z0-9-]*$/.test(opts.runtime) ? opts.runtime : undefined
  const binPath = iapeerBinPath(env)
  const dir = join(resolveGlobalRoot(env), 'tray')
  mkdirSync(dir, { recursive: true })
  const cmdFile = join(dir, `attach-${p}.command`)
  writeFileSync(cmdFile, `#!/bin/bash\nexec "${binPath}" attach ${p}${rt ? ` ${rt}` : ''}\n`, { mode: 0o755 })
  run('open', [cmdFile])
  return { cmdFile }
}

export interface TrayStatus {
  daemon: { fleet: boolean; version?: string; sock?: string; tcp?: string }
  swiftbar: { installed: boolean; pluginDir?: string }
  plugin: { installed: boolean; path?: string }
  /** Login-autostart LaunchAgent: registered (our plist present) + its path. */
  autostart: { registered: boolean; path?: string }
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
  const autostartPath = swiftBarAutostartPlistPath(env)
  const autostartOurs = existsSync(autostartPath) && isFoundationOwnedPlist(autostartPath)
  return {
    daemon: { fleet: addr.fleet === 1, version: addr.version, sock: addr.sock, tcp: addr.tcp },
    swiftbar: { installed, pluginDir: cfgDir },
    plugin: { installed: Boolean(found), path: found },
    autostart: { registered: autostartOurs, path: autostartOurs ? autostartPath : undefined },
  }
}
