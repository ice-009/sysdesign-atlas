---
title: Distributed Transactions & Sagas
summary: Why 2PC blocks, how sagas trade atomicity for availability, designing compensating actions, and the honest answer — avoid needing one.
difficulty: Hard
tags: [transactions, saga, 2pc, consistency]
prereqs: [idempotency, consistency-models]
---

## The problem

A single database gives you ACID across many rows for free. Split those rows across two databases — or two services — and atomicity disappears.

```diagram
   Book a trip:
     1. Reserve flight     (flight service DB)
     2. Reserve hotel      (hotel service DB)
     3. Charge card        (payment service)

   Step 2 fails after step 1 succeeded.
   The flight is now reserved for a trip that doesn't exist.
```

You need all-or-nothing across systems that don't share a transaction manager. There are two real answers, and one better one.

## Two-phase commit (2PC)

A coordinator drives all participants to a unanimous decision.

```diagram
   PHASE 1 — PREPARE
   coordinator ──"can you commit?"──► A, B, C
               ◄──── "yes" ─────────
        Each participant does the work, writes it durably,
        holds LOCKS, and promises it CAN commit if asked.

   PHASE 2 — COMMIT
   coordinator ──── "commit" ───────► A, B, C
               ◄──── "done" ────────
        Any "no" in phase 1 → coordinator sends "abort" instead.
```

The promise is the key: after voting yes, a participant **must** be able to commit, even across a crash. So it holds locks and keeps the transaction open until told what to do.

**Why 2PC is largely avoided:**

**It blocks.** If the coordinator crashes after participants vote yes but before sending the decision, participants are stuck — they cannot commit (maybe someone voted no) and cannot abort (maybe everyone voted yes). They hold locks and wait, potentially forever. This is the defining flaw.

**Locks are held for the full round trip**, across the network, across every participant. Throughput collapses under contention, and one slow participant stalls everyone.

**Availability multiplies down.** All participants must be up for the duration. Three services at 99.9% give the transaction 99.7%.

**3PC** adds a pre-commit phase to make it non-blocking, at the cost of an extra round trip — and it's still unsafe under network partitions, so it's rarely used. Modern systems that need atomic cross-shard commits (Spanner, CockroachDB) use 2PC *over Paxos/Raft groups*, so the coordinator itself is fault-tolerant and can't disappear. That's the fix that makes 2PC viable, and it's worth naming.

:::interview When 2PC is acceptable
"2PC is reasonable inside a single trust and latency domain — cross-shard transactions in one database cluster, where the coordinator is itself replicated by consensus so it can't block indefinitely. It's a poor fit across independently-operated services over the internet, where the coordinator is a single point of failure and locks are held across unbounded latency."
:::

## Sagas

Break the distributed transaction into a sequence of **local** transactions, each with a **compensating action** that semantically undoes it.

```diagram
   T1 reserve flight   →  C1 cancel flight
   T2 reserve hotel    →  C2 cancel hotel
   T3 charge card      →  C3 refund card

   Forward:  T1 → T2 → T3 ✓
   T3 fails: T1 → T2 → ✗ → C2 → C1   (compensate backwards)
```

Each step commits immediately and locally — no distributed locks, no blocking, and each service stays independently available.

**What you give up, and you must say this:** atomicity and isolation. There is a window where the flight is booked and the hotel isn't. Other transactions can *see* that intermediate state. A saga is **eventually** consistent, not atomic.

### Orchestration vs choreography

**Orchestration** — a coordinator explicitly invokes each step and handles failures.

```diagram
   ┌──────────────┐
   │ Saga         │──1──► Flight service
   │ orchestrator │──2──► Hotel service
   │ (state       │──3──► Payment service
   │  machine)    │
   └──────────────┘  on failure, invokes compensations in reverse
```

The process is visible in one place, debuggable, and easy to monitor — you can always answer "what state is this booking in?" Cost: a component that knows about everyone.

**Choreography** — each service listens for events and reacts, emitting its own.

Maximally decoupled, and the overall business process exists nowhere. Understanding it requires reading every service. Cycles emerge that nobody designed.

**Recommend orchestration for anything with more than ~3 steps or real money involved.** The observability alone justifies it. Choreography is fine for simple, side-effect-y fanout.

### Designing compensations

This is the real engineering, and the part usually left thin.

