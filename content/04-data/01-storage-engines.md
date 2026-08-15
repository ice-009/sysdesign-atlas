---
title: Storage Engines — B-Tree vs LSM
summary: The two ways databases put bytes on disk, why one favours reads and the other writes, and how compaction and write amplification decide your workload's fate.
difficulty: Hard
scope: Core
tags: [b-tree, lsm, storage, compaction]
prereqs: [indexing, hardware-numbers]
---

## Why this matters

"Should I use Postgres or Cassandra?" is really a question about storage engines. The read/write asymmetry of your workload maps almost directly onto B-tree versus LSM, and being able to explain *why* an LSM tree suits write-heavy workloads means reasoning one level below where most explanations stop.

The fundamental constraint driving both designs: **sequential disk I/O is dramatically faster than random I/O.** On spinning disks it was ~100×. On SSDs the gap is smaller but still real, and random writes additionally cause write amplification in the flash translation layer. Every storage engine is a strategy for turning random writes into sequential ones — or deciding not to.

## B-trees

The classic. Used by Postgres, MySQL/InnoDB, Oracle, SQL Server, and most relational systems.

Data lives in fixed-size **pages** (typically 4–16 KB) arranged in a balanced tree, kept sorted by key. See [Indexing](../02-building-blocks/indexing.html) for the structure.

**Writing** means finding the right page and modifying it **in place**:

```diagram
   UPDATE row 4711
     1. traverse the tree to find its leaf page   (random reads)
     2. modify the page in the buffer pool
     3. write to the WAL (sequential, durable)
     4. eventually flush the dirty page           (random write)

   If the page is full → SPLIT into two pages,
   update the parent, possibly cascading upward.
```

**Strengths:**
- **Predictable reads.** Every lookup is O(log n) — about 3–4 page reads for any dataset size. There's exactly one place a key can be.
- **Excellent range scans.** Leaves are sorted and linked.
- **Mature transactional support.** In-place updates fit naturally with [MVCC](transactions-isolation.html) and locking.

**Weaknesses:**
- **Random writes.** Updates scatter across the disk.
- **Write amplification.** Changing 100 bytes rewrites an entire 8 KB page — and the WAL entry too. Amplification of 10–100× is normal.
- **Page splits** cause fragmentation and occasional latency spikes.
- **Random primary keys make it worse** — see the UUID discussion in [Unique ID Generation](../02-building-blocks/unique-id-generation.html).

## LSM trees

Log-Structured Merge trees. Used by Cassandra, RocksDB, LevelDB, HBase, ScyllaDB, InfluxDB — and increasingly as an option inside traditional databases.

The core idea: **never write randomly. Only append.**

```diagram
   WRITE PATH
   ┌─────────────────────────────────────────────┐
   │ 1. append to WAL (sequential, for crash     │
   │    recovery only)                            │
   │ 2. insert into MEMTABLE (sorted in-memory    │
   │    structure — skip list or red-black tree)  │
   └─────────────────────────────────────────────┘
                     │ memtable full
                     ▼
   ┌─────────────────────────────────────────────┐
   │ 3. FLUSH to disk as an immutable, sorted     │
   │    SSTable — one big SEQUENTIAL write        │
   └─────────────────────────────────────────────┘

   DISK LAYOUT
   L0  [SST][SST][SST]        newest, may overlap
   L1  [SST][SST][SST][SST]   non-overlapping, 10× bigger
   L2  [SST]...               10× bigger again
```

**Writes are extremely fast** — an in-memory insert plus a sequential WAL append. No tree traversal, no page reads, no random I/O. This is why LSM engines handle write-heavy workloads so much better.

**Reads are harder**, because a key may live in the memtable or *any* SSTable:

```diagram
   1. check memtable                        (in memory)
   2. check L0 SSTables, newest first
   3. check L1, L2, ... (binary search within each)
   ...until found
```

Three optimizations make this viable, and they're worth naming:

- **[Bloom filters](../02-building-blocks/bloom-filters.html)** per SSTable — skip files that definitely don't contain the key. This is the single most important read optimization; without it, a read might touch every level.
- **Sparse indexes** — an in-memory index of every Nth key per SSTable, so you seek to a block rather than scanning.
- **Block caching** of hot data.

Even so, a read may touch several files, and a read for a **non-existent** key is the worst case — it must check everything (which is why Bloom filters matter so much).

## Compaction

Immutable SSTables accumulate, and updates/deletes are just newer entries shadowing older ones. **Compaction** merges SSTables, discards overwritten values, and drops tombstones.

This is where LSM engines earn their reputation for operational subtlety:

**Size-tiered compaction** merges SSTables of similar size. Cheap on writes, but read performance suffers (many overlapping files) and it can transiently need ~2× the disk space during a large merge.

