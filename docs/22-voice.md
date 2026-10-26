# 22 — Native Codex voice (`iapeer voice`)

Status: v1, 0.4.146; asleep-peer wake and migration-offer decline in 0.4.150. Implementation: `src/voice/` (engine `index.ts`, effects `deps.ts`, daemon sweep
`sweep.ts`); codex keystroke plan: `launch/adapters/codex.ts` → control `voice`.

## Purpose

Open and close codex-cli's native realtime voice conversation (`/voice`) inside a peer's LIVE codex
session on its current thread. The goal is a natural voice conversation with the fleet without
STT → agent → TTS. iapeer owns the session control, the receipts, and the idle close. Microphone
handover and wake word stay with voicetalk-runtime.

## Upstream facts (codex-cli 0.163.0, source tag `rust-v0.163.0`)

- `/voice` TOGGLES (`tui/src/chatwidget/slash_dispatch.rs` → `VoiceControl::Toggle`). `/voice stop`
  is an explicit close and a no-op when Inactive/Stopping, so it is idempotent. `/voice mute` only
  mutes the microphone: the session stays connected.
- Each voice session runs in a separate helper process, `codex-voice-host`
  (`codex-resources/voice/bin`), which holds the CoreAudio microphone and speaker. Codex terminates
  it on close.
- In a paginated-history thread (the default since 0.160) the rollout records
  `realtime_item{realtime_session_started}`, `transcript_segment{role,text}` (both sides) and
  `realtime_session_closed{outcome}`. Delegated work shows as
  `task_started{turn_attribution.turn_trigger:"realtime"}`.
- Codex has no idle timeout of its own.
- Calls go to `chatgpt.com/backend-api/codex/realtime/calls` (ChatGPT-account auth). Protocol V3;
  the default model per source is `gpt-live-1-codex`. Billing and whether a muted session is metered
  are NOT confirmed.

## Contract (consumer: voicetalk-runtime)

`iapeer voice <open|close|status> <peer> [--json]` prints one JSON line. Exit 0 iff `ok`
(`status` always exits 0).

| verb | returns after | success |
|---|---|---|
| open | `realtime_session_started` newer than the open intent, with exactly 1 helper | `{"ok":true,"state":"open","session":"<id>","already":false,"hosts":1}` |
| open (already open) | immediately; nothing is typed | `{"ok":true,"state":"open","session":"<same id>","already":true}` |
| close | the helper is gone | `{"ok":true,"state":"closed","reason":"requested",…}` |
| status | — | `{"ok":true,"state":"open|opening|closing|closed","session"?,"reason"?:"idle|user|error|requested","hosts":n,"live":bool,"idle_ms"?}` |

Invariants:
- `state:"closed"` holds only when no `codex-voice-host` exists in the peer's supervised process tree
  (audio released) and no unconfirmed open is still inside its 12 s grace.
- A timed-out open is never reported as closed by itself. The engine types `/voice stop` and returns
  `closed` only once the helper is gone; otherwise it returns `closing`.
- `/voice` (a toggle) is typed only after observing `closed`, under a per-peer lock
  (`state/lifecycle/voice/<identity>.lock`; a lock whose holder died is stolen).
- A caller killed mid-operation leaves an intent file. Status converges to the observed truth, and
  the daemon sweep finishes the reconciliation.
- open on a codex peer with no live session wakes it by ordinary warm-on-demand (no forced resume;
  the lifecycle picks fresh or resume) with a short first turn (`VOICE_WAKE_TASK`). Codex creates the
  thread's rollout lazily on the first persisted turn, and a realtime start alone does not create it.
  The open waits for that turn to end, so voice is never switched on mid-turn. This path can take up to
  ~2 min (boot + one turn); during it status reads `closed`. A live session with no materialized
  rollout is refused without typing anything.

## Idle close (daemon, every 5 s)

Applies only to sessions iapeer opened (an intent file exists). The session is idle when no
`realtime_session_started`, `transcript_segment` or turn boundary has occurred for
`IAPEER_VOICE_IDLE_SECS` (default 60) and no turn is running: waiting for requested work does not
count as idle. The sweep closes the session with `reason:"idle"`. A close that happened outside
iapeer (the human's `/voice`, a transport drop) is recorded as `user`/`error`. The lifecycle log
gets `voice-opened` and `voice-closed` events.

## Codex boot offer: model migration

A codex upgrade can raise «Meet <model> … › 1. Try new model 2. Use existing model» at startup, and it
blocks the wake. The boot-driver answers a bare `2` (Use existing model): a peer's model is the owner's
pin. Enter and Esc would both ACCEPT the switch. Without the opt-out row the screen is left to the
boot-modal fail-fast alert.

## Microphone binding

The voice helper selects the input by the exact CoreAudio device name (`voice-host/src/devices.rs`).
An unknown name fails the open with "selected audio device unavailable"; it never falls back to the
default device. `audio.*` is read from every config layer except Project, so a per-peer binding is a
session flag in the peer's codex `launch.env`. TOML `\u0020` escapes stand in for spaces because
`PEER_START_ARGS` is whitespace-split:

    PEER_START_ARGS="… -c audio.microphone="reSpeaker\u0020XVF3800\u00204-Mic\u0020Array""

`audio.microphone_channel` (1-based, unset = mix all) is available when needed. The binding takes
effect on the peer's next launch.

## Not available in 0.163 — initial request text

The TUI starts voice with `initial_items: None` (`tui/src/app_server_session/realtime.rs`) and never
sends `RealtimeConversationText`. No in-band path from outside the TUI process gives the voice model
an initial utterance, so the wake phrase's request has to be spoken again after open. Deferred.

## Known upstream limitation — identity of the voice layer

The realtime model receives codex's built-in `BACKEND_PROMPT` ("You are Codex, an OpenAI
general-purpose agentic assistant…") plus a synthesized `<startup_context>` (current thread digest,
recent work, workspace tree). It does not receive the peer's `model_instructions_file`, so it may
deny being the peer while the delegated backend turns run as the peer. The only override is the
config key `experimental_realtime_ws_backend_prompt` (it replaces the whole prompt and reaches V3
`instructions`), with `experimental_realtime_ws_startup_context` as a sibling. Upstream marks both
"Experimental / do not use". iapeer does not set them yet.
