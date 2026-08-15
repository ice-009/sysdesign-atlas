---
title: Sharding & Partitioning
summary: How to split data across machines, choosing a partition key, hot spots and celebrity problems, and why cross-shard queries and resharding are the costs you must name.
difficulty: Hard
scope: HLD
tags: [sharding, partitioning, scale]
prereqs: [replication, indexing]
---

## When you actually need it

Sharding splits one logical dataset across multiple machines, each owning a subset. It's the **only** technique that scales writes and data volume — replicas give you read capacity, not write capacity.

It is also the most expensive decision in this curriculum to reverse. So the first thing to say in an interview is *when* you'd do it, not how:

- Working set no longer fits in RAM, so the buffer pool thrashes and reads hit disk.
- Write throughput exceeds one primary (~10–50K/s for tuned relational hardware).
- Data volume makes backups, restores, and schema migrations operationally impossible.
- A single instance's failure blast radius is unacceptable.

:::goat Say what you'd do first
"Before sharding I'd exhaust the cheaper options: better indexes, a read-through cache, moving cold data to archival storage, vertical scale, and functional splitting of tables onto separate databases. Sharding is a one-way door — cross-shard joins and transactions largely go away, and resharding later is a migration project. I'd only take it when writes or volume genuinely exceed one machine." That reasoning is what separates sharding as a decision from sharding as a reflex.
:::

## Partitioning strategies

### Range partitioning

Split by key ranges: users A–F on shard 1, G–M on shard 2, and so on.

**Good:** range scans stay on one shard (`WHERE created_at BETWEEN`), and the routing logic is trivially understandable.

**Bad:** hot spots are almost guaranteed. Partitioning by timestamp means **all writes go to the newest shard** while the others sit idle — the single most common sharding mistake. Partitioning by name means the shard holding "S" is far busier than the one holding "Q".

### Hash partitioning

`shard = hash(key) mod N`.

**Good:** excellent distribution, since a good hash destroys any skew in the original key.

**Bad:** range queries must hit **every** shard, because adjacent keys are scattered. And plain `mod N` is catastrophic when N changes — adding one node remaps nearly every key. Which is why:

### Consistent hashing

Map both keys and nodes onto a ring; a key belongs to the next node clockwise. Adding or removing a node moves only ~1/N of keys instead of nearly all of them. Essential for caches and for any system where membership changes routinely. Full treatment in [Consistent Hashing](consistent-hashing.html).

### Directory-based (lookup service)

Keep an explicit map from key (or key range) to shard.

**Good:** total flexibility. You can move a single hot tenant to a dedicated shard, rebalance arbitrarily, and split ranges without touching a hash function. This is how most large production systems actually work.

**Bad:** the directory is a new dependency on every request — it must be highly available and heavily cached. Usually served from a consensus store ([etcd/ZooKeeper](../03-distributed/consensus.html)) and cached in every client.

### Geographic / tenant partitioning

Shard by region (data residency, latency) or by customer (isolation, noisy-neighbor control). Common in B2B SaaS, where "one shard per large tenant, shared shards for small ones" is a standard and defensible pattern.

## Choosing the partition key

**This is the decision.** Everything else follows from it, and it is where the design is decided.

Four criteria:

1. **High cardinality** — enough distinct values to spread across shards. `country` for a global app has ~200 values and terrible skew; `user_id` has millions.
2. **Even distribution** — no single value should dominate.
3. **Matches your access pattern** — the key must be present in the majority of queries, or every query becomes a scatter-gather.
4. **Keeps related data together** — data you read together should live together.

Criteria 2 and 4 are often in tension, and saying so is worth points.

**Worked examples:**

| System | Key | Why |
|---|---|---|
| Chat app | `conversation_id` | All messages in a chat co-located; a conversation loads from one shard |
| Social posts | `user_id` | A profile page reads one shard |
| E-commerce orders | `customer_id` | Order history is single-shard; but "all orders today" is scatter-gather |
| Multi-tenant SaaS | `tenant_id` | Natural isolation boundary; matches nearly every query |
| Time-series metrics | `(metric_id, time_bucket)` | Compound key avoids the all-writes-hit-newest-shard problem |

:::trap Sharding a chat app by user_id
Tempting and wrong. A message between Alice and Bob would be written to *both* users' shards (duplication and consistency work), or reading a conversation would require querying two shards and merging. Sharding by `conversation_id` keeps each conversation whole — one shard serves the entire message history. The lesson generalizes: **shard by the entity you read together**, not by the entity that seems most natural.
:::

## Hot spots and the celebrity problem

Even a well-chosen key can produce skew, because real-world popularity follows a power law.

Shard by `user_id` and most users generate a trickle of traffic — but one account with 100 million followers puts enormous load on one shard. That shard is now your system's bottleneck while the others idle.

**Mitigations:**

