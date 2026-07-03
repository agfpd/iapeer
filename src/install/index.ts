// install — the foundation install-phase (contract Установка §INSTALL). The
// foundation ships as ONE real binary at a STABLE host-wide path
// (~/.local/bin/iapeer), built standalone from src via `bun build --compile`, so
// PROD is DECOUPLED from the mutable src working tree: the daemon/infra launchd
// plists run the INSTALLED binary, and any edit/git-op in the tree no longer hits
// prod. Update = atomic overwrite in place (build to .tmp → rename over), with ONE
// .prev for rollback. NO versions/ catalog + resolver-symlink (that pattern is for
// multi-version toolchains; the foundation is one-latest).
//
// macOS TCC: a stable PATH is NOT enough to keep grants through updates — TCC keys
// on the code requirement, and an ad-hoc bun-compiled binary's requirement is its
// CDHash (changes every build → re-prompts; live-proven).
// signInstalledBinary (signing.ts) re-signs each install with the
// stable local identity so the designated requirement — and the grants — survive.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { basename, join, relative, sep } from 'path'
import { spawnSync } from 'child_process'
import { resolveGlobalRoot } from '../storage/index.ts'
import { signInstalledBinary, type SigningOutcome } from './signing.ts'

/** The stable host-wide install path of the `iapeer` binary. Standard user-bin (no
 *  admin, not tied to a node/bun version), ON $PATH. The launchd plists reference
 *  THIS path, not process.execPath / a src file — that is the decoupling. */
export function iapeerBinPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME?.trim() || homedir()
  // IAPEER_BIN_DIR override is for tests/sandbox only (never write a real ~/.local/bin
  // in a test). Default = ~/.local/bin.
  const binDir = env.IAPEER_BIN_DIR?.trim() || join(home, '.local', 'bin')
  return join(binDir, 'iapeer')
}

export interface InstallResult {
  binPath: string
  /** The previous binary preserved for rollback (when one existed). */
  prevPath?: string
  /** В50 — set when the outgoing binary was NOT copied to `.prev` because the healthy-stamp
   *  says it never passed a post-deploy health-check: the existing `.prev` (last KNOWN-GOOD)
   *  is preserved so a retry after a broken release cannot destroy the rollback target. */
  prevKept?: { reason: string }
  /** Bytes of the installed binary. */
  size?: number
  /** Stable-identity re-sign outcome (TCC grants survive updates). Soft: a signing
   *  hiccup never fails the install — the binary works ad-hoc-signed. */
  signing?: SigningOutcome
}

// ─────────────────────────────────────────────────────────────────────────────
// В50 — known-good `.prev`. Without a gate, EVERY install copies the current
// binary to `.prev`: a series of broken releases overwrites the known-good
// rollback target with a broken binary (retry of an update destroys the recovery
// path). The gate: `iapeer update`/`rollback` stamp `<bin>.healthy` with the
// sha256 of the binary ONLY after the daemon passed its post-deploy health-check.
// The next install copies the current binary to `.prev` only when the stamp
// matches it (proven-healthy). No stamp at all → legacy behavior (copy) — first
// update after this ships, manual `bin/iapeer install` runs, and fresh bootstraps
// keep working unchanged. NB the stamp is CROSS-VERSION state: install runs from
// the NEWLY-FETCHED package's source while the stamp was written by the OUTGOING
// version — keep the format trivial (hex digest + newline).
// ─────────────────────────────────────────────────────────────────────────────

