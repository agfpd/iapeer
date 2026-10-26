// Composition of the voice engine's real effects (supervisor keyboard, lifecycle log, paths).
// Kept apart from src/voice/index.ts so the engine stays pure + injectable for tests.

import { routeControl } from '../transport/index.ts'
import { loadLifecycleConfig } from '../lifecycle/index.ts'
import { appendLifecycleEvent } from '../lifecycle/eventlog.ts'
import { DEFAULT_IDLE_SECS, voiceStateDir, type VoiceDeps } from './index.ts'

/** Voice idle timeout (seconds) — IAPEER_VOICE_IDLE_SECS overrides the default. */
export function voiceIdleSecs(env: NodeJS.ProcessEnv): number {
  const v = Number(env.IAPEER_VOICE_IDLE_SECS)
  return Number.isFinite(v) && v >= 10 ? v : DEFAULT_IDLE_SECS
}

export function realVoiceDeps(personality: string, env: NodeJS.ProcessEnv): VoiceDeps {
  const cfg = loadLifecycleConfig(env)
  return {
    env,
    stateDir: voiceStateDir(cfg.stateDir),
    ...(cfg.supervisorRunDir ? { runDir: cfg.supervisorRunDir } : {}),
    idleSecs: voiceIdleSecs(env),
    control: async args => {
      const r = await routeControl(personality, 'codex', { name: 'voice', args })
      return r.ok ? { ok: true } : { ok: false, error: r.error.message }
    },
    log: ev => {
      try {
        const fields: Record<string, string | number | undefined> = { personality }
        for (const [k, v] of Object.entries(ev)) fields[k] = typeof v === 'number' || v === undefined ? v : String(v)
        appendLifecycleEvent(cfg.eventLogDir, fields, { env })
      } catch {
        /* best-effort */
      }
    },
  }
}
