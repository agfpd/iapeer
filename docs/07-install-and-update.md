# 07 — Install and update

[Русский](ru/07-установка-и-обновление.md) · **English**

Install is two steps: lay down the core and prepare the host. You don't bring the daemon up by hand — onboarding does that. Below: both steps, plus updating the core and rolling back.

## What you need first

- **macOS.** Processes are managed by launchd — there's no other platform yet.
- **[bun](https://bun.sh)** on `PATH`. The core runs through bun; the package ships no compiled JS.
- **`~/.local/bin` on `PATH`.** The `iapeer` binary is installed here. Not on `PATH` — the command won't be found after install.
- **At least one agent runtime** — Claude Code or Codex CLI. Without it, `iapeer create` and `iapeer init` refuse with an explicit error.

## Step 1. Install the core

```bash
npx @agfpd/iapeer
```

A run with no arguments performs the install. It does exactly three things:

1. **Layout.** Creates `~/.iapeer/` with all its directories: registry, state, logs, cache, runtime spaces.
2. **Binary.** Builds `iapeer` and atomically places it in `~/.local/bin/iapeer`. The previous version stays beside it as `iapeer.prev` — a rollback reserve. Atomicity matters: between the old and new versions there's no moment when a stub sits at the path.
3. **Daemon plist.** Writes `~/Library/LaunchAgents/com.agfpd.iapeer.plist` but **doesn't load** it. Loading is taken on by `iapeer onboard` (step 2): on a running host the daemon may already be spinning, and migrating to a new binary is a deliberate act, not a side effect of install.

On install a local binary signature is created once (for macOS permissions). The signature is stable and survives updates.

The install is idempotent — a re-run is safe.

The same operation is available as `iapeer install` if the binary is already in place. But the very first time is always through `npx` or from source: a compiled binary can't rebuild itself.

## Step 2. Prepare the host

```bash
iapeer onboard
```

`onboard` prepares the host for agents. First of all it **brings up the daemon** — loads the plist into launchd, after which launchd holds the daemon itself, bringing it back up on a crash and a reboot. No separate `launchctl` command is needed for this. Then onboard registers the extension marketplace in Claude and Codex, provisions the scheduler (`notifier`), creates a human peer on Telegram, and installs the memory provider. The daemon start always runs; the rest are on by default and turned off with flags (`--no-notifier`, `--no-telegram`, `--no-memory`).

Check the daemon is alive and the host is ready:

```bash
iapeer status
```

You'll see the core version, the daemon's health, and the memory-slot state. The exit code is non-zero if the daemon is unhealthy — handy for check scripts.

A breakdown of each onboard step is in [02 — Quick start](02-quickstart.md); runtimes and memory in detail — in [09](09-runtimes.md) and [11](11-extensions-and-memory.md).

## Updating the core

```bash
iapeer update            # to the latest version
iapeer update 0.2.80     # to a specific version
iapeer update --force    # reinstall even if the version is already in place
```

An update pulls the core version from npm and restarts the daemon onto it. Step by step:

1. Learns the target version from npm. If the installed one already matches and there's no `--force` — it does nothing.
2. Downloads and builds the new binary. This is done via `npm pack`, not `npx`: the binary doesn't rebuild itself.
3. Restarts the daemon onto the new binary.
4. Restarts the infrastructure launchd jobs the core owns (`com.iapeer.*` — the `timer`, `watcher`, Telegram routers), moving them onto the just-replaced binary. Their plists launch the same core binary as the daemon — without a restart a job would stay on the old code. It's the job that's restarted (booted out and back in); the runtimes' **package code** (telegram-runtime, notifier-runtime) is not updated by this — that's the separate `update-runtime` operation. The memory provider (`iapeer-memory`) and ordinary peers' plists aren't touched at all. If the daemon didn't come up in step 3, this step is skipped — no point moving jobs onto a binary the daemon didn't revive on.
5. Verifies the daemon actually came up healthy — not by the restart command exiting successfully, but by a probe: it connects to the daemon's socket (the one the daemon opens right before the readiness signal). The daemon counts as healthy only when the socket accepts a connection **twice in a row** — a single probe would also pass for a daemon that bound the socket and immediately crashed. The check is given 15 seconds; if a run of successful probes doesn't accumulate in that time, the command says so directly and advises rolling back.

An update touches **only the core**. The daemon plist and third-party packages stay as they are.

Naming a specific version (`iapeer update <version>`) is useful when you need to roll back deeper than one step, or pin a proven version.

## Rollback

```bash
iapeer rollback
```

Restores the previous binary (that `iapeer.prev`), restarts the daemon onto it, and checks health. Rollback goes **one level back** — one previous version is kept. It's a local "undo the last update" while a fixed version is published to npm. To go deeper — `iapeer update <version>`.

## If the daemon didn't come up after an update

The sign — `iapeer status` shows an unhealthy daemon, or `update` finished with a warning. The order of action:

```bash
iapeer rollback                         # return to the prior binary
# if the daemon is still down — bring it up by hand:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agfpd.iapeer.plist
iapeer status                            # confirm it's revived
```
