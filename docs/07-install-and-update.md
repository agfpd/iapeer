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

`onboard` prepares the host for agents. First of all it **brings up the daemon** — loads the plist into launchd, after which launchd holds the daemon itself, bringing it back up on a crash and a reboot. No separate `launchctl` command is needed for this. Then onboard registers the extension marketplace in Claude and Codex, provisions the scheduler (`notifier`), creates a human peer on Telegram, installs the memory provider and the voice backend, and offers the menu-bar tray face (SwiftBar). The daemon start always runs; the memory/voice/notifier/telegram steps are on by default and turned off with flags (`--no-notifier`, `--no-telegram`, `--no-memory`, `--no-voice`). The **tray** is the exception — default **off** (it pulls in a GUI app via Homebrew), opted into with `--tray` on the non-interactive path or a `[y/N]` prompt in the interactive wizard; without Homebrew it degrades to a soft skip (the plugin is left in place, install SwiftBar manually with `iapeer tray install --app`).

Check the daemon is alive and the host is ready:

```bash
iapeer status
```

You'll see the core version, the daemon's health, and the memory-slot state. The exit code is non-zero if the daemon is unhealthy — handy for check scripts.

A breakdown of each onboard step is in [02 — Quick start](02-quickstart.md); runtimes and memory in detail — in [09](09-runtimes.md) and [11](11-extensions-and-memory.md).

## First-run dialogs on a clean machine

On a fresh macOS host the first install → onboard → peer launch surfaces a handful of dialogs. iapeer auto-clears the agent runtimes' own first-run modals when it brings a peer up; **three** items are yours to do.

**Auto-cleared (iapeer answers them on peer boot — you do nothing):**

- **Claude** — the theme picker ("Choose the text style"), folder-trust, external-CLAUDE.md-import, and dev-channels modals (the launcher accepts the default with Enter); the **bypass-permissions accept** screen ("WARNING: Claude Code running in Bypass Permissions mode") that a *virgin* config shows the first time `--dangerously-skip-permissions` runs — its default cursor is "No, exit", so the launcher **steps the cursor to "Yes, I accept"** and confirms (never a bare Enter, which would exit); and the **project MCP-server approval** ("N new MCP servers found in this project") when the peer's cwd carries a `.mcp.json` — pre-approved at `iapeer init` via a project-local `enableAllProjectMcpServers` flag and Enter-confirmed on boot as a backstop. Claude records each accept natively, so a re-launch on the same config is dialog-free.
- **Codex** — folder-trust ("Do you trust the contents of this directory") is pre-trusted at peer creation and also auto-accepted on boot; the self-update offer is disabled (`check_for_update_on_startup = false`) and auto-declined; hooks-review is auto-trusted.
- **Bypass / no-sandbox is the operating mode, not a one-time prompt.** The launcher runs Claude with `--dangerously-skip-permissions` and Codex with `--dangerously-bypass-approvals-and-sandbox`, so peers execute tools without per-action approval (a headless peer has no human to approve each call). The one-time *acceptance* screen above is the only interactive gate; the mode itself then stays on for every turn. See the security note in the [README](../README.md#bypass-permissions-mode) — this is a deliberate, disclosed trade-off.

**Three things you do (these cannot be automated):**

1. **Log in to the runtimes — before onboard.** Sign in to Claude Code and Codex first. Their login screen is a browser OAuth flow that no headless peer can drive, so iapeer deliberately does **not** auto-answer it; a runtime that is installed but not signed in makes a peer fail its first wake loudly. `iapeer onboard` warns when it finds an unauthenticated runtime.
2. **Login keychain password — once, during install.** The install code-signs the binary with a stable local identity so Full Disk Access survives updates; macOS asks for your login keychain password the one time that identity is created. It is expected (the installer announces it). If declined, the binary still works — TCC prompts would just recur on updates.
3. **Full Disk Access — a manual grant, no prompt.** macOS TCC cannot be set by any flag, env var, or script. Without it, a peer reading or writing a TCC-protected path (an iCloud Obsidian vault, Desktop, Documents, Downloads) silently fails with EPERM — no prompt, no hang. Grant it in **System Settings → Privacy & Security → Full Disk Access** (`~/.iapeer` itself is under `$HOME` and needs nothing); onboard prints the reminder.

Gatekeeper does not gate the locally-built CLI run from a terminal (no quarantine attribute). Verified live on a truly-virgin Claude config (claude 2.1.183): the theme picker, folder-trust, the bypass-permissions accept (cursor stepped to "Yes"), and the project MCP-server approval all auto-clear in sequence, the peer reaches its input prompt, and a second launch on the same config is dialog-free; the Codex folder-trust / update auto-clearing likewise (an owner's clean-machine install + an isolated first-boot test).

## Updating

```bash
iapeer update                   # cascade-update the WHOLE stack: core + runtimes + memory
iapeer update --foundation-only # update just the core
iapeer update 0.2.80            # pin the CORE to a specific version (core only)
iapeer update --force           # reinstall even if the version is already in place
```

A bare `iapeer update` updates the **whole host stack** in one command — the core (foundation), every installed runtime, and the memory provider — so "updated" means the whole machine, not just the core. The core goes first; the runtimes and memory follow only if the core came up healthy.

**1. Core (foundation)** — and it ABORTS the cascade on a hard failure (never update runtimes onto a broken core):

1. Learns the target version from npm. If the installed one already matches and there's no `--force` — it does nothing.
2. Downloads and builds the new binary via `npm pack`, not `npx` (the binary doesn't rebuild itself).
3. Restarts the daemon onto the new binary.
4. Restarts the infrastructure launchd jobs the core owns (`com.iapeer.*` — the `timer`, `watcher`, Telegram routers), moving them onto the just-replaced binary. It's the JOBS that restart, not the runtimes' package code — that's the next step. If the daemon didn't come up in step 3, this is skipped.
5. Verifies the daemon came up healthy — by a probe, not by the restart command exiting: it connects to the daemon's socket and counts it healthy only when it accepts a connection **twice in a row** (a single probe would also pass a daemon that bound the socket and immediately crashed). The check is given 15 seconds; on failure the command says so and advises rolling back.

**2. Runtimes** — each installed runtime package (telegram-runtime, notifier-runtime) is version-gated, re-installed, re-provisioned, and its peers restarted (via the regular stop/start — the persistent-peer fleet is refused, never forced).

**3. Memory provider** — if a provider is claimed, its own update verb runs (the provider owns its update, its slot version, and its memory-daemon restart).

Runtimes and memory are **best-effort**: a component failure is reported and the rest still run; the command exits non-zero if anything failed. Agentic peers (Claude/Codex) pick up new core doctrine lazily on their next wake.

`iapeer update --foundation-only` does just step 1 (the narrow case). A pinned `iapeer update <version>` is **core-only** by design — a version pin is core-specific (downgrade, or pin a proven version, deeper than one rollback step).

> **Upgrading from before the cascade (< 0.4.2).** The cascade is driven by the *installed* binary, so the very first `iapeer update` from a pre-cascade version runs the OLD (foundation-only) logic: it upgrades the core to the cascade-capable binary but does not yet cascade runtimes + memory. Run `iapeer update` once more — now the new binary cascades the rest. This is a one-time bootstrap; from 0.4.2 onward it is a single command. (A fresh install lands on a cascade-capable binary directly, so it never needs the double run.)

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
