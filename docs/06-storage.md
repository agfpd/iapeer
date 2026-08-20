# 06 — Storage

[Русский](ru/06-хранение.md) · **English**

iapeer state lives in two places: the shared host directory `~/.iapeer/` and the `.iapeer/` directory inside each peer's working folder.

## Two storage levels

**The shared level** `~/.iapeer/` — everything concerning the host as a whole: the peer registry, daemon state, shared settings, installed runtime packages.

**The peer level** `<peer-folder>/.iapeer/` — everything concerning one peer: its profile, doctrine, its plugins' state, its sessions' logs.

The same plugin can store data at both levels: shared in `~/.iapeer/`, peer-bound in the peer's folder.

## The shared-level layout

```text
~/.iapeer/
├── IAPEER.md                  host doctrine (shared by all peers; prompt layer 2)
├── peers-profiles.json        registry of all peers (written under a lock)
├── peers-profiles.lock        registry lock file
├── memory-provider.json       memory slot: who the provider is (if claimed)
├── fragments/                 shared doctrine fragments (prompt layer 5)
├── peers/
│   └── <name>/                a peer's default working folder
│       └── .iapeer/           (peer-level layout — see below)
├── state/
│   ├── iapeer/                daemon state (router.sock, router.json …)
│   │   └── attachments/       recipient-owned IAP attachment copies
│   └── <plugin>/              a plugin's mutable state
├── logs/
│   ├── iapeer/                daemon logs: lifecycle.log, delivery.log, exits.log
│   └── <name>/                an infrastructure peer's logs (by name)
├── cache/
│   ├── iapeer/                core cache
│   └── <plugin>/              plugin cache (safe to delete)
├── docs/
│   ├── iapeer/                foundation reference docs (this host's installed version)
│   └── <package>/             each ecosystem package's docs (copied on its install)
├── plugins/
│   ├── iap/                   the core IAP plugin's install
│   └── <plugin>/              a plugin's install (immutable)
└── runtimes/
    ├── claude/
    │   └── plugins/<plugin>/  a plugin's config under the claude runtime
    ├── codex/
    │   └── plugins/<plugin>/
    ├── telegram/
    │   └── runtime.json       a runtime package's manifest
    └── notifier/
        └── runtime.json
```

A few nodes worth highlighting:

- **`peers-profiles.json`** — the registry. Written only through a single writer under the file lock `peers-profiles.lock`; direct editing is forbidden at the core level.
- **`state/iapeer/`** — where the daemon lives: its local socket `router.sock`, config `router.json`, and `attachments/<recipient>/<sha256>/<basename>` inboxes. Attachment inboxes are durable recipient state (not cache); peer removal cleans that recipient's inbox.
- **`logs/<name>/`** — an infrastructure peer's logs are placed by peer name at the shared level (not in the peer's folder), because it's the output of a launchd service.
- **`runtimes/<runtime>/`** — dual ownership: the root belongs to the runtime itself (Telegram keeps bot tokens and poll state here), while the `plugins/<plugin>/` subfolder is the plugins' space, holding their config under this runtime.
- **`docs/<package>/`** — on-host reference docs, one folder per ecosystem package (see below).

## On-host ecosystem docs

`~/.iapeer/docs/<package>/` holds a copy of each ecosystem package's reference docs, so an agent can read the contract offline at a stable, versioned path. It exists because a compiled binary embeds no docs and the npm tarball's `docs/` is discarded after install — a reference into a transient install or cache directory would go dead on the first update.

The convention is **copy-on-install, per package**: every package copies its own public docs (excluding `internals/`) into its own `~/.iapeer/docs/<package>/` on each of its installs and updates, via an atomic swap, best-effort — a copy failure never fails the install. Because the copy happens in the same install that places the artifact, a package's on-host docs always match its installed version. Each package writes only its own subfolder, the same ownership isolation as everywhere else; the folder name is the short unscoped package name (`iapeer`, `iapeer-memory`, `telegram-runtime`, `notifier-runtime`).

A peer's system prompt points here — `~/.iapeer/docs/`, one folder per package, starting at `iapeer/README.md` — so a "how does iapeer do X" question is answered from the docs rather than guessed.

## The peer-level layout

```text
<peer-folder>/.iapeer/
├── peer-profile.json          the peer profile — the source of truth about it
├── IAPEER.md                  personal doctrine (prompt layer 2)
├── fragments/                 personal doctrine fragments (layer 5)
├── plugins/
│   ├── iap/
│   └── <plugin>/              a plugin's data for this peer
├── state/
│   ├── iap/
│   └── <plugin>/
├── logs/
│   ├── iap/
│   └── <plugin>/
├── cache/
│   ├── iap/
│   └── <plugin>/
└── runtimes/
    ├── claude/
    │   ├── launch.env         launch args and env vars for this runtime
    │   └── plugins/<plugin>/
    └── codex/
        ├── launch.env
        └── plugins/<plugin>/
```

- **`peer-profile.json`** — the peer's card and the single source of truth about it (the fields are covered in [03 — Peers, runtimes, identity](03-peers-runtimes-identity.md)).
- **`launch.env`** — a `KEY=VALUE` file for a specific peer+runtime pair: extra launch arguments (`PEER_START_ARGS`) and environment variables. So one peer can be given special launch flags without touching the rest. `create`/`init` scaffold it as an all-comment skeleton for every agentic runtime scope (behaves exactly like no file until edited), so fleet-wide launch.env operations never skip a peer for lack of the file; an existing file is never overwritten.

A peer's working folder doesn't have to live under `~/.iapeer/peers/`. By default `iapeer create` puts it there, but any folder can be made a peer with `iapeer init` — then `.iapeer/` appears right inside it.

## Who owns what

The ownership boundary is simple: everyone owns the contents of their own folder and stays out of others'.

| Owner | What belongs to it |
|---|---|
| **Core (`iapeer`)** | `peers-profiles.json`, `state/iapeer/`, `logs/iapeer/`, `cache/iapeer/` |
| **Runtime** | the root of `runtimes/<runtime>/` — except the `plugins/` subfolder |
| **Plugin** | its own `<plugin>/` folder in every category (`state`, `logs`, `cache`, `plugins`) at both levels |

The name `iapeer` in the categories is reserved for the core. A runtime never touches `plugins/<plugin>/` inside its space, and a plugin never touches the runtime root.

## Data classes by lifetime

Install is separated from mutable data — important for updates and for cleanup:

- **Install** (`plugins/<plugin>/`) — immutable. It's the plugin's unpacked code; an update replaces it whole.
- **State** (`state/`) — mutable data worth protecting: losing it is losing work.
- **Logs** (`logs/`) — process output; useful for analysis but not critical. What's written to `lifecycle.log`, `delivery.log`, `exits.log` and how to configure their rotation — [14 — Configuration and logs](14-configuration-and-logs.md).
- **Cache** (`cache/`) — recoverable data; it can be deleted with no consequence, the system rebuilds it.

This split means updating a plugin is replacing its install folder without touching its state; and freeing space is deleting the cache without risking data.

## The registry as a derivative

Worth repeating the key storage principle: **the registry `peers-profiles.json` is a projection of the local profiles, not a separate source of truth.** The source of truth about a peer is its `peer-profile.json`. The registry can be reprojected from the profiles at any time with `iapeer verify --fix`. On a divergence between the registry and a profile, the profile wins. So losing or corrupting the registry isn't fatal — it's rebuilt by walking the peers' working folders.
