// The guard-FREE atomic-write CORE — the single durability implementation shared by
// storage.writeFileAtomic (public, basename-guarded) and registry's private
// peers-profiles writer (which bypasses that guard legitimately: it is the sole writer
// under withPeersLock). Factored out because the registry kept its OWN copy of the
// atomic-rename, and that copy DRIFTED — it lost the fsync the storage primitive has,
// re-opening the power-loss hole on the most critical file of the host (the fleet
// registry). One implementation → the durability protocol can never drift again.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DIR_MODE = 0o700

/**
 * Atomically write `data` to `target`:
 *   1. write to a unique tmp in `tmpDir` (default: the target's directory — which MUST be the same
 *      filesystem as `target`, or the rename is not atomic),
 *   2. fsync the tmp BEFORE the rename — rename is atomic on one fs, but without flushing the bytes
 *      first a power-loss can publish a zero-length / partial file,
 *   3. rename the tmp over `target`.
 *
 * writeSync is LOOPED over a Buffer: a single writeSync can write FEWER bytes than requested (on
 * ENOSPC / a signal, write(2) returns a partial count WITHOUT throwing), which would otherwise publish
 * a truncated file — the exact failure the atomic primitive exists to prevent. The tmp is always
 * cleaned up on failure so a partial write never leaks.
 */
export function writeFileAtomicRaw(
  target: string,
  data: string,
  mode: number,
  tmpDir: string = dirname(target),
): void {
  mkdirSync(dirname(target), { recursive: true, mode: DIR_MODE })
  if (tmpDir !== dirname(target)) mkdirSync(tmpDir, { recursive: true, mode: DIR_MODE })
  const tmp = join(tmpDir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    const fd = openSync(tmp, 'w', mode)
    try {
      const buf = Buffer.from(data, 'utf8')
      let written = 0
      while (written < buf.length) {
        const n = writeSync(fd, buf, written, buf.length - written)
        if (n <= 0) throw new Error(`writeSync made no progress writing ${target} (${written}/${buf.length} bytes)`)
        written += n
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, target)
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* best-effort cleanup */
    }
    throw e
  }
}
