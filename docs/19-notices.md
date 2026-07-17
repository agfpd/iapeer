# 19 — Notices: telling the owner a peer went mute

A peer can fail in a way that leaves it **alive, healthy by every signal the daemon has, and
unable to say a word**. Nobody inside that session can report it — that is precisely what
broke. So the daemon reports it, on the owner's own surfaces, by the same principle an
approval request travels.

This note is the normative contract for the daemon side and for any face that renders
notices. Client obligations are in §4.

## 1. Why a notice is not an approval

The approval broker (docs/17) and the notice board look alike and are not.

| | Approval | Notice |
|---|---|---|
| Direction | request → decision → unblock | one-way |
| Someone waits | yes — a hook long-polls, a tool is blocked | no |
| A human must act | yes, or a timeout default-denies | no — it is information |
| Faces can write | `POST …/approve` \| `…/deny` | nothing to write; **read-only** |
| Lifetime | until answered or timed out | until TTL |

Reusing the broker would drag a promise/timeout/fail-safe-deny machine into a problem with
none of those, and would invite a face to "resolve" something that has no resolution.

What the two DO share is the **surface**: a durable log tailed into the fleet SSE stream, an
additive snapshot field, and a GET endpoint for the verbatim content. A face that already
renders approvals renders notices with the same plumbing.

## 2. The signal: `peer-mute`

The first notice kind (§2a adds `peer-goal-stalled`). It means: *a structural API error left
this peer unable to answer.*

The daemon does not infer this from silence — silence is unfalsifiable. It reads the fact
**structurally** out of the runtime's own session file. Neither runtime is scraped from the
pane: the refusal there is prose that line-wraps, while both runtimes write the fact as data.

### claude — the transcript

`~/.claude/projects/<slug>/<sessionId>.jsonl`, on the line the runtime wrote when it refused:

```json
{ "isApiErrorMessage": true, "error": "rate_limit", "apiErrorStatus": 429,
  "message": { "model": "<synthetic>", "content": [{ "type": "text",
    "text": "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model." }] } }
```

The detector keys on **`isApiErrorMessage: true`** — the CLASS — and reports `error`
verbatim as `errorType`. `rate_limit` is one value; `overloaded`, an expired auth and any
future member arrive on the same field and take the same path. `error` is a locale-stable
enum, so no prose is matched.

### codex — the rollout

