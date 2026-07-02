// Native runtime-memory levers (контракт «Слот памяти» §Native-память рантаймов
// при занятом слоте). The CORE canonizes the lever FORMS — runtime
// knowledge lives in the runtime layer, like deliveryMarkers/buildArgv:
//
//   claude: merge `"autoMemoryEnabled": false` into `<cwd>/.claude/settings.json`
//   codex:  merge `memories = false` into the `[features]` section of
//           `<cwd>/.codex/config.toml`
//
// Both files CARRY FOREIGN BLOCKS (plugin enables, statusline wrappers, …) —
// every write here is a NO-CLOBBER merge (parse/patch + atomic temp+rename),
// never a rewrite. Forms verified live on the fleet (12/12 + behavioral smoke;
// codex reads project-local config when the cwd is TRUSTED — see
// preTrustCodexCwd).
//
// `off` writes the explicit disable; `on` REMOVES the key (restores the
// runtime's own default rather than baking an explicit enable — the core has
// no opinion beyond "parallel store off while a memory provider owns the host").
//
// Consumers: the operator verb `iapeer native-memory <off|on>`, the provider's
// install-time sweep (calls the verb), and provisionPeer's birth-time hook
// (slot-gated, see provision/index.ts).

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { homedir } from 'os'
import type { Runtime } from '../core/constants.ts'
import { writeFileAtomic } from '../storage/index.ts'
import { assertTomlSafeKey } from './tomlKey.ts'

export type NativeMemoryState = 'off' | 'on'

export interface LeverOutcome {
  runtime: 'claude' | 'codex'
  path: string
  state: 'written' | 'already' | 'failed'
  detail?: string
}

// ─── claude: <cwd>/.claude/settings.json — JSON merge ───────────────────────

export function claudeSettingsPath(cwd: string): string {
  return join(cwd, '.claude', 'settings.json')
}

function applyClaudeLever(cwd: string, state: NativeMemoryState): LeverOutcome {
  const path = claudeSettingsPath(cwd)
  try {
    let obj: Record<string, unknown> = {}
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { runtime: 'claude', path, state: 'failed', detail: 'settings.json is not a JSON object — refusing to clobber' }
      }
      obj = raw as Record<string, unknown>
    }
    if (state === 'off') {
      if (obj.autoMemoryEnabled === false) return { runtime: 'claude', path, state: 'already' }
      obj.autoMemoryEnabled = false
    } else {
      if (!('autoMemoryEnabled' in obj)) return { runtime: 'claude', path, state: 'already' }
      delete obj.autoMemoryEnabled // restore the runtime's own default
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileAtomic(path, `${JSON.stringify(obj, null, 2)}\n`)
    return { runtime: 'claude', path, state: 'written' }
  } catch (e) {
    return { runtime: 'claude', path, state: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}

// ─── codex: <cwd>/.codex/config.toml — section-scoped line merge ─────────────

export function codexProjectConfigPath(cwd: string): string {
  return join(cwd, '.codex', 'config.toml')
}

/** Locate the `[features]` section bounds: [startLine, endLine) of its BODY
 *  (after the header, up to the next `[…]` header or EOF). null = no section. */
function featuresBounds(lines: string[]): { header: number; start: number; end: number } | null {
  const header = lines.findIndex(l => l.trim() === '[features]')
  if (header < 0) return null
  let end = lines.length
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i
      break
    }
  }
  return { header, start: header + 1, end }
}