- **Compensation is semantic, not a rollback.** You can't un-send an email; you send an apology. You can't un-charge a card; you issue a refund, which is a *new* transaction that appears on the statement. The customer sees both.
- **Compensations must be idempotent.** They'll be retried. See [Idempotency](idempotency.html).
- **Compensations can fail too.** Retry with backoff, and after N attempts escalate to a human via an alert and a dead-letter store. A saga stuck half-complete with no human path is an outage waiting to be discovered by a customer.
- **Some steps can't be compensated.** Order the saga so irreversible steps come **last**, after everything reversible has succeeded. Charge the card after inventory is confirmed, not before.
- **Pivot transactions.** The step after which the saga can no longer be aborted, only completed forward. Identifying it explicitly clarifies the whole design.

**Forward recovery** is the alternative to backward compensation: instead of undoing, keep retrying until the step succeeds. Right when the operation *must* eventually complete (the payment has been taken; the goods must ship).

## Avoiding the problem

The strongest answer is usually to not need a distributed transaction at all. Volunteer these before designing a saga:

**1. Fix the boundaries.** A transaction spanning services often means the service boundary is drawn in the wrong place. If order and inventory must always change together, maybe they belong to one service with one database. Aggregate boundaries should follow transactional boundaries — this is the single most valuable observation in this whole topic.

**2. Choose a partition key that keeps the transaction local.** Sharding by `customer_id` keeps everything about one customer's order on one shard, so it's an ordinary local transaction. Most "distributed transaction" problems are [sharding key](../02-building-blocks/sharding.html) problems in disguise.

**3. Use the outbox pattern.** For "update the database and publish an event," you don't need 2PC — write both in one local transaction and let a relay publish. See [CDC & Outbox](../04-data/cdc-outbox.html).

**4. Reserve-then-confirm.** Model the intermediate state explicitly in the domain instead of hiding it:

```diagram
   1. Reserve inventory with a TTL (status = reserved, expires_at)
   2. Take payment
   3. Confirm the reservation (status = committed)

   If step 2 fails or times out, the reservation simply EXPIRES.
   No compensation needed — the TTL is the compensation.
```

This is how [ticket booking](../05-case-studies/ticket-booking.html) and hotel reservations actually work, and it's elegant: expiry handles the failure path automatically, with no coordinator and no compensating transaction to get wrong.

**5. Accept eventual consistency and reconcile.** Let the steps happen independently and run a periodic job that finds and fixes mismatches. Every large financial system does this regardless of its other mechanisms — reconciliation is the safety net that catches everything the design missed.

## Choosing

| Situation | Approach |
|---|---|
| Rows in one database | Plain ACID transaction |
| Shards of one cluster with a replicated coordinator | 2PC over consensus |
| Across independent services, reversible steps | **Saga (orchestrated)** |
| Update + publish an event | **Outbox** |
| Reserving limited inventory | **Reserve-with-TTL, then confirm** |
| Steps that must eventually complete | Saga with forward recovery |
| Anything financial | All of the above **plus reconciliation** |

:::goat The line that lands
"Before I design a saga, I'd ask whether this needs to be a distributed transaction at all. If inventory and orders must change atomically, that's a strong hint they belong in the same service and database. Distributed transactions are usually a symptom of service boundaries drawn along organizational lines rather than transactional ones — and the cheapest fix is to move the boundary, not to add a coordinator."
:::

:::exercise Choose a coordination strategy
1. Book a flight, a hotel, and a car — three separate services, all must succeed or none. Design it as a saga: list the steps and the compensating action for each.
2. Which of your compensations are not truly reversible? What do you do about those?
3. 2PC: the coordinator crashes after all participants voted "prepare". What state is the system in, for how long, and what breaks?
4. Compare 2PC, saga, and the outbox pattern for: latency, failure behaviour, isolation, and operational complexity.
5. A saga step fails after three later steps succeeded. Walk through the compensation order and say what a user observes during it.
:::

:::paper Two-phase commit and its alternatives
Jim Gray's *Notes on Data Base Operating Systems* (1978) introduced 2PC; the standard critique is that it is a blocking protocol — if the coordinator fails after prepare, participants hold locks indefinitely.

*Sagas* (Garcia-Molina & Salem, SIGMOD 1987) is the compensating-transaction alternative. Pat Helland's *Life beyond Distributed Transactions* (CIDR 2007) is the argument for avoiding the problem entirely.
:::
