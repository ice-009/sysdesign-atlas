---
title: Leader Election
summary: When you need a leader, how election works, split brain and fencing, and the designs that avoid needing a single leader in the first place.
difficulty: Medium
scope: HLD
tags: [leader-election, coordination, split-brain]
prereqs: [consensus, failure-modes]
---

## Why elect a leader

A leader is a designated node that performs a role no one else may perform simultaneously:

- **Accepting writes** in a primary-replica database, so ordering is unambiguous.
- **Running a scheduled job** exactly once across a fleet, not once per instance.
- **Owning a partition** — one consumer per Kafka partition, one worker per shard.
- **Coordinating** — assigning work, driving a rebalance, managing cluster membership.

The leader's real value is **serialization**. A single decision-maker turns a distributed coordination problem into a local one: no locks, no conflicts, no consensus per operation. That's a large simplification, and it's why the pattern is everywhere.

The cost is equally clear: the leader is a bottleneck for throughput, a single point of failure, and an availability gap during every election.

## How election works

Election *is* [consensus](consensus.html) — the cluster must agree on one value ("who is leader"), and disagreement is catastrophic. Three practical approaches:

### 1. Consensus-backed (etcd, ZooKeeper, Consul)

The standard production answer. Candidates race to create a key with a lease; exactly one wins.

```diagram
   etcd:  PUT /leader = node-A  if not exists,  lease 10s
          → winner renews the lease every ~3s
          → if it stops renewing, the key expires and
            others compete for it
```

ZooKeeper's idiom uses **ephemeral sequential nodes**: each candidate creates a node, lowest sequence wins, and each watches only its *immediate predecessor* — watching all of them causes a herd on every change. The node is ephemeral, so it vanishes automatically when the session dies. No TTL guessing required.

This is correct because the underlying store is linearizable — two nodes cannot both believe they hold the key.

### 2. Built into the protocol (Raft)

As covered in [Consensus](consensus.html): randomized election timeouts, terms, and majority votes, with the log-completeness rule preventing an out-of-date node from winning.

### 3. Simple algorithms (mostly of academic interest)

**Bully** — the highest-ID reachable node wins; it announces itself and others yield. Simple, chatty, and prone to repeated elections when the network is flaky.

**Ring** — election messages circulate around a logical ring accumulating IDs. Elegant, fragile in practice.

Both assume reliable failure detection, which doesn't exist. Real systems use consensus.

## Split brain

The defining failure. Two nodes each believe they are leader, usually because of a partition rather than a crash.

```diagram
   Before:   [A=leader]  B  C  |  D  E

   Partition splits the cluster:
     Left  {A, B, C} — A is still leader, has majority ✓
     Right {D, E}    — sees no leader, tries to elect one

   With majority quorum: D and E can only get 2 of 5 votes
                         → NO leader elected → safe ✓

   WITHOUT quorum (e.g. "highest ID wins"): E declares
                         itself leader → TWO LEADERS → divergence ✗
```

**Prevention layers, and a strong answer names more than one:**

**1. Majority quorum.** Only a partition containing more than half the nodes can elect. Since two disjoint majorities can't exist, two leaders can't be elected. This is why cluster sizes are odd — an even split would deadlock both halves.

**2. Fencing tokens.** Quorum prevents electing a second leader, but it doesn't stop the *old* leader from acting. A node that was partitioned may not yet know it lost leadership and can keep writing.

```diagram
   A is leader with epoch 7, gets partitioned (doesn't know it)
   B is elected leader with epoch 8
   B writes to storage → storage records max_epoch = 8
   A writes with epoch 7 → storage REJECTS (7 < 8) ✓
```

The **resource** enforces this, not the election service. Without it, election alone cannot guarantee single-writer semantics. Same mechanism as in [distributed locks](../02-building-blocks/distributed-locks.html) — and naming it in a leader-election discussion is a distinctly senior move.

**3. Lease self-fencing.** The leader stops acting the moment it fails to renew its lease, *before* the lease actually expires. Combined with a lease TTL longer than the leader's self-imposed stop threshold, this closes most of the window without relying on the resource.

**4. STONITH.** Forcibly power off or network-isolate the old leader. Brutal, effective, used in systems where correctness dominates.

## The availability gap

Every failover has a window where there is no leader and writes are rejected:

