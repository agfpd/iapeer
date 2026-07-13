// Canonical constants for the iapeer foundation.
// Consolidated from inter-agent-protocol/src/lib/constants.ts (wins as-is) and
// extended with storage-layer path names (blueprint §1 core/constants).

import { join } from 'path'

export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
export const NAME_RE_SOURCE = '^[a-z][a-z0-9-]{0,31}$'
export const RUNTIME_RE = /^[a-z][a-z0-9]{0,31}$/
export const RUNTIME_RE_SOURCE = '^[a-z][a-z0-9]{0,31}$'

export type Runtime = string
export type TmuxRuntime = Runtime
export const SUPPORTED_LOCAL_RUNTIMES = ['claude', 'codex'] as const
export type SupportedLocalRuntime = (typeof SUPPORTED_LOCAL_RUNTIMES)[number]

export const PEERS_SCHEMA_VERSION = 2
// 450 (was 250): self-documenting API-peer descriptions (notifier timer/watcher)
// must fit "who the peer is + registration format + a live example" — dense full
// texts run to ~408 chars; 250 cut them mid-word so the caller could not compose
// the call. NB: this is COMPILE-TIME
// baked — the live daemon re-clamps descriptions on read (registry parsePeerRecord),
// so the running router keeps the OLD limit until restarted onto the new binary.
export const MAX_DESCRIPTION_LEN = 450

// Contract vocabulary (docs/Идентичность): the nature of the
// intelligence expressing itself through a runtime.
//   artificial — AI agent · natural — human · absent — programmatic source
export const INTELLIGENCE_VALUES = ['artificial', 'natural', 'absent'] as const
export type Intelligence = (typeof INTELLIGENCE_VALUES)[number]

export function isIntelligence(value: unknown): value is Intelligence {
  return typeof value === 'string' && (INTELLIGENCE_VALUES as readonly string[]).includes(value)
}

// READ-COMPAT: the live registry/profiles still carry the previous vocabulary
// (human/scripted) until the coordinated live-fleet migration. The foundation
// MUST read that data correctly — map legacy → contract on READ only. It does
// NOT rewrite the live fleet (that migration is a separate, coordinated step;
// it touches the live telegram human-guard which keys on 'human').
//   human → natural · scripted → absent
const LEGACY_INTELLIGENCE: Readonly<Record<string, Intelligence>> = {
  human: 'natural',
  scripted: 'absent',
}

/**
 * Read-compat normalizer for an intelligence value coming off disk / the wire.
 * Returns the contract value (passing through artificial/natural/absent and
 * mapping legacy human→natural / scripted→absent), or undefined when the value
 * is unrecognised (caller decides whether to throw or fall back to a default).
 */
export function normalizeIntelligenceValue(value: unknown): Intelligence | undefined {
  if (typeof value !== 'string') return undefined
  if (isIntelligence(value)) return value
  return LEGACY_INTELLIGENCE[value]
}

const NATURAL_RUNTIMES = new Set(['telegram', 'discord', 'matrix', 'email', 'web', 'voicetalk'])
const ABSENT_RUNTIMES = new Set(['notifier', 'webhook', 'api', 'cron'])

export function defaultIntelligenceForRuntime(runtime: string): Intelligence {
  if (NATURAL_RUNTIMES.has(runtime)) return 'natural'
  if (ABSENT_RUNTIMES.has(runtime)) return 'absent'
  return 'artificial'
}

/**
 * The intelligences a runtime may LEGITIMATELY carry (the single Ф0 source; provision
 * validates against it, the launch gate enforces it). Identity (natural/absent/artificial)
 * is ORTHOGONAL to the channel: a human-channel runtime can carry a HUMAN (natural) OR a
 * FACELESS SERVICE bot (absent) — e.g. a Telegram approval-card bot — but never an LLM agent
 * (artificial) on that channel. A service-only runtime carries services (absent). An agentic
 * runtime carries an LLM (artificial). The DEFAULT (defaultIntelligenceForRuntime) stays the
 * first of each set, so an existing peer with no explicit nature is unchanged — `absent` on a
 * channel runtime is strictly OPT-IN (an explicit `--intelligence absent` / manifest decl).
 */
export function allowedIntelligencesForRuntime(runtime: string): readonly Intelligence[] {
  if (NATURAL_RUNTIMES.has(runtime)) return ['natural', 'absent']
  if (ABSENT_RUNTIMES.has(runtime)) return ['absent']
  return ['artificial']
}

