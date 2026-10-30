import { readPeersIndex } from '../registry/index.ts'
import { isLaunchdManaged, isStopped, wakeOrSpawn, type LifecycleConfig } from '../lifecycle/index.ts'
import { hostRunDir, listHostedPeers } from '../launch/ptyHost.ts'
import { sessionAlive } from '../supervisor/client.ts'
import { appendLifecycleEvent } from '../lifecycle/eventlog.ts'
import { completeReloads, gcReloads, pendingReloads, readReload, reloadIdentities, requestReload, saveReload, type ReloadRequest } from './reloadStore.ts'
import { readSurfaceBaseline, surfaceFingerprint, writeSurfaceBaseline } from './surfaces.ts'

export interface ReloadDeps {
  alive?: (identity: string) => boolean
  replace?: typeof wakeOrSpawn
  /** The remove-runtime tail (unprovision, markers, profile, registry, state purge). Default: the CLI's. */
  finishRemove?: (personality: string, runtime: string, env: NodeJS.ProcessEnv) => Promise<string[]>
}

async function defaultFinishRemove(personality: string, runtime: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const { completeRemoveRuntime } = await import('../cli/index.ts')
  return completeRemoveRuntime(runtime, { peer: personality, env })
}

// CLI and daemon can both drive the same request. wakeOrSpawn serializes the actual retirement /
// launch across processes, and launch completes only the configuration snapshot it actually read.
export async function applyReloads(cfg: LifecycleConfig, identity: string, env: NodeJS.ProcessEnv, deps: ReloadDeps = {}): Promise<void> {
  const requests = pendingReloads(cfg, identity)
  if (!requests.length) return
  const newest = requests.reduce((a, b) => a.requestedAt > b.requestedAt ? a : b)
  const update = (state: ReloadRequest['state'], detail: string, resumeRef?: string): void => {
    let changed = false
    for (const r of requests) {
      // A natural launch may have completed this request concurrently. Never rewind applied.
      let current: ReloadRequest
      try { current = readReload(cfg, r) } catch { continue } // purged by a completed removal
      if (current.state === 'applied') continue
      changed ||= current.state !== state || current.detail !== detail
      saveReload(cfg, { ...current, state, detail, ...(resumeRef ? { resumeRef } : {}), attemptAt: Date.now() })
    }
    if (changed) appendLifecycleEvent(cfg.eventLogDir, { ev: 'capability-reload', identity, state, detail }, { env })
  }
  const peer = readPeersIndex({ env }).peers.find(p => p.personality === newest.personality)
  if (!peer || !peer.runtimes.some(rt => rt === newest.runtime)) {
    update('failed', 'endpoint no longer exists; capability reload cannot be applied')
    return
  }
  const alive = (deps.alive ?? (id => sessionAlive(cfg.supervisorRunDir ?? hostRunDir(env), id)))(identity)
  const retire = requests.find(r => r.kind === 'retire')
  if (retire) {
    const finish = async (): Promise<void> => {
      const steps = await (deps.finishRemove ?? defaultFinishRemove)(retire.personality, retire.runtime, env)
      appendLifecycleEvent(cfg.eventLogDir, { ev: 'remove-runtime', identity, state: 'removed', at: 'turn-boundary', steps: steps.join('; ') }, { env })
    }
    if (isLaunchdManaged(retire.personality, env)) { update('pending', 'launchd-owned endpoint; remove-runtime waits for its owning lifecycle'); return }
    // Asleep (idle-reaped, stopped, crashed): nothing to interrupt — complete the removal now.
    if (!alive) { await finish(); return }
    try {
      const result = await (deps.replace ?? wakeOrSpawn)({
        personality: retire.personality, runtime: retire.runtime, task: '', reload: true, retireOnly: true,
        reloadRequestIds: requests.map(r => r.id), afterRetire: finish,
      }, { cfg, env })
      if (result.status !== 'READY') update(result.pending || result.stopped ? 'pending' : 'failed', result.reason ?? 'remove-runtime retirement failed')
    } catch (e) { update('failed', e instanceof Error ? e.message : String(e)) }
    return
  }
  if (isStopped(cfg, identity)) { update('pending', 'endpoint is stopped; waiting for its next ordinary launch'); return }
  if (isLaunchdManaged(newest.personality, env)) { update('pending', 'launchd-owned endpoint; waiting for its owning lifecycle to restart it'); return }
  if (newest.runtime !== peer.runtime) { update('pending', 'non-default endpoint; next ordinary launch will apply the surfaces'); return }
  const recovery = requests.find(r => r.resumeRef)
  if (!alive && !recovery) { update('pending', 'endpoint is asleep; next ordinary launch will apply the surfaces'); return }
  try {
    const result = await (deps.replace ?? wakeOrSpawn)({
      personality: newest.personality,
      runtime: newest.runtime,
      task: '',
      suppressInitialPrompt: true,
      reloadRequestIds: requests.map(r => r.id),
      ...(alive ? { reload: true } : { reloadResumeRef: recovery!.resumeRef, resume: true }),
      beforeReloadRetire: ref => update('replacing', 'idle hosting fenced; automatic resume replacement is owed', ref),
    }, { cfg, env })
    if (result.status === 'READY') {
      // A real launch acknowledged its own snapshot inside wakeOrSpawn. This completion is needed
      // only for injected replacement seams in unit tests, never to cover newly-arriving requests.
      if (deps.replace) completeReloads(cfg, requests)
    } else update(result.pending || result.stopped ? 'pending' : 'failed', result.reason ?? 'reload failed')
  } catch (e) { update('failed', e instanceof Error ? e.message : String(e)) }
}

