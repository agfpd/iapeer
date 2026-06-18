# 02 — Quick start

[Русский](ru/02-быстрый-старт.md) · **English**

Four steps — from an empty host to an agent you can message. Each step is one command; under it, what it does.

## Requirements

- **macOS.** Process presence is managed by launchd, so for now only macOS is supported.
- **[bun](https://bun.sh)** on `PATH`. Needed for install and updates: the package is installed from source (it ships no precompiled JS), and the `iapeer` binary is built via `bun build --compile`. The installed `~/.local/bin/iapeer` is itself a standalone binary and no longer needs bun at runtime.
- **`~/.local/bin` on `PATH`.** The `iapeer` binary is installed here. If the directory isn't on `PATH`, the `iapeer` command won't be found after install — add it: `export PATH="$HOME/.local/bin:$PATH"` in your shell profile.
- **At least one agent runtime** — Claude Code or Codex CLI. Each AI peer is a live session of one of them; if neither is installed, `iapeer create` and `iapeer init` say so with an error rather than failing silently later.

## Step 1. Install the core

```bash
npx @agfpd/iapeer
```

The call with no arguments is the install. It does three things and starts nothing:

1. Builds the `iapeer` binary and places it in `~/.local/bin/iapeer` (the previous version stays beside it as `iapeer.prev`, for rollback).
2. Creates the `~/.iapeer/` layout — directories for the registry, state, logs, cache, and runtimes.
3. Writes the daemon plist to `~/Library/LaunchAgents/com.agfpd.iapeer.plist` but **doesn't load** it — that's what `iapeer onboard` does in step 2.

The install is idempotent: a re-run updates the binary and rebuilds the layout without breaking anything.

## Step 2. Set up the host

```bash
iapeer onboard
```

`onboard` prepares the host for agents and is required: first of all it brings up the router daemon, without which messages aren't delivered. What it does, in order:

- **Daemon.** Loads the plist into launchd (idempotent) and verifies the router answers. From then on launchd brings the daemon up itself — after a crash and after a machine reboot. This starts a persistent background service, so macOS shows an "iapeer added a background item" notice — that's expected.
- **Marketplace.** Registers the agfpd extension marketplace in Claude and Codex so agents can later install capability plugins.
- **notifier.** Provisions the scheduler infrastructure runtime: the service peers `timer` (fires on a schedule) and `watcher` (watches for events) appear.
- **Telegram.** Sets up a human peer — that's you, the owner — present over Telegram. This step is interactive: you'll need your Telegram user-id.
- **Memory.** Installs the default memory provider if the slot is free.

The daemon start always runs; the rest are on by default but each can be turned off with a flag — `--no-notifier`, `--no-telegram`, `--no-memory`. To see what the command would do without changing anything:

```bash
iapeer onboard --dry-run
```

Check the daemon is alive and the host is ready:

```bash
iapeer status
```

You'll see a host snapshot: the core version, the daemon's health, the memory-slot state.

## Step 3. Create your first agent

```bash
iapeer create assistant --runtime claude
```

This is how the peer `assistant` appears, on the Claude runtime. What the command sets up:

- a working folder — by default `~/.iapeer/peers/assistant`;
- the peer profile `peer-profile.json` — name, runtimes, description, nature;
- a registry entry, so the daemon knows about the peer;
- a connection to the daemon over MCP — through which the agent gets the `send_to_peer` tool;
- a doctrine file `IAPEER.md` — the agent's role and character (a peer's `CLAUDE.md`-equivalent), which you fill in later;
- shared memory, if the memory slot is claimed.

The agent is created, but the session isn't running yet — it comes up on the first message.

`IAPEER.md` is to a peer what a `CLAUDE.md` is to a project — its instructions and character. The one in `~/.iapeer/` applies to every peer on the host; the one in a peer's folder applies to that peer alone. And any other `.md` you drop in the root of a peer's `.iapeer/` folder (or the host's `~/.iapeer/`) rides into the system prompt too — so you can hand an agent extra context just by adding a file. Details in [05 — Identity and the system prompt](05-system-prompt.md).

You can also create an agent from its working folder, with no path, using `iapeer init`. The difference between `create` and `init` is covered in [08 — Peer management](08-peer-management.md).

**Want the agent to reply in Telegram?** Connect a bot to it and you message the agent from the messenger — see the [telegram-runtime quickstart](https://github.com/agfpd/telegram-runtime/blob/main/docs/02-quickstart.md).

## Step 4. Send the first message

```bash
iapeer send assistant --message "hi, are you there?"
```

There's no live session yet, so the daemon brings one up and delivers the message. In reply you'll see `delivered to assistant (claude)` — or `queued …` if the agent turned out to be busy.

See which peers exist and who's alive right now:

```bash
iapeer list
```

Each line is a peer, its runtimes, and its state: `●` alive, `○` asleep, `✕` stopped.

Join an agent's session live, like an ordinary terminal:

```bash
iapeer attach assistant
```

The session opens under the supervisor; detach with `Ctrl-]` — or just close the terminal. Either way the session keeps running in the background, and you reattach with `iapeer attach` whenever you need it.

## What's next

The basic loop is closed: the host is ready, the agent is created, the message is delivered. From here, by task:

- What happens on wake and sleep — [04 — Lifecycle and the daemon](04-lifecycle-and-daemon.md).
- Fill in the agent's role and understand the system prompt — [05 — Identity and the system prompt](05-system-prompt.md).
- Connect an agent to Telegram, add a second runtime, switch all peers to another runtime — [09 — Runtimes](09-runtimes.md).
- Install an extension or memory for an agent — [11 — Extensions and memory](11-extensions-and-memory.md).
