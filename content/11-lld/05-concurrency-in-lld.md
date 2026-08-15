---
title: Threads and Races
summary: The follow-up you will definitely get — which data is shared, what rule a collision would break, and the four techniques that answer almost every version of the question.
difficulty: Medium
scope: LLD
tags: [concurrency, threads, locking, lld]
prereqs: [lld-interview-method, concurrency-and-the-os]
unlocks: Answering "what if two people do this at the same time?" with a specific mechanism and its cost.
---

Almost every SDE-2 LLD round ends up here, usually as: *"two users try to book the last seat at the same moment — what happens?"*

First, the vocabulary, because it's used loosely everywhere.

- A **thread** is one flow of execution. A server handles many users by running many threads at once, and they share the same objects in memory.
- A **race** (or race condition) is when the result depends on which thread happens to get there first — and one of the possible orders is wrong.
- An **invariant** is a rule that must always hold. "A seat has at most one owner" is an invariant. A race is only a bug because it breaks one.

The difference between a vague answer ("I'd synchronise it") and a specific one ("the seat hold is a compare-and-set on the seat's status, so exactly one caller wins and the other gets `SeatUnavailable`") is a level.

## The two-question drill

Whatever the system, answer in this order:

1. **Which data is shared and changes?** Name the exact field or collection. There are usually only two or three in a whole design.
2. **What rule would a collision break?** "A spot is assigned to at most one car." "The balance never goes negative."

Only then pick a mechanism. Jumping to `synchronized` without naming the data is guessing, and interviewers can tell.

```viz
{
  "type": "steps",
  "caption": "Try these in order. Each step down costs more and is easier to get wrong.",
  "steps": [
    { "label": "1 · Make it unchangeable", "sub": "Nothing to race on. Free." },
    { "label": "2 · Give it one owner", "sub": "One thread touches it. Also free." },
    { "label": "3 · Use an atomic operation", "sub": "Compare-and-set, ConcurrentHashMap. Cheap, can't deadlock." },
    { "label": "4 · Lock the smallest thing", "sub": "One seat, one account — not the whole system." },
    { "label": "5 · Push it into the database", "sub": "Unique constraint, conditional update, transaction." }
  ]
}
```

## 1 · Unchangeable objects can't race

Most of a good design is value objects, and a value object that never changes cannot be corrupted by two threads. Say this early and you've removed most of the surface before anyone asks:

*"`Money`, `TimeSlot` and `Ticket` never change after they're created, so calculating a fee shares nothing. The only changing shared data here is spot occupancy and the ticket store."*

Now the conversation is about two things instead of ten.

## 2 · One owner needs no lock

If exactly one thread ever touches a piece of data, no protection is needed at all. This is why a lift is usually modelled with one thread per car: requests go into a queue, the car's own loop takes them out, and the car's fields have exactly one writer.

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

**Say this:** *"Rather than locking the lift's state, I give it a queue and one owning thread. Callers hand work over; the lift has a single writer, so its internals need no locks."*

The same idea appears one level up in HLD: it's why systems give each slice of data a single owning server. See [Sharding](../building-blocks/sharding.html).

## 3 · Atomic operations

For "grab the last one" problems, the right tool is usually **compare-and-set** rather than a lock.

Compare-and-set (CAS) means: *change this value to B, but only if it is currently A — and tell me whether it worked.* The check and the change happen as one indivisible step, so two threads cannot both succeed.

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

Two cars, one `true`. The loser sees `false` and asks for another spot. No lock, no waiting, no deadlock possible.

The collection equivalents matter just as much:

| Instead of | Use | Why |
|---|---|---|
| `HashMap` guarded by `synchronized` | `ConcurrentHashMap` | Readers don't block each other |
| `map.get` then `map.put` | `putIfAbsent` / `computeIfAbsent` | The gap between the two *is* the bug |
| `counter++` | `AtomicLong` | `++` is read, add, write — three steps, not one |
| `ArrayList` of listeners | `CopyOnWriteArrayList` | Read constantly, written rarely |

