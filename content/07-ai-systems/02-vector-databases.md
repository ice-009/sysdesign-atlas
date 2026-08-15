---
title: Vector Databases at Scale
summary: Sharding an ANN index, replication when the index is derived state, incremental updates, and why "just add a vector column" is often the right answer.
difficulty: Hard
scope: HLD
tags: [ai, vector-database, sharding, replication]
prereqs: [vector-search, sharding, replication]
unlocks: Operating vector retrieval as a real distributed system rather than a library call.
---

## What a vector database adds

[Vector search](vector-search.html) is an algorithm. A vector database is that algorithm plus everything a production system needs: durability, sharding, replication, filtering, transactions against metadata, backups, and multi-tenancy.

The first design decision is whether you need a separate one at all.

| Option | When it's right |
|---|---|
| **Library in-process** (FAISS, hnswlib) | Small, static corpus; you own the lifecycle; lowest latency |
| **Postgres + pgvector** | You already run Postgres; <10M vectors; you want real transactions and joins |
| **Dedicated vector DB** (Qdrant, Weaviate, Milvus, Vespa) | >10M vectors, high QPS, complex filtering, or you need the operational features |
| **Managed service** | You'd rather not operate an index rebuild at 3am |
| **Search engine with vectors** (Elasticsearch, OpenSearch, Vespa) | You need hybrid lexical+dense and already run one |

:::goat Postgres is the right answer more often than the discourse suggests
Under about 10 million vectors, `pgvector` with an HNSW index is genuinely competitive on latency, and it gives you things a dedicated vector database makes hard:

- **Transactional consistency** between the vector and its metadata. No dual-write problem, no "the document was deleted but the vector wasn't."
- **Joins.** Filter by anything in your schema, using the query planner you already understand.
- **One system to operate.** Backups, replication, monitoring, and access control you already have.

The dual-write problem is the underrated one. With a separate vector store, every write goes to two systems and they *will* diverge — a failed write, a partial rollback, a replay. You end up building [CDC or an outbox](../04-data/cdc-outbox.html) to keep them consistent, which is real work that Postgres gives you for free.

Reach for a dedicated store when you've measured that Postgres doesn't fit — not before.
:::

## Sharding

Above one machine's memory, the index must be partitioned. There are two ways, and they behave very differently.

```diagram
   RANDOM / HASH SHARDING            SEMANTIC / METADATA SHARDING

   vectors spread uniformly           vectors grouped by tenant,
   across N shards                    topic, or time

   Query → ALL shards                 Query → only relevant shards
           merge top-k                        (if the filter selects them)

   ✓ perfectly balanced               ✓ query touches 1 shard, not N
   ✓ recall is predictable            ✓ per-tenant isolation for free
   ✗ every query hits every shard     ✗ skew: one huge tenant
   ✗ p99 = slowest shard's p99        ✗ cross-shard queries hit all
   ✗ cost scales with shard count     ✗ needs the filter in every query
```

:::derive Why scatter-gather punishes you at the tail
```
   Random sharding, 16 shards, each with p99 = 20 ms.

   A query must wait for ALL 16 to return.

   P(all 16 under 20 ms) = 0.99^16 = 0.85

   → 15% of queries exceed 20 ms.
     Your effective p99 is roughly the shards' p99.7.

   With 64 shards:  0.99^64 = 0.53
     → nearly half your queries hit a slow shard.

   The tail gets worse as you add shards, which is the
   opposite of what people expect from scaling out.
```
:::

The standard mitigations: **hedged requests** (send to a replica after a delay, take whichever answers first), **partial results** (return after 15 of 16 shards answer, accepting slight recall loss), and — best where it applies — **avoid scatter-gather entirely** by sharding on the dominant filter.

**Shard by tenant if you can.** For a multi-tenant product where every query is scoped to one tenant, tenant sharding turns a 16-shard scatter into a single-shard lookup, makes the filter free, and gives you isolation. The problem is skew: your largest tenant may be 1,000× your median. The usual fix is to give large tenants dedicated shards and pack small ones together — the same approach as [sharding](../02-building-blocks/sharding.html) generally.

## Replication

Replication for vector indexes has a property that changes the design: **the index is derived state.** It can always be rebuilt from the source documents and the embedding model.

```diagram
   REPLICATE THE INDEX               REBUILD PER REPLICA

   build once, copy the index        each replica builds its own
   file to each replica              index from the source data

   ✓ fast — file copy                ✓ no large file transfer
   ✓ replicas are bit-identical      ✗ N× the build compute
   ✗ 50-200 GB per copy              ✗ replicas may differ slightly
   ✗ must rebuild-then-redistribute    (HNSW build is order-dependent)

   → build-once-and-copy is almost always right.
     Treat the index as an immutable artifact, exactly like
     a model checkpoint.
```

This framing — index as artifact — simplifies everything. Build in a batch job, version it, distribute it to replicas, and route reads to whichever replicas hold the current version. The same [distribution problem as model weights](../06-ai-infrastructure/model-deployment.html), with the same solutions.

## Updates

Most ANN indexes are built for read-heavy, append-light workloads. Real corpora change constantly.

