# 21 — Capability-plugin lifecycle

A **capability plugin** adds per-peer surfaces to a peer's agent runtime: hooks, a
private config fragment, an MCP entry (examples: statusline-injector, totp-presence).
Like the memory slot, the **core owns when and for whom** these surfaces are provisioned
and the **plugin owns what** they are. The core shells into two declared commands and
knows nothing about surface forms.

## Declaration

`<IAPEER_ROOT>/capabilities/<name>.json` (default root `~/.iapeer`). The plugin never
writes this file directly. Its installer runs `iapeer capability register <file>`, which
validates the declaration and stores it.

```json
{
  "schema": 1,
  "capability": "statusline-injector",
  "package": "@agfpd/statusline-injector",
  "version": "1.2.3",
  "runtimes": ["claude", "codex", "opencode"],
  "provision":   { "command": "/abs/path/bin", "args": ["provision-peer",   "--personality", "{personality}", "--runtime", "{runtime}", "--cwd", "{cwd}", "--occasion", "{occasion}"] },
  "unprovision": { "command": "/abs/path/bin", "args": ["unprovision-peer", "--personality", "{personality}", "--runtime", "{runtime}", "--cwd", "{cwd}", "--occasion", "{occasion}"] }
}
```

Validation rules. A violation refuses `register`; an invalid file found on disk is
reported loudly and never skipped silently.
- `schema` is `1`. `capability` is a valid name and equals the file stem.
- `runtimes` is a non-empty list of the agent runtimes the plugin supports.
- `command` is an **absolute** path, because launchd's minimal PATH resolves nothing.
- `args` is an argv tail. `{personality}`, `{runtime}`, `{cwd}` and `{occasion}` are
  substituted per argument, and **no shell** is involved.
- `{privateDir}` is the core-owned private directory of the endpoint (OpenCode:
  `<root>/state/opencode/<p>/`). It is also exported as `IAPEER_PRIVATE_DIR` to the
  command for every runtime that has one. Plugins take the directory from the core
  and never compute the layout themselves. `{privateDir}` on a runtime without one
  is refused (`failed`) before spawn. A command that spans runtimes reads the env
  variable instead.
- Both commands must carry `{personality}`. Several personalities can share one cwd,
  and a command that cannot tell them apart would touch another peer's surfaces.

## Joints (core-owned)

An **endpoint** is one `(peer, runtime)` pair where the runtime is:
- declared by the peer;
- hostable as an agent by this core (`host.agent_runtimes`, docs/15);
- listed in the declaration's `runtimes`.

Channel runtimes (telegram, web, …) are never endpoints.

| Joint | Command | `{occasion}` |
|---|---|---|
| Peer birth: `create`, `init`, `add-runtime`, and `default-runtime` convergence onto an unwired runtime | provision for each endpoint | `birth` |
| `iapeer capability register` / `sync <name>` (sync is the repair) | provision for every endpoint of every registered peer | `sweep-on` |
| `iapeer remove <peer>` | unprovision for each endpoint, before state purge | `remove` |
| `iapeer capability unregister <name>` | unprovision for every endpoint, then the declaration is deleted | `off-all` |

Timeout per call: 120 s. Every call is logged to `lifecycle.log` as
`ev=capability-provision capability=<name> identity=<runtime>-<peer> occasion=… state=…`.
Failure handling:
- At birth and remove, a failure is a loud warning and the flow continues. A plugin
  hiccup never kills a birth or blocks a removal.
- For the sweep verbs, failures are listed per endpoint and the exit code is 1.

## Applying surfaces to a live endpoint

Successful `register`, `sync` and `unregister` converge a live agent session to the
registered MCP configuration automatically, for Claude, Codex and OpenCode alike.
Writing the plugin's files is not evidence that its running session loaded them.

- An idle endpoint reloads immediately, retaining its conversation history. A
  lifecycle replacement resumes the native dialogue; it is not a fresh `/new`.
- A busy endpoint finishes its current turn without interruption, then reloads
  automatically. The request is durable across daemon restarts. Repeated requests
  may coalesce, but a change arriving during reload must not be silently consumed.
