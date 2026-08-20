# 18 — Origin guard

[Русский](ru/18-origin-guard.md) · **English**

When a human writes to an agent from one channel (say, the web console) and the agent replies into another (say, Telegram), the reply lands where the human is not looking. Until now this error class was held back only by agent doctrine («reply where the message came from») — memory, not mechanics. The **origin guard** enforces it at the router: an agent's *reply* to a human must target the channel the human last wrote from, or it is **held** for an explicit one-command confirmation instead of being delivered.

This is a **normative contract** for the guard's behavior, state, and CLI surface.

## What counts as a reply

The guard keeps one entry per **(human, agent)** pair — humans are peers with `intelligence: natural`:

- an ok **human → agent** delivery stamps the pair: the human's channel (`rt` = the sender's runtime) and the instant (`inboundTs`);
- an ok **agent → human** delivery stamps `answeredTs`.

The pair is **armed** when the latest inbound is *unanswered* (`inboundTs > answeredTs`) and younger than the arm TTL (48 h by default). An agent's send to the human **while armed is presumed a reply** and must target the origin channel. Once answered — or once the TTL cuts a stale thread — any further send is *initiative* and passes with no friction.

Why not a plain time window: a long task is exactly the high-value catch (asked from web, the agent finishes two hours later — the reply must still land in web), while a long window would false-hold initiative after an already-answered question. Unansweredness is the semantically precise discriminator; the TTL only bounds staleness (a thread closed outside the router — in an attached terminal, by voice — is invisible to the guard and must not arm it forever).

## The hold

On an armed mismatch — the **intended** channel (`runtime` argument, or the human's default runtime when omitted) differs from the armed origin — the send is **not delivered**. It is persisted verbatim as a *pending held send* and the sender gets an instructive error:

```text
origin-guard: "arthur" last wrote to you from "web" (2026-07-15T12:58:03+03:00) and that
message is not yet answered — this send targets "telegram". Message NOT delivered; held
verbatim as og-1a2b3c4d (expires in 15 min).
- cross-channel is intentional → deliver as addressed: iapeer confirm-send og-1a2b3c4d
- reply to the origin channel instead: iapeer confirm-send og-1a2b3c4d --runtime web
Do not re-send the message text — confirm-send delivers the held message.
```

Both exits cost one shell command and **zero message regeneration**: the held send carries the original message/topic/runtime and recipient-owned copies of every attachment. Copying happens before the hold is persisted, so deleting a caller's temporary sources during the 15-minute decision window cannot break `confirm-send`.

```bash
iapeer confirm-send og-1a2b3c4d                 # deliver as addressed (intentional cross-channel)
iapeer confirm-send og-1a2b3c4d --runtime web   # deliver the same message to the origin channel
```

`confirm-send` re-sends under the **original sender identity**. A peer session (carrying `PEER_IDENTITY`) may confirm only its own held sends; a bare operator shell may confirm any (same-uid trust domain). The claim is atomic — of two concurrent confirms exactly one wins. A failed delivery puts the hold back (retry until TTL); an expired hold answers «re-send the message instead».

## Where it runs

The guard and both stamps live in `routeSend` — the one routing point **both** entry paths share: the daemon's `send_to_peer` tool *and* the in-process CLI `iapeer send` (which is how the channel bridges deliver human inbound). A daemon-only guard would never see the inbound half and never arm. The bypass used by `confirm-send` is a routing dependency wired by the entry points — it is **not reachable from agent-supplied tool arguments**, so an agent cannot forge it.

State is on disk (it must survive daemon restarts and short-lived CLI processes), under the state root:

```text
~/.iapeer/state/iapeer/origin/
  state.json          # (agent → human → {rt, inboundTs, answeredTs}) — last-wins, atomic writes
  pending/<id>.json   # held sends; attachment fields already name recipient-inbox copies
```

## Scope and non-interference

The guard touches exactly one traffic class: **agent → human** sends while armed. Everything else is untouched by construction: agent→agent, human→agent, service (`absent`) senders and targets, same-channel replies (armed origin = intended channel), initiative (disarmed), and every flow with the guard disabled. Input typed directly into an attached terminal never passes the router, so it neither arms nor disarms the pair — the arm TTL bounds the resulting staleness. Hard delivery policies (e.g. the telegram sender-face policy) still apply at delivery time, including on the confirm path.

Delivery outcomes stay observable in `delivery.log`: a hold is an `ok=false` line whose `err` carries the origin-guard note (grep `origin-guard`); a confirmed delivery carries `og=<id>`, correlating it with its earlier refusal.

## Knobs

| Env | Default | Meaning |
|---|---|---|
| `IAPEER_ORIGIN_GUARD` | on | `0` disables the guard and the stamps host-wide |
| `IAPEER_ORIGIN_GUARD_ARM_TTL_MS` | 48 h | how long an unanswered inbound keeps the pair armed |
| `IAPEER_ORIGIN_GUARD_PENDING_TTL_MS` | 15 min | how long a held send stays confirmable |