**Leveled compaction** keeps each level non-overlapping and ~10× the previous. Reads touch at most one file per level — much better and more predictable. Costs significantly more write amplification, since data is rewritten as it moves down levels.

The classic tradeoff, worth stating crisply:

```diagram
   Size-tiered  → better WRITE throughput, worse read latency,
                  more space amplification
   Leveled      → better READ latency, predictable space,
                  higher write amplification
```

**Deletes are the operational trap.** A delete writes a **tombstone**, not a removal. Space isn't reclaimed until compaction, and until then reads must still scan past tombstones. A workload that deletes heavily can build up so many tombstones that reads become dramatically slower — a well-known Cassandra pathology, and a great detail to mention if a design involves lots of deletion or TTL expiry.

**Compaction competes with foreground traffic** for disk and CPU. Poorly tuned compaction shows up as unexplained p99 spikes. This is the main reason LSM engines are considered operationally harder.

## Amplification — the three-way tradeoff

Every storage engine trades among three quantities, and you cannot minimize all three (the "RUM conjecture"):

- **Read amplification** — disk reads per logical read.
- **Write amplification** — bytes written per logical byte.
- **Space amplification** — disk used per logical byte.

| | B-tree | LSM (leveled) | LSM (size-tiered) |
|---|---|---|---|
| Read amp | Low (~1 page) | Medium (per level) | High (many files) |
| Write amp | Medium-high | High (rewrites on merge) | Lower |
| Space amp | Medium (fragmentation) | Low (~1.1×) | High (~2× transiently) |
| Write throughput | Moderate | **High** | **Highest** |
| Read latency | **Predictable** | Good | Variable |

:::goat The comparison that scores
"This workload is roughly 20:1 writes to reads, appending time-ordered events. That favours an LSM engine — writes become sequential appends to a memtable and WAL rather than random page updates, so throughput is much higher. The costs are that reads may touch several SSTables (mitigated by Bloom filters), and compaction consumes background I/O that shows up in p99 if it isn't tuned. If the workload were read-heavy with range scans over a moderate dataset, I'd take a B-tree for its predictable single-page reads instead."
:::

## Write-ahead logging

Both engines need durability before the real write lands, and both solve it the same way: append to a **write-ahead log** first, then do the actual work.

```diagram
   1. append change to WAL, fsync           ← durability point
   2. acknowledge the client
   3. modify pages / memtable in memory
   4. flush to their permanent home later

   Crash after 1 → replay the WAL on restart
```

The WAL is sequential, so it's fast; the expensive random work is deferred and batched. **`fsync` is the actual durability boundary** — an acknowledged write that hasn't been fsynced can vanish in a power loss, which is why "group commit" (batching several transactions' fsyncs) is such a common throughput optimization.

The WAL is also the source of [replication and CDC](cdc-outbox.html) streams — it's already an ordered record of every change.

**Checkpointing** bounds recovery time by periodically flushing dirty state and truncating the log. Long intervals mean less steady-state I/O and slower crash recovery.

## Choosing

| Workload | Engine |
|---|---|
| OLTP, mixed reads/writes, joins | **B-tree** (Postgres, MySQL) |
| Write-heavy, append-mostly, time-ordered | **LSM** (Cassandra, RocksDB) |
| Time series, telemetry, event logs | **LSM**, often with time-windowed compaction |
| Read-heavy with complex queries | **B-tree** |
| Embedded KV under another system | **LSM** (RocksDB is the default building block) |
| Analytics over huge scans | Neither — [columnar](olap-columnar.html) |

The practical caveat worth adding: **the engine is rarely the deciding factor by itself.** Query capabilities, transactions, operational familiarity, and ecosystem usually matter more. But when the workload is genuinely write-dominated at high volume, the engine difference is large enough to drive the decision — and being able to say exactly why is what makes the answer credible.

:::exercise Reason about amplification
1. Define read, write, and space amplification. For a B-tree and a leveled LSM tree, estimate each.
2. A workload is 95% writes of small records. Which engine, and by how much? Now make it 95% random point reads.
3. LSM compaction: leveled versus tiered. Which trades write amplification for read amplification, and in which direction?
4. Your LSM has 8 levels and a 1% Bloom false-positive rate per SSTable. How many disk reads for a key that does not exist?
5. A B-tree page split cascades to the root. When does this happen, and what does it cost? How does the fill factor change the frequency?
:::

:::paper B-trees versus LSM trees
Bayer & McCreight (1972) for the B-tree; O'Neil et al., *The Log-Structured Merge-Tree* (Acta Informatica, 1996) for the LSM tree.

*Optimal Bloom Filters and Adaptive Merging for LSM-Trees* (Dayan, Athanassoulis & Idreos, TODS 2018) and the *RUM Conjecture* (Athanassoulis et al., EDBT 2016) formalise the read/update/memory trade every storage engine navigates. RocksDB's tuning guide is the practical companion.
:::