`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. **The primary signal is the death
fingerprint, established on the real incident of 17.07.2026** (quota genuinely exhausted,
both codex peers mute; forensics: `docs/internals/forensics/model-limit-2026-07-17/`). The
rollout records **no error event**; what the refused API call leaves instead is:

```json
{ "payload": { "type": "token_count",
    "info": null-or-cumulative-totals-UNCHANGED,
    "rate_limits": { "limit_id": "premium", "primary": null, "secondary": null,
      "credits": { "has_credits": false, "unlimited": false, "balance": "0" },
      "rate_limit_reached_type": null } } }
{ "payload": { "type": "task_complete", "last_agent_message": null, "completed_at": 1784309462 } }
```

The detector requires the CONJUNCTION: both windows null AND no new usage recorded (`info`
null in a fresh session, or cumulative totals identical to the previous `token_count` — a
refused call consumes nothing) AND the turn closes with `task_complete{last_agent_message:
null}`. Each conjunct is load-bearing: a lone null-window snapshot occurs transiently while
the turn SURVIVES (measured 10.07.2026 — totals advanced, the turn lived on), and a
message-less `task_complete` alone is an absence, not a signal (§8). The event time is
`completed_at` (the original epoch) — never the line timestamp, which a session resume
REWRITES when it replays history into a fresh rollout (measured 16.07: a 14:31:58 death
re-recorded at 18:49:23).

`errorType` is `usage_limit_exceeded` — codex's own error-code vocabulary (0.144.1 binary) —
when the tail holds a window at `used_percent ≥ 100` (the evidence this is the usage-limit
class); that window's `resets_at` becomes the notice's reset. Without such evidence the
honest fallback is `api-refusal` and no reset is invented. The model comes from the dead
turn's own `turn_context` (real bytes name it: `gpt-5.6-sol`).

`rate_limit_reached_type` non-null is KEPT as a forward-compat second path — but the real
incident **refuted it as the primary signal**: with the quota exhausted and turns dying, it
stayed `null` in every snapshot of every rollout. When it does fire, the detector keys on
**non-null**, never on the variant strings (`rate_limit_reached`,
`workspace_owner_usage_limit_reached`, … — read out of the 0.144.1 binary).

## 2a. The signal: `peer-goal-stalled` (codex only)

The second notice kind. It means: *this peer's pinned objective stopped being worked, and
will not resume on its own.* Same class as `peer-mute` — peer alive, every health signal
green, nobody told — different evidence and a different cause.

**What the harness is.** Codex 0.144.x pins an objective to a thread (`create_goal`) and then
continues it AUTOMATICALLY: when the thread goes idle it injects a synthetic
`<codex_internal_context source="goal">` user message and runs another turn. iapeer owns no
part of this and writes nothing into it.

**Why it stalls.** `ext/goal/src/extension.rs::on_turn_error` maps every terminal turn error
that is not a usage limit to `ActiveGoalStopReason::TurnError`, which `ext/goal/src/runtime.rs`
writes as status `blocked`. That is the **only** path that reaches `blocked` without the model
calling `update_goal`. Once the status leaves `active`, `clear_active_goal()` runs and
automatic continuation stops **permanently**: the objective is abandoned while the peer stays
healthy and keeps taking unrelated turns.

**Where the truth is — the state DB, not the rollout.** Unlike `peer-mute`, this fact is *not*
in the session file. A live capture (16.07.2026, `zapret2-oneclick`, thread `019f6709…`) holds
exactly one `thread_goal_updated` event in 1971 rollout lines — the `active` one at resume —
and **none** for the transition to `blocked`. The transition exists only in codex's goal store:

```
~/.codex/goals_<n>.sqlite   thread_goals(thread_id, goal_id, objective, status,
                                         token_budget, tokens_used, time_used_seconds,
                                         created_at_ms, updated_at_ms)
