# 11 — Extensions and memory

[Русский](ru/11-расширения-и-память.md) · **English**

A peer's capabilities are extended by two kinds of package: capability plugins (abilities — tools, context) and runtime packages (modes of presence). Memory is a separate mechanism: one provider per host, through a slot. This section is how to use these; the contract for package developers is in [13 — Architecture and contract](13-architecture-and-contract.md).

## Capability plugins: enable

A plugin adds an ability to a peer without being a runtime — shared memory, speech synthesis, a set of skills. Attaching it:

```bash
iapeer enable peer-voice assistant      # attach a plugin to a peer
iapeer enable iapeer-memory             # to the current folder's peer
iapeer enable peer-voice assistant --no-setup   # without the plugin's setup step
```

The command installs the plugin on each of the peer's agent runtimes (for Claude — into the project scope inside the peer's folder, for Codex — into the host's shared config), enables it, and, if the plugin declares a setup step, runs it. The operation is idempotent and doesn't disturb other peers: for Claude the binding is by the specific peer's folder.

A runtime's local marketplace snapshot may lag: a plugin registered in the marketplace after the host's last sync reads as an "unknown plugin" until then. So if the install doesn't go through the first time, `enable` refreshes the runtime's marketplace snapshot (Claude — `marketplace update`, Codex — `marketplace upgrade`) and retries once.

## The memory slot

Memory in iapeer is a first-class option, not a built-in feature. It's provided by a **memory provider** — a separate package that claims the single per-host slot. The slot is either occupied by exactly one provider or empty; an empty slot is a normal state.

The default provider is installed at onboarding:

```bash
iapeer onboard                       # installs the default provider if the slot is empty
iapeer onboard --memory <package>    # specify a different provider
iapeer onboard --no-memory           # leave the slot empty
```

The slot state is shown by `iapeer status` — the provider name, version, and the freshness of its daemon (or `none` if the slot is empty).

The reference provider is **iapeer-memory** (`@agfpd/iapeer-memory`), also the default. It's the team's shared memory: a knowledge canon (knowledge, decisions, ideas, projects, lists) and each agent's personal operative memory, with search over content and the link graph. Memory reaches an agent two ways — a map of its notes lands in the system prompt as a fragment layer ([05 — System prompt](05-system-prompt.md)), and it reads and writes through the provider's MCP tools. Details — in iapeer-memory's own documentation.

When the slot is claimed, the core calls the provider's commands at a peer's life events: at peer birth (`birth`) — to set up its memory, at removal (`remove`) — to wind it down. The provider manifest format, the commands, and the call moments — in [13](13-architecture-and-contract.md).

### A runtime's native memory

Claude and Codex have their own built-in memory. When the slot is occupied by a provider, keeping the runtime's native memory in parallel is harmful — a second, uncurated set accumulates. So at the birth of a peer with a claimed slot, the core automatically turns off its runtimes' native memory.

To manage this by hand:

```bash
iapeer native-memory off --peer assistant   # turn off native memory
iapeer native-memory on --peer assistant      # restore it
iapeer native-memory off --all               # across all peers
```

## Runtime packages

Modes of presence (Telegram, the scheduler) ship as runtime packages:

```bash
iapeer install-runtime notifier      # install + provision the declared peers
iapeer update-runtime --all          # update all runtime packages
```

`install-runtime` installs the package and provisions the peer set it declares (notifier — `timer` and `watcher`). A runtime with no declared set (telegram) has its peers set up by the operator with `iapeer create … --runtime telegram`. Telegram connection details — [09 — Runtimes](09-runtimes.md); the runtime package contract — [13](13-architecture-and-contract.md).
