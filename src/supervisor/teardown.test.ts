import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { hasNewEager, loadLifecycleConfig, processOrphanEagerMarks } from '../lifecycle/index.ts'
import { deliverToHost } from './deliver.ts'
import { killSession, sessionAlive, startSupervisorDaemon } from './index.ts'
import { defaultRunDir, pidStartToken } from './paths.ts'

const fixture = resolve(import.meta.dir, 'fixtures/owned-stdio.ts')
const cli = resolve(import.meta.dir, '../cli/index.ts')
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function until(pred: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await Bun.sleep(40)
  }
  return pred()
}

test('real self-fresh reclaims owned stdio tree; fresh MCP answers; sibling and detached-descendant sentinels survive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iapeer-stdio-'))
  const env = { ...process.env, IAPEER_ROOT: join(dir, 'root'), IAPEER_LAUNCHAGENTS_DIR: join(dir, 'agents'), PEER_IDENTITY: 'codex-stdio-probe' }
  const runDir = defaultRunDir(env)
  const cfg = loadLifecycleConfig(env)
  const session = env.PEER_IDENTITY
  const sentinel = Bun.spawn(['sleep', '60']) // sibling, not owned by the hosted runtime
  const seen = new Map<number, string>()
  const events = (d: string) => existsSync(join(d, 'events.jsonl'))
    ? readFileSync(join(d, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
  const remember = (d: string) => {
    for (const e of events(d)) {
      const token = pidStartToken(e.pid)
      if (token) seen.set(e.pid, token)
    }
  }
  const start = async (generation: string) => {
    const cwd = join(dir, generation)
    mkdirSync(cwd)
    const r = await startSupervisorDaemon({ session, runtime: 'tick', runDir, serve: {
      argv: [process.execPath, fixture, 'peer', cwd, cli], env: env as Record<string, string>, cwd,
    } })
    expect(r.state).toBe('started')
    expect(await until(() => existsSync(join(cwd, 'ready.json')))).toBe(true)
    remember(cwd)
    return cwd
  }
  try {
    const oldDir = await start('old')
    const old = JSON.parse(readFileSync(join(oldDir, 'ready.json'), 'utf8'))
    const server = events(oldDir).find(e => e.event === 'server').pid as number
    const detached = events(oldDir).find(e => e.event === 'detached-sentinel').pid as number
    expect(old.result.content[0].text).toBe(`pong:${server}`)
    expect((await deliverToHost(runDir, session, 'fresh')).ok).toBe(true)
    expect(await until(() => hasNewEager(cfg, session) && !sessionAlive(runDir, session))).toBe(true)
    // Wait well beyond EOF delivery; the stubborn MCP remains on the broken implementation.
    const gone = await until(() => [old.peer, old.wrapper, server].every(p => !alive(p)), 2000)
    console.log(JSON.stringify({ phase: 'old-after-self-fresh', peer: old.peer, wrapper: old.wrapper, server, gone, sentinelAlive: alive(sentinel.pid), events: events(oldDir).map(e => e.event) }))
    expect(gone).toBe(true)
    expect(alive(detached)).toBe(true)
    let freshDir = ''
    const wake = await processOrphanEagerMarks(cfg, { env, wakeFn: async args => {
      expect(args.resume).toBe(false)
      freshDir = await start('fresh')
      return { status: 'READY', woke: true, runtime: 'codex' }
    } })
    expect(wake[0]?.status).toBe('READY')
    const fresh = JSON.parse(readFileSync(join(freshDir, 'ready.json'), 'utf8'))
    const freshServer = events(freshDir).find(e => e.event === 'server').pid as number
    expect(freshServer).not.toBe(server)
    expect(fresh.result.content[0].text).toBe(`pong:${freshServer}`)
    expect(alive(sentinel.pid)).toBe(true)
    expect(hasNewEager(cfg, session)).toBe(false)
    console.log(JSON.stringify({ phase: 'fresh-mcp-call', ...fresh, server: freshServer, sentinelAlive: alive(sentinel.pid) }))
  } finally {
    remember(join(dir, 'old'))
    remember(join(dir, 'fresh'))
    killSession(runDir, session)
    expect(await until(() => !sessionAlive(runDir, session))).toBe(true)
    // A failing BEFORE run must not leave its deliberately stubborn processes behind.
    for (const [pid, token] of seen) {
      if (pidStartToken(pid) === token) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    }
    sentinel.kill('SIGKILL')
    await sentinel.exited
    expect(await until(() => [...seen].every(([pid, token]) => pidStartToken(pid) !== token))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  }
}, 20000)