/** The healthy-stamp path kept next to the binary. */
export function iapeerHealthyStampPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${iapeerBinPath(env)}.healthy`
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Record the CURRENT installed binary as known-good (call ONLY after a passed
 *  post-deploy health-check). Best-effort by design — a stamp hiccup must never
 *  fail a successful update; it only means the next install falls back to
 *  preserving the older `.prev`. */
export function stampBinaryHealthy(env: NodeJS.ProcessEnv = process.env): boolean {
  const binPath = iapeerBinPath(env)
  assertInstallSandboxIsolated(binPath, env)
  try {
    writeFileSync(iapeerHealthyStampPath(env), `${sha256File(binPath)}\n`, { mode: 0o644 })
    return true
  } catch {
    return false
  }
}

/** The В50 decision: should the CURRENT binary become `.prev`? Copy when the
 *  healthy-stamp matches it (proven-good) or when no stamp exists (legacy /
 *  first stamped update / manual install); preserve the existing `.prev` when
 *  the stamp EXISTS but does not match (the current binary never passed a
 *  health-check — a broken release being retried). Pure read — exported for
 *  hermetic tests (installIapeer itself runs a full compile). */
export function shouldCopyCurrentToPrev(binPath: string): { copy: boolean; reason?: string } {
  let stamped: string | undefined
  try {
    const stampPath = `${binPath}.healthy`
    stamped = existsSync(stampPath) ? readFileSync(stampPath, 'utf8').trim() : undefined
  } catch {
    stamped = undefined // unreadable stamp → treat as absent (legacy copy)
  }
  if (stamped && stamped !== sha256File(binPath)) {
    return {
      copy: false,
      reason:
        'current binary never passed a post-deploy health-check (healthy-stamp mismatch) — ' +
        'keeping the existing .prev as the known-good rollback target',
    }
  }
  return { copy: true }
}

/**
 * Build the standalone `iapeer` binary from the CLI entrypoint and place it at the
 * stable path ATOMICALLY: `bun build --compile <entry> → <bin>.tmp`, then rename over
 * <bin> (atomic on one fs; a running daemon keeps its old inode, new launches take the
 * new one). An existing binary is preserved as <bin>.prev first. Throws on build
 * failure (never leaves a half-written bin). The build runs from the SRC TREE (the
 * dev/npx bootstrap); the resulting binary is self-contained (no tree dependency).
 */
/** Fail-closed sandbox guard (audit #25, symmetric to the registry's): under
 *  IAPEER_TEST_SANDBOX=1 refuse to build over the REAL ~/.local/bin/iapeer (the live
 *  prod binary). A test/sandbox MUST set IAPEER_BIN_DIR to an isolated path. */
function assertInstallSandboxIsolated(binPath: string, env: NodeJS.ProcessEnv): void {
  if (env.IAPEER_TEST_SANDBOX !== '1') return
  const realBin = join(env.HOME?.trim() || homedir(), '.local', 'bin', 'iapeer')
  if (binPath === realBin) {
    throw new Error(
      `refusing to overwrite the REAL prod binary (${realBin}) under IAPEER_TEST_SANDBOX=1 — ` +
        'set IAPEER_BIN_DIR to an isolated path',
    )
  }
}

export function installIapeer(cliEntrypoint: string, env: NodeJS.ProcessEnv = process.env): InstallResult {
  const binPath = iapeerBinPath(env)
  assertInstallSandboxIsolated(binPath, env)
  mkdirSync(join(binPath, '..'), { recursive: true })
  const tmp = `${binPath}.tmp`
  const build = spawnSync('bun', ['build', '--compile', cliEntrypoint, '--outfile', tmp], {
    encoding: 'utf8',
  })
  if (build.status !== 0 || !existsSync(tmp)) {
    throw new Error(`iapeer build failed: ${(build.stderr ?? '').trim() || `exit ${build.status}`}`)
  }
  let prevPath: string | undefined
  let prevKept: InstallResult['prevKept']
  if (existsSync(binPath)) {
    // В50 — copy to .prev ONLY when shouldCopyCurrentToPrev says the current binary
    // is trustworthy; otherwise preserve the existing .prev (last known-good).
    const verdict = shouldCopyCurrentToPrev(binPath)
    if (!verdict.copy) {
      prevKept = { reason: verdict.reason! }
    } else {
      prevPath = `${binPath}.prev`
      // COPY (not move) the current binary to .prev so binPath is NEVER absent (audit
      // #7): a move-then-move leaves no binary in the window between the two renames —
      // if the second throws, the prod daemon + infra fleet crash-loop with no bin.
      copyFileSync(binPath, prevPath)
    }
  }
  renameSync(tmp, binPath) // atomic replace in place (POSIX rename over an existing file)
  // The stamp described the binary we just REPLACED — it must not vouch for the new
  // bytes. Health of the new binary is proven (and re-stamped) by the update verb
  // AFTER its health-check passes.
  try {
    unlinkSync(`${binPath}.healthy`)
  } catch {
    /* absent — fine */
  }
  // Stable-identity re-sign (TCC grants survive updates). AFTER the rename: the
  // signature belongs to the final inode at the final path. Soft-fail by design.
  const signing = signInstalledBinary(binPath, env)
  let size: number | undefined
  try {
    size = statSync(binPath).size
  } catch {
    /* best-effort */
  }
  return { binPath, prevPath, prevKept, size, signing }
}

/**
 * Scaffold an ecosystem package's docs to the STABLE, versioned, per-package host
 * path `~/.iapeer/docs/<pkg>/` so an agent can read the contract OFFLINE (a compiled
 * binary embeds no docs; the npm tarball's docs/ is discarded after install — proven:
 * `iapeer update` extracts to a temp dir it rm's in a `finally`, and the bunx cache
 * does not retain the package findably). This is the FOUNDATION-OWNED CONVENTION every
 * ecosystem package follows: each copies its OWN docs on its OWN install/update, so a
 * package's on-host docs always match its installed version.
 *
 * Mechanics: copy <docsSource> → ~/.iapeer/docs/<pkg> EXCLUDING internals/ (mirroring
 * the npm `files` exclusion), via an atomic temp-dir swap so a reader never sees a
 * half-copied tree. BEST-EFFORT — a missing source or copy hiccup NEVER fails the
 * install (the binary works without on-host docs); the caller logs the outcome.
 */
export function scaffoldHostDocs(
  pkg: string,
  docsSource: string,
  env: NodeJS.ProcessEnv = process.env,
): { copied: boolean; dest: string; reason?: string } {
  const root = resolveGlobalRoot(env)
  const dest = join(root, 'docs', pkg)
  // Fail-closed sandbox guard (in spirit with assertInstallSandboxIsolated): never write
  // the REAL machine ~/.iapeer under a sandboxed test that forgot to set IAPEER_ROOT.
  // Compared against the ACTUAL OS home (homedir()), not env.HOME — the root IS the docs
  // isolation, so an env.HOME-based check would false-trip when a test legitimately
  // points IAPEER_ROOT at <tmp>/.iapeer (with env.HOME also <tmp>).
  if (env.IAPEER_TEST_SANDBOX === '1' && root === join(homedir(), '.iapeer')) {
    throw new Error(`refusing to scaffold docs into the REAL ${join(root, 'docs')} under IAPEER_TEST_SANDBOX=1 — set IAPEER_ROOT`)
  }
  if (!existsSync(docsSource)) return { copied: false, dest, reason: `docs source not found: ${docsSource}` }
  const tmp = `${dest}.tmp-${process.pid}`
  try {
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(join(dest, '..'), { recursive: true })
    cpSync(docsSource, tmp, {
      recursive: true,
      // Skip the internals/ subtree (matches package.json files: "!docs/internals";
      // returning false for a directory skips its whole subtree) and macOS .DS_Store
      // cruft (the foundation is macOS-targeted, so every dev/host tree carries it).
      filter: src => {
        if (basename(src) === '.DS_Store') return false
        const rel = relative(docsSource, src)
        return rel !== 'internals' && !rel.startsWith(`internals${sep}`)
      },
    })
    rmSync(dest, { recursive: true, force: true })
    renameSync(tmp, dest)
    return { copied: true, dest }
  } catch (e) {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
    return { copied: false, dest, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** The previous-binary path kept by the last install for one-step rollback. */
export function iapeerPrevBinPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${iapeerBinPath(env)}.prev`
}

