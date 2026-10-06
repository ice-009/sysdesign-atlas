---
title: Databases on Object Storage
summary: Why a new generation of databases, queues and search engines keeps no data on local disk at all — what made it possible, how a write survives 50 ms object-store latency, and how compare-and-swap on a file replaces a consensus cluster.
difficulty: Hard
scope: HLD
tags: [storage, object-storage, s3, architecture]
prereqs: [object-storage, storage-engines, wal-and-durability, lakehouse-and-batch]
unlocks: Judging when "store everything in S3" is the right database architecture, and what it costs in latency and requests.
---

:::predict Guess first
1. Writing one small record to S3 takes tens of milliseconds. How could a database built on S3 still accept thousands of writes per second?
2. Two servers both believe they are the database's only writer. With nothing but object storage between them, how could you stop both from writing?
3. Which do you think costs more for a busy database on S3: storing the data, or the number of requests?
:::

## A different place to put the data

The classic database design keeps data on disks attached to its own machines and replicates it to other machines for durability. Over the last few years a growing set of systems has done something that would have sounded reckless a decade ago: **keep the durable copy only in object storage** — S3 or its equivalents — and treat local disks and memory as nothing more than a cache.

```diagram
   CLASSIC (shared-nothing)              OBJECT-STORAGE NATIVE

   node 1  [ data on local disk ]        compute 1  [ cache ]  ┐
   node 2  [ replica on local disk ]     compute 2  [ cache ]  ├─► object store
   node 3  [ replica on local disk ]     compute 3  [ cache ]  ┘   (the only
                                                                   durable copy)
   durability = replicate between        durability = the object store's
   your own machines                     own replication across zones
   lose a node → re-copy its data        lose a node → start another;
                                         nothing to re-copy
```

The examples now span most kinds of data system:

| System | What it is | The object-storage idea |
|---|---|---|
| Snowflake, BigQuery | Data warehouses | The pioneers: storage separated from compute, which scales independently |
| Iceberg, Delta Lake | [Table formats](lakehouse-and-batch.html) | Tables are files plus metadata, committed atomically |
| Neon | Postgres | WAL to a small quorum, pages to object storage |
| WarpStream, Kafka diskless topics | [Message logs](../08-case-studies/distributed-log.html) | Brokers keep nothing; batches go straight to object storage |
| turbopuffer, LanceDB | Search and vector databases | Indexes in object storage, hot data cached on NVMe |
| SlateDB | Embedded key-value store | An [LSM tree](storage-engines.html) whose files live only in object storage |

## Why now: three changes

**1. Strong consistency (2020).** S3 became strongly consistent for reads after writes in December 2020. Before that, a reader might not see an object it had just written, which made building a database on it a minefield.

**2. Compare-and-swap on objects (2024).** S3 added *conditional writes*: in August 2024, "create this object only if it doesn't already exist" (`If-None-Match`); in November 2024, "replace this object only if it's still the version I read" (`If-Match` on the ETag). Google Cloud Storage and Azure had offered similar preconditions for longer. That single primitive is enough to coordinate writers without a separate consensus cluster — more below.

**3. The economics of cloud networking.** In the cloud, copying data between availability zones is billed per gigabyte, in both directions. A classic replicated database or Kafka cluster copies every byte to two other zones — often its largest cost. Object storage replicates across zones internally, with no per-gigabyte transfer charge for writing to it from within the region. Moving replication into the object store removes that line from the bill.

## The latency problem, and the standard answer

Object storage is durable, cheap and effectively unlimited. It is not fast:

```diagram
   Local NVMe write                 ~0.02-0.1 ms
   Write to a replica in another    ~1-2 ms
     availability zone
   S3 Standard PUT                  ~20-100 ms typical, more at the tail
   S3 Express One Zone              single-digit ms, one zone only
```

A database that waited 50 ms per write would be useless for most workloads. The answer, in every system above, is the same one databases have always used for slow disks: **batch**.

