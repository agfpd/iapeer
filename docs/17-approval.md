# 17 — Human approval

A peer can run in one of two **approval modes**. In `yolo` (the default — every peer today) the agent acts autonomously: the runtime is launched with its bypass flag and nothing asks a human before a tool runs. In `gated` the peer is launched **without** bypass, and every blocking approval the runtime would raise is routed to a **human** through the daemon's approval broker — a Telegram button, a tray click, or `iapeer approve` on the CLI. The human's `allow`/`deny` (with a reason) flows back into the runtime and the tool proceeds or is refused.

This is a **normative contract**. The approval broker is the daemon's, the fleet endpoints and `ev` kinds below are the surface that operator faces (CLI, tray, the Telegram runtime) are written against — not the daemon source. The interception facts (which runtime event fires, in which shape) are pinned to **Claude Code 2.1.201** and **codex-cli 0.142.5**, taken from the live binaries + current runtime docs.

`gated` means **«ask before acting»**, not «sandboxed». It removes the bypass so blocking questions surface; it does **not** add an OS sandbox (a separate axis, not in v1). On codex, gated is explicitly `approvals ON + sandbox OFF` (see the toggle table).

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

**codex** (`PreToolUse` hook — verified live, codex-cli 0.142.5):

| # | Surface | yolo | gated |
|---|---|---|---|
| X1 | argv `--dangerously-bypass-approvals-and-sandbox` | present | **removed** |
| X2 | argv approval/sandbox | (bypass) | `-c approval_policy=on-request -c sandbox_mode=danger-full-access` — approvals **ON**, sandbox **OFF** (so loopback-MCP `send_to_peer` + writes to the memory vault outside cwd still work; `workspace-write` would cut the network and external paths). Session-scoped via `-c`, not host config. |
| X3 | `PreToolUse` hook `<cwd>/.codex/hooks.json` + trust pre-seed in `~/.codex/config.toml [hooks.state]` | **absent** | **installed + trusted** (`preSeedCodexHooksTrust`; an untrusted codex hook is silently skipped) |
| X4 | codex cwd-trust `[projects."<cwd>"] trust_level="trusted"` | pre-trusted (both modes) | pre-trusted (matters more with approvals active) |
| X5 | ready-gate `isInputReady` (`›` composer) | mode-independent | unchanged |

The codex hook is matched by tool-name regex `^(Bash|Shell|shell|local_shell|exec|apply_patch|ApplyPatch)$` — the coarse class matcher lives on the runtime's own `hooks.json` (the user tunes it as ordinary runtime config).

### Idempotency and the application moment

- **argv surfaces** (C1–C2, C8, X1–X2) are computed from the mode on every launch — structurally idempotent, no accumulation.
- **settings.json / hooks.json** (C5–C6, X3) are add-on-gated / remove-on-yolo with a no-clobber merge, keyed on the stable `approval-hook` marker: our block is written deterministically and removed cleanly (an emptied `hooks.PermissionRequest` / `PreToolUse` array is dropped, an emptied `hooks` / `permissions` object is dropped, foreign hooks/rules untouched). A `gated→yolo→gated` round-trip restores the pre-install bytes.
- **codex trust** (X3–X4) reuses the already-idempotent `preSeedCodexHooksTrust` / `removeCodexHooksTrustUnder`.

All surfaces are read/applied **at session start**. A **live session keeps its launched mode** until the next fresh session — exactly like an agentic peer picking up new doctrine lazily on its next wake. The toggle (1) persists `approval_mode`, (2) idempotently brings the settings/hooks surfaces to the mode, (3) does **not** touch the live session. To apply immediately, start a fresh session (`iapeer approval-mode <peer> <mode> --now`, or `iapeer new`/`refresh`).

## Interception mechanism

Both runtimes carry a Claude-compatible **hook** system that intercepts an approval programmatically and returns `allow`/`deny` + a reason + the structured action content. That is the primary mechanism. **pty screen-scrape is a backstop for one class only** — claude's `dangerous-rm` circuit-breaker, which sits *above* the permission layer and no hook can see.

- **claude `PermissionRequest`** — stdin carries `{tool_name, tool_input, …}`; the hook prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow|deny","message":"…"}}}`. A `deny` carries `message` to the model. Fires only on prompt-worthy calls.
- **codex `PreToolUse`** — same stdin shape; prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny","permissionDecisionReason":"…"}}`. `exit 2` (+ stderr) also denies. Verified live (0.142.5): codex fires `PreToolUse` (not `PermissionRequest`) for tool calls with `tool_name:"Bash"` for shell; a `deny` hard-blocks the tool and the reason reaches the model even under `sandbox_mode=danger-full-access` — so under the gated config (danger-full-access + on-request → `permission_mode=bypassPermissions`) the hook is the SOLE gate.
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

