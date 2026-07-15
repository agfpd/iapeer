import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoticeBoard, noticeDedupKey } from './notices.ts'
import { noticesLogPath } from './noticeslog.ts'

const base = {
  personality: 'iapeer',
  runtime: 'claude',
  kind: 'peer-mute',
  errorType: 'rate_limit',
  model: 'Fable 5',
  content: "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'iapeer-notices-'))
}

describe('NoticeBoard', () => {
  test('raise returns a notice and serves it on list/get', () => {
    const board = new NoticeBoard({})
    const { notice, deduped } = board.raise(base)
    expect(deduped).toBe(false)
    expect(notice.id).toBe('n1')
    expect(notice.count).toBe(1)
    expect(board.list()).toHaveLength(1)
    expect(board.get('n1')?.content).toBe(base.content)
    expect(board.size()).toBe(1)
  })

  test('summary defaults to the first line of the runtime verbatim content', () => {
    const board = new NoticeBoard({})
    const { notice } = board.raise({ ...base, content: 'first line\nsecond line' })
    expect(notice.summary).toBe('first line')
  })

  // The core anti-spam invariant: a mute peer re-emits its error on EVERY attempted turn.
  test('repeat detections FOLD into the live notice — one card, count bumps, no new id', () => {
    let t = 1_000
    const board = new NoticeBoard({ now: () => t })
    const first = board.raise(base)
    expect(first.deduped).toBe(false)
    for (let i = 0; i < 6; i++) {
      t += 1_000
      const again = board.raise(base)
      expect(again.deduped).toBe(true)
      expect(again.notice.id).toBe('n1') // same card, never a new one
    }
    expect(board.list()).toHaveLength(1)
    expect(board.list()[0]!.count).toBe(7)
    expect(board.list()[0]!.lastMs).toBe(t) // last sighting moves…
    expect(board.list()[0]!.createdMs).toBe(1_000) // …the original stays put
  })

  test('a folded repeat writes NO second log line (the owner is not spammed)', () => {
    const dir = tmp()
    const board = new NoticeBoard({ logDir: dir, env: {} as NodeJS.ProcessEnv })
    board.raise(base)
    board.raise(base)
    board.raise(base)
    const lines = readFileSync(noticesLogPath(dir), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('ev=notice-raised')
  })

  // Found live on 15.07: the sweep window overlaps on purpose, so the SAME transcript line is
  // re-read across passes. Counting those would render 2 real refusals as "×3" — a claim the
  // owner cannot check. count must mean OCCURRENCES.
  test('the same runtime event re-read by an overlapping sweep does NOT inflate count', () => {
    let t = 1_000
    const board = new NoticeBoard({ now: () => t })
    board.raise({ ...base, eventAtMs: 500 })
    t = 2_000
    board.raise({ ...base, eventAtMs: 500 }) // same line, next sweep
    t = 3_000
    board.raise({ ...base, eventAtMs: 500 }) // and again
    expect(board.list()[0]!.count).toBe(1)
    expect(board.list()[0]!.lastMs).toBe(1_000) // no phantom "latest occurrence" either
  })

  test('a genuinely NEW occurrence does bump count', () => {
    let t = 1_000
    const board = new NoticeBoard({ now: () => t })
    board.raise({ ...base, eventAtMs: 500 })
    t = 2_000
    board.raise({ ...base, eventAtMs: 500 }) // re-read — ignored
    board.raise({ ...base, eventAtMs: 1_900 }) // a real second refusal
    expect(board.list()[0]!.count).toBe(2)
    expect(board.list()[0]!.lastMs).toBe(2_000)
  })

  test('an older event than the one already counted is never counted (out-of-order sweep)', () => {
    const board = new NoticeBoard({})
    board.raise({ ...base, eventAtMs: 5_000 })
    board.raise({ ...base, eventAtMs: 4_000 })
    expect(board.list()[0]!.count).toBe(1)
  })

  test('a DIFFERENT wall on the same peer is a different notice (model is part of the key)', () => {
    const board = new NoticeBoard({})
    board.raise(base)
    const other = board.raise({ ...base, model: 'Opus 4.8' })
    expect(other.deduped).toBe(false)
    expect(board.list()).toHaveLength(2)
  })

  test('a different errorType on the same peer+model is a different notice', () => {
    const board = new NoticeBoard({})
    board.raise(base)
    const other = board.raise({ ...base, errorType: 'overloaded' })
    expect(other.deduped).toBe(false)
    expect(board.list()).toHaveLength(2)
  })

  test('dedupKey composes peer|runtime|kind|errorType|model', () => {
    expect(noticeDedupKey(base)).toBe('iapeer|claude|peer-mute|rate_limit|Fable 5')
    expect(noticeDedupKey({ ...base, model: undefined })).toBe('iapeer|claude|peer-mute|rate_limit|')
  })

  test('TTL expires the notice, and a still-broken peer then re-raises a FRESH card', () => {
    let t = 0
    const board = new NoticeBoard({ ttlMs: 10_000, now: () => t })
    board.raise(base)
    t = 5_000
    expect(board.raise(base).deduped).toBe(true) // still live → folded
    t = 20_000
    expect(board.list()).toHaveLength(0) // expired out
    const again = board.raise(base)
    expect(again.deduped).toBe(false) // …and re-raised as a NEW card — the periodic reminder
    expect(again.notice.id).toBe('n2')
  })

  test('ttl comes from IAPEER_NOTICE_TTL_MS when not passed', () => {
    let t = 0
    const board = new NoticeBoard({ env: { IAPEER_NOTICE_TTL_MS: '5000' } as unknown as NodeJS.ProcessEnv, now: () => t })
    board.raise(base)
    t = 6_000
    expect(board.list()).toHaveLength(0)
  })

  test('an absent reset is OMITTED from the log, never invented', () => {
    const dir = tmp()
    const board = new NoticeBoard({ logDir: dir, env: {} as NodeJS.ProcessEnv })
    board.raise(base) // claude case — no resetsAtMs
    const line = readFileSync(noticesLogPath(dir), 'utf8')
    expect(line).not.toContain('resets_at')
    expect(line).toContain('error_type=rate_limit')
  })

  test('a stated reset is logged as BOTH epoch-ms and an iso stamp', () => {
    const dir = tmp()
    const board = new NoticeBoard({ logDir: dir, env: {} as NodeJS.ProcessEnv })
    board.raise({ ...base, runtime: 'codex', model: undefined, resetsAtMs: 1_783_114_795_000 })
    const line = readFileSync(noticesLogPath(dir), 'utf8')
    expect(line).toContain('resets_at=1783114795000')
    expect(line).toContain('resets_at_iso=2026-07-03')
  })

  test('a falsy logDir writes nothing (library/test daemons stay hermetic)', () => {
    const dir = tmp()
    const board = new NoticeBoard({ logDir: undefined, env: {} as NodeJS.ProcessEnv })
    board.raise(base)
    expect(existsSync(noticesLogPath(dir))).toBe(false)
  })
})
