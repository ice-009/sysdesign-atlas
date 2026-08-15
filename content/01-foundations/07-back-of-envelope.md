---
title: Back-of-the-Envelope Estimation
summary: The numbers to memorize, a repeatable four-step method, and worked examples — plus the crucial judgment of which estimates actually change a decision.
difficulty: Medium
scope: Core
tags: [estimation, capacity, math]
prereqs: [latency-throughput, hardware-numbers]
---

## The point of estimation

Not precision. **Estimation exists to make architectural decisions.**

If your calculation says 500 GB of data, that's one database. If it says 500 TB, that's a sharded cluster with a completely different design. The estimate is only worth doing when it flips a decision: size the storage because it determines whether you shard; skip precise CPU numbers because they don't change the architecture.

:::trap Estimation theater
The failure mode is spending eight minutes computing memory bandwidth to three significant figures, then never referencing the number again. That's pure clock burn and it reads as poor prioritization. Estimate what you'll *use*. State that's what you're doing.
:::

## Numbers to memorize

**Time:**
- 1 day = 86,400 s ≈ **10⁵ s** (this rounding is the single most useful trick here)
- 1 month ≈ 2.6M s · 1 year ≈ 31.5M s ≈ **3 × 10⁷ s**

**The powers of two:**

| Power | Approx | Name | Bytes |
|---|---|---|---|
| 2¹⁰ | 10³ | thousand | 1 KB |
| 2²⁰ | 10⁶ | million | 1 MB |
| 2³⁰ | 10⁹ | billion | 1 GB |
| 2⁴⁰ | 10¹² | trillion | 1 TB |
| 2⁵⁰ | 10¹⁵ | quadrillion | 1 PB |

**Typical object sizes:**

| Thing | Size |
|---|---|
| UUID / 64-bit ID | 16 B / 8 B |
| Timestamp | 8 B |
| Tweet-sized text (280 chars) | ~300 B |
| A typical database row w/ metadata | ~1 KB |
| Chat message | ~1 KB |
| Compressed HTML page | ~50–100 KB |
| Thumbnail | ~10 KB |
| Photo (web-optimized) | ~200 KB – 2 MB |
| 1 min of 1080p video | ~30 MB |
| 1 hour of 1080p video | ~2 GB |

**Machine capacities.** These are for one ordinary rented server — "commodity" meaning nothing special, the kind you get by the hour — and they're order-of-magnitude figures:

| Resource | Capacity |
|---|---|
| RAM | 64–512 GB |
| SSD throughput | ~500 MB/s – 2 GB/s |
| Network interface | 10 Gbps ≈ 1.2 GB/s |
| Postgres/MySQL writes | ~10–50K/s (tuned, simple rows) |
| Redis ops | ~100K/s per core, single-threaded |
| Kafka broker | ~100 MB/s – 1 GB/s |
| Web server (simple JSON) | ~5–20K QPS |

## The four-step method

**1. Traffic.** Start from **DAU** — daily active users, how many distinct people use the product in a day — multiply by how often each one acts, and divide by the seconds in a day to get **QPS**, queries per second.

```diagram
     QPS_avg  =  DAU × actions_per_user / 86,400
     QPS_peak =  QPS_avg × peak_factor        (use 2-3×; 10× for
                                               events/flash sales)
```

**2. Storage.** QPS_write × bytes_per_item × seconds — then multiply by replication factor and add index overhead.

```diagram
     storage/day   = writes/day × bytes_per_write
     storage/5yr   = storage/day × 365 × 5
     actual disk   = storage × replication (×3) × index overhead (~1.3)
```

**3. Bandwidth.** QPS × payload size, in and out separately. Egress usually dominates and it's the one you pay for.

**4. Memory (cache).** Apply the 80/20 rule: cache the 20% of data serving 80% of reads. Compare to per-machine RAM to get node count.

## Worked example — a photo sharing service

**Given:** 500M DAU. Each user views 50 photos/day, uploads 0.2 photos/day. Average photo 1.5 MB, plus three generated thumbnails totalling ~100 KB.

**Traffic:**

```diagram
  Reads:   500M × 50            = 25 × 10⁹ views/day
           25 × 10⁹ / 10⁵       = 250,000 QPS average
           peak ×3              ≈ 750,000 QPS

  Writes:  500M × 0.2           = 100 × 10⁶ uploads/day
           100 × 10⁶ / 10⁵      = 1,000 QPS average
           peak ×3              ≈ 3,000 QPS
```

**Read:write ratio = 250:1.** That single number is the most important output of the whole exercise — it says: aggressively cacheable, CDN-first, read replicas, and the write path can afford to be slow and do heavy processing.

**Storage:**

```diagram
  Per upload:  1.5 MB + 0.1 MB thumbnails  = 1.6 MB
  Per day:     100M × 1.6 MB               = 160 TB/day
  Per year:    160 TB × 365                ≈ 58 PB/year
  With 3× replication                      ≈ 175 PB/year
```

