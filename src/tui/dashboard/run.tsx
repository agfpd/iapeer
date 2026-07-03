// runDashboard — the Ink entry point + terminal owner of the management dashboard
// (tty form of `iapeer list`). Owns EVERYTHING terminal-shaped so the app stays pure:
//
//  - alt-screen: the dashboard is a full-screen live surface; it renders on the
//    alternate screen so quitting restores the operator's scrollback untouched
//    (Apple Terminal keeps no E3, so repeated in-scrollback repaints would pile up —
//    the alt-screen sidesteps that class entirely). The alt-screen is owned by INK
//    (`alternateScreen: true`), NOT written manually: Ink's resize/erase heuristics
//    (clear-on-width-shrink, fullscreen-frame clears) key on the buffer IT manages —
//    a manual \x1b[?1049h behind Ink's back left it erasing by stale line-counts, so
//    a window resize stacked old frames (live incident: the footer repeated ~5×).
//  - интерактив только в реальном TTY (контракт фазы): stdin+stdout must both be
//    TTYs, else the caller falls back to the scriptable table (never render + hang;
//    the same fail-closed belt as the onboard wizard).
//  - TUI↔TUI handoff = suspend-and-spawn (решение фазы, Требование-1): on attach the
//    dashboard fully unmounts + leaves the alt-screen + returns the terminal to
//    cooked mode, then spawns `iapeer attach <peer>` as a CHILD with inherited stdio
//    (the runtime TUI gets the REAL tty — the readline-class constraint), waits, and
//    remounts. One full-screen TUI owns the terminal at any moment. A child that
//    FAILS (spawn error OR exit≠0) is surfaced and acknowledged — never silently
//    remounted over (live incident: Enter looked dead because the attach child died
//    instantly and the remount swallowed its error).
//
// Self-invocation uses the same `$bunfs` discriminator as supervisor's
// resolveDaemonSelfArgv: compiled standalone → re-invoke the binary by verb; running
// from src → `bun <cli/index.ts> attach …`.

import React from 'react'
import { render } from 'ink'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DashboardApp, type DashAction } from './app.tsx'
import { attachFailureMessage } from './model.ts'

/** Sentinel: no real interactive TTY — the caller should print the scriptable table. */
export const DASHBOARD_NOT_INTERACTIVE = -1

/** argv prefix that re-invokes THIS package's CLI (compiled binary by verb / src via
 *  bun). Same discriminator as supervisor/index.ts resolveDaemonSelfArgv: `$bunfs` in
 *  the module path marks the compiled standalone (existsSync is NO discriminator —
 *  Bun intercepts bunfs reads). */
export function resolveSelfCliArgv(execPath: string, selfPath: string): string[] {
  return selfPath.includes('$bunfs') ? [execPath] : [execPath, selfPath]
}

function selfCliArgv(): string[] {
  return resolveSelfCliArgv(process.execPath, fileURLToPath(new URL('../../cli/index.ts', import.meta.url)))
}

export interface DashboardOptions {
  env?: NodeJS.ProcessEnv
}

/** Mount the dashboard once; resolve with the action that ended it. */
async function mountOnce(env: NodeJS.ProcessEnv): Promise<DashAction> {
  let action: DashAction = { type: 'quit' }
  const app = render(<DashboardApp env={env} onAction={a => (action = a)} />, {
    // the dashboard repaints in place on the alt screen; Ctrl-C is handled by the
    // app itself (quit action) so a half-torn frame never leaks to the main screen
    exitOnCtrlC: false,
    // Ink OWNS the alt-screen (enter on mount, exit+cursor-restore on unmount —
    // BEFORE waitUntilExit resolves, so the attach child always gets the primary
    // buffer). Manual 1049-writes behind Ink's back broke its resize erase model.
    alternateScreen: true,
  })
  await app.waitUntilExit()
  return action
}

/**
 * Run the live management dashboard. Loops mount → (attach child) → remount until
 * quit. Returns the process exit code, or DASHBOARD_NOT_INTERACTIVE when there is no
 * real TTY to drive it (caller falls back to the scriptable table).
 */
export async function runDashboard(opts: DashboardOptions = {}): Promise<number> {
  const env = opts.env ?? process.env
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return DASHBOARD_NOT_INTERACTIVE
  for (;;) {
    let action: DashAction
    try {
      action = await mountOnce(env)
    } catch {
      // raw-mode unsupported / render failed → let the caller fall back, never hang
      return DASHBOARD_NOT_INTERACTIVE
    }
    if (action.type === 'quit') return 0
    // suspend-and-spawn: the child owns the real TTY until the operator detaches
    // (Ctrl-]) or the session ends; then the dashboard remounts with fresh state.
    const argv = selfCliArgv()
    const r = spawnSync(argv[0]!, [...argv.slice(1), 'attach', action.personality], {
      stdio: 'inherit',
      env,
    })
    // Surface BOTH failure shapes before remounting: a spawn error AND a child that ran but
    // FAILED (exit≠0 / signal — its own stderr is already on the primary screen via inherit).
    // Remounting silently over either reads as "Enter does nothing" (live incident).
    const failure = attachFailureMessage(r)
    if (failure) {
      process.stdout.write(`attach ${action.personality} failed: ${failure}\npress Enter to continue…`)
      // swallow one line so the operator sees the error before the alt-screen returns
      spawnSync('sh', ['-c', 'read _'], { stdio: 'inherit' })
    }
  }
}
