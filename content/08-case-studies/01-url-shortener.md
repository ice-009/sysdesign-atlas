---
title: Design a URL Shortener
summary: The classic opener. Deceptively simple, and a precise test of whether you scope, estimate, and pick an ID strategy for stated reasons.
difficulty: Easy
scope: HLD
tags: [case-study, ids, cache, read-heavy]
prereqs: [back-of-envelope, caching, unique-id-generation]
---

:::predict Guess first
1. 100 million new links a day, each read 100 times. Roughly how many redirects per second is that at peak?
2. Would you send a permanent (301) or temporary (302) redirect? What does each cost you?
3. If short codes come from a simple counter, what could an outsider do with them?
:::

:::interview Why this question
It's often the warm-up, and it's a filter. The design is easy; what's scored is whether you *drive*. Candidates who spend 30 minutes here have failed to recognize a simple problem. Aim to have a working design in 10 minutes, then go deep on one thing — ID generation or the read path.
:::

## 1. Requirements

**Functional**
- Given a long URL, return a short one.
- Visiting the short URL redirects to the original.
- Optional: custom aliases, expiration, click analytics.

**Non-functional**
- Read-heavy — redirects vastly outnumber creations.
- Redirect latency must be low (it's in the user's critical path, before the real page even starts loading).
- High availability — a dead shortener breaks every link ever shared.
- Short codes must not be predictable enough to enumerate.

**Explicitly out of scope** (say this): user accounts, spam/malware scanning, an analytics dashboard. Name them explicitly, so the boundaries of the design are on the record.

**Clarifying questions worth asking:**
- Traffic volume, and the read/write ratio?
- How long must links live? Forever, or can they expire?
- Custom aliases needed?
- Is analytics required, and does it need to be real-time?

## 2. Estimation

Assume **100M new URLs/day**, read:write of **100:1**, 5-year retention.

```diagram
   Writes:  100M / 10⁵ s      = 1,000 QPS avg  → ~3,000 peak
   Reads:   1,000 × 100       = 100,000 QPS avg → ~300,000 peak

   Storage per record:
     short_code  7 B    long_url   ~200 B (cap at 2048)
     created_at  8 B    user_id      8 B    → ~250 B, round to 500 B

   Per day:   100M × 500 B     = 50 GB/day
   5 years:   50 GB × 365 × 5  ≈ 91 TB
   With replication (×3)        ≈ 275 TB

   Keyspace: 62⁷ = 3.5 × 10¹²  → 100M/day for ~95 years ✓
```

**What the numbers decided:**
- 91 TB rules out a single node → **sharded store**.
- 300K read QPS at ~500 B → tiny payloads, extremely cacheable → **cache tier is the primary read path**.
- 62⁷ confirms **7 characters** is enough; no need for 8.

## 3. API

```diagram
   POST /api/v1/urls
     { "long_url": "...", "custom_alias": null, "expires_at": null }
     → 201 { "short_url": "https://sho.rt/aB3xK9p" }

   GET /{short_code}
     → 302 Found, Location: <long_url>
```

:::goat 301 vs 302 — a real tradeoff
A redirect is an HTTP response that says "what you want is over there". Which *kind* you send matters more than it looks.

**301 Permanent**: browsers cache it, so subsequent visits never reach your servers. Great for load (potentially removing most of your traffic), terrible if you need analytics or ever want to change the target — and the cached redirect is effectively unrevocable.

**302 Found**: every visit hits you. Costs traffic, preserves analytics and control.

"I'd use 302 because click analytics is a core feature and I want to be able to disable malicious links after the fact. If analytics weren't needed, 301 would remove most of my read traffic — a genuinely large saving." Naming this tradeoff unprompted is one of the highest-value things you can say in this question.
:::

## 4. Data model

```diagram
   urls
   ├── short_code   VARCHAR(7)  PRIMARY KEY
   ├── long_url     TEXT
   ├── user_id      BIGINT
   ├── created_at   TIMESTAMP
   └── expires_at   TIMESTAMP NULL
```

A single-table key-value access pattern — `short_code` is the only lookup key. That's a strong argument for a **key-value store** (DynamoDB, Cassandra) over a relational database: no joins, no range scans, perfect partitioning on the primary key.

Shard on `short_code` by hash. It's high-cardinality, uniformly distributed by construction (the codes are essentially random), and present in every read.

