---
title: Concurrency in LLD
summary: The follow-up you will definitely get — what's shared, what guards it, and the four techniques (immutability, atomics, fine-grained locks, single-writer) that answer almost every version of the question.
difficulty: Medium
scope: LLD
tags: [concurrency, threads, locking, lld]
prereqs: [lld-interview-method, concurrency-and-the-os]
unlocks: Answering "what if two threads do this at once?" with a specific mechanism and its cost.
---

Every LLD round for an SDE-2 ends up here, usually phrased as *"two people try to book the last seat at the same time — what happens?"* It is the single most reliable follow-up in the format, and the difference between a vague answer ("I'd synchronise it") and a specific one ("I'd make the seat-hold a compare-and-set on the seat's status, so exactly one wins and the other gets a `SeatUnavailable`") is a level.

## The two-question drill

Whatever the system, answer in this order:

1. **What is the shared mutable state?** Name the exact field or collection. Usually there are only two or three in the whole design.
2. **What is the invariant that a race would break?** "A spot is assigned to at most one vehicle." "The balance never goes negative." "A seat is held by one user."

Only then pick a mechanism. Candidates who jump straight to `synchronized` without naming the state are guessing, and interviewers can tell.

```viz
{
  "type": "steps",
  "caption": "Reach for these in order. Each one down the list costs more and is easier to get wrong.",
  "steps": [
    { "label": "1 · Make it immutable", "sub": "No shared mutable state, no race. Free." },
    { "label": "2 · Confine it", "sub": "One thread / one owner per entity. Also free." },
    { "label": "3 · Atomic op or concurrent collection", "sub": "CAS, ConcurrentHashMap. Cheap, no deadlock." },
    { "label": "4 · Lock the smallest unit", "sub": "Per-seat, per-account — not the whole lot." },
    { "label": "5 · Push it to the database", "sub": "Unique constraint, conditional update, transaction." }
  ]
}
```

## 1 · Immutability — the answer you should give first

Most of a good domain model is value objects, and value objects can't race. Say this early and you've removed 80% of the surface before anyone asks:

*"`Money`, `TimeSlot`, and `Ticket` are immutable — a fee calculation shares nothing. The only mutable state in this design is the spot occupancy map and the ticket store."*

Now the conversation is about two things instead of ten.

## 2 · Confinement and the single writer

If exactly one thread ever touches a piece of state, no synchronisation is needed at all. This is why the elevator problem is usually modelled with one controller thread per elevator: requests go into a queue, the elevator's own loop drains it, and the elevator's internal state has exactly one writer.

```java
class ElevatorController {
    private final BlockingQueue<Request> inbox = new LinkedBlockingQueue<>();
    private final Elevator elevator;                    // touched only by the loop below

    void submit(Request r) { inbox.put(r); }            // any thread may call this

    void run() {                                        // exactly one thread runs this
        while (running) {
            Request r = inbox.poll(100, MILLISECONDS);
            if (r != null) elevator.accept(r);
            elevator.step();
        }
    }
}
```

**Say this:** *"Rather than locking the elevator's state, I give it a queue and a single owning thread. Callers hand off; the elevator is single-writer, so its internals need no locks."*

The HLD echo is exact: this is why partitioned systems assign one owner per key. See [Sharding](../building-blocks/sharding.html).

## 3 · Atomics and concurrent collections

For the "reserve the last one" family of problems, the right primitive is usually **compare-and-set**, not a lock. It's non-blocking, deadlock-free, and expresses the invariant directly:

```java
class ParkingSpot {
    private final AtomicReference<Status> status = new AtomicReference<>(FREE);

    /** Returns true for exactly one caller, however many race. */
    boolean tryOccupy() {
        return status.compareAndSet(FREE, OCCUPIED);
    }

    void release() { status.set(FREE); }
}
```

Two callers, one `true`. The loser sees `false` and asks the allocator for another spot — no lock, no queue, no deadlock possible.

The collection equivalents matter just as much:

| Instead of | Use | Why |
|---|---|---|
| `HashMap` + `synchronized` | `ConcurrentHashMap` | Lock striping; reads are lock-free |
| `map.get` then `map.put` | `putIfAbsent` / `computeIfAbsent` | The check-then-act is the race |
| `int counter++` | `AtomicLong` / `LongAdder` | `++` is read-modify-write, not atomic |
| `ArrayList` for listeners | `CopyOnWriteArrayList` | Read-heavy, write-rare |

