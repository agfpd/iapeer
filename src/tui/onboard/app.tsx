// OnboardApp — the interactive onboard wizard (Ink). Owns the interactive +
// live-progress part and EXITS; the inherited-stdio memory install + the final
// summary run post-Ink (see run.tsx). Drives the SAME backend functions as the
// linear non-interactive path (no logic duplication), honoring the phase
// principles: explicit prompts (what to press), visible progress on otherwise
// silent steps (daemon start), and a clear next-step instead of a cryptic code.

import React, { useEffect, useState } from 'react'
import { Box, Text, useApp, useInput, useStdin } from 'ink'
import { ONBOARD_SECURITY_WARNING } from '../../onboard/risk.ts'
import { onboardHost, runtimeAuthNote, tccFullDiskAccessNote, type OnboardRuntime } from '../../onboard/index.ts'
import { probeFullDiskAccess } from '../../status/index.ts'
import { ensureDaemonStarted } from '../../daemon/main.ts'
import { iapeerBinPath } from '../../install/index.ts'

/** What the wizard hands back to run.tsx for the post-Ink phase (memory install +
 *  summary). */
export interface WizardResult {
  code: number
  memoryConsent: boolean
  advisories: string[]
  summary: string[]
  telegramConsent: boolean
  /** Host agentic runtime detected during the run (claude if installed, else
   *  codex, else undefined on a no-runtime host) — threaded to the memory
   *  provider init as `--runtime` per the onboard↔init contract. */
  hostRuntime?: OnboardRuntime
}

type Phase = 'gate' | 'running' | 'telegram' | 'memory' | 'declined' | 'finishing'
type StepStatus = 'pending' | 'running' | 'ok' | 'warn' | 'fail'
interface Step {
  key: string
  label: string
  status: StepStatus
  detail?: string
  /** Honest "this can take a moment" note shown while the step is running (the
   *  spinner can't animate during a blocking spawnSync, so the label carries the
   *  expectation). */
  hint?: string
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function useSpinnerFrame(active: boolean): string {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setI(n => (n + 1) % SPINNER.length), 80)
    return () => clearInterval(t)
  }, [active])
  return SPINNER[i]
}

function glyph(status: StepStatus, spin: string): string {
  switch (status) {
    case 'running':
      return spin
    case 'ok':
      return '✓'
    case 'warn':
      return '!'
    case 'fail':
      return '✗'
    default:
      return '·'
  }
}

function color(status: StepStatus): string {
  switch (status) {
    case 'ok':
      return 'green'
    case 'warn':
      return 'yellow'
    case 'fail':
      return 'red'
    case 'running':
      return 'cyan'
    default:
      return 'gray'
  }
}

