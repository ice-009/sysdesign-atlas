---
title: Design a Distributed Cache
summary: Building Memcached/Redis from first principles — sharding, eviction, replication, and the hot key problem that consistent hashing cannot solve.
difficulty: Medium
scope: HLD
tags: [case-study, cache, consistent-hashing, memory]
prereqs: [caching, consistent-hashing, replication]
---

:::predict Guess first
1. A cache uses key mod N to pick a node. You add one node to 16. Roughly what fraction of keys move?
2. One key gets 40% of all traffic. Does a perfectly balanced hash ring help?
3. The whole cache cluster restarts empty while full production traffic is flowing. What happens to the database?
:::

:::interview Why this question
It's a compact systems design with no product ambiguity, so the whole conversation is technical. It rewards depth on [consistent hashing](../02-building-blocks/consistent-hashing.html), eviction, and — the part that is usually skipped — the failure modes that consistent hashing *doesn't* fix.
:::

## 1. Requirements

**Functional**
- `get(key)`, `set(key, value, ttl)`, `delete(key)`.
- Values up to ~1 MB, opaque bytes.
- TTL-based expiry and LRU eviction when memory is full.
- Add and remove nodes without a full cache flush.

**Non-functional**
- **Sub-millisecond p99.** This is the entire reason the cache exists.
- Very high throughput — hundreds of thousands of ops/s per node.
- **Cache misses are acceptable; correctness violations are not.** Returning stale data is a design decision; returning *another key's* data is a bug.
- Losing the cache must degrade performance, not correctness.

