# 20 — OpenCode agent runtime

**Implementation in progress; not a released capability.** This is the acceptance
contract, not a claim that the matrix below has passed. Existing Claude/Codex
behaviour and the signing-phase activation restrictions remain unchanged.

## Ownership and mechanism

OpenCode is an **agent adapter**, not an infrastructure router. Its native process
and TUI belong to the existing pty supervisor; wake, locks, crash guard, idle-reap,
resume/fresh choice, identity, routing and operator commands stay foundation-owned.
It does not acquire a launchd KeepAlive plist or bypass H4.

Provider and model configuration belongs to OpenCode configuration/launch.env.
NVIDIA is one provider, not a dependency of the adapter. Credentials are environment
references or native credential storage, never embedded in generated artifacts.

The native `agent.iapeer.prompt` replaces the provider's built-in base prompt.
The native environment, tools and project-instruction channels remain enabled, as
they do for Claude/Codex. A user-message prefix is not a system-prompt replacement.
The file is re-composed on every process launch, including resume; live processes
keep their launch snapshot. Foreign config/plugins are preserved, not overwritten.
OpenCode's inline config **merges** other sources; managed config/MDM can override
it. Effective-config checks must refuse a conflicting required setting rather
than claim success, erase foreign settings, or circumvent an administrative gate.

Structural delivery/readiness/control use the native plugin SDK, not a guessed
screen glyph or a successful process spawn. The core-owned plugin must be present
and healthy before incoming delivery. The native TUI remains the attach surface.
An acknowledgement means the **specific message** is persisted/accepted, not merely
that bytes reached a socket. Message IDs, session IDs, tool events and errors must
remain available to history/observability clients. No mandatory command may succeed
as a silent no-op.

## Memory-provider ABI (agreed with iapeer-memory)

- Existing slot `provision-peer --personality <p> --runtime opencode --cwd <cwd>`.
- Canonical child ABI: `PEER_PERSONALITY`, `PEER_RUNTIME=opencode`,
  `PEER_IDENTITY=opencode-<p>`; `IAPEER_IDENTITY` is an alias set by the core.
- Private directory: `<IAPEER_ROOT>/state/opencode/<p>/` (default root `~/.iapeer`).
  It lives under the core's `state/`, never in the agent's working tree (the default
  peer cwd is `<root>/peers/<p>`). Moved there from `<root>/peers/<p>/opencode/` on
  2026-10-17, before any release (no producer ever wrote the old path; it is not
  read or migrated).
  Provider and capability commands receive it from the core as `{privateDir}` and
  `IAPEER_PRIVATE_DIR` (docs/21); they never compute it.
  Memory owns `iapeer-memory.json` and `iapeer-memory-plugin.mjs` there. The core
  reads the JSON fragment on each launch and merges its `mcp` and `plugin` fields
  into runtime overrides. Missing means no memory surfaces; malformed/present
  means an explicit failure. Other keys are rejected, not given core authority.
- MCP fragment uses `type: remote`, `oauth: false`, and
  `headers: {"X-IAPeer-Identity": "{env:PEER_IDENTITY}"}`. Memory owns its MCP and
  write-attribution hooks; foundation owns IAP, doctrine and approvals.
- Guide/index remain ordinary global/local `.iapeer/fragments` input to the
  foundation composer. They are not duplicated in a separate OpenCode memory.
- Unprovision receives `--personality` as well as `--cwd` and `--runtime` so removal
  cannot target another personality sharing a working directory.

## Observability ABI (agreed with web-runtime, telegram-runtime, statusline-injector)

**Contract under implementation — no live producer yet.** Consumers must not treat
a synthetic fixture as proof of the producer; the core ships a native source harness.

The core is the **single producer**. Consumers read only these files, never the
native OpenCode SQLite DB or a second SDK client:

- `<IAPEER_ROOT>/state/opencode/<p>/events.jsonl` — append-only journal, one JSON
  object per line:
  `{schema:1, seq, time:<epoch ms>, identity:"opencode-<p>", launchID,
  sessionID:<native ses_…|null>, type, properties, nativeID:<event.id|null>}`.
  - `seq` is monotonic across process restarts and resumes. The journal is never
    rotated or renamed on fresh. Consumers dedup by `seq`.
  - Native events are passed through **unchanged** (`type` + `properties`):
    `message.updated` (info: tokens, cost, modelID, providerID, time.completed),
    `message.part.updated` (the full part with id, tool args/output),
    `message.part.delta`, `session.status`, `session.error`, `session.created`,
    `session.compacted`, `permission.asked`/`permission.replied`.
  - Core events: `runtime.ready` `{session:<native session info>, resumed:boolean}`;
    `runtime.stopped` `{reason, exitCode?:number, signal?:string}`. A resume emits
    `runtime.ready` with the existing session; it never fabricates `session.created`.
    **Every process launch that reaches readiness writes exactly one `runtime.ready`**
    with a new `launchID`, including resume, so the main session is recoverable from
    the journal alone. A launch that fails before readiness writes `runtime.error`
    `{error}` under its `launchID` instead.
  - Consumers: web-runtime, telegram-runtime and iapeer-memory's weekly collector (it
    relies on the path, `time`, unchanged `type`/`properties` and no rotation).
    statusline-injector reads in-process (its own plugin hook, which also receives the
    context window), so the journal is optional for it. Any ABI change is announced
    to all four.
  - Per-peer plugin fragments merged into the launch config are the memory provider's
    plus those of every registered capability (docs/21). No plugin list is hardcoded.
  - Native bootstrap snapshots can repeat part ids, so consumers must **upsert parts by id**.
