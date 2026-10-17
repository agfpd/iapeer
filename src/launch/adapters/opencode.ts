// opencode RuntimeAdapter — the "HOW to launch / observe ONE OpenCode session" half of the
// launch contract (docs/20-opencode.md). Unlike claude/codex, NOTHING here reads the screen:
// readiness, delivery and control go through the core-owned in-process plugin
// (src/opencode/iapeer-plugin.mjs) — its runtime.ready journal line, its control socket and its
// per-message persistence ack. The native TUI is still hosted by the pty supervisor (the human
// attach surface), but the core never pastes into it.
//
// Per-launch preparation (prepareLaunch):
//   • write the plugin source into <root>/state/opencode/<p>/ (re-written every launch — the
//     installed copy is never trusted to be current);
//   • compose OPENCODE_CONFIG_CONTENT: the operator's opencode.json + inline env config, the memory
//     and capability fragments, then the core-required fields (agent.iapeer.prompt = the freshly
//     composed doctrine, the iapeer MCP, the plugin) — doctrine is re-read on EVERY process launch,
//     including resume;
//   • the plugin ABI env: IAPEER_OPENCODE_DIR / _LAUNCH_ID / _SESSION (resume only).
//
// State is personality-scoped (not cwd-scoped: two personalities may share a cwd), so the
// observation methods take the optional ObserveContext; without it they answer null/not-ok.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { composeOpencodeConfig, hasExplicitModel, OPENCODE_AGENT, OPENCODE_PLUGIN_SOURCE, opencodePaths, writeOpencodePlugin } from '../../opencode/config.ts'
import { opencodeControl } from '../../opencode/control.ts'
import { fileMtimeMs, readJournalFrom, readOpencodeState } from '../../opencode/journal.ts'
import { resolveDaemonMcpUrl } from '../../storage/index.ts'
import { resolveFleetBase } from '../../approval/brokerClient.ts'
import type {
  ApprovalMode,
  ControlCommand,
  ControlPlan,
  LaunchAdapterConfig,
  LaunchSpec,
  ObserveContext,
  PreparedLaunch,
  RuntimeAdapter,
} from '../types.ts'

/** Compaction is a model turn; bound it like a long turn, not like a socket round-trip. */
export const OPENCODE_COMPACT_TIMEOUT_MS = 600_000

/** Journal byte offset at prepare time, per launchID — structuralReady scans only THIS launch's lines. */
const readyOffsets = new Map<string, number>()

function newLaunchID(): string {
  return `lch_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`
}

function paths(personality: string, env?: NodeJS.ProcessEnv) {
  return opencodePaths(personality, { env })
}

function controlSocket(personality: string, env?: NodeJS.ProcessEnv): string {
  return `${paths(personality, env).dir}/control.sock`
}

