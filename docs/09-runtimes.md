# 09 — Runtimes

[Русский](ru/09-рантаймы.md) · **English**

A runtime is a peer's mode of presence. The core knows four: `claude`, `codex`, `telegram`, `notifier`. The first two are AI agents, the last two infrastructure routers.

## Agent runtimes: claude, codex

The daemon brings an agent up on an incoming message, in a session under the pty supervisor, and closes it after an hour idle. The system prompt ([05](05-system-prompt.md)) is swapped through the runtime's standard mechanism.

**Claude** launches with the `--system-prompt-file` flag, which replaces the built-in system prompt with the text assembled by iapeer. Conversation resume goes through `--continue` (the last session is taken), not by selecting a session by id. The conversation history lives in `~/.claude/projects/<folder>/*.jsonl`.

**Codex** gets the prompt via the `model_instructions_file` setting (`codex -c model_instructions_file=<file>`), which replaces the compiled base instructions. Resume is `codex resume --last`. History is in `~/.codex/sessions/`. Codex's connection to the daemon over MCP goes through a token header: Codex gates HTTP-MCP behind a token check, so the core supplies a non-functional "empty" token (it carries no protective role), and the daemon identifies the peer by the `X-IAPeer-Identity` header.

When setting up Codex, the core host-wide silences the startup update-check dialog (`check_for_update_on_startup = false` in `config.toml`). The interactive "an update is available, press Enter" is a gate at load: a Codex session the daemon woke headless would hang on it, never reaching readiness, until a human connected. Codex updates stay manual (`codex update` or brew) rather than a prompt at startup. A value the operator already set, the core doesn't rewrite.

Launch an agent in the current folder by hand, as a fresh session:

```bash
iapeer claude     # bring up the current folder's peer on Claude
iapeer codex      # on Codex
```

Fine launch flags for a specific peer+runtime pair are set in `<folder>/.iapeer/runtimes/<runtime>/launch.env` ([06](06-storage.md)).

### Which runtime is chosen when a peer is created

When a peer is created (`create` / `init`), the primary runtime is resolved by layers:

1. An explicit `--runtime` — it's taken, but first it's checked that the runtime is installed; if not, the command finishes with a clear error rather than silently accepting a non-existent runtime.
2. Otherwise — a marker in the folder (`.claude` / `.codex`): a folder already configured for a runtime keeps it. The marker takes priority and isn't re-checked for installedness.
3. Otherwise — from those installed on the host: exactly one installed — it; none — a clear error (not a silent Claude on a host with no runtime); both installed — Claude by default (choose Codex explicitly with `--runtime codex`).

The core determines a runtime's installedness by its launcher — the `IAPEER_<RUNTIME>_BIN` variable, the native installer location, then `PATH` — and by the global config directory (`~/.claude` / `~/.codex`).

## Infrastructure runtimes: telegram, notifier

These are long-lived router processes, not AI. They run continuously under launchd; the daemon doesn't bring them up or sleep them.

**telegram** — the Telegram ↔ peers bridge. It requires the peer to be of `natural` nature (a human): an attempt to give an AI agent a Telegram presence is rejected. It runs as `telegram-runtime run`.

**notifier** — the scheduler. It provisions the service peers `timer` (fires on a schedule) and `watcher` (watches for events). It runs as `notifier-runtime run`.

Infrastructure peers' plists, unlike the daemon's plist, are **loaded automatically** on `iapeer create --runtime telegram|notifier` and on `iapeer onboard` (unless `--no-bootstrap` is passed). So no separate `launchctl bootstrap` is needed for them.

**Plist scheme (multi-infra).** One personality can carry several always-on channels (e.g. a human peer with both a Telegram bridge and a web console). Each (personality, runtime) pair resolves to its own launchd label: a **legacy base plist** `com.iapeer.<personality>` stays the channel of the runtime it already holds (no forced migration — existing single-channel hosts keep their plists untouched), while every new install gets the **per-runtime plist** `com.iapeer.<personality>.<runtime>`. Both channels are held by launchd KeepAlive simultaneously and independently; `stop`/`start <peer> <runtime>` bootout/bootstrap exactly that runtime's label, `remove` tears down **all** the personality's plists. The suffixed label can't collide with anything: peer names can't contain dots.

## Several runtimes on a peer

A peer profile has two runtime fields: `runtimes` (all the peer can be present on) and `default_runtime` (the primary — where messages route and which comes up first). Extending the options and switching the primary runtime are different commands.

### add-runtime — add a runtime

```bash
iapeer add-runtime codex --peer assistant   # for one peer
iapeer add-runtime codex --all              # for all peers
```

