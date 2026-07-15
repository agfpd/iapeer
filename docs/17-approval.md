# 17 — Human approval

A peer can run in one of two **approval modes**. In `yolo` (the default — every peer today) the agent acts autonomously: the runtime is launched with its bypass flag and nothing asks a human before a tool runs. In `gated` the peer is launched **without** bypass, and every blocking approval the runtime would raise is routed to a **human** through the daemon's approval broker — a Telegram button, a tray click, `iapeer approve` on the CLI, or the web console's approvals panel. The human's `allow`/`deny` (with a reason) flows back into the runtime and the tool proceeds or is refused.

This is a **normative contract**. The approval broker is the daemon's, the fleet endpoints and `ev` kinds below are the surface that operator faces (CLI, tray, the Telegram runtime) are written against — not the daemon source. The interception facts (which runtime event fires, in which shape) are pinned to **Claude Code 2.1.201** and **codex-cli 0.142.5**, taken from the live binaries + current runtime docs.

`gated` means **«ask before acting»** — blocking questions surface instead of being bypassed. On **claude**, gated stays sandbox-free (the `PermissionRequest` hook is the interceptor). On **codex**, gated is the EXEMPLAR (reframe 07.07): it runs `approvals ON + a workspace-write sandbox` so codex shows its **OWN native approval modal** in the TUI on a risky action — an attached human answers it right there — while the supervisor proxies that same modal to the bar. iapeer installs **no broker hook** on gated codex (a `PreToolUse` hook would silence the native modal). The shared memory vault (outside every peer cwd) is granted writable so routine memory writes never prompt. See the codex toggle table.

## The approval-mode toggle

### Profile field

A foundation-owned lifecycle field in `peer-profile.json`, next to `wake_policy` / `initial_prompt`:

```json
{ "approval_mode": "gated" }
```

`"yolo" | "gated"`, **default `yolo`**. Only `gated` is persisted — writing `yolo` **removes** the field (so a `gated→yolo→gated` round-trip is byte-identical, and the whole fleet keeps behaving exactly as before this feature existed). The one place the «absent ⇒ yolo» default lives is `approvalModeOf(profile)`; every reader (launch, supervisor, fleet snapshot, CLI) resolves through it and never re-derives it. The mode appears in the fleet snapshot as the additive `approval_mode` field (docs/15) by reading the local profile — a pre-approval daemon omits it and clients MUST treat its absence as `yolo`.

### Launch surfaces the flip touches

The bypass is a **launch argument**, different per runtime, and the mode is a coordinated operation over **all** the surfaces that argument implies. iapeer owns the launch, so completeness is on the foundation.

**claude** (Option D — a matcher-free `PermissionRequest` hook; verified live 2.1.201):

| # | Surface | yolo | gated |
|---|---|---|---|
| C1 | argv `--dangerously-skip-permissions` | present | **removed** |
| C2 | argv permission-mode | (bypass) | `--permission-mode default` (explicit — never inherits an acceptEdits/bypass defaultMode) |
| C3 | ready-gate marker `isInputReady` | needs the `bypass permissions on` banner | banner is **absent** → the marker is mode-aware (composer `❯` + boot dialogs cleared), else the peer never becomes ready and the wake fails |
| C4 | boot-dialog «Bypass Permissions mode» accept | appears (first bypass) | not shown (no bypass) |
| C5 | `PermissionRequest` hook in `<cwd>/.claude/settings.json` | **absent** (0 overhead, byte-identical to today) | **installed** — matcher-free (see below), `command = iapeer approval-hook` |
| C6 | allow-rule for the peer's own MCP tool (`permissions.allow: ["mcp__iapeer__send_to_peer"]`) | not needed (bypass) | **needed** — else default-mode gates the peer's own IAP channel and it hangs on `send_to_peer` |
| C7 | supervisor circuit-breaker (dangerous-rm, above the permission layer) | auto-Yes + audit log | **routed to a human** through the broker |
| C8 | argv `--disallowedTools AskUserQuestion` | stays | stays in v1 (see Limitations) |

