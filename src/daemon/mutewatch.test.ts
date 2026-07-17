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
// HISTORY OF AN HONEST BOUNDARY. The 15.07 acceptance had no real reached-bytes (the quota
// had never run out here), so `codexReached()` SYNTHESIZES the one field — and docs/19 §7
// said so. On 17.07.2026 the quota DID run out, and the real bytes REFUTED the synthesis:
// through a full live incident (both codex peers mute, turns dying on delivery),
// `rate_limit_reached_type` stayed null in every snapshot of every rollout. The reached path
// below is kept as forward-compat only; the REAL death fingerprint has its own fixtures —
// verbatim incident bytes — further down.
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

// ─────────────────────────────────────────────────────────────────────────────
// REAL DEATH BYTES — the 17.07.2026 incident (codex quota exhausted, doc/linus mute, owner
// found out by asking). Verbatim lines out of doc's rollout (019f70d0-…9477) and the minimal
// `codex exec` probe (019f7127-…558b); full files in docs/internals/forensics/
// model-limit-2026-07-17/. The fingerprint they establish: the refused call emits a
// token_count with BOTH windows null and NO new usage, and the turn closes with
// task_complete{last_agent_message:null}. No error event exists anywhere in the rollout.
// ─────────────────────────────────────────────────────────────────────────────

/** doc, 17:29:01Z — the last WINDOWED snapshot before death: primary 100%, resets_at present. */
const DOC_WINDOWED_100 =
  '{"timestamp":"2026-07-17T17:29:01.549Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3512591,"cached_input_tokens":3324160,"output_tokens":15042,"reasoning_output_tokens":7047,"total_tokens":3527633},"last_token_usage":{"input_tokens":98653,"cached_input_tokens":96000,"output_tokens":160,"reasoning_output_tokens":55,"total_tokens":98813},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":100.0,"window_minutes":10080,"resets_at":1784817491},"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"plan_type":"plus","rate_limit_reached_type":null}}}'

/** doc, 17:31:00Z — the dying turn opens. */
const DOC_TASK_STARTED =
  '{"timestamp":"2026-07-17T17:31:00.452Z","type":"event_msg","payload":{"type":"task_started","turn_id":"019f7121-addf-7541-8ead-f9514250701d","started_at":1784309460,"model_context_window":258400,"collaboration_mode_kind":"default"}}'

/** doc, 17:31:00Z — the dying turn's turn_context (trimmed to the fields read), verbatim values. */
const DOC_TURN_CONTEXT =
  '{"timestamp":"2026-07-17T17:31:00.458Z","type":"turn_context","payload":{"turn_id":"019f7121-addf-7541-8ead-f9514250701d","cwd":"/Users/macmini/Peers/doc","model":"gpt-5.6-sol","comp_hash":"3000","personality":"pragmatic"}}'

/** doc, 17:31:02Z — the REFUSED call's snapshot: both windows null, cumulative totals UNCHANGED. */
const DOC_REFUSAL_TC =
  '{"timestamp":"2026-07-17T17:31:02.146Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3512591,"cached_input_tokens":3324160,"output_tokens":15042,"reasoning_output_tokens":7047,"total_tokens":3527633},"last_token_usage":{"input_tokens":98653,"cached_input_tokens":96000,"output_tokens":160,"reasoning_output_tokens":55,"total_tokens":98813},"model_context_window":258400},"rate_limits":{"limit_id":"premium","limit_name":null,"primary":null,"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"plan_type":"plus","rate_limit_reached_type":null}}}'

/** doc, 17:31:02Z — the turn dies. completed_at 1784309462 is the ORIGINAL epoch (replay-stable). */
const DOC_TASK_COMPLETE =
  '{"timestamp":"2026-07-17T17:31:02.153Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"019f7121-addf-7541-8ead-f9514250701d","last_agent_message":null,"completed_at":1784309462,"duration_ms":1700}}'

