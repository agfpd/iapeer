// Provision — the one-call peer-creation entrypoint. Composes the two foundation
// writes a new peer needs: identity.ensurePeerProfile (local <cwd>/.iapeer/
// peer-profile.json + scaffold + — for an INFRA runtime — the always-on launchd
// plist) and registry.upsertPeer (the global peers-profiles.json entry the daemon
// reads for its tool-list, caller resolution, and wake-on-miss findPeer).
//
// INFRA gotcha closed at this layer: a notifier/telegram always-on plist runs its
// launcher under launchd's MINIMAL PATH (no ~/.local/bin, ~/.bun/bin). So before
// writing the plist we RESOLVE the runtime launcher to an absolute path against the
// rich provisioning PATH and bake it in (NOTIFIER_RUNTIME_BIN / TELEGRAM_RUNTIME_BIN
// via installAlwaysOnPlist). If it does not resolve to an executable, we REFUSE to
// provision rather than create a peer whose always-on session crash-loops.

import { basename, resolve } from 'path'
import {
  INFRA_RUNTIME_DEFAULT_BIN,
  isInfraRuntime,
  isRuntime,
  normalizeNameCandidate,
  type Intelligence,
  type Runtime,
} from '../core/constants.ts'
import { IapError } from '../core/errors.ts'
import { peerProfilePath } from '../storage/index.ts'
import { ensurePeerProfile } from '../identity/index.ts'
import { readPeersIndex, upsertPeer } from '../registry/index.ts'
import { resolveAlwaysOnTarget, resolveExecutable } from '../launch/launchd.ts'

export interface ProvisionPeerOptions {
  /** The peer's working directory. personality defaults to normalized basename. */
  cwd: string
  runtime: Runtime
  /** Explicit personality override (default: normalized basename(cwd)). */
  personality?: string
  description?: string
  intelligence?: Intelligence
  /** Infra runtime launcher (abs path or PATH name); resolved to an abs path. */
  runtimeBin?: string
  env?: NodeJS.ProcessEnv
  warn?: (message: string) => void
}

export interface ProvisionResult {
  personality: string
  runtime: Runtime
  cwd: string
  profilePath: string
  intelligence: Intelligence
  /** For an infra runtime: the installed always-on plist path. */
  plistPath?: string
  /** For an infra runtime: the absolute launcher path baked into the plist. */
  runtimeBin?: string
}

/**
 * Provision a new peer in one call: local profile + scaffold (+ infra always-on
 * plist with a pinned launcher) then the registry entry. Idempotent-ish: if the
 * cwd already has a peer-profile.json, ensurePeerProfile returns it unchanged (no
 * second plist install) and the registry is upserted (merge-with-existing).
 */