:::trap Check-then-act is the bug you'll actually write
```java
if (!map.containsKey(k)) map.put(k, newValue());   // two threads both pass the check
```
Any **check** followed by an **act** on shared data is a race, even when each operation is individually thread-safe. `computeIfAbsent(k, this::newValue)` makes it a single atomic step.

Saying the phrase "check-then-act" out loud is a strong signal — it shows you know *why* it's broken, not just that it is.
:::

## 4 · Real locks, at the right size

You need an actual lock when the rule spans **more than one object** — moving money between two accounts, moving a seat between two holds. Two things to get right.

**Size.** A single lock on the whole car park means one car at a time, everywhere. Lock the individual spot instead. State the trade-off: *"one lock is obviously correct but serialises everything; per-spot locks give real concurrency and I don't need ordering between spots."*

**Order, to avoid deadlock.** *Deadlock* is when two threads each hold something the other needs, so both wait forever. It needs two threads taking two locks in opposite orders. The standard fix is to always take them in the same order:

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

Worth knowing: deadlock needs four conditions at once (mutual exclusion, hold-and-wait, no preemption, circular wait), and **breaking any one is enough**. Ordering breaks circular wait; `tryLock` with a timeout breaks hold-and-wait.

`ReentrantReadWriteLock` deserves a sentence when reads hugely outnumber writes: many readers at once, writers alone. The catch is that constant reading can starve writers.

## 5 · Push it into the database

When the interviewer says "but you have five servers", in-memory tricks stop working — each server has its own copy of everything. The answer moves down a layer:

- **Unique constraint** — the database rejects a second row for the same seat. Simple, correct, nothing extra to run.
- **Conditional update** — `UPDATE seats SET status='HELD' WHERE id=? AND status='FREE'`, then check how many rows changed. This is compare-and-set, written in SQL. One row changed means you won.
- **Optimistic locking** — a `version` column: `WHERE id=? AND version=?`, incremented on write. Zero rows means someone beat you; retry or fail.
- **A distributed lock** (Redis, ZooKeeper) — only when the thing isn't a row you can conditionally update. Say the caveats: it needs an expiry, and the lease can run out mid-operation. See [Distributed Locks](../building-blocks/distributed-locks.html).

:::goat Prefer a conditional write to a lock — at both levels
`compareAndSet` in memory and `UPDATE … WHERE status='FREE'` in a database are the same idea: **make the check and the change one operation, and let the loser find out by failing.**

It's cheaper than a lock, can't deadlock, and fails cleanly instead of hanging. Whenever your rule can be written as a conditional write, write it that way — the answer then works in the LLD round *and* when the same interviewer moves the question to a cluster.
:::

## The classic follow-ups, answered

**"Two users book the last seat at the same time."**
> "The seat's status is the shared data; the rule is one live hold per seat. I'd make the hold a conditional change — `compareAndSet(FREE, HELD)` in one process, or `UPDATE … WHERE status='FREE'` with a row-count check across servers. Exactly one wins; the other gets `SeatUnavailable` and I refresh their view. The hold carries an expiry so an abandoned checkout frees the seat — checked when the seat is next read, so it doesn't depend on a timer still being alive."

**"How do you avoid deadlock?"**
> "Mostly by needing only one lock. Where I need two — a transfer — I always take them in the same order by ID, and use `tryLock` with a timeout so the worst case is a failed operation rather than a stuck thread."

**"Is your singleton thread-safe?"**
> "The enum form is, and the class loader guarantees it. But I'd rather create one instance at startup and pass it in than use a static accessor — same single instance, testable, no global state."

**"How would you test this?"**
> "A latch test: start N threads, hold them all at a `CountDownLatch`, release them together, all calling `book(seat)`. Assert exactly one success and N−1 failures, and that the seat ends up consistent. Run it a few thousand times, because a race that appears one time in fifty proves nothing in a single run."

:::warn Don't lock everything to look careful
Putting `synchronized` on every method is not the safe answer. It's slow *and* still wrong at the next level up — two synchronised calls in a row are not one atomic operation, so the check-then-act bug survives.

Interviewers read blanket locking as "hasn't worked out which rule needs protecting". Name the data, name the rule, protect exactly that.
:::
