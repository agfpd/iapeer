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
//
// Structure: Ink owns the interactive + live-progress part (gate, daemon/
// marketplace/auth/FDA steps, memory consent) and EXITS. The memory provider
// install — an INHERITED-STDIO subprocess (it owns its own tty questions) — runs
// AFTER Ink has unmounted, so the two never share the terminal at once. The final
// summary is plain text post-Ink (it folds in the memory outcome).

import React from 'react'
import { render } from 'ink'
import { OnboardApp, type WizardResult } from './app.tsx'

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
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return WIZARD_NOT_INTERACTIVE
  }

  let result: WizardResult = { code: 0, memoryConsent: false, advisories: [], summary: [] }
  try {
    const app = render(<OnboardApp env={env} onResult={r => (result = r)} />)
    await app.waitUntilExit()
  } catch {
    return WIZARD_NOT_INTERACTIVE
  }

  // Post-Ink: the memory provider install owns the terminal (inherited stdio).
  // Ink is fully unmounted now, so there is no contention.
  if (result.memoryConsent) {
    const { onboardMemoryProvider } = await import('../../onboard/memory.ts')
    process.stdout.write(
      '\nInstalling the shared-memory provider (@agfpd/iapeer-memory)…\n' +
        'This can take a few minutes — it builds a native module. Memory is OPTIONAL:\n' +
        'press Ctrl-C to skip it (set it up later with `npx @agfpd/iapeer-memory init`).\n\n',
    )
    // NON-WEDGE: ignore SIGINT in the PARENT during the install so Ctrl-C kills
    // only the foreground child installer (it dies → spawnSync returns) and we
    // continue to the summary, instead of the whole onboard dying. A no-op handler
    // prevents default parent termination; it is queued past the blocking spawnSync.
    // A generous wall-clock timeout is the last-resort backstop for a hung provider.
    const prevInt = process.listeners('SIGINT')
    process.removeAllListeners('SIGINT')
    const ignore = (): void => {}
    process.on('SIGINT', ignore)
    try {
      const mem = await onboardMemoryProvider({ env, timeoutMs: 12 * 60_000 })
      const label = mem.provider ? `${mem.provider.provider} ${mem.provider.version}` : 'none'
      process.stdout.write(`\nmemory: ${mem.state}${mem.detail ? ` — ${mem.detail}` : ''} (slot: ${label})\n`)
    } catch (e) {
      process.stdout.write(
        `\nmemory: step skipped — ${e instanceof Error ? e.message : String(e)} (set up later: \`npx @agfpd/iapeer-memory init\`)\n`,
      )
    } finally {
      process.removeListener('SIGINT', ignore)
      for (const h of prevInt) process.on('SIGINT', h as NodeJS.SignalsListener)
    }
  } else {
    process.stdout.write('\nmemory: skipped — set it up later with `npx @agfpd/iapeer-memory init`\n')
  }

  // Final summary (plain text, post-Ink).
  process.stdout.write('\n')
  for (const line of result.summary) process.stdout.write(line + '\n')
  if (result.advisories.length > 0) {
    process.stdout.write('\n')
    for (const a of result.advisories) process.stdout.write(a + '\n')
  }
  process.stdout.write('\nNext: create your first agent — `iapeer create <name> --runtime claude`\n')
  return result.code
}