~/.codex/state_<n>.sqlite   threads(id, cwd, …)     ← the only place a thread's cwd lives
```

Both are read **read-only**, and the filename generation is globbed (highest `_<n>` wins) —
`state_5` says codex has rolled it before, so a pinned literal name would silently read a
stale DB the day it rolls again. Attribution is the §6 rule unchanged: `thread_id` → `cwd`
(state DB) → personality (registry). A thread whose cwd is no peer's is a human's own codex
and is never notified.

**The reported statuses** are codex's own values, verbatim on `errorType`:

| status | meaning | notified |
|---|---|---|
| `blocked` | a turn error stopped continuation | **yes** |
| `usage_limited` | a usage wall stopped continuation | **yes** |
| `budget_limited` | the token budget stopped continuation | **yes** |
| `active` | being worked | no — healthy |
| `complete` | the model proved it done | no — success is not news |
| `paused` | the human's own choice | no — his own click is not news |

`blocked` and `usage_limited` stay distinct rather than flattening into one "stalled": they
are different facts with different remedies, and they carry different dedup identities.

**One-shot without a state file.** A stalled goal's row is never touched again — its
accounting is `ActiveOnly`, measured live: through 17 further minutes of turns the blocked
row's `tokens_used`/`updated_at_ms` stayed frozen at the block instant. So `updated_at_ms` is
a stable *transition* clock, and the `updated_at_ms > since` boundary fires exactly once and
then falls behind forever. A goal blocked while the daemon was down is missed — the same
honest boundary `peer-mute` already has (§7).

**Only the peer's CURRENT thread counts.** `thread_goals` is keyed by thread_id, so a thread the
peer has abandoned keeps its last goal row forever. Measured live 16.07.2026: a peer escaped a
blocked goal the only way its tools allowed — a fresh session — and ended up with two rows,
`blocked` on the dead thread and `active` on the live one. Reporting the fossil would tell the
owner an objective is stalled while the peer is working it. So a goal is attributed only on the
cwd's newest thread (`recency_at_ms`); a fossil is silent.

### Recovery — `iapeer goal <peer> <resume|clear|pause>`

A notice states a fact the peer cannot state. For `peer-goal-stalled` the owner then hits a second
wall: **the peer cannot fix it either.** Codex splits goal control, and the model's half has no
exit — `update_goal` may only mark complete|blocked ("pause, resume, budget-limited, and
usage-limited status changes are controlled by the user or system"), and `create_goal` is refused
while a goal is unfinished. An agent peer whose goal blocks can only lie (mark an unachieved
objective `complete`, which its own prompt forbids) or restart its session and lose the thread.

The transition out exists — it is human-only. The TUI's `/goal [<objective>|clear|edit|pause|
resume]` calls `thread/goal/set`, an unconditional upsert that sets Active from any status, and
`thread_goal_actions.rs` treats `Paused | Blocked | UsageLimited` as resumable. The daemon is the
peer's keyboard, so the verb presses it:

| sub | effect |
|---|---|
| `resume` | the SAME goal, `blocked` → `active`; codex resumes injecting its own continuation turns |
| `clear` | the goal is removed ⇒ the peer's OWN `create_goal` stops being refused — the supported route to a *new* objective, authored by the agent rather than by us |
| `pause` | operator park |

`/goal <objective>` is deliberately NOT offered: replacing an unfinished goal opens a "Replace
goal?" modal, and blind-typing past a modal is how the wrong option gets picked. Subcommands are a
closed whitelist — caller text is never interpolated into a keystroke stream. A claude peer returns
`unsupported` (it has no thread goals; `/goal` would land as literal text in its composer).

**Success is gated on codex's goal store, never on keystrokes being accepted** — a pty write proves
the bytes left us, not that the TUI acted (§the delivery contour learned this the hard way). The
verb reads the goal row before and after and reports the transition it can see; a session that took
the text but never acted returns `unchanged`, not success. iapeer only ever READS codex's sqlite.

Verified live 16.07.2026 on a real codex peer: `blocked → active` in ~1 s, same `goal_id`, same
thread, no self-fresh, and auto-continuation genuinely resumed.

## 3. What the owner is told — and what is deliberately withheld

A notice states who, which runtime, which error type, which model, and when the wall lifts.
Two of those are **absent by design rather than guessed**:

- **`resetsAtMs` on claude.** Claude does not say when a per-model bucket lifts. Its
  `errorDetails` is a raw 429 reading *"Please try again later"* — no stamp. The 5h/7d
  `resets_at` in the statusline blob belongs to a **different limit** and must never be
  substituted: measured live on 15.07.2026, the 5h bucket sat at **11 %** and the 7d at
  **66 %** while fable was fully exhausted. Codex does state its reset, so its notices carry
  one. The asymmetry is real and stays visible.
- **`model` on codex.** The rollout snapshot names no model. Claude names it only in prose,
  so it is lifted from the runtime's own sentence when no real model reply precedes the
  error; a miss omits the field.

Absent field ⇒ *the runtime did not say*. Never ⇒ *there is no limit*.

`content` is the runtime's **verbatim** refusal for claude. For codex the rollout carries no
prose, so `content` is rendered from its typed fields (both windows, their percentages and
resets, the plan) — data, never our interpretation of the cause.

## 4. Fleet API

### `GET /fleet/v1/notices`

```json
{ "api": 1, "version": "0.4.93", "ts": "2026-07-15T21:10:00.000Z", "notices": [ { … } ] }
```

### `GET /fleet/v1/notices/<id>`

```json
{ "api": 1, "version": "0.4.93", "ts": "…", "notice": { … } }
```

404 when the id is unknown or its TTL has passed. There is **no** POST on either route — see §1.

### The notice object

| field | type | notes |
|---|---|---|
| `id` | string | `n1`, `n2`, … Unique while live; **not** stable across a daemon restart. |
| `personality` | string | the affected peer |
| `runtime` | string | `claude` \| `codex` |
| `kind` | string | `peer-mute` \| `peer-goal-stalled` (codex only). **Treat unknown kinds as renderable** — new kinds ride this surface. |
| `errorType` | string | the runtime's OWN value (`rate_limit`, `overloaded`, `rate_limit_reached`, …; for `peer-goal-stalled` the goal status: `blocked` \| `usage_limited` \| `budget_limited`). Free-form: do not switch exhaustively. |
| `model` | string? | **absent** when the runtime did not name it (always absent on `peer-goal-stalled` — the goal store names no model) |
| `resetsAtMs` | number? | epoch-ms; **absent** when the runtime did not state it → render "unknown", never substitute |
| `summary` | string | one line, e.g. `boris · claude — rate_limit (Fable 5)`, `zapret2-oneclick · codex — goal blocked: <objective>` |
| `content` | string | verbatim (claude) / rendered from typed fields (codex, both kinds) |
| `sessionId` | string? | correlates with the on-disk transcript. On `peer-goal-stalled` this is the codex **thread id** — the rollout's `session_meta.session_id`. |
| `createdMs` | number | when the notice was raised (board clock — the TTL anchor) |
| `lastMs` | number | when the latest occurrence was folded in (board clock). A sweep that merely re-reads an already-counted event does not move it. |
| `expiresMs` | number | TTL boundary |
| `count` | number | distinct OCCURRENCES folded in (≥1) — how many times the peer actually hit the wall. Render as `×N`. The sweep window overlaps on purpose, so the same runtime event is re-read across passes; the board discriminates on the event's own timestamp, and a re-read never bumps this. |

### Snapshot

`GET /fleet/v1/snapshot` carries `notices?: FleetNotice[]` — the same items, so a client that
already fetches the snapshot on every event needs no extra call. **ADDITIVE and omitted when
the board is empty**: absence ⇒ empty board (the same rule as `approvals`).

### Events (SSE)

`notices.log` is one of the tailed durable logs, so `GET /fleet/v1/events` pushes:

```
ev=notice-raised id=n1 personality=boris runtime=claude kind=peer-mute error_type=rate_limit
  model="Fable 5" session=… summary="…" created=… expires=…
