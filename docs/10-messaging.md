# 10 — Messaging

[Русский](ru/10-обмен-сообщениями.md) · **English**

Peers exchange messages over the IAP protocol. Agents do it with the `send_to_peer` tool, the operator with the `iapeer send` command. Both paths go through the same daemon routing.

## Two ways to send

**`send_to_peer`** — the MCP tool every claude/codex agent gets (through its connection to the daemon). This is the main channel between agents.

```text
send_to_peer(personality="assistant", message="...", topic?, attachments?)
```

**`iapeer send`** — sending from the command line, the same delivery path around the agent session (works even when the daemon's HTTP listener is unavailable):

```bash
iapeer send assistant --message "text"
iapeer send assistant --message-file ./report.md       # body from a file; '-' = stdin
iapeer send assistant --message "see attachment" --attachment ./report.pdf
iapeer send assistant --message "..." --topic "release" --from claude-reviewer
```

The `--from` flag sets the sender (`<runtime>-<name>`); by default it's the identity of the current folder's peer. `--attachment` is repeatable. `--message-file`, with the body from a file or stdin, is handy for long, multi-line messages.

## The delivery path

The daemon finds the recipient in the registry and looks at its state:

- **alive** — the daemon writes the message into the peer's session through the supervisor socket onto the session's input. The daemon waits for confirmation that the input was accepted (the input field cleared); the answer is `delivered`.
- **busy** (the agent is mid-turn, the input field isn't empty) — the message goes into the composer queue and is delivered as soon as the agent is free; the answer to the sender is `queued`. The queue waits up to 120 seconds, then force-delivers.
- **asleep** — the daemon brings the session up, re-checks the recipient, delivers; the answer is `delivered, woke`.
- **stopped** — the daemon refuses and tells the sender directly.

The key guarantee: `delivered` means the message actually landed in a live session (the daemon waited for confirmation), not that it was just sent into the void. If the session didn't confirm receipt in the allotted time, the daemon treats it as dead and doesn't lie about success.

In every message's envelope travels the sender's nature (`intelligence`) — the recipient knows whether a human, an agent, or a service process is writing to it.

## Message limits

The protocol has bounds: the message body — up to 16000 characters, the topic — up to 200, attachments — up to 20 at a time. A message over the limit must be split or its content passed as a file attachment.

## Sending into Telegram only with your own bot

A peer can't send messages into the Telegram domain if it has no bound Telegram bot. This is a guard: a reply to a human goes through a specific agent's bot, and a peer without such a binding doesn't write into Telegram — delivery to it is refused. The binding is made with `iapeer connect telegram` (see [09 — Runtimes](09-runtimes.md)).

## Control commands

Session control goes on a separate channel from messages — it's not text into the conversation but a control action:

```bash
iapeer interrupt assistant     # interrupt the current turn (Escape), context intact
iapeer compact assistant       # compact the conversation
```

`interrupt` stops a turn that's gone off-track or hung, without losing context. `compact` compacts the conversation; if the peer is asleep after a clean sleep, the daemon resumes it first, then compacts, and for an empty session it honestly answers that there's nothing to compact.

Separate are **aliases** — shortcuts like `/alias-new`, `/alias-compact`, defined in the peer profile. These aren't control but text templates: the runtime expands an alias into its full text and delivers it to the peer as an ordinary message. So with one short command the operator runs a pre-written scenario (e.g. "save state to memory and restart fresh").

## Ephemeral workers

A peer with the wake policy `wake_policy: "ephemeral"` in its profile works differently from an ordinary agent — it's meant for one-off tasks:

- **always fresh.** Each task brings up a fresh session, with no resume of the past conversation.
- **one at a time.** Tasks aren't delivered into a live session in parallel — they line up in a durable queue (it survives a daemon restart) and are processed strictly one by one. The daemon feeds the queue on supervisory ticks.
- **finish after the reply.** Having sent its single reply, the worker is marked for a quiet wind-down: a quiet window (20 seconds by default) — and the daemon closes the session, waking no one. If the worker stays silent and doesn't reply, a safety bound (600 seconds by default) winds it down anyway.
- **`iapeer self-done`** — a self-call by a worker that has nothing to send: it frees the queue for the next task without waking anyone. The doctrine is "nothing to send — `self-done` instead of an empty reply".

This model keeps a stream of one-off tasks orderly: one worker per task, with no accumulation of parallel sessions and no empty wakes of the recipient.
