---
title: Distributed Locks & Leases
summary: Why a lock in a distributed system is never as safe as it looks, why fencing tokens are mandatory, and the designs that avoid needing a lock at all.
difficulty: Hard
scope: HLD
tags: [locks, leases, coordination, fencing]
prereqs: [consistency-models, replication]
---

## What you're actually asking for

A distributed lock lets one process among many claim exclusive access to a resource — process one job, write one file, run one cron task.

The naive implementation looks trivial:

```diagram
   SET lock:job42 <owner_id> NX EX 30     ← acquire, 30s expiry
   ... do the work ...
   DEL lock:job42                         ← release
```

`NX` means "only set this if nobody else already has," so exactly one caller can win even if a thousand try at once. `EX 30` puts a 30-second expiry on it — a **lease** rather than a lock — so if the holder crashes, the lock doesn't stay held forever and block everyone.

That expiry is also the source of every problem below. A lock that can time out is a lock you might not still hold while you think you do.

So this design is fine for **efficiency** — stopping duplicate work that would merely waste effort. It is *not* sufficient for **correctness** — stopping two writers from corrupting each other. That distinction is the entire subject.

## Why locks aren't safe

The failure is not exotic. It's a garbage collection pause.

```diagram
   t=0    Client A acquires lock, TTL 30s
   t=1    Client A begins work
   t=2    Client A hits a 40-SECOND GC PAUSE (or VM migration,
          or network partition, or a slow disk)
   t=31   Lock EXPIRES. A is frozen and doesn't know.
   t=32   Client B acquires the lock — legitimately, it's free
   t=33   Client B starts writing
   t=42   Client A wakes up, believes it still holds the lock,
          and writes.
          ► TWO WRITERS. Data corrupted.
```

No lock service can prevent this, because **the client cannot know whether its lease is still valid at the moment it acts.** Time passes between checking and acting, and in that window anything can happen. This is a fundamental property of distributed systems, not a bug in Redis or ZooKeeper.

:::goat This is the answer that scores
The question to sit with is "how do you prevent two workers from processing the same job?" The weak answer is "a Redis lock." The strong answer is:

"A lock gets me most of the way — it prevents duplicate work in the common case. But it can't guarantee mutual exclusion, because a GC pause or partition can make a client believe it holds an expired lease. If duplicate processing merely wastes CPU, the lock is fine. If it would corrupt data, I need **fencing tokens** at the storage layer, or I need to remove the requirement for a lock entirely by making the operation idempotent."
:::

## Fencing tokens

The actual fix, and it requires cooperation from the **resource**, not just the lock service.

Every time the lock is handed out, it comes with a number one higher than last time. Whatever you're writing to remembers the highest number it has seen and **refuses anything with a lower one**. A stale holder can still try to write — it just can't succeed.

```diagram
   A acquires lock  → token 33
   A pauses...
   Lock expires; B acquires → token 34
   B writes with token 34   → storage records max_token = 34  ✓
   A wakes, writes token 33 → storage sees 33 < 34, REJECTS  ✓
```

Now safety doesn't depend on timing at all. A stale holder is *structurally* unable to do damage, regardless of how long it was paused.

The catch, and it's why fencing is rare in practice: **the storage system must support it.** If you're writing to S3 or a database that doesn't check tokens, you can't fence. Workarounds: use a conditional write (compare-and-set on a version column — most databases support this), or use the token as part of a uniqueness constraint. When neither is possible, accept that you have an efficiency lock and design so duplicates are harmless.

Note this is the same mechanism used to prevent [split brain during failover](replication.html) — the concept generalizes to "make stale actors detectable rather than trying to prevent them."

## Implementations

### Redis single instance

`SET key value NX EX ttl`, released with a Lua script that checks ownership before deleting:

```diagram
   if redis.call("GET", KEYS[1]) == ARGV[1] then
       return redis.call("DEL", KEYS[1])
   end
```

The ownership check matters: without it, a client whose lock already expired could delete the *next* holder's lock. This is a real bug people ship.

Fast (sub-millisecond) and simple. But Redis replication is **asynchronous**, so if the primary acknowledges a lock and dies before replicating, the promoted replica has no record of it and will grant the same lock to someone else. Redis-based locks are efficiency locks by construction.

### Redlock

An algorithm that acquires the lock on a majority of N independent Redis instances. It's more robust against single-node failure, and it remains controversial: it depends on bounded clock drift and bounded pauses, which distributed systems don't guarantee. It raises the bar without changing the category — still not safe for correctness without fencing.

### ZooKeeper / etcd

Locks built on **consensus** ([Raft/ZAB](../03-distributed/consensus.html)), which makes the lock state itself linearizable and durable.