function applyCodexLever(cwd: string, state: NativeMemoryState): LeverOutcome {
  const path = codexProjectConfigPath(cwd)
  try {
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const lines = text.length ? text.split('\n') : []
    const bounds = featuresBounds(lines)
    const memRe = /^\s*memories\s*=/
    if (state === 'off') {
      if (bounds) {
        const idx = lines.slice(bounds.start, bounds.end).findIndex(l => memRe.test(l))
        if (idx >= 0) {
          const abs = bounds.start + idx
          if (/^\s*memories\s*=\s*false\s*$/.test(lines[abs]!)) return { runtime: 'codex', path, state: 'already' }
          lines[abs] = 'memories = false'
        } else {
          lines.splice(bounds.start, 0, 'memories = false')
        }
      } else {
        if (lines.length && lines[lines.length - 1]!.trim() !== '') lines.push('')
        lines.push('[features]', 'memories = false')
      }
    } else {
      if (!bounds) return { runtime: 'codex', path, state: 'already' }
      const idx = lines.slice(bounds.start, bounds.end).findIndex(l => memRe.test(l))
      if (idx < 0) return { runtime: 'codex', path, state: 'already' }
      lines.splice(bounds.start + idx, 1) // restore the runtime's own default
    }
    mkdirSync(dirname(path), { recursive: true })
    const outText = lines.join('\n')
    writeFileAtomic(path, outText.endsWith('\n') ? outText : `${outText}\n`)
    return { runtime: 'codex', path, state: 'written' }
  } catch (e) {
    return { runtime: 'codex', path, state: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}

// ─── codex trust (birth-time only) ───────────────────────────────────────────

/** The codex GLOBAL config (`~/.codex/config.toml`) — where trust lives as
 *  `[projects."<path>"] trust_level = "trusted"` blocks. Honors $CODEX_HOME
 *  first, SAME as init's codexConfigPath — the two writers of this shared prod
 *  file must respect one override set, or a sandbox isolating one path still
 *  leaks through the other (live defect: an IAPEER_ROOT sandbox pre-trusted a
 *  throwaway cwd into the PROD config). */
export function codexGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = env.CODEX_HOME?.trim()
  if (codexHome) return join(codexHome, 'config.toml')
  const home = env.HOME?.trim() || homedir()
  return join(home, '.codex', 'config.toml')
}

/**
 * Pre-trust a NEWBORN codex peer's cwd by appending its `[projects."<cwd>"]`
 * block to the codex global config (no-clobber: only when no block for this
 * path exists). Closes the contract requirement «рычаг действует с ПЕРВОЙ
 * сессии» DETERMINISTICALLY: codex reads project-local config only for a
 * trusted cwd, and without pre-trust the first session's trust is granted
 * mid-boot by the adapter's dialog auto-accept — whether the project config is
 * (re)read after that grant within the same run is codex-internal. Birth-time
 * only — existing peers are already trusted through their boot history.
 */
export function preTrustCodexCwd(cwd: string, env: NodeJS.ProcessEnv = process.env): LeverOutcome {
  const path = codexGlobalConfigPath(env)
  try {
    // Codex keys trust on the RESOLVED real path (live fact: the /tmp →
    // /private/tmp symlink made a literal-path entry MISS and left the lever
    // inert — trust entries written by codex itself are all /private/tmp/...).
    let real = cwd
    try {
      real = realpathSync(cwd)
    } catch {
      /* cwd not on disk yet → keep as given */
    }
    // В42 — the cwd becomes a QUOTED TOML key `[projects."<real>"]`. An operator-supplied
    // `create --path` cwd carrying `"`/`\` (legal on APFS) would corrupt the SHARED global
    // config and break codex for every peer on the host. Refuse (the try/catch reports it
    // as a 'failed' lever); same guard the sibling hooks-trust writer uses.
    assertTomlSafeKey(real)
    const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (text.includes(`[projects."${real}"]`)) return { runtime: 'codex', path, state: 'already' }
    const block = `${text.length && !text.endsWith('\n') ? '\n' : ''}${text.trim().length ? '\n' : ''}[projects."${real}"]\ntrust_level = "trusted"\n`
    mkdirSync(dirname(path), { recursive: true })
    writeFileAtomic(path, text + block)
    return { runtime: 'codex', path, state: 'written' }
  } catch (e) {
    return { runtime: 'codex', path, state: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Resolve `p` to its real path even when the leaf (or several trailing components) no
 * longer exists: realpath the nearest EXISTING ancestor and re-append the missing tail.
 * Returns null only if nothing on the chain up to the root exists (impossible for `/`).
 * Used by removeCodexCwdTrust to reconstruct the realpath-form key of an already-deleted
 * cwd so a stale trust entry written under a symlink-resolved path is still matched.
 */
function realpathViaExistingAncestor(p: string): string | null {
  let cur = resolve(p)
  const tail: string[] = []
  // Guard against an unbounded loop: dirname('/') === '/'.
  for (let depth = 0; depth < 4096; depth++) {
    try {
      return tail.length ? join(realpathSync(cur), ...tail.slice().reverse()) : realpathSync(cur)
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return null // reached the root and even it did not resolve
      tail.push(basename(cur))
      cur = parent
    }
  }
  return null
}

/**
 * Remove a peer's pre-trust entry from the codex GLOBAL config — the reap-side
 * counterpart of preTrustCodexCwd (backlog «remove не чистит pre-trust», made
 * live by a defect: every sandboxed/throwaway codex birth left a stale
 * `[projects."<cwd>"]` block in the PROD config forever). Removes the
 * section for BOTH the resolved and the literal path form (the writer stores
 * realpath, but a since-deleted cwd cannot be resolved anymore — match either),
 * strictly section-scoped: from the `[projects."<p>"]` header up to the next
 * `[` header, other sections untouched. Idempotent: no entry → 'already'.
 */
export function removeCodexCwdTrust(cwd: string, env: NodeJS.ProcessEnv = process.env): LeverOutcome {
  const path = codexGlobalConfigPath(env)
  try {
    if (!existsSync(path)) return { runtime: 'codex', path, state: 'already' }
    let real = cwd
    try {
      real = realpathSync(cwd)
    } catch {
      /* cwd already deleted → only the literal form can match */
    }
    // В43 — the writer keyed the entry on the RESOLVED real path. When the cwd is already
    // DELETED (the throwaway-sandbox reap case), realpathSync(cwd) above throws and `real`
    // falls back to the LITERAL cwd — which MISSES if any path component was a symlink
    // (e.g. codex stored /private/tmp/… for a /tmp/… cwd). Reconstruct the resolved form
    // from the nearest still-existing ANCESTOR + the deleted remainder, so the stale entry
    // is found and removed instead of lingering as a phantom trust for that path.
    const viaAncestor = realpathViaExistingAncestor(cwd)
    const candidates = new Set([real, cwd, ...(viaAncestor ? [viaAncestor] : [])])
    const lines = readFileSync(path, 'utf8').split('\n')
    const kept: string[] = []
    let inDoomed = false
    let removed = false
    for (const line of lines) {
      const header = line.match(/^\s*\[projects\."(.+)"\]\s*$/)
      if (header) {
        inDoomed = candidates.has(header[1]!)
        if (inDoomed) {
          removed = true
          continue
        }
      } else if (inDoomed && /^\s*\[/.test(line)) {
        inDoomed = false // next section starts — stop dropping
      }
      if (!inDoomed) kept.push(line)
    }
    if (!removed) return { runtime: 'codex', path, state: 'already' }
    writeFileAtomic(path, kept.join('\n').replace(/\n{3,}/g, '\n\n'))
    return { runtime: 'codex', path, state: 'written' }
  } catch (e) {
    return { runtime: 'codex', path, state: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}

// ─── public entry ────────────────────────────────────────────────────────────

/**
 * Apply the native-memory lever for one peer cwd across its declared runtimes
 * (∩ {claude, codex} — other runtimes carry no native memory). Idempotent;
 * every outcome is reported (a 'failed' lever never throws).
 */
export function applyNativeMemory(
  cwd: string,
  runtimes: readonly Runtime[],
  state: NativeMemoryState,
): LeverOutcome[] {
  const out: LeverOutcome[] = []
  if (runtimes.includes('claude')) out.push(applyClaudeLever(cwd, state))
  if (runtimes.includes('codex')) out.push(applyCodexLever(cwd, state))
  return out
}
