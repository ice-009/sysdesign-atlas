---
title: Transactions, Isolation & MVCC
summary: What ACID actually guarantees, the anomalies each isolation level permits, how MVCC gives readers a consistent view without locks, and why write skew catches everyone.
difficulty: Hard
scope: Core
tags: [acid, isolation, mvcc, transactions]
prereqs: [consistency-models, storage-engines]
---

## ACID, precisely

- **Atomicity** — all operations commit or none do. Note this is about *abortability*, not concurrency.
- **Consistency** — the database moves from one valid state to another, respecting constraints. This is largely the *application's* responsibility; the database only enforces what you declared. (Genuinely the odd one out — it's in the acronym partly because ACID is a nicer word than AID.)
- **Isolation** — concurrent transactions don't interfere. In theory they behave as if serial; in practice, only at the strongest level.
- **Durability** — committed data survives a crash. In practice this means fsync'd to a WAL, and often replicated.

The word to be careful with is **Consistency** — the C in ACID is unrelated to the C in [CAP](../01-fundamentals/cap-pacelc.html). ACID's C is about invariants; CAP's C is linearizability. Blurring them leads to genuinely wrong conclusions.

## ACID vs BASE

**BASE** is the name given to the opposite style, popularised with the first wave of NoSQL databases. It stands for:

- **Basically Available** — the system answers even when parts of it are failing, possibly with stale or partial data.
- **Soft state** — what a replica holds may change without new writes, as updates from other replicas arrive.
- **Eventually consistent** — if writes stop, all replicas end up agreeing; until then, different readers may see different answers. See [eventual consistency](../01-fundamentals/consistency-models.html).

