---
title: OLTP vs OLAP & Columnar Storage
summary: Why analytical queries need a different database, how column orientation changes everything, and the modern pipeline from operational data to insight.
difficulty: Medium
scope: HLD
tags: [olap, columnar, analytics, warehouse]
prereqs: [storage-engines, query-execution]
---

:::predict Guess first
1. A monthly sales report runs on the same database as checkout. What could go wrong at 9 a.m. on the 1st?
2. A query sums one column out of 50. If each row is stored together on disk, how much of the table must it read?
3. Why might a column of city names compress far better than a whole row?
:::

## Two workloads, two systems

**OLTP (Online Transaction Processing)** — the operational database. Many small, fast operations touching few rows each, found by key.

```sql
SELECT * FROM orders WHERE id = 4711;
UPDATE inventory SET qty = qty - 1 WHERE sku = 'ABC';
```

Thousands per second, single-digit milliseconds, strict correctness, current state only.

**OLAP (Online Analytical Processing)** — the analytics database. Few large queries, each scanning millions or billions of rows and aggregating.

```sql
SELECT region, DATE_TRUNC('month', created_at), SUM(total)
FROM orders WHERE created_at > '2024-01-01'
GROUP BY 1, 2;
```

A handful per minute, seconds to minutes, read-only, full history.

These are so different that trying to serve both from one database serves neither well — the classic symptom being an analytics query that locks up the production database and takes checkout down with it. **Separating them is the first thing to say** when a design mixes reporting with transactions.

## Row vs column storage

The structural reason OLAP databases are so much faster at analytics.

```diagram
   ROW-ORIENTED (OLTP) — all fields of a row stored together
   [1|Alice|Pune |4999][2|Bob|Delhi|1299][3|Cara|Pune|8800]
    ▲ fetching one whole row = one contiguous read ✓
    ▲ SUM(total) must read EVERY field of EVERY row ✗

   COLUMN-ORIENTED (OLAP) — each column stored together
   ids:     [1][2][3]
   names:   [Alice][Bob][Cara]
   cities:  [Pune][Delhi][Pune]
   totals:  [4999][1299][8800]   ◄── read ONLY this for SUM(total)
```

**The consequence:** a query touching 3 of 50 columns reads ~6% of the data instead of 100%. On a terabyte table that's the difference between 20 seconds and 20 minutes.

Three more advantages compound it:

**Compression is dramatically better.** A column holds one kind of value, over and over — `city` might have 200 distinct values across a billion rows. That repetition is exactly what compression feeds on: store each city name once and refer to it by number (*dictionary encoding*), or record "Pune, 40,000 times" instead of writing it 40,000 times (*run-length encoding*). Columnar data routinely compresses 10:1 where row data manages about 2:1. Less data on disk means less I/O, and I/O is the bottleneck.

**Vectorised execution.** When a million values of the same type sit side by side, the CPU can apply one instruction to a batch of them at once instead of looping one at a time — often 10× faster per byte.

**Late materialisation.** Do the filtering against the compressed columns first, and only bother assembling complete rows for the handful that survive.

**The cost:** writing or updating a single row means touching every column file. Columnar stores are therefore append-and-batch oriented — most don't support efficient single-row updates at all, which is exactly why they're unsuitable for OLTP.

## Making scans cheap

Beyond column orientation, analytical stores avoid reading data at all:

**Partitioning.** Split by a column, usually date. A query with `WHERE created_at > '2024-06-01'` skips entire partitions — *partition pruning*.

**Zone maps / min-max indexes.** Each block stores the min and max of each column. A query filtering `total > 10000` skips any block whose max is below that. Cheap, automatic, and extremely effective when data is naturally clustered.

**Sort keys / clustering.** Physically ordering data by a frequently-filtered column makes zone maps far more selective. This is often the single highest-impact tuning decision in a warehouse.

**Materialized views / rollups.** Pre-aggregate common queries. Turns a billion-row scan into a thousand-row lookup — and the pre-aggregation is where most of the "real-time analytics" magic lives.

Note the pattern: analytical databases barely use B-tree indexes. Their strategy is "scan fast and skip aggressively" rather than "seek precisely" — a genuinely different philosophy, and a good thing to articulate.

## The systems

| System | Type | Best at |
|---|---|---|
| Snowflake / BigQuery / Redshift | Cloud warehouse | Ad-hoc SQL over huge history, separated storage/compute |
| ClickHouse | Columnar OLAP | Very fast aggregations, real-time ingest, self-hosted |
| Apache Druid / Pinot | Real-time OLAP | Sub-second queries on streaming data, user-facing analytics |
| DuckDB | Embedded OLAP | Local/single-node analytics; surprisingly capable |
| Parquet + Spark/Trino | Lake / query engine | Cheap object storage, flexible compute |

**Separation of storage and compute** is the defining feature of the modern warehouse: data lives in object storage, compute clusters spin up on demand and scale independently. You pay for storage cheaply and for compute only when querying — and two teams' queries don't compete for the same machines.

## The pipeline

```diagram
   OLTP DBs ──┐
   Event      ├──► ingest ──► LAKE ──► transform ──► WAREHOUSE ──► BI
   streams  ──┤    (CDC,      (raw,      (dbt,        (modelled,     dashboards
   3rd-party──┘    batch)     Parquet)   Spark)        columnar)     ML, ad-hoc
```

**ETL vs ELT.** The old way transformed data *before* loading (ETL), because storage and compute were expensive. The modern way loads raw data first and transforms *inside* the warehouse (ELT), because storage is cheap and warehouse compute is powerful. ELT means you keep the raw data, so when a transformation turns out to be wrong you can reprocess rather than having lost the original — which is usually decisive.

