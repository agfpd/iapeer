# 12 — CLI

[Русский](ru/12-cli-reference.md) · **English**

The full list of `iapeer <command>`. General rules: `--help` / `-h` anywhere in the line prints help and runs nothing; flags take both `--key value` and `--key=value` forms.

## Core install and maintenance

| Command | What it does |
|---|---|
| `install` | Core bootstrap: build the `~/.local/bin/iapeer` binary, create the `~/.iapeer/` layout, write the daemon plist (without loading). |
| `update [version] [--force]` | Update the core from npm, restart the daemon, restart the core's infra services. With no argument — to the latest version; with a version — to the exact one. `--force` reinstalls even when versions match. |
| `rollback` | Restore the previous binary (`.prev`), restart the daemon, check health. One level back. |
| `version` · `--version` · `-v` | The installed binary's version. |
| `help` · `--help` · `-h` | Command help. |
| `daemon [--install-plist]` | Run the router (normally held by launchd). `--install-plist` only writes the plist, without loading. |

`update` checks the daemon's health after the restart: if the daemon didn't revive, the command returns a non-zero code and advises `rollback`.

## Host

| Command | What it does |
|---|---|
| `onboard [flags]` | Host setup: marketplace (Claude + Codex) → notifier → Telegram (human peer) → memory provider. All steps on by default. |
| `status` | Host snapshot: version, daemon health, memory slot. Non-zero exit code if the daemon is unhealthy. |
| `install-runtime <runtime> [--package <pkg>] [--npx] [--no-bootstrap]` | Install a runtime package and provision its declared peer set. `--no-bootstrap` — don't load peers into launchd. |
| `update-runtime <runtime> \| --all [--force]` | Update runtime package(s) with a restart of their peers. |

`onboard` flags: `--dry-run` (show without changes), `--no-notifier`, `--no-telegram`, `--no-memory`, `--telegram-human <name>`, `--telegram-user-id <id>`, `--memory <pkg>`, `--infra <list>`.

## Peers: creation and review

| Command | What it does |
|---|---|
| `init [folder] [--runtime r] [--description d] [--bin path] [--no-bootstrap]` | Make the current (or a given) folder a peer: profile, MCP, doctrine. The peer name is the folder name; not set by a separate flag. |
| `create <name> [--runtime r] [--path folder] [--bin path] [--description d] [--intelligence i] [--no-bootstrap]` | Create a peer from anywhere (by default `~/.iapeer/peers/<name>`) and provision it. |
| `list [--json]` | The peer registry with per-runtime state. In an interactive terminal — a control panel; otherwise or with `--json` — a table. |
| `verify [--json] [--fix]` | Check profiles against the standard and registry↔profile divergences. `--fix` self-heals the registry and migrates the old runtime-field format. |

## Peers: lifecycle

| Command | What it does |
|---|---|
| `stop <peer> [runtime] \| --all` | Agent: stop flag + close the session (the daemon won't wake it). Infra: remove from launchd. `--all` — all peers. |
| `start <peer> [runtime] \| --all` | Clear the stop flag (the session comes up on the first message). Infra: load into launchd. |
| `new <peer> [runtime]` | An unconditional fresh restart — the emergency lever for a hung/dead session, around the agent. Code 0 = a fresh session is up and ready. |
| `refresh <peer> [runtime] \| --all` | A lazy "soft restart": an agent peer comes up fresh (re-reads the doctrine/fragments from disk) on its NEXT natural wake. Doesn't kill a live session, doesn't wake the rest, doesn't do an immediate restart — only sets a marker. Routers (notifier/telegram) and absent runtimes are skipped (they have no doctrine). `--all` — all peers. |
| `remove <peer> [--force]` | Delete the registry entry (doesn't touch the peer's folder). Refuses a live peer without `--force`. Idempotent. |
| `attach <peer> [runtime]` | Bring up (if asleep), resume the conversation, open the session under the supervisor in the terminal (detach — `Ctrl-]`). |
| `interrupt <peer> [runtime]` | Interrupt the current turn (Escape), context intact. |
| `compact <peer> [runtime]` | Compact the conversation; a sleeper is resumed first after idle sleep. |
| `add-runtime <runtime> (--peer <p> \| --all)` | Add an agent runtime to existing peers. Doesn't touch `default_runtime`. |
| `default-runtime <runtime> (--peer <p> \| --all)` | Switch the primary runtime (routing / first bring-up). Refuses if the runtime isn't declared. |

`stop`/`start`/`new` refuse to touch peers under a foreign launchd plist — the core doesn't intervene in what it doesn't manage.

## Messages

| Command | What it does |
|---|---|
| `send <target> (--message <text> \| --message-file <f\|->) [--from <id>] [--runtime <r>] [--attachment <path>]… [--topic <t>]` | Manual IAP send over the same path as `send_to_peer`. |

`--message-file -` reads the body from stdin. `--attachment` is repeatable. `--from` defaults to the current folder's peer identity.

## Launch and runtimes

| Command | What it does |
|---|---|
| `<runtime>` (e.g. `iapeer claude`) | Launch the current folder's peer on this runtime — always as a fresh session. |
| `connect telegram <peer> [--token <t>]` | Connect a Telegram bot to a peer: register the bot → write into the profile → restart the router. Asks only for the token. |

## Extensions and memory

| Command | What it does |
|---|---|
| `enable <plugin> [peer] [--no-setup]` | Install and enable a capability plugin for a peer (across runtimes), run its setup step. |
| `native-memory <off\|on> (--peer <p> \| --all)` | Turn off/restore a peer's runtimes' native memory. |
| `trust-hooks <hooks.json> [--check]` | Pre-trust codex hooks from a file (without the modal). `--check` — a divergence report. |

## Agent self-calls

Commands an agent runs in its own session (require `PEER_IDENTITY` in the environment):

| Command | What it does |
|---|---|
| `self-fresh` | Mark itself for a fresh restart and close its session — the daemon brings up a fresh one. |
| `self-done` | Ephemeral worker: quietly finish, freeing the queue, waking no one. |

## Service

| Command | What it does |
|---|---|
| `daemon` | The router daemon's entry point; launched from the `com.agfpd.iapeer` plist. |
| `run-infra <name> <runtime>` | An infrastructure peer's entry point; launched from its launchd plist. |

These two commands are invoked by launchd, not the operator directly.