```diagram
   LSM-STYLE, THE STANDARD PATTERN

     ┌─────────────────────────┐
     │  Base index (immutable) │   50M vectors, HNSW, on disk/RAM
     └─────────────────────────┘
     ┌─────────────────────────┐
     │  Delta index (mutable)  │   ~500K recent, in memory
     └─────────────────────────┘
     ┌─────────────────────────┐
     │  Tombstone set          │   deleted IDs, a bitmap or Bloom
     └─────────────────────────┘

   Query: search BOTH indexes, merge, drop tombstoned IDs
   Merge: periodically fold the delta into a new base,
          rebuild in the background, swap atomically
```

This is exactly the [LSM tree](../04-data/storage-engines.html) design, and for the same reason: writes go somewhere cheap and sequential, reads pay a small merge cost, and compaction happens off the critical path.

**Deletion is the awkward operation.** You cannot cleanly remove a node from an HNSW graph without damaging connectivity, so deleted vectors are tombstoned and filtered at query time. Over time the index fills with dead nodes: recall degrades (the graph routes through nodes that get discarded) and memory is wasted. The trigger for a rebuild is usually a tombstone ratio — commonly 10–20%.

**Freshness is a real requirement to negotiate.** "New documents searchable within 5 minutes" costs far less than "within 1 second." The delta index handles seconds if it's small; sub-second requires writing to the delta synchronously on the ingest path, which couples your write latency to index maintenance.

:::trap The dual-write problem will bite you
Document goes to Postgres. Embedding goes to the vector store. Two writes, no transaction.

```
   write to Postgres      ✓
   generate embedding     ✓
   write to vector store  ✗ (timeout)

   → the document exists and is unsearchable, permanently,
     and nothing reports an error
```

Or in reverse: delete from Postgres succeeds, delete from the vector store fails, and now search returns a document that no longer exists — often a data-access-control problem, not just a bug.

The fix is the [outbox pattern](../04-data/cdc-outbox.html): write the document and an "embed me" outbox row in one transaction, then have a worker consume the outbox and update the index idempotently. Reconciliation jobs that compare the two stores are also worth running — they will find drift.
:::

## Multi-tenancy

Three models, with a real security dimension:

| Model | Isolation | Cost | Notes |
|---|---|---|---|
| **Shared index, filter by tenant** | Weak — a filtering bug leaks data across tenants | Lowest | Filter correctness becomes a security control |
| **Namespace per tenant, shared cluster** | Good | Medium | Common default; overhead per namespace limits tenant count |
| **Index per tenant** | Strong | Highest | Right for large or regulated tenants |

The shared-index model deserves caution: the filter is now the only thing preventing cross-tenant data exposure, and post-filtering strategies that over-fetch and then discard are doing the filtering *after* the data has left the index. Test this path explicitly, and prefer pre-filtering or partitioning where tenant data is sensitive.

Most products end up hybrid — shared namespaces for the long tail of small tenants, dedicated indexes for large or regulated ones.

## What to monitor

| Signal | Why |
|---|---|
| **Recall@k against a golden set** | The only real quality signal; run it continuously, not once |
| **p50/p99 query latency, per shard** | Identifies the slow shard dragging your tail |
| **Index size and memory headroom** | Rebuilds need double; OOM at rebuild is a classic outage |
| **Tombstone ratio** | Triggers rebuild before recall degrades |
| **Delta index size** | If it grows unboundedly, merges aren't keeping up |
| **Indexing lag** | Time from document write to searchable |
| **Filter selectivity distribution** | A change here silently changes recall |

**Recall monitoring is the one teams skip.** Latency is easy to see and recall is invisible — an index can quietly return worse results for months. Maintain a fixed set of queries with known-correct answers, run them against production continuously, and alert on recall drift. Without it you have no idea whether your retrieval is working.

:::exercise Design the storage layer
A document platform: 200M documents across 5,000 customers. Largest customer has 30M documents, median has 8,000. Every query is scoped to one customer. 2,000 QPS, p99 target 50 ms. 500K documents change daily.

1. Total vector memory at 768 dims, float32, plus HNSW overhead at M=32. How many machines?
2. Shard by customer, or randomly? Work through what happens to the 30M-document customer under each.
3. With random sharding across 12 shards at 25 ms per-shard p99, what's your effective p99? Does that meet the target?
4. Design the update path for 500K daily changes. Delta index size, merge frequency, and what triggers a full rebuild.
5. Documents are also in Postgres. Write the consistency mechanism — what's in the transaction, what's in the worker, and how do you detect drift?
6. A customer requests deletion of all their data under GDPR, with a 30-day deadline. Walk through it. What's actually hard?
:::

:::paper Sources
*Milvus: A Purpose-Built Vector Data Management System* (Wang et al., SIGMOD 2021) is the clearest published description of a distributed vector database's architecture.

*Manu: A Cloud Native Vector Database Management System* (Guo et al., VLDB 2022) covers the disaggregated-storage design. Vespa's documentation on hybrid retrieval is unusually good on the filtering and ranking interaction.
:::

## What to carry forward

- **Postgres + pgvector handles more than people expect** — and avoids the dual-write problem entirely.
- **Scatter-gather makes the tail worse as you add shards.** Shard on the dominant filter if you can.
- **The index is derived state** — build once as an artifact, distribute to replicas.
- **LSM-style base + delta + tombstones** is the standard update pattern; rebuild at ~10–20% tombstones.
- **Dual writes will diverge.** Use an outbox and run reconciliation.
- **Filter correctness is a security control** in shared multi-tenant indexes.
- **Monitor recall continuously** against a golden set. Nothing else will tell you it broke.
