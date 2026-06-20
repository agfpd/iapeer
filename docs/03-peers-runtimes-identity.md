# 03 — Peers, runtimes, identity

[Русский](ru/03-пиры-рантаймы-идентичность.md) · **English**

A deeper take on the three base concepts from the [overview](01-overview.md) — at the level of detail you need to create peers, switch them between runtimes, and read profiles.

## Peer

A peer is a participant in the system. It has a working folder, a name, a set of runtimes, and a nature.

### Name (personality)

The name is a short lowercase logical name: `assistant`, `code-reviewer`, `timer`. The format follows `^[a-z][a-z0-9-]{0,31}$`: a letter, then letters, digits, dashes, up to 32 characters.

The name isn't stored as a separate value — it's **derived from the working-folder name**. The folder `~/.iapeer/peers/assistant` yields the name `assistant`; non-Latin and other characters are normalized to an allowed form.

Hence a strict rule: **the name and the working folder are one-to-one**. A name already taken by another peer is refused — no silent suffix to resolve a collision. The name is an address, and it must be unambiguous.

### Nature (intelligence)

Every peer carries a nature attribute. It travels with the message, so the recipient knows who it's talking to without guessing.

| Value | Who it is |
|---|---|
| `artificial` | an AI agent (Claude, Codex) |
| `natural` | a human (over Telegram and similar channels) |
| `absent` | a program with no intelligence (a scheduler, a watcher, a webhook) |

The nature defaults from the runtime: agent runtimes give `artificial`, Telegram `natural`, notifier `absent`. You can set it explicitly when creating a peer.

The values `human` and `scripted` were used before — they're still read (understood as `natural` and `absent` respectively), but on write the system keeps whatever value is already in the profile and doesn't rewrite peers already set up.

## Runtime

A runtime is a peer's mode of presence. A runtime name is shorter than a peer name: the format `^[a-z][a-z0-9]{0,31}$`, no dashes. That matters for parsing identity (below).

### Two runtime classes

**claude, codex** — AI agents. Their session isn't kept running all the time: the daemon brings the agent up on an incoming message and closes the session after an hour idle. This runtime the daemon manages fully — it wakes and sleeps it.

**telegram, notifier** — router runtimes, not AI. The Telegram bridge accepts inbound messages at any time, notifier fires on a schedule — so they run continuously under launchd with auto-restart. Such a runtime the daemon **doesn't touch**: wake and sleep don't apply to it, its lifecycle is governed by launchd. These are the infrastructure runtimes.

The split is a responsibility boundary: the daemon owns claude/codex, launchd the infrastructure runtimes. The `stop`/`start`/`new` commands behave differently depending on the class (see [08 — Peer management](08-peer-management.md)).

### Several runtimes on one peer

A peer can declare several runtimes. In the profile that's two fields:

- **`runtimes`** — the list of all runtimes the peer can be present on, e.g. `["claude", "codex"]`.
- **`default_runtime`** — the primary runtime: where messages route by default and which runtime comes up first.

Adding a runtime to a peer and making it the primary are different operations. The first (`add-runtime`) extends the options without changing routing; the second (`default-runtime`) switches the primary runtime. Switching `default_runtime` across all peers in bulk is exactly the moment of "transplanting" the team from one agent runtime to another. See [09 — Runtimes](09-runtimes.md).

The runtime list also fills itself: when a peer is initialized, the system scans its folder for runtime markers (the `.claude`, `.codex` directories and subfolders under `runtimes/`) and adds what it finds to `runtimes`. So the list stays current even when a runtime appeared on a peer organically rather than being declared explicitly.

## Identity

Identity is the address of a specific live presence of a peer. It's composed of the runtime and the name through a dash:

```text
PEER_IDENTITY = PEER_RUNTIME + "-" + PEER_PERSONALITY
```

The peer `assistant` on Claude is `claude-assistant`; the same one on Codex is `codex-assistant`. One name, two identities.

Identity is parsed **by the first dash**: everything to the left is the runtime, everything to the right is the name. Since a runtime name has no dashes while a peer name may, the parse is unambiguous: `claude-code-reviewer` is the runtime `claude` and the peer `code-reviewer`.

### The identity ABI

Three values form an ABI — a set of environment variables by which any component of the system knows who it is:

| Variable | Value | Example |
|---|---|---|
| `PEER_PERSONALITY` | the peer name | `assistant` |
| `PEER_RUNTIME` | the current session's runtime | `claude` |
| `PEER_IDENTITY` | the full address | `claude-assistant` |

When the daemon brings up an agent session, it passes these variables into the environment. By them the agent knows its name and on whose behalf it sends messages. The current session's runtime is resolved in this order: from the identity header (`PEER_IDENTITY`), then from the profile, then from `PEER_RUNTIME`, and last by autodetection from runtime markers in the environment — Codex sets `CODEX_THREAD_ID`, Claude sets `CLAUDECODE=1`. If no source works, the wake is refused with a demand to set `PEER_RUNTIME` or create a profile.

## Profile and registry

Identity has two storage places, and it matters which is authoritative.

### The peer profile — the source of truth

`<peer-folder>/.iapeer/peer-profile.json` is the peer's card, the single source of truth about it. Here's a real profile:

```json
{
  "personality": "assistant",
  "runtimes": ["codex", "claude"],
  "default_runtime": "claude",
  "runtime": "claude",
  "description": "General-purpose assistant. Takes tasks over IAP.",
  "intelligence": "artificial",
  "initial_prompt": "New session. Greet the owner.",
  "interfaces": {
    "telegram": { "bot": "assistant" }
  }
}
```

The profile fields split into three classes by who owns them:

- **Identity core** — `personality`, `default_runtime`, `runtimes`, `description`, `intelligence`, `initial_prompt`. Owned by the core and the lifecycle. The `initial_prompt` field is the seed for a fresh session's first turn. The legacy `runtime` field beside `default_runtime` is no longer written — a read-fallback still understands older profiles that carry only `runtime`.
- **Private plugin config** — sections like `expansion` (shortcut aliases), `notifier` (the scheduler peer's settings), and others, one per plugin. Read only from the local profile, never projected into the registry.
- **Public passport** — the `interfaces` section (e.g. `interfaces.telegram.bot`). These are routing attributes, and they're projected into the registry.

The `description` is length-bounded (currently 450 characters) — it's self-documenting, seen by other peers in the registry.

### The registry — a derivative

`~/.iapeer/peers-profiles.json` is the shared registry of all peers. The daemon reads it to know whom to deliver a message to and what runtimes a peer has. A registry entry holds a projection of the profile: name, primary runtime, runtime list, description, nature, working folder, public interfaces.

The registry isn't the source of truth but a **projection** of the local profiles. It can be reprojected from the profiles at any time (`iapeer verify --fix`). If the registry and a profile diverge, the profile wins — the registry is fixed from it.

The registry is written only through a single writer under a file lock — editing `peers-profiles.json` directly is forbidden at the core level. This rules out races when several processes change the peer set at once. More on layout and ownership — [06 — Storage](06-storage.md).
