// runOnboardWizard — the Ink entry point for the interactive onboard wizard.
//
// Boundary (контракт «интерактив только в реальном TTY», фаза TUI-редизайн):
// the wizard runs ONLY in a real interactive terminal. The CLI routes here only
// when stdin AND stdout are TTYs and no non-interactive flag is set; install.sh
// never launches it (it prints a next-step to open a normal terminal). As a
// belt-and-suspenders guard against the readline-class wedge (Bun raw-mode on a
// redirect-opened /dev/tty reports isTTY=true but never receives input), we also
// fail CLOSED here: no real TTY → return WIZARD_NOT_INTERACTIVE so the caller
// falls back to the linear non-interactive path instead of rendering raw and
// hanging.

import React from 'react'
import { render } from 'ink'
import { OnboardApp } from './app.tsx'

/** Sentinel: the environment is not a real interactive TTY — caller should fall
 *  back to the linear non-interactive onboard path (never render raw + hang). */
export const WIZARD_NOT_INTERACTIVE = -1

export interface OnboardWizardOptions {
  env?: NodeJS.ProcessEnv
}

/** Render the interactive onboard wizard. Resolves with the process exit code, or
 *  WIZARD_NOT_INTERACTIVE when there is no real TTY to drive it. */
export async function runOnboardWizard(opts: OnboardWizardOptions = {}): Promise<number> {
  const env = opts.env ?? process.env
  // Primary guard: a real interactive terminal on BOTH ends. isTTY can lie under
  // a /dev/tty redirect, but the CLI only routes here for a user-launched onboard
  // in a normal terminal, and install.sh no longer pipes onboard at all.
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return WIZARD_NOT_INTERACTIVE
  }
  let code = 0
  try {
    const app = render(<OnboardApp env={env} onResult={c => { code = c }} />)
    await app.waitUntilExit()
  } catch {
    // Ink raw-mode init failed (raw unsupported) — degrade, never wedge.
    return WIZARD_NOT_INTERACTIVE
  }
  return code
}