:::derive Why batching is mandatory — in latency and in money
```
   A service writes 10,000 small records a second.

   ONE PUT PER RECORD
     10,000 PUTs/s × 86,400 s       =  864 million PUTs/day
     at ~$0.005 per 1,000 PUTs      ≈  $4,300 per day
     each write waits ~50 ms

   BATCH INTO ONE OBJECT EVERY 250 ms
     4 PUTs/s × 86,400 s            ≈  346,000 PUTs/day
     cost                           ≈  $1.70 per day
     each write waits up to ~250 ms + one PUT

   → batching cuts request cost about 2,500× and turns many
     slow writes into one slow write shared by everyone in the
     batch. It's group commit, with object storage as the disk.
```
:::

The trade is plain: **throughput and cost improve, per-write latency gets worse.** Systems then claw some latency back in a few standard ways:

- **A low-latency write-ahead log in front.** Neon writes its WAL to a small Paxos group of "safekeepers" for fast commits and moves pages to object storage in the background. Others write the log to S3 Express One Zone, or to replicated local disks, and flush to standard object storage later.
- **Acknowledge on the fast tier, upload later** — and be explicit about what survives losing that tier.
- **Choose per topic or table.** Kafka's diskless topics are opt-in: low-latency topics keep classic replication, high-volume logs that tolerate a second of delay go diskless.

## Reads: caching is the whole performance story

A read that goes all the way to object storage costs tens of milliseconds and a request fee. So these systems cache aggressively in layers:

```diagram
   memory       hot data           microseconds
   local NVMe   warm data          ~0.1 ms     (far cheaper per GB than
                                                RAM; fast for big reads)
   object store everything else    tens of ms
```

Routing matters as much as the cache. turbopuffer, for example, sends queries for the same namespace to the same query node so that node's NVMe cache stays warm — the same [cache-affinity](../06-ai-infrastructure/kv-cache-management.html) idea used for LLM prefix caches. A cold read of a rarely touched dataset is slow; a warm read is fast. That's the bet: **most data is cold most of the time**, and paying object-storage prices for it while caching the hot part beats paying replicated-disk prices for all of it.

## Coordination without a consensus cluster

The interesting systems problem. Many writers can append immutable files safely — names are unique, nothing is overwritten. The hard part is the one mutable thing every database has: **the pointer to its current state** (the manifest, the table metadata, the list of live files). Two writers updating it at once would corrupt the database.

Classically you'd run a consensus group (ZooKeeper, etcd) to decide who the writer is. With conditional writes, the object store itself can do it:

```diagram
   THE MANIFEST HOLDS: list of live data files + writer epoch

   Writer B starts:
     read manifest            → epoch 7, ETag "e7"
     write manifest, epoch 8,
       IF-MATCH "e7"          → succeeds: B is now the writer

   Old writer A (paused, then wakes up) tries to commit:
     write manifest, epoch 7 + its new files,
       IF-MATCH "e7"          → FAILS: the manifest has changed
                                A learns it was fenced off and stops
```

That's a [fencing token](../02-building-blocks/distributed-locks.html) implemented as a compare-and-swap on a file. SlateDB uses exactly this pattern: each new writer bumps an epoch in the manifest with an `If-Match` write, and its write-ahead-log objects are created with `If-None-Match` names tied to that epoch, so a "zombie" writer that was partitioned away can't slip stale data in after a new writer has taken over.

Table formats work the same way. An Iceberg or Delta commit is an atomic swap of the pointer to the current metadata — via a catalog or, increasingly, via a conditional write on the object store itself. Many writers prepare new files in parallel; only the pointer swap must be serialised, and the loser of a race retries its commit against the new state.

:::goat The pattern underneath
Put **immutable data** in object storage, where it is cheap, durable and safe to write in parallel. Keep exactly **one small mutable pointer**, and update it with compare-and-swap.

Everything else follows. Readers see a consistent snapshot by reading one pointer. Writers coordinate through a single conditional write. Old files are garbage-collected once no snapshot points at them. It's the same shape as [copy-on-write](wal-and-durability.html) in storage engines, [MVCC](transactions-isolation.html) snapshots and Git commits — applied at the scale of a bucket.
:::

## When it fits, and when it doesn't

| Good fit | Poor fit |
|---|---|
| Analytics, logs, metrics, search over large mostly-cold data | Transactions needing single-digit-ms commits at high rates |
| Many tenants, each queried occasionally | Small, hot datasets that fit comfortably on one machine |
| Elastic compute — scale to zero when idle | Workloads dominated by tiny random writes |
| Avoiding cross-zone replication costs | Single-zone deployments where replication is cheap anyway |
| Simple operations — losing a node loses no data | Teams that can't tolerate cold-read latency spikes |