- `<IAPEER_ROOT>/state/opencode/<p>/state.json`, written atomically:
  `{schema:1, identity, cwd, sessionID, launchID, startedAt, lastEventSeq,
  lastActivityMs, status:"starting|idle|busy|approval|error|stopped", error?}`.
  - `lastEventSeq` is a fence: every journal line with `seq ≤ lastEventSeq` is
    durable on disk before the state write.
  - Busy/idle comes from `status`, not from the pane-log mtime.
  - An abrupt process death (SIGKILL) is recorded by the core supervisor; the
    in-process plugin alone cannot promise `stopped`. A stale `busy` after a death
    is resolved from supervisor liveness.
- Session identity: exactly one native session per personality. Fresh starts a new
  ID; resume keeps the same one.
- Turn completion: correlate assistant `info.time.completed` with terminal tool
  parts. `session.status` idle is a native observation only: it does not guarantee
  that no event is still in flight. The live ordering is still to be verified.
- Control (`interrupt`/`new`/`compact`) and approvals use the existing Fleet API and
  approval faces. There is no new face API.
- Endpoint selection: send and control from one channel dialogue anchor on the
  same endpoint. A send without a runtime resolves to the profile's
  `default_runtime`. `delivery.delivered_to.runtime` is authoritative for activity.
  The live runtime is not a selector when two endpoints are live.

Open core contracts this ABI depends on:

- **Agent-endpoint discovery** — the declared profile runtimes plus the agent
  adapters the core supports, for channel menus. Not `Bun.which` and not a
  consumer-side hardcode.
- **Capability-plugin lifecycle** — a stable declaration through which a
  registered capability plugin (e.g. statusline-injector) gets
  provision/unprovision per peer and runtime, like the memory slot. Until it
  exists, a manual install is not reported as final.

## Acceptance matrix

`OPEN` includes implementation and/or missing live proof. Unit tests, config-file
existence and isolated SDK probes alone do not close an end-to-end row. Row IDs are
stable interfaces for the independent acceptance harness.

| ID | Mandatory invariant and normal triggers | Owner / evidence required | State |
|---|---|---|---|
| OC01 | create/init/add-runtime; discovery intelligence gate; no default-runtime migration | core; cold peer and shared-cwd contrast | OPEN |
| OC02 | explicit/default endpoint, simultaneous runtimes, exact per-request identity | core; real MCP headers and routing contrast | OPEN |
| OC03 | cold/warm inbound, busy queue, attachments, response, no loss/duplicate | core; native records, IAP history, 3/3 full cycles | OPEN |
| OC04 | process launch, MCP import, actual readiness, missing/invalid config/plugin failure | core; native process and effective-config contrast | OPEN |
| OC05 | attach/detach, human input coexistence, full native history | core + channel clients; actual PTY and history replay | OPEN |
| OC06 | stop/start, idle-reap/resume, refresh/new/self-fresh/self-done | core; each original trigger and same/fresh session IDs | OPEN |
| OC07 | abrupt death, crash-loop guard, restart/recovery, durable queued work | core; actual death and recovery, not synthetic mid-pipeline events | OPEN |
| OC08 | base system swap, native instructions, fresh doctrine on resumed history | core; wire capture before/after full process restart | MECHANISM VERIFIED; adapter proof OPEN |
| OC09 | memory MCP, shared personality, guide/index, native write/edit/patch authorship, removal | memory provider + core slot; isolated vault and actual tool writes | OPEN |
| OC10 | gated/yolo, native risky action → broker allow/deny/timeout/cancel; direct attach race | core + approval faces; real risky triggers, no production cards | OPEN |
| OC11 | interrupt and compact, completion/failure detection; unsupported runtime-specific commands fail loud | core; native turn interruption/compaction records | OPEN |
| OC12 | native skills and MCP extensions; foreign configuration preserved | core + capability owners; actual tool/skill calls | OPEN |
| OC13 | state, busy/idle/tool work, errors/notices, usage where available, full owner-channel history | core event contract + web/telegram/statusline owners | OPEN |
| OC14 | install/update/remove/rollback; signature/exec failure preserves previous state | core + provider installers; exact installed published artifact | OPEN |
| OC15 | provider-independent config and NVIDIA synthetic cloud trial | core + linus; native model/tool behaviour, no fleet secrets/memory | OPEN |
| OC16 | Claude/Codex and H4/path-isolation regressions | core + PM; hermetic suite and coordinated native regression | OPEN |

