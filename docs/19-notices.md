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

`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, in an `event_msg` / `token_count` payload:

```json
{ "rate_limits": { "limit_id": "codex", "plan_type": "plus",
    "primary":   { "used_percent": 1.0,  "window_minutes": 300,   "resets_at": 1783114795 },
    "secondary": { "used_percent": 17.0, "window_minutes": 10080, "resets_at": 1783412915 },
    "rate_limit_reached_type": null } }
```

`rate_limit_reached_type` is `null` while healthy and non-null once a wall is hit. The
detector keys on **non-null**, never on the variant strings (`rate_limit_reached`,
`workspace_owner_usage_limit_reached`, `workspace_member_credits_depleted`, … — read out of
the 0.144.1 binary), so a variant we have never seen still detects and reports itself.

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
- **codex — proven by replay, not live.** The rollout structure, windows, resets and the
  healthy (`null`) path are real bytes from this host. Codex's quota never ran out here, so
  **no real reached-bytes exist**: the tests flip that one field to a variant read out of the
  binary. The detector keys on non-null precisely so this synthesis cannot flatter it. A real
  codex reach should be captured opportunistically and folded in.
- **The blocking-window heuristic is unverified.** Codex does not say WHICH window blocked;
  the notice reports the **fullest** one. Both windows ride in `content`, so a human sees the
  raw fact even if the heuristic picks wrong.
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

**A codex peer left mute by anything other than a rate limit is not detected.** Its
rate-limit path — the actual incident class — IS covered by `rate_limit_reached_type`. Mute
from overload or an expired auth is not.

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

**Rejected, deliberately:** `task_complete` with `last_agent_message: null` is the only tell
that the turn failed — and it is an **absence, not a signal**. A detector on it would fire on
every turn that legitimately produced no agent message. Inferring "mute" from it would be the
exact plausible-inference defect this whole note exists to prevent; it is not built.

**Not answered:** whether `stream_error` — a real serde variant of codex's `EventMsg`, next to
`deprecation_notice` and `patch_apply_begin` — is persisted to the rollout. Codex filters
which `event_msg` kinds land there (`patch_apply_end` does, `patch_apply_begin` does not), and
it has never appeared in any rollout here. A mid-stream-break probe was run; codex retries a
broken stream with a long backoff and did not terminate inside the time box. **This is left
unanswered rather than inferred from the 429 result.**

**Caveat on the measurement:** the probe drove a custom `model_provider`. The real ChatGPT
provider path could in principle record something this one did not.

Artifacts (rollout, injector, config): `docs/internals/forensics/model-limit-2026-07-15/`.
