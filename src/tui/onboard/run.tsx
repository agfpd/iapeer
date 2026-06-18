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

  let result: WizardResult = { code: 0, memoryConsent: false, telegramConsent: false, advisories: [], summary: [] }
  try {
    const app = render(<OnboardApp env={env} onResult={r => (result = r)} />)
    await app.waitUntilExit()
  } catch {
    return WIZARD_NOT_INTERACTIVE
  }

  // Post-Ink interactive provisioning — telegram THEN memory (the canonical order:
  // telegram creates the human peer that memory's --human resolves from). These own
  // the terminal (inherited stdio / readline), so they run AFTER Ink unmounts (no
  // contention). NON-WEDGE: ignore SIGINT in the parent so Ctrl-C kills only the
  // CURRENT step's child/readline and onboard continues to the summary, instead of
  // the whole flow dying. The no-op handler is queued past the blocking spawnSync.
  const prevInt = process.listeners('SIGINT')
  process.removeAllListeners('SIGINT')
  const ignore = (): void => {}
  process.on('SIGINT', ignore)
  try {
    if (result.telegramConsent) {
      const { onboardTelegramStep } = await import('../../onboard/steps.ts')
      process.stdout.write('\nSetting up Telegram… (Ctrl-C to skip — add later: `iapeer create <you> --runtime telegram`)\n')
      try {
        const ts = await onboardTelegramStep({ env })
        process.stdout.write(`telegram: ${ts.state}${ts.detail ? ` — ${ts.detail}` : ''}\n`)
      } catch (e) {
        process.stdout.write(`telegram: step skipped — ${e instanceof Error ? e.message : String(e)}\n`)
      }
    } else {
      process.stdout.write('\ntelegram: skipped — add later with `iapeer create <you> --runtime telegram`\n')
    }

    if (result.memoryConsent) {
      const { onboardMemoryProvider } = await import('../../onboard/memory.ts')
      process.stdout.write(
        '\nInstalling the shared-memory provider (@agfpd/iapeer-memory)…\n' +
          'This can take a few minutes — it builds a native module. Memory is OPTIONAL:\n' +
          'press Ctrl-C to skip it (set it up later with `npx @agfpd/iapeer-memory init`).\n\n',
      )
      try {
        const mem = await onboardMemoryProvider({ env, runtime: result.hostRuntime, timeoutMs: 12 * 60_000 })
        const label = mem.provider ? `${mem.provider.provider} ${mem.provider.version}` : 'none'
        process.stdout.write(`\nmemory: ${mem.state}${mem.detail ? ` — ${mem.detail}` : ''} (slot: ${label})\n`)
      } catch (e) {
        process.stdout.write(
          `\nmemory: step skipped — ${e instanceof Error ? e.message : String(e)} (set up later: \`npx @agfpd/iapeer-memory init\`)\n`,
        )
      }
    } else {
      process.stdout.write('\nmemory: skipped — set it up later with `npx @agfpd/iapeer-memory init`\n')
    }
  } finally {
    process.removeListener('SIGINT', ignore)
    for (const h of prevInt) process.on('SIGINT', h as NodeJS.SignalsListener)
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
