---
title: WebSockets & Real-Time Delivery
summary: Polling, long polling, SSE and WebSockets compared; how to scale millions of persistent connections and route a message to the right one.
difficulty: Medium
tags: [websocket, realtime, sse, push]
prereqs: [networking, load-balancing]
---

## The problem

HTTP is request/response: the client asks, the server answers. But chat, notifications, live scores, collaborative editing, and presence all need the **server** to initiate. Four techniques exist, and picking the simplest one that works is the scored decision.

## The four options

### Short polling

Client asks "anything new?" every N seconds.

```diagram
   client ──GET /messages?since=t──► server → "nothing"
   (wait 5s)
   client ──GET /messages?since=t──► server → "nothing"
   (wait 5s)
   client ──GET /messages?since=t──► server → [msg]
```

Trivial to build, works everywhere, stateless servers. Wildly wasteful: with 1M clients polling every 5 s you're serving **200K QPS of mostly empty responses**, and worst-case latency is your poll interval.

Acceptable for low-frequency, latency-tolerant updates — and worth proposing when the requirement is "refresh within 30 seconds," because the operational simplicity is real.

### Long polling

Client requests; the server **holds the connection open** until data arrives or a timeout (~30 s) fires, then the client immediately reconnects.

Near-real-time latency without a new protocol, and it works through every proxy and firewall. Costs: a held connection per client (so servers must handle many idle connections), and a reconnect storm risk if everyone's timeout fires together — jitter the timeouts.

Still a legitimate fallback, and the right answer when infrastructure constraints rule out WebSockets.

### Server-Sent Events (SSE)

One long-lived HTTP connection over which the server streams events. **Unidirectional** (server → client only).

```diagram
   GET /stream           Content-Type: text/event-stream

   data: {"type":"like","post":42}\n\n
   data: {"type":"comment","post":7}\n\n
   ...connection stays open...
```

Underrated. It's plain HTTP (so it works with existing proxies, auth, and compression), has **automatic reconnection with `Last-Event-ID` replay** built into the browser, and is far simpler than WebSockets. If the client only needs to *receive* — notifications, live feeds, progress updates, streaming LLM tokens — SSE is usually the right choice, and saying so instead of reflexively picking WebSockets is a good signal.

Limits: one direction only; older HTTP/1.1 connection limits per domain (largely resolved by HTTP/2).

### WebSockets

A single TCP connection upgraded from HTTP, then **full-duplex** — either side can send at any time, with low per-message framing overhead.

```diagram
   GET /ws
   Upgrade: websocket           ← handshake over HTTP
   ───────────────────────────
   ◄──► binary/text frames, both directions, low overhead
```

The right choice when the client sends frequently too: chat, collaborative editing, multiplayer, live trading.

Costs, and these are the interview substance: connections are **stateful**, so your servers are no longer interchangeable; load balancers must support upgrade and long-lived connections; you must implement your own heartbeat, reconnection, and message-replay logic; and scaling means managing millions of open sockets.

### Choosing

| Need | Use |
|---|---|
| Updates within ~30 s, simple infra | Short polling |
| Near-real-time, constrained infra | Long polling |
| Server → client only | **SSE** |
| Both directions, high frequency | **WebSockets** |
| Mobile app, background delivery | **Push notifications** (APNs/FCM) — the OS holds the connection, not you |

That last row matters: on mobile, the OS kills your socket in the background. Real-time delivery to a backgrounded app *must* go through platform push services.

## Scaling persistent connections

This is where the design gets interesting.

**Connection capacity.** A tuned server handles ~100K–1M concurrent WebSocket connections, but the binding constraint is usually **memory**, not CPU — each connection needs socket buffers and application state, typically 10–50 KB. At 30 KB, 1M connections ≈ 30 GB of RAM. You'll also raise file descriptor limits and expand the ephemeral port range.

:::math Sizing the connection tier
10M concurrent users, 50 KB per connection → 500 GB of connection state. At 64 GB usable per node that's ~8 nodes minimum; realistically 20+ for headroom and failure tolerance. The math is simple and the fact that you *did* it is the point.
:::

**The routing problem.** This is the core difficulty: user B's message arrives at server 3, but user B's socket is on server 17.