- CLI output distinguishes surfaces written from runtime application: `applied`
  means reload completed; `pending` means automatic application is still owed.
  Exit 0 with `pending` promises that automatic continuation, not merely advice to
  run `/new`. A scheduling or reload failure is reported per endpoint, with exit 1.
- An asleep/stopped endpoint stays asleep/stopped; its next ordinary launch reads
  the current surfaces. Reload never changes the default runtime or a stop flag.
- H4 still wins: the core never replaces a launchd-owned endpoint. An application
  it cannot arrange through the owning lifecycle is explicit, not a false `applied`.

Unregister is not an emergency revocation mechanism: it allows an already-running
turn to finish. Use `interrupt` or `stop` to abort work. After reload, removed MCP
tools are neither advertised nor callable; added ones are discovered and usable
without a manual `/new`. Failures and pending work remain observable rather than
being hidden behind the plugin command's exit 0.

### Writers outside the core

The same invariant holds for every writer of a live endpoint's surfaces, not only the
capability verbs: the memory provider's own `provision-peer` and update sweep, `native-memory`,
an operator's hand edit. Such writers do not call the core, so the core records what each
launch read — a fingerprint of the endpoint's launch-read surface files — and the daemon
compares it every few seconds. A difference owes one reload, applied at the next turn boundary
exactly as above. Fingerprinted files (read at launch, never written by the runtime itself):

| Runtime | Files |
|---|---|
| claude | `<cwd>/.mcp.json`, `<cwd>/.claude/settings.json` |
| codex | `<cwd>/.codex/config.toml`, `<cwd>/.codex/hooks.json` |
| opencode | `<privateDir>/*.json`, `*.mjs` fragments (not `state.json`, `events.jsonl`, the core's `iapeer-plugin.mjs` and `peer-mcp.json`), plus `<cwd>/.mcp.json` and `<cwd>/.codex/config.toml` — the sources of the core's MCP projection |

Host-global configuration (`~/.codex/config.toml`, `~/.claude.json`) is written by the runtimes
themselves and is not fingerprinted; the core verbs that write it — `iapeer enable` (codex
installs plugins host-wide) — request the reload explicitly and print `runtime=applied|pending`.
A hosting launched before this mechanism has no baseline: its current state is adopted as the
baseline (what it actually read is unknown, and a guess never replaces a running process).

### remove-runtime on a live endpoint

`remove-runtime` follows the same turn-boundary rule instead of refusing a live endpoint: an idle
one is retired (input-fenced, proven idle) and removed in the call — `removed`; a busy one prints
`pending` (exit 0) and is removed by the daemon after its current turn — never killed mid-turn.
The owed removal is durable and visible in `iapeer capability list`. `--force` keeps its meaning:
kill the session now and remove.

This affects plugin install/update/uninstall sweeps: they can replace a live native
process and its MCP helpers at a turn boundary. Conversation history is retained;
process-local tool handles do not survive a lifecycle replacement. The acceptance
matrix exercises both idle and busy register/unregister on all three runtimes,
including actual new-tool calls and absence of the removed tool after reload.

## Plugin obligations

- **Idempotent** by construction. The core may repeat `birth`/`sweep-on` for an
  already-provisioned endpoint, for example on add-runtime repair or `sync`.
- Surfaces are scoped by **personality and runtime**, not by cwd alone. For opencode
  they live in the peer's private directory `<root>/state/opencode/<p>/`, and the core
  merges `<name>.json` fragments from there (docs/20).
- Exit 0 only when the surfaces are in place. stderr is the failure detail the operator
  sees.
- On `remove` / `off-all`, remove only this plugin's surfaces for that endpoint.
- Hold your own lock against concurrent invocations.

## Install / uninstall of the plugin package

- Install: install the package, then `iapeer capability register <decl.json>`. This
  provisions every existing peer.
- Update: re-register with the new version. Registration is idempotent and re-sweeps.
- Uninstall: `iapeer capability unregister <name>`, then remove the package.
