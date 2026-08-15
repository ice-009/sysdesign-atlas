---
title: The HLD Refresher
summary: The whole high-level-design round compressed into one page — the 45-minute structure, the six numbers worth memorising, a decision table for every building block, and a worked ten-minute mini-design.
difficulty: Medium
scope: HLD
tags: [hld, framework, revision, cheatsheet]
prereqs: [hld-vs-lld, back-of-envelope]
unlocks: Walking into an HLD round with the structure, the numbers, and the component tradeoffs in working memory.
---

This is the compression of [Foundations](../fundamentals/scalability-basics.html), [Building Blocks](../building-blocks/load-balancing.html), and the [interview framework](../appendix/framework.html) into what fits in your head two days before an interview. Read the first half on day 1 and the second on day 2; skim both on day 3.

## Part 1 · The structure

```viz
{
  "type": "steps",
  "caption": "45 minutes. Announce it in the first minute, then deviate when steered.",
  "note": "Minutes 27–40 hold most of the score. Everything before them exists to buy that time.",
  "steps": [
    { "label": "0–5 · Requirements", "sub": "Functional, non-functional, explicit scope cut." },
    { "label": "5–10 · Estimation", "sub": "Only numbers that change a decision." },
    { "label": "10–15 · API + data model", "sub": "Endpoints, schema, and the partition key." },
    { "label": "15–27 · High-level design", "sub": "Draw it, then narrate one request end to end." },
    { "label": "27–40 · Deep dives", "sub": "Two, properly. Depth beats breadth." },
    { "label": "40–45 · Wrap", "sub": "Bottleneck at 10×, failure modes, what you'd monitor." }
  ]
}
```

**Requirements.** Three or four functional bullets, then the non-functional ones that actually shape the design: read/write ratio, latency target, consistency need, availability target, and scale. Then say what you're *not* doing. Scope discipline is scored.

**Estimation.** One or two numbers, each followed by "…which means". `QPS = DAU × actions/day ÷ 10⁵`. Storage = objects × size × retention × replication. If a number doesn't change a decision, skip it and say you're skipping it.

**API + data model.** Four or five endpoints max. Then the schema — and always name the **partition key** and why. "Partition by `user_id`, because every read is scoped to a user and it keeps a timeline on one shard" is one of the highest-value sentences in the round.

**High-level design.** Draw the boxes, then walk one write and one read through them, labelling every arrow with what flows. Never leave an unlabelled arrow.

**Deep dives.** Pick the two hardest parts — usually the hot path and the consistency problem — and go three levels down. Offer a choice: *"the interesting parts here are the fan-out strategy and the cache invalidation; which would you rather I dig into?"*

**Wrap.** "At 10× this breaks first, here's what I'd do. If this component dies, here's the degradation. I'd monitor these three metrics." Three sentences, and they close the round strongly.

:::interview The two sentences that raise your score most
**At the start:** "Here's how I'd like to use the time…" — it frames everything after as deliberate.
**Throughout:** "…which means…" — never state a number or a component without the consequence. "300K read QPS, *which means* the cache tier is the primary read path, not an optimisation." Decisions with reasons are the entire scoring rubric.
:::

## Part 2 · The numbers

Six facts. Everything else can be derived at the whiteboard.

```diagram
   1 day  ≈ 10⁵ seconds                    QPS = DAU × actions/day ÷ 10⁵
   Peak   ≈ 3× average                     (10× for events, launches, matches)

   Memory read       ~100 ns    ─┐
   SSD random read   ~100 µs     │  memory is ~1,000× SSD
   Same-DC round trip ~500 µs    │  a network hop costs more than reading 1 MB of RAM
   Cross-continent RTT ~100 ms  ─┘  physics; only moving data closer helps

   One commodity server:  ~50K QPS trivial work · ~10K QPS real work
                          64–512 GB RAM · 10 Gbps NIC ≈ 1.2 GB/s
   One SQL primary:       ~10–50K writes/s · single-node ceiling ~10 TB comfortably
   Redis:                 ~100K ops/s per core, sub-ms
   Kafka partition:       ~10 MB/s, ordered
```

