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
- Private directory: `<IAPEER_ROOT>/peers/<p>/opencode/` (default root `~/.iapeer`).
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

- `<IAPEER_ROOT>/peers/<p>/opencode/events.jsonl` — append-only journal, one JSON
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
  - Native bootstrap snapshots can repeat part ids, so consumers must **upsert parts by id**.
- `<IAPEER_ROOT>/peers/<p>/opencode/state.json`, written atomically:
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

## Delivery gate

Source changes and isolated native artifacts are allowed. npm publication and host
activation are separate coordinated stages. Neither this document nor the runtime
task authorizes production START, neighbouring service restarts, auth/MFA changes,
or a signing-gate bypass. Final acceptance uses the exact installed published
bytes and a PM-owned activation window with recovery instructions.
