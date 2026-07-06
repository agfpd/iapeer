# 15 — Fleet API

The daemon's HTTP surface for **operator clients**: dashboards, menu-bar apps, scripts, future web gateways. It serves three things: a **snapshot** of the fleet state, a **live event stream**, and **commands** over the existing management verbs. Everything an `iapeer list`-style client needs — without parsing CLI output.

This is a **normative contract**: fleet clients (SwiftBar plugins, native apps, web pages) are written against this document, not against the daemon source. The MUST/MUST NOT rules in «Client obligations» below are load-bearing — a client that skips them will break on a future daemon update.

## Surface and transport

- Base path: **`/fleet/v1`**, plain HTTP + JSON (+ SSE for events). This is *not* MCP: MCP (`/mcp`) is the agent surface and deliberately carries a single tool; fleet clients are GUIs and scripts that consume HTTP natively.
- Served on **both** daemon listeners:
  - the unix socket `~/.iapeer/state/iapeer/router.sock` — `curl --unix-socket ~/.iapeer/state/iapeer/router.sock http://iapeer/fleet/v1/snapshot`
  - TCP loopback — `http://127.0.0.1:8765/fleet/v1/snapshot`
- **Discovery:** read `~/.iapeer/state/iapeer/router.json`. A daemon that serves this API advertises `"fleet": 1` there, next to the active `sock`/`tcp` addresses and the daemon `version`. Absent `fleet` key ⇒ pre-fleet daemon ⇒ the client must degrade (hide, or fall back to CLI).
- **Auth:** when the daemon is configured with a bearer token (`IAPEER_BEARER_TOKEN`), every fleet request must carry `Authorization: Bearer <token>` — the same gate as MCP, checked before dispatch. Without a configured token, the surface is open to the local user (same trust class as the CLI: loopback + same-uid socket).
- **No CORS headers, deliberately.** A browser page must not be able to drive loopback fleet commands cross-origin. A web gateway is a separate future decision with mandatory auth.

## Client obligations (normative)

1. **Unknown event kinds MUST be ignored.** The `ev` vocabulary grows without a version bump (e.g. future `approval-request` / `approval-resolved`). A client that throws on an unknown `ev` is broken by design.
2. **Unknown JSON fields MUST be ignored.** The snapshot and every response evolve **additively** within `/fleet/v1`: new fields appear, existing fields keep their meaning and type. Removals or type changes would be a `/fleet/v2`.
3. **Events are at-least-once.** After an SSE reconnect (and around log rotation) a client may see an event twice. The SSE `id:` is the event's epoch-ms timestamp — use it (plus field equality) for display-level dedup. There is no exactly-once replay cursor; on reconnect, re-fetch the snapshot and resume from live events.
4. **The snapshot is the state; events are change hints.** The intended loop: fetch `/snapshot` once, subscribe to `/events`, re-fetch `/snapshot` when an event arrives (cheap, coalesce bursts). Do not reconstruct fleet state from events alone.
5. **Ages are client-rendered.** `last_active_ms` is an epoch timestamp; render the ticking «4m ago» yourself instead of polling the snapshot per second.

## GET /fleet/v1/snapshot

The full fleet state. The peer rows are produced by the **same in-process function that renders `iapeer list`** — agreement with the CLI is by construction.

```json
{
  "api": 1,
  "version": "0.4.63",
  "ts": "2026-07-05T18:00:00.000Z",
  "host": {
    "version": "0.4.63",
    "pid": 12345,
    "startedAt": "2026-07-05T09:00:00.000Z",
    "uptimeSecs": 32400,
    "memory": { "provider": "iapeer-memory", "version": "1.2.3", "heartbeatAgeSecs": 12 },
    "voice":  { "provider": "voice-connect", "version": "0.3.1", "heartbeatAgeSecs": null },
    "fda": true
  },
  "peers": [
    {
      "personality": "boris",
      "description": "Напарник Артура по мультиагентной системе",
      "intelligence": "artificial",
      "default_runtime": "claude",
      "cwd": "/Users/me/.iapeer/peers/boris",
      "runtimes": [
        { "runtime": "claude", "status": "live", "attached": true },
        { "runtime": "codex",  "status": "asleep" }
      ],
      "last_active_runtime": "claude",
      "last_active_ms": 1751731100000,
      "attached": true,
      "launchd_managed": false,
      "wake_policy": "warm",
      "approval_mode": "yolo"
    }
  ],
  "approvals": [
    { "id": "a1", "personality": "boris", "runtime": "claude", "kind": "circuit-breaker",
      "tool": "dangerous-rm", "summary": "rm -rf /tmp/x",
      "content": "cmd=\"rm -rf /tmp/x\" target=\"/tmp/x\"", "createdMs": 1751731100000, "expiresMs": 1751731400000 }
  ]
}
```

