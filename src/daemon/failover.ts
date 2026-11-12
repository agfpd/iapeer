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
const yieldTurn = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/**
 * How long a watching task outlives the end of the hosting that accepted it. A refusal for that
 * input can only be produced by that hosting; the native detector records it within ~20 s and the
 * next supervise pass (60 s) claims it. The grace covers several full passes AFTER the end was first
 * observed, so a refusal written just before the hosting died is still claimed normally.
 */
export const FAILOVER_WATCH_RELEASE_GRACE_MS = 10 * 60_000

/**
 * Release custody of a watching task whose accepting hosting has ended without a provider refusal
 * attributable to it. Not a proof of completion and never a replay: nothing can transfer it any
 * more (a later hosting of the identity is `hosting-replaced` review by construction), so keeping
 * it «watching» only re-reads up to 16 MiB of evidence per task per pass, forever — the 12.11
 * incident (297 tasks back to 04.11; their inputs had slid out of the bounded evidence window, so
 * neither `finished` nor a refusal could ever be proved). The first observation is made durable so
 * a daemon restart does not reset the grace.
 */
function releaseOrphanedWatch(
  cfg: LifecycleConfig,
  task: FailoverTask,
  alive: typeof hostSessionAlive,
  token: typeof hostSessionToken,
  env: NodeJS.ProcessEnv,
  log: (t: FailoverTask, outcome: string) => void,
  now: number,
): void {
  const ended = !task.sessionToken || !alive(task.identity, env) || token(task.identity, env) !== task.sessionToken
  if (!ended) {
    if (task.hostingEndedAt !== undefined) { task.hostingEndedAt = undefined; saveFailoverTask(cfg, task) }
    return
  }
  if (task.hostingEndedAt === undefined) { task.hostingEndedAt = now; saveFailoverTask(cfg, task); return }
  if (now - task.hostingEndedAt < FAILOVER_WATCH_RELEASE_GRACE_MS) return
  task.state = 'released'
  task.reviewReason = 'hosting-ended-without-refusal'
  saveFailoverTask(cfg, task); log(task, 'released')
}
export interface FailoverSeam {
  send?: typeof routeSend
  alive?: typeof hostSessionAlive
  token?: typeof hostSessionToken
  kill?: typeof killPtyHost
  proof?: typeof refusedBeforeWork
  belongs?: typeof failureContainsTask
  completed?: typeof deliveryCompleted
  processed?: typeof deliveryProcessed
  /** Event-loop yield between tasks (tests: a no-op). */
  yieldTurn?: () => Promise<void>
  now?: () => number
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
      // Proofs below read and JSON-parse up to 16 MiB of native evidence per task. Yield between
      // tasks so a long pass never starves the router's HTTP-MCP listener (incident 12.11: a 57 s
      // synchronous pass over 297 watching tasks every 60 s → peers' MCP clients timed out).
      await (seam.yieldTurn ?? yieldTurn)()
      if (['transferred', 'review', 'finished', 'released'].includes(task.state)) continue
      const peer = findPeer(readPeersIndex({ env }), task.personality)
      if (!peer || isLaunchdManaged(task.personality, env) || !failoverEnabled(peer.cwd)) continue
      if (task.state === 'watching') {
        // Positive failure evidence wins over native task_complete: a refused Codex
        // call also writes task_complete, and a Claude refusal is an assistant row.
        const watching = (): boolean => {
          const newest = providerFailure(cfg, task.identity)
          const failure = task.failure ?? (newest ? failureForTask(task, newest) : undefined)
          if (!failure || failure.atMs < task.ts) {
            if ((seam.processed ?? deliveryProcessed)(task, env) && (seam.completed ? seam.completed(task, env) : deliveryCompleted(task, env, undefined, true))) {
              task.state = 'finished'; saveFailoverTask(cfg, task)
            }
            return true
          }
          if (!failure.sessionId || !failure.file) return true // unknown evidence: no transfer
          if (!(seam.belongs ?? failureContainsTask)(task, failure)) {
            if (deliveryCompleted(task, env, undefined, true)) { task.state = 'finished'; saveFailoverTask(cfg, task) }
            return true
          }
          const candidate = selectFailoverRuntime(cfg, peer, undefined, Date.now(), task.failoverVisited ?? [task.runtime], env)
          if (!candidate.ok || !candidate.value.runtime) return true // e.g. walt: both alternatives stopped
          if (isStopped(cfg, task.identity)) return true // operator stop wins; don't revive its work elsewhere
          claim = { target: candidate.value.runtime, failure }
          return false
        }
        let claim: { target: string; failure: NonNullable<FailoverTask['failure']> } | undefined
        if (watching() || !claim) {
          if (task.state === 'watching') releaseOrphanedWatch(cfg, task, alive, token, env, log, seam.now?.() ?? Date.now())
          continue
        }
        if (!task.sessionToken || (alive(task.identity, env) && token(task.identity, env) !== task.sessionToken)) {
          task.state = 'review'; task.reviewReason = 'hosting-replaced'; task.error = 'hosting replaced before failover; no replay'; saveFailoverTask(cfg, task); log(task, 'review'); continue
        }
        task.state = 'claimed'; task.targetRuntime = claim.target; task.failure = claim.failure
        // Write custody BEFORE invalidating anything. Re-entering this state after
        // daemon death re-applies quarantine/teardown, not a second dispatch.
        saveFailoverTask(cfg, task); log(task, 'claimed')
      }
      if (task.state === 'dispatching') {
        task.reviewReason ??= 'dispatch-uncertain'
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
          failoverQueueAtMs: Number.isFinite(Date.parse(task.sentAt)) ? Date.parse(task.sentAt) : task.ts,
          failoverQueueOrderNs: task.fifoOrderNs,
          selectAgentRuntime: (p, rt) => selectFailoverRuntime(cfg, p, rt, Date.now(), [], env) })
        task.state = safe && result.ok ? 'transferred' : 'review'
        if (!result.ok) task.reviewReason ??= 'dispatch-failed'
        if (!result.ok) task.error = result.error.message
        saveFailoverTask(cfg, task); log(task, result.ok ? task.state : 'dispatch-failed')
      } catch (e) {
        // Preserve dispatching; next pass exposes uncertain custody without replay.
        task.error = String(e); saveFailoverTask(cfg, task); log(task, 'dispatch-uncertain')
      }
    }
  } finally { running.delete(cfg.stateDir) }
}
