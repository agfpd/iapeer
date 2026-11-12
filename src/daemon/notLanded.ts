// Positive NON-delivery evidence for an unresolved Claude paste (docs/10 §delivery acceptance).
// «No receipt» alone is never proof: Claude may persist a queued/submitted input later. This proof
// needs the SAME hosting still alive and, at one instant, all of:
//   1. the native Claude session reports `idle` and its transcript ends on a terminal assistant turn
//      (no turn in progress that could still ingest the input);
//   2. the composer is empty and the screen shows neither the payload header nor a paste placeholder
//      (nothing waiting to be submitted or queued);
//   3. no transcript record carries the payload (checked by the caller: deliveryLanded).
// Then the model never received the input and cannot receive it later — resending is safe.
// Any missing/ambiguous evidence returns null: the record stays `unresolved` (fail closed).
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pidPath } from '../supervisor/paths.ts'
import { captureHostState } from '../supervisor/capture.ts'
import { strictClaudeIdle } from '../supervisor/nativeIdle.ts'
import { readSessionSlices } from './sessionfiles.ts'
import { transcriptSlug } from '../launch/adapters/claude.ts'
import type { AcceptanceRecord } from '../launch/acceptanceStore.ts'

const canonical = (p: string): string => { try { return realpathSync(p) } catch { return p } }

export interface NotLandedDeps {
  hostToken: (runDir: string, identity: string) => string | null
  children: (pid: number) => number[]
  nativeSession: (home: string, pid: number) => { status?: string; cwd?: string; sessionId?: string } | null
  transcriptTail: (home: string, cwd: string, sessionId: string) => string
  screen: (runDir: string, identity: string) => Promise<{ text: string; composerOccupied: boolean } | null>
}

export const defaultNotLandedDeps: NotLandedDeps = {
  hostToken: (runDir, identity) => { try { return readFileSync(pidPath(runDir, identity), 'utf8').trim() || null } catch { return null } },
  children: pid => (spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim().split(/\s+/).map(Number).filter(n => n > 0),
  nativeSession: (home, pid) => { try { return JSON.parse(readFileSync(join(home, '.claude', 'sessions', `${pid}.json`), 'utf8')) } catch { return null } },
  transcriptTail: (home, cwd, sessionId) => readSessionSlices(join(home, '.claude', 'projects', transcriptSlug(cwd), `${sessionId}.jsonl`), 1024 * 1024)?.tail ?? '',
  screen: captureHostState,
}

/** The envelope header line as Claude would render it (first non-empty line of the payload). */
function payloadHeader(message: string): string {
  const at = message.indexOf('<iap ')
  const from = at >= 0 ? message.slice(at) : message
  return (from.split('\n').find(l => l.trim()) ?? '').trim()
}

/** A reason string when non-delivery is POSITIVELY proven, otherwise null. */
export async function claudeNotLanded(r: AcceptanceRecord, runDir: string, deps: NotLandedDeps = defaultNotLandedDeps): Promise<string | null> {
  if (!r.identity.startsWith('claude-')) return null
  const token = deps.hostToken(runDir, r.identity)
  if (!token || `host:${token}` !== r.token) return null // hosting changed: its composer is not ours to read
  const hostPid = Number(token.split(/\s/)[0])
  for (const pid of deps.children(hostPid)) {
    const s = deps.nativeSession(r.home, pid)
    if (!s || typeof s.sessionId !== 'string' || typeof s.cwd !== 'string' || canonical(s.cwd) !== canonical(r.cwd)) continue
    if (s.status !== 'idle') return null
    if (!strictClaudeIdle(deps.transcriptTail(r.home, r.cwd, s.sessionId)).idle) return null
    const screen = await deps.screen(runDir, r.identity)
    if (!screen || screen.composerOccupied) return null
    // Whitespace-insensitive: the viewport wraps long lines. The header carries sender+ts+topic, so a
    // match is this very input visible somewhere (queued/echoed) — ambiguous, never «not landed».
    const flat = (t: string) => t.replace(/\s+/g, '')
    const header = flat(payloadHeader(r.message))
    if ((header && flat(screen.text).includes(header)) || /\[Pasted text #\d+/.test(screen.text)) return null
    // Re-check after the async capture: the session must still be idle on the same hosting.
    if (deps.hostToken(runDir, r.identity) !== token || deps.nativeSession(r.home, pid)?.status !== 'idle') return null
    return 'not-landed: receiver idle after a terminal turn, composer empty, no native record of the input — the model never received it; safe to resend'
  }
  return null
}
