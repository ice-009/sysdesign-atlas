---
title: Design a Metrics & Monitoring System
summary: Millions of numbers a second from every server, stored cheaply enough to keep, queried fast enough for a live dashboard, and watched by alert rules — with the time-series storage tricks and the cardinality trap that decide whether it survives.
difficulty: Hard
scope: HLD
tags: [case-study, time-series, storage, observability]
prereqs: [consistent-hashing, wal-and-durability, olap-columnar]
---

:::predict Guess first
1. Each sample is a timestamp plus a value — 16 bytes. Could you store it in under 2 bytes?
2. A team adds user_id as a label on a request metric. What happens to the number of stored series?
3. A dashboard shows a year of latency using hourly averages. Could a five-second spike to 5,000 ms disappear?
:::

:::interview Why this question
It's a write-heavy system with an unusual data shape — numbers over time, labelled — and the generic answer ("put it in a database") fails on cost long before it fails on speed. It tests whether you can see that the data's shape suggests its own storage engine, and whether you know the one mistake that kills real monitoring systems: labels with too many values.
:::

## 1. Requirements

**Functional**
- Collect metrics from every service and host: request counts, latencies, CPU, queue depths.
- Store them with labels — `http_requests_total{service="checkout", region="eu", status="500"}`.
- Query for dashboards: "error rate of checkout, per region, last 6 hours", refreshed every few seconds.
- Evaluate alert rules continuously against the data (the rules and notifications are designed in [Alerting System](../11-lld/alerting-system.html)).
- Keep raw data 15 days; keep coarser summaries for a year.

**Non-functional**
- **Writes dominate.** Every service reports every 10 seconds, forever. Queries are comparatively rare.
- **Recent data must be fast** — a dashboard over the last hour should load in under a second.
- **Cheap per data point**, or the bill for storing it outgrows the systems being monitored.
- **Keeps working when things are on fire** — the monitoring system is most needed exactly when everything else is failing.

**Clarifying questions:** How many hosts and services? How often is each measured — every 10 s, every minute? Do services send data to us, or do we fetch it? How long must data be kept, and at what detail?

## 2. Estimation

**100,000 hosts, ~500 time series each, measured every 10 seconds.**

```diagram
   Active series:  100,000 × 500                       = 50M series
   Samples/sec:    50M / 10 s                          = 5M samples/s

   A sample is (timestamp, value) = 8 + 8               = 16 bytes raw
   Compressed (section 5):                              ~1.5 bytes/sample

   Per day:  5M/s × 86,400 s = 432 billion samples
             × 1.5 B                                    ≈ 650 GB/day compressed
             (raw, uncompressed, it would be ~7 TB/day)
   15 days of raw data                                  ≈ 10 TB

   1 year at 5-minute summaries:
     50M series × 288 points/day × 365 × ~6 B           ≈ 30 TB
```

**What this decided:** ten times compression is the difference between 10 TB and 100 TB for two weeks of data, so storage format is the main design problem — not query speed, not networking. And 5M writes a second is far beyond a normal database inserting one row per sample.

## 3. The data model

Every metric is a **series**: a name plus a set of labels, with a stream of (time, value) pairs.

```diagram
   series:  http_requests_total{service="checkout", region="eu", status="500"}
   samples: (10:00:00, 1042) (10:00:10, 1049) (10:00:20, 1063) ...

   Three kinds of metric:
     counter    only goes up (requests served).   You query its RATE, not its value.
     gauge      goes up and down (memory in use, queue depth).
     histogram  counts per bucket (≤ 10 ms, ≤ 50 ms, ≤ 250 ms …) → percentiles
```

Each distinct combination of labels is a separate series. That's the root of the biggest operational danger in this whole design:

:::goat The cardinality trap
*Cardinality* is the number of distinct series. Labels multiply it. `service` × `region` × `status` might be 50 × 5 × 10 = 2,500 series — fine. Add `user_id` as a label and you have one series per user: tens of millions of new series, each with its own index entry and memory, and the system falls over.

**Say this:** *"Labels must have a small, bounded set of values — service, region, status code, endpoint. Never user IDs, request IDs or email addresses; those belong in logs or traces. I'd enforce a per-team limit on active series and reject new ones beyond it, because one bad deploy adding a high-cardinality label can take down monitoring for everyone."*

This is the failure real monitoring teams spend most of their time preventing. Naming it unprompted is a strong signal.
:::

## 4. High-level design

