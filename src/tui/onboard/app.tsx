// OnboardApp — the interactive onboard wizard (Ink). First slice: security-gate
// screen → running steps with live progress → summary. Drives the SAME backend
// functions as the linear non-interactive path (no logic duplication) and renders
// them as screens, honoring the phase principles: explicit prompts (what to
// press), visible progress on otherwise-silent steps (daemon start), and a clear
// next-step instead of a cryptic code.
//
// NOTE (WIP): memory-provider setup + telegram/infra steps are layered in
// follow-up slices (memory install runs an inherited-stdio sub-process → handled
// via suspend-and-spawn, not inside the live Ink tree). Wizard is reached only
// behind the IAPEER_ONBOARD_WIZARD opt-in until feature-complete.

import React, { useEffect, useState } from 'react'
import { Box, Text, useApp, useInput, useStdin } from 'ink'
import { ONBOARD_SECURITY_WARNING } from '../../onboard/risk.ts'
import { onboardHost, runtimeAuthNote, tccFullDiskAccessNote, type OnboardRuntime } from '../../onboard/index.ts'
import { probeFullDiskAccess } from '../../status/index.ts'
import { ensureDaemonStarted } from '../../daemon/main.ts'
import { iapeerBinPath } from '../../install/index.ts'

type Phase = 'gate' | 'running' | 'declined' | 'done'
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
  onResult: (code: number) => void
}): React.ReactElement {
  const { exit } = useApp()
  const { isRawModeSupported } = useStdin()
  const [phase, setPhase] = useState<Phase>('gate')
  const [steps, setSteps] = useState<Step[]>([])
  const [advisories, setAdvisories] = useState<string[]>([])
  const spin = useSpinnerFrame(phase === 'running')

  // Gate input — explicit y/N (clear what to press; no silent raw read).
  useInput(
    (input, key) => {
      if (phase !== 'gate') return
      if (input === 'y' || input === 'Y') setPhase('running')
      else if (input === 'n' || input === 'N' || key.escape) setPhase('declined')
    },
    { isActive: phase === 'gate' },
  )

  // Declined / no-raw fallback → exit with the right code.
  useEffect(() => {
    if (phase === 'declined') {
      onResult(1)
      exit()
    }
  }, [phase, onResult, exit])

  // Running phase — drive the backend steps sequentially with live status.
  useEffect(() => {
    if (phase !== 'running') return
    let cancelled = false
    const set = (k: string, patch: Partial<Step>) =>
      setSteps(prev => prev.map(s => (s.key === k ? { ...s, ...patch } : s)))
    const initial: Step[] = [
      { key: 'daemon', label: 'Start router daemon', status: 'pending' },
      { key: 'market', label: 'Register marketplace (claude, codex)', status: 'pending' },
      { key: 'auth', label: 'Check runtime sign-in', status: 'pending' },
      { key: 'fda', label: 'Check macOS Full Disk Access', status: 'pending' },
    ]
    setSteps(initial)

    void (async () => {
      const adv: string[] = []
      // 1. daemon (the previously-silent step → now a visible spinner)
      set('daemon', { status: 'running' })
      try {
        const d = await ensureDaemonStarted({ env })
        const ok = d.state !== 'failed' && d.healthy !== false
        set('daemon', { status: ok ? 'ok' : 'fail', detail: d.detail ?? d.state })
      } catch (e) {
        set('daemon', { status: 'fail', detail: e instanceof Error ? e.message : String(e) })
      }
      if (cancelled) return

      // 2. marketplace
      set('market', { status: 'running' })
      const r = onboardHost({ env })
      const installed: OnboardRuntime[] = []
      for (const m of r.marketplaces) if (m.state !== 'runtime-missing') installed.push(m.runtime)
      const mFail = r.marketplaces.some(m => m.state === 'failed')
      set('market', {
        status: mFail ? 'fail' : 'ok',
        detail: r.marketplaces.map(m => `${m.runtime}:${m.state}`).join(' '),
      })
      if (cancelled) return

      // 3. runtime auth (clean-host login prerequisite)
      set('auth', { status: 'running' })
      if (installed.length === 0) {
        set('auth', { status: 'warn', detail: 'no runtime installed' })
        adv.push(
          'SETUP INCOMPLETE — no agent runtime found. Install Claude Code or Codex CLI,\n' +
            'sign in, then re-run `iapeer onboard`.',
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

      // 4. FDA (probe-driven; silent EPERM, not a hang)
      set('fda', { status: 'running' })
      const fda = probeFullDiskAccess(env)
      const tcc = tccFullDiskAccessNote({ fda, binPath: iapeerBinPath(env) })
      set('fda', { status: tcc ? 'warn' : 'ok', detail: fda === true ? 'granted' : tcc ? 'not granted' : 'n/a' })
      if (tcc) adv.push(tcc)
      if (cancelled) return

      setAdvisories(adv)
      setPhase('done')
    })()

    return () => {
      cancelled = true
    }
  }, [phase, env])

  // Done → emit result + exit (0 even with advisories: onboard did its work; a
  // missing runtime / FDA is a next-step, not an onboard failure).
  useEffect(() => {
    if (phase !== 'done') return
    const failed = steps.some(s => s.status === 'fail')
    onResult(failed ? 1 : 0)
    const t = setTimeout(() => exit(), 50)
    return () => clearTimeout(t)
  }, [phase, steps, onResult, exit])

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

  // running | done
  return (
    <Box flexDirection="column">
      <Text bold>{phase === 'done' ? 'Onboard complete.' : 'Setting up the host…'}</Text>
      <Box flexDirection="column" marginTop={1}>
        {steps.map(s => (
          <Box key={s.key}>
            <Text color={color(s.status)}>{glyph(s.status, spin)} </Text>
            <Text>{s.label}</Text>
            {s.detail ? <Text dimColor> — {s.detail}</Text> : null}
          </Box>
        ))}
      </Box>
      {phase === 'done' && advisories.length > 0 ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
          {advisories.map((a, i) => (
            <Text key={i} color="yellow">
              {a}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}