const DOC_DEATH_AT_MS = 1_784_309_462 * 1000
const DOC_RESET_MS = 1_784_817_491 * 1000
const DOC_DEATH_SEQ = [CODEX_META, DOC_WINDOWED_100, DOC_TASK_STARTED, DOC_TURN_CONTEXT, DOC_REFUSAL_TC, DOC_TASK_COMPLETE].join('\n')

/** The probe (`codex exec` in /private/tmp) — a FRESH session refused outright: info is null. */
const PROBE_REFUSAL_TC =
  '{"timestamp":"2026-07-17T17:37:16.231Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"limit_id":"premium","limit_name":null,"primary":null,"secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":"0"},"individual_limit":null,"plan_type":null,"rate_limit_reached_type":null}}}'
const PROBE_TASK_COMPLETE =
  '{"timestamp":"2026-07-17T17:37:16.235Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"019f7127-54cb-76b2-b7f0-5920c8870b48","last_agent_message":null,"completed_at":1784309836,"duration_ms":5374}}'

/** 10.07.2026 — the TRANSIENT that must NOT detect: windows null but totals ADVANCED (the call
 *  succeeded; the very next rollout line was reasoning and the turn lived on). Verbatim. */
const TRANSIENT_2026_07_10 =
  '{"timestamp":"2026-07-10T14:17:02.743Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":270201,"cached_input_tokens":233984,"output_tokens":2372,"reasoning_output_tokens":1357,"total_tokens":272573},"last_token_usage":{"input_tokens":40059,"cached_input_tokens":37760,"output_tokens":443,"reasoning_output_tokens":189,"total_tokens":40502},"model_context_window":258400},"rate_limits":{"limit_id":"codex","limit_name":null,"primary":null,"secondary":null,"credits":null,"individual_limit":null,"plan_type":"plus","rate_limit_reached_type":null}}}'

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

