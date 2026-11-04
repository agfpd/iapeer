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

An accepted task may transfer only after the failed hosting has ended and the
complete evidence from its input through the refusal proves no model/tool work
started. Missing, truncated or ambiguous evidence is not permission to replay.
The proof currently reads at most 16 MiB of a complete native file, binds a unique
task marker to native input, and rejects unknown bootstrap hooks/queued input or
intervening model output. Oversized files remain unverified, not implicitly safe;
a bounded tail can still attribute their latest input and authorize a state-review
handoff, never replay of the original instruction.
An interrupted task with possible effects instead produces an explicit review
notice with durable evidence; its original instruction is not replayed.

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
