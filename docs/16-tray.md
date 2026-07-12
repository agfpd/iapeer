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

- **Menu bar:** an antenna glyph + the count of peers with a live session. When one or more
  **human-approval** requests are pending, the menu bar instead shows a **red `N.circle.fill`
  badge** (the iOS-notification look — a red circle with the count) so the owner sees an
  awaiting request at a glance. When no advertised daemon address answers, a red warning
  triangle instead (the daemon is down — a purely API-fed dashboard cannot show a broken
  daemon any other way; the built-in TUI keeps its direct read path for that case, see
  [15](15-fleet-api.md)).
- **Dropdown:** a host header (`iapeer <version> · up <uptime>`) and the memory/voice
  provider heartbeats, then one row per peer, in **two groups**: the `🔒` **launchd block**
  (the human channel + service infra — non-clickable status rows) is pulled to the **top as
  one contiguous block, before the first working agent**, regardless of live/asleep — so the
  bar separates "service, don't touch" from the working agents at a glance. Working agents
  follow. Within **each** group the order is live → asleep → stopped, then alphabetical.
  - `<peer>  <runtime><glyph> …  <age>` with the same glyph semantics as the CLI —
    `●` live · `○` asleep · `✕` stopped — green when any runtime is live. Badges: `👤`
    a human is attached, `🔒` launchd-managed (H4 read-only), `🛡` the peer runs in **gated**
    human-approval mode (docs/17; `yolo` is the fleet default and carries no badge — a bare
    row reads as yolo), `⏳N` an ephemeral peer's queue depth.
  - **Each peer is a SUBMENU** — one unified list (no separate Manage section; the peer rows
    and a parallel Manage list of every peer used to be a visible dupe). Clicking a peer
    EXPANDS it; its actions are the children, in order:
    - **Attach** (agent peers only) — the FIRST child. Runs `iapeer tray attach-term <peer>`,
      which writes a per-peer `.command` launcher and `open`s it — `open <file>.command` hands
      the file to Terminal.app with **no Automation/Accessibility permission prompt** (this
      deliberately avoids SwiftBar's own `terminal=true`, whose Terminal launch drives a `Cmd-T`
      System-Events keystroke that silently no-ops unless SwiftBar holds Accessibility). Attach
      is now expand-then-Attach (two clicks) — the trade for a single dupe-free list.
    - **Lifecycle** — Stop / Start / New / Interrupt / Refresh / Compact, each a
      `POST /fleet/v1/peers/<peer>/<cmd>` via `iapeer tray cmd`. (No Wake item — a peer-row
      click path already wakes a sleeping peer before it attaches, so it was redundant.)
    - **Approval-mode toggle** (agent peers only, docs/17): reads the current mode and flips it
      via the local `iapeer approval-mode <peer> <mode>` verb, applied on the peer's **next fresh
      session** (a click never respawns a live session). The friction is asymmetric to the
      security weight: `yolo → gated` (adds human approval) is one safe tap; `gated → yolo`
      (REMOVES the approval perimeter) sits one level deeper behind an explicit red ⚠ confirm, so
      it is never dropped by a stray click.

    **Launchd-managed infra peers (telegram / notifier, `🔒`)** are not pty-attachable, so their
    submenu carries **no Attach** and **no approval toggle** (always yolo) — just the lifecycle
    commands (service Stop / Start etc.).
- **Pending approvals (docs/17):** when the queue is non-empty, the **top of the dropdown** shows
  each pending request **expanded, with no extra clicks** — a header (`<peer> · <tool>`), the
  **verbatim action content** (the command / diff / plan, monospace, capped for the menu; the FULL
  content stays in `iapeer approvals`), then **Allow** / **Deny** items directly below. Clicking runs
  `iapeer tray approve|deny <id>` in the background → the broker resolves → the stream re-renders (the
  badge clears). The peer with a pending request is **highlighted in the fleet list** (a `⚠` prefix, a
  red `🔴N` count, the row painted red) so the owner sees *which* peer is waiting. This channel is
  **always on** — the approval queue is reflected whenever it is non-empty, independent of everything
  else; an empty queue shows no section and no badge. (A true *pulse* animation is not possible in a
  static SwiftBar menu — the highlight + badge is its equivalent.)

