// connect — per-peer channel attachment in ONE flow (design «Onboard костяка» §(в);
// flow facts confirmed by the telegram-runtime owner against v0.10.3).
// Namespace: `iapeer connect <channel> <peer>` — extensible to future channels;
// v1 implements `connect telegram <peer> [--token <t>]`.
//
// The human owes EXACTLY ONE external fact: the bot token (prompt walks them
// through @BotFather → /newbot). Everything else the system resolves: the bot
// @username via Telegram getMe(token) — the bot key is TOKEN-derived, NOT the peer
// personality (a personality may contain a hyphen, structurally invalid as a
// @username; telegram-runtime keys bots by <bot-username>), `telegram-runtime bot add`
// (also validates the token), `telegram-runtime interface bot` (profile merge;
// precondition: the peer is registered), then the MANDATORY
// router-session restart (the live poller reads bots/ ONCE at start, no fs-watch —
// without the restart the channel is dead both ways), and the activation hint:
// the FIRST message from the human to the bot opens the chat (a Telegram platform
// rule — a bot cannot initiate; outbound into an unopened chat is 403).
//
// IDEMPOTENT: the same token is a byte-stable no-op (bots/<alias>/.env unchanged →
// no restart needed); a NEW token replaces with an explicit message AND restarts
// (credentials load at start).

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { normalizeIntelligenceValue } from '../core/constants.ts'
import { runtimeRoot } from '../storage/index.ts'
import { findPeer, readPeersIndex } from '../registry/index.ts'
import { readRuntimeManifest } from '../runtime/index.ts'

export interface TgRunResult {
  status: number | null
  stdout: string
  stderr: string
}
export type TgRunner = (args: string[], env: NodeJS.ProcessEnv) => TgRunResult

export interface RestartOutcome {
  state: 'restarted' | 'refused-foreign-launchd' | 'failed' | 'no-router'
  detail?: string
}
export type RestartFn = (humanPeer: string, env: NodeJS.ProcessEnv) => RestartOutcome

export interface ConnectTelegramOptions {
  peer: string
  /** --token; absent → tty prompt (BotFather recipe) / non-tty refusal. */
  token?: string
  env?: NodeJS.ProcessEnv
  /** Injectable prompt (tests). Default: readline on the live tty. */
  ask?: (question: string) => Promise<string>
  /** Override tty detection (tests). */
  isTty?: boolean
  /** Injectable telegram-runtime invoker (tests). Default: spawn the manifest's bin. */
  runTg?: TgRunner
  /** Injectable router restart (tests). Default: stopPeer→startPeer strictly in order. */
  restart?: RestartFn
  /** Injectable bot-@username resolver (tests). Default: Telegram getMe(token). Returns the
   *  bare @username (no leading @) or null on a rejected/unreachable token. */
  resolveUsername?: (token: string) => Promise<string | null>
}

export interface ConnectTelegramResult {
  state:
    | 'connected' // bot added + interfaced + router restarted — channel live after activation
    | 'noop-same-token' // byte-stable .env → nothing changed, no restart
    | 'refused-no-token' // non-tty and no --token (or an empty tty answer)
    | 'unregistered-peer' // precondition: the peer must be in the registry
    | 'runtime-missing' // no telegram runtime manifest — install it first
    | 'bad-token' // Telegram getMe rejected the token (invalid/revoked) or was unreachable
    | 'bot-add-failed' // telegram-runtime bot add exited non-zero (incl. getMe refusal)
    | 'interface-failed' // telegram-runtime interface bot exited non-zero
  peer: string
  /** Bot @username when `bot add` surfaced one (owner obligation) — best-effort. */
  username?: string
  restart?: RestartOutcome
  detail?: string
}

async function ttyAsk(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

/** bots/<alias>/.env under the telegram runtime scope (stable ABI — owner's fact). */
export function botEnvPath(alias: string, env: NodeJS.ProcessEnv): string {
  return join(runtimeRoot('telegram', { env }), 'bots', alias, '.env')
}

function readBotEnv(alias: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const p = botEnvPath(alias, env)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  } catch {
    return null
  }
}

/**
 * Resolve the bot's REAL @username from the token via Telegram getMe — the bot identity
 * is TOKEN-derived (BotFather sets it), NOT the peer personality. telegram-runtime keys
 * bots by `<bot-username>` (`bot add <bot-username>`, `interface bot <bot-username>`), and a
 * personality can contain a hyphen which is structurally invalid as a @username — so the
 * personality can NEVER be the bot-username. Returns the bare username (no leading @) or
 * null on a rejected/unreachable token. The token goes literally in the URL path
 * (Telegram tokens are `<digits>:<urlsafe>`; no encoding).
 */
async function defaultResolveBotUsername(token: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const j = (await r.json()) as { ok?: boolean; result?: { username?: unknown } }
    const u = j?.ok === true && typeof j.result?.username === 'string' ? j.result.username.trim().replace(/^@/, '') : ''
    return u || null
  } catch {
    return null // network error / non-JSON → treat as unresolvable (bad-token)
  }
}

/** Resolve the telegram-runtime CLI bin from the manifest's selfConfig command (the
 *  package's own absolute bin — PATH-independent, launchd-safe). */
function resolveTgBin(env: NodeJS.ProcessEnv): string | null {
  const manifest = readRuntimeManifest('telegram', { env })
  if (!manifest) return null
  const sc = manifest.selfConfig
  if (typeof sc === 'string' && sc.trim()) return sc.trim().split(/\s+/)[0]!
  if (sc && typeof sc === 'object' && sc.command) return sc.command
  return 'telegram-runtime' // manifest present but no hook — fall back to PATH
}

const defaultRunTg =
  (bin: string): TgRunner =>
  (args, env) => {
    const r = spawnSync(bin, args, { encoding: 'utf8', env: env as Record<string, string> })
    return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') }
  }

