import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NoticeBoard } from './notices.ts'
import { modelFromClaudeText, muteWatchTick, parseClaudeTranscript, parseCodexRollout, resolveMuteWatchPaths, scanMuteEvents } from './mutewatch.ts'

// ─────────────────────────────────────────────────────────────────────────────
// REAL BYTES. This is the transcript line claude actually wrote on 15.07.2026 when the
// account's fable bucket was exhausted — captured live from a real pty session while the
// window was open (the raw capture + this line live in docs/internals/forensics/
// model-limit-2026-07-15/). Every field is verbatim; nothing here is hand-authored, which
// is the point: the detector is tested against what the runtime EMITS, not against what we
// believe it emits.
// ─────────────────────────────────────────────────────────────────────────────
const REAL_CLAUDE_RATE_LIMIT_LINE =
  '{"parentUuid":"33027f3c-4568-413c-a0f4-1a1870345b8d","isSidechain":false,"type":"assistant","uuid":"fd395da0-0a07-4fc4-b426-3117eec7d91e","timestamp":"2026-07-15T17:40:12.594Z","requestId":"req_011Cd4FdpFh4xXSbbicAccrN","error":"rate_limit","apiErrorStatus":429,"isApiErrorMessage":true,"errorDetails":"429 {\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"rate_limit_error\\",\\"message\\":\\"This request would exceed your account\'s rate limit. Please try again later.\\"},\\"request_id\\":\\"req_011Cd4FdpFh4xXSbbicAccrN\\"}","cwd":"/Users/macmini/Peers/probe","sessionId":"85ea79c9-c515-4a27-afbd-20ab88025f3e","version":"2.1.210","userType":"external","entrypoint":"sdk-cli","gitBranch":"HEAD","message":{"model":"<synthetic>","role":"assistant","type":"message","content":[{"type":"text","text":"You\'ve reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."}]}}'

const REAL_TS_MS = Date.parse('2026-07-15T17:40:12.594Z')

const USER_LINE =
  '{"type":"user","timestamp":"2026-07-15T17:40:05.000Z","cwd":"/Users/macmini/Peers/probe","sessionId":"85ea79c9","message":{"role":"user","content":"ping"}}'
const REAL_MODEL_REPLY =
  '{"type":"assistant","timestamp":"2026-07-15T17:39:00.000Z","cwd":"/Users/macmini/Peers/probe","sessionId":"85ea79c9","message":{"model":"claude-opus-4-8","role":"assistant","content":[{"type":"text","text":"hi"}]}}'

// ─────────────────────────────────────────────────────────────────────────────
// REAL CODEX BYTES, replayed. `REAL_CODEX_TOKEN_COUNT` is a verbatim token_count line out of
// ~/.codex/sessions on this host (2026-07-03) — the healthy case, byte-for-byte, including
// `rate_limit_reached_type: null` and the real window figures (primary 1%, secondary 17%).
//
// HONEST BOUNDARY (docs/19 §5): codex's quota never ran out here, so no real REACHED bytes
// exist to replay. `codexReached()` flips that ONE field to a variant read out of the 0.144.1
// binary and touches nothing else. So: the structure, the windows, the resets and the healthy
// path are real; the reached VALUE is synthesized. The detector keys on non-null precisely so
// this synthesis cannot flatter it — any variant, known or not, takes the same path.
// ─────────────────────────────────────────────────────────────────────────────
const REAL_CODEX_TOKEN_COUNT =
  '{"timestamp":"2026-07-03T16:40:10.618Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":26124,"cached_input_tokens":4480,"output_tokens":754,"reasoning_output_tokens":463,"total_tokens":26878},"last_token_usage":{"input_tokens":26124,"cached_input_tokens":4480,"output_tokens":754,"reasoning_output_tokens":463,"total_tokens":26878},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":1.0,"window_minutes":300,"resets_at":1783114795},"secondary":{"used_percent":17.0,"window_minutes":10080,"resets_at":1783412915},"credits":null,"individual_limit":null,"plan_type":"plus","rate_limit_reached_type":null}}}'

