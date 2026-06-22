# Changelog

All notable changes to **@agfpd/iapeer** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> The public repository begins at the **Initial public release (0.2.98, 2026-06-18)**.
> Versions before 0.2.98 predate the public repo (private development) and are not itemized here.

## [Unreleased]

## [0.4.22] - 2026-06-22

### Added

- **`iapeer live-runtime <peer>`** — prints the peer's CURRENT live runtime: the
  freshest-pane-log among its **pid-alive** supervisor sessions (a peer can be alive on
  more than one runtime at once — a `/codex` flip can leave the old session running
  alongside the new). This is the authoritative, real-time signal for "what runtime is
  this peer running right now" — NOT `default_runtime` (only the wake-default) and NOT a
  `.session` wake-record (alive-filtered only on a supervise-tick latency). Exit 0 + the
  runtime on stdout when one is live; exit 1 + no output when none is alive. For external
  consumers (e.g. telegram-runtime's typing/tool-use indicator) that must resolve the live
  runtime of a peer running on a non-default runtime, instead of inferring it. Exposed as
  `resolveLiveRuntime` (transport).

## [0.4.21] - 2026-06-22

### Fixed

- **`iapeer remove` of an always-on peer no longer leaves an orphan launchd plist.** An
  infra peer (notifier/telegram/voicetalk) has a `com.iapeer.<p>` plist with KeepAlive;
  `remove` dropped only the registry record, so launchd kept relaunching `iapeer run-infra
  <p> <rt>` against the now-deleted record → crash-loop (the SRE peer alerted
  "gone-without-disable"). `remove` now boots out + removes the **foundation-owned** plist
  BEFORE the registry remove (closing the crash-loop window), and the **H4 fleet-guard**
  refuses a FOREIGN persistent-peer plist (`--force` drops only the registry record and
  leaves the foreign plist intact). A warm peer (no plist) is unaffected.

## [0.4.20] - 2026-06-22

### Fixed

- **Codex hosted-delivery no longer false-fails.** The warm-delivery landing-confirm
  (`deliverViaHost`) confirmed a message "landed" only by a transcript/session-jsonl mtime
  advance within a 3000ms grace. Claude writes the user turn to its transcript promptly, but
  **codex writes its session jsonl only at model-turn-start** (gated by time-to-first-token,
  ~4-6s after submit) — so every codex delivery structurally false-failed with `"no transcript
  advance within 3000ms"` even though the message landed and codex was processing it (proven in
  delivery.log: an `ok=false` immediately followed by codex recording the input and replying).
  The confirm now also accepts a **pane-log (TUI render-stream) mtime advance** — the same true
  active-turn signal the 0.4.16 idle-reap fix uses; it ticks ~1s as the session renders the
  working state on submit, giving codex delivery parity with claude without lengthening the
  (synchronous) grace. An advance proves the session is alive and reacted to the just-flushed
  bytes (a dead/wedged pty renders nothing → still fails correctly). The typing/tool-use
  indicator for codex is a separate telegram-runtime concern (its pane-log parsing).

## [0.4.19] - 2026-06-22

### Added

- **Voice provider slot** (`@agfpd/voice-connect`) — a second declarative provider slot
  alongside memory, integrated into the host lifecycle:
  - `iapeer onboard` now offers an optional **DEFAULT-YES** voice step (after memory) in
    both the linear path (`--no-voice` / `--voice <pkg>`) and the interactive wizard. It
    installs the voice provider's **HOST BACKEND only** (a self-managed launchd HTTP
    TTS/STT service) via the provider's own `init` (inherited stdio) — per-peer voice
    tooling stays the separate explicit `iapeer enable voice-connect <peer>`. Report-only
    for the exit code (an empty slot is a valid state).
  - `iapeer update` cascades to the voice provider (best-effort, version-gated) via its
    own `npm exec --package=@agfpd/voice-connect@latest -- voice-connect update` verb —
    after foundation + runtimes + memory.
  - `iapeer status` shows a `voice:` line (`<provider> <version> @ <endpoint>` + heartbeat
    freshness, or `none`). The voice slot is read-only to the core, fail-open; unlike
    memory it carries no provision/unprovision (voice is opt-in per-peer, not at birth)
    and adds an `endpoint` for HTTP-facade discovery (telegram-STT / voicetalk).

