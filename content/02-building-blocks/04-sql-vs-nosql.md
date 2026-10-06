---
title: SQL vs NoSQL — Choosing a Datastore
summary: A decision framework that goes beyond "relational vs document," the four NoSQL families and what each is genuinely for, and why the honest default is Postgres.
difficulty: Medium
scope: HLD
tags: [database, nosql, sql, storage]
prereqs: [consistency-models, cap-pacelc]
---

:::predict Guess first
1. Your service handles 500 queries a second. Postgres or Cassandra — and why?
2. "NoSQL is schemaless, so there's less modelling to do." True or false?
3. Do most large social networks store their social graph in a graph database?
:::

## The framing that scores

"SQL vs NoSQL" is a bad question, because NoSQL isn't one thing — a key-value store and a graph database have nothing in common. The question interviewers actually want answered is:

> **What are the access patterns, and what's the smallest system that serves them?**

Answer that, and the datastore choice usually falls out. Lead with the technology name and you've skipped the reasoning that gets scored.

:::interview The opening move
"Before I pick a database, let me state the access patterns: writes are ~3K/s appends keyed by user; reads are ~250K/s point lookups by post ID plus a range scan of a user's recent posts. There are no cross-entity joins on the hot path. Given that, I'd…" — now the conclusion is defensible, and a disagreement is about the *premise*, which is the argument worth having.
:::

## Relational databases

Postgres, MySQL, and friends. Data in tables with a fixed schema, related by keys, queried with SQL.

**What you actually get, and why it's more than people credit:**

- **ACID transactions across multiple rows and tables.** The killer feature. ACID is four promises about a group of changes: they all happen or none do (**atomic**), they leave the data obeying its rules (**consistent**), they don't see each other half-finished (**isolated**), and once confirmed they survive a crash (**durable**). Moving money between accounts, or reducing stock while creating an order, needs exactly that — and rebuilding it yourself on a store that doesn't offer it is genuinely hard.
- **A query planner.** You describe *what* you want; the database works out *how* to get it — which index to use, which table to read first. A new kind of question usually needs no redesign, just an index.
- **Joins** — combining rows from two tables in one query. This is what lets data stay **normalised**: each fact stored in exactly one place, so an update can't leave two copies disagreeing.
- **Constraints as guarantees** — foreign keys, uniqueness, checks. Correctness enforced by the database rather than hoped for in every application that touches it.
- **Decades of operational tooling**, and engineers who already know it.

**Real limits:**

- **Writes scale to one machine.** You can add read replicas freely, but the primary is the write ceiling — call it ~10–50K writes/s for tuned commodity hardware.
- **Horizontal sharding is manual and painful.** Once sharded, cross-shard joins and transactions largely go away, and you've kept the costs of SQL while losing its main benefits.
- **Rigid schema** — migrations on huge tables need care (though `ADD COLUMN` with a default is cheap in modern Postgres).

:::goat The honest default
"I'd start with Postgres." At the scale of most interview prompts, that's correct, and saying it confidently is a *senior* signal, not a naive one. Then add the threshold: "I'd revisit when sustained writes approach ~30K/s or the working set stops fitting in RAM." Candidates who reach for Cassandra at 500 QPS are demonstrating that they match technologies to prestige rather than to requirements.
:::

Note also that "SQL doesn't scale" is increasingly outdated: **NewSQL** systems (Spanner, CockroachDB, TiDB, Vitess, Aurora) offer horizontal scale with SQL and transactions, paying for it in latency (cross-node coordination) and cost. Naming this category is worth doing — it defeats the false dichotomy the question implies.

## The four NoSQL families

### Key-value stores
*Redis, DynamoDB, Memcached, Riak*

A dictionary spread across many machines. `get(key)`, `put(key, value)`. The value is **opaque** — the store treats it as a blob of bytes and can't look inside it, so you can't ask "find me all values where status is active".

**Strengths:** the simplest possible data model, which means it splits across machines perfectly — double the nodes, double the throughput. Single-digit-millisecond latency at essentially any scale.

**Limits:** you can only fetch by key. No querying by value, no joins, no range scans (unless the store adds sort keys, as DynamoDB does).

