---
title: Design an Ad Click Aggregator
summary: Stream processing at enormous scale with a hard requirement most systems don't have — the numbers are money, so approximate isn't good enough.
difficulty: Hard
scope: HLD
tags: [case-study, streaming, kafka, analytics]
prereqs: [stream-processing, message-queues, olap-columnar]
---

:::interview Why this question
It's the canonical **stream processing** design, and it has a twist that catches people: these numbers are billed to advertisers, so "eventually roughly right" is not acceptable. It forces you to reconcile a low-latency approximate path with an exact one — and to handle late-arriving and duplicate events properly.
:::

## 1. Requirements

**Functional**
- Ingest click and impression events from ad serving.
- Advertisers see near-real-time metrics (clicks, impressions, spend) by campaign, time, and dimensions like geography and device.
- Support arbitrary time-range queries and drill-down.
- Detect and exclude fraudulent clicks.

**Non-functional**
- **Correctness matters** — these numbers drive billing.
- Dashboard latency: metrics visible within ~1 minute.
- Query latency: sub-second for dashboards.
- Handle late and out-of-order events (mobile devices go offline and upload later).
- No event loss.

**Clarifying questions:** How fresh must the dashboard be — seconds or minutes? Is the same pipeline used for billing? What's the acceptable window for late events? Do we need per-user uniqueness (unique reach), which is much harder than counting?

## 2. Estimation

**10B clicks/day**, 100B impressions/day.

```diagram
   Clicks:      10¹⁰ / 10⁵ s  = 100,000/s avg → 300,000 peak
   Impressions: 10¹¹ / 10⁵ s  = 1,000,000/s avg → 3,000,000 peak

   Event size: ad_id 8 + campaign 8 + user 8 + ts 8 + geo 4
               + device 4 + cost 8 + ~50 B context ≈ 100 B

   Raw ingest: 1.1M events/s × 100 B = 110 MB/s
               ≈ 9.5 TB/day raw

   Kafka retention (7 days): ~67 TB   ← affordable, and it's
                                        your replay safety net

   AGGREGATED output (the point of the system):
     1M campaigns × 24 hourly buckets × 10 dimensions
     ≈ 240M rows/day × 100 B = 24 GB/day
     → 400× reduction. This is what makes queries fast.
```

**What this decided:** 1.1M events/s means the ingest layer must be a partitioned log, not a database. The 400× reduction from aggregation is *why* the architecture exists — you never query raw events for a dashboard.

## 3. High-level design

```diagram
   ad servers ──► ┌──────────────┐
   (global)       │  Ingest API  │ validate, enrich, dedupe-tag
                  └──────┬───────┘
                         ▼
              ┌──────────────────────┐
              │  KAFKA (partitioned  │  7-day retention
              │  by campaign_id)     │  ← the buffer AND
              └──────┬───────────────┘     the replay log
                     │
        ┌────────────┴────────────────┐
        ▼                             ▼
   ┌──────────────┐            ┌──────────────┐
   │ SPEED layer  │            │ BATCH layer  │
   │ Flink        │            │ hourly/daily │
   │ windowed agg │            │ exact recompute
   │ → ~1 min     │            │ from raw     │
   └──────┬───────┘            └──────┬───────┘
          ▼                           ▼
   ┌──────────────┐            ┌──────────────┐
   │ Real-time    │            │ Warehouse    │
   │ OLAP store   │            │ (exact,      │
   │ (approximate,│            │  billing)    │
   │  fast)       │            └──────────────┘
   └──────┬───────┘                   │
          └─────────┬─────────────────┘
                    ▼
             ┌──────────────┐
             │  Query API   │ recent → speed layer
             │              │ historical → batch layer
             └──────────────┘
```

**Partition Kafka by `campaign_id`.** All events for one campaign land on one partition, so aggregation per campaign is local — no cross-partition coordination. The cost is a hot partition risk for a very large advertiser, mitigated by sub-partitioning `campaign_id:bucket`.

## 4. Deep dive — why two layers

This is the central design decision, and the reasoning matters more than the diagram.

```diagram
   SPEED LAYER          fast, approximate, may double-count
                        under failure. Powers the dashboard.

   BATCH LAYER          slow (hourly), exact, deduplicated,
                        reprocessible. Powers BILLING.
```

**Why not just the speed layer?** Stream processing under failure gives at-least-once semantics. A worker crash and restart can re-emit counts. For a dashboard, a 0.1% error is invisible. For an invoice, it's a dispute and potentially a legal problem.

**Why not just the batch layer?** Advertisers need to see whether a campaign is working *now*, not an hour from now. A campaign burning budget on a broken creative needs to be caught in minutes.

:::goat The framing that scores
"I'd serve the dashboard from a streaming aggregation with about a minute of latency, and compute billing numbers from a batch recomputation over the raw event log. They'll disagree slightly, and that's fine as long as it's *stated* — the dashboard says 'preliminary', and the batch numbers are authoritative. What I won't do is bill from the streaming path, because at-least-once processing means I can't guarantee I haven't counted a click twice, and that's the one error this system can't afford."

Running a fast approximate path alongside a slow exact one over the same data has a name — **lambda architecture** — and naming its cost shows you know the tradeoff rather than just the pattern: the same counting logic now exists in two codebases, and they can drift apart.
:::