const REAL_CODEX_TS_MS = Date.parse('2026-07-03T16:40:10.618Z')
/** The real line's own reset stamps — secondary is the FULLER window in the real data (17% vs 1%). */
const REAL_PRIMARY_RESET_MS = 1_783_114_795 * 1000
const REAL_SECONDARY_RESET_MS = 1_783_412_915 * 1000

const codexReached = (variant = 'rate_limit_reached'): string =>
  REAL_CODEX_TOKEN_COUNT.replace('"rate_limit_reached_type":null', `"rate_limit_reached_type":"${variant}"`)

// Real session_meta (trimmed to the fields the detector reads), verbatim values.
const CODEX_META =
  '{"timestamp":"2026-07-13T01:44:12.982Z","type":"session_meta","payload":{"session_id":"019f5925-6c1f-7911-85e5-87feba841fb9","cwd":"/Users/macmini/Peers/doc","originator":"codex-tui","cli_version":"0.144.1"}}'

describe('parseClaudeTranscript — against the REAL captured rate-limit line', () => {
  test('detects the real line and reports the runtime taxonomy verbatim', () => {
    const d = parseClaudeTranscript(REAL_CLAUDE_RATE_LIMIT_LINE, 0)
    expect(d).not.toBeNull()
    expect(d!.errorType).toBe('rate_limit') // the runtime's own enum, not our string
    expect(d!.cwd).toBe('/Users/macmini/Peers/probe')
    expect(d!.sessionId).toBe('85ea79c9-c515-4a27-afbd-20ab88025f3e')
    expect(d!.atMs).toBe(REAL_TS_MS)
    expect(d!.content).toBe("You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.")
  })

  // The asymmetry boris signed off on: claude states no reset for a per-model bucket.
  test('states NO reset for the real line — omission, never an extrapolation', () => {
    const d = parseClaudeTranscript(REAL_CLAUDE_RATE_LIMIT_LINE, 0)
    expect(d!.resetsAtMs).toBeUndefined()
  })

  test('names the model from the runtime prose when no real reply preceded it', () => {
    // A session that hits the wall on its FIRST turn has no real model line to read.
    const d = parseClaudeTranscript([USER_LINE, REAL_CLAUDE_RATE_LIMIT_LINE].join('\n'), 0)
    expect(d!.model).toBe('Fable 5')
  })

  test('prefers the real model reply over the prose when the transcript has one', () => {
    const d = parseClaudeTranscript([REAL_MODEL_REPLY, USER_LINE, REAL_CLAUDE_RATE_LIMIT_LINE].join('\n'), 0)
    expect(d!.model).toBe('claude-opus-4-8')
  })

  test('never reads the synthetic error message as a model', () => {
    const d = parseClaudeTranscript(REAL_CLAUDE_RATE_LIMIT_LINE, 0)
    expect(d!.model).not.toBe('<synthetic>')
  })

  test('ignores the line once it is older than the since-boundary (no re-dredging history)', () => {
    expect(parseClaudeTranscript(REAL_CLAUDE_RATE_LIMIT_LINE, REAL_TS_MS)).toBeNull()
    expect(parseClaudeTranscript(REAL_CLAUDE_RATE_LIMIT_LINE, REAL_TS_MS + 1)).toBeNull()
    expect(parseClaudeTranscript(REAL_CLAUDE_RATE_LIMIT_LINE, REAL_TS_MS - 1)).not.toBeNull()
  })

  test('a healthy transcript detects nothing', () => {
    expect(parseClaudeTranscript([REAL_MODEL_REPLY, USER_LINE].join('\n'), 0)).toBeNull()
  })

  // The CLASS, not the instance — boris's scope call. rate_limit is one value of `error`.
  test('detects the whole isApiErrorMessage class, not just rate_limit', () => {
    const overloaded = REAL_CLAUDE_RATE_LIMIT_LINE.replace('"error":"rate_limit"', '"error":"overloaded"')
    const d = parseClaudeTranscript(overloaded, 0)
    expect(d!.errorType).toBe('overloaded')
  })

  test('an api-error line with an unknown error field still detects (falls back to api-error)', () => {
    const noType = REAL_CLAUDE_RATE_LIMIT_LINE.replace('"error":"rate_limit",', '')
    const d = parseClaudeTranscript(noType, 0)
    expect(d).not.toBeNull()
    expect(d!.errorType).toBe('api-error')
  })

  test('survives a truncated first line from the tail cut, and garbage lines', () => {
    const text = ['ed":"rate_limit","isApiErr', 'not json at all', '', REAL_CLAUDE_RATE_LIMIT_LINE].join('\n')
    expect(parseClaudeTranscript(text, 0)!.errorType).toBe('rate_limit')
  })

  test('takes the NEWEST error line when several are present', () => {
    const older = REAL_CLAUDE_RATE_LIMIT_LINE.replace('2026-07-15T17:40:12.594Z', '2026-07-15T17:00:00.000Z')
    const d = parseClaudeTranscript([older, REAL_CLAUDE_RATE_LIMIT_LINE].join('\n'), 0)
    expect(d!.atMs).toBe(REAL_TS_MS)
  })

  test('a line without a cwd is unattributable and ignored rather than guessed', () => {
    const noCwd = REAL_CLAUDE_RATE_LIMIT_LINE.replace('"cwd":"/Users/macmini/Peers/probe",', '')
    expect(parseClaudeTranscript(noCwd, 0)).toBeNull()
  })
})

