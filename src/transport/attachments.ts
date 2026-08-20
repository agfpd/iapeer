// IAP attachment ownership — copy-on-send into recipient-owned foundation state.
//
// A caller-supplied attachment path is a SOURCE, never the delivered object. Before
// routeSend builds an envelope, each regular file is copied byte-for-byte into:
//
//   <IAPEER_ROOT>/state/iapeer/attachments/<recipient>/<sha256>/<basename>
//
// and only that durable path enters the envelope. The content hash makes repeat
// sends idempotent without coupling the copy to an ephemeral message/queue entry;
// a recipient can forward its copy and the next route creates a separate copy in
// the next recipient's inbox. Completed copies are STATE (not cache): no age GC.
// The recipient's explicit peer removal purges its complete inbox.

import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { STATE_DIR, isValidName } from '../core/constants.ts'
import { IapError, err, ok, type Result } from '../core/errors.ts'
import { resolveGlobalRoot } from '../storage/index.ts'

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const COPY_BUFFER_BYTES = 1024 * 1024

export const ATTACHMENT_SPOOL_DIR = 'attachments'

export interface SpooledAttachments {
  paths: string[]
  sha256: string[]
}

export interface AttachmentPurgeResult {
  path: string
  removed: boolean
}

export function attachmentSpoolRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalRoot(env), STATE_DIR, 'iapeer', ATTACHMENT_SPOOL_DIR)
}

export function attachmentInboxDir(
  recipient: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isValidName(recipient)) {
    throw new IapError(`invalid attachment recipient "${recipient}"`)
  }
  return join(attachmentSpoolRoot(env), recipient)
}

/**
 * Copy one source through an fsynced staging file while calculating its SHA-256.
 * The staging file lives in the recipient inbox (same filesystem as the final
 * path), so the final rename is atomic. A partial copy is never exposed in an IAP
 * envelope and is cleaned on every failure visible to this process.
 */
function copyOne(
  source: string,
  recipient: string,
  env: NodeJS.ProcessEnv,
): { path: string; sha256: string } {
  const inbox = attachmentInboxDir(recipient, env)
  mkdirSync(inbox, { recursive: true, mode: DIR_MODE })
  const tmp = join(inbox, `.incoming-${process.pid}-${randomUUID()}`)
  let sourceFd: number | undefined
  let targetFd: number | undefined
  try {
    sourceFd = openSync(source, 'r')
    const sourceStat = fstatSync(sourceFd)
    if (!sourceStat.isFile()) throw new Error('source is not a regular file')

    targetFd = openSync(tmp, 'wx', FILE_MODE)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    while (true) {
      const read = readSync(sourceFd, buffer, 0, buffer.length, null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
      let written = 0
      while (written < read) {
        const n = writeSync(targetFd, buffer, written, read - written)
        if (n <= 0) {
          throw new Error(`write made no progress (${written}/${read} bytes in current chunk)`)
        }
        written += n
      }
    }
    fsyncSync(targetFd)
    closeSync(targetFd)
    targetFd = undefined
    closeSync(sourceFd)
    sourceFd = undefined

    const sha256 = hash.digest('hex')
    const hashDir = join(inbox, sha256)
    mkdirSync(hashDir, { recursive: true, mode: DIR_MODE })
    const path = join(hashDir, basename(source))
    // Atomic publish. Replacing an existing same-hash+basename object is safe and
    // repairs a manually damaged copy; concurrent publishers carry identical bytes.
    renameSync(tmp, path)
    chmodSync(path, FILE_MODE)
    return { path, sha256 }
  } finally {
    if (targetFd !== undefined) {
      try { closeSync(targetFd) } catch { /* already closed */ }
    }
    if (sourceFd !== undefined) {
      try { closeSync(sourceFd) } catch { /* already closed */ }
    }
    try { rmSync(tmp, { force: true }) } catch { /* renamed or best-effort cleanup */ }
  }
}

/**
 * Materialize every attachment in the target peer's inbox. All validation and
 * copying completes before the caller receives paths for envelope construction;
 * any failure aborts the send loudly. Copies already completed before a later
 * item fails stay as harmless recipient state and are content-address deduplicated
 * on retry (removing them here could delete a copy referenced by an earlier send).
 */
export function spoolAttachments(
  sources: readonly string[],
  recipient: string,
  env: NodeJS.ProcessEnv = process.env,
): Result<SpooledAttachments> {
  const paths: string[] = []
  const sha256: string[] = []
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]!
    try {
      const copied = copyOne(source, recipient, env)
      paths.push(copied.path)
      sha256.push(copied.sha256)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      return err(`attachment ${i + 1} "${source}" could not be copied for "${recipient}": ${reason}; message NOT delivered`)
    }
  }
  return ok({ paths, sha256 })
}

/** Recipient-lifetime cleanup: called by `iapeer remove <peer>`. */
export function purgeAttachmentInbox(
  recipient: string,
  env: NodeJS.ProcessEnv = process.env,
): AttachmentPurgeResult {
  const path = attachmentInboxDir(recipient, env)
  const removed = existsSync(path)
  rmSync(path, { recursive: true, force: true })
  return { path, removed }
}