export async function provisionPeer(opts: ProvisionPeerOptions): Promise<ProvisionResult> {
  const env = opts.env ?? process.env
  if (!isRuntime(opts.runtime)) {
    throw new IapError(`invalid runtime "${opts.runtime}" — must match /^[a-z][a-z0-9]{0,31}$/`)
  }
  const cwd = resolve(opts.cwd)

  // INFRA: resolve the launcher to an abs path NOW (rich provisioning PATH) and
  // refuse to provision a crash-looper. Warm-on-demand runtimes need no plist.
  let runtimeBin: string | undefined
  if (isInfraRuntime(opts.runtime)) {
    const want = opts.runtimeBin ?? INFRA_RUNTIME_DEFAULT_BIN[opts.runtime] ?? opts.runtime
    runtimeBin = resolveExecutable(want, env)
    if (!runtimeBin) {
      throw new IapError(
        `cannot provision infra peer "${opts.personality ?? normalizeNameCandidate(basename(cwd))}": ` +
          `runtime launcher "${want}" not found on PATH or not executable. Install ${opts.runtime}-runtime ` +
          `(or pass an absolute --bin) so the always-on plist resolves it under launchd's minimal PATH.`,
      )
    }
  }

  const peers = readPeersIndex({ env }).peers
  // 1) local profile + scaffold + (infra) always-on plist with the pinned launcher.
  const profile = ensurePeerProfile({
    cwd,
    runtime: opts.runtime,
    env,
    peers,
    personality: opts.personality,
    runtimeBin,
    // The EXPLICIT nature now reaches the LOCAL profile too (A1) — previously it landed only
    // in the registry upsert below, so a `--intelligence absent` telegram bot got a natural
    // local profile (split-brain) and its plist crash-looped the natural gate. Validated
    // against the runtime's allowed set inside ensurePeerProfile.
    intelligence: opts.intelligence,
    // В36 — description goes into the LOCAL profile (source of truth); the registry
    // upsert below then persists a value reindexFromLocals can no longer wipe.
    description: opts.description,
    warn: opts.warn,
  })
  // Birth-time native-memory lever (контракт «Слот памяти» §Native-память рантаймов):
  // an OCCUPIED memory slot gates the AUTOMATIC lever at peer birth — zero window of
  // a parallel, uncurated native store (the criterion). Empty slot → native memory is
  // legitimate, untouched. Best-effort with a LOUD warn (a lever hiccup must not kill
  // the provision — the operator verb `iapeer native-memory off` is the repair).
  try {
    const { readMemoryProvider } = await import('../status/index.ts')
    const slot = readMemoryProvider(env)
    if (slot) {
      const { applyNativeMemory, preTrustCodexCwd } = await import('../launch/nativeMemory.ts')
      for (const o of applyNativeMemory(cwd, profile.runtimes, 'off')) {
        if (o.state === 'failed') {
          opts.warn?.(
            `native-memory lever (${o.runtime}) FAILED for "${profile.personality}": ${o.detail} — ` +
              `the peer may accumulate a parallel native store; repair: iapeer native-memory off --peer ${profile.personality}`,
          )
        }
      }
      // Codex reads project-local config only for a TRUSTED cwd — pre-trust the
      // newborn so the lever acts from the FIRST session (contract requirement),
      // not from whenever the boot dialog's trust grant takes effect.
      if (profile.runtimes.includes('codex')) {
        const t = preTrustCodexCwd(cwd, env)
        if (t.state === 'failed') {
          opts.warn?.(
            `codex pre-trust FAILED for "${profile.personality}": ${t.detail} — ` +
              `the lever may be inert until the first boot's trust dialog`,
          )
        }
      }
      // Provider PROVISION command (контракт §Provision провайдера, declaration
      // v1.2 — ADR-009 inversion): an occupied slot WITH a provision block shells into
      // the PROVIDER's command per agentic runtime (occasion=birth) — the core
      // knows nothing about surface forms. A failure is NEVER masked (a broken
      // provider must not hide) — LOUD warn; repair is provider-side (the core is
      // provider-agnostic and names no command). Runs AFTER preTrustCodexCwd
      // above, so the provider's per-peer codex surfaces land in an already-
      // trusted cwd.
      if (slot.provision) {
        const { runProvisionCommand } = await import('../enable/provisionCommand.ts')
        const { appendLifecycleEvent } = await import('../lifecycle/eventlog.ts')
        const { pluginLogsDir } = await import('../storage/index.ts')
        const agentic = profile.runtimes.filter((r): r is 'claude' | 'codex' => r === 'claude' || r === 'codex')
        for (const rt of agentic) {
          const o = runProvisionCommand({
            block: slot.provision,
            cwd,
            runtime: rt,
            personality: profile.personality,
            occasion: 'birth',
            env,
          })
          appendLifecycleEvent(
            pluginLogsDir('iapeer', { env }),
            {
              ev: 'memory-provision',
              identity: `${rt}-${profile.personality}`,
              occasion: 'birth',
              state: o.state,
              exit: o.exitCode ?? undefined,
              ms: o.durationMs,
              detail: o.detail,
            },
            { env },
          )
          if (o.state !== 'ok') {
            opts.warn?.(
              `memory provision (${rt}) ${o.state.toUpperCase()} for "${profile.personality}"` +
                `${o.detail ? `: ${o.detail}` : ''} — память пира не подключена; ` +
                `repair: re-run the provider's provision for this peer (the provider's own CLI — verify/repair/init)`,
            )
          }
        }
      }
      // NB: the v1.1 plugin auto-install branch (an occupied slot WITH a `plugin`
      // block) was REMOVED — the plugin form is retired ecosystem-wide
      // (provider's ADR-017; contract §Плагин провайдера is a tombstone). A v1.2
      // declaration without a provision block provisions nothing here.
    }
  } catch (e) {
    opts.warn?.(`memory birth-time hook failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // wake_policy:"ephemeral" sanity (M2 edge cases — warn, don't refuse: the policy
  // lives in the hand-editable local profile, provision just surfaces the mismatch):
  //   • + interfaces.telegram: ephemeral WINS in resolveWakeMode (explicit policy
  //     beats the inferred human type), so a human dialogue channel would die-after-
  //     reply and never resume — almost certainly a config mistake.
  //   • + infra (always-on) runtime: launchd KeepAlive owns the session (H4 read-only)
  //     — the daemon never wakes/reaps it, so the ephemeral policy is INERT.
  if (profile.wake_policy === 'ephemeral') {
    if (profile.interfaces?.telegram != null) {
      opts.warn?.(
        `peer "${profile.personality}" declares BOTH wake_policy:"ephemeral" AND interfaces.telegram — ` +
          `ephemeral wins (always-fresh, die-after-reply); a human telegram dialogue should not be ephemeral`,
      )
    }
    if (isInfraRuntime(opts.runtime)) {
      opts.warn?.(
        `peer "${profile.personality}" declares wake_policy:"ephemeral" on always-on infra runtime ` +
          `"${opts.runtime}" — launchd owns the session (H4), the daemon never wakes/reaps it, the policy is inert`,
      )
    }
  }
  // 2) registry entry — without it the daemon does not see the peer (tool-list,
  //    caller resolution, wake-on-miss findPeer all read peers-profiles.json).
  await upsertPeer(
    {
      personality: profile.personality,
      runtime: opts.runtime,
      cwd,
      intelligence: opts.intelligence ?? profile.intelligence,
      description: opts.description,
    },
    { env, warn: opts.warn },
  )

  return {
    personality: profile.personality,
    runtime: opts.runtime,
    cwd,
    profilePath: peerProfilePath(cwd),
    intelligence: opts.intelligence ?? profile.intelligence,
    // Multi-infra: the plist ensurePeerProfile actually installed for THIS runtime
    // (legacy base or per-runtime suffixed) — resolveAlwaysOnTarget re-resolves to
    // the same target the install used (resolution is stable once the file exists).
    plistPath: isInfraRuntime(opts.runtime) ? resolveAlwaysOnTarget(profile.personality, opts.runtime, env).path : undefined,
    runtimeBin,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — `bun src/provision/index.ts <cwd> <runtime> [--personality p] [--bin path]
//        [--description d] [--intelligence i]`
// ─────────────────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[++i] ?? ''
    } else {
      positionals.push(a)
    }
  }
  return { positionals, flags }
}

