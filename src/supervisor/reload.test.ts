import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSupervisorDaemon, killSession } from './index.ts'
import { fenceHost } from './reload.ts'
import { deliverToHost } from './deliver.ts'
import { sessionAlive } from './client.ts'
import { transcriptSlug } from '../launch/adapters/claude.ts'

test('input fence rejects concurrent acknowledged delivery, releases on disconnect and retires only an idle native session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'iap-fence-')), home = join(root, 'home'), identity = 'claude-fence'
  let lease: Awaited<ReturnType<typeof fenceHost>> | undefined
  try {
    const start = await startSupervisorDaemon({ session: identity, runtime: 'claude', runDir: root,
      serve: { argv: ['/bin/sh', '-c', `echo $$ > '${join(root, 'child.pid')}'; exec /bin/cat`], env: { HOME: home, PATH: process.env.PATH ?? '' }, cwd: root } })
    expect(start.state).toBe('started')
    for (let i = 0; i < 30; i++) { try { readFileSync(join(root, 'child.pid')); break } catch { await Bun.sleep(50) } }
    const pid = Number(readFileSync(join(root, 'child.pid'), 'utf8'))
    const id = '11111111-1111-4111-8111-111111111111'
    mkdirSync(join(home, '.claude/sessions'), { recursive: true })
    const transcript = join(home, '.claude/projects', transcriptSlug(root), `${id}.jsonl`)
    mkdirSync(join(home, '.claude/projects', transcriptSlug(root)), { recursive: true })
    const evidence = (reason: string) => {
      writeFileSync(join(home, '.claude/sessions', `${pid}.json`), JSON.stringify({ pid, cwd: root, sessionId: id, status: 'idle', statusUpdatedAt: Date.now() }))
      writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: reason } }) + '\n')
    }
    evidence('tool_use')
    lease = await fenceHost(root, identity)
    expect(lease.ready.ok).toBe(false)
    expect(lease.ready.pending).toBe(true)
    expect(sessionAlive(root, identity)).toBe(true)
    lease.close()
    await Bun.sleep(50)
    evidence('end_turn')
    lease = await fenceHost(root, identity)
    expect(lease.ready.ok).toBe(true)
    const rejected = await deliverToHost(root, identity, 'must not land')
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toContain('reloading')
    lease.close()
    await Bun.sleep(50)
    evidence('end_turn')
    lease = await fenceHost(root, identity)
    expect(lease.ready.ok).toBe(true)
    expect((await lease.retire()).ok).toBe(true)
    await Bun.sleep(400)
    expect(sessionAlive(root, identity)).toBe(false)
  } finally {
    lease?.close()
    killSession(root, identity)
    await Bun.sleep(300)
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)
