import { join } from 'node:path'
import type { LifecycleConfig } from '../lifecycle/index.ts'
import { isLaunchdManaged, isStopped } from '../lifecycle/index.ts'
import { failoverEnabled, gcFailoverTasks, listFailoverTasks, markFailoverFresh, providerFailure, quarantineSession, saveFailoverTask, selectFailoverRuntime, type FailoverTask } from '../lifecycle/failover.ts'
import { clearLimitPark } from '../lifecycle/limitpark.ts'
import { settleFailoverInflight } from '../lifecycle/inflight.ts'
import { hostSessionAlive, hostSessionToken, killPtyHost } from '../launch/ptyHost.ts'
import { resolveCallerIdentity, systemCaller } from '../identity/index.ts'
import { findPeer, readPeersIndex } from '../registry/index.ts'
import { deliveryCompleted, deliveryProcessed, routeSend, type RouteDeps } from '../transport/index.ts'
import { appendLifecycleEvent } from '../lifecycle/eventlog.ts'
import { failureContainsTask, failureForTask, refusedBeforeWork, refusalReviewReason } from './failoverProof.ts'
import type { NoticeBoard } from './notices.ts'

const running = new Set<string>()
export interface FailoverSeam {
  send?: typeof routeSend
  alive?: typeof hostSessionAlive
  token?: typeof hostSessionToken
  kill?: typeof killPtyHost
  proof?: typeof refusedBeforeWork
  belongs?: typeof failureContainsTask
  completed?: typeof deliveryCompleted
  processed?: typeof deliveryProcessed
  sleep?: (ms: number) => Promise<void>
}
/** Only this daemon pass transfers custody; durable states make restart fail closed.
 * Unknown dispatch is a review item, never permission to send a second copy. */