if (import.meta.main) {
  const { positionals, flags } = parseFlags(process.argv.slice(2))
  const [cwd, runtime] = positionals
  if (!cwd || !runtime) {
    process.stderr.write(
      'usage: provision-peer <cwd> <runtime> [--personality <p>] [--bin <abs-launcher>] ' +
        '[--description <d>] [--intelligence artificial|natural|absent]\n',
    )
    process.exit(2)
  }
  provisionPeer({
    cwd,
    runtime,
    personality: flags.personality,
    description: flags.description,
    intelligence: flags.intelligence as Intelligence | undefined,
    runtimeBin: flags.bin,
    warn: m => process.stderr.write(`warn: ${m}\n`),
  })
    .then(r => {
      process.stdout.write(
        `provisioned peer "${r.personality}" (${r.runtime}, ${r.intelligence})\n` +
          `  profile:  ${r.profilePath}\n` +
          `  registry: peers-profiles.json updated\n` +
          (r.plistPath ? `  plist:    ${r.plistPath}\n  launcher: ${r.runtimeBin}\n` : '') +
          (r.plistPath ? `  (plist written, NOT loaded — run: launchctl bootstrap gui/$(id -u) ${r.plistPath})\n` : ''),
      )
      process.exit(0)
    })
    .catch(e => {
      process.stderr.write(`provision failed: ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    })
}