**Object sizes:** ID 8–16 B · text post ~300 B · DB row ~1 KB · thumbnail ~10 KB · web photo ~500 KB · 1 hr 1080p ≈ 2 GB.

**The three derived conclusions** that do most of the work in an interview:

1. If working-set data fits in memory across a few machines, **cache it** — you just removed most of your read load.
2. If storage exceeds ~10 TB or writes exceed ~50K/s, **you're sharding**, and the only question is the key.
3. If a step is slow, fallible, or bursty and the user doesn't need its result immediately, **queue it**.

For the full tables see [the cheat sheet](../appendix/cheat-sheet.html).

## Part 3 · The building blocks, as a decision table

| Component | Use it when | The tradeoff to say out loud |
|---|---|---|
| **Load balancer** | Always, in front of any tier | L4 is fast and dumb; L7 can route on path/header and terminate TLS. Health checks decide what "up" means |
| **Cache** | Read-heavy and staleness is tolerable | Invalidation is the hard part. Name the pattern: cache-aside (default), write-through, write-behind. Set a TTL even with invalidation |
| **CDN** | Static or cacheable media, geographically spread users | Cheap latency win; purge lag is real. Version URLs instead of purging |
| **SQL** | Relationships, transactions, ad-hoc queries; the default | One primary bounds writes. Read replicas add read capacity and replication lag |
| **NoSQL (KV/wide-column)** | Known access pattern, huge scale, simple queries | You trade joins and flexible querying for linear scale. Model the table around the query |
| **Sharding** | Past a single node's storage or write ceiling | Cross-shard queries and transactions get hard. Choose the key for even distribution *and* query locality |
| **Message queue** | Decouple, absorb bursts, retry, fan out | Adds eventual consistency and duplicate delivery — so consumers must be idempotent |
| **Search index** | Full-text, faceting, relevance ranking | A second store to keep in sync; near-real-time, not real-time |
| **Object store** | Blobs — images, video, backups | Store the URL in the database, never the bytes. Upload direct with pre-signed URLs |
| **WebSockets / SSE** | Server must push; sub-second delivery | Stateful connections make deploys and scaling harder than polling |
| **Rate limiter** | Any public API | Fail-open vs fail-closed is a real decision. See [rate limiting](rate-limiter-classes.html) |

## Part 4 · The reference architecture

Most designs are this picture with two or three boxes changed. Start here, then justify each deviation.

```diagram
   Client ─▶ CDN ─▶ LB ─▶ API gateway ──▶ Service tier ──▶ Cache ──▶ Primary DB
                          (auth,               │                        │
                           rate limit)         │                        ├─▶ Read replicas
                                               │                        └─▶ Shards
                                               ▼
                                        Message queue ──▶ Workers ──▶ Search index
                                                                 └──▶ Object store
                                                                 └──▶ Analytics / OLAP
```

- **Sync path** (left to right, top row): must be fast, must be simple. Every component here is on the user's critical path.
- **Async path** (down through the queue): anything the user's response doesn't depend on — notifications, indexing, thumbnails, analytics, fan-out.

Deciding what goes below the line is most of the design. "The user's write must return once it's durable in the primary; indexing, notifications, and feed fan-out all happen off the queue" is a sentence that covers a lot of ground in one breath.

## Part 5 · The five deep dives that appear everywhere

Have a paragraph ready on each. One of them will come up in any HLD round.