describe('parseCodexRollout — the REAL death fingerprint (17.07.2026 incident bytes)', () => {
  test('detects the real death and every field comes from the bytes', () => {
    const d = parseCodexRollout(DOC_DEATH_SEQ, 0)
    expect(d).not.toBeNull()
    expect(d!.errorType).toBe('usage_limit_exceeded') // codex's own error-code vocab; window at 100% evidences the class
    expect(d!.model).toBe('gpt-5.6-sol') // from the dead turn's own turn_context
    expect(d!.resetsAtMs).toBe(DOC_RESET_MS) // from the exhausted window — the reset codex DOES state
    expect(d!.atMs).toBe(DOC_DEATH_AT_MS) // completed_at, not the line timestamp
    expect(d!.cwd).toBe('/Users/macmini/Peers/doc')
    expect(d!.content).toContain('primary 100%')
  })

  test('a fresh session refused outright (the probe: info null, no windowed history) still detects', () => {
    const d = parseCodexRollout([CODEX_META, PROBE_REFUSAL_TC, PROBE_TASK_COMPLETE].join('\n'), 0)
    expect(d).not.toBeNull()
    // No exhausted-window evidence in the file → the honest fallback class, and NO reset invented.
    expect(d!.errorType).toBe('api-refusal')
    expect(d!.resetsAtMs).toBeUndefined()
  })

  test('the real 10.07 transient (windows null but totals ADVANCED) does NOT detect', () => {
    // REAL_CODEX_TOKEN_COUNT establishes the previous cumulative total; the transient's differs
    // → the call consumed tokens → it was not refused, whatever its snapshot looked like.
    const text = [CODEX_META, REAL_CODEX_TOKEN_COUNT, TRANSIENT_2026_07_10, DOC_TASK_COMPLETE].join('\n')
    expect(parseCodexRollout(text, 0)).toBeNull()
  })

  test('a mid-turn refusal the turn RECOVERS from does not detect', () => {
    // refusal snapshot → a later windowed token_count (the retry succeeded) → task_complete null.
    const text = [CODEX_META, DOC_WINDOWED_100, DOC_REFUSAL_TC, REAL_CODEX_TOKEN_COUNT, DOC_TASK_COMPLETE].join('\n')
    expect(parseCodexRollout(text, 0)).toBeNull()
  })

  test('a refusal snapshot never crosses a turn boundary (docs/19 §8 stands)', () => {
    // Refusal in turn N, then task_started for turn N+1 which completes message-less WITHOUT
    // any token_count of its own (the §8 custom-provider shape) → an absence, not a signal.
    const text = [CODEX_META, DOC_WINDOWED_100, DOC_REFUSAL_TC, DOC_TASK_STARTED, DOC_TASK_COMPLETE].join('\n')
    expect(parseCodexRollout(text, 0)).toBeNull()
  })

  test('task_complete WITH a message after a refusal snapshot does not detect', () => {
    const survived = DOC_TASK_COMPLETE.replace('"last_agent_message":null', '"last_agent_message":"done"')
    const text = [CODEX_META, DOC_WINDOWED_100, DOC_TASK_STARTED, DOC_REFUSAL_TC, survived].join('\n')
    expect(parseCodexRollout(text, 0)).toBeNull()
  })

  test('an unlimited-credits account with windowless snapshots never detects', () => {
    const unlimited = PROBE_REFUSAL_TC.replace('"unlimited":false', '"unlimited":true')
    const text = [CODEX_META, unlimited, PROBE_TASK_COMPLETE].join('\n')
    expect(parseCodexRollout(text, 0)).toBeNull()
  })

  test('REPLAY protection: the event time is completed_at, so a resumed session re-recording the death does not re-raise', () => {
    // codex resume REPLAYS history into the new rollout with FRESH line timestamps but the
    // ORIGINAL completed_at (measured 16.07: a death re-recorded 4h19m later). A boundary
    // after the original death must skip it even though the line timestamps are new.
    const replayed = DOC_DEATH_SEQ.replaceAll('2026-07-17T17:31:02', '2026-07-17T21:50:23').replaceAll('2026-07-17T17:29:01', '2026-07-17T21:50:23')
    expect(parseCodexRollout(replayed, DOC_DEATH_AT_MS)).toBeNull()
    expect(parseCodexRollout(replayed, DOC_DEATH_AT_MS - 1)).not.toBeNull()
  })

  test('attributes through the tree and raises with honest summary fields', () => {
    const home = mkdtempSync(join(tmpdir(), 'iapeer-mutedeath-'))
    const paths = resolveMuteWatchPaths({ HOME: home } as unknown as NodeJS.ProcessEnv)
    mkdirSync(join(paths.codexSessionsDir, '2026', '07', '17'), { recursive: true })
    writeFileSync(join(paths.codexSessionsDir, '2026', '07', '17', 'rollout-real.jsonl'), DOC_DEATH_SEQ)
    const found = scanMuteEvents({ ...paths, peerByCwd: cwd => (cwd === '/Users/macmini/Peers/doc' ? 'doc' : undefined) }, 0)
    expect(found).toHaveLength(1)
    expect(found[0]!.personality).toBe('doc')
    expect(found[0]!.runtime).toBe('codex')
    expect(found[0]!.errorType).toBe('usage_limit_exceeded')
    expect(found[0]!.model).toBe('gpt-5.6-sol')
    expect(found[0]!.resetsAtMs).toBe(DOC_RESET_MS)
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

  // The dir name is a red herring by construction — attribution must come from the content,
  // which is what lets ONE rule serve claude (slug dirs) and codex (dateless rollout paths).
  test('attribution ignores the slug dir name entirely', () => {
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

  // The overlapping sweep window re-reads the same line by design — that must be invisible
  // to the owner: one card, and a count that still says ONE refusal happened.
  test('a second sweep over the SAME evidence neither raises again nor inflates count', () => {
    const paths = withTranscript()
    const board = new NoticeBoard({})
    expect(muteWatchTick({ ...paths, board, peerByCwd: () => 'probe' }, 0).raised).toBe(1)
    expect(muteWatchTick({ ...paths, board, peerByCwd: () => 'probe' }, 0).raised).toBe(0)
    expect(board.list()).toHaveLength(1)
    expect(board.list()[0]!.count).toBe(1)
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
