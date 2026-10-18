// `iapeer capability <list|register|unregister|sync>` — the operator/installer surface
// of the capability-plugin lifecycle (docs/21-capabilities.md).
import { readFileSync } from 'node:fs'
import { readPeersIndex } from '../registry/index.ts'
import { appendLifecycleEvent } from '../lifecycle/eventlog.ts'
import { pluginLogsDir } from '../storage/index.ts'
import type { ProvisionOccasion } from '../enable/provisionCommand.ts'
import { loadLifecycleConfig } from '../lifecycle/index.ts'
import { requestAndApply } from './reload.ts'
import { pendingReloads, reloadIdentities } from './reloadStore.ts'
import {
  capabilityEndpoints,
  listCapabilities,
  parseCapabilityDeclaration,
  removeCapabilityDeclaration,
  runCapabilityLifecycle,
  writeCapabilityDeclaration,
  type CapabilityDeclaration,
} from './index.ts'

export interface CapabilitySweepLine {
  personality: string
  runtime: string
  state: string
  detail?: string
  application?: 'applied' | 'pending' | 'failed'
  applicationDetail?: string
}

/** Run one command of ONE capability across every registered peer's applicable endpoints. */
export async function sweepCapability(
  decl: CapabilityDeclaration,
  kind: 'provision' | 'unprovision',
  occasion: ProvisionOccasion,
  env: NodeJS.ProcessEnv,
): Promise<CapabilitySweepLine[]> {
  const lines: CapabilitySweepLine[] = []
  for (const p of readPeersIndex({ env }).peers) {
    if (capabilityEndpoints(decl, p.runtimes).length === 0) continue
    for (const run of runCapabilityLifecycle({ kind, personality: p.personality, cwd: p.cwd, runtimes: p.runtimes, occasion, env, only: decl })) {
      const o = run.outcome
      appendLifecycleEvent(
        pluginLogsDir('iapeer', { env }),
        { ev: 'capability-provision', capability: decl.capability, identity: `${run.runtime}-${p.personality}`, occasion, state: o.state, exit: o.exitCode ?? undefined, ms: o.durationMs, detail: o.detail },
        { env },
      )
      lines.push({ personality: p.personality, runtime: run.runtime, state: o.state, ...(o.state !== 'ok' && o.detail ? { detail: o.detail } : {}) })
    }
  }
  return lines
}

function find(name: string, env: NodeJS.ProcessEnv): CapabilityDeclaration {
  const decl = listCapabilities({ env }).declarations.find(d => d.capability === name)
  if (!decl) throw new Error(`capability "${name}" is not registered`)
  return decl
}

/** Returns the process exit code. */
export async function capabilityCli(
  positionals: string[],
  env: NodeJS.ProcessEnv,
  out: (s: string) => void,
  errOut: (s: string) => void,
): Promise<number> {
  const [sub, arg] = positionals
  const apply = async (lines: CapabilitySweepLine[]): Promise<CapabilitySweepLine[]> => {
    const cfg = loadLifecycleConfig(env)
    for (const l of lines) {
      if (l.state !== 'ok') continue
      const r = await requestAndApply(cfg, l.personality, l.runtime, env)
      l.application = r.application
      l.applicationDetail = r.detail
    }
    return lines
  }
  const report = (lines: CapabilitySweepLine[]): number => {
    for (const l of lines) out(`${l.personality} (${l.runtime}): ${l.state}${l.detail ? ` — ${l.detail}` : ''}${l.application ? `; runtime=${l.application} — ${l.applicationDetail}` : ''}\n`)
    if (lines.length === 0) out('no applicable peer endpoints\n')
    return lines.some(l => l.state !== 'ok' || l.application === 'failed') ? 1 : 0
  }
  try {
    switch (sub) {
      case 'list': {
        const { declarations, invalid } = listCapabilities({ env })
        for (const d of declarations) out(`${d.capability}${d.version ? `@${d.version}` : ''}  runtimes=[${d.runtimes.join(', ')}]  ${d.provision.command}\n`)
        for (const b of invalid) out(`INVALID ${b.file}: ${b.error}\n`)
        if (declarations.length + invalid.length === 0) out('no capabilities registered\n')
        const cfg = loadLifecycleConfig(env)
        let failed = false
        for (const identity of reloadIdentities(cfg)) {
          const pending = pendingReloads(cfg, identity)
          if (!pending.length) continue
          const last = pending.reduce((a, b) => (a.attemptAt ?? a.requestedAt) > (b.attemptAt ?? b.requestedAt) ? a : b)
          failed ||= last.state === 'failed'
          out(`${identity}: runtime=${last.state === 'replacing' ? 'pending' : last.state} (${pending.length} request(s)) — ${last.detail}\n`)
        }
        return invalid.length || failed ? 1 : 0
      }
      case 'register': {
        if (!arg) throw new Error('usage: iapeer capability register <declaration.json>')
        const decl = parseCapabilityDeclaration(JSON.parse(readFileSync(arg, 'utf8')))
        const path = writeCapabilityDeclaration(decl, { env })
        out(`registered ${decl.capability} → ${path}\n`)
        // Existing peers get the surfaces now; new peers get them at birth.
        return report(await apply(await sweepCapability(decl, 'provision', 'sweep-on', env)))
      }
      case 'sync': {
        if (!arg) throw new Error('usage: iapeer capability sync <name>')
        return report(await apply(await sweepCapability(find(arg, env), 'provision', 'sweep-on', env)))
      }
      case 'unregister': {
        if (!arg) throw new Error('usage: iapeer capability unregister <name>')
        const decl = find(arg, env)
        const lines = await sweepCapability(decl, 'unprovision', 'off-all', env)
        // The declaration goes even if a peer failed to unwind: a lingering declaration
        // would re-provision surfaces on the next birth. The failures are reported above.
        removeCapabilityDeclaration(decl.capability, { env })
        out(`unregistered ${decl.capability}\n`)
        return report(await apply(lines))
      }
      default:
        errOut('usage: iapeer capability <list | register <declaration.json> | sync <name> | unregister <name>>\n')
        return 2
    }
  } catch (e) {
    errOut(`capability ${sub ?? ''}: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}