**Why matcher-free `PermissionRequest`, not `PreToolUse`.** `PermissionRequest` fires **only when the runtime's permission config decided to prompt** — a call not covered by an allow/deny rule. So the policy of *what to ask* stays 100% at the runtime: a user tunes it with ordinary permission rules (a tool in `permissions.allow` is never asked → the hook never fires → auto-allowed). No class matcher to drift, no new tool slipping through, no hang. iapeer only seeds the hook + the one allow-rule for the peer's own MCP tool.

**codex** (native modal + supervisor proxy — codex-cli 0.142.5):

| # | Surface | yolo | gated |
|---|---|---|---|
| X1 | argv `--dangerously-bypass-approvals-and-sandbox` | present | **removed** |
| X2 | argv approval/sandbox | (bypass) | `-c approval_policy=on-request -c sandbox_mode=workspace-write -c sandbox_workspace_write.network_access=false` (+ `-c sandbox_workspace_write.writable_roots=[…]` when the host has a memory vault). approvals **ON**, an OS sandbox that makes cwd/`/tmp`/`$TMPDIR` + the vault silent and a risky write (outside those) or outbound network pop codex's **native modal**. The old `danger-full-access` was disproven by the live sandbox matrix (07.07): `send_to_peer` (MCP) is unaffected by the sandbox because Seatbelt wraps the shell CHILDREN codex spawns, not the codex process, so the loopback MCP call is never sandboxed; and the vault is restored via `writable_roots`. Session-scoped via `-c`, not host config. |
| X3 | `PreToolUse` broker hook | **absent** | **absent** — gated codex relies on its NATIVE modal + the supervisor proxy, so iapeer installs no broker hook (it would silence the native modal). A prior (pre-reframe) hook is removed on the next gated toggle. |
| X4 | codex cwd-trust `[projects."<cwd>"] trust_level="trusted"` | pre-trusted (both modes) | pre-trusted (matters more with approvals active) |
| X5 | ready-gate `isInputReady` (`›` composer) | mode-independent | unchanged |

The gated↔yolo difference for codex is thus ONLY the launch config + the profile field (no hooks.json either way), so the round-trip is byte-identical by construction. (The `iapeer approval-hook` binary + its codex `allow`→abstain shaping stay in the tree — still correct for any deny-by-rule hook an operator adds, and for claude — they are simply not installed by the codex gated toggle.)

### Idempotency and the application moment

- **argv surfaces** (C1–C2, C8, X1–X2) are computed from the mode on every launch — structurally idempotent, no accumulation.
- **settings.json / hooks.json** (C5–C6, X3) are add-on-gated / remove-on-yolo with a no-clobber merge, keyed on the stable `approval-hook` marker: our block is written deterministically and removed cleanly (an emptied `hooks.PermissionRequest` / `PreToolUse` array is dropped, an emptied `hooks` / `permissions` object is dropped, foreign hooks/rules untouched). A `gated→yolo→gated` round-trip restores the pre-install bytes.
- **codex trust** (X3–X4) reuses the already-idempotent `preSeedCodexHooksTrust` / `removeCodexHooksTrustUnder`.

All surfaces are read/applied **at session start**. A **live session keeps its launched mode** until the next fresh session — exactly like an agentic peer picking up new doctrine lazily on its next wake. The toggle (1) persists `approval_mode`, (2) idempotently brings the settings/hooks surfaces to the mode, (3) does **not** touch the live session. To apply immediately, start a fresh session (`iapeer approval-mode <peer> <mode> --now`, or `iapeer new`/`refresh`).

## Interception mechanism

