---
title: Consistency Models
summary: The spectrum from linearizability to eventual consistency, the session guarantees that solve most real problems cheaply, and how to pick one without saying "strong" or "eventual."
difficulty: Hard
scope: Core
tags: [consistency, linearizability, replication]
prereqs: [cap-pacelc]
---

## Why there's a spectrum

A consistency model is a **contract between the storage system and you**: given a set of concurrent operations, which return values are legal?

The stronger the model, the more the system must coordinate, and coordination costs round trips and availability. So this is not a quality ladder where stronger is better — it's a price list. Your job is to buy the weakest model that keeps the product correct.

Most discussions use only two words, "strong" and "eventual" — and the entire interesting middle is where good designs live.

```diagram
  STRONGER / more coordination / slower / less available
     ▲
     │  Linearizability        single copy, real-time order
     │  Sequential             single order, no real-time guarantee
     │  Causal                 causally related ops ordered
     │  Session guarantees     per-client promises (RYW, monotonic)
     │  Eventual               converges, eventually, somehow
     ▼
  WEAKER / cheap / fast / highly available
```

## Linearizability (strong consistency)

**The contract:** the system behaves as if there is exactly one copy of the data, and every operation takes effect atomically at some instant between its invocation and its response. Once a write completes, *every* subsequent read — from any client — sees it or something newer.

That "real-time" clause is what makes it strong and expensive. It links the ordering to wall-clock reality, not just to some internally consistent story.

```diagram
  LINEARIZABLE                        NOT LINEARIZABLE

  W(x=1) ├──┤                         W(x=1) ├──┤
  R(x)        ├──┤ → 1                R(x)        ├──┤ → 1
  R(x)            ├──┤ → 1            R(x)            ├──┤ → 0  ✗
                                                   (went backwards
                                                    in time)
```

**Cost:** every read must confirm it isn't stale — via consensus, a quorum, or a leader lease. Minimum one round trip to a majority. Cross-region, this means 100 ms+ per operation, and during a partition the minority stops serving.

**Where it's required:** distributed locks and leader election, uniqueness constraints, inventory decrements on the last unit, account balance before a withdrawal, anything where the read *causes an irreversible action*.

**Systems:** etcd, ZooKeeper, Spanner, single-node Postgres, DynamoDB with `ConsistentRead=true`.

## Sequential consistency

All operations appear in *some* single total order that respects each individual client's program order — but that order need not match real time. If Alice writes and then Bob (having never talked to Alice) reads, Bob may legally see the old value.

Weaker than linearizability, rarely offered as an explicit database guarantee, but useful vocabulary: it's the difference between "there's one agreed history" and "that history matches the clock on the wall."

## Causal consistency

**The contract:** operations that are causally related are seen in the same order by everyone. Concurrent (unrelated) operations may be seen in different orders by different observers.

Causality is defined by the happens-before relation: if you read X and then write Y, Y may depend on X, so everyone must see X before Y.

The canonical motivating failure:

```diagram
  Alice:  "I lost my keys!"          (post P1)
  Bob:    "Glad you found them!"     (reply P2, depends on P1)

  Carol's replica receives P2 before P1:

      "Glad you found them!"    ← nonsense
      "I lost my keys!"
```

Causal consistency makes this impossible while still allowing two unrelated posts to arrive in any order — which is fine, since nobody can tell.

**This is the sweet spot for social systems.** It's the strongest model that remains fully available during partitions, which is a genuinely remarkable result. Implemented with vector clocks, dependency tracking, or [hybrid logical clocks](../03-distributed/clocks.html).

:::goat Naming causal consistency is a senior signal
The usual instinct is to jump between "strong" and "eventual" and ignore everything in between. Saying "I need causal here — comment ordering breaks under eventual, but I don't need linearizability, and causal stays available under partition" demonstrates you know the middle of the spectrum exists.
:::

## Session guarantees — the practical workhorses

These are per-client promises. They're cheap, they're composable, and they solve the overwhelming majority of user-visible consistency bugs.

**Read-your-writes.** A client always sees its own writes. Without it: you edit your profile, the read hits a lagging replica, your change appears to vanish, you edit again — and now you have a duplicate or an angry user.

*Implementations:* route a user's reads to the primary for N seconds after a write; pin the session to one replica; or have the client carry the write's version token and require the replica to have caught up to it.

**Monotonic reads.** Time never goes backwards for one client. Without it: refresh shows 51 comments, refresh again shows 49 (you hit a more-lagged replica), refresh again shows 51.

*Implementation:* pin the client to a replica by consistent hashing on user ID, or track the highest version seen and never serve older.

