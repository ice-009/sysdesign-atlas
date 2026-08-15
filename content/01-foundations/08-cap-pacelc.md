---
title: CAP, PACELC & the Real Tradeoff
summary: Why "pick two of three" is wrong, what a partition actually forces you to choose, and the tradeoff that matters far more in practice — the one you make when nothing is broken.
difficulty: Medium
scope: Core
tags: [cap, consistency, availability]
prereqs: [scalability-basics, networking]
---

## The theorem, stated correctly

CAP is the most-cited and most-misquoted idea in system design. The pop version — *"pick two of Consistency, Availability, Partition tolerance"* — is wrong in a way that leads to real design errors.

The actual statement:

> In the presence of a **network partition**, a distributed system must choose between **consistency** and **availability**.

The terms, precisely:

- **C (Consistency)** — here meaning *linearizability*: every read sees the most recent completed write, as if there were a single copy of the data. Note this is **not** the C in ACID, which is about invariants. Same letter, different concept, and conflating them produces genuinely wrong designs.
- **A (Availability)** — every request to a *non-failed* node receives a non-error response. Note: it says nothing about latency. A response after 90 seconds is "available" by this definition, which is one reason CAP is less practically useful than it appears.
- **P (Partition tolerance)** — the system continues operating when the network drops or delays messages between nodes.

## Why "pick two" is nonsense

**You do not choose P.** Partitions are a property of networks, not a design option. Cables get cut, switches fail, routes flap, a datacenter loses connectivity. If your system spans more than one machine, partitions *will* happen.

So "CA" is not an available choice for a distributed system. Claiming CA means claiming your network never fails — and when it does, you get neither C nor A.

The real decision is binary and only applies during the partition:

```diagram
              Partition happens: nodes A and B can't talk

    ┌──────────────────────────┬──────────────────────────┐
    │  CP: choose consistency  │  AP: choose availability │
    ├──────────────────────────┼──────────────────────────┤
    │  Minority side REFUSES   │  BOTH sides ACCEPT       │
    │  reads/writes            │  reads/writes            │
    │                          │                          │
    │  ✓ never returns stale   │  ✓ always answers        │
    │  ✗ some users see errors │  ✗ replicas diverge;     │
    │                          │    must reconcile later  │
    └──────────────────────────┴──────────────────────────┘
```

There's no third door. Either you refuse to answer without confirmation you're current, or you answer and risk being wrong.

:::interview How to say it
"CAP is really about what happens during a partition. Since I can't avoid partitions, my choice is whether the minority side rejects requests to stay correct, or serves them and reconciles later. For a payment ledger I'd take CP — a declined transaction is recoverable, a double-spend isn't. For a like counter I'd take AP, because showing a stale count for a few seconds is invisible to users."

That framing takes fifteen seconds to state and is materially more accurate than "pick two."
:::

## CP in practice

The minority side stops serving. Concretely: a system using majority quorums (Raft, Paxos, ZooKeeper, etcd, Spanner, HBase, and MongoDB in its default configuration) elects a leader on the majority side. The minority — say 2 of 5 nodes — can't reach quorum, so it rejects writes and (for linearizable reads) rejects reads too.

**Consequence:** if your cluster splits 3/2, roughly 40% of your capacity goes dark rather than serve possibly-stale data.

**Right for:** financial ledgers, inventory with hard limits (last concert ticket), unique username assignment, distributed locks, configuration and service discovery, anything where two answers can't both be right.

## AP in practice

Every node keeps serving from whatever it has. Writes are accepted on both sides, so replicas diverge and must be reconciled when the partition heals.

Reconciliation strategies, weakest to strongest:

- **Last-write-wins** by timestamp. Simple; silently loses data, and depends on clock sync you don't have. Fine for caches, dangerous for user data.
- **Vector clocks / version vectors** — detect concurrent writes and surface siblings to the application. Correct, but pushes the merge decision onto you.
- **[CRDTs](../03-distributed/crdts.html)** — data structures that mathematically converge regardless of order. The best option when your data fits one (counters, sets, text).
- **Application-level merge** — a shopping cart union, a "you have conflicting edits" prompt.

**Right for:** social feeds, view/like counters, product catalogs, shopping carts, DNS, session stores, anything where availability beats momentary precision. Dynamo, Cassandra, Riak, and CouchDB sit here.

:::trap "Cassandra is AP, therefore inconsistent"
Cassandra is tunable per query. With `QUORUM` reads *and* `QUORUM` writes on RF=3, you get R + W > N, which gives strong-ish consistency for those operations — and you've traded away availability, since a partition can leave you unable to reach quorum. The label describes the default posture, not a fixed property. Saying "it's tunable per operation, and here's the R + W > N condition" is a materially stronger answer.
:::