- **Key salting / sub-partitioning.** Split the hot key across sub-partitions: `celebrity_id:0` … `celebrity_id:9`, writes distributed randomly, reads gather all ten. Fixes writes; makes reads more expensive.
- **Dedicated shards.** Detect hot keys and give them their own capacity. Requires directory-based routing — a concrete argument for that strategy.
- **Cache the hot key aggressively.** If it's read-hot rather than write-hot, a cache in front removes most of the load. Often the simplest fix.
- **Special-case the workload.** Social platforms typically don't fan out celebrity posts at all; followers pull them at read time. See [News Feed](../05-case-studies/news-feed.html).
- **Two-tier: local + distributed cache** so the very hottest keys are served from application memory without a network hop.

Detecting hot keys matters as much as fixing them: track per-key request rates (heavy-hitter sketches like count-min are the standard tool) and alert on skew.

## Cross-shard operations — the real cost

**Queries that don't include the shard key** must go to every shard (*scatter-gather*), which means:

- Latency becomes the **slowest** shard's latency — [tail amplification](../01-fundamentals/latency-throughput.html) at full force.
- Cost scales with shard count, not result size.
- Aggregation, sorting, and pagination must be merged in the coordinator layer, and `LIMIT 20 OFFSET 1000` becomes genuinely painful (each shard must return 1,020 rows so the coordinator can sort and slice).

**Joins across shards** essentially disappear. Standard responses:

- **Denormalize** so the join isn't needed.
- **Replicate small dimension tables** to every shard (reference data: countries, categories, product metadata).
- **Application-side join** — fetch from each shard and combine. Fine for small result sets.
- **Redundant storage by a second key** — keep a second copy sharded differently to serve the other access pattern, kept in sync via [CDC](../04-data/cdc-outbox.html).

**Transactions across shards** require [two-phase commit or a saga](../03-distributed/distributed-transactions.html), both of which are substantially more complex than a local transaction. The best answer is usually to choose the partition key so that transactions stay within one shard.

## Resharding

The operationally hardest part, and a favorite deep-dive question.

**Why it's hard:** you must move data while serving traffic, with no lost writes, no downtime, and a safe rollback path.

**Techniques:**

**Pre-splitting (virtual shards).** The standard trick. Create many more logical shards than physical nodes — say 1,024 logical shards across 8 machines, 128 each. Growing means *reassigning* logical shards to new machines, which is a metadata change plus a bulk copy, not a rehash of every key.

```diagram
   logical shard = hash(key) mod 1024      ← never changes
   physical node = directory[logical]      ← changes freely

   8 nodes  → 128 logical shards each
   16 nodes → 64 each   (move 512 shards, rehash nothing)
```

Choose the logical shard count generously up front. It's cheap to have too many and expensive to have too few.

**Live migration procedure:**

1. Mark the shard as migrating in the directory.
2. Bulk-copy a consistent snapshot to the destination.
3. Stream the changes made during the copy (CDC / replication log) until the destination is nearly caught up.
4. Briefly pause writes for that shard (milliseconds), apply the final delta.
5. Flip the directory entry; route to the new node.
6. Verify, then reclaim the old copy.

**Double-write** is the alternative: write to old and new simultaneously, backfill history, verify equality, then cut reads over. More application work, but easier to roll back — which frequently makes it the better choice.

## How to explain it

A compact, complete answer looks like this:

> "I'll shard on `conversation_id`. It has high cardinality, it's present in every read on the hot path, and it keeps a whole conversation on one shard so loading history is a single-shard query. The cost is that 'all messages for a user across conversations' becomes scatter-gather — I'd solve that with a separate index table sharded by `user_id`, kept in sync via CDC. For hot spots, a very large group chat could overload one shard; I'd detect that and sub-partition by time bucket. And I'd use 1,024 virtual shards from day one so growth is a directory update rather than a rehash."

Key, justification, named cost, mitigation, and an operational plan. That's the full shape.

:::exercise Choose a shard key and live with it
A multi-tenant SaaS: 50,000 tenants, largest is 2,000× the median, 4 TB total, growing 100 GB/month.

1. Propose a shard key. What breaks with `tenant_id`? With a hash of the row ID? With time?
2. Your largest tenant outgrows one shard. Walk through the options.
3. A query needs "all records across all tenants matching X". What does that cost under your scheme, and how would you serve it instead?
4. Design the resharding: how do you split a shard while serving traffic, and what is the cutover moment?
5. Estimate how long a full resharding takes at 4 TB, and what the failure recovery path is if it dies halfway.
:::

:::paper Partitioning at scale
*Bigtable* (Chang et al., OSDI 2006) and *Spanner* (Corbett et al., OSDI 2012) cover range partitioning with automatic splitting. *Slicer: Auto-Sharding for Datacenter Applications* (Adya et al., OSDI 2016) is Google's general sharding service and is unusually good on rebalancing.

Vitess and Citus both have public design documentation worth reading for how resharding is done without downtime.
:::