/** The default router restart: stop→start of the human peer's telegram runtime,
 *  STRICTLY sequential (the per-bot runtime.lock with live-pid detection refuses a
 *  parallel process — a feature). Deferred import: connect → cli would otherwise be
 *  a static cycle (cli imports connect). */
async function defaultRestart(humanPeer: string, env: NodeJS.ProcessEnv): Promise<RestartOutcome> {
  const { stopPeer, startPeer } = await import('../cli/index.ts')
  try {
    const stops = stopPeer(humanPeer, 'telegram', { env })
    if (stops.some(o => o.action === 'refused-foreign-launchd')) {
      return {
        state: 'refused-foreign-launchd',
        detail: `router "${humanPeer}" is persistent-peer-managed (H4 read-only) — restart it yourself to load the new bot`,
      }
    }
    const starts = startPeer(humanPeer, 'telegram', { env })
    const bad = starts.find(o => o.reason && o.action === 'bootstrap')
    return bad ? { state: 'failed', detail: bad.reason } : { state: 'restarted' }
  } catch (e) {
    return { state: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}

/** The registry's natural peer — the router-session owner (ONE poller serves all
 *  bots; it runs under the human peer's telegram runtime). */
function findRouterHuman(env: NodeJS.ProcessEnv): string | null {
  try {
    const naturals = readPeersIndex({ env }).peers.filter(
      p => normalizeIntelligenceValue(p.intelligence) === 'natural' && (p.runtime === 'telegram' || p.runtimes.includes('telegram')),
    )
    return naturals[0]?.personality ?? null
  } catch {
    return null
  }
}

export async function connectTelegram(opts: ConnectTelegramOptions): Promise<ConnectTelegramResult> {
  const env = opts.env ?? process.env
  const peer = opts.peer.trim()

  // Precondition (owner's fact): `interface bot` merges into the peer's profile —
  // the peer must exist in the registry first.
  if (!findPeer(readPeersIndex({ env }), peer)) {
    return { state: 'unregistered-peer', peer, detail: `peer "${peer}" is not registered — create it first (iapeer create ${peer})` }
  }

  const tgBin = resolveTgBin(env)
  if (!tgBin) {
    return { state: 'runtime-missing', peer, detail: 'telegram runtime is not installed — run: iapeer install-runtime telegram' }
  }

  // The ONE human-owed fact: the bot token.
  let token = opts.token?.trim()
  if (!token) {
    const tty = opts.isTty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)
    if (!tty) {
      return { state: 'refused-no-token', peer, detail: 'no tty and no --token — re-run with --token <bot-token> (create one: @BotFather → /newbot)' }
    }
    const ask = opts.ask ?? ttyAsk
    token = (await ask(`bot token for "${peer}" (create: message @BotFather → /newbot → copy the token): `)).trim()
    if (!token) return { state: 'refused-no-token', peer, detail: 'no answer — nothing connected' }
  }

  // Resolve the bot's REAL @username from the token (getMe) — NOT the personality. The
  // bot-username is token-derived; a personality with a hyphen (e.g. "impact-finder") is
  // structurally invalid as a @username and telegram-runtime (which keys bots by
  // <bot-username>) rejects it. getMe also validates the token early (bad token → fail here).
  const resolveUsername = opts.resolveUsername ?? defaultResolveBotUsername
  const botUsername = await resolveUsername(token)
  if (!botUsername) {
    return { state: 'bad-token', peer, detail: 'Telegram getMe rejected the token (invalid/revoked) or was unreachable — recheck the token with @BotFather' }
  }
  const runTg = opts.runTg ?? defaultRunTg(tgBin)
  const alias = botUsername // bot key = the REAL @username from getMe (telegram-runtime keys bots by <bot-username>)
  const before = readBotEnv(alias, env)

  // (1) bot add — token → bots/<alias>/.env. Owner adds getMe validation here: an
  // invalid token fails EARLY with the platform's reason; we surface it verbatim.
  const add = runTg(['bot', 'add', alias, '--token', token], env)
  if (add.status !== 0) {
    return { state: 'bot-add-failed', peer, detail: (add.stderr || add.stdout || `exit ${add.status}`).trim() }
  }
  // @username for display / the activation hint: the bot key (alias) IS the
  // getMe-resolved username, so the display form is simply `@<alias>` — no need to
  // re-parse bots/<alias>/.env (telegram-runtime writes the same value there).
  const username = `@${alias}`

  // (2) interface bot — merge the channel binding into the peer's profile.
  const iface = runTg(['interface', 'bot', alias, '--peer', peer], env)
  if (iface.status !== 0) {
    return { state: 'interface-failed', peer, username, detail: (iface.stderr || iface.stdout || `exit ${iface.status}`).trim() }
  }

  // (3) Idempotency gate: the SAME token leaves bots/<alias>/.env byte-stable →
  // the live poller already loaded these credentials → NO restart, clean no-op.
  const after = readBotEnv(alias, env)
  if (before !== null && after === before) {
    return { state: 'noop-same-token', peer, username, detail: 'same token — byte-stable no-op, router not restarted' }
  }

  // (4) MANDATORY router restart (new/changed credentials load only at start).
  // Cost: a seconds-long delivery blip for the whole fleet; inbound is NOT lost
  // (long-polling offset, Telegram holds up to 24 h) — known, accepted (design).
  const human = findRouterHuman(env)
  const restart: RestartOutcome = human
    ? opts.restart
      ? opts.restart(human, env)
      : await defaultRestart(human, env)
    : { state: 'no-router', detail: 'no natural telegram peer in the registry — start the router manually after onboarding the human' }

  return { state: 'connected', peer, username, restart }
}
