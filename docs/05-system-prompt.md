# 05 — Identity and the system prompt

[Русский](ru/05-системный-промпт.md) · **English**

So an agent knows its name, role, and teammates, iapeer assembles a system prompt for it — the text the runtime receives before the conversation starts. The prompt is built from layers: some written by a human, some assembled by the system.

## Why swap the system prompt

Claude and Codex have their own built-in system prompt — the one that makes them a "coding assistant". iapeer replaces it entirely: instead of the native prompt, the runtime gets a text assembled by iapeer where the agent is described as a team peer — with its name, role, knowledge of its neighbors, and shared rules.

The swap goes through each runtime's standard mechanism:

- **Claude** — the `--system-prompt-file <file>` flag;
- **Codex** — the `model_instructions_file` setting (`codex -c model_instructions_file=<file>`), which replaces the compiled base instructions.

Infrastructure runtimes (Telegram, notifier) get no system prompt — they aren't language models, there's nothing to fill for them.

## The prompt layers

The prompt is assembled from layers, general to specific. Each layer, when empty, simply drops out — no stray sections appear.

```text
1. Identity block (YAML)             ← system, always fresh
2. IAPEER.md doctrine                 ← human: shared + personal
3. Peer registry                      ← system: who else is on the team
4. Domain files (any .md by name)     ← human / plugin
5. Doctrine fragments                 ← primitive plugins, machine-generated
```

### Layer 1 — the identity block

A dynamic YAML block at the top of the prompt. The system synthesizes it on each launch from the peer profile and host facts: name, description, working folder, platform, OS version, user, machine name, today's date. Values are escaped, so colons, quotes, and newlines in the description don't break the markup.

This layer is always fresh — the date and host facts are substituted anew on each launch.

### Layer 2 — the IAPEER.md doctrine

The main layer a human fills — a peer's equivalent of a project's `CLAUDE.md`: the agent's standing instructions and character. It's two files:

- **The shared doctrine** `~/.iapeer/IAPEER.md` — rules in force for all the host's peers: how to answer an approach, how to handle memory, the team's shared agreements.
- **The personal doctrine** `<peer-folder>/.iapeer/IAPEER.md` — the role and character of the specific peer: who it is, what it does, its areas of responsibility.

The order is general to specific: the shared doctrine first, then the personal. The specific comes after the general and refines it. Each file is inserted as its own marked section with a path label (an HTML comment with the file path, visible to the model), so the agent understands where each rule came from.

Both files are edited by the operator in ordinary markdown. This is where you define who the agent will be.

### Layer 3 — the peer registry

The system inserts a short summary of every team peer: name, primary runtime, runtime list, description, nature. So the agent knows whom it can reach via `send_to_peer` and who does what. The summary is sorted by name; if there are no peers, the layer drops out.

This is where the self-documenting `description` from the profile does its work: it's length-bounded precisely because it lands in every peer's prompt — bloated descriptions would cost the whole team context.

For a service peer — the notifier's `timer` and `watcher`, say — this description carries the call format itself: the JSON fields and an example. So an agent knows how to drive the service from its prompt alone, and when it needs more it can just ask the service (which replies to `help` with its full format). The registry teaches the call; the peer documents the rest.

### Layer 4 — domain files by name

Any markdown file in the root of `.iapeer/` — except `IAPEER.md` — rides into the prompt as its own section. This channel is open to you, not just plugins: drop a `SOUL.md` (or any name you like) in `~/.iapeer/` and every peer on the host sees it; drop it in a single peer's `.iapeer/` folder and only that peer does. Handing an agent extra context is as simple as adding a file.

Like the doctrine, each file has a shared form (`~/.iapeer/<DOMAIN>.md`) and a personal one (`<peer-folder>/.iapeer/<DOMAIN>.md`), inserted general to specific. Only the root of `.iapeer/` is scanned — not subfolders. Files come in a deterministic order (alphabetical by name), each as its own marked section, and empty files drop out. Plugins use this same channel to add their settings (a `<DOMAIN>.md` per plugin); your hand-written files and a plugin's sit side by side.

### Layer 5 — doctrine fragments

The last layer — fragments that primitive plugins generate by machine. They live in the `fragments/` subfolder of both roots (`~/.iapeer/fragments/` and `<peer-folder>/.iapeer/fragments/`). For example, the memory provider places the agent's current memory map here.

This layer is the most volatile, so it goes last and is **re-read on every fresh session bring-up**. When an agent's memory or other machine context changes, the updated fragment reaches the prompt on the next launch.

## Assembly and in-session immutability

The layers are joined into one file with a blank line between sections. That file is what's passed to the runtime via the prompt-swap flag.

The system prompt is fixed at the moment the session comes up and doesn't change while the session lives. When the daemon brings the agent up again — fresh or resuming the prior conversation — it reassembles the file, so the fresh layer-5 fragments and the current date are pulled in on each bring-up. This is verified: resuming the conversation re-applies the new prompt file rather than carrying the old one.

The swap delivers iapeer's system prompt — the peer's identity. It doesn't disable the runtime's own native instruction files: a `CLAUDE.md` (Claude) or `AGENTS.md` (Codex) still works exactly as it does outside iapeer — read as standing instructions the model follows. These are two independent channels — iapeer's identity through the swap, the runtime's `CLAUDE.md`/`AGENTS.md` natively — and they apply together. So if you bring an existing project that already has a `CLAUDE.md`, it keeps working alongside the iapeer prompt; those files also work on their own, with no iapeer at all.

## What you fill in

Of all the layers, two files are filled by hand:

- `~/.iapeer/IAPEER.md` — the team's shared rules (once per host);
- `<peer-folder>/.iapeer/IAPEER.md` — each peer's role.

The rest — the identity block, the registry, the fragments — the system and plugins assemble themselves. The directory layout where these files live is covered in [06 — Storage](06-storage.md).