**Use for:** sessions, caching, feature flags, rate-limit counters, user preferences, shopping carts.

### Document stores
*MongoDB, DynamoDB, Couchbase, Firestore*

Self-describing documents (JSON-ish) in collections. Queryable *inside* the document, and nested structures are stored together.

**Strengths:** flexible schema (genuinely useful when different records have different fields — product catalogs, user-generated content). Fetching one aggregate is one read with no joins, since related data is embedded.

**Limits:** denormalization means duplicated data, so updates touch many documents. Cross-document transactions exist in modern versions but are not the design center. Joins are weak.

**Use for:** content management, catalogs, event/activity records, user profiles with varying fields.

**The modeling rule:** embed what you read together, reference what you update independently. Getting this wrong — either a 16 MB document because you embedded an unbounded array, or full normalization that reproduces SQL badly — is the usual failure.

### Wide-column stores
*Cassandra, ScyllaDB, HBase, Bigtable*

Every row is addressed by two things: a **partition key**, which decides *which machine* holds it, and a **clustering key**, which decides *what order* rows sit in on that machine. So "all messages in chat 42, newest first" is one partition read in sorted order — which is exactly why these stores are so fast at that shape of question.

**Strengths:** exceptional write throughput ([LSM-based](../04-data/storage-engines.html), so writes are sequential appends), linear scale, no single point of failure (peer-to-peer, no leader), tunable consistency, and outstanding performance for time-ordered range scans within a partition.

**Limits:** **you must know your queries before you design the tables.** Nothing works out a query plan for you, and joins don't exist. A question you didn't design for means a new table, filled by a new write path. Deleting doesn't remove data either — it writes a **tombstone**, a marker saying "this is gone", which is itself data you now have to read past until it's cleaned up.

**Use for:** time series, event logs, message history, IoT telemetry, feeds — anything write-heavy, append-mostly, and queried by a known key with a time range.

### Graph databases
*Neo4j, Neptune, JanusGraph*

Nodes and edges as first-class citizens, with relationship traversal as the primitive.

**Strengths:** multi-hop traversals ("friends of friends who like X") that would be self-joins of exponential cost in SQL run in time proportional to the result set, not the dataset.

**Limits:** hard to shard (relationships cross partitions by nature), narrower operational ecosystem, and often unnecessary — one or two hops is fine in a relational database with the right indexes.

**Use for:** social graphs, fraud rings, recommendation networks, permission hierarchies, knowledge graphs. Note that most large social networks do **not** use a graph database for the primary store; they use sharded MySQL or similar with a graph-shaped API layer on top. Knowing that is a nice piece of nuance.

## The decision framework

Walk these in order:

**1. Do you need multi-record ACID transactions?** If invariants span records — money, inventory, bookings — start relational. Everything else is a workaround.

**2. What's the write throughput?** Under ~10K/s sustained: single relational primary. Above ~50K/s: partitioned store, likely wide-column, or a sharded/NewSQL relational system.

**3. What's the data volume?** Under a few TB: one machine (with replicas). Hundreds of TB: distributed by necessity. Petabytes of blobs: object storage with metadata in a database.

**4. Are the access patterns known and stable?** Known and fixed → wide-column/KV is safe and fast. Evolving or ad-hoc → you want a query planner, i.e. SQL.

**5. What's the read:write ratio?** Very read-heavy → replicas plus caching, which favors relational. Write-heavy and append-only → LSM-based stores.

**6. What consistency does each operation need?** Per [the spectrum](../01-fundamentals/consistency-models.html) — and note it varies by operation, so **polyglot persistence** is normal and worth proposing.

## Polyglot persistence

Real systems use several stores, each for what it's good at. Proposing this — with justification, not as a shopping list — is a strong signal:

| Data | Store | Why |
|---|---|---|
| Users, orders, payments | Postgres | Transactions, constraints, ad-hoc queries |
| Sessions, rate limits | Redis | Sub-ms, TTL native, disposable |
| Message / event history | Cassandra | Write-heavy, time-ordered, huge volume |
| Photos, video | S3 + CDN | Cheap bytes; DBs are a terrible fit for blobs |
| Full-text search | Elasticsearch | Inverted index, relevance ranking |
| Feed / analytics rollups | ClickHouse / Druid | Columnar aggregation |
| Recommendations | Precomputed → Redis | Latency; compute offline |