**Monotonic writes.** A client's own writes apply in the order issued. Without it, "create doc" and "rename doc" can land out of order and the rename fails.

**Writes-follow-reads.** If you read a value and then write, your write is ordered after the value you read — the mechanism behind sensible reply threading.

:::tip The 90% fix
When a design has replication lag and a user-visible correctness problem, the answer is usually **not** "make it strongly consistent." It's usually **read-your-writes for that one flow.** Costs one routing rule, preserves replica scaling for everything else. Reaching for this before reaching for linearizability is usually the correct instinct, and much cheaper.
:::

## Eventual consistency

**The contract:** if writes stop, all replicas eventually converge. That's the whole promise — no bound on "eventually," no guarantee about what you see in the meantime.

It's the weakest useful model, and it's genuinely fine for a lot of data: view counts, recommendation feeds, search indexes, denormalized aggregates, DNS.

Its two failure modes to be ready for:

1. **Conflict resolution.** When two replicas take conflicting writes, someone must decide. Last-write-wins is easy and silently destroys data. See [CRDTs](../03-distributed/crdts.html) for the principled alternative.
2. **Unbounded staleness.** "Eventually" can mean hours if a replica is partitioned. Production systems monitor and alarm on replication lag precisely because the model gives no guarantee.

## Isolation is a different axis

A frequent confusion worth pre-empting: **consistency models describe replication; isolation levels describe concurrent transactions.** They're orthogonal.

- *Consistency:* "I have five copies of this data — what can a reader see?"
- *Isolation:* "Two transactions are interleaving — what anomalies are possible?"

Serializable isolation on a single node says nothing about replica freshness. Linearizability on a key-value store says nothing about multi-key transactions. **Strict serializability** is the combination of both, and it's the strongest (and most expensive) guarantee on offer — Spanner's headline feature. See [Transactions & Isolation](../04-data/transactions-isolation.html).

## Choosing, concretely

Ask three questions:

1. **What's the cost of a stale read?** Wrong like-count → nothing. Wrong balance → money moves incorrectly. This alone eliminates most of the spectrum.
2. **Does a read cause an irreversible action?** Reading inventory to *display* it can be stale. Reading inventory to *decide whether to sell* cannot.
3. **What does the user perceive?** Users notice their *own* changes disappearing far more than they notice other people's changes arriving late. Hence: session guarantees buy most of the perceived correctness of strong consistency for a fraction of the cost.

| Data | Model | Reasoning |
|---|---|---|
| Account balance (for transfer) | Linearizable | Read drives an irreversible action |
| Seat / ticket assignment | Linearizable | Double-booking is unrecoverable |
| Username registration | Linearizable | Uniqueness is a hard invariant |
| Your own profile edits | Read-your-writes | Only *you* notice the lag |
| Comment threads | Causal | Replies must follow parents |
| Feed timeline | Eventual + monotonic | Staleness invisible; going backwards is not |
| Like / view counts | Eventual | Approximation is acceptable by design |
| Search index | Eventual | Seconds of lag is expected behavior |

## The sentence worth remembering

> "Different data in this system needs different guarantees, so I'll pick per operation rather than globally. The transactional core — inventory and payment — needs linearizability, and I'll accept the coordination cost there. Feed and counters go eventual for availability and latency. The one place I'd add a session guarantee is the user's own posts: read-your-writes, so their content never appears to vanish after they publish it."

That sentence contains a model choice, a justification, an acknowledged cost, and a user-facing consideration — which is precisely the four-part structure the [rubric](../10-appendix/what-interviewers-score.html) rewards.

:::exercise Pick the weakest model that works
For each, name the weakest consistency model that is still correct, and say what breaks one level below it:

1. A user edits their profile and immediately reloads the page.
2. Two users bid on the same auction item in the final second.
3. A social feed shows like counts.
4. A bank transfer between two accounts at the same institution.
5. A user reads a comment thread, refreshes, and must not see comments disappear.
6. A distributed lock protecting a payment capture.

Then: for the ones that needed strong consistency, estimate what a cross-AZ round trip costs on that path, and whether the operation's rate makes that acceptable.
:::

:::paper The consistency hierarchy
Herlihy and Wing's *Linearizability: A Correctness Condition for Concurrent Objects* (TOPLAS, 1990) is the definition. Lamport's *How to Make a Multiprocessor Computer That Correctly Executes Multiprocess Programs* (1979) defines sequential consistency.

Peter Bailis et al., *Highly Available Transactions: Virtues and Limitations* (VLDB 2014) maps which guarantees survive a partition. Kyle Kingsbury's consistency-model map (jepsen.io/consistency) is the best visual reference for how they relate.
:::
