# 01 — Overview

[Русский](ru/01-обзор.md) · **English**

iapeer keeps a team of agents on one host: it maintains a registry of participants, routes messages between them, and manages their presence. Three concepts define the whole system — peer, runtime, identity.

## Peer

A peer is a participant in the system. It's an AI agent (Claude, Codex), a human (over Telegram), or a service process (a scheduler, a watcher). At the transport level they're indistinguishable: addressed the same way, exchanging messages over one protocol.

A peer has a name (`personality`) — a short lowercase logical name (`assistant`, `code-reviewer`). The name is stable across runtimes, derived from the working-folder name, and unique: two peers can't share one name.

A peer's nature is set by the `intelligence` attribute — it travels in the envelope of every message, so the recipient knows who it's talking to with no out-of-band agreement:

| Value | Who |
|---|---|
| `artificial` | an AI agent (Claude, Codex) |
| `natural` | a human (over Telegram) |
| `absent` | a program with no intelligence (a scheduler, a watcher) |

## Runtime

A runtime is a peer's mode of presence. One peer can be present in several runtimes. By lifecycle management, runtimes split into two classes:

- **claude, codex** — AI agents. Their session isn't kept running all the time: the daemon brings the agent up on an incoming message and closes the session after an hour idle. The daemon governs this class.
- **telegram, notifier** — service router runtimes (not AI). They run continuously: the Telegram bridge accepts inbound messages at any time, notifier fires on a schedule. launchd holds them with auto-restart. These are the infrastructure runtimes; the daemon doesn't touch them.

The boundary is a split of responsibility: the daemon manages the claude/codex agents, launchd the infrastructure runtimes. That's why `stop`/`start`/`new` behave differently depending on the class.

## Identity

Identity is the address of a peer's live presence, a join of runtime and name:

```text
PEER_IDENTITY = PEER_RUNTIME + "-" + PEER_PERSONALITY
```

The agent `assistant` on Claude is `claude-assistant`, the same one on Codex is `codex-assistant`: one name, different identities. Parsing goes by the first dash (a runtime name has no dashes, a peer name may), so `claude-code-reviewer` is the runtime `claude` and the peer `code-reviewer`.

Three values — `PEER_PERSONALITY`, `PEER_RUNTIME`, `PEER_IDENTITY` — are passed into the session's environment. By them any component knows its own name and on whose behalf it acts. Details — [03 — Peers, runtimes, identity](03-peers-runtimes-identity.md).

## Components

```text
┌──────────────────────────────────────────────────────────────┐
│  CLI  iapeer <command>                                         │
│  create · list · send · stop/start · new · connect · enable …  │
└───────────────┬──────────────────────────────────────────────┘
                │
┌───────────────▼───────────────┐     ┌──────────────────────────┐
│  Router daemon (runs 24/7)     │     │  Peer registry            │
│  • accepts send_to_peer        │◀───▶│  ~/.iapeer/               │
│  • finds the recipient         │     │  peers-profiles.json      │
│  • delivers / wakes            │     └──────────────────────────┘
│  • supervises peers            │
└───────────────┬───────────────┘
                │ wakes / sleeps
┌───────────────▼───────────────────────────────────────────────┐
│  Runtime adapters                                              │
│ claude · codex (pty supervisor) │ telegram · notifier (launchd)│
└────────────────────────────────────────────────────────────────┘
```

**The router daemon** — the only continuously running core process, under launchd. It accepts `send_to_peer` calls, finds the recipient in the registry, and delivers the message into a live session or wakes a sleeping agent. Once a minute it walks the peers: it closes sessions after an hour idle, restarts those marked for a fresh start, and keeps a crashed agent from entering a restart loop. See [04 — Lifecycle and the daemon](04-lifecycle-and-daemon.md).

**The peer registry** — `~/.iapeer/peers-profiles.json`: each peer's name, runtimes, description, nature, working folder. The source of truth is each peer's own profile (`<folder>/.iapeer/peer-profile.json`); the registry is reprojected from the profiles. See [06 — Storage](06-storage.md).

**Runtime adapters** — the session-launch layer. For Claude and Codex it's a TUI session under a pty supervisor with a swapped-in system prompt; for Telegram and notifier, a long-lived router process under launchd. The adapters hide the runtimes' differences behind one interface. See [09 — Runtimes](09-runtimes.md).

**The `iapeer` CLI** — the entry point for the operator and for agents: creating peers, reviewing peers and their state, manual sending, stopping and restarting, connecting Telegram, installing extensions. See [12 — CLI](12-cli-reference.md).

## A message's path

1. The sender calls `send_to_peer(assistant, "...")` — the call goes to the daemon over a local socket or HTTP.
2. The daemon finds `assistant` in the registry and checks for a live session.
3. **Alive** — the message is inserted into the session, the daemon confirms receipt and answers `delivered`.
4. **Asleep** — the daemon wakes the session (resuming the prior conversation or starting fresh), delivers, and answers `delivered, woke`.
5. **Stopped** by the operator — the daemon refuses delivery and tells the sender directly.

A `delivered` answer means the message landed in a live session — there's normally no "for later" queue. The mechanics are covered in [10 — Messaging](10-messaging.md).

## Next

- Try it — [02 — Quick start](02-quickstart.md).
- Understand the concepts deeper — [03 — Peers, runtimes, identity](03-peers-runtimes-identity.md).
- Build an extension or a runtime package — [13 — Architecture and contract](13-architecture-and-contract.md).
