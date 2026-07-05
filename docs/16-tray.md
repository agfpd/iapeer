# 16 — Tray (menu-bar fleet dashboard)

A macOS menu-bar dashboard of the fleet — the peer list of `iapeer list` rendered as a
[SwiftBar](https://github.com/swiftbar/SwiftBar) plugin. It is the **first external
client of the [Fleet API](15-fleet-api.md)**: it discovers the daemon via `router.json`,
reads `/fleet/v1/snapshot`, follows `/fleet/v1/events`, and issues commands over
`/fleet/v1/peers/<peer>/<cmd>` — all over HTTP, against the normative contract, with no
knowledge of daemon internals. If the daemon and the contract ever diverge, the tray is
the second consumer that feels it (the first being the daemon itself, which wrote the
snapshot).

Packaging: the tray ships **with the foundation** — it is another face of the daemon, the
same class as the `iapeer list` TUI, not a separate project. `iapeer install` drops the
plugin file (inert until SwiftBar is present); `iapeer tray install` is the one-time
activation that also installs SwiftBar.app when it is absent.

## What you see

- **Menu bar:** an antenna glyph + the count of peers with a live session. When no
  advertised daemon address answers, a red warning triangle instead (the daemon is down —
  a purely API-fed dashboard cannot show a broken daemon any other way; the built-in TUI
  keeps its direct read path for that case, see [15](15-fleet-api.md)).
- **Dropdown:** a host header (`iapeer <version> · up <uptime>`) and the memory/voice
  provider heartbeats, then one row per peer:
  - `<peer>  <runtime><glyph> …  <age>` with the same glyph semantics as the CLI —
    `●` live · `○` asleep · `✕` stopped — green when any runtime is live. Badges: `👤`
    a human is attached, `🔒` launchd-managed (H4 read-only), `⏳N` an ephemeral peer's
    queue depth.
  - **Click a peer → Terminal.app running `iapeer attach <peer>`.** Attach is a terminal
    handoff the API deliberately keeps client-side (a PTY inside a GUI is out of scope);
    the same row's submenu carries the lifecycle actions (Wake / Stop / Start / New /
    Interrupt / Refresh / Compact), each a `POST /fleet/v1/peers/<peer>/<cmd>` via
    `iapeer tray cmd`.

The list updates itself: the plugin is **streamable** — it subscribes to the event stream
and re-fetches the snapshot on every change (a peer waking, an operator stop/start, a
death), coalescing bursts. A ~15 s heartbeat keeps ages fresh and self-heals a missed
event; the stream reconnects across daemon restarts. No manual refresh needed (there is a
Refresh item anyway).

## Verbs

| Verb | What it does |
|---|---|
| `iapeer tray install [--plugin-only]` | Install SwiftBar.app when absent (owner-sanctioned), point it at the plugin dir, write the plugin, launch + refresh. `--plugin-only` writes just the plugin file (no app, no launch — what the foundation install does). Idempotent. |
| `iapeer tray uninstall` | Remove the plugin file and refresh SwiftBar. **Never touches the fleet** — the daemon, TUI and delivery keep running; SwiftBar.app is left installed (it may host other plugins). |
| `iapeer tray render [--stream]` | Print the SwiftBar plugin output. `--stream` is the streamable loop the plugin runs; the one-shot form is the poll fallback and the test surface. |
| `iapeer tray cmd <command> <peer> [runtime]` | POST a fleet command (`wake`/`stop`/`start`/`new`/`refresh`/`interrupt`/`compact`) — the menu's lifecycle actions call this. |
| `iapeer tray status` | Read-only: is the fleet API up (from `router.json`), is SwiftBar installed and where is its plugin dir, is the plugin file present. Repairs nothing. |

## How it is wired

The SwiftBar plugin file (`iapeer.10s.sh` in the plugin dir) is a thin shim: SwiftBar
metadata (`<swiftbar.type>streamable</swiftbar.type>`) plus one line —
`exec "<~/.local/bin/iapeer>" tray render --stream`. All rendering, streaming and
command logic lives in the compiled binary (typed, tested); the `.sh` is stable and
carries no logic, so an `iapeer update` never has to rewrite it.

Plugin directory: an already-configured SwiftBar `PluginDirectory` is respected (the
plugin is installed into the user's own dir); otherwise a dedicated
`~/.iapeer/tray/plugins/`, and SwiftBar is pointed at it via
`defaults write com.ameba.SwiftBar PluginDirectory` — a plain-string default SwiftBar
reads on launch (it is not sandboxed and stores no security-scoped bookmark), so the
folder picker is skipped.

Auth follows the Fleet API: on an open-local host no bearer is needed; when the daemon is
configured with `IAPEER_BEARER_TOKEN`, the plugin's environment must carry it too.

Config: `IAPEER_TRAY_HEARTBEAT_MS` tunes the heartbeat cadence (default 15 s, clamped
1 s…10 min).

## Client obligations

Because the tray is a Fleet API client, it obeys the normative rules in
[15 — Fleet API §Client obligations](15-fleet-api.md): unknown `ev` kinds and unknown
JSON fields are ignored (additive evolution), events are at-least-once (the snapshot is
the state, events are change hints), and a missing `fleet: 1` marker in `router.json`
means "no fleet API" — the tray degrades to the daemon-down state rather than probing
endpoints.

## Boundaries

- **GUI teardown ≠ fleet teardown.** Removing the plugin (or quitting SwiftBar) leaves the
  daemon, the fleet and the CLI/TUI fully working — the dashboard is an optional face.
- **Attach is not an API command** — it is a terminal handoff the client performs.
- Native app, pet overlay and approval buttons are later phases (a native `iapeer-tray`
  Swift app is considered only if the SwiftBar version proves insufficient); all would be
  further thin clients of the same Fleet API.
