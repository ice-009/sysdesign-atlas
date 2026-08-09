---
title: Consensus — Raft & Paxos
summary: How a group of unreliable machines agrees on one value, Raft explained well enough to whiteboard, and why you should almost never implement it yourself.
difficulty: Hard
tags: [raft, paxos, consensus, replication]
prereqs: [replication, consistency-models, failure-modes]
---

## The problem

Get N machines to agree on a value, given that machines crash, messages are lost, delayed, and reordered, and no one has a reliable clock.

The guarantees a consensus protocol provides:

- **Agreement** — no two nodes decide different values.
- **Validity** — the decided value was proposed by someone.
- **Termination** — nodes eventually decide (given enough working nodes).

**FLP impossibility** proves that in a fully asynchronous system with even one possible crash failure, no deterministic algorithm guarantees all three. Real protocols sidestep this by assuming *partial synchrony* — the network is eventually well-behaved for long enough to make progress. They guarantee **safety always** (never disagree) and **liveness eventually** (make progress when the network cooperates). Stating that tradeoff is a strong signal.

## Why it matters

Consensus is the foundation under everything that must be unambiguous:

- **Leader election** — who is the primary?
- **Configuration and membership** — which nodes are in the cluster?
- **Distributed locks** with real safety.
- **Replicated state machines** — the general form. If every replica applies the same commands in the same order, they end in the same state. That's how a fault-tolerant database is built.

The last one is the key insight: **consensus on an ordered log gives you a fault-tolerant version of any deterministic service.**

## Raft

Designed for understandability, and it succeeded — Raft is what etcd, Consul, TiKV, and CockroachDB use. It decomposes into three pieces.

### Leader election

Each node is a **follower**, **candidate**, or **leader**. Time is divided into **terms** — logical, monotonically increasing epochs.

```diagram
   follower ──timeout, no heartbeat──► candidate
                                          │ requests votes
              ┌───────────────────────────┤
              │ majority votes            │ sees higher term
              ▼                           ▼
           leader ──────────────────► follower
              │ sends heartbeats
              └── stays leader while heartbeats succeed
```

- Followers expect heartbeats from the leader. If none arrives within a randomized **election timeout** (typically 150–300 ms), a follower becomes a candidate.
- The candidate increments the term, votes for itself, and requests votes.
- **Each node votes at most once per term**, and only for a candidate whose log is at least as up to date as its own.
- A candidate winning a **majority** becomes leader.

**Two details that matter and that interviewers probe:**

**Randomized timeouts** prevent split votes. If every node timed out simultaneously, they'd all become candidates, split the vote, and repeat forever. Randomization means one node almost always times out first.

**The "at least as up to date" rule** guarantees safety: a candidate missing committed entries cannot win, because a majority of nodes have those entries and will refuse to vote for it. This is what makes leader election safe rather than merely convenient.

### Log replication

```diagram
   client → LEADER
              │ 1. append to own log (uncommitted)
              │ 2. AppendEntries to all followers
              ▼
   ┌──────────┼──────────┐
   F1         F2         F3
   │ ack      │ ack      │ (slow/down)
   └──────────┴──────────┘
              │ 3. majority acked → entry is COMMITTED
              │ 4. apply to state machine, reply to client
              │ 5. followers learn commit index from next heartbeat
              ▼
           client gets response
```

Only the leader accepts writes. An entry is **committed** once a majority has it — at that point it is durable even if the leader dies immediately, because any future leader must have it (majority overlap).

The **Log Matching Property** keeps logs consistent: each `AppendEntries` includes the index and term of the *preceding* entry. A follower rejects the request if it doesn't match, and the leader walks backwards until it finds the point of agreement, then overwrites the follower's divergent tail. Logs converge to the leader's, always.

### Safety

The critical rule: **a leader only commits entries from its own term directly.** Entries from previous terms become committed indirectly, when a current-term entry above them commits. Without this restriction, a specific sequence of failures can cause a committed entry to be overwritten — a subtle bug that Raft's authors identified explicitly. You don't need to reproduce the derivation from memory, but knowing the rule exists is what stops you assuming safety you don't have.

## Paxos

The original, and notoriously harder to follow. Two phases:

1. **Prepare(n)** — a proposer picks a proposal number `n` and asks acceptors to promise not to accept anything numbered lower. Acceptors reply with the highest-numbered value they've already accepted.
2. **Accept(n, v)** — the proposer sends the value. If it learned of any previously accepted value in phase 1, **it must propose that value instead of its own** — this is the rule that guarantees agreement.

Basic Paxos decides **one** value. **Multi-Paxos** amortizes it: elect a stable leader, skip phase 1 for subsequent entries, and you get a replicated log — converging on essentially the same shape as Raft.

