# 04 — Lifecycle and the daemon

[Русский](ru/04-жизненный-цикл-и-демон.md) · **English**

## The router daemon

The daemon is the only continuously running core process. It has three roles:

1. **Routing** — accepts `send_to_peer`, finds the recipient in the registry, delivers.
2. **Waking** — brings up a sleeping recipient's session and delivers after the wake.
3. **Supervision** — once a minute walks the peers: sleeps the idle, notices the crashed, restarts those marked for a fresh start.

launchd holds the daemon by the plist `com.agfpd.iapeer` — separate from the peers' plists. launchd brings the daemon up at system boot and restarts it on a crash, so the router survives both a machine reboot and its own failures.

The daemon listens on two inputs at once:

- the **local socket** `~/.iapeer/state/iapeer/router.sock` (owner-only access) — for the CLI and the router runtimes;
- **TCP on loopback** `127.0.0.1:8765` — for Claude and Codex agents connected to `send_to_peer` over HTTP.

### The supervisory tick

Once a minute the daemon runs a supervisory pass. In one tick it sleeps agents idle longer than an hour; notices dead sessions and decides their fate; brings up fresh those marked for an immediate restart; and feeds the ephemeral-worker queues. A minute is the ceiling on latency for deferred work: a queue that piled up during the daemon's restart window is drained on the next tick.

## Peer states

A hosted agent is, at any moment, in one of four states:

| State | What it means | Marker in `iapeer list` |
|---|---|---|
| **alive** | the session is running and answering | `●` |
| **booting** | the supervisor is up, but this runtime hosting has not passed readiness | `◐` |
| **asleep** | no session, the peer is ready to wake on a message | `○` |
| **stopped** | the operator set a stop flag; the daemon won't wake it | `✕` |

```text
                 message
      asleep  ──────────────▶  alive
        ▲                        │
        │  stop flag cleared      │ an hour idle / crash
        │                        ▼
   stopped  ◀───────────────  alive
                stop (operator)
```

## Delivery and waking

On an incoming message the daemon looks at the recipient's state:

- **alive** — inserts into the session, confirms receipt, answers `delivered`;
- **asleep** — brings up the session, re-checks the recipient, delivers, answers `delivered, woke`;
- **stopped** — refuses and tells the sender directly.

The guarantee "`delivered` means it landed in a live session" is covered in [10 — Messaging](10-messaging.md).

### A fresh start or resuming the conversation

When bringing up a sleeper, the daemon chooses: start a **fresh** session or **resume** the prior conversation. It depends on what's waking it, the peer type, and — for agents — the **topic** of the incoming message.

