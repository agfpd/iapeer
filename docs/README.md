# iapeer

[Русский](ru/README.md) · **English**

iapeer is the foundation of a multi-agent system on one host. It maintains a registry of participants, a single router daemon for messaging between them, and a set of commands to manage participants: create, start, sleep, restart, connect to external channels.

A participant in the system is called a **peer**. A peer can be an AI agent (Claude, Codex), a human (over Telegram), or a service process (a scheduler, a watcher). iapeer doesn't distinguish them by nature at the transport level — they're all addressed the same way and exchange messages over one protocol.

```text
   send_to_peer (from any peer)
        │
        ▼
   ┌────────────────────────┐
   │      router daemon       │   runs continuously
   │   find · deliver         │   reads peers-profiles.json (the registry)
   └────────────────────────┘
        │
        ▼
   recipient peer  (asleep? it'll be brought up)
```

## What it solves

When a machine hosts not one agent but a team — each with its own role, working folder, and runtime — problems arise that a single agent doesn't have:

- **Addressing.** How agent A sends a message to agent B without knowing whether B is running right now.
- **Presence.** Whether to keep every agent in memory all the time (expensive) or bring them up on demand (someone has to do the bringing up).
- **Identity.** The same logical agent may be present in different runtimes (Claude today, Codex tomorrow) — the system must understand it's the same peer.
- **Lifecycle.** Who sleeps an idle agent, who restarts a hung one, who keeps a crashed agent from entering a restart loop.

iapeer takes this on. An agent only needs to call `send_to_peer(<name>, <text>)` — the daemon does the rest: finds the recipient in the registry, checks whether it's alive, delivers into a live session or brings up a sleeper and delivers after the wake.

## Quick start

Requirements: **macOS** (process management goes through launchd), **[bun](https://bun.sh)** on `PATH`, and at least one agent runtime — Claude Code or Codex CLI.

```bash
# 1. Install the core — the binary, the ~/.iapeer layout, and the daemon plist
npx @agfpd/iapeer

# 2. Set up the host — onboard starts the daemon, registers the marketplace,
#    installs notifier, Telegram, and memory
iapeer onboard

# 3. Create your first agent
iapeer create assistant --runtime claude

# 4. Send a message — the daemon brings up the session if there's none
iapeer send assistant --message "hi, are you there?"
```

A detailed breakdown of each step — in [02 — Quick start](02-quickstart.md).

## Documentation

The sections are layered: from "install and use" to "understand the architecture and extend it".

**Introduction**
- [01 — Overview](01-overview.md) — what iapeer is and what it's made of
- [02 — Quick start](02-quickstart.md) — install, onboarding, the first peer, the first message

**Concepts**
- [03 — Peers, runtimes, identity](03-peers-runtimes-identity.md)
- [04 — Lifecycle and the daemon](04-lifecycle-and-daemon.md)
- [05 — Identity and the system prompt](05-system-prompt.md)
- [06 — Storage](06-storage.md)

**Guides**
- [07 — Install and update](07-install-and-update.md)
- [08 — Peer management](08-peer-management.md)
- [09 — Runtimes](09-runtimes.md)
- [10 — Messaging](10-messaging.md)
- [11 — Extensions and memory](11-extensions-and-memory.md)

**Reference**
- [12 — CLI](12-cli-reference.md) — all commands with flags
- [13 — Architecture and contract](13-architecture-and-contract.md) — for plugin and runtime-package developers
- [14 — Configuration and logs](14-configuration-and-logs.md) — environment variables, logs, diagnostics

## Status

Built and working: the single router daemon, the messaging protocol (IAP), the peer registry, identity and its ABI, the lifecycle (wake, sleep, restart, supervision), runtime adapters for Claude, Codex, Telegram, and notifier, host install and onboarding, Telegram connection, the memory slot, and capability plugins.

Planned on top of the foundation: a package-compatibility graph, a whole-team health doctor, and an interactive coordination interface. Until those exist, coordination operations live in the `iapeer` CLI.

## Roadmap

Larger directions, planned and not yet built:

- **Web UI** — a browser interface for working with the team.
- **Linux support** — iapeer runs on macOS today; Linux is planned.
- **More agent runtimes** — `opencode` and `antigravity`, two further CLI runtimes alongside Claude Code and Codex.
- **Discord runtime** — a human-presence runtime for Discord, alongside Telegram.
- **Permissions gate** — finer control over what an agent is allowed to do.
- **Approve permissions over Telegram** — approve an agent's permission requests from the chat; today permissions are auto-allowed by flags.

The platform for now is macOS/launchd only. Linux (systemd) and Windows support is not implemented.
