---
title: Quorums
summary: Why R + W > N works, what it does and does not guarantee, sloppy quorums, and the anti-entropy machinery that keeps leaderless replicas converging.
difficulty: Medium
tags: [quorum, replication, consistency]
prereqs: [replication, consistency-models]
---

## The idea

In a leaderless system ([Dynamo-style](../02-building-blocks/replication.html)), there's no primary to ask for the truth. Instead, clients contact multiple replicas and rely on **overlap**.

```diagram
   N = number of replicas holding each key
   W = replicas that must acknowledge a write
   R = replicas that must respond to a read

   If  R + W > N,  the read set and write set must
   share at least one replica → the read sees the write.
```

The picture, with N=3, W=2, R=2:

```diagram
   write to A, B (ack) ──►  A[v2]  B[v2]  C[v1]
                             ▲      ▲
   read from B, C ───────────┘      │
                    B has v2, C has v1
                    → overlap guarantees v2 is seen;
                      version numbers pick the winner
```

Any 2 of 3 replicas must include at least one of the 2 that took the write. Pigeonhole principle — that's the whole mechanism.

## Tuning the dials

The same N gives you very different systems:

| Config | Behaviour |
|---|---|
| N=3, W=2, R=2 | Balanced. Tolerates 1 failure for both reads and writes. **The default.** |
| N=3, W=3, R=1 | Very fast reads; writes fail if **any** replica is down. Good for read-heavy, rarely-written data. |
| N=3, W=1, R=3 | Very fast writes; reads must reach everyone. Rarely useful. |
| N=3, W=1, R=1 | Fastest, no overlap guarantee. Pure eventual consistency. |
| N=5, W=3, R=3 | Tolerates 2 failures. More durable, higher latency. |

**Latency implication:** you wait for the *W-th fastest* response, not the slowest — so higher N with the same W can actually *reduce* tail latency, because you have more replicas to race. That's a nice, non-obvious point to raise.

## What quorums do NOT give you

The most important part, and the part that is usually rushed.

**`R + W > N` does not give linearizability.** It guarantees a read *overlaps* a completed write. It does not guarantee a total order or real-time recency. Concretely:

- **Concurrent writes still conflict.** Two clients write different values to overlapping quorums simultaneously. Both succeed. Now replicas hold different values and something must resolve them — last-write-wins (lossy) or [version vectors](clocks.html) surfacing siblings.
- **Partial writes are not rolled back.** A write that reaches 1 of 3 replicas and then fails is reported as failed to the client — but that one replica *keeps* the value. A later read may return it. The failed write "succeeds" later.
- **Reads can go backwards.** Two successive reads hitting different replica subsets can return v2 then v1, violating monotonic reads.
- **No atomicity across keys.** Quorums are per-key.

:::goat The distinction worth naming
"Quorum overlap gives me *recency* on a per-key basis — a read will see the latest completed write. It doesn't give me linearizability: concurrent writes still conflict and need resolution, and a failed write can leave a value behind that shows up later. If I need true linearizability I need [consensus](consensus.html), not quorums." It is common to treat `R + W > N` as equivalent to strong consistency. It isn't, and saying so precisely is a real depth signal.
:::

## Sloppy quorums and hinted handoff

Strict quorums require W of the **designated home replicas** for a key. If enough of them are unreachable, the write fails — you've chosen consistency over availability.

**Sloppy quorum** takes availability instead: accept the write on *any* W reachable nodes, even ones that don't normally own the key.

```diagram
   Home replicas for key K: A, B, C.  A and B are unreachable.

   Strict quorum (W=2):  write FAILS
   Sloppy quorum:        write goes to C, D, E
                         D and E store a HINT: "this belongs
                         to A / B; deliver when they return"
```

**Hinted handoff** is the delivery half: D and E hold the data temporarily and forward it once A and B are healthy.

This substantially raises write availability — but note it *breaks the overlap guarantee entirely*. A read from a strict quorum of {A, B, C} may miss the write that landed on {C, D, E}. Sloppy quorums are a durability-and-availability mechanism, not a consistency one. Being precise about that distinction is what keeps the rest of the reasoning sound.

