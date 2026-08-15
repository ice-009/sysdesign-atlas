---
title: Data Lakes, Lakehouses & Batch Processing
summary: Parquet, table formats like Iceberg, partitioning that actually helps, and why the industry converged on "object storage plus metadata" for everything analytical.
difficulty: Medium
scope: HLD
tags: [data, batch, parquet, iceberg, lakehouse]
prereqs: [olap-columnar, object-storage]
unlocks: Designing the storage layer that every analytics and ML training pipeline sits on.
---

## Why not just use a database

An analytical warehouse works well until one of three things happens:

1. **The data outgrows what you'll pay for.** In a traditional warehouse, the machines that store your data are the same machines that query it, so you pay for both together. A petabyte you touch once a quarter costs the same per byte as the table you hit every second.
2. **The data isn't tabular.** Images, audio, model checkpoints, raw JSON, logs. A warehouse will take these grudgingly and expensively.
3. **Many engines need the same data.** SQL, Spark, a training pipeline, and a notebook all want the same table without copying it four times.

The answer the industry converged on is to **separate storage from compute and from the table definition**:

```viz
{
  "type": "stack",
  "caption": "Each layer is independently replaceable. That's the whole point.",
  "layers": [
    { "label": "Query engines", "sub": "Spark · Trino · DuckDB · training jobs", "accent": "#38bdf8" },
    { "label": "Table format", "sub": "Iceberg / Delta / Hudi — schema, snapshots, ACID", "accent": "#a78bfa" },
    { "label": "File format", "sub": "Parquet / ORC — columnar, compressed, statistics", "accent": "#4ade80" },
    { "label": "Object storage", "sub": "S3 / GCS — cheap, durable, infinitely scalable", "accent": "#fbbf24" }
  ]
}
```

Any engine can be swapped without moving data. Storage costs cents per gigabyte-month. Compute is rented only while a query runs. That combination is why this architecture won.

## Parquet: why columnar files are so much faster

A Parquet file stores data column by column within row groups, with statistics attached at every level.

```diagram
   PARQUET FILE
   ├── Row group 1  (~128 MB of rows)
   │   ├── Column "user_id"    [pages] + min/max/nulls/count
   │   ├── Column "country"    [pages] + min/max + dictionary
   │   └── Column "amount"     [pages] + min/max
   ├── Row group 2 ...
   └── Footer: schema + statistics for every column of every row group

   Query:  SELECT amount FROM t WHERE country = 'IN'

     1. Read the footer only (a few KB)
     2. Skip every row group whose country min/max excludes 'IN'
     3. In surviving groups, read ONLY the country and amount columns
     4. Never touch the other 47 columns
```

Three separate wins compound here:

- **Column pruning.** Reading 2 of 50 columns reads ~4% of the bytes.
- **Predicate pushdown via statistics.** Min/max per row group skips whole chunks without decompressing them.
- **Compression that actually works.** A column holds one type with similar values, so dictionary encoding, run-length encoding, and delta encoding all apply. 5–10× compression on real data is typical, versus ~2× for row-oriented JSON.

Combined with [vectorized execution](query-execution.html), this is why a scan over a Parquet dataset can beat a row-store by two orders of magnitude on the same hardware. The mechanism is entirely covered by [columnar storage](olap-columnar.html) — Parquet is that idea serialised to a file.

:::trap Small files will destroy you
Object storage charges per request and has ~20–100 ms of latency per GET. A table stored as 500,000 files of 1 MB each spends nearly all of its query time on request overhead, and listing the directory alone can take minutes.

**Target 128 MB – 1 GB per file.** Streaming ingest naturally produces small files (one per micro-batch per partition), so any streaming-to-lake pipeline needs a **compaction job** as a first-class, scheduled component — not something added after the first slow quarter. This is the most common way a lakehouse becomes unusable.
:::

## Partitioning: the highest-leverage decision

Partitioning stores rows in different directory paths by column value, so the engine can skip entire directories.

```diagram
   s3://lake/events/
     dt=2026-08-01/hour=00/part-0000.parquet
     dt=2026-08-01/hour=01/part-0000.parquet
     ...

   WHERE dt = '2026-08-08'  → reads 1 day instead of 3 years
```

The rules that matter:

- **Partition on what you filter by**, almost always time. If most queries are "last 7 days", partitioning by date is the single biggest win available.
- **Don't over-partition.** Partitioning by `user_id` with 10 million users creates 10 million directories with tiny files in each — you've built the small-file problem deliberately.
- **Aim for 100 MB – 1 GB per partition.** If a day's data is 10 KB, partition by month.
- **Beware skew.** Partitioning by `country` puts 60% of rows in one directory, and one task processes it while the others idle.

:::goat Hidden partitioning is why Iceberg exists
In the old Hive layout, partitioning was **physically encoded in the path**, so a query had to filter on the partition column *in exactly the right form* to benefit:

```sql
-- reads everything, no pruning
WHERE event_time > '2026-08-01'
-- prunes correctly
WHERE dt = '2026-08-01'
```

Users had to know the physical layout and repeat it in every query. Worse, changing the partitioning scheme meant rewriting the entire table.

Iceberg decouples them: the table declares a *transform* (`days(event_time)`), and the engine derives partition pruning from a predicate on the natural column. You can also change the partitioning scheme without rewriting history — old data keeps its old layout, new data uses the new one, and queries handle both.

This is a small-sounding change that removed an entire class of "why is my query scanning everything" incident.
:::

## Table formats: giving a pile of files ACID

A folder full of data files is not a table. Nothing says which files are current, nothing lets you add and remove files as one indivisible change, nothing gives a reader a stable view while a writer is midway through appending, and nothing tracks how the columns have changed over time.