```

`resets_at` + `resets_at_iso` appear **only** when the runtime stated a reset. At-least-once;
ignore unknown `ev` kinds as always.

### Client obligations

1. **Render, never resolve.** No approve/deny.
2. **Absent `resetsAtMs` ⇒ unknown.** Never substitute the 5h/7d reset — different limit.
3. **Absent `notices` ⇒ empty board.**
4. **Unknown `kind` / `errorType` ⇒ still render.** Both are growth seams.
5. **Do not key on `id` across daemon restarts** — the board is in-memory; a restart
   re-detects from the on-disk evidence and issues new ids.
6. **On startup, seed the board SILENTLY.** Whatever is already live when your face comes up
   is history: mark it seen and deliver none of it. Deliver only notices raised *while you
   were running* — i.e. whose `createdMs` is later than your own start.

#### Why obligation 6 exists, and what it costs

A notice is one-way: nobody is waiting on it, nothing unblocks. So a face restart is an event
in the **face's** life, not news about the fleet — and re-announcing the live board because
*you* redeployed tells the owner nothing he did not already know. It is your deploy, buzzing
his phone.

This is not hypothetical: on 15.07.2026 a telegram-runtime deploy re-delivered all five live
cards; the web-runtime, from the same board and the same version of this document, seeded
silently. Neither face was wrong — **the contract was silent, so each guessed, and they
guessed differently.** That is what this obligation ends.

**The cost, named:** a notice raised while your face was DOWN is never delivered by you.
Accepted, because it is bounded and self-healing:

- if the peer recovered during your downtime, the notice was moot — there was nothing to act on;
- if the peer is **still** broken, the board re-raises a FRESH notice when the TTL expires
  (§5). Its `createdMs` is then later than your start, so you deliver it. The worst case is a
  delay of one TTL, not a permanent loss.

**Approvals are the OPPOSITE — do not copy this rule across (docs/17).** A pending approval
has a human on the other end and a ≤300 s default-deny deadline: a face that starts up and
stays quiet about it lets the request time out into a denial. So approvals *are* delivered on
startup. The discriminator is not which surface you are, it is **whether anything is blocked
waiting on a human**. Notices block nothing; approvals block a peer's tool call.

**Implementation:** record your start time at boot and compare `createdMs`. No persisted
seen-set is needed, and it stays correct across a daemon restart — a restarted daemon
re-detects from the on-disk evidence and stamps newer `createdMs`, so genuinely current
conditions are delivered rather than suppressed.

## 5. Dedup and TTL — one mechanism

A mute peer re-emits its error on **every** attempted turn. So a notice carries a dedup key —
`personality | runtime | kind | errorType | model` — and while a notice with that key is live,
a repeat detection only bumps `count` and `lastMs`: **no new id, no new log line, no new SSE
event**. The owner sees one card saying `×7`, not seven cards.

`count` means **occurrences, not sweeps**. The sweep window deliberately overlaps (so an event
landing between two passes is never missed), which means the same transcript line is re-read on
the next pass. The board therefore discriminates on the runtime event's OWN timestamp: a re-read
of an already-counted event folds silently and bumps nothing. Without that, two real refusals
would render as `×3` — a number the owner cannot check and that we would have made up.

When the TTL passes (`IAPEER_NOTICE_TTL_MS`, default 1 h) the notice expires silently. If the
peer is still broken, the next detection raises a **fresh** notice — a deliberate periodic
reminder rather than one card that scrolls away forever. Expiry is not an event: either the
peer recovered (nothing to say) or it is still broken and will re-raise.

The board is in-memory; `notices.log` is the audit trace, not a recovery store. A restart
re-detects from the transcript evidence still on disk.

## 6. Detection, and why paths are not derived from `cwd`

The daemon sweeps on its own timer (`DEFAULT_MUTEWATCH_INTERVAL_MS`, 20 s — detection latency
is the product here, and the 60 s supervise tick would put the worst case at the budget with
nothing to spare). A sweep only opens files whose mtime moved since the last pass.

Attribution does not derive the path from `cwd`. It reads the cwd each file states **about
itself** (claude: the `cwd` field on every line; codex: `session_meta.payload.cwd`) and matches
it against the registry, case-insensitively. A file whose cwd belongs to no peer is ignored —
a human's own session never notifies.

The reason is that one rule must serve both runtimes: the claude slug is a naming convention we
do not own, and a codex rollout carries no cwd in its path at all (`YYYY/MM/DD/rollout-*`), so
there is nothing to derive from. Reading the file's own statement works for both.

> **Correction (15.07.2026).** This section previously justified the choice by claiming the host
> carries BOTH `-Users-macmini-Projects-IAPeer` and `-Users-macmini-Projects-iapeer` as two
> directories for one case-insensitive path. **That was false.** `readdir` lists exactly one
> (`…-IAPeer`), and both spellings `stat` to the same inode — the filesystem is case-insensitive,
> so a slug of differing case resolves correctly, and the confirm path in `transport` derives its
> slug this way and works. The claim came from reading a `grep -c` result of 2 whose second hit was
> `…-Projects-iapeer-memory`: a count was trusted instead of the entries. The design choice is
> unchanged; its stated reason is.

## 7. What is proven, and what is not

- **claude — proven live.** The transcript signal, the missing reset, the whole path
  (detector → board → fleet surface) were exercised against a genuinely exhausted fable
  bucket on 15.07.2026. Tests replay the captured line byte-for-byte.
- **codex — the 15.07 replay acceptance was REFUTED by the first real incident, and the
  detector was rebuilt on the real bytes (17.07.2026).** The original detector keyed on
  `rate_limit_reached_type` non-null — a field whose reached VALUE was synthesized at
  acceptance (honestly flagged here at the time). When the quota genuinely ran out on
  17.07.2026 the field stayed `null` through the entire incident and the detector missed
  both mute peers; the owner found out by asking. The current death-fingerprint path (§2)
  is built from and tested against the incident's verbatim bytes (four independent dying
  sessions + a negative transient + the resume-replay trap), and proven live on the real
  mute fleet. The reached path is retained as forward-compat only.
- **The blocking-window heuristic (reached path only) is unverified.** Codex does not say
  WHICH window blocked; that path reports the **fullest** one. The fingerprint path has no
  such ambiguity in practice: the real incident carried exactly one exhausted window, and
  with several the LATEST reset is reported (blocked until the last wall lifts). Windows
  ride in `content`, so a human sees the raw fact either way.
- **`peer-goal-stalled` — the state read is proven on real data; the CAUSE of one instance is
  not.** The detector was run against the live goal store on 16.07.2026 and returned exactly
  the real stall (`zapret2-oneclick`, `blocked`, goal `c25d2378…`, 09:54:32, attributed via the
  real registry), and returned nothing with the boundary at `now` — both directions on real
  bytes, not fixtures. What is **not** proven is which turn error blocked that particular goal:
  codex logged nothing in the 28 s spanning the transition and the rollout carries no error
  event. That gap does not weaken the detector, which watches the **state** and is deliberately
  cause-agnostic — it is why the notice reports codex's status verbatim and never names a cause.
- **The `blocked` mechanism itself is proven by source + live state**, not inferred from
  silence: `on_turn_error` → `TurnError` → `Blocked` is the only non-`update_goal` writer in
  the upstream tree, the model called `update_goal` zero times in the captured rollout, and the
  blocked row's counters stayed frozen through 17 further minutes of turns.

Forensic evidence for all of the above: `docs/internals/forensics/model-limit-2026-07-15/`.

## 8. Known hole: codex generic API errors — measured, not assumed

**A codex peer left mute by a cause that emits NO rate_limits snapshot is not detected.**
The usage-limit class — the actual incident class — IS covered, by the §2 death fingerprint
(the refused call's own snapshot; `rate_limit_reached_type` proved inert on the real
incident and is forward-compat only). Mute from a cause whose refusal leaves no
`token_count` at all (this section's fault-injected 429 on a custom provider left none) is
not.

This is a property of codex, not an omission here. Measured on 15.07.2026:

- **A real 429 leaves no trace in the rollout.** An isolated codex (`CODEX_HOME` on a temp
  tree, a custom `model_provider` pointed at a local endpoint — the live fleet untouched) was
  fault-injected with a genuine HTTP 429. Codex's OWN retry and error path ran and the turn
  died: `ERROR: exceeded retry limit, last status: 429 Too Many Requests`. Its rollout
  contains: `session_meta`, `task_started`, three `response_item/message`, `world_state`,
  `turn_context`, `user_message`, `task_complete`. **Zero error items.**
- **Worse: the rollout affirmatively says the turn SUCCEEDED.** It records
  `task_complete { last_agent_message: null }` for the turn that just died on a 429. The
  rollout is not merely silent about the failure — for this purpose it is wrong.
- **Corroborated across real history**: 43 real rollouts, ~6147 `token_count` events, zero
  error events of any kind; `TurnAbortedReason`'s variants (`interrupted`, `review_ended`,
  `budget_limited`, `other`) contain no API-error member; codex's own `logs_2.sqlite` holds
  exactly one ERROR row, unrelated (a model-refresh timeout).

So codex's only structural error surface is the `rate_limits` snapshot this detector already
reads. The claude/codex asymmetry in §2 is that fact, not a shortcut.

**Rejected, deliberately:** `task_complete` with `last_agent_message: null` **alone** is an
**absence, not a signal**. A detector on it by itself would fire on every turn that
legitimately produced no agent message; that is not built, and the 17.07 rebuild did not
change it. What the real incident ADDED (this probe could not see it — the custom provider
emitted no `token_count` at all) is that the real ChatGPT provider's refused call leaves a
POSITIVE artifact: the null-window, no-new-usage `token_count` snapshot. The §2 conjunction
keys on that artifact and uses the message-less `task_complete` only to scope it to a turn
that actually died. A mute from a cause that emits NO snapshot (as in this probe) remains
undetected — this hole is narrowed, not closed.

**Not answered:** whether `stream_error` — a real serde variant of codex's `EventMsg`, next to
`deprecation_notice` and `patch_apply_begin` — is persisted to the rollout. Codex filters
which `event_msg` kinds land there (`patch_apply_end` does, `patch_apply_begin` does not), and
it has never appeared in any rollout here. A mid-stream-break probe was run; codex retries a
broken stream with a long backoff and did not terminate inside the time box. **This is left
unanswered rather than inferred from the 429 result.**

**Caveat on the measurement:** the probe drove a custom `model_provider`. The real ChatGPT
provider path could in principle record something this one did not.

Artifacts (rollout, injector, config): `docs/internals/forensics/model-limit-2026-07-15/`.