/** Request + try to apply one endpoint's owed reload now; the outcome the operator sees. */
export async function requestAndApply(cfg: LifecycleConfig, personality: string, runtime: string, env: NodeJS.ProcessEnv): Promise<{ application: 'applied' | 'pending' | 'failed'; detail: string }> {
  try {
    const req = requestReload(cfg, personality, runtime)
    await applyReloads(cfg, `${runtime}-${personality}`, env)
    const result = readReload(cfg, req)
    return { application: result.state === 'applied' ? 'applied' : result.state === 'failed' ? 'failed' : 'pending', detail: result.detail }
  } catch (e) { return { application: 'failed', detail: e instanceof Error ? e.message : String(e) } }
}

/**
 * Surface watch: a live agentic endpoint whose surfaces differ from what its launch read gets a reload
 * request (writers outside the core — the memory provider's provision-peer/update, an operator edit).
 * A hosting with no baseline (launched before this mechanism) adopts the current state as its baseline:
 * what it actually read is unknown, and a guess must never replace a running process.
 */
export function watchSurfaces(cfg: LifecycleConfig, env: NodeJS.ProcessEnv, hosted = listHostedPeers(env, cfg.supervisorRunDir ?? hostRunDir(env))): string[] {
  const requested: string[] = []
  const peers = readPeersIndex({ env }).peers
  for (const h of hosted) {
    if (h.runtime !== 'claude' && h.runtime !== 'codex' && h.runtime !== 'opencode') continue
    const peer = peers.find(p => p.personality === h.personality)
    if (!peer || !peer.runtimes.includes(h.runtime) || isLaunchdManaged(h.personality, env)) continue
    const identity = `${h.runtime}-${h.personality}`
    let now: string
    try { now = surfaceFingerprint(h.runtime, peer.cwd, h.personality, env) } catch { continue }
    const base = readSurfaceBaseline(cfg, identity)
    if (!base) { writeSurfaceBaseline(cfg, identity, now); continue }
    if (base === now) continue
    // One owed application covers every later write: the launch reads the files as they are then,
    // and a write after its snapshot differs again from the new baseline.
    if (pendingReloads(cfg, identity).length) continue
    requestReload(cfg, h.personality, h.runtime)
    requested.push(identity)
    appendLifecycleEvent(cfg.eventLogDir, { ev: 'capability-surfaces-changed', identity }, { env })
  }
  return requested
}

export function startCapabilityReloads(cfg: LifecycleConfig, env: NodeJS.ProcessEnv): () => void {
  let closed = false, running = false, lastGc = 0, lastWatch = 0
  const tick = async (): Promise<void> => {
    if (closed || running) return
    running = true
    try {
      if (Date.now() - lastGc >= 60_000) {
        lastGc = Date.now()
        const peers = readPeersIndex({ env }).peers
        for (const id of reloadIdentities(cfg)) {
          const exists = peers.some(p => p.runtimes.some(rt => `${rt}-${p.personality}` === id))
          const n = gcReloads(cfg, id, exists)
          if (n) appendLifecycleEvent(cfg.eventLogDir, { ev: 'capability-reload-gc', identity: id, removed: n, endpoint: exists ? 'present' : 'gone' }, { env })
        }
      }
      if (Date.now() - lastWatch >= 3_000) {
        lastWatch = Date.now()
        try { watchSurfaces(cfg, env) } catch (e) { appendLifecycleEvent(cfg.eventLogDir, { ev: 'capability-reload-error', error: `surface watch: ${String(e)}` }, { env }) }
      }
      await Promise.all(reloadIdentities(cfg).map(async id => {
        const req = pendingReloads(cfg, id)
        if (!req.length || req.every(r => r.attemptAt && Date.now() - r.attemptAt < 3000)) return
        await applyReloads(cfg, id, env)
      }))
    } catch (e) { appendLifecycleEvent(cfg.eventLogDir, { ev: 'capability-reload-error', error: String(e) }, { env }) }
    finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, 1000)
  timer.unref()
  void tick()
  return () => { closed = true; clearInterval(timer) }
}