describe('modelFromClaudeText', () => {
  test('lifts the model out of the runtime prose', () => {
    expect(modelFromClaudeText("You've reached your Fable 5 limit. Run /usage-credits")).toBe('Fable 5')
    expect(modelFromClaudeText("You've reached your Opus 4.8 limit.")).toBe('Opus 4.8')
  })
  test('no match → undefined (omit, never guess)', () => {
    expect(modelFromClaudeText('Something else entirely')).toBeUndefined()
  })
})

describe('parseCodexRollout — replaying REAL rollout bytes', () => {
  test('the real healthy line, byte-for-byte, detects nothing', () => {
    expect(parseCodexRollout([CODEX_META, REAL_CODEX_TOKEN_COUNT].join('\n'), 0)).toBeNull()
  })

  test('detects on NON-NULL reached type and reports the reset codex DOES state', () => {
    const d = parseCodexRollout([CODEX_META, codexReached()].join('\n'), 0)
    expect(d).not.toBeNull()
    expect(d!.errorType).toBe('rate_limit_reached')
    expect(d!.cwd).toBe('/Users/macmini/Peers/doc')
    expect(d!.sessionId).toBe('019f5925-6c1f-7911-85e5-87feba841fb9')
    expect(d!.atMs).toBe(REAL_CODEX_TS_MS)
    // The reset time claude cannot give — from the real bytes' own secondary window (17% > 1%).
    expect(d!.resetsAtMs).toBe(REAL_SECONDARY_RESET_MS)
  })

  // The rule that survives codex shipping a variant we have never seen — and the reason the
  // synthesized reached-value above cannot flatter the detector.
  test('an UNKNOWN future variant still detects (we key on non-null, not on the strings)', () => {
    const d = parseCodexRollout([CODEX_META, codexReached('some_variant_invented_in_2027')].join('\n'), 0)
    expect(d!.errorType).toBe('some_variant_invented_in_2027')
  })

  test('carries BOTH real windows verbatim so the human sees the raw fact', () => {
    const d = parseCodexRollout([CODEX_META, codexReached()].join('\n'), 0)
    expect(d!.content).toContain('primary 1%')
    expect(d!.content).toContain('secondary 17%')
    expect(d!.content).toContain('300m window')
    expect(d!.content).toContain('plan=plus')
  })

  test('when primary is the fuller window, primary leads', () => {
    const primaryFull = codexReached().replace('"used_percent":1.0', '"used_percent":99.0')
    const d = parseCodexRollout([CODEX_META, primaryFull].join('\n'), 0)
    expect(d!.resetsAtMs).toBe(REAL_PRIMARY_RESET_MS)
  })

  // Codex does not say WHICH window blocked; "fullest" is our documented heuristic, so a tie
  // must resolve deterministically rather than by map order.
  test('a tie between windows resolves to primary, deterministically', () => {
    const tie = codexReached().replace('"used_percent":17.0', '"used_percent":1.0')
    const d = parseCodexRollout([CODEX_META, tie].join('\n'), 0)
    expect(d!.resetsAtMs).toBe(REAL_PRIMARY_RESET_MS)
  })

  test('codex names no model → model omitted rather than invented', () => {
    const d = parseCodexRollout([CODEX_META, codexReached()].join('\n'), 0)
    expect(d!.model).toBeUndefined()
  })

  test('reads cwd from the HEAD when a long session pushed session_meta out of the tail', () => {
    const d = parseCodexRollout(codexReached(), 0, CODEX_META)
    expect(d!.cwd).toBe('/Users/macmini/Peers/doc')
  })

  test('no session_meta anywhere → unattributable → ignored', () => {
    expect(parseCodexRollout(codexReached(), 0)).toBeNull()
  })

  test('respects the since-boundary', () => {
    expect(parseCodexRollout([CODEX_META, codexReached()].join('\n'), REAL_CODEX_TS_MS)).toBeNull()
  })
})