**Getting data in:** [CDC](cdc-outbox.html) from operational databases (low latency, no application changes), event streams for behavioural data, and batch loads for third-party sources.

**The medallion structure** is the common organizing convention: *bronze* (raw, as-ingested), *silver* (cleaned, deduplicated, typed), *gold* (business-level aggregates the analysts actually query). Worth naming because it shows familiarity with how these systems are actually organized.

## Lakehouse

The lake gave cheap storage of anything but no transactions, no schema enforcement, and no efficient updates — the "data swamp" problem. **Table formats** (Iceberg, Delta Lake, Hudi) add a metadata layer over Parquet files in object storage that provides:

- **ACID transactions** over files, so concurrent writers don't corrupt each other.
- **Schema evolution** with enforcement.
- **Time travel** — query the table as of a past version.
- **Efficient upserts and deletes** (which also makes GDPR deletion tractable in a lake).
- **Partition evolution** without rewriting history.

The result is warehouse-like semantics at lake economics, queryable by multiple engines rather than locked into one vendor. Iceberg has become the common denominator.

## Real-time analytics

When dashboards must reflect the last few seconds — user-facing metrics, live operational monitoring, an [ad click dashboard](../05-case-studies/ad-click-aggregator.html) — batch pipelines are too slow.

The **lambda architecture** ran a fast approximate streaming path alongside a slow exact batch path and merged them. It works, and it means maintaining the same business logic twice in two systems, which is where it usually breaks down.

The **kappa architecture** uses one streaming path and reprocesses from the retained log when logic changes. Simpler and now more common, enabled by log systems that retain long history.

In practice, real-time OLAP stores (Druid, Pinot, ClickHouse) collapse the distinction: they ingest from a stream, pre-aggregate on write, and serve sub-second aggregate queries directly. For most "real-time dashboard" requirements this is the pragmatic answer.

:::interview The separation argument
When a design includes both transactions and reporting, say this early:

"Analytics shouldn't run against the operational database — a full table scan for a monthly report competes for the same buffer pool and I/O as checkout, and that's how a reporting query causes a production incident. I'd replicate to a columnar store via CDC. Reads there are seconds behind, which is fine for reporting, and it means analysts can write whatever queries they like without any risk to the transactional path."

That names the failure mode, the fix, the consistency cost, and why the cost is acceptable — the four-part structure that scores.
:::

:::exercise Compute the scan cost
1. A table of 50 columns, 2 billion rows, 8 bytes per value. A query touches 3 columns. Compare bytes read for a row store and a column store.
2. Compression: which encodings apply to a column of timestamps, a column of country codes, and a column of random UUIDs? Estimate the ratio for each.
3. Why does a column store handle `SELECT *` on a single row badly? Quantify it.
4. Late materialisation: explain what it is and construct a query where it changes the cost by an order of magnitude.
5. Your analytical query scans 400 GB in 12 seconds. Is that bandwidth-bound or compute-bound? What measurement tells you, and what would you change in each case?
:::

:::paper Column stores
*C-Store: A Column-oriented DBMS* (Stonebraker et al., VLDB 2005) is the paper that established the design. *The Design and Implementation of Modern Column-Oriented Database Systems* (Abadi et al., 2013) is the comprehensive survey.

*MonetDB/X100* (Boncz, Zukowski & Nes, CIDR 2005) is vectorized execution — see [query execution](query-execution.html) — and *Dremel* (Melnik et al., VLDB 2010) is the nested columnar format Parquet implements.
:::

## Check yourself

```recall
Q: OLTP versus OLAP?
A: OLTP: many small key lookups and updates touching few rows, in milliseconds, on current state. OLAP: few large read-only queries scanning and aggregating millions of rows over full history, in seconds.

Q: Why run analytics on a separate system?
A: A big scan competes with checkout for the same buffer pool and I/O, so a report can cause a production incident. Replicate to a columnar store via CDC and accept seconds of lag.

Q: Why is column storage so much faster for analytics?
A: A query reads only the columns it touches — 3 of 50 is about 6% of the data — and same-typed columns compress about 10:1 and suit vectorised, SIMD execution.

Q: Name two encodings that make columns compress well.
A: Dictionary encoding (store each distinct value once and refer to it by number) and run-length encoding ("Pune, 40,000 times"). Delta encoding suits sorted numbers and timestamps.

Q: Why are column stores bad at OLTP?
A: Writing or updating one row touches every column file, so they favour appends and batches; many don't support efficient single-row updates at all.

Q: How do analytical stores avoid reading data?
A: Partition pruning (usually by date), zone maps (per-block min/max), sort keys that make zone maps selective, and materialised rollups. Scan fast and skip aggressively rather than seek with B-trees.

Q: ETL versus ELT — why did ELT win?
A: ELT loads raw data first and transforms inside the warehouse. Storage is cheap and warehouse compute is strong, and keeping raw data means a bad transformation can be reprocessed.

Q: Lambda versus kappa architecture?
A: Lambda runs a streaming path and a batch path and merges them, so logic is written twice. Kappa uses one streaming path and replays the log to reprocess. Real-time OLAP stores like Druid, Pinot and ClickHouse often make the question moot.
```

## What to carry forward

- Separate OLTP from OLAP early; replicate via CDC and accept seconds of lag for reporting.
- Column storage reads only touched columns and compresses about 10:1 — the root of analytical speed.
- Analytical stores skip data (partitions, zone maps, sort keys) instead of seeking with B-trees.
- Separating storage from compute is the defining feature of the modern warehouse.
- ELT keeps raw data so mistakes can be reprocessed; organise it as bronze, silver and gold.
