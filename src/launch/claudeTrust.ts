// claudeTrust — pre-seed Claude Code workspace trust for every directory a claude peer is launched with.
//
// Claude Code asks an interactive "trust this folder" question for the session cwd AND for every
// `--add-dir` it was given (2.1.326+: "This session hasn't worked here before…" / "Yes, add it"). A
// headless peer has no human to answer, so an unseeded directory parks the boot on a modal (incident
// 2026-11-17: the self-updated 2.1.326 hung mentor/boris/coach/darwin on `--add-dir /`).
//
// Verified live against 2.1.326 on an isolated CLAUDE_CONFIG_DIR:
//   - trust is `projects[<path>].hasTrustDialogAccepted === true` in the global config
//     (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`);
//   - the `--add-dir` dialog's "Yes" is NOT persisted ("Your answer holds for this session"), so without a
//     seed it reappears on EVERY launch;
//   - trust inherits to descendants, but NOT across a git-repository boundary: `/` alone covers a plain
//     cwd, yet a cwd inside a repo still asks — so the cwd itself is seeded too.
//
// Write discipline: the file is shared with every live claude process, so it is rewritten ONLY when a key
// is actually missing (steady state = read-only), via atomic rename, keeping every other field and the
// file mode; an unparsable file is never touched (fail-open: the boot-driver's dialog auto-answer is the
// backstop).

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export interface ClaudeTrustOutcome {
  path: string
  state: 'already' | 'written' | 'skipped' | 'failed'
  added?: string[]
  detail?: string
}

/** Global claude config file — the same resolution claude applies: $CLAUDE_CONFIG_DIR wins, else $HOME. */
export function claudeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  if (dir) return join(dir, '.claude.json')
  return join(env.HOME?.trim() || homedir(), '.claude.json')
}

/** Directories claude will ask about for this argv: the cwd plus every `--add-dir` value. */
export function claudeTrustDirs(argv: readonly string[], cwd: string): string[] {
  const dirs = [cwd]
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--add-dir') {
      // `--add-dir` is variadic in claude; consume values until the next flag.
      for (let j = i + 1; j < argv.length && !argv[j]!.startsWith('-'); j++) dirs.push(argv[j]!)
    } else if (a.startsWith('--add-dir=')) dirs.push(a.slice('--add-dir='.length))
  }
  return dirs
}

/** Both spellings of a directory: the resolved literal and its realpath (/tmp → /private/tmp). */
function trustKeys(dir: string, cwd: string): string[] {
  const abs = resolve(cwd, dir)
  const keys = [abs]
  try {
    const real = realpathSync(abs)
    if (real !== abs) keys.push(real)
  } catch { /* not on disk yet — the literal key is all we have */ }
  return keys
}

export function ensureClaudeTrust(dirs: readonly string[], cwd: string, env: NodeJS.ProcessEnv, guardEnv: NodeJS.ProcessEnv = env): ClaudeTrustOutcome {
  const path = claudeGlobalConfigPath(env)
  // Test isolation: a sandboxed run must never mutate the real host config.
  if ((guardEnv.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1') && path === join(homedir(), '.claude.json')) {
    return { path, state: 'skipped', detail: 'IAPEER_TEST_SANDBOX without CLAUDE_CONFIG_DIR/HOME override' }
  }
  try {
    const keys = [...new Set(dirs.flatMap(d => trustKeys(d, cwd)))]
    const exists = existsSync(path)
    const text = exists ? readFileSync(path, 'utf8') : ''
    let config: Record<string, unknown>
    if (text.trim()) {
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config is not a JSON object')
      config = parsed as Record<string, unknown>
    } else config = {}
    const projects = (config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects)
      ? config.projects : {}) as Record<string, Record<string, unknown> | undefined>
    const added = keys.filter(k => projects[k]?.hasTrustDialogAccepted !== true)
    if (!added.length) return { path, state: 'already' }
    for (const k of added) {
      const prev = projects[k]
      projects[k] = { ...(prev && typeof prev === 'object' ? prev : {}), hasTrustDialogAccepted: true }
    }
    config.projects = projects
    const mode = exists ? statSync(path).mode & 0o777 : 0o600
    mkdirSync(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.claude.json.iapeer-${process.pid}-${Date.now()}.tmp`)
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode })
    renameSync(tmp, path)
    return { path, state: 'written', added }
  } catch (e) {
    return { path, state: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}
