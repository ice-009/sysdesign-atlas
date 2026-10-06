---
title: Build WhatsApp
summary: Stateful connections at scale, the message routing problem, and delivery guarantees where losing a message is unacceptable.
difficulty: Hard
scope: HLD
level: 3
prereqs: [realtime, chat-system, sharding, idempotency, consistent-hashing]
tags: [level-3, realtime, messaging, stateful]
unlocks: Managing millions of persistent connections and guaranteeing delivery.
---

:::predict Guess first
1. 100 million phones hold open connections. What resource will limit how many servers you need — CPU, memory, or network?
2. Deploying new business logic restarts every server holding a socket. How could you avoid dropping 100 million connections?
3. You restart 200 gateway servers one after another. What might the reconnecting clients do to the servers still running?
:::

## The product

Send a message to a person or group. It arrives in under a second if they're online, and waits for them if they aren't. You see sent / delivered / read. History persists across devices.

**What makes this structurally different from every previous build:** servers are no longer interchangeable. A user's socket lives on one specific machine, and getting a message to it is the central problem.

## Estimation

```diagram
   500M DAU · 40 messages sent/user/day

   Messages: 500M × 40 / 10⁵ = 200,000 msg/s → 600,000 peak
   Storage:  20B msg/day × 200 B (with metadata) = 4 TB/day → 7 PB over 5y

   CONNECTIONS — the number that shapes the design
     100M concurrent × ~50 KB state = 5 TB of connection memory
     at ~1M connections/node → 100 nodes minimum, 200+ realistically
```

**Sized by memory, not CPU.** Each connection holds socket buffers plus application state whether or not it's active. And 7 PB forces a retention decision — "keep everything forever" is a product choice with a large bill attached.

## Phase 1 — Split the tiers

The one structural decision that everything else depends on:

```diagram
   ┌──────────────┐   stateful: holds sockets, NO business logic
   │  GATEWAY     │   deploys rarely, drains gracefully
   │  (200 nodes) │
   └──────┬───────┘
          │
   ┌──────▼───────┐   stateless: all logic, deploys freely
   │ Chat service │
   └──────┬───────┘
          │
   ┌──────▼───────┐
   │  Cassandra   │   PARTITION conversation_id
   └──────────────┘   CLUSTER   message_id DESC
```

Without this split, every business-logic deploy drops every connection in the fleet. With it, gateways are boring long-lived processes and logic ships continuously.

**Shard on `conversation_id`, not `user_id`.** This is the classic trap: sharding by user means a message between Alice and Bob is either written twice or read from two shards and merged. Sharding by conversation keeps the entire history on one partition, so loading a chat is a single-partition range scan.

The cost, which you should name: "all messages for a user across conversations" becomes scatter-gather. That's rare (mostly search), and you'd serve it from a separate index kept in sync via [CDC](../data/cdc-outbox.html).

## Phase 2 — Routing to a socket

Alice's message arrives at gateway G1. Bob's socket is on G17.

```diagram
   SESSION REGISTRY (Redis)
     user:bob → [{device: phone, gateway: G17}, {device: web, gateway: G4}]
     TTL-based, refreshed by heartbeat

   1. G1 → chat service → persist message
   2. look up bob in registry → G17, G4
   3. forward via internal RPC to both
   4. gateways write to their sockets
```

**Registry for direct messages, pub/sub for groups.** Direct lookup is one hop and efficient; group delivery is naturally a broadcast to a channel every member's gateway subscribes to. Most large systems run both.

**Stale entries are normal.** A gateway that receives a message for a user it no longer holds replies "not mine," and you fall back to offline delivery. Design for the registry lying rather than assuming it's authoritative.

## Phase 3 — Never lose a message

```diagram
   1. persist to Cassandra          ← DURABILITY POINT
   2. ack sender: "sent" ✓
   3. attempt real-time delivery
   4. recipient client ACKs → "delivered" ✓✓
   5. recipient opens chat → "read" ✓✓ blue
```

**Step 1 must precede step 2.** A socket write is not a delivery guarantee — the client may vanish mid-write. Persist first, and the worst case becomes "a message exists but hasn't been delivered yet," which is recoverable. Deliver first and the worst case is a message the sender saw acknowledged that no longer exists anywhere.

**Reconnection sync is what makes "no message loss" true:**

```diagram
   On reconnect the client sends its highest-seen message_id
   per conversation. Server returns everything after it.
```

This requires message IDs to be **monotonically ordered per conversation** — [Snowflake IDs](../building-blocks/unique-id-generation.html) give you that plus time-sortability. It also means the socket is a *fast path*, never the system of record.

**Dedupe on a client-generated ID.** Alice's client retries after a timeout; the server dedupes on `(sender_id, client_msg_id)` so a retry doesn't create a second message. The transport gives you nothing — [at-least-once plus idempotency](../distributed/idempotency.html) is what you build.

## Phase 4 — Groups without write amplification

**Write amplification** is when one action from a user turns into many writes inside your system. Here it's stark: one person sends one message to a 500-member group, and the naive design performs 500 writes — a copy dropped into each recipient's inbox.