The approval queue lives **in the daemon** (the always-on process). Every channel that asks (the runtime hook, the supervisor breaker) and every channel that answers (CLI, tray, the Telegram runtime) is an interface to this one queue: a decision from any face resolves the request everywhere. In-memory + ephemeral — pending requests do **not** survive a daemon restart (the blocking hook connection breaks → the hook fails safe to deny); the durable `approvals.log` is the audit trace, not a recovery store.

Flow: the gated peer's hook (or the supervisor breaker) blocks on `POST /fleet/v1/approvals` → the broker enqueues, emits `approval-request` (to `approvals.log` → SSE), and holds the connection → a face answers via `POST /fleet/v1/approvals/<id>/(approve|deny)` → the promise resolves, the daemon writes the runtime hook JSON back, the tool proceeds or is blocked with the reason.

**Fail-safety — every failure direction is `deny`:** broker unreachable, daemon restarted mid-wait (connection breaks), requester disconnect, unknown id, and the per-request timeout all resolve to deny. This is the engineering basis for removing the bypass under gated: with no bypass, «no decision» degrades to the runtime's own permission prompt (a blocked TUI), **not** an auto-run — so a supervision fault is safe, never permissive. (Under a *retained* bypass a hook timeout would auto-run — exactly the harm gated exists to prevent.)

**Timeouts (ordered so the broker's default-deny always wins):** the broker default-deny is **300 s** (`IAPEER_APPROVAL_TIMEOUT_MS`); the hook client's fetch ceiling is **600 s**; the installed runtime hook `timeout` is **900 s**. So the broker answers (or default-denies) first, the client aborts second, and the runtime only kills the hook last. A timeout is delivered to the model as `deny` with `reason="approval timed out (default-deny)"`.

## Fleet API

The approval surface is served on both daemon listeners under `/fleet/v1`, same auth and client obligations as the rest of the Fleet API (docs/15). It adds a fourth durable log, `approvals.log`, to the SSE tail — clients MUST ignore unknown `ev` kinds (obligation 1), which is exactly how `approval-request` / `approval-resolved` were reserved.

**Events** (compact logfmt line → SSE JSON; the full content is *not* in the event — read the queue for it):

- `approval-request` — `id, personality, runtime, kind, tool, summary, created, expires, approvers`.
- `approval-resolved` — `id, personality, runtime, decision (allow|deny), reason, by (approver), via (cli|tray|telegram|timeout|disconnect), latencyMs`.

**Endpoints:**

| Method + path | Purpose |
|---|---|
| `GET /fleet/v1/approvals` | list pending requests (full items) |
| `GET /fleet/v1/approvals/<id>` | one pending request, full `content` (the multi-line diff / plan / command) |
| `POST /fleet/v1/approvals/<id>/approve` | `{approver?}` → allow |
| `POST /fleet/v1/approvals/<id>/deny` | `{reason?, approver?}` → deny (reason to the model) |
| `POST /fleet/v1/approvals` | the **blocking long-poll** the asking hook/breaker holds: `{personality, runtime, kind, tool, content, summary?}` → `{id, decision, reason?}` |

`kind` is the taxonomy tag (`tool` | `plan` | `question` | `circuit-breaker`; free-form-tolerant). So the SSE/badge stays light while the full content is available in every channel through the two `GET`s.

## CLI

- `iapeer approvals [--json]` — the pending queue: personality · runtime · kind · **the verbatim command/content** · age · id.
- `iapeer approve <id> [--approver <peer>]` — allow.
- `iapeer deny <id> [reason] [--approver <peer>]` — deny with a reason (delivered to the model).
- `iapeer approval-mode <peer> [gated|yolo] [--now]` — read the current mode (omit the mode), or flip it: persists the field, idempotently brings the runtime surfaces to the mode, and reports the application moment. `--now` also starts a fresh session so the mode takes effect immediately.

`approve` / `deny` / `approvals` reach the in-daemon broker over the Fleet API (like the tray), not in-process — the queue lives in the live daemon.

## Compatibility

Additive within `/fleet/v1` (docs/15): the `approval-*` endpoints and `ev` kinds grow the surface without a version bump. A pre-approval daemon simply omits `approval_mode` from the snapshot and serves no `/approvals` endpoints; a client feature-detects by the presence of the field / a `200` from `GET /fleet/v1/approvals`.