```diagram
   WRITE PATH
   each service's /metrics ◀── scrape every 10 s ── collectors
   (short-lived jobs push instead —                      │
    see section 6)                                       │ hash(series), 3 copies
                                                         ▼
                                          ┌────────────────────────────┐
                                          │ ingesters (×N)             │
                                          │ last 2 h in RAM + WAL      │
                                          └──────────────┬─────────────┘
                                                         │ every 2 h: seal a block
                                                         ▼
   compactor: merges blocks,         ──▶  ┌────────────────────────────┐
   writes 5-min summaries                 │ object storage:            │
                                          │ compressed blocks + index  │
                                          └────────────────────────────┘
   READ PATH                                             ▲ older blocks
   dashboards  ──▶ ┌──────────┐ ─────────────────────────┘
   alert rules ──▶ │ queriers │ ── last 2 h ──▶ ingesters
                   └──────────┘
```

Two paths, deliberately separate:

- **Writes** land in memory on an ingester (fast), protected by a [write-ahead log](../04-data/wal-and-durability.html) so a crash loses nothing. Every two hours the recent data is sealed into an immutable, compressed **block** and shipped to [object storage](../02-building-blocks/object-storage.html), which is cheap and effectively unlimited.
- **Reads** go to queriers, which ask ingesters for the last two hours and read older blocks from object storage, then merge.

Blocks never change once written. That makes them easy to cache, easy to copy and easy to delete when they expire — retention is just "delete blocks older than 15 days".

## 5. Deep dive — why time series compress so well

A generic database stores each sample as a row with a timestamp column and a value column — 16 bytes plus row overhead, plus an index entry. Time series have a shape you can exploit instead. Within one series:

**Timestamps are nearly regular.** Measured every 10 seconds, the gaps are 10, 10, 10, 11, 10. So store the *difference between differences*:

```diagram
   timestamps:            1000  1010  1020  1030  1041  1051
   differences:                 10    10    10    11    10
   difference of those:               0     0     1    −1
                                      ↑ mostly zero, so 1–2 bits each
```

