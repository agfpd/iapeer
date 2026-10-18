import { readPeersIndex } from '../registry/index.ts'
import { isLaunchdManaged, isStopped, wakeOrSpawn, type LifecycleConfig } from '../lifecycle/index.ts'
import { hostRunDir } from '../launch/ptyHost.ts'
import { sessionAlive } from '../supervisor/client.ts'
import { appendLifecycleEvent } from '../lifecycle/eventlog.ts'
import { completeReloads, gcReloads, pendingReloads, readReload, reloadIdentities, saveReload, type ReloadRequest } from './reloadStore.ts'

export interface ReloadDeps {
  alive?: (identity: string) => boolean
  replace?: typeof wakeOrSpawn
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
      const current = readReload(cfg, r)
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
  if (isStopped(cfg, identity)) { update('pending', 'endpoint is stopped; waiting for its next ordinary launch'); return }
  if (isLaunchdManaged(newest.personality, env)) { update('pending', 'launchd-owned endpoint; waiting for its owning lifecycle to restart it'); return }
  const alive = (deps.alive ?? (id => sessionAlive(cfg.supervisorRunDir ?? hostRunDir(env), id)))(identity)
  const recovery = requests.find(r => r.resumeRef)
  if (!alive && !recovery) { update('pending', 'endpoint is asleep; next ordinary launch will apply the surfaces'); return }
  try {
    const result = await (deps.replace ?? wakeOrSpawn)({
      personality: newest.personality,
      runtime: newest.runtime,
      task: '',
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

export function startCapabilityReloads(cfg: LifecycleConfig, env: NodeJS.ProcessEnv): () => void {
  let closed = false, running = false, lastGc = 0
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
