// Private, personality-scoped OpenCode configuration. This module is preparatory:
// declaring a runtime as supported is gated on the complete adapter, not this file.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isValidName } from '../core/constants.ts'
import { opencodePrivateDir, writeFileAtomic, type StorageOptions } from '../storage/index.ts'
import pluginSource from './iapeer-plugin.mjs' with { type: 'text' }
import { listCapabilities } from '../capability/index.ts'

export const OPENCODE_AGENT = 'iapeer'
/** The memory provider's private fragment stem (docs/20 §Memory-provider ABI). */
export const OPENCODE_MEMORY_FRAGMENT = 'iapeer-memory'
type JsonObject = Record<string, unknown>

export function opencodePaths(personality: string, options: StorageOptions = {}) {
  if (!isValidName(personality)) throw new Error(`invalid OpenCode personality: ${personality}`)
  const dir = opencodePrivateDir(personality, options)
  return {
    dir,
    plugin: join(dir, 'iapeer-plugin.mjs'),
    state: join(dir, 'state.json'),
    events: join(dir, 'events.jsonl'),
    config: join(dir, 'opencode.json'), // optional operator-owned provider/model config
  }
}

function object(value: unknown, source: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${source}: expected a JSON object`)
  return value as JsonObject
}

/** OpenCode-like object merge; plugin arrays are additive, with stable dedup. */
export function mergeOpencodeConfig(base: JsonObject, extra: JsonObject): JsonObject {
  const out = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    if (key === 'plugin' && Array.isArray(value)) {
      const all = [...(Array.isArray(out[key]) ? out[key] as unknown[] : []), ...value]
      out[key] = all.filter((v, i) => all.findIndex(x => JSON.stringify(x) === JSON.stringify(v)) === i)
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const prior = out[key]
      out[key] = mergeOpencodeConfig(prior && typeof prior === 'object' && !Array.isArray(prior) ? prior as JsonObject : {}, value as JsonObject)
    } else out[key] = value
  }
  return out
}

export function readOpencodeExtension(path: string): JsonObject {
  const fragment = object(JSON.parse(readFileSync(path, 'utf8')), path)
  for (const key of Object.keys(fragment)) {
    if (key !== 'mcp' && key !== 'plugin') throw new Error(`${path}: unsupported extension field ${key}`)
  }
  if (fragment.mcp !== undefined) {
    const mcp = object(fragment.mcp, `${path}: mcp`)
    if ('iapeer' in mcp) throw new Error(`${path}: extension cannot replace core IAP MCP`)
    for (const [name, config] of Object.entries(mcp)) object(config, `${path}: mcp.${name}`)
  }
  if (fragment.plugin !== undefined && (!Array.isArray(fragment.plugin) || fragment.plugin.some(p => typeof p !== 'string' || !p.startsWith('file:///')))) {
    throw new Error(`${path}: plugins must be absolute file URLs`)
  }
  return fragment
}

/** Is the peer's provider explicit (`model` = `<provider>/<model>`)? */
export function hasExplicitModel(config: JsonObject): boolean {
  return typeof config.model === 'string' && /^[^/\s]+\/\S+$/.test(config.model)
}

/**
 * Provider pinning (docs/20 §Provider pinning, OC04). Without an explicit model OpenCode falls back to
 * its own hosted default (`opencode/big-pickle`) and the whole composed doctrine goes there. Owner
 * policy (18.10): allowed, but NEVER silently — an implicit provider passes through unchanged and the
 * launch records a warning (see the adapter) while the actual model is reported in the fleet snapshot.
 * An EXPLICIT model is pinned: `small_model` defaults to `model` (titles never drift to another
 * provider) and `enabled_providers` is exactly those providers; an explicit list that excludes them
 * is a misconfiguration and refuses loudly.
 */
export function pinProvider(config: JsonObject, configPath: string): JsonObject {
  const hint =
    `configure the peer's provider in ${configPath} (or OPENCODE_CONFIG_CONTENT in the peer's launch.env): ` +
    `"model": "<provider>/<model>" plus that provider's "provider" block; see docs/20 §Provider pinning`
  const providerOf = (v: unknown, field: string): string => {
    if (typeof v !== 'string' || !/^[^/\s]+\/\S+$/.test(v)) {
      throw new Error(`opencode: no explicit ${field} — refusing to launch on OpenCode's implicit default provider. ${hint}`)
    }
    return v.slice(0, v.indexOf('/'))
  }
  if (!hasExplicitModel(config)) return config
  const model = providerOf(config.model, 'model')
  const smallModel = config.small_model === undefined ? config.model : config.small_model
  const small = providerOf(smallModel, 'small_model')
  const needed = [...new Set([model, small])]
  let enabled = config.enabled_providers
  if (enabled === undefined) enabled = needed
  else if (!Array.isArray(enabled) || !needed.every(p => (enabled as unknown[]).includes(p))) {
    throw new Error(`opencode: enabled_providers ${JSON.stringify(enabled)} must include ${JSON.stringify(needed)} (the model providers). ${hint}`)
  }
  return { ...config, small_model: smallModel, enabled_providers: enabled }
}