/** Is `intelligence` a legitimate nature for `runtime`? (provision fail-loud + launch gate.) */
export function isIntelligenceAllowedForRuntime(runtime: string, intelligence: Intelligence): boolean {
  return allowedIntelligencesForRuntime(runtime).includes(intelligence)
}

// Infra runtimes are ALWAYS-ON (held live by launchd KeepAlive), as opposed to the
// warm-on-demand agentic runtimes (claude/codex, woken by the daemon). Liveness is
// a property of the RUNTIME, not the personality (zone Идентичность). Infra runtimes
// are routers hosted by the pty supervisor: telegram/voicetalk carry a human channel
// (inbound messages / voice), notifier receives send_to_peer(timer|watcher, …)
// registration/live-reload — outbound to each is deliverHosted → the child's stdin.
// This set gates always-on launchd plist generation (src/launch/launchd.ts).
const INFRA_RUNTIMES = new Set(['notifier', 'telegram', 'voicetalk'])

export function isInfraRuntime(runtime: string): boolean {
  return INFRA_RUNTIMES.has(runtime)
}

// Each INFRA runtime's always-on plist PINS its launcher binary to an ABSOLUTE
// path via a runtime-specific env var. launchd gives a job a MINIMAL PATH (no
// ~/.local/bin, ~/.bun/bin, /opt/homebrew/bin), so a bare `notifier-runtime`
// would not resolve and the always-on session would crash-loop. The plist baker
// (launchd.installAlwaysOnPlist) resolves the bin against the rich provisioning
// PATH and writes the abs path here; launchdRun reads it back into
// LaunchConfig.{notifierBin,telegramBin} → adapter.buildArgv. SINGLE source for
// both the baker and the reader so they cannot drift on the var name.
export const INFRA_RUNTIME_BIN_ENV: Readonly<Record<string, string>> = {
  notifier: 'NOTIFIER_RUNTIME_BIN',
  telegram: 'TELEGRAM_RUNTIME_BIN',
  voicetalk: 'VOICETALK_RUNTIME_BIN',
}

/** The PATH-resolvable default launcher name per infra runtime (when no abs path
 *  is pinned). Mirrors the adapter buildArgv fallbacks (`notifier-runtime` /
 *  `telegram-runtime`). */
export const INFRA_RUNTIME_DEFAULT_BIN: Readonly<Record<string, string>> = {
  notifier: 'notifier-runtime',
  telegram: 'telegram-runtime',
  voicetalk: 'voicetalk-runtime',
}

// codex MCP token-free import (contract Установка §codex MCP). codex REFUSES to import
// tools from an OPEN streamable-HTTP MCP server — it marks it authStatus=unsupported
// (and blocks on startup) unless an auth scheme is configured (codex bug #21532). The
// fix is a NON-SECRET fixed bearer: setting `bearer_token_env_var` flips authStatus to
// `bearer_token` purely from the config FACT (codex does not require the server to
// validate the token). The daemon stays OPEN — it ignores `Authorization` and resolves
// the caller from the X-IAPeer-Identity header (loopback same-uid + per-peer identity
// is the auth, the same as the claude side). So a codex peer's launch sets this env var
// to the public stub below; nothing real is gated. Proven live (codex 0.136, gpt-5.5).
/** The env var codex reads the bearer from (config `bearer_token_env_var`); the launch
 *  sets it for a codex peer. */
export const CODEX_BEARER_ENV_VAR = 'IAPEER_BEARER'
/** The fixed, PUBLIC, non-secret bearer value codex sends to satisfy its own auth gate.
 *  Deliberately not a secret — the daemon never validates it (it is open on loopback). */
export const CODEX_DUMMY_BEARER = 'iapeer-localhost-open-no-secret'

export const MAX_MESSAGE_LEN = 16_000
export const MAX_TOPIC_LEN = 200
export const MAX_ATTACHMENTS = 20
export const DEFAULT_SOCK_DIR = '/tmp'

