---
title: Design a Chat System (WhatsApp / Messenger)
summary: Persistent connections at scale, the message routing problem, delivery guarantees and ordering, plus group chat fanout and end-to-end encryption.
difficulty: Hard
scope: HLD
tags: [case-study, websocket, realtime, messaging]
prereqs: [realtime, message-queues, sharding]
---

:::interview Why this question
It tests something most designs don't: **stateful connection management**. Every other case study has interchangeable stateless servers. Here, a user's socket lives on one specific machine, and getting a message to it is the central problem. Interviewers push on delivery guarantees and ordering, which are genuinely subtle.
:::

## 1. Requirements

**Functional**
- 1:1 messaging, delivered in near real time.
- Group chats (say up to 500 members).
- Delivery status: sent → delivered → read.
- Message history, persisted and paginated.
- Offline delivery — messages queue and arrive on reconnect.
- Online/last-seen presence.

**Non-functional**
- Low latency: end-to-end under ~200 ms for online users.
- **No message loss.** This is the hard requirement — users will forgive latency, never a vanished message.
- Ordered within a conversation.
- Massive concurrent connections.

**Cut:** voice/video calls, media transcoding (mention media goes to [object storage](../02-building-blocks/object-storage.html) via presigned URLs), search, bots.

**Clarifying questions:** Group size limit? Is end-to-end encryption required (it changes what the server can do)? Do we retain history forever or on-device only? Multi-device per user?

## 2. Estimation

**500M DAU**, 40 messages sent per user per day, 100 B average message.

```diagram
   Messages: 500M × 40 / 10⁵ = 200,000 msgs/s avg → 600,000 peak

   Storage: 500M × 40 × 100 B = 2 TB/day
            with metadata & indexes (×2)  ≈ 4 TB/day
            5 years ≈ 7 PB               ← must shard, and must
                                            consider retention policy

   CONNECTIONS (the number that shapes the design):
     assume 100M concurrent
     50 KB state per connection → 5 TB of connection memory
     at 1M connections/node → 100 nodes minimum,
     realistically 200+ for headroom and failure tolerance
```

**What this decided:** a dedicated **connection/gateway tier**, separate from business logic, sized by memory rather than CPU. 7 PB forces a retention decision — worth raising, because "keep everything forever" is a product choice with a large cost.

## 3. High-level design

```diagram
   ┌────────┐  WebSocket  ┌──────────────┐
   │ client │◄───────────►│   GATEWAY    │  stateful: holds sockets
   └────────┘             │   (100+      │  no business logic
                          │    nodes)    │
                          └──────┬───────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
      ┌──────────────┐  ┌────────────────┐  ┌──────────────┐
      │ Session      │  │ Chat service   │  │  Presence    │
      │ registry     │  │ (persist,      │  │  service     │
      │ user→gateway │  │  route, ack)   │  │              │
      │ (Redis)      │  └───────┬────────┘  └──────────────┘
      └──────────────┘          │
                          ┌─────▼──────┐   ┌──────────────┐
                          │ Cassandra  │   │ Push (APNs/  │
                          │ (messages) │   │ FCM) offline │
                          └────────────┘   └──────────────┘
```

**The critical split:** gateways are stateful (they own connections) and dumb. Business logic lives in stateless services that can be deployed and scaled freely. Without this split, every deploy of business logic would drop every connection.

## 4. Message flow — narrate this end to end

```diagram
   Alice → Bob, both online

   1. Alice's client sends over its WebSocket to gateway G1
   2. G1 forwards to the Chat service
   3. Chat service:
        a. assigns a message_id (Snowflake — time-ordered)
        b. PERSISTS to Cassandra           ← durability FIRST
        c. acks Alice: "sent" ✓
   4. Look up Bob in the session registry → gateway G7
   5. Forward the message to G7 (internal RPC or pub/sub)
   6. G7 writes to Bob's socket
   7. Bob's client ACKs → "delivered" ✓✓
   8. Bob opens the chat → "read" ✓✓(blue)
```

:::goat Persist before delivering
Step 3b before 3c is the whole ballgame. If you deliver first and persist second, a crash between them loses a message that the sender saw acknowledged. Persisting first means the worst case is a message that exists but hasn't been delivered yet — recoverable on reconnect.

"I persist before acknowledging, because a socket write is not a delivery guarantee — the client may be gone mid-write. The socket is a fast path; the database is the source of truth, and the client re-syncs from it on reconnect using its last-seen message ID."
:::

## 5. Deep dive — the routing problem

Here's the problem in one line. Every connected user is holding an open connection to *one specific gateway server*, chosen more or less at random when they connected. Bob happens to be on G7. Alice's message lands on G1. G1 has no connection to Bob at all — so how does the message get across?