The modern alternative worth mentioning: **kappa architecture** — keep only the streaming path, and when the logic changes, replay the retained event log through the new version rather than maintaining a separate batch implementation. Simpler to maintain, and viable here because Kafka already holds 7 days of raw events. The catch is that exact deduplication still requires stateful processing over a long window.

## 5. Deep dive — exactly-once and deduplication

The hard correctness problem.

**Sources of duplicates:**
1. The ad server retries a failed ingest call.
2. The client fires the same click event twice (double-tap, retry).
3. A stream processor reprocesses after failure.

**Layered defense:**

```diagram
   1. EVENT ID at the source. The ad server generates a UUID
      per impression/click. Duplicates share the ID.

   2. INGEST DEDUP: check the ID against a short-window store
      (Redis, 24h TTL) or a Bloom filter in front of it.
      Catches network-level retries cheaply.

   3. STREAM DEDUP: Flink keyed state per (campaign, event_id)
      within the watermark window. Exactly-once *within* the
      streaming pipeline via checkpointing.

   4. BATCH DEDUP: the authoritative pass. Deduplicate on
      event_id across the full raw dataset. Slow, exact.
```

Note that layer 4 is the one that makes billing correct. Layers 1–3 make the streaming numbers *close*.

**Fraud filtering** is a related but separate concern: bot traffic, click farms, and repeated clicks from one user must be excluded before billing. Run it as a stage in the batch layer (where you can afford to be expensive and look at wider context), with a cheap heuristic filter in the stream layer. Advertisers are billed on *valid* clicks, and this distinction is worth naming.

## 6. Deep dive — windowing and late events

Events arrive out of order. A mobile device offline for 3 hours uploads its events afterwards. Which time bucket do they belong to?

```diagram
   EVENT TIME  — when the click actually happened  ← use this
   PROCESSING TIME — when your system saw it       ← not this
```

**Always aggregate by event time**, or your hourly numbers shift depending on network conditions, and reprocessing produces different results than the original run.

**Watermarks** handle the "how long do I wait?" question:

```diagram
   A watermark asserts: "I believe I've seen all events with
   event_time <= T."

   Window [10:00-11:00) closes when the watermark passes 11:00
   (plus an allowed lateness, say 10 minutes).

   Events arriving after that are LATE:
     - within allowed lateness → update the window, re-emit
     - beyond it → route to a side output for the batch layer
```

**The tradeoff to state:** longer allowed lateness means more complete results and higher latency plus more state held in memory. Shorter means faster dashboards and more corrections later. A common answer: ~10 minutes of lateness in the stream, with the batch layer catching everything within 24 hours.

**Never drop late events silently.** Route them somewhere. The batch layer will pick them up, and silently discarding billable events is the failure mode nobody notices until an advertiser audits you.

## 7. The serving layer

```diagram
   Pre-aggregate at multiple granularities:
     minute → hour → day → month

   Dashboards query the coarsest granularity that answers
   the question. "Last 30 days" reads 30 daily rows,
   not 43 million minute rows.
```

Use a real-time OLAP store (Druid, Pinot, ClickHouse): they ingest directly from Kafka, pre-aggregate on write, and serve sub-second aggregate queries. This is exactly the workload they exist for.

**Dimensions are the cost driver.** Supporting drill-down by campaign × geo × device × creative × hour multiplies row counts combinatorially. Pre-aggregate the *common* combinations; compute rare ones on demand from a finer granularity. Naming the cardinality explosion is a good depth signal, because it's the thing that makes these systems expensive.

**Approximate where it's safe:** [HyperLogLog](../02-building-blocks/bloom-filters.html) for unique reach (counting distinct users exactly requires storing every user ID per campaign — enormous), and it's mergeable so you can union sketches across time buckets for free. But use exact counts for clicks and spend, because those are billed.

## 8. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| Ingest API down | Ad servers buffer locally and retry. Some loss if the outage is long — hence local buffering with generous capacity. |
| Kafka partition unavailable | Producers retry; ingest blocks for that partition. Replication (RF=3) makes this rare. |
| Flink job crashes | Restarts from the last checkpoint and reprocesses. May emit duplicates downstream — which is exactly why billing doesn't come from here. |
| OLAP store down | Dashboards fail; **ingestion continues** into Kafka. Recovery replays from the log. Decoupling ingest from serving is what makes this survivable. |
| Batch job fails | Rerun it. Kafka retention is the safety net, which is why 7 days rather than 1. |
| Sudden traffic spike | Kafka absorbs it as a deeper queue; consumers lag and catch up. This is the buffering benefit of a log, and worth stating. |

**Follow-ups:**
- *"How do you handle a hot campaign?"* — sub-partition the key (`campaign:0`…`campaign:9`) and sum on read. Same fix as any [hot shard](../02-building-blocks/sharding.html).
- *"Reduce cost?"* — sample impressions (they're 10× clicks and less valuable individually), but **never sample clicks**, since those are billed. Choosing what to approximate by business value is the right instinct.
- *"Budget enforcement — stop a campaign at its cap?"* — this needs low latency and can't wait for batch. Maintain a fast decrementing counter in the serving path with a conservative buffer, then reconcile exactly in batch. Slight overspend is usually absorbed rather than risking underspend.
- *"Multi-region?"* — aggregate locally per region, then merge. Sums and counts are commutative and associative, so regional pre-aggregation is safe — a nice property to point out.
