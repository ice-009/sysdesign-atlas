---
title: Replication
summary: Leader-follower, multi-leader and leaderless topologies; sync vs async and the data-loss window; replication lag and the failover problems it creates.
difficulty: Medium
scope: HLD
tags: [replication, availability, consistency]
prereqs: [consistency-models, cap-pacelc]
---

## Three reasons to replicate

Keep copies of the same data on multiple nodes for:

1. **Availability** — a node dies, another serves.
2. **Read scale** — reads spread across replicas. (Note: **writes do not scale this way** — that's [sharding](sharding.html). Confusing the two is a common early error.)
3. **Locality** — a replica near the user cuts latency.

The whole difficulty is that copies must stay in agreement while accepting writes.

## Leader–follower (primary–replica)

The dominant model. One node accepts writes; changes stream to followers, which serve reads.

```diagram
             writes
               │
               ▼
          ┌─────────┐
          │ LEADER  │───── replication log ────┐
          └─────────┘                          │
               │                    ┌──────────┼──────────┐
               ▼                    ▼          ▼          ▼
             reads             FOLLOWER 1  FOLLOWER 2  FOLLOWER 3
                                   │          │          │
                                   └──── reads ──────────┘
```

Simple and effective: one writer means no write conflicts, ever. Used by Postgres, MySQL, MongoDB, Redis, and most relational systems.

### What actually gets replicated

Worth knowing, since it drives real behavior:

- **Statement-based** — ship the SQL. Compact but dangerous: `NOW()`, `RAND()`, and auto-increment produce different results on each replica. Largely abandoned.
- **Write-ahead log (physical)** — ship the byte-level page changes. Exact and efficient, but couples replicas to the same storage engine version, which complicates zero-downtime upgrades.
- **Logical (row-based)** — ship "row X changed from A to B." Decoupled from storage format, so it supports version-mixed replication and, crucially, **[change data capture](../04-data/cdc-outbox.html)** into other systems.

## Synchronous vs asynchronous

The most important tradeoff in replication, and a guaranteed follow-up question. It comes down to one thing: **when the leader tells the user "saved", how many copies actually have it?**

**Asynchronous** — the leader saves and replies straight away; copying to the followers happens afterwards, in the background.

- Fast writes; leader unaffected by slow/dead replicas.
- **If the leader dies, unreplicated writes are lost.** Acknowledged to the user, then gone.

**Synchronous** — leader waits for replica acknowledgment before responding.

- Zero data loss on failover.
- Every write pays the replica's round trip (and its slowest moment). If the replica is down or slow, **writes block** — one replica failure becomes a total write outage.

**Semi-synchronous** — the practical compromise, and the right thing to propose. Wait for *one* replica (or a quorum) to acknowledge, others async.

```diagram
   Leader ──ack required──► Replica A   (sync: durability)
          ──fire & forget─► Replica B   (async: read scale)
          ──fire & forget─► Replica C
```

You get "at least two copies exist" durability without depending on all replicas being healthy. If the sync replica dies, most systems fail over the sync role to another rather than blocking.

:::interview Frame it as RPO
"Async replication means an RPO — recovery point objective, the amount of recent data you accept losing in a disaster — of a few seconds: if the leader dies we lose whatever hadn't shipped yet. For session data that's fine. For payments it isn't, so I'd use semi-sync: acknowledge only after one replica has the write. That costs about a millisecond of write latency in-AZ, and it's the difference between losing transactions and not." Connecting the mechanism to [RPO](../01-fundamentals/availability-slas.html) is the senior framing.
:::

## Replication lag and its symptoms

Async replication means followers are behind — usually milliseconds, occasionally minutes under load, hours if something is broken. Each lag symptom maps to a [session guarantee](../01-fundamentals/consistency-models.html):

**1. Read-your-writes violation.** User updates their profile, the read hits a lagging follower, the change appears lost.
*Fix:* route reads to the leader for N seconds after that user writes; or pin the session; or have the client carry the write's log position and require the replica to have reached it.

**2. Monotonic reads violation.** Refresh shows 51 comments, then 49, then 51 — successive reads hitting differently-lagged replicas.
*Fix:* pin each user to one replica (consistent hash on user ID).

**3. Causal violation.** A reply arrives before the post it replies to, because they came through replicas with different lag.
*Fix:* causal tracking, or co-locate causally related data on the same partition.

**Always monitor lag.** It's a leading indicator of trouble and it silently breaks correctness assumptions that nothing else will surface.

## Failover — where the real problems are

When the leader dies: detect failure, choose a new leader, redirect writes. Every step has a trap, and they compound.

**Detection is a guess.** You infer death from missing heartbeats. Too aggressive → unnecessary failovers. Too lax → long outages. There is no correct timeout.

**Split brain.** The old leader isn't dead, just partitioned. It keeps accepting writes while the new leader does too. Now two divergent histories exist and *someone's writes must be thrown away*.

*Mitigations:* **fencing tokens** — every new leader gets a number one higher than the last, and storage refuses writes stamped with an older number, so a deposed leader that wakes up mid-write is rejected; **STONITH** ("shoot the other node in the head" — forcibly power off the old leader); and requiring a majority to elect a leader, so the smaller side of a split can't crown one at all. Naming **fencing tokens** specifically is a strong depth signal — see [Distributed Locks](distributed-locks.html).

**Lost writes.** With async replication, a promoted follower is missing the leader's most recent writes. Those writes are gone, but they may have already been consumed elsewhere — if an order ID was returned to the user and cached downstream, discarding it creates inconsistency across systems.

**Choosing the right follower.** Promote the most up-to-date one (highest log position) to minimize loss.

## Multi-leader replication

Multiple nodes accept writes and replicate to each other. Used for multi-datacenter setups, offline-capable clients, and collaborative editing.

**The benefit:** writes are local, so latency is low and each region stays available if the link between regions breaks.

**The cost:** **write conflicts are now possible and unavoidable.** Two users edit the same record in two regions concurrently; both writes are accepted; they must be reconciled.

Conflict resolution options:
- **Last-write-wins** — simple, silently discards data, and depends on synchronized clocks you don't have.
- **Per-field merge** — apply the latest value per field rather than per record. Better, still lossy.
- **[CRDTs](../03-distributed/crdts.html)** — structures that converge by construction. The principled answer when the data type allows.
- **Surface both versions** to the user or application.
- **Avoid conflicts by design** — route all writes for a given entity to one region ("home region" / partitioned ownership). Very often the right answer, and worth proposing before conflict resolution.

## Leaderless replication

No leader; clients (or a coordinator) write to several replicas directly. The Dynamo model — Cassandra, Riak, DynamoDB internally.

**Quorums** provide the consistency dial:

```diagram
   N = replicas holding each key
   W = replicas that must ack a write
   R = replicas that must respond to a read

   If  R + W > N  →  read and write sets overlap
                     → reads see the latest write

   N=3, W=2, R=2  → balanced (the usual default)
   N=3, W=3, R=1  → fast reads, writes fail if any replica is down
   N=3, W=1, R=1  → fastest, weakest; no overlap guarantee
```

Because there's no leader, there's no failover and no split brain — any node can serve any request. That's the model's real appeal: no election, no promotion, no downtime window.

Anti-entropy mechanisms keep replicas converging: **read repair** (the coordinator notices a stale replica during a read and fixes it), **hinted handoff** (a live node temporarily stores writes destined for a down node), and **Merkle tree comparison** for efficient background reconciliation. See [Quorums](../03-distributed/quorums.html) for why `R + W > N` is weaker than linearizability.

## Choosing a topology

| Requirement | Topology |
|---|---|
| Standard web app, read-heavy | Leader–follower, async, semi-sync for durability |
| Zero data loss on failover | Leader–follower, semi-sync (quorum ack) |
| Multi-region low-latency writes | Multi-leader with per-entity home region |
| Always-writable, partition-tolerant | Leaderless with quorums |
| Strict correctness across regions | Consensus (Raft/Paxos) — see [Consensus](../03-distributed/consensus.html) |

The line to remember for interviews: **replication solves reads and availability; sharding solves writes and data volume.** Most real systems need both, and stating which problem you're solving before drawing replicas keeps the discussion precise.

:::exercise Reason about replication lag
1. Async replication with 200 ms average lag. A user posts a comment and immediately reloads. What do they see, and name the consistency guarantee that is being violated.
2. List four distinct mechanisms for fixing that, and the cost of each.
3. Your replica falls 90 seconds behind during a batch job. Which reads are now wrong, and how would a client know?
4. Semi-sync replication: the primary waits for one replica to *receive* the write. Exactly which failure does this protect against, and which does it not?
5. Compute the RPO for async, semi-sync, and quorum commit, in seconds of acknowledged writes.
:::

:::paper Replication protocols
*Chain Replication for Supporting High Throughput and Availability* (van Renesse & Schneider, OSDI 2004) is an elegant alternative to primary-backup with strong guarantees.

*PNUTS: Yahoo!'s Hosted Data Serving Platform* (Cooper et al., VLDB 2008) introduced per-record timeline consistency. For the failure modes, Kyle Kingsbury's Jepsen reports on MySQL, Postgres, and MongoDB replication are the empirical record.
:::