## [0.4.18] - 2026-06-22

### Changed

- `iapeer rename <old> <new>` now performs a **full folder rename** (extends 0.4.17's
  personality-only rename). The personality is a self-healed mirror of `normalize(basename(cwd))`,
  so a rename that kept the cwd would be reverted by profile-standard self-heal — the folder
  must move. The verb now atomically moves the cwd folder (the per-cwd profile, `.mcp.json`,
  native-memory, `CLAUDE.md`, and the `.git` clone ride it), moves the claude transcript slug
  dir (`~/.claude/projects/<slug>`, keyed by `realpath(cwd)` — so claude history is preserved),
  and updates the registry cwd + personality + per-cwd profile, with rollback of the fs moves on
  failure. Best-effort afterwards: re-trust the new cwd for codex + clean the old, rewrite the
  claude `.mcp.json` identity, purge the old identity's lifecycle markers. Refuses a LIVE peer
  unless `--force`. Memory (operativka folder + author/index attribution) re-key is the memory
  provider's separate step; codex resume-history (keyed by the cwd recorded inside each session
  file, not a path-dir) does not carry to the new cwd.

## [0.4.17] - 2026-06-21

### Added

- `iapeer rename <old> <new>` — first-class peer-identity rename (parity with remove/create).
  Renames the personality in **both** the registry and the per-cwd profile atomically and
  **keeps the cwd**, so the claude transcript history (keyed by `realpath(cwd)`) survives.
  Refuses a LIVE peer unless `--force` (a running session carries the old identity in its
  env), and purges the old identity's lifecycle markers. Memory re-key (the personality-keyed
  operativka folder + author/index attribution) is the memory provider's separate step;
  native-memory is cwd-keyed and unaffected.

## [0.4.16] - 2026-06-21

### Fixed

- Idle-reap now uses the pane-log (TUI render-stream) mtime as its activity proxy, not the
  transcript file mtime. A live claude session re-touches its session `.jsonl` periodically
  *without a real turn*, so the transcript proxy never crossed `idleSecs` and **claude peers
  never idle-reaped** — the fleet piled up warm while codex peers (whose session file isn't
  re-touched) reaped normally. The pane-log goes truly quiet at the prompt, so idle peers now
  reap as intended. Pane-log primary; transcript fallback only when the pane-log is missing
  (legacy supervisor); the launch ready-gate still uses the transcript.

## [0.4.15] - 2026-06-21

### Fixed

- Ephemeral idle-reap no longer kills a **working** session mid-turn. An armed ephemeral
  worker (one that has sent its reply) was reaped after 20s of *transcript* silence, but the
  transcript goes quiet during a long model generation — so a still-working worker was killed
  mid-turn. The reap now folds in the pane-log (TUI render-stream) mtime, so "quiet" means the
  turn truly ended: a working session is never reaped, while an idle one still reaps in ~20s
  (keeping the ephemeral serial conveyor draining promptly).

## [0.4.14] - 2026-06-21

### Fixed