describe('scanMuteEvents — attribution across a real-shaped tree', () => {
  function tree(): { home: string; paths: ReturnType<typeof resolveMuteWatchPaths> } {
    const home = mkdtempSync(join(tmpdir(), 'iapeer-mutewatch-'))
    const paths = resolveMuteWatchPaths({ HOME: home } as unknown as NodeJS.ProcessEnv)
    mkdirSync(join(paths.claudeProjectsDir, '-Users-macmini-Peers-probe'), { recursive: true })
    mkdirSync(join(paths.codexSessionsDir, '2026', '07', '13'), { recursive: true })
    return { home, paths }
  }

  test('attributes a claude transcript to its peer by the cwd the FILE states', () => {
    const { paths } = tree()
    writeFileSync(join(paths.claudeProjectsDir, '-Users-macmini-Peers-probe', 's.jsonl'), REAL_CLAUDE_RATE_LIMIT_LINE)
    const found = scanMuteEvents({ ...paths, peerByCwd: cwd => (cwd === '/Users/macmini/Peers/probe' ? 'probe' : undefined) }, 0)
    expect(found).toHaveLength(1)
    expect(found[0]!.personality).toBe('probe')
    expect(found[0]!.runtime).toBe('claude')
    expect(found[0]!.errorType).toBe('rate_limit')
  })

  // The dir name is a red herring by construction — attribution must come from the content.
  test('attribution ignores the slug dir name entirely (the IAPeer/iapeer case trap)', () => {
    const { paths } = tree()
    mkdirSync(join(paths.claudeProjectsDir, '-Totally-Unrelated-Dir-Name'), { recursive: true })
    writeFileSync(join(paths.claudeProjectsDir, '-Totally-Unrelated-Dir-Name', 's.jsonl'), REAL_CLAUDE_RATE_LIMIT_LINE)
    const found = scanMuteEvents({ ...paths, peerByCwd: cwd => (cwd === '/Users/macmini/Peers/probe' ? 'probe' : undefined) }, 0)
    expect(found).toHaveLength(1)
    expect(found[0]!.personality).toBe('probe')
  })

  test("a NON-peer session (a human's own shell) never raises anything", () => {
    const { paths } = tree()
    writeFileSync(join(paths.claudeProjectsDir, '-Users-macmini-Peers-probe', 's.jsonl'), REAL_CLAUDE_RATE_LIMIT_LINE)
    expect(scanMuteEvents({ ...paths, peerByCwd: () => undefined }, 0)).toHaveLength(0)
  })

  test('finds a codex rollout nested under YYYY/MM/DD', () => {
    const { paths } = tree()
    writeFileSync(
      join(paths.codexSessionsDir, '2026', '07', '13', 'rollout-x.jsonl'),
      [CODEX_META, codexReached()].join("\n"),
    )
    const found = scanMuteEvents({ ...paths, peerByCwd: cwd => (cwd === '/Users/macmini/Peers/doc' ? 'doc' : undefined) }, 0)
    expect(found).toHaveLength(1)
    expect(found[0]!.personality).toBe('doc')
    expect(found[0]!.runtime).toBe('codex')
    expect(found[0]!.resetsAtMs).toBe(REAL_SECONDARY_RESET_MS)
  })

  test('an empty/absent tree is a clean no-op', () => {
    const paths = resolveMuteWatchPaths({ HOME: join(tmpdir(), 'iapeer-nonexistent-xyz') } as unknown as NodeJS.ProcessEnv)
    expect(scanMuteEvents({ ...paths, peerByCwd: () => 'x' }, 0)).toHaveLength(0)
  })
})