```diagram
   NAIVE   write 500 copies, one per recipient inbox
           → 500× storage and write amplification

   BETTER  write the message ONCE to the conversation partition
           each member tracks their own read cursor
           delivery = push a notification to online members;
                      everyone else pulls on reconnect
```

Storage becomes O(1) per message instead of O(members), and per-user state is just a cursor. Same insight as feed fanout: **materialize once, track position per reader.**

For very large groups, drop per-member delivery receipts — computing "delivered to all 500" is expensive and nobody reads it. Real products limit receipts in large groups for exactly this reason: a *product* decision made for systems reasons.

## Phase 5 — Operations

This is where connection-oriented systems actually break.

**Deploys drop connections.** Drain gradually: stop accepting new connections, then close existing ones in **batches with jitter**. A naive rolling restart of 200 gateways creates a reconnection surge that knocks over the nodes still running.

**Reconnect storms** need jittered exponential backoff on the client. Without it, one gateway restart triggers a synchronized stampede that cascades.

**Heartbeats** every 30s, drop after two misses. TCP holds half-open connections long after the peer is gone; without heartbeats your registry lies and your connection count drifts up with ghosts.

**Backpressure:** bound the per-connection send buffer. On overflow, disconnect and let the client re-sync from history rather than consuming unbounded memory.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| Split stateful gateway / stateless logic | One tier | Otherwise every logic deploy drops every connection |
| Shard on `conversation_id` | `user_id` | Keeps a conversation on one partition; avoids dual-write |
| Persist before acking | Deliver then persist | A socket write isn't a delivery guarantee |
| Client-side reconnect sync | Server-tracked delivery | Client knows what it actually received |
| Write group messages once + cursors | Per-recipient copies | O(1) vs O(members) storage |
| Registry for DMs, pub/sub for groups | One mechanism | Direct is efficient; broadcast is natural for rooms |
| Jittered batched drain on deploy | Rolling restart | Reconnect stampede takes out surviving nodes |

## If end-to-end encryption is required

End-to-end encryption means only the sender's and recipient's own devices hold the keys — your servers carry the messages but cannot read them. That constrains the design significantly, and saying *how* is a strong signal: the server stores and routes scrambled bytes only, so there is no server-side search, no link previews, and no spam filtering on content. Group messaging uses a sender key so a message is encrypted once rather than per recipient. Multi-device means per-device sessions. And backups become a genuine product problem — encrypted backups need a key the user holds, and losing it means losing history.

## Explaining the design

> "The defining constraint is that connections are stateful — a user's socket lives on one specific gateway. So I split the tiers: dumb stateful gateways holding sockets, stateless services holding logic, with a Redis session registry mapping user to gateway.
>
> Storage shards on `conversation_id`, not `user_id` — sharding by user would force a dual-write or a two-shard merge for every message.
>
> For delivery: persist before acking, because a socket write isn't a guarantee. The client tracks its highest-seen message ID and re-syncs on reconnect, which is what actually makes 'no message loss' true. Dedupe on a client-generated ID so retries don't duplicate.
>
> Groups write once to the conversation with a per-member read cursor, rather than N copies.
>
> Operationally, the thing that bites is deploys — draining 200 gateways needs batching and jitter or the reconnect surge takes out whatever's still up."

## Next

[Build Netflix](netflix.html) — where the read path is measured in terabits and the CDN *is* the architecture.

## Check yourself

```recall
Q: What makes WhatsApp structurally different from earlier builds?
A: Servers aren't interchangeable: each user's socket lives on one machine, and routing to it is the central problem.

Q: What sizes the gateway fleet?
A: Memory: ~100 million connections × ~50 KB ≈ 5 TB of connection state — at ~1 million connections a node, 100 nodes minimum and 200+ in practice.

Q: Why split gateways from chat services?
A: Stateful gateways hold sockets with no business logic and deploy rarely; stateless services hold logic and deploy freely — otherwise every deploy drops every connection.

Q: How do messages reach the right socket?
A: A Redis session registry maps user to device and gateway, refreshed by heartbeat; groups use pub/sub. Stale entries are normal — a gateway replies "not mine" and you fall back to offline delivery.

Q: What three mechanisms make "never lose a message" true?
A: Persist before acknowledging the sender, reconnect sync from the client's highest-seen message ID per conversation, and dedup on a client-generated message ID.

Q: How do groups avoid write amplification?
A: Write the message once to the conversation partition; each member tracks a read cursor. Online members get a push, others pull on reconnect; large groups drop per-member receipts.

Q: Name three operational must-haves for connection fleets.
A: Drain gateways in jittered batches on deploy, jittered exponential backoff on client reconnects, heartbeats to clear half-open connections, and bounded per-connection send buffers.
```

## What to carry forward

- Stateful connections: split dumb gateways from stateless logic.
- Shard messages by conversation, not user.
- Persist first, sync on reconnect, dedupe on client IDs.
- Write group messages once; each reader keeps a cursor.
- Deploys and reconnect storms are where connection systems break.
