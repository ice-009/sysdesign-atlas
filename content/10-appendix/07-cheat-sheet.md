---
title: The Cheat Sheet
summary: Every number, comparison table, and decision heuristic worth having in working memory — the page to review the morning of the interview.
difficulty: Easy
scope: HLD
tags: [reference, numbers, cheatsheet]
---

:::predict Guess first
1. Which is faster: one round trip inside a datacenter, or reading 1 MB from memory?
2. 100 million daily users each doing 10 actions — roughly how many queries per second is that?
3. Five services in a chain, each 99.9% available. Is the whole chain still 99.9%?
:::

## Latency numbers

| Operation | Time |
|---|---:|
| L1 cache reference | 1 ns |
| Main memory reference | 100 ns |
| Compress 1 KB | 2 µs |
| Read 1 MB from memory | 10 µs |
| SSD random read | 100 µs |
| Read 1 MB from SSD | 200 µs |
| **Round trip within a datacenter** | **500 µs** |
| Read 1 MB from disk (HDD) | 2 ms |
| Disk seek (HDD) | 5 ms |
| US East ↔ US West RTT | ~60 ms |
| US ↔ Europe RTT | ~100 ms |
| US ↔ Asia RTT | ~180 ms |

**The three derived facts:** memory is ~1,000× faster than SSD; a same-DC round trip costs more than reading 1 MB from memory (so chatty services are expensive); and cross-continent latency is bounded by physics — only moving data closer helps.

## Estimation shortcuts

Two abbreviations used throughout: **QPS** is queries per second, and **DAU** is daily active users.

```diagram
   1 day ≈ 10⁵ seconds        (86,400, round it)
   1 month ≈ 2.6 × 10⁶ s
   1 year ≈ 3 × 10⁷ s

   QPS = DAU × actions_per_day / 10⁵
       → "multiply, then drop five zeros"

   Peak = average × 3          (default; 10× for event spikes)
```

| DAU | Actions/day | Avg QPS |
|---:|---:|---:|
| 1M | 10 | 100 |
| 10M | 10 | 1,000 |
| 100M | 10 | 10,000 |
| 100M | 100 | 100,000 |
| 1B | 10 | 100,000 |

## Object sizes

| Item | Size |
|---|---|
| 64-bit ID / UUID | 8 B / 16 B |
| Short text post | ~300 B |
| Typical DB row | ~1 KB |
| Chat message | ~1 KB |
| Compressed web page | ~50–100 KB |
| Thumbnail | ~10 KB |
| Web-optimized photo | ~200 KB–2 MB |
| 1 min of 1080p video | ~30 MB |
| 1 hour of 1080p video | ~2 GB |

## Single-machine capacities

| Resource | Order of magnitude |
|---|---|
| RAM per server | 64–512 GB |
| SSD throughput | 0.5–2 GB/s |
| Network interface | 10 Gbps ≈ 1.2 GB/s |
| Postgres/MySQL writes | 10–50K/s |
| Redis operations | ~100K/s per core |
| Kafka broker | 100 MB/s – 1 GB/s |
| Web server (JSON) | 5–20K QPS |
| WebSocket connections | ~100K–1M per node |

**Storage multipliers:** ×3 for replication, ×1.3 for index overhead, plus backups.

## Availability

| Nines | Downtime/year | Downtime/month |
|---|---|---|
| 99% | 3.65 days | 7.2 h |
| 99.9% | 8.8 h | 43.8 min |
| 99.99% | 52.6 min | 4.4 min |
| 99.999% | 5.3 min | 26 s |

```diagram
   Serial dependencies MULTIPLY:   0.999⁵ = 99.5%
   Parallel redundancy ADDS nines: 1 − (1−0.99)³ = 99.9999%

   Availability = MTBF / (MTBF + MTTR)
   → halving MTTR is usually far cheaper than halving failures
```

## Decision tables

### Database

| Need | Choose |
|---|---|
| Multi-row ACID transactions | **Relational** (Postgres) |
| Point lookups by key, extreme scale | Key-value (DynamoDB, Redis) |
| Flexible schema, nested documents | Document (MongoDB) |
| Write-heavy, time-ordered, known queries | Wide-column (Cassandra) |
| Multi-hop relationship traversal | Graph (Neo4j) |
| Aggregations over huge scans | Columnar (ClickHouse, BigQuery) |
| Full-text relevance ranking | Search (Elasticsearch) |
| Large binaries | Object storage (S3) + metadata in a DB |

**Default answer: Postgres.** Revisit past ~30K writes/s or when the working set outgrows RAM.

### Caching

**TTL** — time to live — is the expiry stamped on a cache entry. *Jitter* means randomising it slightly per key, so entries written together don't all expire together.

| Problem | Fix |
|---|---|
| Popular key expires, herd hits DB | Request coalescing, probabilistic early refresh, TTL jitter |
| Requests for nonexistent keys | Cache negatives; Bloom filter |
| Mass expiry / cache node loss | TTL jitter, replication, gradual warm-up |
| One key saturates a node | Replicate key with suffixes; local in-process cache |

**Write strategy:** cache-aside by default. On write, **delete** the key rather than updating it. Every entry gets a TTL as a safety net.

### Consistency

| Data | Model |
|---|---|
| Balance before a transfer | Linearizable |
| Seat/ticket assignment | Linearizable |
| Username uniqueness | Linearizable |
| A user's own edits | Read-your-writes |
| Comment threads | Causal |
| Feed timeline | Eventual + monotonic reads |
| Like/view counts | Eventual |
| Search index | Eventual |

**Pick per operation, never per system.**