export interface ComposeOpencodeConfigInput {
  personality: string
  doctrine: string
  daemonUrl: string
  /** Existing OPENCODE_CONFIG_CONTENT. It is merged, never discarded. */
  inline?: string
  /** docs/17. gated → the iapeer agent ASKS before exec/mutation/web (bash, edit, webfetch), and the
   *  plugin bridges each native ask to the human broker. yolo (default) adds nothing (`--auto`). */
  approvalMode?: 'yolo' | 'gated'
}

/** Gated ask rules — the claude/codex «ask before acting» set mapped onto OpenCode permissions.
 *  Agent-level, so an operator's top-level `permission: {"*":"allow"}` cannot silently undo it. Reads,
 *  search and the core MCP stay allowed (as on gated claude). */
export const OPENCODE_GATED_PERMISSION = { bash: 'ask', edit: 'ask', webfetch: 'ask', external_directory: 'ask', doom_loop: 'ask' } as const

/** No writes and no env resolution except through injected StorageOptions. */
export function composeOpencodeConfig(input: ComposeOpencodeConfigInput, options: StorageOptions = {}): JsonObject {
  if (!input.doctrine.trim()) throw new Error('OpenCode requires a non-empty composed system prompt')
  const paths = opencodePaths(input.personality, options)
  let result: JsonObject = existsSync(paths.config) ? object(JSON.parse(readFileSync(paths.config, 'utf8')), paths.config) : {}
  if (input.inline !== undefined) result = mergeOpencodeConfig(result, object(JSON.parse(input.inline), 'OPENCODE_CONFIG_CONTENT'))
  // Fragment owners: the memory provider + every REGISTERED capability (docs/21) — never a
  // hardcoded plugin list. An unregistered plugin's leftover fragment is not merged.
  const stems = [OPENCODE_MEMORY_FRAGMENT, ...listCapabilities(options).declarations.map(d => d.capability)]
  for (const stem of stems) {
    const path = join(paths.dir, `${stem}.json`)
    if (existsSync(path)) result = mergeOpencodeConfig(result, readOpencodeExtension(path))
  }
  result = pinProvider(result, paths.config)
  // Last writer for required fields; foreign MCP servers, agents, plugins and
  // provider settings survive. Effective managed overrides still need a live gate.
  return mergeOpencodeConfig(result, {
    autoupdate: false,
    share: 'disabled',
    default_agent: OPENCODE_AGENT,
    agent: {
      [OPENCODE_AGENT]: {
        mode: 'primary',
        prompt: input.doctrine,
        ...(input.approvalMode === 'gated' ? { permission: { ...OPENCODE_GATED_PERMISSION } } : {}),
      },
    },
    mcp: { iapeer: { type: 'remote', url: input.daemonUrl, enabled: true, oauth: false, headers: { 'X-IAPeer-Identity': '{env:PEER_IDENTITY}' } } },
    plugin: [pathToFileURL(paths.plugin).href],
  })
}

/** Installer/launcher must pass only trusted core source. Provider secrets stay in
 * native env/config, never interpolated into this executable source artifact. */
export function writeOpencodePlugin(personality: string, source: string, options: StorageOptions = {}): string {
  const paths = opencodePaths(personality, options)
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  writeFileAtomic(paths.plugin, source, 0o600)
  return paths.plugin
}

/** The core-owned plugin source shipped with this package (embedded in the compiled binary). */
export const OPENCODE_PLUGIN_SOURCE: string = pluginSource