describe('muteWatchTick', () => {
  function withTranscript(): ReturnType<typeof resolveMuteWatchPaths> {
    const home = mkdtempSync(join(tmpdir(), 'iapeer-mutetick-'))
    const paths = resolveMuteWatchPaths({ HOME: home } as unknown as NodeJS.ProcessEnv)
    mkdirSync(join(paths.claudeProjectsDir, '-p'), { recursive: true })
    writeFileSync(join(paths.claudeProjectsDir, '-p', 's.jsonl'), REAL_CLAUDE_RATE_LIMIT_LINE)
    return paths
  }

  test('raises a notice the fleet surface can serve', () => {
    const paths = withTranscript()
    const board = new NoticeBoard({})
    const r = muteWatchTick({ ...paths, board, peerByCwd: () => 'probe' }, 0)
    expect(r.raised).toBe(1)
    const n = board.list()[0]!
    expect(n.personality).toBe('probe')
    expect(n.errorType).toBe('rate_limit')
    expect(n.model).toBe('Fable 5')
    expect(n.resetsAtMs).toBeUndefined()
    expect(n.summary).toBe('probe · claude — rate_limit (Fable 5)')
  })

  test('a second sweep over the SAME evidence folds instead of raising again', () => {
    const paths = withTranscript()
    const board = new NoticeBoard({})
    expect(muteWatchTick({ ...paths, board, peerByCwd: () => 'probe' }, 0).raised).toBe(1)
    expect(muteWatchTick({ ...paths, board, peerByCwd: () => 'probe' }, 0).raised).toBe(0)
    expect(board.list()).toHaveLength(1)
    expect(board.list()[0]!.count).toBe(2)
  })

  test('a throwing dependency is REPORTED, never propagated out of the tick', () => {
    const paths = withTranscript()
    const board = new NoticeBoard({})
    const errs: unknown[] = []
    const r = muteWatchTick(
      {
        ...paths,
        board,
        onError: e => errs.push(e),
        peerByCwd: () => {
          throw new Error('registry exploded')
        },
      },
      0,
    )
    expect(r.raised).toBe(0)
    expect(errs).toHaveLength(1)
  })

  test('advances the since-boundary so the next sweep starts where this one ended', () => {
    const paths = withTranscript()
    const board = new NoticeBoard({})
    const r = muteWatchTick({ ...paths, board, now: () => 999_000, peerByCwd: () => 'probe' }, 0)
    expect(r.sinceMs).toBe(999_000)
  })
})

describe('resolveMuteWatchPaths', () => {
  test('defaults to the runtimes own trees under HOME', () => {
    const p = resolveMuteWatchPaths({ HOME: '/home/x' } as unknown as NodeJS.ProcessEnv)
    expect(p.claudeProjectsDir).toBe('/home/x/.claude/projects')
    expect(p.codexSessionsDir).toBe('/home/x/.codex/sessions')
  })

  test('env overrides win (a sandboxed sweep never touches the real tree)', () => {
    const p = resolveMuteWatchPaths({
      HOME: '/home/x',
      IAPEER_CLAUDE_PROJECTS_DIR: '/tmp/sandbox/claude',
      IAPEER_CODEX_SESSIONS_DIR: '/tmp/sandbox/codex',
    } as unknown as NodeJS.ProcessEnv)
    expect(p.claudeProjectsDir).toBe('/tmp/sandbox/claude')
    expect(p.codexSessionsDir).toBe('/tmp/sandbox/codex')
  })
})