## 5. ID generation — the actual interesting part

Four approaches. **Compare them; don't just pick one.**

First, the encoding everything below uses: **base62** just means writing a number using all ten digits plus both cases of the alphabet — 62 symbols instead of 10 — so a big number becomes a short string like `bQ7kx2M`.

**A. Hash and truncate.** Run the URL through a hash function, encode the result in base62, keep 7 characters.
*Problem:* two different URLs producing the same short code (a **collision**) becomes likely far sooner than the size of the keyspace suggests — the same counter-intuitive maths as the birthday paradox, where 23 people already give even odds of a shared birthday. You need a read-before-write on every insert, and a retry loop. Also makes identical URLs collide deliberately, which may or may not be wanted.

**B. Counter + base62.** A global counter, base62-encoded.
*Problems:* sequential codes are enumerable (anyone can walk `aaaaaab`, `aaaaaac` and read every link ever created — a genuine privacy leak), and a single counter is a coordination bottleneck.

**C. Counter with range allocation (recommended).** A coordination service hands out **blocks** (e.g. "you own 1,000,000–1,999,999"). Each application server allocates locally with zero coordination and requests a new block when low.

Then fix the guessability: don't turn the counter straight into a code. **Scramble it first** with a cipher that maps each number in the range to exactly one other number in the same range. Because that mapping is one-to-one, two counters can never produce the same code — collisions are impossible by construction, with no check needed before writing — yet consecutive counters produce codes that look nothing alike.

```diagram
   counter 1,000,001 ──► FPE(key, n) ──► 2,847,193,554 ──► "bQ7kx2M"
                          bijective         base62
   ✓ no collisions ever   ✓ not enumerable   ✓ no coordination per write
```

**D. Pre-generated key pool.** A background job generates random unused codes into a "available" table; servers claim batches. Simple, unguessable, and needs a generator plus a claim protocol.

:::interview How to present this
"The naive answer is hashing, but truncation makes collisions likely well before the keyspace is exhausted, so every write needs a check-and-retry. A counter avoids collisions entirely but is enumerable and needs coordination. I'd use range-allocated counters — so each server allocates locally — and pass the counter through a format-preserving encryption before base62-encoding it. That keeps the bijection, so collisions are impossible by construction, while making codes unguessable."

That's a complete answer with two alternatives rejected for stated reasons — exactly the [tradeoff structure](../10-appendix/what-interviewers-score.html) being scored.
:::

## 6. High-level design

```diagram
                        ┌──────────┐
     create ───────────►│          │──► ID service (block allocation)
                        │  Write   │
                        │  Service │──► DB (sharded KV)
                        └──────────┘

                   ┌─────┐    ┌───────┐    ┌──────────┐
   redirect ──────►│ CDN │───►│  LB   │───►│  Read    │
                   └─────┘    └───────┘    │  Service │
                                            └────┬─────┘
                                    ┌────────────┴────────────┐
                                    ▼                         ▼
                              ┌──────────┐            ┌──────────────┐
                              │  Redis   │ miss ────► │ DB (sharded) │
                              │  cache   │ ◄───fill── └──────────────┘
                              └──────────┘
                                    │
                                    └──► Kafka ──► analytics pipeline
                                         (async, off the redirect path)
```

**Redirect path, narrated:** request hits the LB → read service → Redis lookup by `short_code` → hit (~99%) returns 302 immediately, ~1 ms → miss falls through to the sharded database, populates the cache, returns. A click event is published asynchronously to Kafka; **analytics never blocks the redirect.**

## 7. Deep dives

### The cache is the system

At 300K peak QPS with a 500-byte value, the hot working set is tiny.

```diagram
   Hot set: say 20% of the last 30 days of links
   30 days × 100M = 3 × 10⁹ links; 20% = 600M
   600M × 250 B ≈ 150 GB → ~5 Redis nodes at 32 GB

   At a 99% hit rate the DB sees 3,000 QPS instead of 300,000.
```

Use **LRU** with a long TTL. Access is heavily skewed — a link shared on a popular account gets millions of hits in an hour, then nothing. That's ideal cache behaviour.

**Guard the failure modes** ([caching](../02-building-blocks/caching.html)): TTL jitter to prevent avalanche; **cache negative lookups** briefly, because random 7-character probes are the obvious attack and each one would otherwise be a database query ([cache penetration](../02-building-blocks/bloom-filters.html)); and a circuit breaker so a cold cache can't take the database down.