## Anti-entropy

With no leader ordering things, replicas drift. Three mechanisms pull them back together:

**1. Read repair.** During a read, the coordinator sees replicas returning different versions, returns the newest to the client, and writes it back to the stale replicas. Free repair for hot data — but cold data is never read, so it never gets repaired.

**2. Hinted handoff.** As above — covers temporary unavailability.

**3. Merkle trees.** For the cold data problem: a hash tree over each replica's key ranges.

```diagram
              root hash
             /         \
        h(A)             h(B)          Compare roots.
       /    \           /    \         Equal → identical, done.
    h1      h2       h3      h4        Differ → descend only
   /  \    /  \     /  \    /  \       into the differing subtree.
  keys keys keys  keys keys keys
```

Two replicas compare root hashes. If equal, they're in sync — one comparison for the whole range. If not, they descend only into subtrees that differ, so the amount of data exchanged is proportional to the number of *differences*, not the size of the dataset. This is what makes background repair affordable across terabytes.

## Quorum reconfiguration

An under-discussed subtlety worth knowing: changing N (adding or removing replicas) can break the overlap guarantee mid-transition, because old and new quorums may not intersect.

Systems handle this with **joint consensus** (Raft's approach — briefly require majorities in *both* old and new configurations) or by changing membership one node at a time, so consecutive configurations always overlap. If you're ever asked "how do you add a replica safely?", this is the answer.

## Quorum vs consensus

They're related but not the same thing, and mixing them up is common.

| | Quorum (Dynamo-style) | Consensus (Raft/Paxos) |
|---|---|---|
| Coordinator | None — any node | Elected leader |
| Ordering | None; conflicts possible | Total order guaranteed |
| Conflicts | Application/CRDT resolves | Impossible by construction |
| Consistency | Per-key recency (tunable) | Linearizable |
| Write path | Client → W replicas | Client → leader → majority |
| Availability | Higher (no election gap) | Lower (minority can't serve) |
| Best for | High-availability data stores | Coordination, metadata, locks |

Consensus *uses* quorums (a majority must ack), but adds a leader and a totally ordered log. Quorums alone give you overlap without order — which is cheaper, more available, and weaker.

## In an interview

The scoring answer connects the dials to the requirement:

> "I'll use N=3 across three availability zones with W=2, R=2. That tolerates one replica or one AZ failing without losing availability for reads or writes, and the overlap means a read sees the last completed write. It does *not* give me linearizability — concurrent writes to the same key will conflict, so I need a resolution strategy. For the like counter that's fine; I'd use a CRDT counter so conflicts merge correctly. If this were inventory, quorums wouldn't be enough and I'd move to a consensus-backed store."

That paragraph names the configuration, the failure tolerance, the guarantee, the *limit* of the guarantee, and the mitigation — and then shows where the whole approach stops being appropriate.

:::exercise Tune the quorum
1. N=3. Enumerate every (R, W) combination and, for each, state read consistency, write availability, and read latency.
2. With R=1, W=1 on N=3, how stale can a read be? What does the answer depend on?
3. Sloppy quorum with hinted handoff: what does it buy, and what guarantee does it break? Name a workload where that trade is right.
4. R + W > N gives you "strong-ish" consistency. Name precisely what it still does not give you, versus linearizability.
5. Your cluster is N=5 across 3 availability zones. One zone fails. Which (R, W) settings still work, and what does that imply about how you should place replicas?
:::

:::paper Quorum systems
Gifford's *Weighted Voting for Replicated Data* (SOSP 1979) is where R + W > N comes from. *Dynamo* (DeCandia et al., SOSP 2007) is the production system that made tunable quorums mainstream.

*Probabilistically Bounded Staleness for Practical Partial Quorums* (Bailis et al., VLDB 2012) is the important refinement: it quantifies how stale a partial quorum read actually is in practice, which turns out to be much less than the worst case.
:::