The acronym is a bit forced (like ACID's C), but the contrast is real:

| | ACID | BASE |
|---|---|---|
| Priority | Correctness of every transaction | Staying up and fast under failure and scale |
| After a write | Every reader sees it (at strong isolation) | Readers may see old data for a while |
| Multi-item changes | All-or-nothing transactions | Usually single-item writes; you reconcile the rest |
| When replicas disagree | Refuse or wait | Answer anyway; repair later |
| Typical systems | Postgres, MySQL, Spanner, CockroachDB | Cassandra, DynamoDB (by default), DNS, caches |

Two things worth saying, because they're where shallow answers go wrong:

- **It isn't a property of a whole system — it's a choice per piece of data.** One product can keep money, inventory and bookings in an ACID store, and likes, view counts and feeds in a BASE one. Choose by asking *"what does a stale or lost update cost here?"*. A wrong bank balance is a real problem; a like count that's off for two seconds isn't.
- **The line has blurred.** Many "NoSQL" databases now offer transactions, and distributed SQL databases offer ACID across many machines. BASE is better understood as the eventually consistent end of the spectrum in [CAP / PACELC](../01-fundamentals/cap-pacelc.html) than as a category of product.

## The anomalies

An **anomaly** here is a specific way concurrent transactions can produce a result that no sequence of one-at-a-time transactions could have produced. **Isolation levels** are then defined backwards from these: a level is simply a promise about which anomalies it prevents and which it still allows. So learn the anomalies and the levels come for free.

**Dirty read** — you read data another transaction wrote but hasn't committed. If it rolls back, you acted on data that never existed.

**Non-repeatable read** — you read a row twice in one transaction and get different values, because someone committed in between.

**Phantom read** — you run the same *query* twice and get different **rows**, because someone inserted or deleted matching rows.

**Lost update** — two transactions read-modify-write the same value; one silently overwrites the other.

```diagram
   T1: read counter (10)
   T2: read counter (10)
   T1: write 11
   T2: write 11        ← T1's increment vanished
```

**Write skew** — the subtle one, and the one that matters most in interviews.

```diagram
   Rule: at least one doctor must remain on call.
   Currently Alice and Bob are both on call.

   T1 (Alice): count on-call = 2, OK → set Alice off-call
   T2 (Bob):   count on-call = 2, OK → set Bob off-call
   Both commit.

   → ZERO doctors on call. Each transaction was individually
     valid. They wrote to DIFFERENT rows, so no write conflict
     was detected. The INVARIANT is broken.
```

Write skew is nasty precisely because the transactions don't touch the same row — every mechanism based on detecting write-write conflicts misses it entirely.

## The levels

| Level | Dirty read | Non-repeatable | Phantom | Lost update | Write skew |
|---|---|---|---|---|---|
| Read Uncommitted | ✗ | ✗ | ✗ | ✗ | ✗ |
| Read Committed | ✓ prevented | ✗ | ✗ | ✗ | ✗ |
| Repeatable Read / Snapshot | ✓ | ✓ | ✓* | ✓* | ✗ |
| Serializable | ✓ | ✓ | ✓ | ✓ | ✓ |

\* Snapshot isolation prevents phantoms and lost updates in practice, though the SQL standard's "Repeatable Read" doesn't require it. Implementations differ, which is itself worth knowing.

**Read Committed** is the default in Postgres, Oracle, and SQL Server. **Repeatable Read** is the default in MySQL/InnoDB. Very few systems run Serializable by default because of its cost.

:::trap The default is not Serializable
Most engineers assume their database gives them serial behaviour. It doesn't. Under Read Committed, lost updates and write skew are both possible, and the resulting bugs are timing-dependent, rare in testing, and appear in production under load.

Stated precisely: the default isolation level won't prevent write skew, so for the seat-booking invariant you either use `SELECT ... FOR UPDATE` to take explicit locks, add a uniqueness constraint that makes the conflict a write-write conflict the database *can* detect, or run that specific transaction at Serializable." Naming three graded fixes is much stronger than naming one.
:::

## MVCC

Multi-Version Concurrency Control — the trick that lets readers and writers stop fighting over the same rows.

The insight: if you never overwrite anything, a reader can't be disturbed by a writer. So each write leaves the old row alone and adds a **new version** beside it, stamped with which transaction created it. Every transaction then reads the versions that existed when it started — its own consistent snapshot of the database, unaffected by anything committed since.

```diagram
   Row 42 versions:
     (v1, created by txn 100, deleted by txn 150)
     (v2, created by txn 150, deleted by null)   ← current

   A transaction with snapshot at txn 120 sees v1.
   A transaction with snapshot at txn 160 sees v2.
   Neither blocks the other, and neither blocks a writer.
```

Each transaction gets a **snapshot** — the set of transactions committed at its start — and sees only versions visible in that snapshot.

**The payoff: readers never block writers, and writers never block readers.** This is the single biggest concurrency improvement in modern databases, and it's why a long analytical query doesn't stall your writes.

**The costs, all of which show up in production:**

- **Old versions accumulate.** They must be cleaned up — `VACUUM` in Postgres, purge threads in InnoDB. A long-running transaction holds back cleanup for the *entire database*, because its snapshot might still need old versions. This is the classic cause of Postgres table bloat, and mentioning it reads as real operational experience.
- **Storage overhead** from multiple versions.
- **Index bloat**, since indexes point at versions too.

## Serializable, three ways

**Actual serial execution.** Run transactions one at a time on a single thread. Sounds absurd; works well when transactions are short, data fits in memory, and you use stored procedures rather than round-tripping to the application (Redis and VoltDB take this approach). Throughput is limited to one core, so it scales only by partitioning.

**Two-phase locking (2PL).** Acquire locks (shared for reads, exclusive for writes), hold them all until commit. Correct and pessimistic. Costs: greatly reduced concurrency, deadlocks requiring detection and abort, and unpredictable latency. Range queries need predicate or next-key locks to prevent phantoms.

**Serializable Snapshot Isolation (SSI).** The modern approach (Postgres's `SERIALIZABLE`, and the basis of CockroachDB's). It's **optimistic** — rather than locking things up front in case of a clash, it lets transactions run freely and checks afterwards whether any pair of them interfered in a way that no one-at-a-time ordering could explain. If so, one is aborted and the client retries.

```diagram
   Detects: "I read something that another transaction
             concurrently wrote, and my write depended on it"
   → abort one of them, ask the client to retry
```

**Excellent when contention is low** — nearly the performance of snapshot isolation with full correctness. **Poor when contention is high** — abort rates climb and you spend your capacity on retries.

The practical consequence: **applications must handle serialization failures and retry.** That's a real application-level requirement, not a database detail, and saying so is a good signal.

## Optimistic vs pessimistic

The general framing behind all of the above:

**Pessimistic (locking)** — assume conflict, prevent it. Better under high contention. Costs concurrency and risks deadlock.

**Optimistic (versioning)** — assume no conflict, detect and retry. Better under low contention. Degrades badly under high contention as retries pile up.

The application-level version of optimistic concurrency is worth knowing, since it works on any database including those with no transactions at all:

```sql
UPDATE items SET qty = 4, version = 8
WHERE id = 42 AND version = 7;     -- 0 rows → someone beat us, retry
```

This is the same mechanism as a [fencing token](../02-building-blocks/distributed-locks.html) and the same idea as a conditional write in DynamoDB. It's the most portable concurrency-control tool you have.

## Choosing under time pressure

Ask what invariant must hold, then pick the cheapest mechanism that holds it:

| Requirement | Mechanism |
|---|---|
| Read-mostly, staleness tolerable | Read Committed (default) — don't over-engineer |
| Prevent lost update on one row | `SELECT ... FOR UPDATE`, or a version check |
| Prevent duplicate creation | **Unique constraint** — simplest, most reliable |
| Invariant across multiple rows (write skew) | Serializable, or materialize the conflict into one row/lock |
| Across services / shards | Not isolation at all — [saga or 2PC](../03-distributed/distributed-transactions.html) |

That third row deserves emphasis: **a unique constraint is the most underrated concurrency control in existence.** For "two users must not book the same seat" or "usernames must be unique," a constraint converts a subtle race into a plain insert failure the database handles for you. Proposing it before proposing locks or Serializable is exactly the right instinct — and it's the answer the [ticket booking](../05-case-studies/ticket-booking.html) design turns on.

:::exercise Construct the anomalies
For each, write two concurrent transactions that produce it, and name the lowest isolation level that prevents it:

1. Dirty read
2. Non-repeatable read
3. Phantom read
4. Lost update
5. Write skew

Then: 6. Snapshot isolation prevents 1–4 but not 5. Construct the classic write-skew example (two doctors, one must remain on call) and show exactly why SI permits it. 7. What does SSI do differently to catch it, and what does that cost in aborted transactions?
:::

:::paper Isolation, precisely
*A Critique of ANSI SQL Isolation Levels* (Berenson et al., SIGMOD 1995) is the paper that showed the standard's definitions are ambiguous and introduced snapshot isolation properly.

*Serializable Snapshot Isolation in PostgreSQL* (Ports & Grittner, VLDB 2012) explains how SSI detects the dangerous structures that make snapshot isolation non-serializable. Martin Kleppmann's *Designing Data-Intensive Applications* chapter 7 is the best textbook treatment.
:::