**1 · Caching strategy.** Cache-aside with TTL as the default. Say what you cache (the object, or the rendered result), where (client / CDN / app / distributed), and how invalidation works. Name the two hard cases: **stampede** (many misses on one hot key → single-flight or a locked refresh) and **hot key** (one key exceeding a node's capacity → replicate it across nodes or add a local L1). See [Caching](../building-blocks/caching.html).

**2 · Partitioning.** State the key and why. Range keys give you scans but hotspots; hash keys give you distribution but no range queries; [consistent hashing](../building-blocks/consistent-hashing.html) makes resharding cheap. Always mention the celebrity/hot-partition problem and one mitigation (salting the key, dedicated handling for the top 0.1%).

**3 · Consistency.** Where do you need strong consistency, and where is eventual fine? The good answer is per-operation, not per-system: "the booking write is strongly consistent — it's a conditional update on one row; the seat map is eventually consistent with a one-second TTL, and the UI says so." See [CAP/PACELC](../fundamentals/cap-pacelc.html).

**4 · Failure.** For each major component: what happens when it dies, and what does the user see? Cache down → higher latency, database load spikes (so have a circuit breaker). Queue backed up → delayed side effects, not lost ones. Region down → failover, with a stated RTO/RPO. Retries need **backoff, jitter, and idempotency keys**, or your retries become the outage.

**5 · The hot path at 10×.** Name the first thing to break and the fix. This is the wrap-up question and the one candidates fumble because they never actually thought about which component is closest to its limit.

## Part 6 · A worked ten-minute mini-design

*"Design a URL shortener"* — how the pieces above assemble under time pressure.

> **Requirements.** Create short link, redirect, optional expiry. Read-heavy, redirect latency in the low tens of ms, high availability — a dead shortener breaks every link ever shared. Out of scope: accounts, analytics dashboards, malware scanning.
>
> **Estimation.** 100M writes/day → 100M ÷ 10⁵ = **1K write QPS**, ~3K peak. 100:1 reads → **100K read QPS**, ~300K peak. 500 B/record × 100M × 365 × 5 ≈ **91 TB** with retention. *Which means:* sharded storage (past one node), and a cache tier as the primary read path (300K QPS of tiny immutable payloads is the ideal cache workload).
>
> **API.** `POST /urls {long_url} → {short_url}`; `GET /{code} → 302`. 302 not 301, because a permanent redirect is cached by browsers and effectively unrevocable — I'd rather keep control and pay the traffic.
>
> **Data model.** `urls(code PK, long_url, created_at, expires_at)`. Partition by hash of `code` — every access is a point lookup by code, so there's no range query to preserve and hashing distributes evenly.
>
> **Design.** CDN/LB → stateless API tier → Redis (code → URL, ~99% hit rate given the Zipf distribution of link popularity) → sharded KV store. Writes go to the store and populate the cache.
>
> **Deep dive: ID generation.** Three options — random 7-char base62 with a uniqueness check (62⁷ = 3.5 × 10¹², collisions negligible but a read before every write), a counter encoded to base62 (dense and sequential, but enumerable and needs a distributed counter), or per-node ranges pre-allocated from a central allocator (no coordination per request, small gaps on restart). I'd take pre-allocated ranges: no read-before-write, no hot counter, and unpredictable enough with a random suffix.
>
> **Failure and scale.** Cache down → all 300K QPS hits the store; mitigate with a local in-process L1 and a circuit breaker. The store is append-mostly and immutable, so replicas are trivially consistent. At 10× the bottleneck is cache memory, and the fix is more cache nodes with consistent hashing.

That's the entire round in six paragraphs. The full version is in [the case study](../case-studies/url-shortener.html).

:::warn The four ways prepared candidates still lose
**No scope cut** — designing everything and finishing nothing. **Numbers with no conclusion** — five minutes of arithmetic that changes no decision. **Breadth over depth** — twelve components named, none explained. **Silent drawing** — three minutes of boxes with no narration. Every one of these is a time-management failure, not a knowledge failure, which is why the structure at the top of this page is the highest-leverage thing on it.
:::

:::exercise Ten minutes, out loud
Do the mini-design above for **a pastebin with expiring notes**, or **a notification service**. Six paragraphs, ten minutes, spoken. If you dry up, the missing thing is almost always the "…which means" after a number.
:::
