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
}

type Phase = 'gate' | 'running' | 'memory' | 'declined' | 'finishing'
type StepStatus = 'pending' | 'running' | 'ok' | 'warn' | 'fail'
interface Step {
  key: string
  label: string
  status: StepStatus
  detail?: string
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
  const spin = useSpinnerFrame(phase === 'running')

  const finish = (memoryConsent: boolean): void => {
    const failed = steps.some(s => s.status === 'fail')
    const summary = steps.map(s => {
      const mark = s.status === 'ok' ? '✓' : s.status === 'warn' ? '!' : s.status === 'fail' ? '✗' : '·'
      return `  ${mark} ${s.label}${s.detail ? ` — ${s.detail}` : ''}`
    })
    summary.unshift(failed ? 'Onboard finished with errors:' : 'Onboard complete:')
    onResult({ code: failed ? 1 : 0, memoryConsent, advisories, summary })
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
    onResult({ code: 1, memoryConsent: false, advisories: [], summary: ['onboard aborted — risk not accepted.'] })
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
      { key: 'daemon', label: 'Start router daemon', status: 'pending' },
      { key: 'market', label: 'Register marketplace (claude, codex)', status: 'pending' },
      { key: 'auth', label: 'Check runtime sign-in', status: 'pending' },
      { key: 'fda', label: 'Check macOS Full Disk Access', status: 'pending' },
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
      const mFail = r.marketplaces.some(m => m.state === 'failed')
      set('market', {
        status: mFail ? 'fail' : 'ok',
        detail: r.marketplaces.map(m => `${m.runtime}:${m.state}`).join(' '),
      })
      if (cancelled) return
      await tick()

      set('auth', { status: 'running' })
      await tick()
      if (installed.length === 0) {
        set('auth', { status: 'warn', detail: 'no runtime installed' })
        adv.push(
          '⚠ SETUP INCOMPLETE — no agent runtime found. iapeer needs Claude Code or Codex CLI\n' +
            '  to run peers. Install one, sign in, then re-run `iapeer onboard`.',
        )
      } else {
        const notes = installed.map(rt => runtimeAuthNote(rt, env)).filter((n): n is string => n != null)
        set('auth', {
          status: notes.length ? 'warn' : 'ok',
          detail: notes.length ? `${notes.length} runtime(s) not signed in` : installed.join(', '),
        })
        adv.push(...notes)
      }
      if (cancelled) return

      set('fda', { status: 'running' })
      await tick()
      const fda = probeFullDiskAccess(env)
      const tcc = tccFullDiskAccessNote({ fda, binPath: iapeerBinPath(env) })
      set('fda', { status: tcc ? 'warn' : 'ok', detail: fda === true ? 'granted' : tcc ? 'not granted' : 'n/a' })
      if (tcc) adv.push(tcc)
      if (cancelled) return

      setAdvisories(adv)
      setPhase('memory')
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

  // running | memory | finishing
  return (
    <Box flexDirection="column">
      <Text bold>Setting up the host…</Text>
      <Box flexDirection="column" marginTop={1}>
        {steps.map(s => (
          <Box key={s.key}>
            <Text color={color(s.status)}>{glyph(s.status, spin)} </Text>
            <Text>{s.label}</Text>
            {s.detail ? <Text dimColor> — {s.detail}</Text> : null}
          </Box>
        ))}
      </Box>
      {phase === 'memory' ? (
        <Box marginTop={1} flexDirection="column">
          <Text>Install the shared-memory provider (@agfpd/iapeer-memory)?</Text>
          <Text dimColor>It gives your agents a shared knowledge vault. [Y/n] </Text>
        </Box>
      ) : null}
    </Box>
  )
}