### Rate limiting

| Need | Algorithm |
|---|---|
| Daily/monthly quota | Fixed window |
| Exact small limits (logins) | Sliding window log |
| General API limiting | **Sliding window counter** |
| Allow bursts, cap average | **Token bucket** |
| Protect a burst-intolerant downstream | Leaky bucket |

### Messaging

| Need | Choose |
|---|---|
| Replay, multiple consumers, high throughput | **Log** (Kafka) |
| Complex routing, priority, per-message TTL | **Broker** (RabbitMQ, SQS) |
| Caller needs the result now | Direct synchronous call |

**Delivery:** at-least-once + idempotent consumers. Exactly-once *delivery* doesn't exist across systems.

### API style

| Consumer | Choose |
|---|---|
| Public / third-party | REST |
| Internal service-to-service | **gRPC** |
| Mobile/rich clients, diverse data needs | GraphQL |

## Sharding

**Choosing a key:** high cardinality · even distribution · present in most queries · keeps co-read data together.

| System | Key |
|---|---|
| Chat | `conversation_id` (**not** user_id) |
| Social posts | `user_id` |
| Orders | `customer_id` |
| Multi-tenant SaaS | `tenant_id` |
| Time series | `(metric_id, time_bucket)` |

**Always pre-split into virtual shards** (e.g. 1,024) so growth is a directory update, not a rehash.

## Resilience checklist

Every remote call needs all four:
1. **Timeout** (with deadline propagation)
2. **Retry** — exponential backoff **+ jitter**, at one layer only, with a budget
3. **Circuit breaker** with a fallback
4. **Idempotency key** for anything that mutates

Plus: bounded queues everywhere, bulkheads per dependency, load shedding by priority, 60–70% target utilization.

## Phrases that score

> "The alternative would be X, but Y decided it."

> "The obvious problem with this is Z — let me handle it."

> "I'd start with the simple version. Here's the threshold at which I'd revisit."

> "I've not operated that myself; my mental model is X, but I'd be guessing past that."

> "That number tells me we need to shard / need a CDN / can stay on one box."

> "Under overload I'd shed low-priority traffic rather than queue everything."

> "This is eventually consistent, which is fine here because — but the user's own writes need read-your-writes."

## The 60-second pre-interview reset

```viz
{
  "type": "steps",
  "caption": "The 60-second reset \u2014 read this on the way into the room.",
  "steps": [
    {
      "label": "Restate & cut scope",
      "sub": "Out loud, and invite redirection."
    },
    {
      "label": "Ask the four questions",
      "sub": "Scale? Read:write ratio? Latency target? Consistency needs?"
    },
    {
      "label": "Estimate what decides something",
      "sub": "End every calculation with its conclusion."
    },
    {
      "label": "API, then data model",
      "sub": "Finish with the partition key and its justification."
    },
    {
      "label": "Draw and narrate",
      "sub": "Label every arrow. Walk one request end to end."
    },
    {
      "label": "Volunteer the flaw",
      "sub": "Then go deep on it before you're pushed."
    },
    {
      "label": "Close deliberately",
      "sub": "Bottleneck at 10\u00d7, failure mode, v1 cut, what you'd monitor."
    }
  ]
}
```

## Check yourself

```recall
Q: Recite the key latency numbers.
A: L1 1 ns, memory 100 ns, 1 MB from memory 10 µs, SSD random read 100 µs, same-datacenter round trip 500 µs, HDD seek 5 ms, US–Europe ~100 ms.

Q: What are the estimation shortcuts?
A: A day ≈ 10⁵ s, a year ≈ 3 × 10⁷ s; QPS = DAU × actions ÷ 10⁵; peak ≈ 3× average (10× for events). 100M DAU × 10 actions ≈ 10,000 QPS.

Q: Give rough single-machine capacities.
A: RAM 64–512 GB, SSD 0.5–2 GB/s, 10 Gbps NIC ≈ 1.2 GB/s, Postgres 10–50K writes/s, Redis ~100K ops/s per core, web server 5–20K QPS, 100K–1M WebSockets per node.

Q: How do availability numbers compose?
A: Serial dependencies multiply (0.999⁵ ≈ 99.5%); parallel redundancy adds nines (1 − 0.01³ = 99.9999%); availability = MTBF ÷ (MTBF + MTTR), so cutting MTTR is usually cheapest.

Q: What is the default database and when do you revisit it?
A: Postgres — revisit past ~30K writes/s or when the working set outgrows RAM. Wide-column for write-heavy time-ordered data, columnar for big scans, object storage for binaries.

Q: What are the cache-problem fixes?
A: Stampede: coalescing, early refresh, TTL jitter. Missing keys: cache negatives or a Bloom filter. Mass expiry: jitter and warm-up. Hot key: replicate with suffixes plus a local cache.

Q: What four things does every remote call need?
A: A timeout with deadline propagation, retries with backoff and jitter at one layer with a budget, a circuit breaker with fallback, and an idempotency key for mutations.

Q: How do you pick a shard key?
A: High cardinality, even distribution, present in most queries, keeps co-read data together — conversation_id for chat, user_id for posts, tenant_id for SaaS — with ~1,024 pre-split virtual shards.
```

## What to carry forward

- Know the latency ladder and the 10⁵-seconds-per-day shortcut.
- Serial dependencies multiply failure; redundancy adds nines.
- Default to Postgres, cache-aside with delete-on-write, consistency chosen per operation.
- Every remote call: timeout, retry with jitter, breaker, idempotency key.
- Use the scoring phrases, and run the 60-second reset before the interview.