## PACELC — the more useful model

CAP only says anything about partitions, which are rare. PACELC (Abadi, 2010) extends it to the 99.9% of the time when the network is fine:

> **If Partition** → choose **A**vailability or **C**onsistency.
> **Else** → choose **L**atency or **C**onsistency.

The `ELC` half is the one that shapes your architecture day to day. Even with a perfect network, strong consistency requires **coordination**, and coordination requires **round trips**. A linearizable write across three replicas in three availability zones costs at least one cross-AZ round trip. Across regions, it costs tens to hundreds of milliseconds — irreducibly.

So the everyday tradeoff is: **do you pay latency on every single operation to guarantee freshness?**

| System | Partition | Else | Reading |
|---|---|---|---|
| Spanner | PC | EC | Consistency always; pays latency (TrueTime commit-wait) |
| DynamoDB (default) | PA | EL | Fast and available; eventually consistent reads |
| DynamoDB (strong reads) | PC | EC | Opt into consistency per request, pay for it |
| Cassandra (default) | PA | EL | Tunable, but defaults to speed |
| MongoDB (default) | PC | EC | Majority writes to primary |
| Redis (async replica) | PA | EL | Replication is async; failover can lose writes |
| PostgreSQL (sync replica) | PC | EC | Commit waits for standby ack |

:::goat Use PACELC unprompted
"This is really a PACELC question. Partitions are rare, so the more important decision is the ELC side: do I pay a cross-AZ round trip on every read for freshness? For the profile service, no — I'll read from a local replica and accept ~200ms of staleness. For the balance check before a transfer, yes — I'll pay the round trip." That framing lands as unusually well-read.
:::

## Consistency is per-operation, not per-system

The strongest correction to the whole CAP framing: **real systems don't pick one point on the spectrum.** They pick one *per operation*, because different data has different costs of being wrong.

In a single e-commerce system:

| Operation | Choice | Why |
|---|---|---|
| Add to cart | AP | Never block a purchase; merge carts on conflict |
| Product reviews | AP | Stale by 30s is invisible |
| Inventory display | AP | "In stock" can be approximate |
| **Checkout / decrement stock** | **CP** | Overselling is a real cost |
| **Payment capture** | **CP** | Non-negotiable |
| Order history | AP (read replica) | Slightly stale is fine |
| Recommendations | AP | Precomputed, staleness expected |

Notice how little of the system needs strong consistency — typically only the transactional core. Recognizing that lets you keep the fast, cheap, available path for most traffic and pay for coordination only where it's genuinely required. That is what mature architectures actually look like, and saying so is a strong signal.

## What CAP doesn't tell you

Be ready for this pushback, because it's the follow-up a strong interviewer asks:

- **It ignores latency.** A system that responds in 30 seconds is "available." Users disagree. In practice, a slow response and an error are the same thing.
- **It's binary.** Real partitions are partial and asymmetric — one node reachable from some peers, high packet loss rather than a clean break, gray failures where a node is up but useless.
- **Its "C" is only linearizability.** There's a whole spectrum of useful weaker guarantees — causal consistency, read-your-writes, monotonic reads — that CAP flattens into "not C". See [Consistency Models](consistency-models.html); those middle options are where most good designs actually live.
- **It says nothing about durability**, which is often the property people actually cared about.

:::exercise Classify by operation, not by system
Take an e-commerce checkout flow and, for each of these, decide CP or AP and justify in one sentence: browse catalogue, add to cart, apply a discount code, reserve inventory, capture payment, send confirmation email, update the recommendation model.

1. How many needed CP? Does that match your intuition before you started?
2. For each AP choice, name the reconciliation strategy when replicas diverge.
3. For each CP choice, say what the user sees during a partition.
4. Now do the ELC half: for each operation, would you pay a cross-region round trip for freshness when the network is healthy?
:::

:::paper The originals
Eric Brewer's CAP conjecture was presented at PODC 2000; Gilbert and Lynch's *Brewer's Conjecture and the Feasibility of Consistent, Available, Partition-Tolerant Web Services* (2002) is the formal proof and the precise statement.

Daniel Abadi's *Consistency Tradeoffs in Modern Distributed Database System Design* (IEEE Computer, 2012) introduces PACELC. Brewer's own *CAP Twelve Years Later: How the "Rules" Have Changed* (2012) is his retraction of the popular reading.
:::
