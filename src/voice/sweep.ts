// Daemon-side voice idle sweep (docs/22): closes native Codex voice sessions iapeer opened once the
// conversation went idle, and records closes that happened outside us. Population = intent files
// (only sessions WE opened); a quiet host does one readdir per tick.

import type { LifecycleConfig } from '../lifecycle/index.ts'
import { voiceIdentities, voiceStateDir, voiceSweep, type VoiceDeps } from './index.ts'
import { realVoiceDeps } from './deps.ts'

export const DEFAULT_VOICE_SWEEP_INTERVAL_MS = 5_000

export function startVoiceSweep(
  cfg: LifecycleConfig,
  opts: { env: NodeJS.ProcessEnv; intervalMs?: number; depsFn?: (personality: string, env: NodeJS.ProcessEnv) => VoiceDeps; onError?: (err: unknown) => void },
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_VOICE_SWEEP_INTERVAL_MS
  if (intervalMs <= 0) return () => {}
  const dir = voiceStateDir(cfg.stateDir)
  const depsFn = opts.depsFn ?? realVoiceDeps
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      for (const identity of voiceIdentities(dir)) {
        if (!identity.startsWith('codex-')) continue
        const personality = identity.slice('codex-'.length)
        await voiceSweep(depsFn(personality, opts.env), [identity])
      }
    } catch (err) {
      opts.onError?.(err)
    } finally {
      running = false
    }
  }
  const t = setInterval(() => void tick(), intervalMs)
  t.unref?.()
  return () => clearInterval(t)
}