The cost to acknowledge: every additional store is operational surface, another failure mode, another consistency boundary, and another thing on-call must understand. "I'd use three datastores here, and here's why each earns its place" is strong; naming seven without justification is the buzzword failure mode.

## Common traps

- **Choosing by scale you don't have.** Cassandra at 200 QPS is a mistake that costs you joins, transactions, and ad-hoc queries in exchange for nothing.
- **"NoSQL is schemaless, so no modeling needed."** Backwards. The schema moves from the database into your application, where it's enforced by nothing and understood by no one. NoSQL demands *more* upfront modeling because you can't fix mistakes with a new index.
- **Ignoring the join you'll need later.** Denormalization is a bet that the access pattern won't change. Sometimes right; make it knowingly.
- **Forgetting operational cost.** Managing a Cassandra ring is a specialist skill. If the team is three engineers, that's a real argument against it — and mentioning team/operational fit is a mature thing to say in a design interview.

:::exercise Justify the choice from the access pattern
For each workload, choose a store and defend it against the two nearest alternatives:

1. A user session store: 200K writes/s, 5-minute TTL, loss tolerable.
2. A financial ledger: 2,000 writes/s, must never lose or double-count, complex queries for reconciliation.
3. Product catalogue: 50M items, heavy filtered search, updated hourly.
4. IoT telemetry: 1M points/s, queried as time-range aggregates, retained 90 days.
5. A social graph: "friends of friends who like X", 500M edges.

Then: for each, name the *specific* query that would be painful in the store you rejected.
:::

:::paper The design space
Michael Stonebraker and Uğur Çetintemel's *"One Size Fits All": An Idea Whose Time Has Come and Gone* (ICDE 2005) is the argument for specialised stores, and it has aged well.

*Dynamo: Amazon's Highly Available Key-value Store* (DeCandia et al., SOSP 2007) and *Bigtable* (Chang et al., OSDI 2006) are the two papers that defined the NoSQL era; *Spanner* (Corbett et al., OSDI 2012) is the argument that you can have transactions at scale after all.
:::

## Check yourself

```recall
Q: What question should replace "SQL or NoSQL?"
A: What are the access patterns, and what's the smallest system that serves them? State the writes, reads and joins first; the datastore choice follows.

Q: What is the relational database's real ceiling, and what are its biggest strengths?
A: Writes go to one primary — roughly 10–50K a second on tuned hardware. In return: multi-row ACID transactions, a query planner, joins over normalised data, and constraints the database enforces.

Q: What does a key-value store give up for its near-perfect scaling?
A: You can only fetch by key: the value is opaque, so no querying by value, no joins and no range scans unless the store adds sort keys.

Q: Document stores: what's the modelling rule?
A: Embed what you read together; reference what you update independently. Unbounded embedded arrays and full normalisation are the two usual failures.

Q: Wide-column stores: what do the partition key and clustering key do, and what's the catch?
A: The partition key picks the machine; the clustering key orders rows within it, making "latest messages in chat 42" one sorted read. The catch: you design tables for known queries, and a new query means a new table and write path.

Q: When does a graph database earn its place?
A: For multi-hop traversals — friends of friends who like X, fraud rings — that would be costly self-joins in SQL. One or two hops are fine in a relational database with the right indexes.

Q: Walk the decision framework for picking a datastore.
A: Need multi-record transactions? Relational. Then check write throughput, data volume, whether access patterns are known and stable, the read:write ratio, and the consistency each operation needs.

Q: What does polyglot persistence cost?
A: Each extra store is more to operate, another failure mode and another consistency boundary. Justify every store; don't list seven.
```

## What to carry forward

- Start from access patterns; "SQL versus NoSQL" is the wrong question.
- The honest default is Postgres, with a stated threshold for when to revisit.
- Each NoSQL family is for a specific shape: key-value lookups, documents read whole, wide-column time ranges, graph traversals.
- NoSQL needs more up-front modelling, not less — the schema moves into your code.
- Mixing stores is normal, but each one must earn its operational cost; NewSQL breaks the false dichotomy.