A **table format** adds a thin layer of bookkeeping on top of those files that supplies exactly those missing pieces — a list of which files make up the table right now, and a rule for swapping that list atomically:

```diagram
   ICEBERG
     catalog → current metadata pointer
                  ↓
              metadata file  (schema, partition spec, snapshot list)
                  ↓
              manifest list  (which manifests belong to this snapshot)
                  ↓
              manifests      (which data files, with per-file statistics)
                  ↓
              Parquet files

   A COMMIT is a single atomic swap of the catalog pointer.
   Readers holding the old pointer keep seeing a consistent old snapshot.
```

That one atomic pointer swap delivers:

| Capability | How it works | Why you care |
|---|---|---|
| **Atomic commits** | Pointer swap; readers never see partial writes | Concurrent readers and writers stop corrupting each other |
| **Snapshot isolation** | Each reader pins a snapshot for its whole query | A long query gets consistent results while ingest continues |
| **Time travel** | Old snapshots retained | `AS OF '2026-08-01'` — reproduce a report or a training set exactly |
| **Schema evolution** | Columns tracked by ID, not position | Add, drop, rename, reorder without rewriting data |
| **Row-level deletes** | Delete files or copy-on-write rewrites | GDPR erasure, CDC merge, corrections |
| **File pruning** | Per-file statistics in the manifests | Skip files without opening them |

The three contenders — **Iceberg**, **Delta Lake**, **Hudi** — differ less than the discourse suggests. Iceberg has the broadest engine-neutral adoption; Delta is strongest inside the Databricks ecosystem; Hudi was built around incremental upserts and still leads there. For a new project without an existing platform commitment, Iceberg is the safe default.

:::goat Time travel is not a novelty feature
Reproducibility is the reason it matters. "Retrain the model on exactly the data we had on 1 August" is impossible on a mutable table and trivial with snapshots.

The same mechanism gives you: rolling back a bad ingest by repointing to the previous snapshot; diffing two snapshots to find what a job changed; and auditing what a report was actually computed from. For anything feeding model training, a versioned dataset is a hard requirement, not a nicety.
:::

## Batch processing over it

With storage solved, batch compute is comparatively simple: read files, transform, write files.

**The shuffle is the only part that's hard.** Any operation that regroups data by key — join, group-by, sort — requires moving records across the network so that all records with the same key land on the same task.

```diagram
   SHUFFLE

   Map tasks partition their output by hash(key) % N
     → written to local disk
   Reduce tasks fetch their partition from every map task
     → M × N network transfers

   Costs: disk write + network + disk read + often a sort

   → The shuffle is where batch jobs spend most of their time
     and where they fail. Everything else is embarrassingly parallel.
```

The two failure modes worth knowing:

- **Skew.** One key holds 40% of the rows, so one task runs for an hour while 999 finish in a minute. Fixes: salt the hot key (append a random suffix, aggregate in two stages), or broadcast the small side of the join so there's no shuffle at all.
- **Spill.** A task's partition doesn't fit in memory and goes to disk. Fixes: more partitions, so each is smaller.

**Avoid shuffles where you can.** A broadcast join — replicating a small table to every task — eliminates the shuffle entirely and is often 10× faster. Pre-partitioning ("bucketing") a table by its join key means a later join can skip the shuffle too.

## Batch, streaming, or both

The old **Lambda architecture** ran a batch pipeline for correctness and a parallel streaming pipeline for freshness, then merged them at query time. It worked, and it meant writing and maintaining every piece of business logic twice, in two systems, with two sets of bugs.

**Kappa** proposed one streaming pipeline, with reprocessing done by replaying the log from the beginning. Cleaner in principle; the constraint is that your log must retain enough history to replay, which for years of data means it's really object storage again.

Where it actually landed is neither: **one table format, two access patterns.** Streaming ingest appends to an Iceberg/Delta table; batch jobs and interactive queries read the same table; a compaction job keeps the file sizes sane; corrections are applied as row-level updates. One copy of the data, one schema, one set of business logic, and freshness measured in minutes rather than hours.

:::exercise Design the layout
You're storing clickstream events: 2 billion per day, 40 columns, ~500 bytes each raw. Queries are usually "last 7 days, filtered by country, grouped by page".

1. Raw daily volume is ~1 TB. What do you expect after Parquet with compression, and why?
2. Choose a partitioning scheme. How many files per partition, at what size? Justify against the 128 MB – 1 GB guidance.
3. Streaming ingest writes every 30 seconds. How many files per day does that produce, and what is your compaction strategy?
4. Someone requests deletion of one user's events under GDPR. Walk through what actually happens with copy-on-write versus merge-on-read deletes, and what it costs.
5. A data scientist needs the exact dataset as of three months ago to reproduce a model. What has to be true for that to work, and what's your snapshot retention policy?
:::

:::paper Sources
*Dremel: Interactive Analysis of Web-Scale Datasets* (Melnik et al., VLDB 2010) introduced the nested columnar encoding Parquet implements.

*Lakehouse: A New Generation of Open Platforms that Unify Data Warehousing and Advanced Analytics* (Armbrust et al., CIDR 2021) is the architecture argument. The Apache Iceberg spec is unusually readable and worth skimming directly for the metadata layout.
:::

## What to carry forward

- **Object storage + file format + table format + engine** — four independently replaceable layers.
- **Parquet wins three ways at once**: column pruning, statistics-based skipping, and compression that works because columns are homogeneous.
- **Small files are the primary failure mode.** Compaction is a required component, not an optimisation.
- **Partition on your filter column, usually time.** 100 MB – 1 GB per partition; watch for skew.
- **Table formats add atomic commits, snapshot isolation, time travel, and schema evolution** through one atomic pointer swap.
- **The shuffle is where batch jobs spend their time and die.** Broadcast joins and pre-bucketing avoid it.
