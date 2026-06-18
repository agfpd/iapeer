# 13 — Architecture and contract

[Русский](ru/13-архитектура-и-контракт.md) · **English**

A section for those building on iapeer: runtime packages, capability plugins, memory providers.

## Invariants

The system's behavior rests on these:

- **One router.** There's exactly one continuously running daemon in the system. All messages go through it; there's no second router.
- **Identity per request.** The daemon keeps no client session — it determines who called from the `X-IAPeer-Identity` header of each MCP request. One listener serves all peers.
- **A single registry writer.** `peers-profiles.json` is written only through one writer under a file lock. Direct writing of the file is forbidden at the core level — this rules out races.
- **Liveness is defined by a peer's live session.** A peer is alive if and only if it has a live session under the supervisor. This isn't a separate state flag that can desync, but an observable fact.
- **`delivered` ⟺ landed in a live session.** Delivery success means the message was accepted by a live session (the daemon waited for confirmation). If it didn't confirm — the daemon treats the session as dead rather than lying about success.
- **The source of truth is the local profile.** The registry is a reprojectable projection of the peer profiles. On a divergence, the profile wins.
- **The binary is installed on the host.** The daemon runs from the installed `~/.local/bin/iapeer`, not from a source working tree. An update is replacing the binary and restarting the daemon onto it.

## Runtime adapters on the core side

An adapter is a core layer that knows how to launch a runtime's session. All adapters implement one interface; the runtimes' differences are hidden behind it.

The adapter's key properties:

- **`kind`** — `tui` (an interactive session that takes input: claude, codex) or `router` (a long-lived process with no input: telegram, notifier).
- **`usesDoctrine`** — whether the runtime consumes the assembled system prompt. For TUI agents — yes, for routers — no (they aren't language models).
- **`requiresIntelligence`** — a gate on the peer's nature. For `telegram` it's `natural`: an attempt to give a non-human a Telegram presence is rejected with an explicit error.
- **`buildArgv`** — how to assemble the launch command: for routers it's `<runtime>-runtime run` plus extra arguments from `launch.env`.

Routers skip all the TUI phases: they have no boot dialogs, no readiness markers, no delivery confirmation, no control commands. Their liveness is held by launchd, not a wake by the daemon.

The production mechanism for hosting TUI sessions is the **pty supervisor**: a supervisor daemon owns the session's pty and its pane log, and delivery onto input goes through its socket. tmux remains only an internal dev branch (the shadow branch) and doesn't figure at the user level.

## The runtime-package contract

A runtime package (`*-runtime`) is an npm package that adds an infrastructure runtime. Examples: `@agfpd/notifier-runtime`, `@agfpd/telegram-runtime`.

### The runtime.json manifest

On self-install the package writes a manifest to `~/.iapeer/runtimes/<runtime>/runtime.json`. The core reads it.

```json
{
  "runtime": "notifier",
  "version": "0.2.0",
  "selfConfig": { "command": "notifier-runtime", "args": ["self-config"] },
  "peers": [
    { "personality": "timer",   "intelligence": "absent", "description": "Schedule-driven scheduler" },
    { "personality": "watcher", "intelligence": "absent", "description": "Event watcher" }
  ]
}
```

| Field | Type | Required | Purpose |
|---|---|---|---|
| `runtime` | string | required | The runtime ID, matches the folder name; pattern `^[a-z][a-z0-9]{0,31}$` |
| `version` | string | optional | The package version. Used for the gate at `update-runtime`; without it an update simply reinstalls |
| `selfConfig` | descriptor | optional | A personal-setup hook, called by the core for each peer at provision |
| `peers` | array | optional | The declared peer set. Present — declared-set mode; absent — operator-add |

A `peers[]` element: `personality` (required), `intelligence`, `description`, `path` (an explicit folder), `runtimeBin` (a launcher path) — the last four optional.

A **descriptor** (`selfConfig` and the like) is `{ "command": "...", "args": [...] }` or simply a command string.

### Two deployment modes

- **declared-set** — the manifest contains `peers[]`. `iapeer install-runtime <runtime>` provisions the whole set at once (notifier provisions `timer` and `watcher`).
- **operator-add** — `peers[]` is empty or absent. Peers are set up by the operator one at a time: `iapeer create <name> --runtime <runtime>` (this is how humans are connected on telegram).

### What the core calls on the package

The contract is minimal — the core reaches the package in exactly three ways:

1. **`npx <package>`** — at install. The package idempotently lays its binary on `PATH` and writes `runtime.json`.
2. **`<runtime>-runtime run`** — at session launch (via the launchd plist or launch). In the environment — `PEER_PERSONALITY`, `PEER_RUNTIME`, `PEER_IDENTITY`.
3. **The `selfConfig` hook** — at each peer's provision. Called in the peer's working folder; in the environment — `IAPEER_PEER_PERSONALITY`, `IAPEER_PEER_CWD`, `IAPEER_PEER_RUNTIME`, `IAPEER_PEER_INTELLIGENCE`. Exit code 0 — configured (idempotently), otherwise — an error (the plist is written but not loaded).

Commands like `prepare`, `interface`, `bot`, `doctor` are the package's own internal commands for the operator, not a contract with the core: the core doesn't call them.

### Install and update

- **`install-runtime <runtime>`** determines the npm package (from the built-in registry or the `--package` flag), installs it via `npx`, then provisions the declared peer set.
- **`update-runtime <runtime>`** compares the manifest version with npm; when behind, it reinstalls, re-provisions, and restarts the runtime's peers with the standard `stop`/`start`.

## The capability-plugin standard

A capability plugin adds an ability to a peer without being a runtime. The distinction is clear: a runtime is a peer's mode of presence, a plugin is an ability on top of a runtime.

### The iapeer.json manifest

A plugin may (but need not) place an `iapeer.json` in its root:

| Field | Type | Purpose |
|---|---|---|
| `setup` | descriptor | The plugin's setup step. Called at `enable`, if declared and the install succeeded |
| `requires` | — | Dependencies (runtimes, other plugins). The core doesn't resolve them — the plugin checks them itself and refuses if a dependency is missing |

A plugin with no `iapeer.json` or no `setup` is the simple class: it's installed and enabled, with no extra initialization.

### enable

`iapeer enable <plugin> [peer]`, step by step:

1. Finds the peer (by name or by the current folder); refuses if the peer has no agent runtime.
2. On each of the peer's agent runtimes it installs the plugin: for Claude — into the project scope inside the peer's folder (`plugin install … --scope project`), for Codex — into the host's shared config. The install enables the plugin along the way.
3. If a `setup` is declared and the install succeeded — it calls it. In the environment: `IAPEER_PEER_PERSONALITY`, `IAPEER_PEER_CWD`; the working folder is the plugin root. The step is best-effort: its failure doesn't roll back the install and enable already done.

Idempotency: for Claude the binding is by the peer folder's real path, so a repeated `enable` doesn't disturb other peers or duplicate the install.

### iapeer-compatibility criteria

A plugin is considered compatible if it:

1. is useful on its own;
2. declares what it provides and what it requires;
3. doesn't own others' responsibilities;
4. has an idempotent preparation;
5. has self-diagnostics (`doctor`/`status`);
6. uses the shared identity ABI (`PEER_*`) when it's available;
7. doesn't require the user to manually sync identity between plugins;
8. understands name, runtime, and identity the same under Claude, Codex, and future runtimes.

## The memory-slot contract

Memory is provided by a provider that claims the single per-host slot. The slot is occupied by exactly one provider or empty.

### The provider manifest

The provider atomically writes `~/.iapeer/memory-provider.json`; the core only reads it. Deleting the file frees the slot. The core never writes the slot.

```json
{
  "provider": "iapeer-memory",
  "package": "@agfpd/iapeer-memory",
  "version": "0.2.7",
  "registeredAt": "2026-06-11T17:46:41.449Z",
  "heartbeat": "/Users/me/.iapeer/state/iapeer-memory/memoryd.heartbeat",
  "provision": {
    "command": "/Users/me/.local/bin/iapeer-memory",
    "args": ["provision-peer", "--cwd", "{cwd}", "--runtime", "{runtime}",
             "--personality", "{personality}", "--occasion", "{occasion}"]
  },
  "unprovision": {
    "command": "/Users/me/.local/bin/iapeer-memory",
    "args": ["unprovision-peer", "--cwd", "{cwd}", "--runtime", "{runtime}",
             "--occasion", "{occasion}"]
  }
}
```

| Field | Type | Required | Purpose |
|---|---|---|---|
| `provider` | string | required | The provider name |
| `package` | string | required | The npm package |
| `version` | string | required | The package version |
| `registeredAt` | ISO date | required | When the slot was claimed |
| `heartbeat` | path | optional | The provider daemon's heartbeat file; `iapeer status` shows its freshness |
| `provision` | descriptor | optional | The command to set up a peer's memory at birth |
| `unprovision` | descriptor | optional | The command to wind down at peer removal |

`command` must be an absolute path; `args` is an array of strings. The core treats an invalid block as absent, and an empty slot as a normal state.

### The provision/unprovision commands

Four placeholders are substituted in the arguments (per-argument substitution, at the substring level):

| Placeholder | Value |
|---|---|
| `{cwd}` | the peer's working folder |
| `{runtime}` | the specific agent runtime (`claude` / `codex`) |
| `{personality}` | the peer name — must equal `normalize(basename({cwd}))` (the peer name and folder are 1:1); a mismatch → `ensurePeerProfile` fails |
| `{occasion}` | the call moment (see below) |

**The call moments the core emits:**

- **`birth`** — at a peer's birth, one command per agent runtime. It runs after Codex pre-trusts the folder, so the provider's surfaces land in an already-trusted folder.
- **`remove`** — at a peer's removal, one command per agent runtime. It runs before the peer's state is cleaned — the provider sees it in its last consistent form.

**Environment:** the command inherits the whole core environment; the core does **not** add special `IAPEER_PEER_*` here — the provider relies on the placeholders in the arguments. stdin is ignored, stdout/stderr are captured.

**Execution semantics:** exit code 0 — success; otherwise — an error; over 120 seconds — a timeout; an unavailable binary — a separate outcome. All best-effort: a command's failure fails neither a peer's birth nor its removal, but is logged loudly. The provider must be idempotent — the core may invoke one command again.

### The native-memory lever

When the slot is claimed, keeping a runtime's native memory in parallel is harmful. The core, at the birth of a peer with a claimed slot, turns it off:

- **Claude** — appends `"autoMemoryEnabled": false` to `<folder>/.claude/settings.json`;
- **Codex** — appends `[features] memories = false` to `<folder>/.codex/config.toml`.

To turn it back on — delete the key (restore the runtime's default). By hand: `iapeer native-memory off|on`. For Codex the core, at birth, also writes folder trust (`[projects."<real-path>"] trust_level = "trusted"`) so the project config is read from the first session; at peer removal this entry is removed.
