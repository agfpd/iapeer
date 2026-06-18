# 08 — Peer management

[Русский](ru/08-управление-пирами.md) · **English**

The everyday operations on peers. Full command signatures with flags are in [12 — CLI](12-cli-reference.md); here — when and why to use each.

## Creating a peer: create and init

A peer can be created with two commands, and the difference between them is where the working folder comes from.

**`iapeer create <name>`** creates a peer from anywhere. The command picks the folder itself (by default `~/.iapeer/peers/<name>`, or pass `--path`), scaffolds it, and initializes it. This is the main way.

```bash
iapeer create assistant --runtime claude
iapeer create reviewer --runtime codex --description "Code and architecture review"
iapeer create helper --path ~/projects/helper --runtime claude
```

**`iapeer init`** turns the current (or a given) folder into a peer. Handy when a peer already has its own project folder and you want `.iapeer/` to appear right inside it.

```bash
cd ~/projects/myagent
iapeer init
```

The peer name is taken from the folder name (the normalized `basename` — `myagent`); there's no separate flag for the name — to name a peer otherwise, rename the folder. The runtime is detected automatically from the installed ones (Claude/Codex), and set with `--runtime` when needed.

In essence `create` is "pick/create a folder, then `init`". Both commands perform the same peer setup:

- write the profile `peer-profile.json`;
- enter the peer into the registry;
- set up the connection to the daemon over MCP (so the agent gets `send_to_peer`);
- create the doctrine file `IAPEER.md` to be filled in;
- if the memory slot is claimed — attach shared memory and do the related runtime setup.

No-clobber protection: if another peer already lives in the target folder (a different name in the profile), the command refuses rather than overwrite.

The `--no-bootstrap` flag creates a peer without starting its service (relevant for infrastructure peers, which otherwise come up under launchd right away).

## Reviewing peers: list

```bash
iapeer list           # a table
iapeer list --json    # machine-readable format
```

Each line is a peer, its runtimes, and the state of each: `●` alive, `○` asleep, `✕` stopped. Run in an interactive terminal, `list` opens a control panel (arrows to navigate, Enter to attach, `/` to search, `q` to quit); in non-interactive mode or with `--json` it prints a table for scripts.

## Integrity check: verify

```bash
iapeer verify          # report divergences
iapeer verify --fix    # repair
```

`verify` checks two things: profiles' conformance to the standard, and divergences between the registry and the local profiles. With `--fix` the command self-heals the registry from the profiles (and migrates profiles from the old runtime-field format to the current one along the way). It's the standard way to put the registry in order if it's gone out of sync.

## Stop and start: stop, start

```bash
iapeer stop assistant          # stop
iapeer start assistant         # clear the stop
iapeer stop --all              # stop all peers
iapeer start --all             # clear the stop on all
```

Behavior depends on the runtime class:

- **A claude/codex agent.** `stop` sets a persistent stop flag and closes the session — the daemon won't wake the peer until `start` is run. `start` clears the flag: the peer can be woken again, but **the session doesn't start right away** — the daemon brings it up on the first message.
- **An infrastructure peer.** `stop` removes the service from launchd, `start` loads it back.

You can address a specific runtime: `iapeer stop assistant codex`.

## Unconditional restart: new

```bash
iapeer new assistant
```

`new` is the emergency lever for a hung or dead session. Unlike the soft path (where a live agent reads the command itself and restarts), `new` acts mechanically, around the agent: it cleanly tears down the current session and brings up a fresh one. The command reports success only when the fresh session has actually come up and is ready. It's the rescue for when an agent is hung so badly it reads nothing.

## Lazy soft restart: refresh

```bash
iapeer refresh assistant         # mark a peer for a fresh start on its next wake
iapeer refresh --all             # mark all peers
```

`refresh` is the deferred lever for "the doctrine was updated, I want the team to re-read it, but without a jolt". It **only sets a marker**: it doesn't kill a live session, doesn't wake sleepers, doesn't do an immediate restart. The effect arrives on its own — on the peer's **next natural wake** (after a normal idle sleep, or on the next message to a sleeper): instead of resuming the prior conversation, a fresh session comes up that re-reads the doctrine and fragments from disk.

Why it's separate from `new`: `new` is immediate and hard (it tears the current work), and a bulk `new --all` would bring the whole team up at once. `refresh` is lazy and soft: it doesn't touch live work, there's no wake spike, freshness reaches each peer at its usual bring-up moment. The marker overrides "resume" for **all** peer types, including humans-on-Telegram, who otherwise resume the old session until an explicit `/new`. Routers (notifier/telegram) and absent runtimes are skipped — they have no doctrine. Using `refresh` is a deliberate operator step (e.g. after releasing an updated doctrine), not an automatic side effect.

## Removal: remove

```bash
iapeer remove assistant          # remove the registry entry
iapeer remove assistant --force  # remove even if the peer is currently alive
```

`remove` deletes a peer's registry entry. Important properties:

- **It doesn't delete the folder.** The peer's data (its `.iapeer/`, history, memory) stays on disk — `remove` clears only the registry entry. If the folder was disposable, delete it yourself.
- **It refuses a live peer.** Removing a running peer's entry would sever its session from routing. The command refuses while the peer is alive; you can override with `--force`, but it's cleaner to stop it first.
- **Idempotent.** Removing a non-existent peer isn't an error — it's a successful no-op.

The typical use is to clean up "zombie" entries left from finished disposable peers.

## Attaching to a session: attach

```bash
iapeer attach assistant
iapeer attach assistant codex    # a specific runtime
```

`attach` brings the peer up if it's asleep, resumes its prior conversation, and opens its session under the supervisor right in your terminal — like an ordinary console. Detach with `Ctrl-]` — or simply close the terminal; the session keeps running in the background either way, and `iapeer attach` reconnects you whenever you need it.

## The boundary: a foreign launchd is off-limits

The commands `stop`, `start`, `new` **refuse to touch peers managed by a foreign launchd plist** (e.g. live peers under a separate lifecycle manager). For such peers the core is only a reader: intervening would mean a fight with launchd over process control. This is a deliberate guard, not a limitation — it keeps the core from accidentally breaking what it doesn't own.
