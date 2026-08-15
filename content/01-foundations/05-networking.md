---
title: The Network Between Your Boxes
summary: TCP handshakes, congestion control, head-of-line blocking, and TLS cost — why the arrows in your architecture diagram are the expensive part.
difficulty: Medium
scope: Core
tags: [fundamentals, networking, tcp, latency]
prereqs: [latency-throughput]
unlocks: Reading a latency budget correctly, and knowing which arrows in a diagram cost real money.
---

## The arrows are not free

Architecture diagrams draw services as boxes and network calls as arrows. The boxes get all the attention. But in a typical request path, **most of the wall-clock time is spent in the arrows** — and almost none of it is spent transmitting bytes.

Understanding what happens inside an arrow tells you why the fix for slow systems is so often "make fewer calls" rather than "make each call faster."

One unit runs through this whole page: **RTT**, the round trip time — how long a message takes to reach the other machine *and* the reply to come back. Everything below is counted in round trips, because that's what actually costs you.

## What one HTTPS request actually costs

```viz
{
  "type": "steps",
  "caption": "A cold HTTPS request to a server 50 ms away. Four round trips before a single byte of your data moves.",
  "steps": [
    { "label": "DNS", "sub": "0-100 ms · cached or not", "accent": "#38bdf8" },
    { "label": "TCP handshake", "sub": "1 RTT · SYN, SYN-ACK, ACK", "accent": "#22d3ee" },
    { "label": "TLS handshake", "sub": "1 RTT (1.3) or 2 (1.2)", "accent": "#a78bfa" },
    { "label": "Request + response", "sub": "1 RTT + server time", "accent": "#4ade80" },
    { "label": "Slow start", "sub": "more RTTs if the response is large", "accent": "#fbbf24" }
  ]
}
```

:::derive The cost of a cold connection
```
   Server 50 ms round trip away, TLS 1.3, DNS uncached:

     DNS lookup                    50 ms   (often more; multiple lookups)
     TCP handshake        1 RTT =  50 ms
     TLS 1.3 handshake    1 RTT =  50 ms
     Request → response   1 RTT =  50 ms
                                  ───────
     Total before server work:    200 ms

   The same request on a warm, already-open connection:

     Request → response   1 RTT =  50 ms

   → The connection setup costs 3× the request itself.
```
:::

**This is why connection pooling is not a micro-optimisation.** It removes 150 ms of pure overhead from every call. It is also why HTTP keep-alive, persistent gRPC channels, and long-lived database connections exist, and why a service that opens a fresh connection per request will be inexplicably slow no matter how fast its code is.

:::goat The framing that lands
"The dominant cost in this call path is round trips, not bytes and not CPU. So the design question is *how many round trips does one user action require* — and my job is to get that number down."

That reframing leads directly to connection reuse, batching, pipelining, and colocating chatty services. It's a much better instinct than optimising the handler.
:::

## TCP: congestion control and slow start

TCP does not start sending at full speed. It has no idea what the network between you can carry, so it feels its way — sending a little, and doubling each round trip until something gets dropped. That ramp-up is called **slow start**, and it's why small responses feel instant while large ones feel sluggish even on a fast connection.

```diagram
   TCP SLOW START (initial window = 10 segments ≈ 14 KB)

     RTT 1:   10 segments   ~14 KB      cumulative ~14 KB
     RTT 2:   20 segments   ~29 KB      cumulative ~43 KB
     RTT 3:   40 segments   ~58 KB      cumulative ~101 KB
     RTT 4:   80 segments  ~116 KB      cumulative ~217 KB

   → A 200 KB response over a 50 ms RTT link needs ~4 RTTs = 200 ms
     of transfer time, even on a gigabit connection.
     The bottleneck is not bandwidth. It is round trips.
```

:::math The 14 KB rule
Because the initial congestion window is ~10 segments (~14 KB), **the first 14 KB of any response arrives in one round trip.** Everything past that costs at least one more.

This is the real reason "keep your critical HTML/CSS under 14 KB" was ever advice — it's a TCP fact, not a web-design preference. The same logic applies to API responses: a 12 KB response and a 20 KB response can be a full RTT apart.
:::

**Bandwidth-delay product** is the related idea worth carrying:

```
   BDP = bandwidth × round-trip time

   1 Gb/s link, 100 ms RTT:
     BDP = 125 MB/s × 0.1 s = 12.5 MB

   → To saturate that link you must keep 12.5 MB of unacknowledged
     data in flight. If the TCP window caps at 64 KB, you achieve
     64 KB / 0.1 s = 640 KB/s — 0.5% of the link.
```

This is why long-distance bulk transfer needs window scaling, parallel streams, or a protocol that isn't TCP. A "slow transatlantic link" is very often a fast link with an unscaled window.

## Head-of-line blocking, three times over

**Head-of-line blocking** is a queue where the item at the front is stuck, so everything behind it waits — even though those items are perfectly ready to go. One shopper arguing at the till holds up ten people with a single item each.

The same failure appears at three layers, and knowing which one you have determines the fix.

```viz
{
  "type": "compare",
  "caption": "The same words describe three different problems at three different layers.",
  "left": {
    "title": "HTTP/1.1 — application layer",
    "items": [
      "One request per connection at a time",
      "A slow response blocks the next request",
      "Fix: 6 parallel connections per origin",
      "Fix properly: HTTP/2 multiplexing"
    ]
  },
  "right": {
    "title": "TCP — transport layer",
    "items": [
      "One lost packet stalls the whole stream",
      "HTTP/2 multiplexes over ONE TCP connection",
      "→ one loss stalls every multiplexed request",
      "Fix: HTTP/3 over QUIC, per-stream recovery"
    ]
  }
}
```

The third case is the one that bites in backend systems: **head-of-line blocking in a message queue partition**. A single *poison message* — one that fails every time it's processed — sits at the front of the queue and blocks every message behind it, no matter how many consumers you add. The fix is not parallelism; it's a dead-letter queue and a bounded retry policy. See [message queues](../02-building-blocks/message-queues.html).

:::trap "HTTP/2 solved head-of-line blocking"
It solved it at the HTTP layer and *concentrated* it at the TCP layer. Multiplexing — running many requests down a single connection at once — means one dropped packet stalls all 100 of them until it's re-sent.

On a clean datacenter network this is a good trade. On a lossy mobile network it can be worse than HTTP/1.1's six connections. HTTP/3 fixes it properly by running over QUIC (UDP), where each stream recovers independently.
:::

## Protocol choice, briefly

| Protocol | Round trips to first byte | Multiplexing | Where it fits |
|---|---:|---|---|
| HTTP/1.1 | TCP + TLS + 1 | None (6 connections/origin) | Simple, universally supported |
| HTTP/2 | TCP + TLS + 1 | Yes, one TCP connection | Default for internal APIs and modern web |
| HTTP/3 (QUIC) | 1 (0 on resumption) | Yes, per-stream recovery | Lossy or mobile networks, high-RTT paths |
| gRPC (HTTP/2) | Same as HTTP/2 | Yes, plus streaming | Internal service-to-service; binary, schema'd |
| WebSocket | TCP + TLS + upgrade | One bidirectional stream | Server push, [realtime](../02-building-blocks/realtime.html) |

QUIC's 0-RTT resumption is the notable one: a returning client can send application data in the *first packet*, eliminating handshake cost entirely. The catch is that 0-RTT data is replayable, so it must only carry idempotent requests — a direct application of [idempotency](../03-distributed/idempotency.html).

## TLS is cheap now, but not free

The old advice that "TLS is expensive" is mostly obsolete. With AES-NI hardware acceleration, symmetric encryption runs at gigabytes per second and costs single-digit percent CPU.

What still costs:

- **The handshake.** One RTT for TLS 1.3, two for 1.2. This is latency, not CPU, and it's why session resumption and connection reuse matter.
- **Asymmetric crypto on the handshake.** An RSA-2048 signature is ~1 ms of CPU. At 10,000 new connections/s that is 10 cores doing nothing but handshakes. ECDSA is roughly 10× cheaper — a genuinely free win.
- **Certificate validation and OCSP.** A blocking OCSP lookup can add an entire uncached network round trip. OCSP stapling removes it.

## Timeouts, retries, and how they cause outages

Every network call needs a deadline, because the failure mode without one is unbounded. But naive retries turn a small problem into an outage.

```diagram
   RETRY AMPLIFICATION

   A service is degraded; 20% of calls time out.
   Every layer retries 3 times.

     Client → Gateway → Service → Database
        ×3       ×3        ×3

     One user request → up to 27 database queries

   → The retries generate more load than the original traffic,
     which deepens the degradation, which triggers more retries.
     This is a metastable failure: it does not recover when the
     original trigger goes away.
```