Adds an agent runtime to existing peers: appends it to `runtimes`, scaffolds the runtime space, and does the full Codex setup (pre-trusting the folder, the native-memory lever, attaching memory, MCP). The command **doesn't touch** `default_runtime` — this is extending options, not changing routing. Idempotent. Infrastructure peers are skipped: giving them an agent runtime is an operator decision via `create`, not a bulk operation.

### default-runtime — switch the primary

```bash
iapeer default-runtime codex --peer assistant   # for one
iapeer default-runtime codex --all              # all peers
```

Switches the primary runtime — where routing goes and which runtime comes up first. A bulk `--all` switch is exactly the "transplant" of the whole team from one agent runtime to another; it's symmetric back (`default-runtime claude --all`). The command refuses if the peer doesn't declare that runtime (run `add-runtime` first), and skips infrastructure peers. The registry is fixed in the same command, so routing switches at once.

## Connecting Telegram: connect

```bash
iapeer connect telegram assistant --token <bot-token>
```

Connects a Telegram bot to a peer in one pass: registers the bot, writes it into the peer profile, restarts the router. From a human only the token is needed (from `@BotFather`). Afterward — send the bot the **first message**: Telegram doesn't let a bot start a chat first, so the channel comes alive only after an inbound message from a human.

The command is idempotent, and behavior depends on the token. **The same token** is a clean no-op: the bot's credentials file doesn't change, the live router already runs on these credentials, no restart. **A new or changed token** requires a router restart (credentials are read only at start) — a second's pause in delivery for all Telegram peers; inbound messages aren't lost (long-polling remembers the offset, Telegram holds messages for up to 24 hours). An invalid token is rejected at once, with the verbatim reason from Telegram.

## Runtime packages

Infrastructure runtimes ship as separate npm packages (`*-runtime`). The core installs and updates them:

```bash
iapeer install-runtime notifier        # install the package + provision its peers
iapeer update-runtime notifier         # update with a peer restart
iapeer update-runtime --all            # update all runtime packages
```

`install-runtime` installs the package and provisions the peer set it declares (notifier provisions `timer` and `watcher`); the `--no-bootstrap` flag installs the package without loading its peers into launchd. A runtime with no declared set (telegram) is "operator-adds" mode: peers are set up by hand with `iapeer create <name> --runtime telegram`.

### Deploying a runtime package: always from the cloud, like `iapeer update`

A runtime package's delivery follows the same **release ≠ deploy** split as the core (see [07 — Install and update](07-install-and-update.md)). `iapeer update-runtime <runtime>` is the runtime analog of `iapeer update`: a deploy to the host **from the cloud (npm)**, not from a local working tree. It:

1. **version-gate** — compares npm-latest with the `version` stamp in the manifest (`~/.iapeer/runtimes/<runtime>/runtime.json`); latest installed → no-op (`already-latest`). With no stamp the gate is skipped and reinstall runs idempotently (and says so) — so stamping `version` in the manifest is the package's duty (otherwise both `update-runtime` gating and version observability in `iapeer status` and the per-peer version audit break).
2. **re-install** — a forced `npx @agfpd/<runtime>-runtime`: **pulls the package from npm** and lets it self-deploy the new binary + manifest. The source is the published package, **not** a working tree.
3. **re-provision** — idempotently the same path as `install-runtime` (sync descriptions, re-self-config; live peers aren't clobbered).
4. **restart** — restarts the runtime's registered peers with ordinary `stop`/`start`. They're **host-aware**: a peer under the supervisor is shut down correctly (kill the supervisor and the child) and brought back up on the new binary — no separate procedure needed.

Accordingly, **a local self-install from a working tree is a dev probe, not a deploy** (the analog of running the core from source, `bun src/...`). Deploy a runtime from the cloud: first release (`npm publish` — to the cloud, live hosts untouched), then deploy (`update-runtime` — pull from the cloud + restart). Bypassing npm (activating local code via self-install) desyncs npm and the host and isn't reproducible on a new host: a clean host brings a runtime up only from npm (`install-runtime`, then `update-runtime`). The core (`iapeer update`) deliberately does NOT touch runtime packages — the symmetry is intentional.

A runtime launcher's path resolves from `PATH` by default; override it (e.g. for launchd with a minimal `PATH`) with the `NOTIFIER_RUNTIME_BIN` / `TELEGRAM_RUNTIME_BIN` variables — see [14 — Configuration and logs](14-configuration-and-logs.md).

The runtime package contract — the manifest format, the duties, the commands — is in [13 — Architecture and contract](13-architecture-and-contract.md).