The standard pattern uses ephemeral sequential nodes: each client creates a node, the lowest sequence number holds the lock, and each client watches only its immediate predecessor (watching *all* nodes causes a herd on every release). The node is **ephemeral** — tied to the client's session, so it vanishes automatically when the session dies, giving you failure detection without a TTL guess.

Stronger and slower (consensus round trips, typically ~10 ms). etcd's revision numbers give you fencing tokens directly, which is the real reason to prefer it.

### Database locks

Postgres advisory locks, or a `SELECT ... FOR UPDATE` row lock. If your data is already in one database, this is often the correct answer — the lock and the data share a transaction, so the whole category of "my lease expired between checking and writing" disappears.

Underrated. When someone proposes ZooKeeper for coordinating work whose state lives in Postgres anyway, "we can just use a row lock in the same transaction" is usually the simpler and *safer* answer.

## Leases

A lock with a TTL is really a **lease** — time-bounded ownership that must be renewed. The framing is more honest, because it forces the question every distributed lock design must answer: *what happens when renewal fails?*

Good lease design:

- **Renew well before expiry** (at ~1/3 of the TTL) so a transient blip doesn't lose ownership.
- **Stop work immediately when renewal fails.** The holder should self-fence: if you couldn't renew, assume you no longer own it and abort, rather than finishing and writing.
- **Pick the TTL as a real tradeoff.** Short TTL → fast recovery after a crash, more renewal traffic, more spurious loss under load. Long TTL → less churn, but a crashed holder blocks the resource for the full duration.

Leases underpin [leader election](../03-distributed/leader-election.html): the leader holds a lease and renews it; failing to renew means stepping down.

## Designing the lock away

The best answer is often that you don't need one. Volunteering an alternative is a stronger move than implementing a lock well.

**1. Make the operation idempotent.** If processing a job twice produces the same result, duplicates are harmless and you can drop the lock entirely. See [Idempotency](../03-distributed/idempotency.html).

**2. Use optimistic concurrency.** Instead of locking, read a version, and make the write conditional on the version being unchanged:

```sql
UPDATE accounts SET balance = 90, version = version + 1
WHERE id = 42 AND version = 7;      -- 0 rows updated → retry
```

No lock, no lease, no timing assumption — and it's naturally fenced. Excellent under low contention, degrades under high contention (retry storms).

**3. Partition ownership.** Assign each key to exactly one worker by [consistent hashing](consistent-hashing.html). Mutual exclusion becomes a routing property rather than a runtime negotiation. This is how Kafka consumer groups avoid needing locks at all — a partition has one consumer by assignment.

**4. Use a single-threaded serialization point.** Route all operations on an entity through one queue partition or one actor. Ordering is guaranteed by construction.

**5. Push it into the database.** A unique constraint prevents duplicate bookings more reliably than any lock: let the second insert fail.

## The decision

| Requirement | Approach |
|---|---|
| Avoid duplicate work; duplicates are wasteful only | Redis lock — simple and fast |
| Duplicates would corrupt data | Fencing tokens + conditional writes, or design the lock away |
| Data is already in one database | Database transaction / advisory lock |
| Leader election, config, membership | etcd / ZooKeeper (consensus) |
| Low-contention updates to one row | Optimistic concurrency (version check) |
| Per-entity serialization at scale | Partition ownership by hash |

The sentence to carry into an interview: **"A distributed lock is a performance optimization, not a safety mechanism. If correctness depends on it, I need fencing at the resource — or a design that doesn't need mutual exclusion at all."**

:::exercise Break the lock
1. A client acquires a 30-second lock, then experiences a 45-second GC pause. Draw the timeline showing two clients holding the lock simultaneously.
2. Add fencing tokens. Show exactly where the second client's write is rejected, and what the storage layer had to support.
3. Why does a lock without fencing provide no safety guarantee at all — only a performance optimisation? State this precisely.
4. You need mutual exclusion for a payment capture. Argue for and against: a distributed lock, an idempotency key, and a database unique constraint. Which would you ship?
5. Your lock service is unavailable for 20 seconds. What do clients do? Design the behaviour for both a safety-critical and a performance-only use of the lock.
:::

:::paper Locks, leases, and fencing
Martin Kleppmann's *How to do distributed locking* (2016) and Salvatore Sanfilippo's response are the essential exchange — the argument is about whether a lock service can be safe without fencing tokens, and it is worth reading both sides.

*The Chubby Lock Service for Loosely-Coupled Distributed Systems* (Burrows, OSDI 2006) is the production system that established the pattern, and is candid about how clients misuse it.
:::
