---
title: Design a Distributed Key-Value Store
summary: Building Dynamo from first principles — consistent hashing, quorums, vector clocks, anti-entropy, and the failure handling that makes it stay available.
difficulty: Hard
scope: HLD
tags: [case-study, dynamo, quorum, consistent-hashing]
prereqs: [consistent-hashing, quorums, replication]
---

:::interview Why this question
This is the *systems* question — no product to reason about, just distributed systems fundamentals. It's common at Google and Amazon for senior roles because it can't be answered from pattern-matching; you have to actually understand replication, quorums, and failure. Expect deep pushback on every component.
:::

## 1. Requirements

**Functional**
- `get(key)` and `put(key, value)`.
- Values are opaque blobs, up to ~1 MB.
- No queries by value, no joins, no transactions — say this explicitly, because the constraint is what makes the design possible.

**Non-functional**
- **Always writable.** Availability prioritized over consistency (the classic shopping-cart requirement: never reject an "add to cart").
- Tunable consistency per operation.
- Linear horizontal scale; add nodes without downtime.
- No single point of failure — a symmetric, peer-to-peer design.
- Low latency: p99 under ~10 ms.

**Clarifying questions:** Availability or consistency priority? Value size range? Do we need range scans (a big fork — that requires an ordered partitioner)? Single or multi-region?

## 2. Estimation

**1 PB of data**, 1M QPS, values averaging 10 KB.

```diagram
   Objects: 1 PB / 10 KB = 10¹¹ = 100 billion keys
   With replication factor 3: 3 PB physical

   At 4 TB usable per node: 3 PB / 4 TB = 750 nodes

   Per node: 1M QPS / 750 ≈ 1,300 QPS  ← very comfortable
   → this cluster is sized by STORAGE, not throughput
```

Knowing which resource sizes the cluster is a useful thing to state — it tells you that node count is driven by capacity, so you'd choose dense storage nodes and the design should optimize for storage efficiency.

## 3. Partitioning

[Consistent hashing](../02-building-blocks/consistent-hashing.html) with **virtual nodes**.

```diagram
   hash(key) → position on a ring
   key belongs to the first node clockwise

   Each physical node holds ~200 virtual nodes:
     ✓ even load distribution despite random placement
     ✓ on failure, one node's load spreads across MANY
       successors rather than landing entirely on one
     ✓ heterogeneous hardware via vnode count (weighting)
```

**Why virtual nodes are non-negotiable here:** without them, a node failure dumps all its keys onto exactly one successor, which may then also fail — cascading around the ring. With 200 vnodes, the load spreads across the whole cluster.

**Membership** propagates by [gossip](../03-distributed/gossip.html) — no coordinator, O(1) messages per node, converges in log(N) rounds. Every node learns the full ring, so any node can route any request. That's what makes the system symmetric: **there are no special nodes.**

## 4. Replication

Each key is stored on the **N successive distinct physical nodes** clockwise from its ring position (the *preference list*).

```diagram
   key K hashes between vnodes → walk clockwise, collecting
   distinct PHYSICAL nodes until we have N=3

   preference list for K: [node-7, node-12, node-3]
                           ▲ coordinator (first in list)
```

The "distinct physical" detail matters — if you naively take the next 3 *virtual* nodes, you can end up with 3 copies on the same machine. Candidates get this wrong regularly, and catching it is a nice depth signal.

For multi-AZ durability, skip nodes until you have replicas in 3 different availability zones.

## 5. Consistency — quorums

```diagram
   N = 3 replicas
   W = replicas that must ack a write
   R = replicas that must respond to a read

   R + W > N  →  read and write sets overlap → reads see
                 the latest completed write

   Default: W=2, R=2, N=3  — tolerates one failure on both paths
```

Full treatment in [Quorums](../03-distributed/quorums.html). The key points to state:

**Tunable per operation.** A shopping cart write uses W=1 (fastest, most available). A read of a config value uses R=3 to be safer. This is a *per-request* dial, not a cluster setting — and that flexibility is a headline feature.

**What it does NOT give you:** linearizability. Concurrent writes still conflict. A failed write can leave a value on one replica that surfaces later. Reads can go backwards. Being precise about this — rather than claiming "R+W>N means strong consistency" — is what separates a good answer from a memorized one.

## 6. Conflict resolution — vector clocks

Two clients write concurrently to the same key. Both succeed on different quorums. Now what?

**Last-write-wins by timestamp is wrong** — [clock skew](../03-distributed/clocks.html) means the write that really happened last may have a lower timestamp, so you silently lose data.

**Vector clocks** detect concurrency instead of guessing:

```diagram
   Each write carries a version vector: [(node, counter), ...]

   Client A writes → [(n1, 1)]
   Client B writes concurrently → [(n2, 1)]

   Comparing: neither dominates → CONCURRENT
   → store BOTH as siblings; return both on read
   → the client (or application) merges and writes back,
     which collapses them: [(n1,1),(n2,1),(n3,1)]
```

**The shopping cart is the canonical example:** merge by union. A partition might resurrect a removed item, but it can never lose an added one. That asymmetry is a deliberate business decision — a spurious item is a minor annoyance; a lost purchase is lost revenue. Framing it as a *product* choice rather than a technical one is a strong move.

**The cost:** vectors grow with the number of writers. Prune the oldest entries past a threshold, accepting rare false "concurrent" verdicts. Modern systems often prefer [CRDTs](../03-distributed/crdts.html), which merge automatically without surfacing siblings — worth mentioning as the evolution of this idea.

## 7. Failure handling

This is where the interview goes deep. Three mechanisms, each solving a different failure duration.

**Hinted handoff — temporary failure.**

```diagram
   Preference list for K: [A, B, C].  B is down.
   Write goes to A, C, and D (the next healthy node).
   D stores a HINT: "this belongs to B."
   When B returns, D delivers the data and drops the hint.
```

This is a **sloppy quorum** — it keeps writes succeeding during failures, at the cost of the overlap guarantee (a strict read quorum of A, B, C could miss a write that landed on D). Naming that tradeoff explicitly is exactly the kind of precision that scores.

**Read repair — passive, ongoing.** During a read, the coordinator sees divergent versions, returns the newest to the client, and writes it back to stale replicas. Free repair for *hot* data — but cold data is never read, so never repaired. Which motivates:

**Merkle trees — permanent failure and cold data.**

```diagram
              root hash
             /         \
         h(A)           h(B)      Compare roots.
        /    \         /    \     Equal → in sync, one comparison
      h1     h2      h3     h4    for the entire key range.
                                  Differ → descend only into
                                  the differing subtree.
```

Data exchanged is proportional to the number of *differences*, not the dataset size. This is what makes background repair affordable across a petabyte.

**Failure detection** uses gossip with indirect probing and a suspect state ([SWIM-style](../03-distributed/gossip.html)) — a GC-paused node shouldn't be evicted, and a single bad network path shouldn't look like a dead node.

## 8. Storage engine per node

[LSM tree](../04-data/storage-engines.html) — writes append to a memtable plus WAL, flush to immutable SSTables, compact in the background.

```diagram
   WRITE:  WAL append (sequential) + memtable insert  → very fast
   READ:   memtable → Bloom filter per SSTable → sparse index
           → block read
```

The [Bloom filter](../02-building-blocks/bloom-filters.html) per SSTable is essential: without it, every read for a missing key would scan every file at every level.

## 9. Request flow

```diagram
   PUT(key, value)
     1. client → any node (that node becomes coordinator)
     2. coordinator computes the preference list from the ring
     3. sends the write to the top N healthy nodes
     4. waits for W acks
     5. returns success (with the new version vector)

   GET(key)
     1. coordinator computes the preference list
     2. requests from N nodes, waits for R responses
     3. if versions differ:
          - one dominates → return it, repair the others
          - concurrent    → return all siblings to the client
```

**A nice property worth noting:** clients can cache the ring and route *directly* to a replica, eliminating the coordinator hop entirely — "zero-hop" routing. That takes a network round trip out of every request.

## 10. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| One node down | Hinted handoff keeps writes succeeding. Reads still meet R from remaining replicas. No user impact. |
| Whole AZ down | With AZ-aware placement, each key still has 2 of 3 replicas. W=2/R=2 still satisfiable — barely. Worth noting the margin is thin. |
| Network partition | **Both sides keep serving** (AP). Divergence resolved by vector clocks and Merkle repair when it heals. |
| Node permanently lost | Replace it; the new node bootstraps from replicas via Merkle comparison. Throttle this — replacement traffic competes with foreground reads. |
| Hot key | Consistent hashing spreads *keys*, not *load*. One key at 40% of traffic saturates its replicas. Needs caching or key-splitting. |

**Follow-ups:**
- *"How do you add a node?"* — it claims vnode positions, streams ranges from current owners, then the ring updates. Throttle the transfer; it's a lot of bytes.
- *"Range scans?"* — not supported by a random partitioner. Requires an ordered partitioner, which reintroduces hot spots on sequential keys. A genuine architectural fork worth naming.
- *"How would you add strong consistency?"* — put a [Raft group](../03-distributed/consensus.html) per partition instead of quorum replication. That's essentially the design of Spanner/CockroachDB, and it trades availability and latency for linearizability. Being able to describe *both* architectures and when each is right is a strong close.
- *"Secondary indexes?"* — either local (query every partition — scatter-gather) or global (a separate index, eventually consistent). Both have real costs; there's no free version.