export async function processFailovers(cfg: LifecycleConfig, env: NodeJS.ProcessEnv, deps: RouteDeps, board?: NoticeBoard, seam: FailoverSeam = {}): Promise<void> {
  if (running.has(cfg.stateDir)) return
  running.add(cfg.stateDir)
  try {
    gcFailoverTasks(cfg)
    const alive = seam.alive ?? hostSessionAlive, token = seam.token ?? hostSessionToken
    const send = seam.send ?? routeSend, proof = seam.proof ?? refusedBeforeWork
    const log = (t: FailoverTask, outcome: string) => appendLifecycleEvent(cfg.eventLogDir, { ev: 'failover', identity: t.identity, task: t.id, target: t.targetRuntime, outcome, err: t.error }, { env })
    for (const task of listFailoverTasks(cfg)) {
      if (['transferred', 'review', 'finished'].includes(task.state)) continue
      const peer = findPeer(readPeersIndex({ env }), task.personality)
      if (!peer || isLaunchdManaged(task.personality, env) || !failoverEnabled(peer.cwd)) continue
      const newest = providerFailure(cfg, task.identity)
      const failure = task.failure ?? (newest ? failureForTask(task, newest) : undefined)
      if (task.state === 'watching') {
        // Positive failure evidence wins over native task_complete: a refused Codex
        // call also writes task_complete, and a Claude refusal is an assistant row.
        if (!failure || failure.atMs < task.ts) {
          if ((seam.processed ?? deliveryProcessed)(task, env) && (seam.completed ? seam.completed(task, env) : deliveryCompleted(task, env, undefined, true))) {
            task.state = 'finished'; saveFailoverTask(cfg, task)
          }
          continue
        }
        if (!failure.sessionId || !failure.file) continue // unknown evidence: no transfer
        if (!(seam.belongs ?? failureContainsTask)(task, failure)) {
          if (deliveryCompleted(task, env, undefined, true)) { task.state = 'finished'; saveFailoverTask(cfg, task) }
          continue
        }
        const candidate = selectFailoverRuntime(cfg, peer, undefined, Date.now(), task.failoverVisited ?? [task.runtime], env)
        if (!candidate.ok || !candidate.value.runtime) continue // e.g. walt: both alternatives stopped
        if (isStopped(cfg, task.identity)) continue // operator stop wins; don't revive its work elsewhere
        if (!task.sessionToken || (alive(task.identity, env) && token(task.identity, env) !== task.sessionToken)) {
          task.state = 'review'; task.reviewReason = 'hosting-replaced'; task.error = 'hosting replaced before failover; no replay'; saveFailoverTask(cfg, task); log(task, 'review'); continue
        }
        task.state = 'claimed'; task.targetRuntime = candidate.value.runtime; task.failure = failure
        // Write custody BEFORE invalidating anything. Re-entering this state after
        // daemon death re-applies quarantine/teardown, not a second dispatch.
        saveFailoverTask(cfg, task); log(task, 'claimed')
      }
      if (task.state === 'dispatching') {
        task.reviewReason = 'dispatch-uncertain'
        task.state = 'review'; task.error = 'daemon restarted during transfer dispatch; acceptance needs reconciliation'
        saveFailoverTask(cfg, task); log(task, 'dispatch-uncertain')
        board?.raise({ personality: task.personality, runtime: task.targetRuntime ?? task.runtime, kind: 'failover-review', audience: 'operator', errorType: 'failover-dispatch-uncertain', eventAtMs: task.ts, content: task.error })
        continue
      }
      if (!task.failure?.sessionId) continue
      quarantineSession(cfg, task.identity, task.failure.sessionId)
      // Force the first later wake (including attach) fresh. The durable native-ID
      // quarantine also guards exact historical reload/resume paths.
      markFailoverFresh(cfg, task.identity)
      clearLimitPark(cfg, task.identity)
      settleFailoverInflight(cfg.stateDir, task)
      if (alive(task.identity, env)) {
        if (token(task.identity, env) !== task.sessionToken) {
          task.state = 'review'; task.reviewReason = 'hosting-changed-during-claim'; task.error = 'hosting changed during failover claim'; saveFailoverTask(cfg, task); log(task, 'review'); continue
        }
        ;(seam.kill ?? killPtyHost)(task.identity, env, { reason: 'provider-failover' }, cfg.supervisorRunDir)
        for (let i = 0; i < 100 && alive(task.identity, env); i++) await (seam.sleep ?? (ms => Bun.sleep(ms)))(50)
        if (alive(task.identity, env)) { task.error = 'old hosting did not terminate; transfer withheld'; saveFailoverTask(cfg, task); log(task, 'waiting-for-exit'); continue }
      }
      // Re-read AFTER shutdown: automatic provider retries could have raced the
      // first detector. Only the final, immutable transcript can authorize replay.
      const reason = seam.proof ? (proof(task, task.failure) ? undefined : 'proof-rejected') : refusalReviewReason(task, task.failure)
      const safe = reason === undefined
      task.reviewReason = reason
      if (isStopped(cfg, task.identity) || isLaunchdManaged(task.personality, env)) continue
      const selected = selectFailoverRuntime(cfg, peer, undefined, Date.now(), task.failoverVisited ?? [task.runtime], env)
      if (!selected.ok || !selected.value.runtime) continue
      task.targetRuntime = selected.value.runtime
      task.state = 'dispatching'; saveFailoverTask(cfg, task); log(task, safe ? 'dispatch-unstarted' : 'dispatch-review')
      try {
        const caller = safe ? resolveCallerIdentity(task.caller, readPeersIndex({ env })) : systemCaller()
        const message = safe ? task.message :
          `[iapeer] Work on ${task.identity} stopped when its model provider refused further calls (${task.failure.errorType ?? 'refusal'}: a usage/rate limit, authentication or overload, not a fault in your work). That native session is quarantined and stopped. Review its durable evidence at ${join(cfg.stateDir, 'failover', 'tasks', task.id + '.json')} and transcript ${task.failure.file}. Reconcile actual tool results before deciding what remains; this is a state-review request, not authorization to replay the original instruction. Do not repeat an operation whose outcome is unknown.`
        const result = await send(caller, { personality: task.personality, runtime: task.targetRuntime, message, topic: task.topic,
          ...(safe && task.attachments?.length ? { attachments: task.attachments } : {}) },
        { ...deps, env, failoverRetry: true, failoverVisited: task.failoverVisited ?? [task.runtime],
          failoverTaskId: task.failoverTaskId,
          selectAgentRuntime: (p, rt) => selectFailoverRuntime(cfg, p, rt, Date.now(), [], env) })
        task.state = safe && result.ok ? 'transferred' : 'review'
        if (!result.ok) task.reviewReason = 'dispatch-failed'
        if (!result.ok) task.error = result.error.message
        saveFailoverTask(cfg, task); log(task, result.ok ? task.state : 'dispatch-failed')
      } catch (e) {
        // Preserve dispatching; next pass exposes uncertain custody without replay.
        task.error = String(e); saveFailoverTask(cfg, task); log(task, 'dispatch-uncertain')
      }
    }
  } finally { running.delete(cfg.stateDir) }
}
