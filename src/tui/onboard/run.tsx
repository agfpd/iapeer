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
import { type Ansi, colorEnabled, makeAnsi } from '../ansi.ts'

/** Sentinel: the environment is not a real interactive TTY — caller should fall
 *  back to the linear non-interactive onboard path (never render raw + hang). */
export const WIZARD_NOT_INTERACTIVE = -1

export interface OnboardWizardOptions {
  env?: NodeJS.ProcessEnv
}

/** Style one post-Ink summary line to match the Ink wizard exactly: the headline
 *  (no leading glyph) bold — red when it announces errors; each item line keeps its
 *  glyph colored by status (✓ green / ! yellow / ✗ red / · gray) and dims the
 *  trailing " — detail", just as the in-wizard render does. */
function paintSummaryLine(line: string, a: Ansi): string {
  const m = line.match(/^(\s*)([✓!✗·]) (.*)$/)
  if (!m) return /error/i.test(line) ? a.bold(a.red(line)) : a.bold(line)
  const [, indent, mark, rest] = m
  const paintMark = mark === '✓' ? a.green : mark === '!' ? a.yellow : mark === '✗' ? a.red : a.gray
  const i = rest.indexOf(' — ')
  const label = i >= 0 ? rest.slice(0, i) : rest
  const detail = i >= 0 ? rest.slice(i) : ''
  return `${indent}${paintMark(mark)} ${label}${detail ? a.dim(detail) : ''}`
}

/** Color a `prefix: state[ rest]` progress line by the state's semantics, matching
 *  the wizard palette + the cross-CLI convention agreed with iapeer-memory: red for
 *  failure, GRAY for a neutral skip/decline (· semantics — yellow is reserved for
 *  warn/attention, not "user chose not to"), yellow for warn, green otherwise. */
function paintResult(prefix: string, state: string, rest: string, a: Ansi): string {
  const paint = /(fail|error|refus)/i.test(state)
    ? a.red
    : /(skip|declin)/i.test(state)
      ? a.gray
      : /(warn|missing|incomplete)/i.test(state)
        ? a.yellow
        : a.green
  return `${a.bold(`${prefix}:`)} ${paint(state)}${rest}`
}

/** Render the interactive onboard wizard. Resolves with the process exit code, or
 *  WIZARD_NOT_INTERACTIVE when there is no real TTY to drive it. */
