// Spawn-flip cutover Block 2, Ф0b-3 slice 3c-1 — the supervisor `.attached` marker (the gate signal
// `hasAttachedSupervisorClient` reads to hold hosted delivery ONLY for a real attached human).
// boris's three faces: (1) present ⟺ clients.size>0; (2) ALL detach paths incl. ABNORMAL (abrupt
// terminate → error/close), not just a clean Ctrl-]; (3) CRASH-ROBUSTNESS — a crashed predecessor
// skips shutdown-cleanup, so a stale marker must be cleared on daemon START. Real detached daemon over
// a real unix socket (tick runtime — no codex needed); the marker is read CROSS-PROCESS, as in prod.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frame, FRAME_RESIZE, sizePayload } from './protocol.ts'
import { killSession, sessionAlive, sockPath, startSupervisorDaemon } from './index.ts'
import { attachedPath } from './paths.ts'

const [maj, min, pat] = (Bun.version || '0.0.0').split('.').map(Number) as [number, number, number]
const bunPty = maj > 1 || (maj === 1 && (min > 3 || (min === 3 && pat >= 5)))
const d = bunPty ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function waitFor(pred: () => boolean, timeoutMs = 5000, step = 40): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { if (pred()) return true; await sleep(step) }
  return false
}

interface Client { end(): void; terminate(): void }
async function attach(runDir: string, session: string): Promise<Client> {
  const sock = await Bun.connect({
    unix: sockPath(runDir, session),
    socket: { open(s) { s.write(frame(FRAME_RESIZE, sizePayload(80, 24))) }, data() { /* */ } },
  })
  return {
    end: () => { try { sock.end() } catch { /* */ } },
    terminate: () => { try { sock.terminate() } catch { /* */ } },
  }
}

const dirs: string[] = []
const mkRunDir = (): string => { const d2 = mkdtempSync(join(tmpdir(), 'iapeer-attmark-')); dirs.push(d2); return d2 }
afterEach(() => { for (const d2 of dirs.splice(0)) rmSync(d2, { recursive: true, force: true }) })

d('supervisor .attached marker (the hosted occupancy gate signal)', () => {
  test('present ⟺ clients.size>0 across multiple clients (no stuck "attached" on partial detach)', async () => {
    const runDir = mkRunDir(), session = 'mk'
    startSupervisorDaemon({ session, runtime: 'tick', runDir })
    expect(await waitFor(() => sessionAlive(runDir, session))).toBe(true)
    const marker = attachedPath(runDir, session)
    expect(existsSync(marker)).toBe(false) // no client yet → absent
    const c1 = await attach(runDir, session)
    expect(await waitFor(() => existsSync(marker))).toBe(true) // ≥1 attached → present
    const c2 = await attach(runDir, session)
    await sleep(150)
    expect(existsSync(marker)).toBe(true) // 2 attached → still present
    c1.end()
    await sleep(250)
    expect(existsSync(marker)).toBe(true) // 1 still attached → NOT stuck-absent, NOT removed early
    c2.end()
    expect(await waitFor(() => !existsSync(marker))).toBe(true) // 0 attached → absent
    killSession(runDir, session)
  })

  test('ABNORMAL detach (abrupt terminate, not a clean Ctrl-]) → marker still removed', async () => {
    const runDir = mkRunDir(), session = 'ab'
    startSupervisorDaemon({ session, runtime: 'tick', runDir })
    expect(await waitFor(() => sessionAlive(runDir, session))).toBe(true)
    const marker = attachedPath(runDir, session)
    const c = await attach(runDir, session)
    expect(await waitFor(() => existsSync(marker))).toBe(true)
    c.terminate() // abrupt RST — daemon sees error/close, NOT a graceful protocol detach
    expect(await waitFor(() => !existsSync(marker))).toBe(true) // the error/close path ALSO syncs the marker
    killSession(runDir, session)
  })

  test('CRASH-ROBUSTNESS: a stale marker is cleared on daemon START (crash skips shutdown-cleanup)', async () => {
    const runDir = mkRunDir(), session = 'cr'
    const marker = attachedPath(runDir, session)
    writeFileSync(marker, '') // a crashed predecessor left this present, with no live client
    expect(existsSync(marker)).toBe(true)
    startSupervisorDaemon({ session, runtime: 'tick', runDir }) // fresh daemon = 0 clients
    expect(await waitFor(() => sessionAlive(runDir, session))).toBe(true)
    expect(await waitFor(() => !existsSync(marker))).toBe(true) // start-cleanup removed the stale lie
    killSession(runDir, session)
  })
})
