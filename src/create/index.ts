// create — the cwd-INDEPENDENT peer-creation verb (`iapeer create <personality>
// [--runtime] [--path]`, contract Фаза §1 / Примитивы). Where `init` provisions the
// CURRENT folder (cwd-dependent, for an implementer working IN a repo), `create`
// RESOLVES a location for a brand-new peer, scaffolds the folder, then inits it —
// from anywhere, no `cd` required.
//
// LOCATION: --path wins; otherwise the foundation-owned default home
// ~/.iapeer/peers/<personality> (collision-free, unlike the organic ~/Peers the
// legacy fleet grew in — existing ~/Peers/* peers are grandfathered, NOT migrated).
//
// NO-CLOBBER: making the folder is mkdir-recursive (never deletes); init is
// idempotent (profile kept, .mcp.json merged, doctrine never overwritten). The one
// hard refusal: a target that already holds a DIFFERENT peer's profile — creating
// "alice" into a folder that is already "bob" would either silently adopt bob or
// split an identity, so it fails loudly instead.
//
// INFRA (telegram human via operator-add / notifier function via a declared set):
// runtime=telegram|notifier → provision installs the always-on plist and (default)
// AUTO-bootstraps it. "1 always-on infra peer = 1 plist", idempotent (re-create of
// the same peer does not duplicate or clobber — installAlwaysOnPlist's sentinel guard
// allows re-writing only OUR own plist).

import { existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'
import { isValidName, normalizeNameCandidate, type Intelligence, type Runtime } from '../core/constants.ts'
import { IapError } from '../core/errors.ts'
import { defaultPeerCwd, ensureGlobalIapScaffold } from '../storage/index.ts'
import { readPeerProfile } from '../identity/index.ts'
import { initPeer, type InitPeerResult } from '../init/index.ts'

/** The default-runtime decision for `create` (FU5), factored out pure + testable.
 *  `--runtime` selects the DEFAULT, not the sole runtime; the model is `runtimes` =
 *  all installed agentic runtimes, `default_runtime` = the chosen one. */
export interface CreateRuntimePlan {
  /** True only when the default is AMBIGUOUS — more than one agentic runtime is
   *  installed and no `--runtime` was given. The caller prompts on a TTY; off a TTY
   *  it falls back to `fallbackDefault` with a loud note (never a silent claude). */
  ambiguous: boolean
  /** The resolved default when NOT ambiguous. `undefined` means "let initPeer
   *  resolve it" — exactly one installed → that one, none → its clear error. */
  resolvedDefault?: Runtime
  /** The deterministic default to use when ambiguous + non-interactive. */
  fallbackDefault?: Runtime
  /** The installed agentic runtimes — the prompt candidates and the basis for the
   *  secondary runtimes to wire (all of them except the chosen default). */
  installedAgentic: Runtime[]
}

/**
 * Decide create's default runtime + whether a prompt is needed, from the explicit
 * `--runtime` (if any) and the set of installed agentic runtimes. Pure: the caller
 * supplies `installedAgentic` (probed via isRuntimeInstalled) and performs the TTY
 * prompt; this only encodes the policy.
 */
export function planCreateRuntimes(explicit: Runtime | undefined, installedAgentic: Runtime[]): CreateRuntimePlan {
  if (explicit) return { ambiguous: false, resolvedDefault: explicit, installedAgentic }
  if (installedAgentic.length > 1) return { ambiguous: true, fallbackDefault: installedAgentic[0], installedAgentic }
  if (installedAgentic.length === 1) return { ambiguous: false, resolvedDefault: installedAgentic[0], installedAgentic }
  return { ambiguous: false, resolvedDefault: undefined, installedAgentic }
}

/** The other installed agentic runtimes to wire after creating on `chosen` (so the
 *  `runtimes` list is truthful). Empty when `chosen` is undefined/infra. */
export function secondaryRuntimes(chosen: Runtime | undefined, installedAgentic: Runtime[]): Runtime[] {
  if (!chosen) return []
  return installedAgentic.filter(rt => rt !== chosen)
}

export interface CreatePeerOptions {
  /** The peer's personality (REQUIRED; validated/normalized). Drives the default
   *  location (~/.iapeer/peers/<personality>) and the registry/profile identity. */
  personality: string
  /** Primary runtime (default: claude). claude/codex → agentic; telegram/notifier →
   *  infra (always-on plist + auto-bootstrap). */
  runtime?: Runtime
  /** Explicit location. Default: ~/.iapeer/peers/<personality> (IAPEER_ROOT-aware). */
  path?: string
  description?: string
  intelligence?: Intelligence
  /** Infra runtime launcher (abs path / PATH name) baked into the always-on plist. */
  runtimeBin?: string
  /** AUTO-bootstrap a freshly-provisioned infra plist (default true; infra only). */
  bootstrap?: boolean
  env?: NodeJS.ProcessEnv
  warn?: (message: string) => void
}

export interface CreatePeerResult extends InitPeerResult {
  /** The resolved peer cwd (default home or --path). */
  location: string
  /** True when this run created the folder (false when it already existed). */
  createdFolder: boolean
}

/**
 * Create a peer from anywhere: resolve a location, scaffold the folder (no-clobber),
 * then run init in it (identity + registry + per-runtime MCP / infra plist + doctrine,
 * with auto-bootstrap for infra). Returns the init result plus the resolved location.
 */
export async function createPeer(opts: CreatePeerOptions): Promise<CreatePeerResult> {
  const env = opts.env ?? process.env
  const personality = normalizeNameCandidate(opts.personality)
  if (!isValidName(personality)) {
    throw new IapError(
      `invalid personality "${opts.personality}" — must normalize to /^[a-z][a-z0-9-]{0,31}$/`,
    )
  }

  // Ensure the global tree (incl. ~/.iapeer/peers/) exists before landing a peer there.
  ensureGlobalIapScaffold({ env })

  const location = opts.path ? resolve(opts.path) : defaultPeerCwd(personality, { env })

  // NO-CLOBBER refusal: a target that already holds a DIFFERENT peer's profile.
  const existing = existsSync(location) ? readPeerProfile(location) : null
  if (existing && existing.personality !== personality) {
    throw new IapError(
      `refusing to create peer "${personality}" at ${location}: it already holds peer "${existing.personality}" ` +
        `(.iapeer/peer-profile.json) — choose another --path or personality`,
    )
  }

  const createdFolder = !existsSync(location)
  mkdirSync(location, { recursive: true }) // recursive mkdir never deletes existing content

  // create is cwd-INDEPENDENT with an EXPLICIT personality, so the ambient session's
  // identity must not govern it. When `iapeer create` is run from INSIDE a peer
  // session (an orchestrator agent provisioning another peer — a real flow), the
  // inherited PEER_PERSONALITY/PEER_IDENTITY/PEER_RUNTIME would trip the identity gate
  // (it refuses a mismatch). The explicit personality is authoritative here, so strip
  // those three ABI vars from the env passed down. (`init`, cwd-dependent, keeps the
  // gate — you init your OWN folder, the ambient identity SHOULD match.) IAPEER_ROOT
  // and the rest of the env are preserved.
  const childEnv: NodeJS.ProcessEnv = { ...env }
  delete childEnv.PEER_PERSONALITY
  delete childEnv.PEER_IDENTITY
  delete childEnv.PEER_RUNTIME

  const result = await initPeer({
    cwd: location,
    runtime: opts.runtime,
    personality,
    description: opts.description,
    intelligence: opts.intelligence,
    runtimeBin: opts.runtimeBin,
    bootstrap: opts.bootstrap,
    env: childEnv,
    warn: opts.warn,
  })

  return { ...result, location, createdFolder }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI — `iapeer create <personality> …` / `bun src/create/index.ts <personality> …`
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 2) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true
      else flags[a.slice(2)] = argv[++i]
    } else {
      positionals.push(a)
    }
  }
  const personality = positionals[0]
  if (!personality) {
    process.stderr.write(
      'usage: create <personality> [--runtime r] [--path dir] [--description d] [--bin abs] [--intelligence i] [--no-bootstrap]\n',
    )
    process.exit(2)
  }
  createPeer({
    personality,
    runtime: typeof flags.runtime === 'string' ? (flags.runtime as Runtime) : undefined,
    path: typeof flags.path === 'string' ? flags.path : undefined,
    description: typeof flags.description === 'string' ? flags.description : undefined,
    intelligence: typeof flags.intelligence === 'string' ? (flags.intelligence as Intelligence) : undefined,
    runtimeBin: typeof flags.bin === 'string' ? flags.bin : undefined,
    bootstrap: flags['no-bootstrap'] === true ? false : undefined,
    warn: m => process.stderr.write(`warn: ${m}\n`),
  })
    .then(r => {
      process.stdout.write(
        `created peer "${r.personality}" (${r.runtime}, ${r.intelligence}) at ${r.location}` +
          `${r.createdFolder ? ' (new folder)' : ' (existing folder)'}\n` +
          `  profile:  ${r.profilePath}\n` +
          `  registry: peers-profiles.json updated\n` +
          (r.mcpConfigPaths.length
            ? `  mcp:      ${r.mcpConfigPaths.join(', ')} → ${r.daemonUrl}\n`
            : r.codexMcpConfigPath
              ? `  mcp:      ${r.codexMcpConfigPath} (codex)\n`
              : '  mcp:      (none — infra/router runtime)\n') +
          (r.plistPath ? `  plist:    ${r.plistPath}\n` : '') +
          (r.selfConfig ? `  selfcfg:  ${r.selfConfig.state}${r.selfConfig.detail ? ` — ${r.selfConfig.detail}` : ''}\n` : '') +
          (r.bootstrapped ? `  bootstrap:${r.bootstrapped.state}${r.bootstrapped.detail ? ` — ${r.bootstrapped.detail}` : ''}\n` : '') +
          `  doctrine: ${r.doctrinePath}${r.doctrineCreated ? ' (template created — fill it in)' : ' (kept)'}\n`,
      )
      process.exit(0)
    })
    .catch(e => {
      process.stderr.write(`create failed: ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    })
}