```diagram
   leader dies
      │  detection (heartbeat timeout)     ~5-30s
      │  election                          ~0.1-1s
      │  new leader initializes, catches up ~1-10s
      ▼
   writes resume                    TOTAL: seconds to a minute
```

**Detection dominates.** Everything else is fast. And the timeout is an unavoidable tradeoff: too short causes spurious failovers under load (which are *themselves* an outage, plus they risk data loss on every switch); too long means a real failure costs minutes.

Typical values: 5–15 s for databases where a false failover is expensive, 1–3 s where failover is cheap and quick.

:::goat Failovers aren't free
"I'd tune the failure detector conservatively — maybe a 10-second timeout — because a spurious failover is more expensive than a few extra seconds of outage. Each failover risks losing unreplicated writes with async replication, invalidates connection pools, and cold-starts caches on the new leader. Systems that flap between leaders are usually less available than systems that fail over slowly."

That inversion — that faster failover can reduce availability — is a genuinely senior observation.
:::

## Doing without a leader

Often the better design. Volunteer these:

**1. Partition ownership.** Instead of one leader for everything, assign each *shard* an owner. Losing one owner affects one shard, and throughput scales with shard count.

```diagram
   ONE LEADER               PARTITIONED OWNERSHIP
   all writes → A           shard 1 → A    shard 4 → A
   (bottleneck,             shard 2 → B    shard 5 → B
    full outage             shard 3 → C    shard 6 → C
    on failure)             (blast radius = 1/N)
```

This is how Kafka consumer groups, sharded databases, and cell-based architectures work. It's the single most useful alternative to global leadership.

**2. Leaderless replication.** [Quorums](quorums.html) — any node serves any request, conflicts resolved after the fact. No election, no failover gap, at the cost of weaker consistency.

**3. Make the work idempotent and let everyone do it.** If a scheduled job is [idempotent](idempotency.html), running it on all N instances is wasteful but correct. For cheap jobs this beats the complexity of election outright — and saying so is a good instinct.

**4. Deterministic assignment.** Hash the task to an instance. No coordination at all, as long as membership is agreed. Degrades gracefully — a wrong assignment during a membership change means a duplicate or a brief gap, not corruption.

## Practical checklist

If you propose leader election in an interview, be ready for these:

- **How is the leader elected?** Consensus store or Raft — not "highest ID."
- **How long until failure is detected?** Give a number and justify it.
- **What happens to in-flight work?** Does the new leader resume it, restart it, or drop it?
- **How do you prevent the old leader from acting?** Fencing tokens. This is the question the rest of the design has to answer.
- **What's unavailable during election?** Be specific — usually writes, while reads continue from replicas.
- **Do you actually need one?** The best answer is often partitioned ownership instead.

## The common mistake

Using a leader for the **data path** rather than the **control path**.

Routing every user request through an elected leader makes it your throughput ceiling and your blast radius. The right pattern, as with [consensus](consensus.html) generally:

```diagram
   CONTROL PLANE (leader, consensus)
     who owns what · membership · config · rebalancing
     → tiny volume, rarely changes, needs to be unambiguous
                    │
   DATA PLANE (no leader on the hot path)
     actual reads and writes, routed directly to the owning shard
     → huge volume, scales horizontally
```

Keep the leader in charge of *decisions*, not *traffic*. That framing answers most leader-election design questions correctly on its own.

:::exercise Handle the split brain
1. A leader is partitioned from its followers but is still serving clients. A new leader is elected. Both now accept writes. Enumerate three mechanisms that prevent this from corrupting data.
2. Why are election timeouts randomised? Compute the probability of a split vote with fixed timeouts across 5 nodes.
3. Leader leases let a leader serve reads without a quorum round trip. What assumption does that make about clocks, and what happens when it is violated?
4. Your leader election is backed by ZooKeeper. ZooKeeper is unavailable for 30 seconds. What should the current leader do, and what should the followers do?
5. Design a system where losing the leader for 10 seconds is acceptable, and one where it is not. What is structurally different about them?
:::

:::paper Electing and detecting
Chandra and Toueg's *Unreliable Failure Detectors for Reliable Distributed Systems* (JACM 1996) established what failure detection can and cannot guarantee, and is the theoretical basis for why perfect leader election is impossible in an asynchronous system.

The Raft paper (Ongaro & Ousterhout, ATC 2014) has the most readable practical election protocol, including the randomised timeouts that prevent split votes.
:::