**Decision:** 160 TB/day rules out any database-resident blob storage instantly. This goes to object storage (S3-class) with only metadata in a database. That's the architectural fork the number bought us.

**Metadata storage** (the part in a real database):

```diagram
  Row: photo_id 8 + user_id 8 + s3_key 100 + caption 200
       + timestamp 8 + counters 24  ≈ 350 B, round to 500 B
  Per day:  100M × 500 B  = 50 GB/day
  Per year: ≈ 18 TB/year
```

**Decision:** 18 TB/year of metadata is too much for one node over five years, so we shard on `user_id`. But it's small enough that the sharding is routine — no exotic solution needed.

**Bandwidth:**

```diagram
  Egress: 750,000 QPS peak × 200 KB (served size) = 150 GB/s
  Ingress: 3,000 QPS × 1.6 MB                     = 4.8 GB/s
```

**Decision:** 150 GB/s egress is ~1.2 Tbps. No origin fleet serves that economically — this *must* be CDN-served, and the CDN hit rate becomes a primary design metric rather than an optimization.

**Cache sizing:**

```diagram
  Assume 20% of photos drive 80% of views, over a 30-day window:
  Photos in 30 days:  100M × 30      = 3 × 10⁹
  Hot 20%:            600M photos
  At 200 KB served:   600M × 200 KB  = 120 TB

  → too large for RAM. Two tiers: CDN edge (disk) holds the
    120 TB; app-tier Redis caches only metadata:
    600M × 500 B = 300 GB → ~6 nodes at 64 GB. Feasible.
```

:::math The whole point
Four calculations produced four architectural decisions: **object storage not DB blobs**, **shard metadata on user_id**, **CDN is mandatory not optional**, and **cache metadata in RAM, media at the edge.** None of that needed precision — an answer 40% off gives the same conclusions.
:::

## Estimating QPS from DAU quickly

The reusable shortcut, since `86,400 ≈ 10⁵`:

| DAU | Actions/user/day | Average QPS |
|---:|---:|---:|
| 1M | 10 | 100 |
| 10M | 10 | 1,000 |
| 100M | 10 | 10,000 |
| 100M | 100 | 100,000 |
| 1B | 10 | 100,000 |

So: **DAU × actions, drop five zeros.** 500M DAU × 50 actions = 25 × 10⁹ → drop five zeros → 250K QPS. You can do this in your head mid-sentence, which is the actual skill.

## Peak factors, chosen with judgment

- **2×** — globally distributed usage, smooth (a worldwide messaging app).
- **3×** — the safe default. Single-region-ish product with a daily peak.
- **5–10×** — strong daily concentration (food delivery at dinner; a work tool at 9am local).
- **50–1000×** — event-driven spikes: ticket sales for a major tour, a flash sale, a live sports finale. These need dedicated design (queues, virtual waiting rooms, precomputed inventory), and saying so is a strong signal.

## Things people get wrong

- **Forgetting replication.** Disk needs are 3× your logical data in most designs. And backups aren't free either.
- **Forgetting index overhead.** Indexes commonly add 20–50% on top of table size, and they're the part that must stay in RAM to be fast.
- **Sizing for average, not peak.** Averages don't page you at 3am.
- **Using exact numbers.** 86,400 is worse than 10⁵ here. Round early, round hard, and *say* you're rounding — precision that isn't used is a tell that you don't know which numbers matter.
- **Not stating assumptions.** State the assumption before the arithmetic — "assuming 500M DAU and a 100:1 read/write ratio" — so that a disagreement lands on the input rather than invalidating everything downstream of it.

## The 60-second version

When time is tight, this is the whole thing:

1. **DAU × actions ÷ 10⁵ = average QPS.** Multiply by 3 for peak.
2. **Writes/day × bytes = storage/day.** Multiply by 365 × years × 3 for replication.
3. **Peak read QPS × response size = egress bandwidth.**
4. **State the read:write ratio.** Then say what each number changed.

That fourth step is the one that scores.

:::exercise Five estimates, no calculator
Round aggressively, state your assumptions, and end each with the decision it informs.

1. A photo app has 20M daily actives, each uploading 2 photos averaging 3 MB. Daily storage? Five-year storage with 3× replication?
2. A chat app with 50M DAU, 40 messages each. Peak QPS assuming peak is 3× average and traffic concentrates in 8 hours?
3. 100,000 concurrent viewers of a 1080p stream at 5 Mbps. Egress bandwidth? What does that cost per month at typical CDN rates?
4. A URL shortener needs 100 billion unique codes. How many characters in base62? How much storage for the mapping table?
5. A feed ranks 500 candidates per request at 1 ms each, at 10,000 req/s. How many cores? Does that number change your design?
:::

:::paper Estimation as a discipline
Enrico Fermi's estimation problems are the origin of the genre; Sanjoy Mahajan's *Street-Fighting Mathematics* (MIT Press, free online) is the best modern treatment of approximation as a skill.

For the specific numbers, Jeff Dean's "Latency Numbers Every Programmer Should Know" and Colin Scott's interactive version tracking hardware drift.
:::