export function OnboardApp({
  env,
  onResult,
}: {
  env: NodeJS.ProcessEnv
  onResult: (r: WizardResult) => void
}): React.ReactElement {
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const [phase, setPhase] = useState<Phase>('gate')
  const [steps, setSteps] = useState<Step[]>([])
  const [advisories, setAdvisories] = useState<string[]>([])
  const [hostRuntime, setHostRuntime] = useState<OnboardRuntime | undefined>(undefined)
  const [telegramConsent, setTelegramConsent] = useState(false)
  const spin = useSpinnerFrame(phase === 'running')

  const finish = (memoryConsent: boolean): void => {
    const failed = steps.some(s => s.status === 'fail')
    const summary = steps.map(s => {
      const mark = s.status === 'ok' ? '✓' : s.status === 'warn' ? '!' : s.status === 'fail' ? '✗' : '·'
      return `  ${mark} ${s.label}${s.detail ? ` — ${s.detail}` : ''}`
    })
    summary.unshift(failed ? 'Onboard finished with errors:' : 'Onboard complete:')
    onResult({ code: failed ? 1 : 0, memoryConsent, telegramConsent, advisories, summary, hostRuntime })
    setPhase('finishing')
    setTimeout(() => exit(), 30)
  }

  // Gate input — explicit y/N.
  useInput(
    (input, key) => {
      if (input === 'y' || input === 'Y') setPhase('running')
      else if (input === 'n' || input === 'N' || key.escape) setPhase('declined')
    },
    { isActive: phase === 'gate' },
  )

  // Telegram consent — DEFAULT-YES ([Y/n]). Records the decision; the actual setup
  // (install + ask name/user_id) runs post-Ink (its readline needs a cooked
  // terminal). Then → memory consent.
  useInput(
    (input, key) => {
      if (input === 'n' || input === 'N') {
        setTelegramConsent(false)
        setPhase('memory')
      } else if (input === 'y' || input === 'Y' || key.return) {
        setTelegramConsent(true)
        setPhase('memory')
      }
    },
    { isActive: phase === 'telegram' },
  )

  // Memory consent — DEFAULT-YES ([Y/n]: Enter or y → install).
  useInput(
    (input, key) => {
      if (input === 'n' || input === 'N') finish(false)
      else if (input === 'y' || input === 'Y' || key.return) finish(true)
    },
    { isActive: phase === 'memory' },
  )

  // Declined → exit 1 (no host mutation).
  useEffect(() => {
    if (phase !== 'declined') return
    onResult({ code: 1, memoryConsent: false, telegramConsent: false, advisories: [], summary: ['onboard aborted — risk not accepted.'] })
    const t = setTimeout(() => exit(), 30)
    return () => clearTimeout(t)
  }, [phase, onResult, exit])

  // Running phase — drive the backend steps sequentially with live status.
  useEffect(() => {
    if (phase !== 'running') return
    let cancelled = false
    const set = (k: string, patch: Partial<Step>) =>
      setSteps(prev => prev.map(s => (s.key === k ? { ...s, ...patch } : s)))
    setSteps([
      { key: 'daemon', label: 'Start router daemon', status: 'pending', hint: 'a few seconds' },
      { key: 'market', label: 'Register marketplace (claude, codex)', status: 'pending' },
      { key: 'auth', label: 'Check runtime sign-in', status: 'pending' },
      { key: 'fda', label: 'Check macOS Full Disk Access', status: 'pending' },
      {
        key: 'notifier',
        label: 'Install scheduler (timer · watcher)',
        status: 'pending',
        hint: 'first run can take up to a minute',
      },
    ])

    // Backend steps use synchronous spawnSync (launchctl, runtime plugin list) —
    // those block the event loop, so we yield (tick) after each status change so
    // Ink flushes a frame and steps paint as they progress, not all at once.
    // (Intra-step spinner can't animate while a single spawnSync blocks — a known
    // limitation until those backend calls go async; the step still shows.)
    const tick = () => new Promise<void>(r => setTimeout(r, 0))

    void (async () => {
      const adv: string[] = []
      set('daemon', { status: 'running' })
      await tick()
      try {
        const d = await ensureDaemonStarted({ env })
        const ok = d.state !== 'failed' && d.healthy !== false
        set('daemon', { status: ok ? 'ok' : 'fail', detail: d.detail ?? d.state })
      } catch (e) {
        set('daemon', { status: 'fail', detail: e instanceof Error ? e.message : String(e) })
      }
      if (cancelled) return
      await tick()

      set('market', { status: 'running' })
      await tick()
      const r = onboardHost({ env })
      const installed: OnboardRuntime[] = []
      for (const m of r.marketplaces) if (m.state !== 'runtime-missing') installed.push(m.runtime)
      // host-runtime for the memory init contract: claude if present (covers
      // both-installed → claude default), else codex, else undefined (no runtime).
      setHostRuntime(installed.includes('claude') ? 'claude' : installed[0])
      const mFail = r.marketplaces.some(m => m.state === 'failed')
      const allMissing = r.marketplaces.length > 0 && r.marketplaces.every(m => m.state === 'runtime-missing')
      set('market', {
        // runtime-missing is NOT success — show '!' (warn), never a contradictory ✓.
        status: mFail ? 'fail' : allMissing ? 'warn' : 'ok',
        detail: allMissing
          ? 'no agent runtime installed — skipped'
          : r.marketplaces
              .map(m => `${m.runtime}: ${m.state === 'runtime-missing' ? 'not installed' : m.state}`)
              .join(', '),
      })
      if (cancelled) return
      await tick()

      set('auth', { status: 'running' })
      await tick()
      if (installed.length === 0) {
        set('auth', { status: 'warn', detail: 'no runtime installed' })
        adv.push(
          '⚠ SETUP INCOMPLETE — no agent runtime found. iapeer needs an agent runtime: Claude Code OR Codex (either works).\n' +
            '  Install EITHER (commands verified against the official docs), sign in, then re-run `iapeer onboard`:\n' +
            '    Claude Code:  curl -fsSL https://claude.ai/install.sh | bash   (or: brew install --cask claude-code)\n' +
            '    Codex:        npm install -g @openai/codex                     (or: brew install --cask codex)\n' +
            '  If a download is blocked in your region, try the brew form or the other runtime.',
        )
      } else {
        const notes = installed.map(rt => runtimeAuthNote(rt, env)).filter((n): n is string => n != null)
        set('auth', {
          status: notes.length ? 'warn' : 'ok',
          detail: notes.length ? `${notes.length} runtime(s) not signed in` : installed.join(', '),
        })
        adv.push(...notes)
      }
      setAdvisories([...adv]) // surface SETUP-INCOMPLETE / auth advisories IN the wizard now
      if (cancelled) return

      set('fda', { status: 'running' })
      await tick()
      const fda = probeFullDiskAccess(env)
      const tcc = tccFullDiskAccessNote({ fda, binPath: iapeerBinPath(env) })
      set('fda', { status: tcc ? 'warn' : 'ok', detail: fda === true ? 'granted' : tcc ? 'not granted' : 'n/a' })
      if (tcc) adv.push(tcc)
      if (cancelled) return
      await tick()

      // notifier — the scheduler (timer · watcher) that memory's index upkeep
      // rides on; a silent default. Its npx install captures stdio (no terminal
      // contention), so it runs in-wizard like the other steps. Idempotent: a
      // present package/peers → no-op. A failure must NOT fail onboard (degrade).
      set('notifier', { status: 'running' })
      await tick()
      try {
        // canonical backbone step (same as the linear onboard path): zero-question,
        // captured-stdio, idempotent, soft-skip on unavailable.
        const { onboardNotifierStep } = await import('../../onboard/steps.ts')
        const ns = await onboardNotifierStep({ env, warn: () => {} })
        set('notifier', {
          status: ns.state === 'deployed' ? 'ok' : 'warn',
          detail: ns.state === 'deployed' ? `${ns.peers.length} peer(s)` : (ns.detail ?? ns.state),
        })
        if (ns.state !== 'deployed') adv.push(`Scheduler (notifier): ${ns.detail ?? ns.state}`)
      } catch (e) {
        set('notifier', { status: 'warn', detail: (e instanceof Error ? e.message : 'failed').slice(0, 60) })
      }
      if (cancelled) return
      await tick()

      setAdvisories([...adv])
      setPhase('telegram')
    })()

    return () => {
      cancelled = true
    }
  }, [phase, env])

  if (isRawModeSupported === false) {
    return (
      <Text color="yellow">
        iapeer onboard needs an interactive terminal. Open a normal terminal and run: iapeer onboard
      </Text>
    )
  }

  if (phase === 'gate') {
    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>
            Security warning — please read.
          </Text>
          <Text>{ONBOARD_SECURITY_WARNING.replace(/^Security warning — please read\.\n\n/, '')}</Text>
        </Box>
        <Box marginTop={1}>
          <Text bold>Continue? </Text>
          <Text dimColor>[y/N] </Text>
        </Box>
      </Box>
    )
  }

  if (phase === 'declined') {
    return <Text color="red">onboard aborted — risk not accepted.</Text>
  }

  // running | telegram | memory | finishing
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          iapeer
        </Text>
        <Text bold> · setting up the host</Text>
      </Box>
      <Box flexDirection="column">
        {steps.map(s => (
          <Box key={s.key}>
            <Text color={color(s.status)}>{glyph(s.status, spin)} </Text>
            <Text>{s.label}</Text>
            {s.detail ? (
              <Text dimColor> — {s.detail}</Text>
            ) : s.status === 'running' && s.hint ? (
              <Text dimColor> — {s.hint}…</Text>
            ) : null}
          </Box>
        ))}
      </Box>
      {advisories.length > 0 ? (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          {advisories.map((a, i) => (
            <Text key={i} color="yellow">
              {a}
            </Text>
          ))}
        </Box>
      ) : null}
      {phase === 'telegram' ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="cyan">
            ? Set up Telegram — talk to your agents from your phone?
          </Text>
          <Text dimColor> It will ask your name + Telegram user_id next. (bot token comes later) [Y/n]</Text>
        </Box>
      ) : null}
      {phase === 'memory' ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="cyan">
            ? Install the shared-memory provider (@agfpd/iapeer-memory)?
          </Text>
          <Text dimColor> Gives your agents a shared knowledge vault. [Y/n]</Text>
        </Box>
      ) : null}
    </Box>
  )
}