export async function runOnboardWizard(opts: OnboardWizardOptions = {}): Promise<number> {
  const env = opts.env ?? process.env
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return WIZARD_NOT_INTERACTIVE
  }
  // Post-Ink lines are plain stdout (Ink has unmounted), so they carry their own
  // ANSI to stay visually continuous with the wizard. Gated: real TTY here (the
  // wizard only runs on one), off under NO_COLOR.
  const a = makeAnsi(colorEnabled(env, process.stdout))

  let result: WizardResult = { code: 0, memoryConsent: false, voiceConsent: false, telegramConsent: false, advisories: [], summary: [] }
  try {
    const app = render(<OnboardApp env={env} onResult={r => (result = r)} />)
    await app.waitUntilExit()
  } catch {
    return WIZARD_NOT_INTERACTIVE
  }

  // Post-Ink interactive provisioning — telegram THEN memory THEN voice (the canonical
  // order: telegram creates the human peer that memory's --human resolves from; voice is
  // an independent host backend). These own the terminal (inherited stdio / readline),
  // so they run AFTER Ink unmounts (no
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
      process.stdout.write(
        '\n' +
          a.bold('Setting up Telegram…') +
          a.dim(' (Ctrl-C to skip — add later: `iapeer create <you> --runtime telegram`)') +
          '\n',
      )
      try {
        const ts = await onboardTelegramStep({ env })
        process.stdout.write(paintResult('telegram', ts.state, ts.detail ? ` — ${ts.detail}` : '', a) + '\n')
      } catch (e) {
        process.stdout.write(paintResult('telegram', 'step skipped', ` — ${e instanceof Error ? e.message : String(e)}`, a) + '\n')
      }
    } else {
      process.stdout.write(
        '\n' + paintResult('telegram', 'skipped', ' — add later with `iapeer create <you> --runtime telegram`', a) + '\n',
      )
    }

    if (result.memoryConsent) {
      const { onboardMemoryProvider } = await import('../../onboard/memory.ts')
      process.stdout.write(
        '\n' +
          a.bold('Installing the shared-memory provider (@agfpd/iapeer-memory)…') +
          '\n' +
          a.dim(
            'This can take a few minutes — it builds a native module. Memory is OPTIONAL:\n' +
              'press Ctrl-C to skip it (set it up later with `npx @agfpd/iapeer-memory init`).',
          ) +
          '\n\n',
      )
      try {
        const mem = await onboardMemoryProvider({ env, runtime: result.hostRuntime, timeoutMs: 12 * 60_000 })
        const label = mem.provider ? `${mem.provider.provider} ${mem.provider.version}` : 'none'
        const rest = `${mem.detail ? ` — ${mem.detail}` : ''} ${a.dim(`(slot: ${label})`)}`
        process.stdout.write('\n' + paintResult('memory', mem.state, rest, a) + '\n')
      } catch (e) {
        const rest = ` — ${e instanceof Error ? e.message : String(e)} ${a.dim('(set up later: `npx @agfpd/iapeer-memory init`)')}`
        process.stdout.write('\n' + paintResult('memory', 'step skipped', rest, a) + '\n')
      }
    } else {
      process.stdout.write(
        '\n' + paintResult('memory', 'skipped', ' — set it up later with `npx @agfpd/iapeer-memory init`', a) + '\n',
      )
    }

    if (result.voiceConsent) {
      const { onboardVoiceProvider } = await import('../../onboard/voice.ts')
      process.stdout.write(
        '\n' +
          a.bold('Installing the voice provider backend (@agfpd/voice-connect)…') +
          '\n' +
          a.dim(
            'A local TTS/STT HTTP service. Voice is OPTIONAL: press Ctrl-C to skip it\n' +
              '(set it up later with `npx @agfpd/voice-connect init`).',
          ) +
          '\n\n',
      )
      try {
        const v = await onboardVoiceProvider({ env, timeoutMs: 12 * 60_000 })
        const label = v.provider ? `${v.provider.provider} ${v.provider.version}` : 'none'
        const rest = `${v.detail ? ` — ${v.detail}` : ''} ${a.dim(`(slot: ${label})`)}`
        process.stdout.write('\n' + paintResult('voice', v.state, rest, a) + '\n')
      } catch (e) {
        const rest = ` — ${e instanceof Error ? e.message : String(e)} ${a.dim('(set up later: `npx @agfpd/voice-connect init`)')}`
        process.stdout.write('\n' + paintResult('voice', 'step skipped', rest, a) + '\n')
      }
    } else {
      process.stdout.write(
        '\n' + paintResult('voice', 'skipped', ' — set it up later with `npx @agfpd/voice-connect init`', a) + '\n',
      )
    }
  } finally {
    process.removeListener('SIGINT', ignore)
    for (const h of prevInt) process.on('SIGINT', h as NodeJS.SignalsListener)
  }

  // Final summary (post-Ink, ANSI-styled to match the wizard's palette).
  process.stdout.write('\n')
  for (const line of result.summary) process.stdout.write(paintSummaryLine(line, a) + '\n')
  if (result.advisories.length > 0) {
    process.stdout.write('\n')
    // Advisories mirror the wizard's yellow box (a multi-line entry stays yellow
    // line-to-line until the trailing reset).
    for (const adv of result.advisories) process.stdout.write(a.yellow(adv) + '\n')
  }

  // Next steps — an aligned 2-column block (label padded, command highlighted), the
  // bot-token left as its own explicit step (no surprise / don't-make-them-guess).
  const next: Array<{ label: string; cmd: string; note?: string }> = [
    { label: 'Create your first agent', cmd: 'iapeer create <name> --runtime claude' },
  ]
  if (result.telegramConsent) {
    next.push({ label: 'Activate Telegram', cmd: 'iapeer connect telegram', note: 'paste a bot token from @BotFather' })
  }
  const w = Math.max(...next.map(n => n.label.length))
  process.stdout.write('\n' + a.bold('Next steps:') + '\n')
  for (const n of next) {
    process.stdout.write(
      `  ${a.cyan('•')} ${n.label.padEnd(w)}   ${a.cyan(n.cmd)}${n.note ? '  ' + a.dim(`(${n.note})`) : ''}\n`,
    )
  }
  return result.code
}