### Scaling reads further

Put a **CDN** in front. A 302 with a short `Cache-Control` (say 60 s) lets the edge serve repeat hits on viral links entirely — the single biggest lever if a link goes viral, since one link can be 30% of your total traffic.

The tension: caching the redirect at the edge costs you per-click analytics precision for those requests. Resolve it by accepting sampled analytics for hot links, or by having the edge log asynchronously.

### Custom aliases

Must be globally unique, so this *does* need a uniqueness check — but the check is a single-shard insert with a **unique constraint**, not a lock. Let the insert fail and return 409. Reserve a blocklist (`api`, `admin`, `login`) and validate the character set.

### Expiration and deletion

A `expires_at` column plus lazy deletion: check on read, and run a background job to reclaim. Don't scan the whole table — index on `expires_at` or partition by expiry month so cleanup is a partition drop.

### Analytics

Never write to a counter on the redirect path — a viral link would create a single hot row taking 50K writes/s. Instead: publish click events to Kafka, aggregate in a stream processor, and store rollups in a [columnar store](../04-data/olap-columnar.html). Approximate uniques via [HyperLogLog](../02-building-blocks/bloom-filters.html).

## 8. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| Cache node dies | Consistent hashing limits loss to 1/N of keys; those fall through to the DB. Circuit breaker if the DB saturates. |
| DB shard dies | Replica promoted; that shard's links are briefly unavailable — bounded blast radius, not total outage. |
| ID service down | Servers keep allocating from their current block. Only blocks the *creation* path once exhausted, and never blocks redirects. |
| Kafka down | Analytics events dropped or buffered locally. Redirects unaffected — the whole point of keeping it async. |

**Common follow-ups and the one-line answers:**

- *"How do you handle a viral link?"* — it's a cache hit by definition, and the CDN absorbs it. Hot-key risk is on the cache node; replicate that key or promote to local cache.
- *"How do you stop malicious URLs?"* — asynchronous scanning against a reputation service, plus the ability to disable a code (which is why 302 over 301 matters).
- *"Multi-region?"* — links are immutable once created, so replicate the table asynchronously everywhere and serve reads locally. Creation can route to a home region. Immutability makes this one of the easiest systems to distribute globally — worth pointing out.
- *"Can you make it cheaper?"* — 301 redirects push traffic to browsers entirely, at the cost of analytics and revocability.

## Check yourself

```recall
Q: What do the URL shortener's numbers decide?
A: 91 TB over five years rules out one node, so shard; 300,000 tiny reads a second makes the cache the primary read path; 62⁷ ≈ 3.5 trillion shows seven characters is enough.

Q: 301 versus 302 for a shortener?
A: 301 is cached by browsers — it removes most traffic but loses analytics and can't be revoked. 302 sends every visit to you, keeping analytics and the ability to disable bad links.

Q: Why is hash-and-truncate a weak ID strategy?
A: Truncated hashes collide far sooner than the keyspace suggests (the birthday paradox), forcing a read-before-write and retries on every insert.

Q: What ID strategy is recommended, and why?
A: Range-allocated counters (each server owns a block, no per-write coordination) passed through format-preserving encryption before base62. The bijection makes collisions impossible while codes look random.

Q: Why use a key-value store sharded by hash of short_code?
A: The only lookup is by code: no joins or range scans, codes are high-cardinality and uniform, and the key is in every read.

Q: Name the cache's three guards.
A: TTL jitter against avalanche, briefly caching negative lookups against random-probe penetration, and a circuit breaker so a cold cache can't flatten the database.

Q: Why never count clicks on the redirect path?
A: A viral link would make one hot row take tens of thousands of writes a second. Publish click events to Kafka, aggregate in a stream processor, store rollups; use HyperLogLog for uniques.

Q: Why is a shortener easy to run in many regions?
A: Links are immutable once created, so the table can replicate asynchronously everywhere and serve reads locally; creation can route to a home region.
```

## What to carry forward

- Drive the easy question: a working design in ten minutes, then go deep on IDs or the read path.
- The numbers decide: shard for storage, cache for reads, seven characters for the keyspace.
- Range-allocated counters plus format-preserving encryption: no collisions, no enumeration, no coordination.
- 302 keeps analytics and revocability; 301 trades them for load.
- Keep analytics asynchronous and off the redirect path.