Three peer types, three base behaviors: an **ephemeral worker** starts each new queued job fresh, a **human** (Telegram) always resumes, an **agent** resumes only on a matching topic. A core limit-reset nudge continues the interrupted job, not a new job: an idle-reaped ephemeral worker resumes its existing context ([19 §9](19-notices.md#9-limit-resume--a-peer-stopped-by-a-limit-continues-by-itself-after-the-reset)). The full expansion:

| What woke it | Condition | Result |
|---|---|---|
| `iapeer <runtime>` (from the folder) | — | 🆕 fresh |
| `iapeer attach` | — | ▶️ resume (error if there's nothing to resume) |
| a message | crashed / self-closed / never started | 🆕 fresh |
| a message | idle-slept, **human** peer (Telegram) | ▶️ resume (always) |
| a message | idle-slept, **agent** · topic matched a session thread | ▶️ resume |
| a message | idle-slept, **agent** · topic is new or absent | 🆕 fresh |
| a message | peer stopped (`stop`) | 🚫 not woken — explicit refusal |

The key for agents: **resume is opt-in — through the topic**. A message with no topic after idle brings up a fresh session rather than reviving old context (otherwise a session days old would wake and carry on the wrong work). To resume the right thread, the sender names its topic. Topics **accumulate**: one session can run several threads, and a ping on any of them (not just the latest) resumes it. For human peers resume is always — a topic doesn't reset them.

The lazy reset-to-fresh is **`iapeer refresh`** (see "Lifecycle commands" below): it marks a peer, and on its next natural wake it starts fresh instead of resuming — for any type, including humans-on-Telegram. So after a doctrine update the team re-reads it on its own, with no manual `/new` and no mass wake.

## Idle sleep

An agent with no activity for longer than an hour is slept on the next supervisory tick: the daemon closes the session and sets a sleep marker. Memory is freed, the conversation is saved to disk — the next message **with that work's topic** brings the agent up exactly where it stopped (without a topic, or with a new one, it's fresh — see above). The hour idle is the only time boundary: there's no "blind" lifetime TTL. The idle threshold defaults to 3600 seconds; it and the other lifecycle thresholds (boot, readiness, restart-loop protection) are tunable via environment variables — [14 — Configuration and logs](14-configuration-and-logs.md).

## Supervision and resilience

**Restart-loop protection.** The daemon keeps a ring of each peer's recent deaths. If a peer dies 3 times in 5 minutes, the daemon stops bringing it up and leaves it asleep — that's a fault signal, not a hundredth blind retry.

**Wake serialization.** Several messages may hit a sleeping agent at once; one attempt should bring it up, or two competing sessions would be born. The daemon takes a lock on waking a given peer — the rest wait for the first to be ready.

**Postmortem diagnostics.** At the moment a session dies the supervisor records its cause (exit code / signal) to a log — what an ordinary "is the process alive" check misses.

## The boundary: claude/codex vs infrastructure

The daemon manages only claude/codex agents, and only those whose plist belongs to the core. Infrastructure peers (Telegram, notifier) and any peer under a foreign launchd plist are off-limits to the daemon: it doesn't wake, sleep, or restart them. Their lifecycle is governed by launchd.

So `stop`, `start`, `new` refuse to touch foreign launchd peers — for those the core is only a reader. This guards against the core fighting launchd over process control.

## Lifecycle commands

- **`iapeer stop` / `start`** — stop (stop flag + close the session) and clear the stop. For infrastructure peers — through launchd.
- **`iapeer new`** — an unconditional fresh restart, the emergency lever for a hung or dead session; acts mechanically, around the agent.
- **`iapeer refresh <peer> \| --all`** — a lazy "soft restart": mark a peer for a fresh start on its NEXT natural wake (re-read the doctrine/fragments from disk), without killing a live session or waking the rest. Unlike `new` (an immediate hard restart), this is a deferred, unobtrusive lever: used after a doctrine release so the team refreshes on its own. The marker overrides "resume" for all peer types, including humans-on-Telegram (who otherwise resume the old session until an explicit `/new`).
- **`iapeer compact`** — compact the conversation; a sleeper is resumed first, then compacted.
- **`iapeer interrupt`** — interrupt the current turn (Escape) without losing context.
- **`iapeer self-fresh` / `self-done`** — an agent's self-calls: mark itself for a fresh restart, or quietly finish (for ephemeral workers).

### Process ownership at teardown

Closing a hosted session is a **hard teardown**, not the MCP client's graceful stdin/EOF shutdown.
Core-controlled termination first fsyncs a write-ahead `termination-request` (or a multi-target
`termination-batch`) to `<supervisorRunDir>/terminations.log`, with caller identity/UID, caller PID
and parent PID, target identity/PID/start token and reason. Failure to persist the audit refuses the
signal. Stop-all, uninstall and infra-update record their scope before the first termination.
Signals from external programs bypass this primitive: `shutdown-sigterm` in `exits.log` alone does
not identify their sender. The supervisor's JavaScript signal handler cannot recover that attribution.

The supervision process namespace is bound to `LifecycleConfig.supervisorRunDir`, not re-resolved
from an invocation's environment. A partial config without that path uses a private subdirectory of
its own `stateDir`. Under `IAPEER_TEST_SANDBOX=1`, the signal primitive also refuses the real host's
supervisor run-dir (including symlink aliases).

Readiness is specific to one hosting token. A never-ready process is not deliverable, even if its
TTY echoes input. The launcher tears it down on its readiness deadline; a later message can replace
an abandoned never-ready hosting under the wake lock. Process-control verbs can still address it.
Migration of existing agent sessions checks their current host emulator (or native control ping),
not old pane-log bytes and not merely a live PID.

Before killing the runtime, the supervisor snapshots its descendants and kills those still attached
to its controlling PTY, including stdio MCP launchers in separate process groups. Each PID's start
token and terminal are re-checked before signalling; unrelated processes and detached daemon branches
are excluded. This also applies to `self-fresh`: finish work and persist the handoff before calling it.
Processes already orphaned before the snapshot, a concurrent fork/exit race, an unreadable process
table, and shared-backend threads outside the PTY are not covered by this cleanup. A shared runtime
daemon needs its own per-thread shutdown protocol; ancestry alone does not authorize killing it.

Behavior by runtime class — [08 — Peer management](08-peer-management.md); ephemeral workers — [10 — Messaging](10-messaging.md).
