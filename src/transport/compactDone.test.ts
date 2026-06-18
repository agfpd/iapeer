import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { compactDoneBaseline, compactTranscriptHasDone, waitForCompactDone, type DeliveryTarget } from './index.ts'

function claudeTarget(): DeliveryTarget {
  return { runtime: 'claude', personality: 'tester', address: 'claude-tester', socketPath: '/tmp/iapeer-test-noop.sock' }
}

const CLAUDE_IDLE_PANE = '❯ \n bypass permissions on'
const CLAUDE_BUSY_PANE = '· Compacting conversation… (esc to interrupt)\n  reloading context'

function withHome(fn: (home: string, env: NodeJS.ProcessEnv) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'iapeer-compact-gate-home-'))
  try {
    fn(home, { ...process.env, HOME: home })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function claudeSlug(cwd: string): string {
  return realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-')
}

describe('compact done transcript gate', () => {
  test('codex: ignores old markers and detects a new context_compacted event', () => withHome((home, env) => {
    const cwd = mkdtempSync(join(tmpdir(), 'iapeer-compact-codex-cwd-'))
    try {
      const dir = join(home, '.codex', 'sessions', '2026', '06', '13')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'rollout-test.jsonl')
      writeFileSync(file,
        JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n' +
        JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }) + '\n',
      )
      const baseline = compactDoneBaseline('codex', cwd, { env })
      expect(compactTranscriptHasDone(baseline, { env })).toBe(false)
      appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }) + '\n')
      expect(compactTranscriptHasDone(baseline, { env })).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }))

  test('claude: detects a new compact_boundary and ignores raw text mentions', () => withHome((home, env) => {
    const cwd = mkdtempSync(join(tmpdir(), 'iapeer-compact-claude-cwd-'))
    try {
      const dir = join(home, '.claude', 'projects', claudeSlug(cwd))
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'session.jsonl')
      writeFileSync(file,
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'context_compacted is only text' } }) + '\n' +
        JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }) + '\n',
      )
      const baseline = compactDoneBaseline('claude', cwd, { env })
      expect(compactTranscriptHasDone(baseline, { env })).toBe(false)
      appendFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Conversation compacted text only' } }) + '\n')
      expect(compactTranscriptHasDone(baseline, { env })).toBe(false)
      appendFileSync(file, JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { durationMs: 12 } }) + '\n')
      expect(compactTranscriptHasDone(baseline, { env })).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }))
})

describe('waitForCompactDone — marker is authoritative, idle is a fast-path', () => {
  function withClaudeMarker(
    fn: (args: { cwd: string; env: NodeJS.ProcessEnv; writeMarker: () => void; baseline: ReturnType<typeof compactDoneBaseline> }) => void,
  ): void {
    withHome((home, env) => {
      const cwd = mkdtempSync(join(tmpdir(), 'iapeer-compact-wait-cwd-'))
      try {
        const dir = join(home, '.claude', 'projects', claudeSlug(cwd))
        mkdirSync(dir, { recursive: true })
        const file = join(dir, 'session.jsonl')
        writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
        const baseline = compactDoneBaseline('claude', cwd, { env })
        const writeMarker = () =>
          appendFileSync(file, JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { durationMs: 140708, preTokens: 535706, postTokens: 12524 } }) + '\n')
        fn({ cwd, env, writeMarker, baseline })
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    })
  }

  // THE FIX: a large-context session that auto-continues into a working turn after compact
  // keeps the composer busy (never idle). The marker proves completion → SUCCESS, not failure.
  test('marker seen + composer never idle → success on the marker (signal: transcript)', () => withClaudeMarker(({ cwd, env, writeMarker, baseline }) => {
    writeMarker()
    const r = waitForCompactDone(claudeTarget(), cwd, baseline, {
      env,
      timeoutMs: 5000,
      pollMs: 5,
      graceMs: 20,
      seam: { sessionAlive: () => true, capturePane: () => CLAUDE_BUSY_PANE },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.signal).toBe('transcript')
  }))

  // Clean common case unchanged: marker + idle composer → the historical 'transcript+ready'.
  test('marker seen + composer idle → fast-path success (signal: transcript+ready)', () => withClaudeMarker(({ cwd, env, writeMarker, baseline }) => {
    writeMarker()
    const r = waitForCompactDone(claudeTarget(), cwd, baseline, {
      env,
      timeoutMs: 5000,
      pollMs: 5,
      graceMs: 5000,
      seam: { sessionAlive: () => true, capturePane: () => CLAUDE_IDLE_PANE },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.signal).toBe('transcript+ready')
  }))

  // BOUNDARY preserved: no structured marker ever → honest failure (hung / never completed).
  test('no marker → honest failure', () => withClaudeMarker(({ cwd, env, baseline }) => {
    const r = waitForCompactDone(claudeTarget(), cwd, baseline, {
      env,
      timeoutMs: 40,
      pollMs: 5,
      graceMs: 20,
      seam: { sessionAlive: () => true, capturePane: () => CLAUDE_BUSY_PANE },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('no transcript compact marker')
  }))

  // Session death during the wait still fails (liveness boundary).
  test('session vanished → failure', () => withClaudeMarker(({ cwd, env, baseline }) => {
    const r = waitForCompactDone(claudeTarget(), cwd, baseline, {
      env,
      timeoutMs: 5000,
      pollMs: 5,
      graceMs: 20,
      seam: { sessionAlive: () => false, capturePane: () => CLAUDE_BUSY_PANE },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('session vanished')
  }))
})
