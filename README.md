# iapeer

**Host-level core for a team of AI agents on one machine.**

[![npm](https://img.shields.io/npm/v/@agfpd/iapeer)](https://www.npmjs.com/package/@agfpd/iapeer)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-macOS-lightgrey)](#quick-start)

iapeer keeps a team of AI agents, humans, and services on one host **always reachable — every one of them a single message away.** Each participant is a **peer**: a Claude Code or Codex CLI agent, a person on Telegram, or a scheduler/watcher service. Any agent reaches any other with one call — `send_to_peer(<name>, <text>)` — and a peer that is asleep is still reachable: the daemon wakes it and delivers. Agents on Claude and on Codex — different AI runtimes from different vendors — talk as equal peers; humans take part over Telegram, or directly in the terminal — attached to a peer's live session with `iapeer attach`.

## How it works

```text
send_to_peer(name, text)     ← from any peer
        │
        ▼
router daemon   — always on; finds the recipient, checks liveness, delivers
        │
        ▼
recipient peer  — asleep? the daemon wakes it and delivers on wake
```

## Quick start

Requirements: **macOS**, [bun](https://bun.sh) on `PATH`, `~/.local/bin` on `PATH`, and at least one agent runtime installed — Claude Code or Codex CLI (each AI peer is a live session of one).

```sh
# 1. install — the iapeer binary and the ~/.iapeer layout
npx @agfpd/iapeer

# 2. set up the host — starts the router daemon, then adds scheduler peers, Telegram, and shared memory
iapeer onboard

# 3. create your first agent
iapeer create assistant --runtime claude

# 4. talk to it live in your terminal — detach with Ctrl-] (or just close it; the agent keeps running)
iapeer attach assistant
```

**Already have a project folder?** In step 3, use `init` instead of `create`: `cd` into the project and register that folder itself as a peer.

```sh
cd ~/projects/myagent
iapeer init
```

The peer's name is the folder name, normalized (`myagent`). `create` sets up a fresh folder under `~/.iapeer/peers/<name>`; `init` turns the folder you are in into a peer. The setup is identical either way.

Two ways to work with an agent locally in your terminal:

- **Join its live session** — `iapeer attach assistant`. The daemon wakes the peer first if it is asleep. Detach with `Ctrl-]` — or just close the terminal — and the session keeps running in the background; reattach with `iapeer attach` whenever you need it.
- **Open a fresh session in the peer's folder** — go to the peer's directory and launch its runtime:

  ```sh
  cd ~/.iapeer/peers/assistant
  iapeer claude
  ```

  This starts a full session with the peer's identity and doctrine and drops you straight into it. In effect, `iapeer claude` is `claude` for that peer — the same interactive CLI, but the session has a stable identity, its own memory, and an address other peers can reach.

Agents reach each other with `send_to_peer`; you can also message any peer over Telegram.

## What makes it different

- **Real interactive CLI sessions, not headless one-shots.** Each AI peer is a full Claude Code or Codex CLI session, not a disposable `claude -p` / `codex exec` call (as of 2026-06-15, `claude -p` no longer counts against the subscription's main usage limits).
- **Warm-on-demand lifecycle.** A live session answers fast; after about an hour idle the daemon closes it; the next message brings it back with its context resumed. The message flow drives the lifecycle — not a human's presence.
- **One identity across runtimes, with one memory.** A peer's `personality` is decoupled from its runtime — the same peer runs on Claude or Codex, switched with a command. By default (set up by `iapeer onboard`) it carries one shared memory (iapeer-memory) keyed to the personality, not the runtime: one personality, one memory, whatever runtime it runs on.
- **Heterogeneous peers, one protocol.** AI agents, humans (Telegram), and services (timer = cron, watcher = event) are all first-class, addressed the same way over an always-on MCP daemon that exposes exactly one tool, `send_to_peer`.

## Documentation

[`docs/`](docs/README.md) — the product side: what it is and how to use it. Available in two languages — English (default) and [Русский](docs/ru/README.md). This repository is the implementation.

## Roadmap

Planned, not yet built:

- **Web UI** — a browser interface for working with the team.
- **Linux support** — iapeer runs on macOS today; Linux is planned.
- **More agent runtimes** — `opencode` and `antigravity`, two further CLI runtimes alongside Claude Code and Codex.
- **Discord runtime** — a human-presence runtime for Discord, alongside Telegram.
- **Permissions gate** — finer control over what an agent is allowed to do.
- **Approve permissions over Telegram** — approve an agent's permission requests from the chat; today permissions are auto-allowed by flags.

## License

Apache-2.0. Platform: macOS / launchd. iapeer is the foundation core of a larger ecosystem; runtime and capability plugins build on top of it.
