// Keep npm OFF the OpenCode wake path (docs/20 §Native findings). Before loading any external
// plugin, native OpenCode (1.19.3 core/src/npm.ts Npm.install) reifies `@opencode-ai/plugin` in
// EVERY config directory it scans, unless that directory already has `node_modules` AND the name
// is in the root of its `package-lock.json` (the version is not re-checked once locked). A cold
// directory therefore costs one npm https round-trip at startup — observed 60 s and >4 min stalls.
// The core satisfies that exact no-op condition at runtime-attach time (an operator verb), so a
// wake never waits on the network.
//
// Directories (native ConfigPaths.directories): the global config dir ($OPENCODE_CONFIG_DIR, else
// $XDG_CONFIG_HOME/opencode, else ~/.config/opencode), every existing `.opencode` from the peer cwd
// upwards, and ~/.opencode (where the official installer puts the binary). Non-writable dirs are
// skipped natively and here.
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const OPENCODE_PLUGIN_PACKAGE = '@opencode-ai/plugin'

export function opencodeConfigDirs(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME?.trim() || homedir()
  const globalDir = env.OPENCODE_CONFIG_DIR?.trim() || join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'opencode')
  const dirs = [globalDir]
  let dir = resolve(cwd)
  while (true) {
    const candidate = join(dir, '.opencode')
    if (existsSync(candidate)) dirs.push(candidate)
    const parent = dirname(dir)
    if (parent === dir || dir === home) break
    dir = parent
  }
  const homeDir = join(home, '.opencode')
  if (existsSync(homeDir)) dirs.push(homeDir)
  return [...new Set(dirs)]
}

/** The exact native no-op condition for one directory. */
export function pluginDependencySatisfied(dir: string): boolean {
  if (!existsSync(join(dir, 'node_modules'))) return false
  try {
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')) as { packages?: Record<string, Record<string, Record<string, string>>> }
    const root = lock.packages?.[''] ?? {}
    return [root.dependencies, root.devDependencies, root.peerDependencies, root.optionalDependencies].some(d => d && OPENCODE_PLUGIN_PACKAGE in d)
  } catch {
    return false
  }
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export interface DependencyOutcome {
  dir: string
  state: 'present' | 'installed' | 'skipped-readonly' | 'failed'
  detail?: string
}

export interface EnsureDepsDeps {
  /** Native binary version (the plugin package is pinned to it, as native does). */
  version: () => string
  /** Run `npm install` in `dir` (throws on failure). */
  npmInstall: (dir: string, spec: string) => void
}

export function defaultEnsureDepsDeps(bin: string, env: NodeJS.ProcessEnv): EnsureDepsDeps {
  return {
    version: () => execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000, env }).trim(),
    npmInstall: (dir, spec) =>
      void execFileSync('npm', ['install', '--no-audit', '--no-fund', '--save', spec], { cwd: dir, env, stdio: 'pipe', timeout: 300000 }),
  }
}

/** Satisfy the native no-op condition in every config dir. Never throws; the caller decides. */
export function ensureOpencodePluginDependency(cwd: string, env: NodeJS.ProcessEnv, deps: EnsureDepsDeps): DependencyOutcome[] {
  // Fail-closed sandbox guard (the IAPEER_TEST_SANDBOX contract): these dirs resolve from HOME, which
  // the IAPEER_ROOT isolation does not cover — a test that forgot to isolate HOME would write into the
  // operator's real OpenCode config (it happened once, 17.10).
  if ((env.IAPEER_TEST_SANDBOX === '1' || process.env.IAPEER_TEST_SANDBOX === '1') && resolve(env.HOME?.trim() || homedir()) === resolve(homedir())) {
    throw new Error('IAPEER_TEST_SANDBOX: refusing to preinstall into the real HOME — inject an isolated HOME')
  }
  const dirs = opencodeConfigDirs(cwd, env)
  mkdirSync(dirs[0]!, { recursive: true }) // the global config dir always exists natively
  let version: string | undefined
  const out: DependencyOutcome[] = []
  for (const dir of dirs) {
    if (pluginDependencySatisfied(dir)) {
      out.push({ dir, state: 'present' })
      continue
    }
    if (!writable(dir)) {
      out.push({ dir, state: 'skipped-readonly' })
      continue
    }
    try {
      version ??= deps.version()
      if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected opencode --version output: ${JSON.stringify(version)}`)
      deps.npmInstall(dir, `${OPENCODE_PLUGIN_PACKAGE}@${version}`)
      out.push(pluginDependencySatisfied(dir) ? { dir, state: 'installed' } : { dir, state: 'failed', detail: 'npm finished but the lock does not record the package' })
    } catch (e) {
      out.push({ dir, state: 'failed', detail: e instanceof Error ? e.message.split('\n')[0] : String(e) })
    }
  }
  return out
}