Codex thread goals and third-party Claude/Codex marketplace plugins are not
cross-runtime guarantees. Their availability is reported explicitly. Native
OpenCode skills, core MCP and the mandatory memory/approval surfaces are required;
calling those optional would not satisfy this contract. Unavailable provider
metrics are null/unknown, never fabricated zeroes.

## Verified mechanism baseline — 2026-10-17

Native npm `opencode-darwin-arm64@1.19.3`, executable SHA-256
`6d3e6458fce4b649edf974c19959d5dbfe1e7f255a503dcfc01215b24ad3ea5b`.
The official source tag `v1.19.3` resolves to
`e3c4eb242585dcd77be1a867391b7c25fd47ce52`; this is a source reference, not
cryptographic provenance of the npm binary (npm metadata has no gitHead).

The native server was started against a local synthetic OpenAI-compatible provider,
fresh HOME/XDG directories and a synthetic working directory. The first wire system
starts with doctrine ONE; after full process stop/start, the same session's next
system starts with doctrine TWO and contains no ONE. Both user turns survive;
native AGENTS.md remains in both system messages. This establishes swap/resume
semantics, not fleet delivery or the acceptance cycles. Production and NVIDIA were
not contacted. The original probe retained the two requests and native events;
the reproducible packaged proof is part of the implementation deliverable.

