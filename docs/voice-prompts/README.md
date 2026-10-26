# Voice-layer prompts (codex realtime)

Per-peer replacements for codex's built-in realtime backend prompt, the instructions the voice model
gets in `/voice` (docs/22-voice.md). They are installed into the peer's project config as
`experimental_realtime_ws_backend_prompt` by `bun scripts/voice-prompt.ts <peer-cwd> <prompt.md>`;
`--remove` restores codex's own prompt. Codex marks the key "Experimental / do not use".

| file | peer | based on |
|---|---|---|
| `darwin.md` | darwin | `upstream-backend_prompt.rust-v0.164.0.md` (codex `prompts/templates/realtime/backend_prompt.md`, identical in rust-v0.163.0) |

Changes from upstream, kept minimal: (1) identity — Darwin, the orchestrator of Arthur's fleet, not
"Codex", speaking Russian; (2) `{{ user_first_name }}` filled in, because codex renders the template
only for its own prompt; (3) one steering rule: questions about pending work or peer replies are always
delegated. Reason for (3): the TUI never relays results of turns the voice layer did not start.

**On every codex update:** diff the new upstream `backend_prompt.md` against the pinned upstream copy
here. If it changed, re-apply the three edits on the new text, bump the pinned copy and regenerate.

Installing changes `<cwd>/.codex/config.toml`. The core sees that as a capability-surface change and
replaces an idle hosting by resume on its own (lifecycle.log `capability-reload`), so no manual
restart is needed.