export interface RollbackResult {
  status: 'rolled-back' | 'failed'
  binPath: string
  reason?: string
}

/**
 * Roll the installed binary back to the `.prev` kept by the last install — the
 * recovery path when an `iapeer update` ships a bad version. ONE level deep (the
 * foundation keeps a single `.prev`, not a history stack): rollback restores the
 * binary that was live BEFORE the most recent install. Atomic (copy .prev → .tmp →
 * rename over the binary), so the binary is never absent. The CALLER restarts the
 * daemon afterwards (cycleDaemon) — rollback only swaps the bytes. Sandbox-guarded.
 */
export function rollbackIapeer(env: NodeJS.ProcessEnv = process.env): RollbackResult {
  const binPath = iapeerBinPath(env)
  assertInstallSandboxIsolated(binPath, env)
  const prev = iapeerPrevBinPath(env)
  if (!existsSync(prev)) {
    return { status: 'failed', binPath, reason: `no previous binary at ${prev} — nothing to roll back to` }
  }
  const tmp = `${binPath}.rollback.tmp`
  try {
    copyFileSync(prev, tmp)
    renameSync(tmp, binPath)
    // Keep the stable requirement on the restored bytes too (a .prev taken before
    // the signing era is ad-hoc — re-signing it heals that). Soft by design.
    signInstalledBinary(binPath, env)
  } catch (e) {
    try {
      if (existsSync(tmp)) renameSync(tmp, `${tmp}.discard`) // never leave a half-written tmp on the path
    } catch {
      /* best-effort */
    }
    return { status: 'failed', binPath, reason: e instanceof Error ? e.message : String(e) }
  }
  return { status: 'rolled-back', binPath }
}
