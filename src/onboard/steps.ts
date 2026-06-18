// Default-yes onboard steps for the distribution BACKBONE (design doc
// docs/«Onboard костяка — notifier, telegram, каналы, update»; baked facts:
// notifier «ноль вопросов», telegram self-config contract v0.10.0+).
//
// Backbone = core + memory slot + notifier-runtime + telegram-runtime. The onboard
// step ORDER is significant: marketplace → notifier → TELEGRAM (creates the human
// peer) → memory (its --human resolves from the natural peer that just appeared).
//
// UX principle («вопросами владеет рантайм»): the package owns its questions; the
// core orchestrates the steps, passes only facts IT owns, and inherits stdio for
// the package's own interactive. Every step is OPTIONAL (default-yes, removed by a
// flag); unavailability is a SOFT SKIP, never a core failure.

import { spawnSync } from 'child_process'
import { isValidName, normalizeIntelligenceValue, normalizeNameCandidate } from '../core/constants.ts'
import { readPeersIndex } from '../registry/index.ts'
import { createPeer } from '../create/index.ts'
import {
  deployRuntime,
  installRuntimePackage,
  RUNTIME_PACKAGES,
  type DeployedPeer,
  type NpxRunner,
} from '../runtime/deploy.ts'

// ─────────────────────────────────────────────────────────────────────────────
// (а) notifier — default-yes, ZERO questions (the whole chain has no
// prompt/stdin/tty dependency; all failures are fail-closed exit≠0).
// Prereq (not a question): `bun` on PATH — without it the npx shim exits non-zero
// → SOFT SKIP with a clear message (design: unavailability is not a core error).
// Idempotent re-onboard: install is manifest-gated (skipped), deploy is no-clobber
// («1 плист = 1 infra-пир»).
// ─────────────────────────────────────────────────────────────────────────────

export interface NotifierStepOptions {
  /** --no-notifier: remove the default-yes step. */
  skip?: boolean
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  /** Injected npx runner (tests / sandbox proof). */
  runNpx?: NpxRunner
  warn?: (message: string) => void
}

export interface NotifierStepResult {
  state:
    | 'deployed' // declared set provisioned (or re-verified — idempotent)
    | 'skipped-flag' // --no-notifier
    | 'skipped-unavailable' // npx failed (no bun / not published / no network) — soft skip
    | 'deploy-failed' // the package installed but the declared-set deploy broke — REAL failure
    | 'dry-run'
  peers: DeployedPeer[]
  detail?: string
}