:::trap check-then-act is the bug you'll actually write
```java
if (!map.containsKey(k)) map.put(k, newValue());   // two threads both pass the check
```
Any *check* followed by an *act* on shared state is a race, even when both operations are individually thread-safe. `computeIfAbsent(k, this::newValue)` makes it one atomic operation. Saying the phrase "check-then-act" out loud is a strong signal — it shows you know *why* it's broken, not just that it is.
:::

## 4 · Locks, when you need them — and at the right granularity

You need a real lock when the invariant spans **more than one object** (transfer money between two accounts; move a seat between two holds). The two things to get right:

**Granularity.** Locking the whole `ParkingLot` serialises every car in the building. Lock the spot, or stripe by floor. State the tradeoff: *"one lock on the lot is correct but caps throughput at one operation at a time; per-spot locks give concurrency at the cost of ordering guarantees across spots, which I don't need here."*

**Ordering, to avoid deadlock.** Two locks acquired in different orders by two threads deadlock. The standard fix is a global order:

```java
void transfer(Account from, Account to, Money amount) {
    Account first  = from.id().compareTo(to.id()) < 0 ? from : to;   // always same order
    Account second = (first == from) ? to : from;
    synchronized (first) {
        synchronized (second) {
            from.withdraw(amount);
            to.deposit(amount);
        }
    }
}
```

Know the four deadlock conditions (mutual exclusion, hold-and-wait, no preemption, circular wait) and that breaking *any one* is enough — ordering breaks circular wait; `tryLock` with a timeout breaks hold-and-wait.

`ReentrantReadWriteLock` is worth one sentence when reads dominate writes by a lot: many readers concurrently, writers exclusive. Note the caveat — under a heavy read load, writers can starve.

## 5 · Push it to the store

When the interviewer says "but you have five servers", in-process locks stop working and the answer must move down a layer:

- **Unique constraint** — the database rejects the second insert of `(seat_id, active_hold)`. Simple, correct, no extra infrastructure.
- **Conditional update** — `UPDATE seats SET status='HELD', holder=? WHERE id=? AND status='FREE'`, then check the affected-row count. This is compare-and-set at the database. One row updated means you won.
- **Optimistic locking** — a `version` column: `WHERE id=? AND version=?`, bump on write. Zero rows means someone else got there; retry or fail.
- **A distributed lock** (Redis/ZooKeeper) — only when the resource isn't a row you can conditionally update. Say the caveats: it needs a TTL, and a lease can expire mid-operation. See [Distributed Locks](../building-blocks/distributed-locks.html).

:::goat Prefer conditional writes to locks — at both levels
`compareAndSet` in memory and `UPDATE … WHERE status='FREE'` in a database are the same idea: **make the check and the act one operation, and let the loser find out by failing.** It's cheaper than a lock, can't deadlock, and it degrades to a clean error instead of a hang. When you can express your invariant as a conditional write, do — that answer works in the LLD round *and* when the same interviewer pushes it to a cluster.
:::

## Answering the classic follow-ups

**"Two users book the last seat at the same time."**
> "The seat's status is the shared state; the invariant is one active hold per seat. I'd make the hold a conditional transition — `compareAndSet(FREE, HELD)` in-process, or `UPDATE … WHERE status='FREE'` with a row-count check across servers. Exactly one wins; the loser gets `SeatUnavailable` and I refresh their view. The hold carries a TTL so an abandoned checkout releases it — I'd expire it lazily on read plus a sweeper, so I don't depend on a timer being alive."

**"How do you avoid deadlock?"**
> "Mostly by not needing two locks. Where I do — a transfer — I acquire in a fixed global order by ID, and use `tryLock` with a timeout so worst case is a failed operation rather than a stuck thread."

**"Is your singleton thread-safe?"**
> "The enum form is, and it's initialised safely by the class loader. But I'd rather create one instance at the composition root and inject it than use a static accessor — same single instance, testable, no global state."

**"How would you test this?"**
> "A latch-based test: N threads all blocked on a `CountDownLatch`, released together, all calling `book(seat)`. Assert exactly one success and N−1 failures, and that the seat's final state is consistent. Run it a few thousand times — races are probabilistic, so a single pass proves little."

:::warn Don't over-lock to look safe
Wrapping every method in `synchronized` is not the safe answer; it's a design that's both slow and *still* racy at the composite level (two synchronised calls in a row are not one atomic operation). Interviewers read blanket synchronisation as "hasn't thought about which invariant needs protecting". Name the state, name the invariant, protect exactly that.
:::