Official references (checked against native 1.19.3, not assumed from latest docs):
[CLI](https://opencode.ai/docs/cli/),
[agents](https://opencode.ai/docs/agents/),
[plugins](https://opencode.ai/docs/plugins/),
[MCP](https://opencode.ai/docs/mcp-servers/),
[config precedence](https://opencode.ai/docs/config/#precedence-order),
[NVIDIA](https://opencode.ai/docs/providers/#nvidia),
[native prompt selection](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/session/llm/request.ts),
[native permission lifecycle](https://github.com/anomalyco/opencode/blob/v1.19.3/packages/opencode/src/permission/index.ts).

## Core plugin and native harness — 2026-10-17

`src/opencode/iapeer-plugin.mjs` is the core-owned plugin. It is embedded in the
binary as text and written to `<dir>/iapeer-plugin.mjs` before every launch. Its
launch environment is `IAPEER_OPENCODE_DIR`, `PEER_IDENTITY`,
`IAPEER_OPENCODE_LAUNCH_ID` and, for resume, `IAPEER_OPENCODE_SESSION`. It produces
the observability ABI above and serves `<dir>/control.sock`
(`src/opencode/control.ts`). The socket takes one JSON line per connection:
- `ping` returns the identity, session and status;
- `deliver {text}` acknowledges `{messageID}` only after the native
  `message.updated` for that exact core-chosen ID is observed;
- `interrupt` runs the native abort;
- `select` publishes `tui.session.select`.

Readiness runs after plugin init returns, because calling the in-process client
during plugin loading would wait on the instance being built.

`scripts/opencode-native-harness.ts` runs the real binary (`opencode serve`) with a
synthetic provider and an isolated HOME and root. Run of 2026-10-17 on native 1.19.3:
16/16 checks passed.
- Readiness and ping.
- Idle delivery acknowledged after persistence; doctrine on the wire.
- A delivery during a running slow turn was acknowledged in 8 ms and processed after
  that turn. The native queue is durable.
- Interrupt.
- Contiguous `seq` and the state fence.
- Full process restart with `--session`: same session, `resumed=true`, `seq`
  continues, the new doctrine replaces the old one, native `AGENTS.md` and earlier
  history are kept.

This proves the producer and plugin mechanics under `serve`. It does not prove the
TUI-under-supervisor adapter, matrix rows or acceptance cycles.

Native findings that bind the adapter:
- **Cold config dir means npm on the critical path.** Before loading any external
  plugin, OpenCode runs `npm install @opencode-ai/plugin@<version>` in each config
  dir that lacks it (`Config.waitForDependencies`). On 17.10 this took about 60 s
  on one run and hung for over 4 min on others: a single npm https connection
  stalled. The adapter must install and verify this dependency at
  `install-runtime`/update time, not on the wake path. The harness uses
  `--seed-config` for offline determinism.
- **`serve` builds the directory instance lazily** (on the first request); the TUI
  does it at startup.
- **A SIGTERM during startup can leave the process running.** It killed the npm
  child, then initialization continued. Stop must escalate TERM → KILL. The plugin's
  `dispose` does not run on a signal, so `runtime.stopped` for a signal death is the
  supervisor's job.

## Adapter under the pty supervisor — 2026-10-17

`src/launch/adapters/opencode.ts` implements the structural adapter hooks
(`RuntimeAdapter.prepareLaunch / structuralReady / deliver / control`,
`deliveryConfirm: 'structural'`). Nothing reads the screen:
- `prepareLaunch` writes the plugin, re-composes `OPENCODE_CONFIG_CONTENT` from
  the freshly composed doctrine on every launch (resume included) and sets the
  plugin env with a new `launchID`;
- readiness is the `runtime.ready` line of **that** `launchID` written after the
  prepare-time journal offset, plus a control ping answering the same `launchID`;
- the first and every warm message go through `deliver`, whose ack means the
  message is persisted natively; there is no composer hold and no pty paste;
- `interrupt` is native abort; other control commands fail loud;
- resume reads `state.json` `sessionID`; idle accounting reads
  `state.lastActivityMs` (busy/approval count as activity now);
- the supervisor records `runtime.stopped` + `status:stopped` on child exit and on
  teardown (idempotent with a graceful dispose). Teardown SIGKILLs the child.

`scripts/opencode-supervised-harness.ts` drives the real `launch()` with the
native TUI hosted by the supervisor (isolated HOME/root, synthetic provider).
Run of 2026-10-17 on native 1.19.3: 16/16 — cold READY in 3.5 s with the
first message delivered; doctrine and native `AGENTS.md` on the wire; transport
warm delivery idle and busy (busy acked in 6 ms, processed after the slow turn);
interrupt; unsupported control refused; the TUI renders the core session;
teardown → `runtime.stopped`; contiguous `seq`; resume on the same session with
`resumed=true`, the new doctrine replacing the old, history kept.

`scripts/opencode-wake-harness.ts` goes through the fleet lifecycle with a
registered peer (`initPeer --runtime opencode`). Run of 2026-10-17: 9/9 — cold
wake by a message (READY in 2.6 s, task delivered as the first message); the
composed doctrine (identity YAML + local `IAPEER.md`) is the system prompt; a
wake on a live session is idempotent; the supervise tick idle-reaps from the
plugin state; the next message on the same topic resumes the same native session
with the re-composed doctrine and earlier history. A topicless message after an
idle-reap wakes fresh — core executor policy, identical for every runtime.

`initPeer --runtime opencode` (create/add-runtime) first satisfies the native
plugin-dependency no-op in every OpenCode config dir (`src/opencode/deps.ts`:
`node_modules` present and `@opencode-ai/plugin` in the lock root, pinned to
`opencode --version`). A failure aborts before the runtime is registered. Real
npm, isolated HOME: installed in 11 s, the repeat is `present` with no network.

`scripts/opencode-mcp-harness.ts` runs a sandboxed daemon in-process with two
registered opencode peers. Run of 2026-10-17: 10/10. The core MCP is imported
(`iapeer_send_to_peer` offered next to native `bash`); the model's native `bash`
call runs; its `send_to_peer` call reaches the daemon with OpenCode's identity
header, wakes the receiver on miss and delivers through the structural path. The
receiver sees `<iap from="ocsend" runtime="opencode" …>`, the tool result is
`ok` with `delivered_to.runtime: opencode`, the sender's journal has completed
tool parts, and `delivery.log` records the send.

Observation (not closed): on startup the native TUI may detect its install method
by probing package managers (`npm/yarn/pnpm/bun list -g`, `brew list`) unless
the binary lives in `~/.opencode/bin` or `~/.local/bin`. With a fresh HOME a
`brew` probe auto-updates over the network. The adapter sets
`OPENCODE_DISABLE_AUTOUPDATE=1`; the official installer location avoids the
probes entirely.

Still not proved here: a live daemon on the host,
approval routing, memory slot, two simultaneous runtimes of one personality.
Since the commit after this proof, `opencode` is a supported local agent runtime:
listed in `host.agent_runtimes` (docs/15), accepted by `add-runtime`/`create
--runtime opencode`, gated to artificial peers, refreshed by `refresh`, and
included in the memory provider's provision/unprovision runs and in capability
applicability (docs/21). `create` does NOT auto-add it as a secondary runtime
(an endpoint without a provider/model configuration would be dead) — it is an
explicit opt-in. The binary resolves from `IAPEER_OPENCODE_BIN`, else
`~/.opencode/bin/opencode`, else `opencode` on PATH.

## Delivery gate

Source changes and isolated native artifacts are allowed. npm publication and host
activation are separate coordinated stages. Neither this document nor the runtime
task authorizes production START, neighbouring service restarts, auth/MFA changes,
or a signing-gate bypass. Final acceptance uses the exact installed published
bytes and a PM-owned activation window with recovery instructions.
