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

export interface ComposeOpencodeConfigInput {
  personality: string
  doctrine: string
  daemonUrl: string
  /** Existing OPENCODE_CONFIG_CONTENT. It is merged, never discarded. */
  inline?: string
}

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
  // Last writer for required fields; foreign MCP servers, agents, plugins and
  // provider settings survive. Effective managed overrides still need a live gate.
  return mergeOpencodeConfig(result, {
    autoupdate: false,
    share: 'disabled',
    default_agent: OPENCODE_AGENT,
    agent: { [OPENCODE_AGENT]: { mode: 'primary', prompt: input.doctrine } },
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
