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

## Plugin obligations

- **Idempotent** by construction. The core may repeat `birth`/`sweep-on` for an
  already-provisioned endpoint, for example on add-runtime repair or `sync`.
- Surfaces are scoped by **personality and runtime**, not by cwd alone. For opencode
  they live in the peer's private directory `<root>/peers/<p>/opencode/`, and the core
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