**Raft vs Paxos in one line:** they solve the same problem with the same quorum math. Raft prescribes a complete, understandable system (strong leader, log-first design); Paxos describes a more general algorithm that every implementer must complete differently. That's why new systems pick Raft.

**Variants worth naming:** *Fast Paxos* (fewer round trips, larger quorums), *EPaxos* (leaderless, commits commutative commands out of order, better for geo-distribution), *Flexible Paxos* (the observation that the two phases' quorums need only *intersect*, not both be majorities).

## Quorums and cluster size

Consensus needs a majority: `⌊N/2⌋ + 1`.

| Nodes | Majority | Failures tolerated |
|---:|---:|---:|
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |
| 7 | 4 | 3 |

**Note 3 and 4 tolerate the same number of failures.** Even-sized clusters give you nothing extra — they just add a node that must be maintained and coordinated with. This is why you always see 3, 5, or 7.

**More nodes ≠ better.** Every write needs a majority ack, so latency is bounded by the *median* node's response. Larger clusters mean more messages and slower commits. **5 is the standard choice** — tolerates two failures (so you can lose one node and still survive another during maintenance) without excessive coordination cost.

## The costs

- **Write latency** — at least one round trip to a majority. In-region, a few ms. Cross-region, 100 ms+, irreducibly. This is the [PACELC](../01-fundamentals/cap-pacelc.html) "else latency" cost made concrete.
- **Throughput is bounded by the leader.** All writes funnel through one node. You scale by **sharding into many independent Raft groups** — one per partition — which is exactly what Spanner, CockroachDB, and TiKV do.
- **Minority unavailability.** A partitioned minority cannot serve writes, or linearizable reads, at all. Consensus systems are firmly CP.
- **Read cost.** A linearizable read technically requires confirming you're still leader. Optimizations: **leader leases** (time-bounded assurance, so reads are local and fast — depends on bounded clock drift) and **ReadIndex** (confirm the commit index with a quorum heartbeat, cheaper than a full log entry).

:::interview Don't implement it
"I'd use etcd or ZooKeeper rather than implementing Raft. The algorithm is well specified, but the implementations that matter get their correctness from years of production exposure, fuzzing, and Jepsen testing — membership changes, log compaction, and snapshot transfer are where the subtle bugs live, not in the paper's pseudocode. I'd only build on top of it."

Knowing when *not* to build something is the harder judgment. Then show you understand what you're buying: leader election, a linearizable KV store, and watches.
:::

## Where to use consensus — and where not to

**Use it for** small, critical, low-write-volume state: cluster membership, shard assignment, feature flags, leader election, service discovery, distributed locks that must actually be safe.

**Don't use it for** bulk data. It's a coordination tool, not a storage engine. Routing every user write through a single Raft group is a common design error — you've reduced your write throughput to one machine's and added round trips.

**The standard architecture** puts consensus in the control plane and keeps it out of the data plane:

```diagram
   ┌──────────── control plane ────────────┐
   │  etcd (Raft): who owns which shard,   │   small, critical,
   │  cluster membership, config           │   rarely written
   └───────────────────┬───────────────────┘
                       │ read (cached aggressively)
   ┌───────────────────▼───────────────────┐
   │  data plane: sharded storage nodes    │   huge, hot,
   │  serving the actual reads and writes  │   no consensus
   └───────────────────────────────────────┘
```

Note that each shard may still run its *own* Raft group for its replicas — the point is that consensus is scoped per-shard, so total write throughput scales with shard count rather than being capped by a single group.

:::exercise Reason through the protocol
1. A 5-node Raft cluster partitions 3/2. What happens on each side to reads, writes, and leader election? Now 2/2/1 — what happens?
2. Why is a majority quorum the requirement, rather than any other fraction? Prove that two disjoint majorities cannot exist.
3. Adding nodes to a Raft group: does write throughput go up, down, or stay flat? What about read throughput, and what about availability?
4. A leader is elected, then immediately partitioned from all followers. It does not know this. How long can it continue believing it is the leader, and what stops it from serving stale reads?
5. Name three things in a real system that should be behind consensus, and three that absolutely should not. What distinguishes them?
:::

:::paper The consensus canon
Lamport's *The Part-Time Parliament* (1998) is Paxos, and is famously hard going; *Paxos Made Simple* (2001) is the readable version. *In Search of an Understandable Consensus Algorithm* (Ongaro & Ousterhout, ATC 2014) is Raft, and its explicit design goal was comprehensibility — read this one first.

*Paxos Made Live* (Chandra, Griesemer & Redstone, PODC 2007) is Google's account of what it actually takes to implement consensus correctly, and is the best argument for using an existing implementation.
:::