- **Completed the bot_username cutover.** The telegram sender-guard (`hasTelegramPresence`)
  now keys on `interfaces.telegram.bot_username` (the cutover's binding key) instead of the
  legacy `bot`; the host registry was regenerated from the per-cwd source of truth, dropping
  the stale `interfaces.telegram.bot` field across the fleet. telegram-runtime already
  resolved on `bot_username`, so the foundation guard was the last consumer of `bot`.
- `recordDrift` (verify / reconcile) now compares the `interfaces` passport with an
  order-insensitive canonical compare, so a source↔derived divergence is detected and healed
  by `verify --fix` — the class that had let the derived registry silently keep a field
  removed from the source of truth.

### Changed

- Fact-actualized the repo docs against the current code: pty-only (tmux references removed),
  no canary/forensics in postmortem diagnostics, and the legacy `runtime`-mirror drop.
- Unified the README to the fleet documentation style.

### Added

- This changelog (Keep a Changelog), shipped in the npm package.
- HD hero GIF in the README (1440×726 — sharper terminal text).

## [0.4.13] - 2026-06-20

### Fixed

- `verify --fix` now strips the legacy `runtime` mirror from **every** profile that still
  carries it, not only the ones that triggered a warning — completes the fleet-wide cleanup.

## [0.4.12] - 2026-06-20

### Fixed

- `migrateProfileRuntimeField` strips any legacy `runtime` field, so `verify --fix` cleans
  the whole fleet.

## [0.4.11] - 2026-06-20

### Changed

- Local peer profiles no longer write the legacy `runtime` mirror — `default_runtime` is the
  single field (Phase-3, local half). A read-fallback still understands older profiles that
  carry only `runtime`.

## [0.4.10] - 2026-06-20

### Changed

- The registry (`peers-profiles.json`) no longer writes the legacy `runtime` mirror
  (Phase-3, registry half).

### Removed

- Two proven-dead internal symbols (audit safe-cuts).

## [0.4.9] - 2026-06-20

### Removed

- **tmux removed entirely — the foundation is now pty-only.** The tmux launch / delivery /
  occupancy paths and the retired tmux→pty burn-in observer are gone; session hosting runs
  through the pty supervisor (which owns the pty, the pane-log, and the delivery socket).
  `render.ts` is kept as a shared leaf.

## [0.4.8] - 2026-06-20

### Fixed

- The supervisor self-heals a pane-log that was unlinked out from under a live session
  (Defect 2).

## [0.4.7] - 2026-06-20

### Fixed

- An unreadable hosted pane-log is no longer treated as composer-busy — fixes an IAP
  delivery stall.

### Added

- Ping-pong hero demo GIF in the README.

## [0.4.6] - 2026-06-19

### Fixed

- Unified omitted-runtime resolution across `new` / `attach` / `compact`.

## [0.4.5] - 2026-06-19

### Fixed

- `init` declares all installed agentic runtimes (parity with `create`).

### Changed

- README: moved "What makes it different" above Quick start; polished the Bypass Permissions
  security disclosure.

## [0.4.4] - 2026-06-19

### Fixed

- Clear the virgin-Claude bypass-accept + project-MCP first-run dialogs (unblocks a
  fresh-machine boot).
- Release scripts push explicitly with `git push origin main --follow-tags`.

### Changed

- Alias namespace `/alias-*` → `/alias_*` (Telegram slash-command constraint).

### Added

- Clean-install first-run dialog reference in docs/07 (EN + RU).

## [0.4.3] - 2026-06-19

### Added

- FU13: targeted CLI argument errors — no more generic help-wall dump.

### Fixed

- onboard: marketplace add no longer shows a bare red "failed" on a transient first run.

### Changed

- docs/07: note the one-time double-run when upgrading from a pre-cascade (<0.4.2) version.

## [0.4.2] - 2026-06-19

### Added

- **FU12: `iapeer update` cascades the whole stack** — foundation + every installed runtime +
  the memory provider in one command. The foundation goes first and is health-checked; a hard
  foundation failure aborts the cascade.

## [0.4.1] - 2026-06-19

### Added

- Per-package ecosystem docs scaffolded to a stable host path `~/.iapeer/docs/<pkg>/`, with a
  host-context docs pointer in the system prompt (FU6).
- Global host-doctrine stub `~/.iapeer/IAPEER.md` scaffolded on install (FU11).
- CI-status + dynamic license badges in the README (FU10).
- A no-empty-acks instruction on the agent tool surface.

### Changed

- Polish batch: onboard summary ANSI, advisory install commands, help/list formatting, the
  create-runtime prompt.
- Dropped `bot_username` from the telegram-interface example and fixtures.

## [0.4.0] - 2026-06-18

### Added

- `iapeer uninstall` — symmetric, namespace-safe foundation removal (S4).
- Onboard wizard hardening (S1–S3): host-runtime detection threading `--runtime` to memory
  init, the notifier scheduler and Telegram as default steps, visual polish with honest
  slow-step labels.

### Fixed

- install: exact-pin cache-bust + keychain heads-up.

## [0.3.0] - 2026-06-18

### Added

- **Public one-line installer** (`curl -fsSL … | sh`) with GitHub Pages hosting — `install.sh`
  is deployed from `main` so the served script is identical to source.
- **Onboard wizard (Ink TUI)** — first slice behind an opt-in flag, then feature-complete and
  default; `install.sh` stops launching onboard directly.

### Changed

- README documents both install paths (one-liner + manual).

## [0.2.99] - 2026-06-18

### Added

- Ship `docs/` in the npm package (excluding `docs/internals`).

### Changed

- README: humans also take part in the terminal via `iapeer attach`.

## [0.2.98] - 2026-06-18

Initial public release — the foundation core of the iapeer multi-agent ecosystem.

### Added

- **Data layer** — identity (`<runtime>-<personality>`), registry (`peers-profiles.json`,
  single-writer), storage (the `~/.iapeer` layout with atomic writes), codec (the IAP envelope).
- **Always-on router daemon** — a canonical HTTP-MCP Streamable router exposing the single
  agent tool `send_to_peer`; dual-listen — a `0600` unix socket for same-host local callers and
  a TCP loopback for real MCP clients.
- **Warm-on-demand lifecycle** — wake-on-miss, idle-reap, zombie-sweep, fresh-vs-resume by
  death cause, a crash-loop guard, and a durable decision log.
- **Launch primitive + runtime adapters** — Claude, Codex, Telegram, and notifier; layered
  system-prompt composition; launchd plist rendering.
- **Install / onboard chain** and the `iapeer` CLI (create, init, list, verify, status, send,
  attach, update, and more).
- **Heterogeneous peers** — AI agents (Claude, Codex), humans (Telegram), and services
  (timer = cron, watcher = event) are all first-class and addressed the same way.

[Unreleased]: https://github.com/agfpd/iapeer/compare/v0.4.22...HEAD
[0.4.22]: https://github.com/agfpd/iapeer/compare/v0.4.21...v0.4.22
[0.4.21]: https://github.com/agfpd/iapeer/compare/v0.4.20...v0.4.21
[0.4.20]: https://github.com/agfpd/iapeer/compare/v0.4.19...v0.4.20
[0.4.19]: https://github.com/agfpd/iapeer/compare/v0.4.18...v0.4.19
[0.4.18]: https://github.com/agfpd/iapeer/compare/v0.4.17...v0.4.18
[0.4.17]: https://github.com/agfpd/iapeer/compare/v0.4.16...v0.4.17
[0.4.16]: https://github.com/agfpd/iapeer/compare/v0.4.15...v0.4.16
[0.4.15]: https://github.com/agfpd/iapeer/compare/v0.4.14...v0.4.15
[0.4.14]: https://github.com/agfpd/iapeer/compare/v0.4.13...v0.4.14
[0.4.13]: https://github.com/agfpd/iapeer/compare/v0.4.12...v0.4.13
[0.4.12]: https://github.com/agfpd/iapeer/compare/v0.4.11...v0.4.12
[0.4.11]: https://github.com/agfpd/iapeer/compare/v0.4.10...v0.4.11
[0.4.10]: https://github.com/agfpd/iapeer/compare/v0.4.9...v0.4.10
[0.4.9]: https://github.com/agfpd/iapeer/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/agfpd/iapeer/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/agfpd/iapeer/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/agfpd/iapeer/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/agfpd/iapeer/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/agfpd/iapeer/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/agfpd/iapeer/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/agfpd/iapeer/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/agfpd/iapeer/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/agfpd/iapeer/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/agfpd/iapeer/compare/v0.2.99...v0.3.0
[0.2.99]: https://github.com/agfpd/iapeer/releases/tag/v0.2.99
