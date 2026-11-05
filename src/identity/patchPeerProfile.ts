import { mkdirSync, readFileSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { IapError } from '../core/errors.ts'
import { writeFileAtomicRaw } from '../storage/atomicWrite.ts'

const PROFILE_LOCK_WAIT_MS = 2000
/** Persistent protocol guard lets generated standalone consumer bundles fail closed
 * when a future incompatible writer joins the same cwd. */
export const PEER_PROFILE_PATCH_PROTOCOL = 1

/** Bounded cooperative lock; no age-based stealing of a possibly paused owner. */
function withProfileLockSync<T>(cwd: string, fn: () => T): T {
  const lockDir = join(cwd, '.iapeer', '.peer-profile.lock')
  const deadline = Date.now() + PROFILE_LOCK_WAIT_MS
  let held = false
  for (;;) {
    try {
      mkdirSync(lockDir)
      held = true
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (Date.now() >= deadline) throw new IapError(`peer-profile lock timeout: ${lockDir}; no write performed`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
    }
  }
  try {
    return fn()
  } finally {
    if (held)
      try {
        rmdirSync(lockDir)
      } catch {
        /* */
      }
  }
}

/** Shared cooperative writer. Read and mutate only owned fields INSIDE the callback.
 * Lock failures and invalid existing data fail closed; see docs/06-storage.md. */
export function patchPeerProfile(cwd: string, mutate: (raw: Record<string, unknown>) => void): void {
  mkdirSync(join(cwd, '.iapeer'), { recursive: true, mode: 0o700 })
  withProfileLockSync(cwd, () => {
    const protocolPath = join(cwd, '.iapeer', '.peer-profile.protocol')
    let protocol: string | undefined
    try { protocol = readFileSync(protocolPath, 'utf8').trim() } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    if (protocol !== undefined && protocol !== String(PEER_PROFILE_PATCH_PROTOCOL)) {
      throw new IapError(`peer-profile protocol mismatch: expected ${PEER_PROFILE_PATCH_PROTOCOL}, found ${protocol}`)
    }
    if (protocol === undefined) writeFileAtomicRaw(protocolPath, `${PEER_PROFILE_PATCH_PROTOCOL}\n`, 0o600)
    const path = join(cwd, '.iapeer', 'peer-profile.json')
    let raw: Record<string, unknown> = {}
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IapError(`invalid peer-profile object: ${path}`)
      raw = value
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    const before = JSON.stringify(raw)
    const result: unknown = mutate(raw)
    if (result !== undefined) throw new IapError('patchPeerProfile callback must be synchronous and return void')
    if (JSON.stringify(raw) !== before) writeFileAtomicRaw(path, `${JSON.stringify(raw, null, 2)}\n`, 0o600)
  })
}