What actually works:

- **Exponential backoff with full jitter.** Without jitter, retries synchronise into waves. `sleep = random(0, min(cap, base × 2^attempt))`.
- **Retry budgets.** Cap retries at a small percentage of total requests (say 10%), globally, rather than per-call. When the budget is exhausted, fail fast.
- **Circuit breakers.** After N consecutive failures, stop calling for a cooldown period. This converts a slow failure into a fast one, which protects the caller's threads.
- **Deadline propagation.** Pass the remaining time budget down the call chain. If a request has 50 ms left, the database call should not be given a 5 second timeout — it should fail immediately.
- **Retry only idempotent operations**, and only on errors that indicate the work definitely did not happen.

:::goat Deadline propagation is the senior move
Most systems set a static timeout per call. That means a request that has already spent 900 ms of its 1,000 ms budget will still start a fresh call with a 500 ms timeout, guaranteeing the client sees a timeout *after* the server did useless work.

Passing a deadline through the call chain — gRPC does this natively — means every layer knows how much time is left and can fail immediately rather than doing work whose result nobody will wait for. It also makes load shedding possible: a server can reject a request whose deadline has already expired before it even starts.
:::

## Where the bytes actually go

For most APIs the payload is small enough that bandwidth is irrelevant and round trips dominate. For media, bulk data, and fan-out systems, the opposite is true and egress cost becomes a line item on the bill.

Practical levers, in rough order of effect:

1. **Make fewer calls.** Batch, pipeline, or colocate. Nothing else comes close.
2. **Compress.** gzip is ~70% off text; brotli slightly better; zstd is faster than both at similar ratios. Never compress already-compressed media.
3. **Send less.** Field selection, pagination, and delta updates beat compressing a payload you shouldn't have sent.
4. **Move the data closer.** A [CDN](../02-building-blocks/cdn.html) turns a cross-continent transfer into a local one.
5. **Choose a tighter encoding.** Protobuf/Avro over JSON is typically 30–50% smaller and much faster to parse — worth it on internal high-volume paths, rarely worth the tooling cost on external APIs.

:::exercise Budget a real request
A user in Singapore loads a page from a service in Virginia (RTT ≈ 230 ms). The page requires: a DNS lookup, an HTTPS connection, an HTML document (8 KB), then three API calls (each 30 KB) that the browser cannot start until the HTML arrives.

1. What is the floor latency, assuming zero server processing and TLS 1.3?
2. The three API calls are issued in parallel over HTTP/2 on the existing connection. Does that change your answer? By how much?
3. You add a CDN edge in Singapore that terminates TLS but still fetches from Virginia. What improves, and what doesn't?
4. Which single change would help most: HTTP/3, a read replica in Singapore, or merging the three API calls into one?
:::

Reasoning to check yourself against: (1) ~4 RTTs ≈ 920 ms. (2) Parallel calls save two RTTs versus serial, so ~690 ms — multiplexing helps a lot here. (3) TLS termination at the edge removes two setup RTTs on a *short* link and replaces them with a warm pooled connection to origin; the data still crosses the Pacific, so the API calls barely improve. (4) The read replica — it attacks propagation delay, which is the only irreducible term. Merging the calls is second and much cheaper to build.

:::paper Sources
Van Jacobson's *Congestion Avoidance and Control* (1988) is the origin of slow start and congestion avoidance. Ilya Grigorik's *High Performance Browser Networking* (O'Reilly, free online) is the best single treatment of everything on this page.

For the failure modes: Marc Brooker's writing on retries and jitter at AWS, and *Metastable Failures in Distributed Systems* (Bronson et al., HotOS 2021) on why retry storms don't self-heal.
:::

## What to carry forward

- **Round trips dominate, not bytes.** Count RTTs per user action; that is your latency budget.
- A cold HTTPS connection costs **3 extra round trips**. Pool connections.
- **Slow start** means the first ~14 KB is one RTT and everything after costs more.
- **BDP** explains why long-distance links underperform: not enough data in flight.
- Head-of-line blocking exists at the HTTP, TCP, and queue-partition layers — identify which one you have before fixing it.
- **Retries without jitter, budgets, and deadline propagation cause outages** rather than preventing them.
