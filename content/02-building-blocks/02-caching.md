---
title: Caching
summary: The caching layers, the four write strategies, eviction policies, and the three failure modes — stampede, penetration, avalanche — that every serious interview eventually reaches.
difficulty: Medium
scope: HLD
tags: [cache, redis, performance]
prereqs: [hardware-numbers, latency-throughput]
---

## Why caching dominates

Caching is the highest-leverage performance technique available, because of the numbers in the [latency ladder](../01-fundamentals/latency-throughput.html): memory is ~1,000× faster than SSD, and a local memory read is ~5,000× faster than a cross-region round trip.

But the real win is usually **load reduction**, not latency. A 95% cache hit rate means your database sees 1/20th of the traffic — which is often the difference between one database and a sharded cluster. Whenever you propose a cache, quantify it: at a 95% hit rate the database handles 5,000 QPS instead of 100,000, which keeps you on a single primary."

Caching works because of two empirical regularities: **temporal locality** (recently accessed data is likely accessed again) and **skew** (a small fraction of items get most of the traffic — the classic 80/20, and on social platforms far more extreme).

## The layers

Requests pass through many caches. Know all of them — most discussions name only one.

```viz
{
  "type": "flow",
  "caption": "Every request passes through several caches. Most designs account for only one.",
  "nodes": [
    {
      "id": "b",
      "label": "Browser",
      "sub": "0 ms",
      "col": 0
    },
    {
      "id": "cdn",
      "label": "CDN edge",
      "sub": "~10 ms",
      "col": 1
    },
    {
      "id": "app",
      "label": "In-process",
      "sub": "~100 ns",
      "col": 2
    },
    {
      "id": "r",
      "label": "Redis",
      "sub": "~0.5 ms",
      "col": 3
    },
    {
      "id": "db",
      "label": "DB buffer pool",
      "sub": "~100 \u00b5s",
      "col": 4
    }
  ],
  "edges": [
    {
      "from": "b",
      "to": "cdn"
    },
    {
      "from": "cdn",
      "to": "app"
    },
    {
      "from": "app",
      "to": "r"
    },
    {
      "from": "r",
      "to": "db"
    }
  ]
}
```

- **Browser / client cache** — free, zero latency, but you can't invalidate it. Controlled by `Cache-Control` and `ETag`.
- **[CDN](cdn.html)** — geographically distributed edge. Best for static assets and increasingly for cacheable API responses.
- **In-process (local) cache** — a hash map in the application's memory. Nanosecond access, no network. Costs: each server has its own copy (memory × N), and consistency across the fleet is hard. Best for small, hot, slow-changing data (feature flags, config, hot metadata).
- **Distributed cache** — Redis/Memcached cluster. Shared by all app servers, so one copy and one invalidation. Costs ~0.5 ms network round trip.
- **Database cache** — buffer pool / page cache. Free and automatic; the reason "does the working set fit in RAM?" is the most important database performance question.

Many high-traffic systems use a **two-tier** cache: a small local cache in front of the distributed cache to absorb the hottest keys and cut network calls. Mentioning this — with the caveat that local tiers make invalidation harder and need short TTLs — is a good depth signal.

## Write strategies

The four patterns. Know the tradeoffs precisely; this is a favorite follow-up.

**Cache-aside (lazy loading)** — the default, and what to name first.

```diagram
  READ:   check cache → hit? return
                      → miss? read DB, write cache, return
  WRITE:  write DB → invalidate (delete) cache key
```

Only requested data is cached; a cache failure degrades to slow rather than broken. The application owns the logic. Downside: every miss costs an extra round trip, and there's a subtle race (below).

**Read-through** — same read behavior, but the cache itself fetches on miss. Cleaner application code, requires cache support or a wrapper library.

**Write-through** — write to cache and DB synchronously.

Cache is never stale, but every write pays both latencies, and you cache data nobody may ever read.

**Write-behind (write-back)** — write to cache, acknowledge, flush to DB asynchronously.

Very fast writes, and it coalesces repeated updates to the same key (excellent for counters). **You can lose data** if the cache dies before flushing. Acceptable for view counts; not for orders.

:::interview Invalidate, don't update
On a write, **delete** the cache key rather than writing the new value into it. Two concurrent updates that each write the cache can land in the opposite order from how they land in the DB, leaving the cache permanently wrong. Deletion is idempotent and self-correcting — the next read repopulates from the source of truth. This is a small detail that signals you've debugged real cache bugs.
:::

### The cache-aside race

Worth knowing because good interviewers ask:

```diagram
  T1: read, cache MISS, reads DB → gets v1
  T2: writes v2 to DB, deletes cache key (no-op, nothing there)
  T1: writes v1 into cache        ← cache now permanently stale
```

Fixes: short TTLs so the damage is time-bounded (usually sufficient and cheap); *delayed double delete* (delete, write, sleep briefly, delete again); or versioned writes that refuse to overwrite a newer value. In practice, **TTL as a safety net is the pragmatic answer** — and saying "every cache entry gets a TTL, because invalidation logic will eventually have a bug" is the kind of realism that scores.

## Eviction policies

When the cache is full, something must go.