export const opencodeAdapter: RuntimeAdapter = {
  runtime: 'opencode',
  kind: 'tui',
  usesDoctrine: true,
  // No pty submit surface: the core never pastes into the OpenCode TUI.
  deliveryMarkers: { promptGlyphs: [] },
  deliveryConfirm: 'structural',

  buildArgv(spec: LaunchSpec, cfg: LaunchAdapterConfig): string[] {
    const argv = [cfg.opencodeBin ?? 'opencode']
    if (spec.resume && spec.resumeRef) argv.push('--session', spec.resumeRef)
    argv.push('--agent', OPENCODE_AGENT)
    // yolo (default) = the fleet's bypass posture; gated launches without it so native
    // permission requests reach the approval path (docs/17, OC10).
    if ((spec.approvalMode ?? 'yolo') === 'yolo') argv.push('--auto')
    if (spec.extraArgs?.length) argv.push(...spec.extraArgs)
    return argv
  },

  prepareLaunch(spec, baseEnv, cfg): PreparedLaunch {
    const env = cfg.env ?? process.env
    if (!spec.systemPromptFile || !existsSync(spec.systemPromptFile)) {
      throw new Error(`opencode: composed system prompt missing (${spec.systemPromptFile ?? 'none'})`)
    }
    const doctrine = readFileSync(spec.systemPromptFile, 'utf8')
    const p = paths(spec.personality, env)
    writeOpencodePlugin(spec.personality, OPENCODE_PLUGIN_SOURCE, { env })
    const config = composeOpencodeConfig(
      {
        personality: spec.personality,
        doctrine,
        daemonUrl: resolveDaemonMcpUrl({ env }),
        inline: baseEnv.OPENCODE_CONFIG_CONTENT,
        approvalMode: spec.approvalMode ?? 'yolo',
      },
      { env },
    )
    const launchID = newLaunchID()
    readyOffsets.set(launchID, existsSync(p.events) ? statSync(p.events).size : 0)
    const out: Record<string, string> = {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      IAPEER_OPENCODE_DIR: p.dir,
      IAPEER_OPENCODE_LAUNCH_ID: launchID,
      IAPEER_IDENTITY: spec.identity,
      // A fleet peer never self-updates (config autoupdate:false says the same; the flag also covers
      // native paths that read only the env). Updates are an operator action.
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      // docs/17: the plugin bridges native permission asks to the daemon broker only when gated.
      IAPEER_APPROVAL_MODE: spec.approvalMode ?? 'yolo',
      IAPEER_FLEET_URL: resolveFleetBase(env),
    }
    if (spec.resume && spec.resumeRef) out.IAPEER_OPENCODE_SESSION = spec.resumeRef
    const warnings = hasExplicitModel(config)
      ? []
      : [`opencode-implicit-provider: no explicit "model" in ${p.config} — OpenCode's own default provider receives the doctrine and messages`]
    return { env: out, readyToken: launchID, warnings }
  },

  async structuralReady(spec, launchID, deadlineMs, alive, env) {
    const p = paths(spec.personality, env)
    let offset = readyOffsets.get(launchID) ?? 0
    try {
      while (Date.now() < deadlineMs) {
        const { lines, end } = readJournalFrom(p.events, offset)
        offset = end
        for (const l of lines) {
          if (l.launchID !== launchID) continue
          if (l.type === 'runtime.ready') {
            // The control socket is up before readiness is journaled; one ping proves it serves.
            const ping = await opencodeControl(controlSocket(spec.personality, env), { op: 'ping' }, 5000)
            if (!ping.ok) return { ok: false, reason: `runtime.ready seen but control ping failed: ${ping.error}` }
            if (ping.launchID !== launchID) return { ok: false, reason: `control socket answers launch ${ping.launchID}, expected ${launchID}` }
            return { ok: true }
          }
          if (l.type === 'runtime.error') {
            const e = (l.properties as { error?: unknown } | null)?.error
            return { ok: false, reason: `runtime.error: ${typeof e === 'string' ? e : JSON.stringify(e)}` }
          }
        }
        if (!alive()) return { ok: false, reason: 'process exited before runtime.ready' }
        await new Promise(r => setTimeout(r, 500))
      }
      return { ok: false, reason: 'no runtime.ready before the boot deadline (plugin not loaded?)' }
    } finally {
      readyOffsets.delete(launchID)
    }
  },

  async deliver(target, text, env) {
    const r = await opencodeControl(controlSocket(target.personality, env), { op: 'deliver', text })
    return r.ok ? { ok: true, messageID: r.messageID } : { ok: false, error: r.error ?? 'deliver failed' }
  },

  async control(target, command, env) {
    if (command.name === 'interrupt') {
      const r = await opencodeControl(controlSocket(target.personality, env), { op: 'interrupt' })
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'interrupt failed' }
    }
    if (command.name === 'compact') {
      // Blocks until the native summary turn completed and session.compacted is recorded.
      const r = await opencodeControl(controlSocket(target.personality, env), { op: 'compact' }, OPENCODE_COMPACT_TIMEOUT_MS)
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'compact failed' }
    }
    return { ok: false, error: `opencode does not support control command "${command.name}"` }
  },

  // ── Screen predicates: deliberately inert (structural runtime). ──────────────
  bootDialogKeys(): string[] | null {
    return null
  },
  isInputReady(_pane: string, _mode?: ApprovalMode): boolean {
    return false
  },

  newestActivityMtime(_cwd: string, ctx?: ObserveContext): number | null {
    return ctx ? fileMtimeMs(paths(ctx.personality, ctx.env).events) : null
  },

  /** Busy/idle come from the plugin's state, not from a file mtime: lastActivityMs advances only on
   *  journaled native events. A busy/approval status counts as activity NOW (a long tool call). */
  lastTurnMtime(_cwd: string, ctx?: ObserveContext): number | null {
    if (!ctx) return null
    const s = readOpencodeState(paths(ctx.personality, ctx.env).state)
    if (!s) return null
    if (s.status === 'busy' || s.status === 'approval') return Date.now()
    return s.lastActivityMs
  },

  resolveResume(_cwd: string, ctx?: ObserveContext): { ok: boolean; ref?: string; reason?: string } {
    if (!ctx) return { ok: false, reason: 'opencode resume needs the personality (no observation context)' }
    const s = readOpencodeState(paths(ctx.personality, ctx.env).state)
    if (!s?.sessionID) return { ok: false, reason: `no recorded OpenCode session for "${ctx.personality}"` }
    return { ok: true, ref: s.sessionID }
  },

  // Control goes through `control` above; there is no pty key plan.
  executeControl(_command: ControlCommand): ControlPlan | null {
    return null
  },
}