The list updates itself: the plugin is **streamable** — it subscribes to the event stream
and re-fetches the snapshot on every change (a peer waking, an operator stop/start, a
death), coalescing bursts. A heartbeat keeps ages fresh and self-heals a missed event; the
stream reconnects across daemon restarts. Every emitted menu block is prefixed with the
`~~~` stream separator (SwiftBar's default leading-separator mode = replace), including the
first — otherwise a manual Refresh, which `terminate()`s and re-`invoke()`s the plugin
without clearing SwiftBar's held content, would append the restarted block and render the
whole dashboard twice.

## Verbs

| Verb | What it does |
|---|---|
| `iapeer tray install [--plugin-only]` | Install SwiftBar.app when absent (owner-sanctioned), point it at the plugin dir, write the plugin, launch + refresh, **and register the tray-host supervisor LaunchAgent** (login autostart + relaunch-on-death). `--plugin-only` writes just the plugin file (no app, no launch, no autostart — what the foundation install does). Idempotent. |
| `iapeer tray uninstall` | Remove the plugin file, refresh SwiftBar, **and tear down the tray-host supervisor LaunchAgent**. **Never touches the fleet** — the daemon, TUI and delivery keep running; SwiftBar.app is left installed (it may host other plugins). |
| `iapeer tray render [--stream]` | Print the SwiftBar plugin output. `--stream` is the streamable loop the plugin runs; the one-shot form is the poll fallback and the test surface. |
| `iapeer tray cmd <command> <peer> [runtime]` | POST a fleet command (`wake`/`stop`/`start`/`new`/`refresh`/`interrupt`/`compact`) — the menu's lifecycle actions call this. |
| `iapeer tray approve <id>` · `iapeer tray deny <id> [reason]` | Resolve a pending human-approval (docs/17) — `POST /fleet/v1/approvals/<id>/(approve\|deny)` over the same unix-first fleet client. The menu's Allow/Deny items call these; the single-queue invariant means the resolution is seen by every channel (CLI, telegram). |
| `iapeer tray status` | Read-only: is the fleet API up (from `router.json`), is SwiftBar installed and where is its plugin dir, is the plugin file present, **is the tray-host supervisor registered**. Repairs nothing. |

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

Tray-host supervision: activating the tray registers a user LaunchAgent
`~/Library/LaunchAgents/com.agfpd.iapeer.tray.plist` (RunAtLoad **and KeepAlive**) that
runs a tiny `/bin/sh` watchdog loop: every 5 s, if no SwiftBar process exists, `open -g
-b com.ameba.SwiftBar` (a no-op activation when it is already running — race-safe, never
a duplicate instance; an absent SwiftBar.app backs off 5 min). So SwiftBar — and with it
the fleet dashboard + approval badge — comes back on its own after a reboot AND within
seconds after a crash or a stray kill. The tray is the owner's fleet-visibility surface;
a silently-dead SwiftBar hides the state of the whole system, so its lifetime is
supervised, not fire-and-forget. Deliberate consequence: quitting SwiftBar by hand also
relaunches it — the supported off-switch is `iapeer tray uninstall`. launchd must NOT
KeepAlive `open` itself (it exits the moment SwiftBar is up — KeepAlive on it is a
respawn storm); KeepAlive guards the long-lived loop process. A **LaunchAgent** is used
deliberately, not a System Events "Login Item" nor SMAppService: a Login Item needs the
invoking process to hold Automation TCC over System Events (attributed to whatever
parent runs the verb — fragile in a headless / `iapeer update` context), and
SMAppService can only register a helper the *target* app ships (we cannot register the
third-party SwiftBar with it from a CLI). The LaunchAgent needs no TCC and reuses the
foundation's idempotent plist lifecycle: the plist is byte-stable (write-if-changed),
carries the `com.iapeer.managed` ownership sentinel, and is bootstrapped/cycled
undead-safe — so re-activation never plants a duplicate, and a foundation install
(`iapeer update`) upgrades an already-registered agent's plist in place (bytes-changed →
re-cycle). `tray uninstall` boots it out and removes the plist (only our own
sentinel-marked file — a foreign plist at the label is left untouched). The label lives
in the foundation's own `com.agfpd.*` namespace, never `com.iapeer.<personality>` (the
persistent-peer fleet), so the H4 launchd-owned sweep-guard can never mistake it for a
peer.

Auth follows the Fleet API: on an open-local host no bearer is needed; when the daemon is
configured with `IAPEER_BEARER_TOKEN`, the plugin's environment must carry it too.

Config: `IAPEER_TRAY_HEARTBEAT_MS` tunes the heartbeat cadence (default 15 s, clamped
1 s…10 min).

## Icon visibility (why the stream writes in 512-byte quanta)

SwiftBar v2.0.1 decodes **every pipe chunk independently** (`RunScript.swift`:
`String(data: availableData, encoding: .utf8)` per readability callback). A chunk
boundary that lands inside a multi-byte UTF-8 character makes that decode `nil`;
`StreamablePlugin` treats `nil` as "clear content", and `MenuBarItem._updateMenu` answers
empty content with `hide()` — the `NSStatusItem` vanishes from the menu bar. Worse, the
item has an `autosaveName`, so AppKit **persists** the hidden state
(`NSStatusItem VisibleCC <plugin>` = 0 in SwiftBar's defaults): the icon stays gone
across SwiftBar restarts until some later update calls `show()`.

The tray's menu block is tens of kilobytes of emoji/box-glyph-rich text; a single
`write(2)` of it reaches the reader in pipe-buffer-fill chunks (measured live:
16384+16384+2400 — byte-arbitrary boundaries), so with a static fleet the same bad
boundary recurred every heartbeat and the icon stayed invisible for hours (owner
incident 13.07.2026, reproduced deterministically with a probe plugin that split an
emoji across two writes).

Two layers make the class impossible:

1. **Atomic UTF-8 quanta** — `tray render --stream` writes its output in chunks of
   ≤512 bytes (`PIPE_BUF`: writes of at most that size into a pipe are atomic,
   all-or-nothing), each ending on a UTF-8 character boundary. The pipe buffer then only
   ever contains whole quanta and every chunk SwiftBar can see is valid UTF-8 — the nil
   decode cannot happen by construction.
2. **Freshness stamp** — every rendered block (and every daemon-down block) carries a
   `HH:MM:SS` footer clock, so consecutive emits always differ and SwiftBar runs its
   update path (which starts with `show()`) on every heartbeat. Any hidden icon —
   whatever hid it (an accidental ⌘-drag removal, a stale persisted `VisibleCC` flag, a
   future SwiftBar quirk) — recovers within one heartbeat (≤15 s) instead of staying
   invisible while the fleet is static.

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
