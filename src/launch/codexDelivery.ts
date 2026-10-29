// Codex's pty ACK proves bytes, not submission. Keep this gate below launch AND warm transport.
// Native evidence: rust-v0.164.0 chatwidget/input_submission.rs (history), input_queue.rs (preview),
// and external_writer_view_shows_notice_instead_of_composer.snap (read-only ownership conflict).
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { codexSessionCwd } from './adapters/transcriptTail.ts'
import { deliverToHost, sendControlToHost, type DeliverResult } from '../supervisor/deliver.ts'
import { pidPath, servePath } from '../supervisor/paths.ts'
import { captureHostState } from '../supervisor/capture.ts'

export interface CodexInputState { text: string; composerOccupied: boolean }
const normalize = (s: string) => s.replace(/\r/g, '').trim()
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const canonical = (p: string) => { try { return realpathSync(p) } catch { return p } }
const size = (p: string) => { try { return statSync(p).size } catch { return 0 } }
function tail(p: string, offset: number): string {
  let fd: number | undefined
  try {
    const n = size(p) - offset
    // No unbounded reads on the router event loop; missing/rotated/over-budget evidence fails closed.
    if (n <= 0 || n > 2 * 1024 * 1024) return ''
    fd = openSync(p, 'r'); const b = Buffer.alloc(n)
    const got = readSync(fd, b, 0, n, offset)
    return b.subarray(0, got).toString('utf8')
  } catch { return '' } finally { if (fd !== undefined) closeSync(fd) }
}
function rows(text: string): any[] {
  return text.split('\n').flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
}

/** Only native USER records count, never an assistant/tool quoting a message. */
export function codexUserRecordCarries(r: any, message: string): boolean {
  if (r.type !== 'response_item' || r.payload?.type !== 'message' || r.payload.role !== 'user') return false
  return Array.isArray(r.payload.content) && r.payload.content.some((c: any) => c.type === 'input_text' && typeof c.text === 'string' && normalize(c.text).includes(normalize(message)))
}

/** Snapshot offsets BEFORE paste. A later session file is included from zero (fresh rollouts are lazy). */
export function codexReceiptBaseline(home: string, cwd: string, message: string) {
  const root = join(home, 'sessions'), target = canonical(cwd)
  const candidates = (): string[] => {
    const out: string[] = []
    const visit = (dir: string) => {
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) visit(p)
        else if (e.name.endsWith('.jsonl') && canonical(codexSessionCwd(p) ?? '') === target) out.push(p)
      }
    }
    visit(root); return out
  }
  const offsets = new Map(candidates().map(p => [p, size(p)]))
  const history = join(home, 'history.jsonl'), historyOffset = size(history)
  return {
    landed: () => candidates().some(p => rows(tail(p, offsets.get(p) ?? 0)).some(r => codexUserRecordCarries(r, message))),
    // History alone is NOT a receipt: native submit may later fail. It is only the full-payload half
    // of queue confirmation, paired with the native pending-input UI and a cleared composer.
    submitted: () => rows(tail(history, historyOffset)).some(r => typeof r.text === 'string' && normalize(r.text) === normalize(message)
      && typeof r.session_id === 'string' && candidates().some(p => p.endsWith(`-${r.session_id}.jsonl`))),
  }
}

export function codexDeliveryBlocker(text: string): string | null {
  return text.includes('This conversation is open in another app') && /(?:r to retry|press R to continue here)/.test(text)
    ? 'Codex thread is open in another app (read-only); close the other owner and retry resume (r)' : null
}

export function codexQueueCarries(state: CodexInputState, message: string): boolean {
  if (state.composerOccupied || codexDeliveryBlocker(state.text)) return false
  const composer = [...state.text.matchAll(/^\s*›[^\n]*$/gm)].at(-1)
  if (!composer || composer.index === undefined) return false
  // Match only the native queue area ABOVE the last composer, not transcript history or a draft.
  const above = state.text.slice(0, composer.index)
  const section = [...above.matchAll(/^(?:\s*•\s*)?(?:Messages to be submitted after next tool call|Messages to be submitted at end of turn|Queued follow-up inputs)[^\n]*$/gm)].at(-1)
  if (!section || section.index === undefined) return false
  const header = message.split('\n')[0]!
  if (!/^<iap\s/.test(header) || !header.endsWith('>')) return false
  return flat(above.slice(section.index).replace(/↳\s*/g, '')).includes(flat(header))
}

