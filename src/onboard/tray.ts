// Tray-face onboard step (the SwiftBar menu-bar fleet dashboard).
//
// Host-phase, OPTIONAL, DEFAULT-NO (a GUI dependency — conservative: do not pull it
// onto the host without an explicit yes). This is a thin WRAPPER over the existing
// activation `installTray` (src/tray/install.ts) — the SAME mechanics as `iapeer tray
// install --app`: brew cask + dequarantine + launch + refresh — dressed in an
// onboard-shaped result vocabulary, with a SOFT no-Homebrew path (report + continue,
// NEVER fail the onboard) per the phase principle "unavailability is a soft skip".
//
// IDEMPOTENT: SwiftBar already installed → NOT reinstalled, only the plugin is
// (re)activated + launched. The plugin FILE itself is dropped by the foundation
// install step regardless (inert without SwiftBar); this step is the GUI activation.
//
// Outcome semantics: this step NEVER fails the onboard exit code — no tray is a fully
// valid state regardless of why (skipped / no brew / cask failure). Mirrors
// onboard/voice.ts deliberately (same shape), minus the provider-slot concepts.

import { isExecutable } from './index.ts'
import { installTray, swiftBarInstalled, type Runner } from '../tray/install.ts'

export interface TrayOnboardOptions {
  /** --no-tray (wizard) / absence of --tray (linear): skip the step entirely. */
  skip?: boolean
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  /** Injectable side-effect runner (tests). Default: installTray's own spawnSync. */
  run?: Runner
  /** Injectable SwiftBar.app presence probe (tests). Default swiftBarInstalled(). */
  probeApp?: () => boolean
  /** Injectable Homebrew-availability probe (tests). Default: `brew` on PATH. */
  brewAvailable?: () => boolean
}

export interface TrayOnboardResult {
  state:
    | 'installed' // SwiftBar.app installed (brew cask) + plugin activated + launched
    | 'activated' // SwiftBar already present → plugin activated + launched (idempotent, no reinstall)
    | 'skipped-flag' // --no-tray / not opted-in
    | 'skipped-no-brew' // SwiftBar absent AND no Homebrew — soft skip (plugin dropped inert; guidance given)
    | 'install-failed' // brew ran and failed (network/cask) — soft (reported; plugin still lands)
    | 'dry-run'
  detail?: string
  /** The resolved plugin file, when known. */
  pluginFile?: string
}

const DOCS = 'docs/16-tray.md'

export async function onboardTrayStep(opts: TrayOnboardOptions = {}): Promise<TrayOnboardResult> {
  const env = opts.env ?? process.env
  if (opts.skip) return { state: 'skipped-flag' }
  const probeApp = opts.probeApp ?? swiftBarInstalled
  const brewAvailable = opts.brewAvailable ?? ((): boolean => isExecutable('brew', env))

  if (opts.dryRun) {
    const present = probeApp()
    return {
      state: 'dry-run',
      detail: present
        ? 'SwiftBar present — would activate the fleet plugin + launch'
        : brewAvailable()
          ? 'would install SwiftBar.app (brew cask) + activate the fleet plugin + launch'
          : 'no Homebrew — would drop the plugin inert + advise manual SwiftBar install',
    }
  }

  const present = probeApp()

  // SwiftBar absent AND no Homebrew → SOFT skip. The auto-install path is brew-only, so
  // without it there is nothing to run; drop the plugin inert (it activates the moment
  // SwiftBar appears), guide the user, and NEVER fail the onboard.
  if (!present && !brewAvailable()) {
    const r = installTray({ env, installApp: false, launch: false, run: opts.run, probeApp: opts.probeApp })
    return {
      state: 'skipped-no-brew',
      pluginFile: r.pluginFile,
      detail:
        'Homebrew not found — the menu-bar app (SwiftBar) needs it. The fleet plugin is in place; ' +
        'install SwiftBar manually (`brew install --cask swiftbar`, or https://swiftbar.app), then run ' +
        `\`iapeer tray install --app\`. Details: ${DOCS}`,
    }
  }

  // Present → activate ONLY (installApp:false — never reinstall). Absent + brew → install the cask.
  const r = installTray({ env, installApp: !present, launch: true, run: opts.run, probeApp: opts.probeApp })
  if (r.app === 'install-failed') {
    return {
      state: 'install-failed',
      pluginFile: r.pluginFile,
      detail:
        `SwiftBar install via brew failed (${r.appReason ?? 'unknown'}) — the fleet plugin is in place; ` +
        `retry with \`iapeer tray install --app\` or install SwiftBar manually (${DOCS}).`,
    }
  }
  const activatedMsg = r.launched ? 'plugin activated + SwiftBar launched' : 'plugin written (SwiftBar not launched)'
  return {
    state: present ? 'activated' : 'installed',
    pluginFile: r.pluginFile,
    detail: `${activatedMsg}${r.dir === 'existing-swiftbar' ? ' (your SwiftBar plugin dir)' : ''}`,
  }
}