**Values change little between neighbours.** A gauge at 63.2, 63.2, 63.4, 63.4. XOR each value with the previous one and the result is mostly zero bits; store only the bits that changed. (This combination was described in Facebook's *Gorilla* paper and is what most time-series databases now use.)

Together they get a 16-byte sample down to roughly **1.3–1.5 bytes**. That's the 10× from the estimate.

Data is stored **per series, in chunks** of about two hours — all the samples of one series sit together, which is what makes the delta tricks work. It's the same idea as [columnar storage](../04-data/olap-columnar.html): put similar values next to each other and they compress.

**Finding the right series.** A query says `{service="checkout", status="500"}`. The block keeps an **inverted index**: for each label value, the sorted list of series that have it. The query intersects two sorted lists — exactly how a search engine finds documents containing two words.

```diagram
   service="checkout"  →  [12, 40, 41, 97, 310]
   status="500"        →  [3, 40, 97, 512]
   both                →  [40, 97]          → read only those two series' chunks
```

**Compaction.** Small two-hour blocks are merged into bigger ones in the background (fewer files to open per query), and the compactor also writes the **downsampled** versions used for long ranges (section 7).

## 6. Deep dive — do we fetch, or do they send?

Two ways to collect, both used in practice:

| | **Pull** — collectors fetch `/metrics` | **Push** — services send to us |
|---|---|---|
| Knowing a host is down | Free — the fetch fails | Silence looks the same as "nothing happened" |
| Controlling load | The collector decides how often | A misbehaving service can flood us |
| Short-lived jobs (a 20-second batch job) | Might finish between fetches | Sends before exiting |
| Behind firewalls / on phones | Collector can't reach them | Works |

**The answer to give:** *"Pull for long-running services — the system knows what it expects to hear from, so a dead host is an alert, not a gap. Push through a small gateway for short-lived jobs and anything the collector can't reach."* The first point is the important one: with pull, **missing data is itself a signal**.

In practice, most new services are instrumented with **OpenTelemetry**, the vendor-neutral standard for metrics, logs and traces. Its protocol (OTLP) pushes, so a modern system accepts both: scraping for the services it knows about, plus an OTLP endpoint — with a heartbeat or "expected sources" list, so a silent pusher still raises an alert.

## 7. Deep dive — queries and long time ranges

**Counters are queried as rates.** A counter's raw value (1,042,316 requests) means nothing; the useful number is "requests per second over the last 5 minutes". The rate calculation must handle the counter **resetting to zero** when a process restarts — a drop is treated as a restart, not as negative traffic.

**Long ranges use summaries.** A dashboard showing a year can't read 3 million samples per series. The compactor pre-computes 5-minute and 1-hour summaries, and the querier picks the coarsest one that still gives enough points for the chart.

Store **min, max, sum and count** per summary interval — never just the average:

```diagram
   Hour 1: 59 samples at 10 ms, 1 sample at 5,000 ms
     average only:  93 ms          → the spike has vanished
     min/max/sum/count: max = 5,000 ms, and the true average is still sum/count
```

An average of averages is wrong, and an average hides the spike you were looking for. With sum and count you can compute any average correctly; with max you can still see the spike.

**Cache dashboard queries by time slice.** Twenty people watching the same dashboard ask the same question every 10 seconds. Cache results in aligned slices (each 10-minute piece), so a refresh only computes the newest slice.

## 8. Scaling the write path

5M samples a second is spread across ingesters by hashing the series identity, with each series on three ingesters for safety — [consistent hashing](../02-building-blocks/consistent-hashing.html), so adding an ingester moves only a small share of series.

```diagram
   series id = hash(name + sorted labels)
   ring position → primary ingester + next 2 on the ring
   a write succeeds when 2 of 3 acknowledge      (a quorum)
```

Hashing by the *whole series identity* spreads load evenly. Hashing by service would put all of a huge service's series on one machine. Queries for one service then fan out to many ingesters and merge — fine, because queries are rare compared with writes.

Each team (or tenant) gets limits: maximum active series, samples per second, and series per query. Limits aren't bureaucracy — they're what stops one team's mistake from becoming everyone's outage.

## 9. Failure modes & follow-ups

**An ingester crashes.** Two other copies hold every series, so reads and writes continue. When it comes back it replays its write-ahead log to rebuild the last two hours in memory.

**"Who monitors the monitoring?"** A small, separate, simple monitoring setup watches this one — ideally in another region — and pages if it stops receiving data. Otherwise the system goes down silently, at exactly the moment it's needed.

**Samples arrive late or out of order.** A host with a wrong clock, or a network delay. Accept samples within a short window (say 10 minutes) of the newest; reject older ones and count them. Fix clocks with time sync, not with storage cleverness.

**The bill.** Most cost is storage and the index. The levers: shorter raw retention, more aggressive summaries, cardinality limits, and dropping metrics nobody has queried in 90 days. Tracking which series are actually used pays for itself.

**"How is this different from logs?"** Metrics are numbers, aggregated, cheap per point and kept long. Logs are text events, detailed and expensive. Traces follow one request. A good answer uses metrics to notice a problem, then logs and traces to explain it — one sentence that shows you know where this system fits.

:::exercise Size and design decisions
1. A team adds a `customer_id` label (2 million customers) to a metric with 20 other label combinations. How many new series is that? What happens to ingester memory, and what should the system do?
2. Work out storage for 30 days of raw data at 1.5 bytes per sample using the estimate above. What changes if you measure every 15 seconds instead of every 10?
3. A dashboard shows p99 latency for the last 90 days. Which stored data does it read, and why can't a 5-minute *average* give a correct p99?
4. Design the query path for "error rate of checkout, last 30 minutes" end to end — which machines are asked, and what is merged where.
:::

:::paper Further study
*Gorilla: A Fast, Scalable, In-Memory Time Series Database* (Pelkonen et al., VLDB 2015) introduced the timestamp and value compression described in section 5.

*Monarch: Google's Planet-Scale In-Memory Time Series Database* (Adams et al., VLDB 2020) describes a global, multi-region design and the trade-offs of pushing aggregation close to the source.
:::

## Check yourself

```recall
Q: What is the main design problem in a metrics system?
A: Storage format: 5 million samples a second is ~7 TB a day raw but ~650 GB compressed. Ten-times compression decides whether keeping the data is affordable.

Q: What is the cardinality trap?
A: Every distinct label combination is a separate series. A label like user_id creates millions of series and exhausts index and memory. Labels must have small bounded value sets; enforce per-team active-series limits.

Q: How do time series compress to ~1.5 bytes a sample?
A: Delta-of-delta timestamps (regular intervals give mostly zeros) and XOR of each value with the previous (mostly zero bits) — the Gorilla encoding — on per-series chunks of about two hours.

Q: How does a query find the right series?
A: An inverted index maps each label value to a sorted list of series IDs; intersecting the lists finds series matching every label, as a search engine does.

Q: Describe the write path.
A: Ingesters keep the last two hours in memory, protected by a WAL; every two hours they seal an immutable compressed block to object storage; a compactor merges blocks and writes downsampled summaries.

Q: Pull or push collection?
A: Pull for long-running services — a failed scrape means a dead host, so missing data is itself a signal. Push (OTLP, or a gateway) for short-lived jobs and unreachable sources, with an expected-sources list.

Q: Why store min, max, sum and count in summaries rather than an average?
A: An average hides spikes and an average of averages is wrong. Sum and count give any correct average; max keeps the spike visible.

Q: Who monitors the monitoring?
A: A small, separate, simple setup — ideally in another region — that pages if the main system stops receiving data, since it's most needed when everything else fails.
```

## What to carry forward

- The data's shape suggests its own storage engine: per-series compressed chunks.
- Cardinality, not volume, is what kills monitoring — keep labels bounded and limit series.
- Recent data in memory with a WAL, immutable blocks in object storage, compaction for summaries.
- Query counters as rates; summarise with min, max, sum and count.
- Pull makes silence a signal; watch the watcher from outside.
