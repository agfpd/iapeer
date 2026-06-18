# 14 — Configuration and logs

[Русский](ru/14-конфигурация-и-журналы.md) · **English**

The core runs on sensible defaults — no separate setup is needed to start. Behavior is fine-tuned with environment variables; logs give material for analysis when something has gone wrong.

## Environment variables

All values below are the defaults from the current code. A variable is set in the daemon's environment or a specific peer's (via `launch.env`, see [06 — Storage](06-storage.md)).

### Lifecycle

| Variable | Default | What it sets |
|---|---|---|
| `IAPEER_IDLE_SECS` | `3600` | After how many idle seconds the daemon closes an agent session (sleep). |
| `IAPEER_BOOT_DEADLINE_SECS` | `240` | How long to wait for a session to load on bring-up before treating the launch as failed. |
| `IAPEER_READY_GATE_SECS` | `120` | How long to wait for the agent to be ready for input after load. |
| `IAPEER_CRASHLOOP_MAX` | `3` | How many deaths in the window are allowed before the daemon stops bringing the peer up. |
| `IAPEER_CRASHLOOP_WINDOW_SECS` | `300` | The window (seconds) over which deaths are counted for restart-loop protection. |
| `IAPEER_EPHEMERAL_QUIET_SECS` | `20` | The quiet window after which an ephemeral worker that already replied winds down. |
| `IAPEER_EPHEMERAL_UNARMED_IDLE_SECS` | `600` | The safety bound for an ephemeral worker that stays silent and sent no reply. |

The daemon's supervisory tick is fixed — once a minute, not configurable.

### Daemon

| Variable | Default | What it sets |
|---|---|---|
| `IAPEER_PORT` | `8765` | The router's TCP port on `127.0.0.1`. |
| `IAPEER_DAEMON_SOCKET` | `~/.iapeer/state/iapeer/router.sock` | The daemon's local socket path. |
| `IAPEER_BEARER_TOKEN` | — | If set, the daemon requires this bearer token at the entrance; otherwise token checking is off. |

### Message delivery

| Variable | Default | What it sets |
|---|---|---|
| `IAP_HOST_LIVENESS_GRACE_MS` | `4000` | How long to wait for confirmation that a session accepted a message before treating it as dead. |
| `IAP_LIVENESS_GRACE_MS` | `3000` | The liveness-check window for a busy session (by the conversation-history shift). |
| `IAPEER_COMPOSER_QUEUE_TIMEOUT_MS` | `120000` | How long the composer queue waits for the input field to free before force-delivering. |
| `IAPEER_COMPOSER_QUEUE_POLL_MS` | `500` | The poll frequency of the input field in the composer queue. |

### Paths and binaries

| Variable | Default | What it sets |
|---|---|---|
| `IAPEER_ROOT` | `~/.iapeer` | The storage root. Changing it isolates sockets into `<root>/socks` (useful for isolated test hosts). |
| `IAPEER_SOCK_DIR` | `/tmp` | The host-wide socket directory. Overrides the host-wide location. |
| `IAPEER_BIN_DIR` | `~/.local/bin` | Where the `iapeer` binary is installed. |
| `IAPEER_LAUNCHAGENTS_DIR` | `~/Library/LaunchAgents` | The launchd plists directory. |
| `IAPEER_CLAUDE_BIN` | `~/.local/bin/claude` | The path to the Claude binary. |
| `IAPEER_CODEX_BIN` | `codex` (from `PATH`) | The path to the Codex binary. |
| `NOTIFIER_RUNTIME_BIN` | `notifier-runtime` (from `PATH`) | The path to the notifier launcher (for launchd with its minimal `PATH`). |
| `TELEGRAM_RUNTIME_BIN` | `telegram-runtime` (from `PATH`) | The path to the Telegram launcher. |
| `CODEX_HOME` | `~/.codex` | An override for Codex's global config directory. |

### Logs

| Variable | Default | What it sets |
|---|---|---|
| `IAPEER_LIFECYCLE_LOG_MAX_BYTES` | `5 MiB` | The `lifecycle.log` size at which rotation happens. |
| `IAPEER_LIFECYCLE_LOG_KEEP` | `5` | How many `lifecycle.log` rotations to keep. |
| `IAPEER_DELIVERY_LOG_MAX_BYTES` | `5 MiB` | The `delivery.log` size for rotation. |
| `IAPEER_DELIVERY_LOG_KEEP` | `5` | How many `delivery.log` rotations to keep. |
| `IAPEER_SUPERVISE_LOG_VERBOSE` | off | A verbose log of supervisory ticks (by default only decisions are written, not routine "doing nothing"). |
| `IAPEER_DAEMON_LOG` | off | An extended daemon log. |

### Internal, dev, and test

`IAPEER_TEST_SANDBOX=1` turns on write protection for real paths: the install refuses to write into the real `~/.local/bin/iapeer` and requires `IAPEER_BIN_DIR` set to an isolated path. For development and automated tests, not for normal work.

A few more variables the system reads but that aren't set in normal operation:

- `NOTIFIER_FALLBACK_TARGET` — a fallback recipient for notifier signals; the core resolves it into the peer's plist at onboarding (no hardcode), the operator doesn't set it by hand.
- `IAP_TMUX_PASTE_SETTLE_MS`, `IAP_TMUX_SUBMIT_TIMEOUT_MS` — delivery timings in the internal tmux dev branch; production uses the pty supervisor ([13 — Architecture and contract](13-architecture-and-contract.md)), so they aren't needed outside development.
- `IAPEER_SHADOW_PATH` — the `PATH` for a shadow-fidelity run (an internal development tool).

## Logs and diagnostics

The daemon keeps three durable logs in `~/.iapeer/logs/iapeer/`:

- **`lifecycle.log`** — lifecycle decisions: wakes, sleeps, restarts, supervisory-tick outcomes. The first place to look if a peer is behaving wrong.
- **`delivery.log`** — the outcome of each delivery: who, to whom, into which runtime, the result, sizes, topic. Metadata only — **the message body is not written**.
- **`exits.log`** — session deaths with postmortem data: the supervisor records the cause (exit code / signal) at the moment a session dies.

### Postmortem diagnostics

The cause of a session's death (exit code / signal) the supervisor records at the moment of death — what an ordinary "is the process alive" check misses. A separate canary holds a connection to the supervisor and, on a session's death, writes the circumstances to `exits.log`: memory, swap, top processes by consumption, system diagnostic reports. It's the material for answering "why did the agent die".

### Full Disk Access

To read system diagnostic reports, the `iapeer` binary needs Full Disk Access (FDA) — a macOS permission. `iapeer status` shows whether FDA is granted and hints at what to do if not. Without FDA, peers will hit TCC prompts when accessing protected folders and third-party app containers.
