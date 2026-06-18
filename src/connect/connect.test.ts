// connect telegram — the one-flow channel attachment (design §(в)). Sandboxed:
// IAPEER_ROOT temp dirs, injected telegram-runtime runner + router restart. The
// runner stub mimics the package: `bot add` writes bots/<alias>/.env (stable ABI).

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { tmpdir } from 'os'
import { join } from 'path'
import { botEnvPath, connectTelegram, type RestartOutcome, type TgRunner } from './index.ts'
import { writeRuntimeManifest } from '../runtime/index.ts'
import { upsertPeer } from '../registry/index.ts'

const roots: string[] = []
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'iapeer-connect-'))
  roots.push(d)
  return d
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function envFor(root: string): NodeJS.ProcessEnv {
  return {
    IAPEER_ROOT: join(root, 'iapeer'),
    IAPEER_LAUNCHAGENTS_DIR: join(root, 'LA'),
    IAPEER_TEST_SANDBOX: '1',
    HOME: root,
  } as NodeJS.ProcessEnv
}

async function fixture(): Promise<{ env: NodeJS.ProcessEnv; calls: string[][]; runTg: TgRunner; restarts: string[] }> {
  const env = envFor(mkTmp())
  writeRuntimeManifest({ runtime: 'telegram', selfConfig: { command: '/stub/telegram-runtime', args: ['self-config'] } }, { env })
  await upsertPeer({ personality: 'leo', runtime: 'claude', cwd: '/tmp/leo', intelligence: 'artificial' }, { env })
  await upsertPeer({ personality: 'nova', runtime: 'telegram', cwd: '/tmp/nova', intelligence: 'natural' }, { env })
  const calls: string[][] = []
  const runTg: TgRunner = (args, e) => {
    calls.push(args)
    if (args[0] === 'bot' && args[1] === 'add') {
      // the package's behavior: token → bots/<alias>/.env (incl. the username
      // field — the RELIABLE source, live-host fact); stdout also prints one
      const p = botEnvPath(args[2]!, e)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, `TELEGRAM_BOT_TOKEN=${args[4]}\nTELEGRAM_BOT_USERNAME=leo_env_bot\n`)
      return { status: 0, stdout: 'bot added: @leo_stdout_bot\n', stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  const restarts: string[] = []
  return { env, calls, runTg, restarts }
}

const okRestart =
  (restarts: string[]) =>
  (human: string): RestartOutcome => {
    restarts.push(human)
    return { state: 'restarted' }
  }

describe('connectTelegram (one flow: bot add → interface → restart → activation)', () => {
  test('happy path: adds the bot, interfaces the peer, restarts the HUMAN router, surfaces @username', async () => {
    const { env, calls, runTg, restarts } = await fixture()
    const r = await connectTelegram({ peer: 'leo', token: 'T1:abc', env, runTg, restart: okRestart(restarts) })
    expect(r.state).toBe('connected')
    expect(r.username).toBe('@leo_env_bot') // .env field WINS over the stdout match
    expect(r.restart?.state).toBe('restarted')
    expect(restarts).toEqual(['nova']) // the router = the natural telegram peer, not leo
    expect(calls[0]).toEqual(['bot', 'add', 'leo', '--token', 'T1:abc'])
    expect(calls[1]).toEqual(['interface', 'bot', 'leo', '--peer', 'leo'])
  })

  test('IDEMPOTENT: the same token is a byte-stable no-op — router NOT restarted', async () => {
    const { env, runTg, restarts } = await fixture()
    expect((await connectTelegram({ peer: 'leo', token: 'T1:abc', env, runTg, restart: okRestart(restarts) })).state).toBe('connected')
    const second = await connectTelegram({ peer: 'leo', token: 'T1:abc', env, runTg, restart: okRestart(restarts) })
    expect(second.state).toBe('noop-same-token')
    expect(restarts).toEqual(['nova']) // exactly ONE restart — the first connect
  })

  test('a NEW token replaces and RESTARTS again (credentials load at start)', async () => {
    const { env, runTg, restarts } = await fixture()
    await connectTelegram({ peer: 'leo', token: 'T1:abc', env, runTg, restart: okRestart(restarts) })
    const r = await connectTelegram({ peer: 'leo', token: 'T2:new', env, runTg, restart: okRestart(restarts) })
    expect(r.state).toBe('connected')
    expect(restarts).toEqual(['nova', 'nova'])
  })

  test('unregistered peer → refused BEFORE any bot add (interface precondition)', async () => {
    const { env, calls, runTg } = await fixture()
    const r = await connectTelegram({ peer: 'ghost', token: 'T', env, runTg })
    expect(r.state).toBe('unregistered-peer')
    expect(calls.length).toBe(0)
  })

  test('no telegram manifest → runtime-missing with the install recipe', async () => {
    const env = envFor(mkTmp())
    await upsertPeer({ personality: 'leo', runtime: 'claude', cwd: '/tmp/leo', intelligence: 'artificial' }, { env })
    const r = await connectTelegram({ peer: 'leo', token: 'T', env })
    expect(r.state).toBe('runtime-missing')
    expect(r.detail).toContain('install-runtime telegram')
  })

  test('non-tty without --token → explicit refusal with the BotFather recipe', async () => {
    const { env, runTg } = await fixture()
    const r = await connectTelegram({ peer: 'leo', env, runTg, isTty: false })
    expect(r.state).toBe('refused-no-token')
    expect(r.detail).toContain('@BotFather')
  })

  test('tty prompt path: the asked token flows in; empty answer → refusal', async () => {
    const { env, runTg, restarts } = await fixture()
    const r = await connectTelegram({ peer: 'leo', env, runTg, isTty: true, ask: async () => 'T9:asked', restart: okRestart(restarts) })
    expect(r.state).toBe('connected')
    const r2 = await connectTelegram({ peer: 'leo', env, runTg, isTty: true, ask: async () => '' })
    expect(r2.state).toBe('refused-no-token')
  })

  test('username falls back to the bot-add stdout when .env carries no username field', async () => {
    const env = envFor(mkTmp())
    writeRuntimeManifest({ runtime: 'telegram', selfConfig: '/stub/telegram-runtime self-config' }, { env })
    await upsertPeer({ personality: 'leo', runtime: 'claude', cwd: '/tmp/leo', intelligence: 'artificial' }, { env })
    await upsertPeer({ personality: 'nova', runtime: 'telegram', cwd: '/tmp/nova', intelligence: 'natural' }, { env })
    const runTg: TgRunner = (args, e) => {
      if (args[0] === 'bot') {
        const p = botEnvPath('leo', e)
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, 'TELEGRAM_BOT_TOKEN=T\n') // no username field (older package)
        return { status: 0, stdout: 'added @stdout_only_bot\n', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    const r = await connectTelegram({ peer: 'leo', token: 'T', env, runTg, restart: okRestart([]) })
    expect(r.username).toBe('@stdout_only_bot')
  })

  test('bot add failure (getMe refusal on a bad token) → bot-add-failed with the package detail', async () => {
    const { env } = await fixture()
    const failTg: TgRunner = args =>
      args[0] === 'bot' ? { status: 1, stdout: '', stderr: 'getMe failed: 401 Unauthorized' } : { status: 0, stdout: '', stderr: '' }
    const r = await connectTelegram({ peer: 'leo', token: 'bad', env, runTg: failTg })
    expect(r.state).toBe('bot-add-failed')
    expect(r.detail).toContain('401')
  })

  test('no natural telegram peer in the registry → connected but restart=no-router (loud)', async () => {
    const env = envFor(mkTmp())
    writeRuntimeManifest({ runtime: 'telegram', selfConfig: '/stub/telegram-runtime self-config' }, { env })
    await upsertPeer({ personality: 'leo', runtime: 'claude', cwd: '/tmp/leo', intelligence: 'artificial' }, { env })
    const runTg: TgRunner = (args, e) => {
      if (args[0] === 'bot') {
        const p = botEnvPath('leo', e)
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, 'TELEGRAM_BOT_TOKEN=T\n')
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    const r = await connectTelegram({ peer: 'leo', token: 'T', env, runTg })
    expect(r.state).toBe('connected')
    expect(r.restart?.state).toBe('no-router')
  })
})