```diagram
   1. REGISTRY: every connection records where it lives
        Redis:  conn:user_B → gateway-17     (TTL, heartbeat-refreshed)

   2. Server 3 receives a message for user B
   3. Look up registry → gateway-17
   4. Forward via internal RPC or a pub/sub channel
   5. Gateway-17 writes to B's socket
```

Two implementations:

- **Registry + direct forward.** Look up the owning node, send it an RPC. Efficient (one hop, no broadcast), needs a fast, highly-available registry. Best at large scale.
- **[Pub/sub broadcast](pub-sub.html).** Publish to a channel per user/room; every gateway subscribes to the channels for its connected users. No registry needed and it handles multi-device naturally, but fanout costs grow with node count if subscriptions are coarse.

Most large systems use pub/sub for rooms and a registry for direct messages.

**Sticky routing.** The load balancer must keep a connection pinned (it's one TCP connection, so this is automatic), but *reconnects* should ideally land somewhere sensible. Use L4 or an L7 balancer with upgrade support; note that consistent hashing on user ID reduces registry churn on reconnect.

## The operational details that matter

**Heartbeats.** TCP can hold a connection open long after the peer is gone ("half-open"). Send ping/pong every 30 s; close after two misses. Without this, your connection count drifts upward with ghosts and your registry lies about where users are.

**Reconnection with backoff and jitter.** When a gateway node restarts, all its connections reconnect simultaneously. Without jittered exponential backoff, that's a self-inflicted DDoS on the remaining nodes — and it repeats, because the surge can knock over the next node. This is the [thundering herd](caching.html) in its most dangerous form, and volunteering it is a strong signal.

**Message delivery guarantees.** A socket write is not a delivery guarantee — the client may disconnect mid-write. For anything that matters:

```diagram
   1. Persist the message durably FIRST
   2. Attempt real-time delivery over the socket
   3. Client ACKs with the message ID
   4. On reconnect, client sends its last-seen ID;
      server replays everything after it
```

Persist-then-push, plus client-driven replay on reconnect, is the pattern. Treat the socket as a *fast path*, never as the system of record.

**Backpressure.** A slow client can't keep up; the server's send buffer grows and consumes memory. Bound the per-connection queue and decide what happens on overflow — drop intermediate updates (fine for presence or a live counter, where only the latest matters) or disconnect the client and let it re-sync. An unbounded send buffer is a memory leak with a user attached.

**Deploys.** Restarting a gateway drops every connection on it. Drain gradually — stop accepting new connections, then close existing ones in batches with jitter, letting clients reconnect elsewhere. A naive rolling deploy of a connection tier is an outage.

## Presence

"Who's online" looks simple and is a classic scaling trap. Naive design: every client heartbeats every 5 s and every friend list query reads all friends' states.

The cost is quadratic-ish: 10M users heartbeating every 5 s is 2M writes/s, and each presence *change* must notify every friend. For a user with 5,000 friends, one status flip is 5,000 notifications.

Standard mitigations: store presence in Redis with a TTL that the heartbeat refreshes (so expiry is automatic and no "went offline" write is needed); **only push changes**, never steady state; batch and debounce (a user toggling network doesn't need 6 notifications); and consider fetching presence on demand for large friend lists rather than pushing. Many products deliberately reduce precision here — "active recently" instead of exact online status — because the exact version costs far more than it's worth.

:::exercise Hold a million connections
1. 1M concurrent WebSocket connections. Estimate memory per connection (socket buffers, TLS state, application state) and total. What is the actual binding resource?
2. List three kernel and three application settings you would change from defaults, with the reason for each.
3. A server holding 100K connections restarts. What happens in the next 60 seconds, and how do you prevent a reconnect thundering herd?
4. Presence: showing which of a user's 200 friends are online. Compute the fan-out cost of the naive design at 1M users, then design a better one.
5. WebSocket vs SSE vs long polling for: a chat app, a stock ticker, a progress bar, a collaborative editor. Justify each.
:::

:::paper Persistent connections at scale
RFC 6455 (WebSocket) and RFC 8895 / the HTML Server-Sent Events spec are the primary references, and both are short enough to read.

For scale, *Scaling Slack's Job Queue* and Discord's engineering posts on maintaining millions of concurrent WebSocket connections cover the practical problems — connection state, presence, and fan-out — better than any paper. See also [concurrency and the OS](../01-foundations/concurrency-and-the-os.html) for why 100K idle connections became cheap.
:::