:::trap Request costs are the hidden bill
Storage in object storage is cheap per gigabyte. **Requests are not free**, and a design that issues one request per small read or write can cost more than the replicated disks it replaced.

Before choosing this architecture, estimate requests per second in both directions, multiply by the per-request prices, and compare against storage cost. Then check what happens on a cold start, when every read misses the cache at once — that's both a latency spike and a request-fee spike.
:::

:::exercise Design a log on object storage
You're building an append-only event log: 50,000 events/s of ~500 bytes, consumers reading in near-real time, retention 30 days.

1. Estimate daily volume and 30-day storage. At about $0.023 per GB-month, what does storage cost?
2. Choose a batching interval. Estimate PUT requests per day and their cost at about $0.005 per 1,000. What latency does a producer see?
3. Consumers poll for new data. If 200 consumers each issue a GET every 100 ms, what do the GETs cost per day at about $0.0004 per 1,000? How would you reduce it?
4. Design the commit protocol so two producers for the same partition can never both believe they own it. Which object holds the epoch, and what conditional writes do you use?
5. Producers need acknowledgements in under 10 ms. Add a fast tier. What does a producer's "acknowledged" now promise, and what does losing that tier lose?
6. Compare total cost with a three-zone replicated cluster, given that cross-zone transfer is billed per gigabyte in each direction.
:::

:::paper Sources
*Building an Elastic Query Engine on Disaggregated Storage* (Vuppalapati et al., NSDI 2020) describes Snowflake's architecture. *Delta Lake: High-Performance ACID Table Storage over Cloud Object Stores* (Armbrust et al., VLDB 2020) covers commits on object storage.

The AWS announcements of S3 conditional writes (August and November 2024), SlateDB's manifest design notes, and turbopuffer's architecture page are the practical references for the patterns above.
:::

## Check yourself

```recall
Q: What does "object-storage native" mean for a database?
A: The only durable copy lives in object storage such as S3; local disks and memory are caches. Losing a node loses no data, and compute scales separately from storage.

Q: Which three changes made databases on object storage practical?
A: S3 strong read-after-write consistency (2020), conditional writes — If-None-Match (August 2024) and If-Match (November 2024) — and cloud pricing that charges per gigabyte for cross-zone replication but not for writing to object storage.

Q: How do these systems cope with 20–100 ms object-store writes?
A: Batching — many records per object, like group commit — which slashes request cost and shares one slow write among many, often with a fast write-ahead log (a Paxos quorum, S3 Express or replicated disks) in front.

Q: Why is batching mandatory in money as well as latency?
A: 10,000 one-record PUTs a second is ~864 million requests a day (~$4,300); batching every 250 ms is ~346,000 (~$1.70). Requests, not storage, dominate the naive design.

Q: How do object-storage systems make reads fast?
A: Layered caches — memory, then local NVMe — plus routing the same dataset to the same node so its cache stays warm. Cold reads still pay object-store latency.

Q: How can a conditional write replace a consensus cluster?
A: Keep one mutable manifest holding a writer epoch. A new writer bumps the epoch with If-Match on the ETag it read; a stale writer's later If-Match fails, fencing it off.

Q: What is the underlying pattern?
A: Immutable data files written freely in parallel, plus one small mutable pointer updated by compare-and-swap — the same shape as copy-on-write, MVCC snapshots and Git commits.

Q: When is this architecture a poor fit?
A: Low-latency transactional commits, small hot datasets, workloads of tiny random writes, single-zone deployments, and anywhere request costs or cold-read spikes would dominate.
```

## What to carry forward

- **Object storage can be the database's only durable copy**; local storage becomes a cache.
- Strong consistency, **conditional writes** and cross-zone pricing made the shift practical.
- **Batch every write** — it's what makes latency tolerable and request costs sane.
- **Immutable files plus one compare-and-swapped pointer** replaces a consensus cluster.
- Great for large, mostly cold, elastic workloads; **estimate request costs** before choosing it.