- **LRU** — evict least recently used. The sensible default; matches temporal locality. Weakness: a large scan (a batch job reading everything once) flushes your hot set — *cache pollution*.
- **LFU** — evict least frequently used. Resistant to scan pollution; slow to adapt when popularity shifts. Usually implemented with decay (Redis's LFU) to handle aging.
- **FIFO** — evict oldest inserted. Rarely what you want.
- **TTL-based** — evict on expiry regardless of use. Not really an eviction policy but a freshness policy; combine with LRU.
- **Segmented LRU / ARC / W-TinyLFU** — adaptive hybrids that resist pollution while adapting to shifts. W-TinyLFU (used by Caffeine) is what modern in-process caches use.

**Choosing a TTL** is a consistency decision in disguise: TTL is your bound on staleness. Short TTL = fresher data, lower hit rate, more DB load. Long TTL = the opposite. State the tradeoff explicitly when you pick one.

## The three failure modes

This is the section that decides whether the design survives contact with reality. Interviewers love these because each has multiple valid answers.

### 1. Cache stampede (thundering herd)

A popular key expires. A thousand concurrent requests all miss simultaneously and all hit the database for the same value. The database, sized for the cached load, falls over.

**Fixes:**

- **Request coalescing / single-flight** — only the first request per key goes to the origin; others wait for its result. In-process handles per-server; across the fleet you need a short-lived distributed lock (`SET key NX EX 5`) where the winner refills and losers serve stale or retry.
- **Probabilistic early refresh** — as a key nears expiry, each request has a small, rising chance of proactively refreshing it. Refreshes spread out naturally; no lock needed. Elegant and cheap.
- **TTL jitter** — never use a fixed TTL. `ttl = base + random(0, base × 0.1)` prevents keys written together from expiring together.
- **Serve stale while revalidating** — return the expired value immediately and refresh in the background. Best user experience; requires tolerating brief staleness.

### 2. Cache penetration

Requests for keys that **don't exist anywhere**. Every one misses the cache, hits the database, finds nothing, caches nothing — so the cache provides zero protection. Trivially weaponized: an attacker requests random nonexistent user IDs.

**Fixes:**
- **Cache the negative result** with a short TTL (30–60 s). Simple and effective.
- **[Bloom filter](bloom-filters.html)** of all existing keys in front of the cache. A negative answer is definitive, so you can reject without touching the database at all. Costs ~1.2 GB per billion keys at 1% false-positive rate.
- **Input validation** — reject malformed IDs before any lookup.

### 3. Cache avalanche

A large fraction of the cache expires or disappears at once — a mass TTL expiry, or a cache node/cluster failure. The full, uncached load hits the database instantly.

**Fixes:**
- **TTL jitter** again (handles the mass-expiry variant).
- **Replication** so a single node loss doesn't drop its keys.
- **Warm-up on restart** — never bring an empty cache into full traffic. Preload hot keys, or ramp traffic gradually.
- **Circuit breaker in front of the DB** — when the cache is gone, shed load rather than let the database die. Degraded service beats no service.

:::goat The cold-start trap
"If the Redis cluster restarts empty and we send it full production traffic, the database sees 100% of reads and dies — and then it dies *again* every time we try to recover, because the cache is still cold. I'd ramp traffic gradually and pre-warm the top keys from an offline job." Recovery being its own overload event is a genuinely production-flavored observation.
:::

## What not to cache

Volunteering this is a good signal, because it shows you see the cost side:

- **Data that changes on nearly every read** — you pay the cache write and get no hits.
- **Data with no reuse** — per-user, one-time queries. You're just adding a round trip and memory pressure.
- **Anything where staleness is unacceptable** and TTLs can't be short enough — see [consistency models](../01-fundamentals/consistency-models.html).
- **Very large objects** that evict many small hot ones. Watch the ratio of size to hit rate.

## Metrics that matter

- **Hit rate.** The headline number. Below ~80% for a read-heavy workload, ask whether the cache is earning its complexity.
- **Latency p99**, cached vs uncached, so you know what a miss actually costs.
- **Eviction rate.** High evictions mean the cache is undersized — you're paying for a cache that keeps throwing away things you're about to need.
- **Key distribution / hot keys.** A single key taking 30% of traffic can saturate one Redis node regardless of cluster size. Fix by replicating that key across nodes with suffixes, or promoting it to local cache.

:::exercise Size and defend a cache
1. Requests follow a Zipf distribution over 10M keys. Caching the top 1% gives roughly what hit rate? What does going to the top 10% add — and is the extra memory worth it?
2. A 200 ms query at a 92% hit rate: what is the effective average latency? What happens to it at 85%?
3. Your cache cluster restarts empty at peak. Compute the load that arrives at the database, and design the mitigation. What is the name of the failure you are preventing?
4. A single key receives 30% of all traffic. Why does adding cache nodes not help, and what does?
5. Invalidation: you update a row and delete the cache key. Write out the interleaving where a concurrent reader repopulates the cache with the *old* value, and fix it.
:::

:::paper Cache theory and practice
*Web Caching and Zipf-like Distributions: Evidence and Implications* (Breslau et al., INFOCOM 1999) explains why hit rates follow the curve they do and why the tail is expensive.

*Scaling Memcache at Facebook* (Nishtala et al., NSDI 2013) is the best production caching paper written — leases, stale sets, thundering herds, and the regional invalidation problem, all from real incidents. *TAO: Facebook's Distributed Data Store for the Social Graph* (Bronson et al., ATC 2013) covers the read-through variant.
:::