// The directory holding tmux iap-sockets. Canonically /tmp (contract sock convention
// `/tmp/tmux-iap-<identity>.sock`); IAPEER_SOCK_DIR overrides it host-wide, exactly
// like IAPEER_ROOT overrides the storage root. EVERY socket-touching site (transport
// scan/resolve, lifecycle, launchdRun) MUST resolve through this ONE helper so they
// agree — a site that hardcodes DEFAULT_SOCK_DIR would look in /tmp while a sandbox
// (IAPEER_SOCK_DIR set) created the session elsewhere → a false "offline".
//
// IAPEER_ROOT IMPLIES SOCKET ISOLATION: an alt-root used
// to inherit the GLOBAL /tmp, so a sandboxed `list` saw PROD sessions live by name
// collision, and a sandboxed stop/start would have HIT a prod session. A set root
// now derives `<root>/socks` unless IAPEER_SOCK_DIR explicitly says otherwise; the
// prod daemon (no IAPEER_ROOT) keeps the canonical /tmp untouched.
export function resolveSockDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.IAPEER_SOCK_DIR?.trim()
  if (explicit) return explicit
  const root = env.IAPEER_ROOT?.trim()
  if (root) return join(root, 'socks')
  return DEFAULT_SOCK_DIR
}

// === per-peer cwd scope ===
export const IAPEER_DIR = '.iapeer'
export const PEER_PROFILE_FILE = 'peer-profile.json'
// Doctrine-fragments layer (Канал A, слой 5): a primitive-owned `.iapeer/fragments/`
// subdir under BOTH the global root (`~/.iapeer/fragments/`, host-wide) and the
// per-peer cwd (`<cwd>/.iapeer/fragments/`, per-peer). Holds machine-regenerated
// `*.md` fragments that an ecosystem primitive writes + rotates itself (e.g.
// iapeer-memory's guide + per-peer note index) — merged into the system prompt so
// the context survives compaction, yet kept OUT of the hand-authored IAPEER.md
// doctrine (two writers, mutual-rollback). See composeSystemPrompt Layer 5.
export const FRAGMENTS_DIR = 'fragments'

// === global scope ~/.iapeer/ ===
export const IAP_PLUGIN_DIR = 'iap'
export const PEERS_PROFILES_FILE = 'peers-profiles.json'
export const PEERS_PROFILES_LOCK_FILE = 'peers-profiles.lock'

// Storage category roots (blueprint §1 storage). One env override: IAPEER_ROOT.
export const IAPEER_ROOT_ENV = 'IAPEER_ROOT'
export const STATE_DIR = 'state'
export const LOGS_DIR = 'logs'
export const CACHE_DIR = 'cache'
export const PLUGINS_DIR = 'plugins'
export const RUNTIMES_DIR = 'runtimes'
// The default home for foundation-provisioned peer cwds (`iapeer create` lands a peer
// here when --path is not given): ~/.iapeer/peers/<personality>. Foundation-owned and
// collision-free — unlike the organic ~/Peers/ the legacy fleet grew in (NOT the
// default; existing ~/Peers/* peers are grandfathered, the registry holds any cwd).
export const PEERS_HOME_DIR = 'peers'

// launchd labels (future lifecycle/daemon phases; named here so storage/cli agree).
export const LAUNCHD_LABEL_PREFIX = 'com.iapeer.'
export const DAEMON_PLIST_LABEL = 'com.agfpd.iapeer'

// Shortened 0.4.86 (envelope-compaction F): the long preamble duplicated doctrine
// (origin-routing) for live sessions; the reply-routing cue is the load-bearing part.
export const IAP_INSTRUCTION = 'Reply via send_to_peer.'

export const ALWAYS_LOAD_META = {
  'anthropic/alwaysLoad': true,
} as const

export function isRuntime(value: unknown): value is Runtime {
  return typeof value === 'string' && RUNTIME_RE.test(value)
}

export function isTmuxRuntime(value: unknown): value is TmuxRuntime {
  return isRuntime(value)
}

export function isSupportedLocalRuntime(value: unknown): value is SupportedLocalRuntime {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LOCAL_RUNTIMES as readonly string[]).includes(value)
  )
}

export function isValidName(value: unknown): boolean {
  return typeof value === 'string' && NAME_RE.test(value)
}

// The name normalizer (normalize(s) = slug(transliterate(s))) lives in its own
// module so the transliteration engine is swappable behind one interface; it is
// re-exported here so existing `from '../core/constants.ts'` importers are unchanged.
export { normalizeNameCandidate } from './normalize.ts'
