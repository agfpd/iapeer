import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  attachmentInboxDir,
  purgeAttachmentInbox,
  spoolAttachments,
} from './attachments.ts'

let root: string
let sources: string

function env(): NodeJS.ProcessEnv {
  return { ...process.env, IAPEER_ROOT: root, IAPEER_TEST_SANDBOX: '1' }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'iapeer-attachments-root-'))
  sources = mkdtempSync(join(tmpdir(), 'iapeer-attachments-src-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(sources, { recursive: true, force: true })
})

describe('recipient-owned attachment spool', () => {
  test('copies bytes before ack-path use; source delete/rename cannot break the copy', () => {
    const source = join(sources, 'report.pdf')
    const bytes = Buffer.from('durable attachment\0with bytes\n', 'utf8')
    const expected = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(source, bytes)

    const copied = spoolAttachments([source], 'receiver', env())
    expect(copied.ok).toBe(true)
    if (!copied.ok) return
    const path = copied.value.paths[0]!
    expect(path).toBe(join(attachmentInboxDir('receiver', env()), expected, basename(source)))
    expect(copied.value.sha256).toEqual([expected])
    expect(readFileSync(path)).toEqual(bytes)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    rmSync(source)
    expect(readFileSync(path)).toEqual(bytes)
  })

  test('forwarding to another recipient creates an independent target copy', () => {
    const source = join(sources, 'part.txt')
    writeFileSync(source, 'same payload')
    const first = spoolAttachments([source], 'first', env())
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = spoolAttachments(first.value.paths, 'second', env())
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.paths[0]).not.toBe(first.value.paths[0])
    rmSync(attachmentInboxDir('first', env()), { recursive: true, force: true })
    expect(readFileSync(second.value.paths[0]!, 'utf8')).toBe('same payload')
  })

  test('missing, unreadable/open-failing, or non-regular sources fail before routing', () => {
    const missing = spoolAttachments([join(sources, 'gone')], 'receiver', env())
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.message).toMatch(/could not be copied.*NOT delivered/)

    const dir = join(sources, 'a-directory')
    mkdirSync(dir)
    const nonRegular = spoolAttachments([dir], 'receiver', env())
    expect(nonRegular.ok).toBe(false)
    if (!nonRegular.ok) expect(nonRegular.error.message).toContain('not a regular file')
  })

  test('recipient removal purges only that recipient inbox', () => {
    const source = join(sources, 'x.bin')
    writeFileSync(source, 'x')
    expect(spoolAttachments([source], 'first', env()).ok).toBe(true)
    expect(spoolAttachments([source], 'second', env()).ok).toBe(true)
    const purged = purgeAttachmentInbox('first', env())
    expect(purged.removed).toBe(true)
    expect(existsSync(attachmentInboxDir('first', env()))).toBe(false)
    expect(existsSync(attachmentInboxDir('second', env()))).toBe(true)
    expect(purgeAttachmentInbox('first', env()).removed).toBe(false) // idempotent
  })

  test('no attachments is a no-op (ordinary text sends create no inbox)', () => {
    const copied = spoolAttachments([], 'receiver', env())
    expect(copied).toEqual({ ok: true, value: { paths: [], sha256: [] } })
    expect(existsSync(attachmentInboxDir('receiver', env()))).toBe(false)
  })

  test('recipient path is name-validated (no spool-root traversal)', () => {
    expect(() => attachmentInboxDir('../outside', env())).toThrow(/invalid attachment recipient/)
  })
})