Field notes:

- `runtimes[].status` — `live` (session up) · `asleep` (wakeable on demand) · `stopped` (operator stop flag; the daemon won't wake it). Same glyph semantics as the CLI: `●` / `○` / `✕`.
- `runtimes[].attached` — present (`true`) only when a **human operator** is attached to that live hosted session.
- `attached` — any runtime attached (peer-level convenience).
- `launchd_managed` — launchd owns this peer's lifecycle (H4): the daemon never wakes/reaps it, and wake/stop/start commands are guarded accordingly.
- `wake_policy` — `warm` (default: wake-on-message, idle-reap, resume) or `ephemeral` (stateless worker: serial task queue, die-after-reply).
- `approval_mode` — the peer's human-approval mode (docs/17-approval): `yolo` (default — launched with the runtime bypass flag, the supervisor auto-confirms circuit-breakers) or `gated` (launched without bypass; the runtime's blocking approval requests are routed to a human through the daemon approval broker). Additive field; a pre-approval daemon omits it — clients MUST treat its absence as `yolo`.
- `queue_depth` — ephemeral peers only: pending tasks across the peer's serial queues.
- `host.memory` / `host.voice` — the provider slots (`null` = empty slot); `heartbeatAgeSecs: null` with a non-null slot = provider declared but its daemon isn't heartbeating.
- `host.fda` — Full Disk Access of the binary: `true` / `false` / `null` (undeterminable).
- The daemon answering **is** the health signal: there is no `healthy` boolean. A dashboard that cannot reach any advertised address should render the daemon as down (this is also why a purely API-fed dashboard is insufficient when the daemon itself is broken — the built-in TUI keeps its direct in-process read path for exactly that case).
- The peer's **LLM model is deliberately absent**: the effective model of a live session is not an observable registry fact (static launch pins exist, but reporting a pin as «the model» would lie under runtime auto-switching). If it ever becomes observable, it will appear as an additive field.
- `approvals` (top-level, docs/17-approval) — the pending human-approval queue, the SAME items `GET /fleet/v1/approvals` returns, carried in the snapshot so a client that already re-fetches `/snapshot` on every event renders the queue with no extra call. **ADDITIVE + OMITTED when the queue is empty** — a client MUST treat its absence as an empty queue (the same rule as `approval_mode`). Each item: `id` (broker id, the target of `POST /fleet/v1/approvals/<id>/(approve|deny)`), `personality` + `runtime` (whose action), `kind` (`tool`|`plan`|`question`|`circuit-breaker`), `tool` (the tool / breaker name), `summary` (a one-line badge string), `content` (the FULL verbatim action — command / diff / plan; criterion #7), `createdMs` / `expiresMs`. The broker's item is a superset — unknown extra fields (`title`, `approvers`) MUST be ignored (obligation 2).

## GET /fleet/v1/peers/&lt;personality&gt;

One peer's card: the same object as the snapshot row, plus its recent history.

```json
{ "api": 1, "version": "0.4.63", "ts": "…", "peer": { …snapshot row… },
  "events": [ { "src": "lifecycle", "ev": "wake", "ts": "…", "personality": "boris", "mode": "resume" } ] }
```

`events` — the newest ≤50 events concerning this peer (matched on personality / `<runtime>-<personality>` identity fields), merged across the logs by timestamp, oldest first. `404` for an unregistered peer.

## GET /fleet/v1/events — SSE stream

`text/event-stream` of fleet events, sourced by tail-following the daemon's **durable logs** (`lifecycle.log`, `delivery.log`, `exits.log`). Those files are written by *every* participating process — the daemon, CLI verbs (attach/stop/wake), the pty supervisors — so the stream covers events an in-daemon bus would miss.

```
GET /fleet/v1/events?replay=50
```

- `replay=N` (0…500, default 0) — emit the newest N historical events before going live.
- Each event:

  ```
  event: wake
  id: 1751731100123
  data: {"src":"lifecycle","ev":"wake","ts":"2026-07-05T18:00:00.123Z","personality":"boris","mode":"resume"}
  ```

  `data` is the full parsed log line: `src` (`lifecycle` | `delivery` | `exits`) + `ev` + every logfmt field with quoted values decoded. `id` = epoch-ms of the event.
- A comment `: connected` marks the transition from replay to live; `: hb` comments every ~15 s keep the connection alive.
- Latency: live events surface within ~0.5 s (log-tail poll).

Current `ev` vocabulary (grows over time — see obligation 1): `wake`, `supervise` (with `action`: `reaped-idle` = parked, `reaped-ephemeral`, `dead`→fresh/resume classification, `eager-orphan-fresh`, `skipped-error`…), `stopped` / `started` (the stop/start verbs — an operator changed a peer's ✕/○ state; `action` is `stopped`/`started` for warm runtimes, `bootout`/`bootstrap` for always-on, with `reason` on failure), `delivery`, `topic-note`, `ephemeral-drain`, `attach` / `attach-end`, `hosted-deliver`, `pty-host-failed`, `supervise-error`, `composer-queue-failed-notify`, `memory-provision`, `session-exit` (from `exits.log`: `cause=child-exit` with `dead_status`/`dead_signal` when the session's process died on its own, `cause=shutdown-sigterm`/`shutdown-sigint` when the supervisor was torn down — reap/stop/new), `supervisor-uncaught` (a survivable supervisor fault left as forensics; the session keeps serving).

What the headline states look like on the stream: a peer **waking** is `ev=wake`; a peer **parked to sleep** is `ev=supervise action=reaped-idle`; an operator **stop/start** is `ev=stopped` / `ev=started`; a **death** is `ev=session-exit` (immediately, from the supervisor) followed by the daemon's classification on its next pass.

## Commands

`POST /fleet/v1/peers/<personality>/<command>` with an optional JSON body `{ "runtime": "claude", "topic": "…" }` (both optional; `topic` is used by `wake` only). The commands are the **existing management verbs called in-process** — every guard (H4 launchd read-only, the foreign-plist fleet guard, the crash-loop guard, wake serialization) lives inside those verbs and cannot be bypassed via the API.

| Command | Verb semantics | Success |
|---|---|---|
| `wake` | bring the peer up (no message; fresh-vs-resume decided by the daemon) | `200` + wake outcome, `502` + `status:"FAILED"` |
| `stop` | set the stop flag / bootout an always-on peer | `200` + `outcomes[]`, `502` if a bootout failed or a foreign plist was refused |
| `start` | clear the stop flag (warm peers become wakeable; no session is launched) / bootstrap always-on | `200` / `502` mirror of `stop` |
| `new` | **unconditional** fresh restart (the emergency lever) | `200` + `action:"fresh"` |
| `refresh` | lazy soft-reload: fresh on next natural wake, no kill | `200` + `outcomes[]` |
| `interrupt` | interrupt a stuck/raving turn (Escape into the live session) | `200` / `502` |
| `compact` | compact the resumable dialogue (honest failure when none) | `200` + `action:"compacted"` / `502` |

`POST /fleet/v1/send` — deliver a message through the same routing path as the `send_to_peer` tool (wake-on-miss, queueing, delivery log — identical semantics):

```json
{ "personality": "boris", "message": "…", "runtime": "claude", "topic": "…", "from": "nova" }
```

`from` is optional: a full `<runtime>-<personality>`, or a bare personality (its default runtime). Default: the **single natural-intelligence peer** of the registry — a GUI-originated message is the human's. With zero or several natural peers the request is refused (`400`) with an instruction to pass `from`.

Not part of the *command* API, deliberately: **attach** (a terminal handoff — a client opens the system terminal with `iapeer attach <peer>`), registry/host **admin verbs** (`create`/`remove`/`update`/`uninstall` — will be added when a client actually needs them). The **human-approval broker** now lives under `/fleet/v1/approvals*` (`GET` the queue / one item, `POST /<id>/(approve|deny)`) with the `approval-request` / `approval-resolved` SSE `ev` kinds and the `approvals` snapshot field above — the full contract is **docs/17-approval**.

Errors are always `{"error": "…"}` with an honest status: `400` malformed request, `401` bearer required, `404` unknown peer/endpoint, `405` wrong method, `502` the verb itself failed, `500` internal.

## Compatibility

- `/fleet/v1` evolves **additively**; `api: 1` in every snapshot. Breaking changes mean `/fleet/v2` served alongside.
- The capability marker in `router.json` (`fleet: 1`) is the feature-detect: clients must treat its absence as «no fleet API» rather than probing endpoints.