**Option A — a directory of who is where.** Keep a map in Redis from user to the gateway holding their connection, kept fresh by each gateway repeatedly re-asserting its entries (so a crashed gateway's entries expire on their own). G1 looks Bob up and forwards the message to G7 directly.

*Efficient:* one lookup, one hop. *Requires:* a fast, highly available registry, and stale entries must be handled (forward to a gateway that no longer owns the socket → it responds "not mine," fall back to offline delivery).

**Option B — pub/sub.** Each gateway subscribes to channels for its connected users. Publishing to `user:bob` reaches whichever gateway holds him.

*No registry to maintain*, handles multi-device naturally (multiple gateways subscribe to the same channel). *Costs:* subscription churn on every connect/disconnect, and fanout overhead.

**Recommend the registry for 1:1** (efficient, direct) **and pub/sub for group chats** (natural fanout to a room). Most large systems do exactly this split.

**Multi-device** complicates it: one user, several sockets, possibly on different gateways. The registry value becomes a *set* of `(device_id, gateway_id)`, and delivery fans out to all of them with per-device delivery state.

## 6. Deep dive — delivery guarantees

**The transport gives you nothing.** Design for at-least-once plus deduplication.

```diagram
   Client-generated message_id (UUID) sent with every attempt.
   Server dedupes on (sender_id, client_msg_id).
   → Alice's retry after a timeout doesn't create a second message.
```

**Reconnection sync** is the mechanism that makes "no message loss" true:

```diagram
   On reconnect, the client sends its highest received message_id
   per conversation. The server returns everything after it.

   → any message missed while disconnected is replayed
   → the socket is never the durability mechanism
```

This is why message IDs must be **monotonically ordered per conversation** — you need "everything after X" to be a well-defined query. [Snowflake IDs](../02-building-blocks/unique-id-generation.html) give you this, and they're time-sortable for free.

**Offline users:** the lookup finds no gateway → the message just stays in the database, and a push notification goes out through Apple's or Google's push service. This part is not optional: on a phone, the operating system closes your connection as soon as the app goes to the background, and only the platform's own push service is allowed to wake it. Those services are part of the design, not an extra.

## 7. Deep dive — storage and sharding

```diagram
   messages  (Cassandra)
     PARTITION KEY:  conversation_id
     CLUSTERING:     message_id DESC
     → "last 50 messages in a conversation" is a single-partition
       range scan — the fastest possible access pattern
```

**Shard on `conversation_id`, not `user_id`.** This is the key decision and a classic trap:

- Sharding by `user_id` means a message between Alice and Bob must be written to *both* their shards (duplication + consistency work), or reading a conversation requires querying two shards and merging.
- Sharding by `conversation_id` keeps the entire conversation on one shard. Loading history is one query.

The cost, which you should name: "all messages for a user across all conversations" becomes scatter-gather. That's a rare query (mainly search), and you'd serve it from a separate index sharded by user, kept in sync via [CDC](../04-data/cdc-outbox.html).

**Hot partition risk:** a very large or very active group chat concentrates on one partition. Mitigate by sub-partitioning on a time bucket: `(conversation_id, month)`.

## 8. Deep dive — group chat

A 500-member group message means 500 deliveries from one send.

```diagram
   Naive: write 500 copies (one per recipient inbox)
     → 500× write amplification, 500× storage

   Better: write the message ONCE to the conversation partition.
     Each member's client tracks its own read position.
     Delivery = push a notification to online members;
                everyone else pulls on reconnect.
```

Storage becomes O(1) per message instead of O(members), and per-user state is just a cursor. This is the same insight as feed fanout — **materialize once, track position per reader** — and it's why group size limits exist at all (delivery fanout, not storage, is the constraint).

For very large groups, drop per-member delivery receipts: computing "delivered to all 500" is expensive and nobody looks at it. Products limit or remove receipts in large groups for exactly this reason — a good example of a *product* decision made for systems reasons.

## 9. Operational concerns

**Deploys drop connections.** Restarting a gateway disconnects everyone on it. Drain gradually: stop accepting new connections, then close existing ones **in batches with jitter**. A naive rolling restart of 100 gateways creates a reconnection thundering herd that can knock over the ones still running.

**Reconnect storms.** Jittered exponential backoff on the client is mandatory. Without it, a gateway restart triggers a synchronized reconnect surge that cascades.

**Heartbeats.** TCP connections can be half-open for a long time. Ping/pong every 30 s; drop after two misses. Otherwise your registry lies about where users are, and your connection count drifts up with ghosts.

**Backpressure.** A slow client's send buffer grows. Bound it; on overflow, disconnect and let the client re-sync from history rather than consuming unbounded memory.

## 10. End-to-end encryption

If required, it constrains the design significantly — and saying *how* is a strong signal:

- The server stores and routes **ciphertext only**. It cannot search messages, generate previews, or do server-side spam filtering.
- Key exchange (Diffie-Hellman style with prekeys) allows asynchronous session setup while the recipient is offline.
- **Group encryption** typically uses a sender key distributed to members, so a message is encrypted once rather than per-recipient.
- **Multi-device** requires per-device sessions — each device is a separate cryptographic identity.
- Backups become a genuine problem: encrypted backups need a key the user holds, and losing it means losing history. This is a real product tradeoff, not just an implementation detail.

## 11. Follow-ups

- *"How do you order messages in a group?"* — server-assigned Snowflake IDs give a total order per conversation. Client timestamps can't be trusted ([clock skew](../03-distributed/clocks.html)), and users notice mis-ordered replies.
- *"Presence at scale?"* — heartbeat with Redis TTL so offline expires automatically; push only *changes*, never steady state; debounce flapping. See [Real-Time Delivery](../02-building-blocks/realtime.html).
- *"Typing indicators?"* — pure ephemeral pub/sub, never persisted, dropped freely under load. A good example of data whose correct durability is *zero*.
- *"Message search?"* — a separate index sharded by user, populated via CDC. Impossible with E2E encryption unless done on-device.