Both runtimes carry a Claude-compatible **hook** system that intercepts an approval programmatically and returns `allow`/`deny` + a reason + the structured action content. That is the primary mechanism. **pty screen-scrape is a backstop for one class only** — claude's `dangerous-rm` circuit-breaker, which sits *above* the permission layer and no hook can see.

- **claude `PermissionRequest`** — stdin carries `{tool_name, tool_input, …}`; the hook prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow|deny","message":"…"}}}`. A `deny` carries `message` to the model. Fires only on prompt-worthy calls.
- **codex** — gated codex is NOT hook-gated (reframe): it runs `approval_policy=on-request` + a `workspace-write` sandbox and shows its **own native modal**, which the supervisor pty-scrape catches and routes (see below). The `iapeer approval-hook` binary still exists and its codex path is correct (verified live 0.142.5: codex fires `PreToolUse` with `tool_name:"Bash"`; a `deny` hard-blocks the tool and the reason reaches the model; a codex `allow` is unsupported by codex's `PreToolUse` so the hook **abstains** on allow rather than emitting a rejected decision) — but the codex gated toggle does not install it. It remains available for a deny-by-rule hook an operator wires by hand.
- **supervisor circuit-breaker** — claude's `dangerous-rm`/`rmdir` guard (and the standard command-approval prompt a no-bypass session shows) is a TUI select the hook never sees. The pty supervisor reads it off its authoritative model and routes by class (see *Supervisor pty-scrape classification* below): the known auto-Yes classes are pressed under yolo (with an audit line) / brokered under gated, while `org-policy` and any unrecognized `unknown-modal` always go to the human.

The hook binary is the `iapeer approval-hook` subcommand: it reads the runtime's hook JSON on stdin, resolves `PEER_PERSONALITY`/`PEER_RUNTIME` from its session env and the daemon URL from `router.json`, POSTs a blocking request to the broker, and prints the runtime-appropriate decision JSON.

### Supervisor pty-scrape classification (yolo-robustness)

The supervisor nag-watcher classifies every mid-session blocking TUI modal it observes off its authoritative model. It fires only when the pane has been **completely static** for a threshold (the timing stuck-gate: a real blocked modal freezes the pty; a peer merely streaming or rendering the modal text keeps writing) **and** the modal is a live numbered-select that **replaced the composer** (the bottom-most cursor-glyph row is a numbered option, not the composer — the same idle→composer / modal→option invariant the known matchers rest on). Owner rule: **yolo presses what it KNOWS (maximum known rights); anything new or above the peer, the human must SEE and confirm** — never a blind auto-Yes (a modal a runtime raised on purpose must not be swallowed), never a hang.

| Class | Detection | yolo | gated |
|---|---|---|---|
| `dangerous-rm` | known needle (2-option `1.Yes/2.No`) | auto-Yes + audit | broker (Allow=1 / Deny=2) |
| `command-approval` | known needle (3-option `1.Yes/2.Yes,…/3.No`) | auto-Yes + audit | broker (Allow=1 / Deny=3) |
| `org-policy` | known needle ("organization requires approval") | **broker — never auto-Yes** | broker (Allow=1 / Deny=3) |
| `unknown-modal` | **generic** — numbered select (≥2 options) matching NO known signature | **broker — never auto-Yes** | **broker** |

- **`org-policy`** is a barrier ABOVE the peer (an MCP org-restriction). It is recognized but **always routed to the human** on both modes (the owner's org rule is human-only), with the precise 3-option keys. Previously it was excluded from the matcher and a yolo peer HUNG on it — now closed.
- **`unknown-modal`** is the generic residue: a numbered-select modal (a new one Anthropic/OpenAI shipped) matching none of the known signatures. It is **always routed to the human** on both modes. Because the option layout is unknown, the injection is **binary** (v1): **Allow presses option 1** (the proceed/primary position in every known select; the position-robust affirmative) and **Deny presses `Escape`** (the universal modal cancel — it commits no numbered choice, so it can never accidentally affirm). The broker `content` carries **explicit button semantics** — the verbatim modal block plus a header stating exactly what Allow presses (`option 1: "<verbatim label>"`) and that Deny cancels via Esc — so the human decides informed, not on an abstract Allow/Deny. A **>2-way** choice on an unknown modal is a v2 extension (most approvals are binary). If a modal ignores the injected keys (Esc not honored), the daemon **bounds re-enqueue** (a few rounds) then **logs once and safe-parks** — the peer stays blocked (safe), never an infinite ask loop nor a blind Yes. Both claude (`❯`) and codex (`›`) are covered; codex's known boot dialogs are excluded (owned by the boot-driver).

> **This is exactly the path that surfaces gated codex's native approval modal** (the reframe). Verified live (codex-cli 0.142.5): a write outside the workspace/writable roots yields `Would you like to run the following command? … › 1. Yes, proceed (y) / 2. … / 3. No, and tell Codex what to do differently (esc) — Press enter to confirm or esc to cancel`. The footer matches the select-footer signature, so `detectNumberedModal('›')` catches it; **Allow = option 1** ("Yes, proceed") and **Deny = Esc** (which is codex's own "No" option here), so the generic binary injection is exactly right for it. So gated codex needs no bespoke breaker — it rides this same generic path, and an attached human can equally answer the modal in the TUI.

The supervisor scrape is the ONLY interceptor for prompts the runtime hook cannot see (dangerous-rm above the permission layer; a non-hookable modal such as codex MCP-elicitation). A blocking prompt that is NOT a numbered select (a free-form text-input prompt) is out of v1 scope — the numbered-select family is the approval/confirm class in practice.

## Nomenclature v1 and content per action (criterion «what is being approved»)

In every channel a human sees the **concrete content** of the action, not just the tool name.

**claude** — `Bash` → full command (+ description); `Edit` → file + old/new; `Write` → file + content; `ExitPlanMode` → the plan text; `dangerous-rm` circuit-breaker → the full prompt + the rm command + target (pane-scraped, not structured).

**codex** — `Bash`/`exec` → the command; `apply_patch` → the patch/diff; escalations (shell/net/MCP) via `PermissionRequest` → tool + input + human-readable description.

An unknown tool falls back to a pretty-printed `tool_input`, so nothing is opaque.

**Limitations (not hidden):**

1. **claude `AskUserQuestion` is not hookable** — no permission-check, not a `PreToolUse` event. It stays suppressed by `--disallowedTools AskUserQuestion` in v1 (a deliberate owner decision, not a gap to close; re-enabling is only on the owner's explicit request).
2. **codex MCP-elicitation** delivers content only on screen, not via a structured hook — rare, not covered in v1.
3. **codex has no plan-mode approval** — the «plan» class exists only on claude (an asymmetry, not a missing feature).

## The broker (single source of truth)

The approval queue lives **in the daemon** (the always-on process). Every channel that asks (the runtime hook, the supervisor breaker) and every channel that answers (CLI, tray, the Telegram runtime, the web console) is an interface to this one queue: a decision from any face resolves the request everywhere. In-memory + ephemeral — pending requests do **not** survive a daemon restart (the blocking hook connection breaks → the hook fails safe to deny); the durable `approvals.log` is the audit trace, not a recovery store.

Flow: the gated peer's hook (or the supervisor breaker) blocks on `POST /fleet/v1/approvals` → the broker enqueues, emits `approval-request` (to `approvals.log` → SSE), and holds the connection → a face answers via `POST /fleet/v1/approvals/<id>/(approve|deny)` → the promise resolves, the daemon writes the runtime hook JSON back, the tool proceeds or is blocked with the reason.

**Fail-safety — every failure direction is `deny`:** broker unreachable, daemon restarted mid-wait (connection breaks), requester disconnect, unknown id, and the per-request timeout all resolve to deny. This is the engineering basis for removing the bypass under gated: with no bypass, «no decision» degrades to the runtime's own permission prompt (a blocked TUI), **not** an auto-run — so a supervision fault is safe, never permissive. (Under a *retained* bypass a hook timeout would auto-run — exactly the harm gated exists to prevent.)

**Timeouts (ordered so the broker's default-deny always wins):** the broker default-deny is **300 s** (`IAPEER_APPROVAL_TIMEOUT_MS`); the hook client's fetch ceiling is **600 s**; the installed runtime hook `timeout` is **900 s**. So the broker answers (or default-denies) first, the client aborts second, and the runtime only kills the hook last. A timeout is delivered to the model as `deny` with `reason="approval timed out (default-deny)"`.

## Fleet API

The approval surface is served on both daemon listeners under `/fleet/v1`, same auth and client obligations as the rest of the Fleet API (docs/15). It adds a fourth durable log, `approvals.log`, to the SSE tail — clients MUST ignore unknown `ev` kinds (obligation 1), which is exactly how `approval-request` / `approval-resolved` were reserved.

**Events** (compact logfmt line → SSE JSON; the full content is *not* in the event — read the queue for it):

- `approval-request` — `id, personality, runtime, kind, tool, summary, created, expires, approvers`.
- `approval-resolved` — `id, personality, runtime, decision (allow|deny), reason, by (approver), via (cli|tray|telegram|web|timeout|disconnect), latencyMs`. `via` is the surface the decision came from, **self-declared by the answering face** in its `POST` body (free-form-tolerant, like `kind`; `timeout`/`disconnect` are broker-internal). A face that did not self-identify gets the field **omitted** — the audit line never guesses a surface.

**Endpoints:**

| Method + path | Purpose |
|---|---|
| `GET /fleet/v1/approvals` | list pending requests (full items) |
| `GET /fleet/v1/approvals/<id>` | one pending request, full `content` (the multi-line diff / plan / command) |
| `POST /fleet/v1/approvals/<id>/approve` | `{approver?, via?}` → allow |
| `POST /fleet/v1/approvals/<id>/deny` | `{reason?, approver?, via?}` → deny (reason to the model) |
| `POST /fleet/v1/approvals` | the **blocking long-poll** the asking hook/breaker holds: `{personality, runtime, kind, tool, content, summary?}` → `{id, decision, reason?}` |

`kind` is the taxonomy tag (`tool` | `plan` | `question` | `circuit-breaker`; free-form-tolerant). So the SSE/badge stays light while the full content is available in every channel through the two `GET`s.

`via` on approve/deny is the answering face's **self-identification of its surface** for the audit trail: the CLI sends `cli`, the tray `tray`, the Telegram runtime `telegram`, the web console `web`. A face MUST send it (the log omits `via` otherwise); the broker passes it through verbatim into `approvals.log`.

## CLI

- `iapeer approvals [--json]` — the pending queue: personality · runtime · kind · **the verbatim command/content** · age · id.
- `iapeer approve <id> [--approver <peer>]` — allow.
- `iapeer deny <id> [reason] [--approver <peer>]` — deny with a reason (delivered to the model).
- `iapeer approval-mode <peer> [gated|yolo] [--now]` — read the current mode (omit the mode), or flip it: persists the field, idempotently brings the runtime surfaces to the mode, and reports the application moment. `--now` also starts a fresh session so the mode takes effect immediately.

`approve` / `deny` / `approvals` reach the in-daemon broker over the Fleet API (like the tray), not in-process — the queue lives in the live daemon.

## Compatibility

Additive within `/fleet/v1` (docs/15): the `approval-*` endpoints and `ev` kinds grow the surface without a version bump. A pre-approval daemon simply omits `approval_mode` from the snapshot and serves no `/approvals` endpoints; a client feature-detects by the presence of the field / a `200` from `GET /fleet/v1/approvals`.

## What an EMPTY broker does and does not mean

Diagnosed live on 15.07.2026 after an owner-visible false alarm; recorded here because the
misreading is natural and cost three people an incident.

**An empty `/fleet/v1/approvals` is the NORMAL state of a yolo fleet, not a symptom.** In
`yolo` the supervisor auto-presses Yes for the known classes (`dangerous-rm`,
`command-approval`) and the broker is deliberately uninvolved — there is no human decision to
route, so `approvals.log` correctly stays silent. Only `gated` peers ever reach the broker.

**A circuit breaker fires even under `--dangerously-skip-permissions`** — that is what makes it
a breaker. Seeing a modal on a bypassed peer is not evidence that the bypass failed. The live
sample: `Dangerous rm operation on working directory or its ancestor: /tmp/codex-probe` on a
peer launched with the bypass flag; the supervisor auto-confirmed 11 s later (nag-poll
cadence) and the tool completed 180 ms after that. Nothing hung, nothing leaked.

A useful narrowing when diagnosing one of these: under `bypassPermissions` the permission
engine auto-allows **every** `ask` decision except reasons beginning `Dangerous rm operation` /
`Dangerous rmdir operation` (established from the 2.1.201 engine). So a live modal on a
bypassed peer is almost certainly that one class — the "the bypass broke" hypothesis can be
dropped before investigating it.

**The yolo auto-confirm IS audited, but only off-surface — and that is DECIDED, not pending.**
The supervisor writes `[supervisor] AUTO-CONFIRM <taxonomy> identity=<id> ts=<…> <detail>` to
its own stderr log (`~/.iapeer/state/supervisor/<identity>.log`). That line is **not** in
`approvals.log`, **not** in the Fleet API, **not** in the SSE stream, and therefore invisible to
tray / telegram / web. Measured frequency: 9 auto-confirms across 10 days over the whole real
fleet (8 `dangerous-rm`, 1 `command-approval`).

> **Decision (owner, 15.07.2026): auto-confirms are NOT surfaced as notices.** Proposed after a
> destructive auto-approval proved invisible to every operator surface; considered, rejected.
> Rationale: `yolo` **means** silent auto-confirmation — the owner chose it explicitly to stop
> being asked, so a card per auto-confirm would be precisely the noise he opted out of. Even the
> narrow variant (destructive class only, post-hoc, one-way) was declined. The audit stays in the
> supervisor log.
>
> **The honest boundary of that decision, accepted knowingly:** observability of auto-confirms
> lives ONLY in `~/.iapeer/state/supervisor/<identity>.log`. You must know that file exists and
> that there is a reason to grep it. This is not a defect — it is the price of `yolo`, chosen
> deliberately. Re-proposing "let's just show them" re-opens a settled question: the counter-
> argument is above, and the frequency number is the reason it does not accumulate.

**The runtime's OWN notifications are outside this contour.** Claude Code pushes a native
"Claude needs your permission: Bash …" notification to the owner's phone when a modal appears —
including modals this contour auto-resolves seconds later. It is not ours (no `Notification`
hook exists in any settings here), we do not control it, and it is indistinguishable from a
real approval request. An owner-visible push therefore does NOT imply the broker saw anything.
Whether `preferredNotifChannel` (a real Claude Code setting) can silence this class is
**unverified**.

## Known unverified area: modals from a child runtime process

A peer's turn can spawn its own `claude` / `codex` child process (e.g. `claude -p …` inside a
Bash call). Such a child does **not** carry the peer's launch flags and its modal does **not**
render in the peer's pane — so the supervisor's nag-watch, the breaker path and the broker are
all structurally blind to it.

This is **not known to be a problem and not known to be safe: it has never been tested.** It is
recorded here so nobody later concludes the contour covers it. The scenario is real — it
occurred on this host on 15.07 during live acceptance (`claude --model fable -p ping` fired
from a peer's turn). Worth probing when there is a reason; not measured to date.