export async function onboardNotifierStep(opts: NotifierStepOptions = {}): Promise<NotifierStepResult> {
  const env = opts.env ?? process.env
  if (opts.skip) return { state: 'skipped-flag', peers: [] }
  if (opts.dryRun) {
    return {
      state: 'dry-run',
      peers: [],
      detail: `would npx-install ${RUNTIME_PACKAGES.notifier} + deploy its declared peer-set (timer, watcher)`,
    }
  }
  const install = installRuntimePackage({ runtime: 'notifier', env, runNpx: opts.runNpx })
  if (install.state === 'failed' || install.state === 'no-package') {
    // SOFT skip (design (а)): a missing prereq (bun) / unpublished package / no
    // network must not fail the core's onboard — report and move on.
    return {
      state: 'skipped-unavailable',
      peers: [],
      detail: `${install.package ?? 'notifier package'} install failed (${install.detail?.split('\n')[0] ?? 'npx non-zero'}) — install later: iapeer install-runtime notifier`,
    }
  }
  try {
    const deploy = await deployRuntime({ runtime: 'notifier', env, warn: opts.warn })
    const broken = deploy.peers.some(p => p.bootstrap === 'failed' || p.selfConfig === 'failed')
    return {
      state: broken ? 'deploy-failed' : 'deployed',
      peers: deploy.peers,
      detail: broken ? 'a declared peer failed self-config/bootstrap — see the per-peer lines' : undefined,
    }
  } catch (e) {
    // The package installed but its manifest/deploy contract broke — a REAL failure
    // (not unavailability), surfaced as such.
    return { state: 'deploy-failed', peers: [], detail: e instanceof Error ? e.message : String(e) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// (б) telegram — default-yes, install WITH setup. The human owes exactly two
// facts: the human-peer name and their telegram user_id (prompt hints at
// @userinfobot). The core creates the HUMAN peer via createPeer with
// TELEGRAM_USER_ID in env — the package's self-config hook (contract v0.10.0+)
// writes interfaces.telegram.user_id itself; no prepare / interface-human calls.
// Bot tokens are NOT asked here — they are per-channel (`iapeer connect telegram`).
//
// IDEMPOTENT re-onboard: an EXISTING natural peer in the registry → the step is
// a no-op/skip with a clear message —
// NEVER an offer to create a second human peer.
//
// Interactive lives INSIDE the step (tty only); non-tty without the flags
// (--telegram-human + --telegram-user-id) → an explicit refusal of the STEP, not
// of the whole onboard.
// ─────────────────────────────────────────────────────────────────────────────

export interface TelegramStepOptions {
  /** --no-telegram: remove the default-yes step. */
  skip?: boolean
  /** --telegram-human <p>: the human peer's personality (skips the prompt). */
  human?: string
  /** --telegram-user-id <id>: the owner's telegram user id (skips the prompt). */
  userId?: string
  dryRun?: boolean
  env?: NodeJS.ProcessEnv
  runNpx?: NpxRunner
  /** Injectable prompt (tests). Default: readline on the live tty. */
  ask?: (question: string) => Promise<string>
  /** Override tty detection (tests). Default: stdin AND stdout are ttys. */
  isTty?: boolean
  warn?: (message: string) => void
}

export interface TelegramStepResult {
  state:
    | 'created' // human peer created; user_id delivered via the self-config hook
    | 'already' // a natural peer already exists — idempotent skip (never a second human)
    | 'skipped-flag' // --no-telegram
    | 'skipped-unavailable' // package install failed — soft skip
    | 'refused-non-tty' // no tty and no flags — the STEP refuses, onboard continues
    | 'invalid-input' // explicit flags carried an invalid name / user id — hard
    | 'create-failed' // createPeer threw — hard
    | 'dry-run'
  personality?: string
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

/** The registry's existing natural peer, if any (the idempotency key of the step). */
export function findNaturalPeer(env: NodeJS.ProcessEnv): string | null {
  try {
    const naturals = readPeersIndex({ env }).peers.filter(
      p => normalizeIntelligenceValue(p.intelligence) === 'natural',
    )
    return naturals[0]?.personality ?? null
  } catch {
    return null // no registry yet → no natural peer
  }
}

export async function onboardTelegramStep(opts: TelegramStepOptions = {}): Promise<TelegramStepResult> {
  const env = opts.env ?? process.env
  if (opts.skip) return { state: 'skipped-flag' }

  // Idempotency FIRST (before any install/questions): an existing natural peer
  // means the host already has its human — the whole step is a no-op.
  const existing = findNaturalPeer(env)
  if (existing) {
    return { state: 'already', personality: existing, detail: `human-пир "${existing}" уже есть — шаг пропущен` }
  }

  if (opts.dryRun) {
    return {
      state: 'dry-run',
      detail: `would npx-install ${RUNTIME_PACKAGES.telegram} + create the human peer (asks: name, telegram user_id)`,
    }
  }

  const install = installRuntimePackage({ runtime: 'telegram', env, runNpx: opts.runNpx })
  if (install.state === 'failed' || install.state === 'no-package') {
    return {
      state: 'skipped-unavailable',
      detail: `${install.package ?? 'telegram package'} install failed (${install.detail?.split('\n')[0] ?? 'npx non-zero'}) — install later: iapeer install-runtime telegram`,
    }
  }

  // Resolve the two human-owed facts: flags → prompt (tty) → refuse (non-tty).
  let human = opts.human?.trim()
  let userId = opts.userId?.trim()
  if (!human || !userId) {
    const tty = opts.isTty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)
    if (!tty) {
      return {
        state: 'refused-non-tty',
        detail:
          'no tty for the telegram questions — re-run with --telegram-human <name> --telegram-user-id <id>, ' +
          'or skip with --no-telegram (add later: iapeer create <name> --runtime telegram)',
      }
    }
    const ask = opts.ask ?? ttyAsk
    if (!human) human = (await ask('telegram step — your human-peer name (short, latin): ')).trim()
    if (human && !userId) {
      userId = (await ask('your telegram user_id (message @userinfobot — it replies with the id): ')).trim()
    }
    if (!human || !userId) {
      // An empty answer on the live tty is a "not now" — soft refusal of the step.
      return {
        state: 'refused-non-tty',
        detail: 'no answer — telegram step skipped (add later: iapeer create <name> --runtime telegram)',
      }
    }
  }

  const personality = normalizeNameCandidate(human)
  if (!isValidName(personality)) {
    return { state: 'invalid-input', detail: `invalid human-peer name "${human}" — must normalize to /^[a-z][a-z0-9-]{0,31}$/` }
  }
  if (!/^\d+$/.test(userId)) {
    return { state: 'invalid-input', detail: `invalid telegram user_id "${userId}" — expected digits (ask @userinfobot)` }
  }

  try {
    // TELEGRAM_USER_ID rides the env into createPeer → initPeer → the package's
    // self-config hook, which writes interfaces.telegram.user_id itself
    // (contract v0.10.0+ — no prepare / interface-human from the core).
    const r = await createPeer({
      personality,
      runtime: 'telegram',
      intelligence: 'natural',
      env: { ...env, TELEGRAM_USER_ID: userId },
      warn: opts.warn,
    })
    const sc = r.selfConfig?.state ?? 'absent'
    if (sc === 'failed') {
      return {
        state: 'create-failed',
        personality,
        detail: `peer created but the telegram self-config hook failed: ${r.selfConfig?.detail ?? ''}`,
      }
    }
    return { state: 'created', personality, detail: `self-config ${sc}; bootstrap ${r.bootstrapped?.state ?? 'n/a'}` }
  } catch (e) {
    return { state: 'create-failed', personality, detail: e instanceof Error ? e.message : String(e) }
  }
}
