// connect telegram — the one-flow channel attachment (design §(в)). Sandboxed:
// IAPEER_ROOT temp dirs, injected getMe (resolveUsername), telegram-runtime runner +
// router restart. The bot key is the getMe-resolved @username (NOT the personality — a
// hyphenated personality is structurally invalid as a @username). The runner stub mimics
// the package: `bot add <username>` writes bots/<username>/.env.

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

/** Injected getMe: token → a fixed bare @username (never touches the real Telegram API). */
const fakeResolve = (username: string) => async (_token: string) => username

async function fixture(): Promise<{
  env: NodeJS.ProcessEnv
  calls: string[][]
  runTg: TgRunner
  restarts: string[]
  resolveUsername: (token: string) => Promise<string | null>
}> {
  const env = envFor(mkTmp())
  writeRuntimeManifest({ runtime: 'telegram', selfConfig: { command: '/stub/telegram-runtime', args: ['self-config'] } }, { env })
  await upsertPeer({ personality: 'leo', runtime: 'claude', cwd: '/tmp/leo', intelligence: 'artificial' }, { env })
  await upsertPeer({ personality: 'nova', runtime: 'telegram', cwd: '/tmp/nova', intelligence: 'natural' }, { env })
  const calls: string[][] = []
  const runTg: TgRunner = (args, e) => {
    calls.push(args)
    if (args[0] === 'bot' && args[1] === 'add') {
      // the package keys bots by <bot-username> (args[2] = the resolved @username):
      // token → bots/<username>/.env.
      const p = botEnvPath(args[2]!, e)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, `TELEGRAM_BOT_TOKEN=${args[4]}\nTELEGRAM_BOT_USERNAME=${args[2]}\n`)
      return { status: 0, stdout: `bot added: @${args[2]}\n`, stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { env, calls, runTg, restarts: [], resolveUsername: fakeResolve('leo_bot') }
}

const okRestart =
  (restarts: string[]) =>
  (human: string): RestartOutcome => {
    restarts.push(human)
    return { state: 'restarted' }
  }

describe('connectTelegram (one flow: getMe → bot add → interface → restart → activation)', () => {
  test('happy path: getMe-username keys bot add + interface (NOT the personality); restarts the HUMAN router', async () => {
    const { env, calls, runTg, restarts, resolveUsername } = await fixture()
    const r = await connectTelegram({ peer: 'leo', token: 'T1:abc', env, runTg, resolveUsername, restart: okRestart(restarts) })
    expect(r.state).toBe('connected')
    expect(r.username).toBe('@leo_bot') // = @<getMe username>, not the personality
    expect(r.restart?.state).toBe('restarted')
    expect(restarts).toEqual(['nova']) // the router = the natural telegram peer, not leo
    expect(calls[0]).toEqual(['bot', 'add', 'leo_bot', '--token', 'T1:abc']) // bot-username, not "leo"
    expect(calls[1]).toEqual(['interface', 'bot', 'leo_bot', '--peer', 'leo']) // <username> + --peer <personality>
  })

  test('THE BUG FIX: a HYPHENATED personality connects — the bot-username is the getMe @username, not "impact-finder"', async () => {
    const { env, calls, runTg, restarts } = await fixture()
    await upsertPeer({ personality: 'impact-finder', runtime: 'claude', cwd: '/tmp/impact-finder', intelligence: 'artificial' }, { env })
    const r = await connectTelegram({
      peer: 'impact-finder',
      token: 'T:tok',
      env,
      runTg,
      resolveUsername: fakeResolve('impactfinder_bot'),
      restart: okRestart(restarts),
    })
    expect(r.state).toBe('connected') // would have failed pre-fix (personality passed as @username)
    expect(calls[0]).toEqual(['bot', 'add', 'impactfinder_bot', '--token', 'T:tok']) // NOT 'impact-finder'
    expect(calls[1]).toEqual(['interface', 'bot', 'impactfinder_bot', '--peer', 'impact-finder'])
    expect(r.username).toBe('@impactfinder_bot')
  })

  test('bad token: getMe returns null → bad-token, BEFORE any bot add', async () => {
    const { env, calls, runTg } = await fixture()
    const r = await connectTelegram({ peer: 'leo', token: 'revoked', env, runTg, resolveUsername: async () => null })
    expect(r.state).toBe('bad-token')
    expect(r.detail).toContain('getMe')
    expect(calls.length).toBe(0) // never reached bot add
  })

  test('IDEMPOTENT: the same token is a byte-stable no-op — router NOT restarted', async () => {
    const { env, runTg, restarts, resolveUsername } = await fixture()
    expect((await connectTelegram({ peer: 'leo', token: 'T1:abc', env, runTg, resolveUsername, restart: okRestart(restarts) })).state).toBe('connected')
    const second = await connectTelegram({ peer: 'leo', token: 'T1:abc', env, runTg, resolveUsername, restart: okRestart(restarts) })
    expect(second.state).toBe('noop-same-token')
    expect(restarts).toEqual(['nova']) // exactly ONE restart — the first connect
  })

  test('a NEW token replaces and RESTARTS again (credentials load at start)', async () => {
    const { env, runTg, restarts, resolveUsername } = await fixture()
    await connectTelegram({ peer: 'leo', token: 'T1:abc', env, runTg, resolveUsername, restart: okRestart(restarts) })
    const r = await connectTelegram({ peer: 'leo', token: 'T2:new', env, runTg, resolveUsername, restart: okRestart(restarts) })
    expect(r.state).toBe('connected')
    expect(restarts).toEqual(['nova', 'nova'])
  })

  test('unregistered peer → refused BEFORE getMe / any bot add (interface precondition)', async () => {
    const { env, calls, runTg } = await fixture()
    const r = await connectTelegram({ peer: 'ghost', token: 'T', env, runTg, resolveUsername: async () => 'x_bot' })
    expect(r.state).toBe('unregistered-peer')
    expect(calls.length).toBe(0)
  })

  test('no telegram manifest → runtime-missing with the install recipe', async () => {
    const env = envFor(mkTmp())
    await upsertPeer({ personality: 'leo', runtime: 'claude', cwd: '/tmp/leo', intelligence: 'artificial' }, { env })
    const r = await connectTelegram({ peer: 'leo', token: 'T', env, resolveUsername: fakeResolve('leo_bot') })
    expect(r.state).toBe('runtime-missing')
    expect(r.detail).toContain('install-runtime telegram')
  })

  test('non-tty without --token → explicit refusal with the BotFather recipe', async () => {
    const { env, runTg, resolveUsername } = await fixture()
    const r = await connectTelegram({ peer: 'leo', env, runTg, resolveUsername, isTty: false })
    expect(r.state).toBe('refused-no-token')
    expect(r.detail).toContain('@BotFather')
  })

  test('tty prompt path: the asked token flows in; empty answer → refusal', async () => {
    const { env, runTg, restarts, resolveUsername } = await fixture()
    const r = await connectTelegram({ peer: 'leo', env, runTg, resolveUsername, isTty: true, ask: async () => 'T9:asked', restart: okRestart(restarts) })
    expect(r.state).toBe('connected')
    const r2 = await connectTelegram({ peer: 'leo', env, runTg, resolveUsername, isTty: true, ask: async () => '' })
    expect(r2.state).toBe('refused-no-token')
  })

  test('bot add failure (package-level refusal) → bot-add-failed with the package detail', async () => {
    const { env, resolveUsername } = await fixture()
    const failTg: TgRunner = args =>
      args[0] === 'bot' ? { status: 1, stdout: '', stderr: 'bot add failed: 409 conflict' } : { status: 0, stdout: '', stderr: '' }
    const r = await connectTelegram({ peer: 'leo', token: 'bad', env, runTg: failTg, resolveUsername })
    expect(r.state).toBe('bot-add-failed')
    expect(r.detail).toContain('409')
  })

  test('no natural telegram peer in the registry → connected but restart=no-router (loud)', async () => {
    const env = envFor(mkTmp())
    writeRuntimeManifest({ runtime: 'telegram', selfConfig: '/stub/telegram-runtime self-config' }, { env })
    await upsertPeer({ personality: 'leo', runtime: 'claude', cwd: '/tmp/leo', intelligence: 'artificial' }, { env })
    const runTg: TgRunner = (args, e) => {
      if (args[0] === 'bot') {
        const p = botEnvPath(args[2]!, e)
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, `TELEGRAM_BOT_TOKEN=T\nTELEGRAM_BOT_USERNAME=${args[2]}\n`)
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    const r = await connectTelegram({ peer: 'leo', token: 'T', env, runTg, resolveUsername: fakeResolve('leo_bot') })
    expect(r.state).toBe('connected')
    expect(r.restart?.state).toBe('no-router')
  })
})
