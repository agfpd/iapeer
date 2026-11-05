# Provider failover

The core prefers the peer's default agent runtime, then its other declared agent
runtimes in declaration order. Operator-stopped endpoints never participate.
`failover: false` in the local peer profile disables automatic failover; absence
means enabled. Human/presence channels and explicitly addressed non-default
working threads retain exact routing.

## Safety boundary

Provider refusal is positive native evidence, not silence, elapsed time, a dead
socket or an unconfirmed paste. Limit, authentication and overload refusals are
eligible. A known refusal excludes that endpoint until its stated reset or a
five-minute retry interval. This does not change the configured default. Detection
uses the native mute-watch (20-second cadence); custody transfer runs before the
normal supervise/inflight/limit-resume passes (60-second cadence by default).

A Codex `usage_limit_exceeded` refusal with a stated reset also excludes other
endpoints using the same positively identified ChatGPT account until that reset.
Only a SHA-256 key of auth mode, non-secret account ID and user subject is persisted
(workspace IDs alone may be shared by different users). Unknown
auth identity remains endpoint-only; different accounts are independent. This
account park affects endpoint selection only, not custody, session quarantine,
idle holds or continuation nudges. Auth changes after the refusal cannot attribute
historical evidence to the new account.
The auth file must predate the matching native session's creation as well as its
refusal; a login/refresh during that session leaves account attribution unknown.
Currently this requires unambiguous file-based ChatGPT auth; keyring, API-key,
custom-provider and inline profile/config overrides remain endpoint-only.
Lifecycle `account-park` records the account hash, `resetAt` and the current list
of affected peers (`blocked_peers`). Selection expires at the stated reset;
`account-park-cleared` records that expiry on the next supervisor tick, without
waking those peers. These are operator diagnostic events, not owner notices.

An accepted task may transfer only after the failed hosting has ended and the
complete evidence from its input through the refusal proves no model/tool work
started. Missing, truncated or ambiguous evidence is not permission to replay.
The proof currently reads at most 16 MiB of a complete native file, binds a unique
task marker to native input, and rejects unknown bootstrap hooks/queued input or
intervening model output. Oversized files remain unverified, not implicitly safe;
a bounded tail can still attribute their latest input and authorize a state-review
handoff, never replay of the original instruction.

Several messages may fail between detector sweeps. Endpoint health uses the newest
error, but custody recovers each task's **own** native refusal by its unique input
marker. A batch with no model work is transferred in receipt order, once per task;
a newer refusal never erases an older task. Native queued Claude input and Codex
`item_completed/UserMessage` input are included. Codex developer/system setup records
are input metadata, not model output; assistant/tool/reasoning items remain work.
For a Codex input steered into an existing turn, earlier model work is allowed
only when its last response has an explicit native `raw_response_completed`
receipt and no outstanding tool calls. No model items may follow the new input.
Absent/ambiguous completion produces review with
`model-work-before-queued-input`. Token usage alone is not completion evidence:
Codex also writes usage records for incomplete responses.
An interrupted task with possible effects instead produces an explicit review
notice with durable evidence; its original instruction is not replayed. The notice
names the refusal class (for example `usage_limit_exceeded`) so the receiving peer
reads a limit as a provider-side stop rather than a fault in its own work.
Review receipts include `reviewReason`, identifying the failed proof condition or
the uncertain custody/dispatch boundary; legacy receipts may lack it.

Before transferring, persist ownership and quarantine the failed native session.
The old session cannot be resumed by limit-resume, attach, capability reload or
ordinary wake. Future work on that endpoint starts fresh. Clearing a limit park
alone is insufficient: runtimes can also continue autonomously.

Transfer dispatch is durable and at-most-once: a crash in the dispatch/receipt
window requires reconciliation, not blind retry. This is not a transaction with
arbitrary external tools. Exactly-once business effects require idempotency or
result reconciliation at the tool/business layer.

## Context and recovery

Ordinary bootstrap supplies the same peer's doctrine, memory and handoffs in the
replacement runtime. A transferred unstarted task retains its original sender,
topic and attachments. Historical native evidence is retained for review rather
than injecting an entire conversation as new executable instructions.

Recovery makes the configured default eligible for subsequent messages; it does
not replay, migrate or interrupt work already assigned to a fallback. Quarantined
native sessions remain quarantined after provider recovery and daemon restart.

After an owner resets quota early, `iapeer provider-clear <peer> <runtime>` opens
that endpoint and its positively identified account for subsequent selection.
It preserves refusal timestamps (dedup), quarantine and task custody. Account
clearance is shared by the same account, not a fake recovery of every peer. A
newer refusal parks again; replay of the cleared old refusal does not. Events:
`provider-cleared` and, when applicable, `account-park-cleared reason=operator`.

## Plugin-hook trust on Codex boot

`state/lifecycle/codex-plugin-trust.json` is operator-owned host configuration:
`{"version":1,"plugins":["exact-plugin@marketplace"]}`. No wildcard or built-in
plugin names are trusted. `trust-hooks --plugin <id>` adds an exact ID and
reconciles its enabled, unmanaged plugin hooks through native app-server
`hooks/list` and `config/batchWrite`; `--check` only reads. `--plugins` processes
the configured allowlist. `--cwd <dir>` selects the discovery cwd. This can be
run after `codex plugin add/update`; the next core-owned Codex boot also checks
it. File hooks and disabled/unknown plugins are not auto-trusted by this path.
Native composite command/content hashes are used verbatim, not recomputed.
Changes emit `plugin-hook-trusted` with plugin, old hash and new hash. Discovery
or protocol failures warn at boot rather than blindly dismissing a modal.
The native trust model is documented in [OpenAI Hooks](https://learn.chatgpt.com/docs/hooks).

Automatic replacement work carries its own durable provenance: it may continue
on its assigned non-default runtime after a later limit reset, just like an
explicitly addressed task. This does not grant autonomous core maintenance notices
permission to start unrelated non-default work.

State lives under `state/lifecycle/failover/`: endpoint provider evidence,
quarantined native IDs, fresh-next barriers, task receipts and a small active
index. Receipt paths remain stable for review. Lifecycle events are
`provider-refusal` and `failover` with task ID, source, target and outcome; bodies
are not written into the lifecycle log. `[iapeer taskId=…]` on agent input is a
core custody marker, not a request for a reply or an application idempotency key.
Settled receipts are retained for seven days; active/uncertain custody and native
session quarantines are not expired by that cleanup.

## Acceptance

Use a disposable peer with genuinely invalid provider authentication, not a mock
error response. Verify a later task bypasses the known-broken endpoint, executes
once on its fallback, and is not executed by the old endpoint after credentials
are repaired. Verify stopped alternatives are excluded (including the production
`walt-trader` codex-only policy, read-only). Limit/overload proof remains pending
until a natural production event; fixture tests do not constitute live proof.