**Clarifying questions:** Is durability required at all? (Usually no — that's the point.) Are we replicating for availability or just sharding for capacity? Does the client route, or is there a proxy tier?

## 2. Estimation

**1 TB working set**, 1M ops/s, average value 10 KB.

```diagram
   Objects: 1 TB / 10 KB = 100M keys

   Memory per node: 64 GB usable (leaving headroom for
   fragmentation and overhead)
   → 1 TB / 64 GB = ~16 nodes minimum, ~24 with headroom

   Throughput: 1M ops/s / 24 = ~42,000 ops/s per node
   → comfortable. Redis does 100K+/s per core.

   Network: 1M ops/s × 10 KB = 10 GB/s aggregate
   → 80 Gbps across the fleet; ~3.5 Gbps per node ✓

   → This cluster is sized by MEMORY, not CPU or network.
```

Stating which resource binds — memory here — is a small thing that demonstrates you understand what you're building.

## 3. Architecture: where does routing live?

Three options, and the comparison is worth having ready.

**Client-side routing (recommended).** The client library knows the ring and connects directly to the right node.

```diagram
   app ──hash(key)──► node 7        one network hop
```

Lowest latency (no proxy hop), no extra tier to operate. Costs: every client needs the topology, so membership changes must propagate to all clients, and client libraries exist in every language you use. This is how Memcached clients and Redis Cluster clients work.

**Proxy tier.** Clients talk to a proxy that routes.

```diagram
   app ──► proxy ──► node 7          two hops
```

Clients stay dumb, topology lives in one place, and you can add features (connection pooling, request coalescing, multi-get splitting). Costs an extra hop (~0.3 ms — significant when your budget is 1 ms) and a tier to scale and keep available.

**Server-side redirect.** The client contacts any node; if it's the wrong one, that node replies with a redirect. Redis Cluster's `MOVED` response works this way. Self-healing topology knowledge, at the cost of an occasional extra round trip.

**Recommend client-side routing** for a latency-critical cache, with the caveat that topology propagation needs a solution (a configuration service the clients poll and cache).

## 4. Sharding

[Consistent hashing with virtual nodes](../02-building-blocks/consistent-hashing.html).

```diagram
   Without consistent hashing (key mod N):
     adding one node to a 16-node cluster remaps ~94% of keys
     → near-total cache miss storm → the database dies

   With consistent hashing:
     adding a node moves ~1/17 of keys → ~6% miss rate briefly
```

**Virtual nodes (~150 per physical node) are essential**, for two reasons — and naming the second one is the depth signal:

1. Even distribution despite random ring placement.
2. **On failure, the dead node's keys spread across many successors** rather than landing entirely on one, which would overload it and potentially cascade.

**Alternatively, rendezvous hashing** — for a cluster of a few dozen nodes it's simpler (no virtual node tuning), distributes uniformly by construction, and gives you an ordered preference list for replica placement for free. At 24 nodes, its O(N) lookup is negligible. Proposing it as the better fit here is a legitimate and well-informed opinion.

## 5. Eviction and memory management

**Eviction policy:** LRU by default — it matches temporal locality. Note its weakness: a large scan (a batch job reading everything once) flushes the hot set. **LFU with decay** resists this and is worth mentioning; modern in-process caches use adaptive policies like W-TinyLFU.

**Approximate LRU is the practical implementation.** True LRU requires updating a linked list on every access, which means a lock and cache-line contention on every read. Instead, sample K random keys and evict the least-recently-used among them:

```diagram
   Sample 5 keys → evict the oldest of those.
   With sampling, results are very close to true LRU
   at a fraction of the bookkeeping cost.
```

Explaining *why* approximate LRU exists (lock contention on the hot path) rather than just naming it is a nice touch.

**Expiry** is lazy plus active: check TTL on read (lazy — free), and run a background sampler that expires a fraction of keys per cycle (active — bounds memory growth from keys never read again). Purely lazy expiry means expired-but-unread keys occupy memory forever.

**Memory allocation** uses slab allocation (fixed-size classes) to avoid fragmentation. The cost is internal waste — a 1.1 KB value in a 2 KB slab wastes 900 bytes. Worth knowing that "we have 64 GB but can only store 50 GB of values" is normal.

## 6. Deep dive — the hot key problem

A **hot key** is one entry that a huge share of traffic wants at the same moment — a celebrity's profile, a flash-sale product, the config every request reads. It's **the single most important limitation to raise**, because consistent hashing gives no protection against it whatsoever.

```diagram
   Consistent hashing distributes KEYS evenly.
   It does NOT distribute LOAD.

   One key taking 40% of all traffic saturates its node
   no matter how perfect the ring is.
```

A celebrity's profile, a flash-sale product, a global config value — these are real and common.

**Mitigations, and a strong answer gives more than one:**

**1. Key replication with suffixes.** Store the hot key as `key:0` … `key:9` on different nodes; clients read a random one. Load spreads 10×. Costs 10× memory for that key and makes invalidation touch all copies.

**2. Client-side (local) cache** for the very hottest keys. A tiny in-process cache with a short TTL absorbs most reads with **zero** network calls. Extremely effective, and the cost is bounded staleness (up to the local TTL) that you must accept explicitly.

**3. Request coalescing** so a miss on a hot key doesn't produce a thousand simultaneous origin fetches ([cache stampede](../02-building-blocks/caching.html)).

**Detection is a prerequisite** for all of these: track per-key request rates with a [count-min sketch](../02-building-blocks/bloom-filters.html) — exact per-key counters for millions of keys would cost more than the cache. Then promote detected hot keys to local caching automatically.

:::goat Say this unprompted
"Consistent hashing solves key distribution, not load distribution. If one key gets 40% of traffic, the ring doesn't help at all — that node saturates. I'd detect hot keys with a count-min sketch on the client side and handle them two ways: replicate the key across several nodes with a suffix, and add a small local in-process cache with a one-second TTL for the very hottest ones. The local cache costs a bounded amount of staleness and removes essentially all network traffic for those keys."

Consistent hashing is often presented as a complete solution. Identifying what it *doesn't* solve is the differentiator.
:::

## 7. Replication and availability

**The first question to ask: do we even need replication?**

For a pure cache, losing a node means those keys miss and fall through to the database. If the database can absorb 1/24th of the read load, replication is unnecessary complexity — and saying so is good judgment, not laziness.

**You need replication when:**
- The origin *cannot* absorb the miss traffic (the cache is load-bearing, not just an optimization).
- Cold-start recovery is too slow to tolerate.
- The cache holds data that isn't cheaply recomputable (sessions, rate-limit counters).

**If replicating:** primary–replica per shard with async replication. Reads may serve from replicas; writes go to the primary. Async is right here — paying sync replication latency for cache data defeats the purpose, and the data is disposable by definition.

## 8. Failure modes

| Failure | Behaviour |
|---|---|
| One node dies | Its ~1/N of keys miss and fall through. **Guard the origin** with a circuit breaker or you convert a cache failure into a database outage. |
| Whole cluster restarts (cold) | The dangerous one. 100% of reads hit the database instantly. Ramp traffic gradually and pre-warm hot keys; a cold cache under full load simply dies again. |
| Network partition | Clients see some nodes as down; those keys miss. Ensure clients fail *fast* on unreachable nodes rather than waiting on timeouts. |
| Slow node (gray failure) | Worse than a dead node — it holds connections and drags p99. Eject on latency, not just on failure. |
| Memory pressure | Eviction rate spikes; hit rate drops. Alert on eviction rate — it's the leading indicator that the cache is undersized. |

:::trap Cold start is a recovery problem too
"If the cluster restarts empty and I send it full production traffic, the database sees 100% of reads and falls over — and then it falls over *again* on the next recovery attempt, because the cache is still cold. Recovery has to be gradual: admit a small fraction of traffic, let the cache fill, then ramp. I'd also pre-warm the top keys from an offline job."

Recognizing that recovery is its own overload event is a genuinely production-flavoured observation.
:::

## 9. Follow-ups

- *"Cache invalidation across the fleet?"* — the cache is shared, so a delete on the owning node is sufficient. **Local client caches break this**, which is the real cost of the hot-key mitigation above: they can only be invalidated by TTL expiry, so keep those TTLs short.
- *"Multi-region?"* — don't replicate cache data across regions. It's regenerable, and cross-region invalidation is unreliable. Each region gets its own cluster; short TTLs bound the divergence.
- *"How do you add capacity without a miss storm?"* — add nodes gradually so only a small fraction of keys move at a time, and warm new nodes by copying from their predecessors before putting them in rotation.
- *"Persistence?"* — usually the wrong instinct for a cache, but useful for fast restart (Redis RDB/AOF). Be clear it's for warm restart, not durability, and that treating a cache as a system of record is how outages become data loss.

## Check yourself

```recall
Q: What sizes a 1 TB, 1 million ops/s cache cluster?
A: Memory: 1 TB ÷ 64 GB usable ≈ 16 nodes, ~24 with headroom, at only ~42,000 ops/s each.

Q: Client-side routing, proxy or server redirect?
A: Client-side routing gives one hop and no extra tier, but every client needs the topology. A proxy keeps clients simple at ~0.3 ms extra. Server redirects (Redis MOVED) self-heal with an occasional extra hop. For latency, route in the client.

Q: Why consistent hashing with virtual nodes?
A: Mod N remaps ~94% of keys when one node is added — a miss storm. Consistent hashing moves ~1/N; ~150 vnodes even out load and spread a dead node's keys across many successors.

Q: Why approximate LRU?
A: True LRU updates a linked list on every read — locks and cache-line contention on the hot path. Sampling about five keys and evicting the oldest gets very close at a fraction of the cost.

Q: Why lazy plus active expiry?
A: Lazy (checked on read) is free, but expired keys nobody reads would stay forever; a background sampler expiring a fraction per cycle bounds memory.

Q: What doesn't consistent hashing solve, and how do you handle it?
A: Hot keys — it spreads keys, not load. Detect them with a count-min sketch, replicate as key:0…key:9, add a short-TTL in-process cache, and coalesce misses.

Q: When does a cache need replication?
A: Only when the origin can't absorb a node's misses, cold recovery is too slow, or the data isn't cheaply recomputable (sessions, counters). Then use async primary–replica.

Q: Why is a cold start dangerous, and how do you recover?
A: An empty cache sends 100% of reads to the database, which falls over again on each retry. Ramp traffic gradually and pre-warm the top keys.
```

## What to carry forward

- A cache is sized by memory; losing it must cost speed, never correctness.
- Client-side routing with consistent hashing or rendezvous hashing.
- Approximate LRU and lazy-plus-active expiry keep the hot path cheap.
- Consistent hashing spreads keys, not load: detect and replicate hot keys.
- Replicate only if the origin can't take the misses; ramp up after cold starts.