function ownDraft(state: CodexInputState, message: string): boolean {
  if (!state.composerOccupied || codexDeliveryBlocker(state.text)) return false
  const composer = [...state.text.matchAll(/^\s*›\s*(.*)$/gm)].at(-1)
  if (!composer) return false
  const folded = `[Pasted Content ${[...message].length} chars]`
  return composer[1]?.trim() === folded || (composer.index !== undefined && flat(state.text.slice(composer.index + composer[0].indexOf('›') + 1)).includes(flat(message)))
}

export interface CodexDeliveryIO {
  state: () => Promise<CodexInputState | null>
  send: () => Promise<DeliverResult>
  resubmit: () => Promise<DeliverResult>
  landed: () => boolean
  submitted: () => boolean
  sameHost: () => boolean
  attached: () => boolean
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  graceMs?: number
}

export async function confirmCodexDelivery(message: string, io: CodexDeliveryIO): Promise<DeliverResult> {
  const now = io.now ?? (() => performance.now()), sleep = io.sleep ?? (ms => Bun.sleep(ms))
  const before = await io.state()
  const blocked = before && codexDeliveryBlocker(before.text)
  if (blocked) return { ok: false, error: blocked }
  if (!io.sameHost()) return { ok: false, error: 'Codex hosting changed before delivery' }
  const sent = await io.send()
  if (!sent.ok) return sent
  const deadline = now() + (io.graceMs ?? 4000)
  let retryAt = now() + 1500
  while (true) {
    if (!io.sameHost()) return { ok: false, error: 'Codex hosting changed during acceptance check; acceptance unconfirmed' }
    if (io.landed()) return { ok: true }
    const state = await io.state()
    const blocker = state && codexDeliveryBlocker(state.text)
    if (blocker) return { ok: false, error: blocker }
    if (state && io.submitted() && codexQueueCarries(state, message)) return { ok: true }
    if (now() >= deadline) break
    // No blind CR into arbitrary modals or a human draft. Retry only this still-visible paste.
    if (state && now() >= retryAt && !io.attached() && ownDraft(state, message)) {
      const retried = await io.resubmit()
      if (!retried.ok) return retried
      retryAt = now() + 1500
    }
    await sleep(100)
  }
  return { ok: false, error: 'Codex acceptance unconfirmed: no new native user-input receipt or matching native queue; message may remain in composer or be consumed later' }
}

export async function deliverCodexToHost(runDir: string, identity: string, message: string, env: NodeJS.ProcessEnv): Promise<DeliverResult> {
  try {
    const spec = JSON.parse(readFileSync(servePath(runDir, identity), 'utf8'))
    const token = readFileSync(pidPath(runDir, identity), 'utf8')
    const home = spec.env?.CODEX_HOME || env.CODEX_HOME || (spec.env?.HOME || env.HOME ? join(spec.env?.HOME || env.HOME, '.codex') : undefined)
    if (!home || typeof spec.cwd !== 'string') return { ok: false, error: 'Codex receipt paths unavailable' }
    const receipt = codexReceiptBaseline(home, spec.cwd, message)
    return await confirmCodexDelivery(message, {
      ...receipt,
      state: () => captureHostState(runDir, identity),
      send: () => deliverToHost(runDir, identity, message),
      resubmit: () => sendControlToHost(runDir, identity, [Buffer.from('\r')]),
      sameHost: () => { try { return readFileSync(pidPath(runDir, identity), 'utf8') === token } catch { return false } },
      attached: () => existsSync(join(runDir, `${identity}.attached`)),
    })
  } catch (e) { return { ok: false, error: `Codex acceptance check failed: ${String(e)}` } }
}
