---
title: Time, Clocks & Ordering
summary: Why wall-clock timestamps lie, Lamport and vector clocks, hybrid logical clocks, and how TrueTime buys strong consistency by waiting out uncertainty.
difficulty: Hard
tags: [clocks, ordering, causality, vector-clocks]
prereqs: [consistency-models, networking]
---

## Why you can't trust a timestamp

Ordering events by wall-clock time seems obvious and is quietly wrong.

**Clock skew.** Two servers' clocks differ. NTP typically keeps them within a few milliseconds on a good network, tens to hundreds of milliseconds on a bad one. That's an eternity — thousands of operations can occur inside the uncertainty window.

**Clocks jump.** NTP corrections can step the clock *backwards*. A VM migration or a leap second adjustment can produce discontinuities. Code that assumes monotonically increasing time breaks in ways that are extremely hard to debug.

**The consequence — last-write-wins silently loses data:**

```diagram
   Server A (clock 3s fast)   Server B (correct clock)
   t=10.003  write X=1        t=10.001  write X=2
             (real: 10.000)             (real: 10.001)

   B's write really happened LAST, but A's timestamp is higher.
   Last-write-wins keeps X=1. B's write is silently discarded.
```

No error, no conflict, no log line. The data is just gone. This is the single most important practical consequence of clock skew, and naming it is a strong signal.

:::trap Monotonic vs wall clock
Two different clocks with different purposes:
- **Wall clock** (`System.currentTimeMillis`, `time.time()`) — absolute time; can jump backwards. Use it for *displaying* timestamps and for cross-machine comparison you're prepared to be wrong about.
- **Monotonic clock** (`System.nanoTime`, `time.monotonic()`) — always increases, no absolute meaning. Use it for *measuring durations*, timeouts, and rate limiting.

Measuring an elapsed duration with a wall clock can yield a **negative** number when NTP steps backwards, which produces spectacular bugs — infinite timeouts, negative rate limits. This is a real production issue and a great detail to mention.
:::

## Happens-before

Since physical time is unreliable, define ordering **logically**. Event A *happens-before* B (written A → B) if:

1. A and B are in the same process and A came first, or
2. A is sending a message and B is receiving it, or
3. Transitively: A → C and C → B.

If neither A → B nor B → A, they are **concurrent** — genuinely unordered, and no amount of clock precision changes that. Concurrency is the interesting case, because it's exactly where conflicts live.

## Lamport clocks

A counter per process, with one rule for messages:

```diagram
   Local event:      counter++
   Sending msg:      counter++, attach counter
   Receiving msg:    counter = max(counter, received) + 1
```

**Guarantee:** if A → B then `L(A) < L(B)`.

**The crucial limitation:** the converse is false. `L(A) < L(B)` does **not** mean A → B — they might be concurrent. Lamport clocks give you a total order that's *consistent with* causality, but they can't detect concurrency, so they can't detect conflicts.

Useful for producing a deterministic tiebreak ordering everyone agrees on (append the process ID to break ties). Not useful for conflict detection.

## Vector clocks

One counter per node, carried as a vector.

```diagram
   3 nodes, each tracks [A, B, C]

   A does work:      [1,0,0]
   A → B (message):  B updates to [1,1,0]
   B does work:      [1,2,0]
   C does work:      [0,0,1]     ← independent

   COMPARING [1,2,0] and [0,0,1]:
     1 > 0 but 0 < 1  → neither dominates → CONCURRENT ✓
```

**Comparison rule:** V1 → V2 if every element of V1 ≤ the corresponding element of V2 **and** at least one is strictly less. If neither dominates, the events are concurrent — a genuine conflict that the application (or a [CRDT](crdts.html)) must resolve.

This is what lets Dynamo-style stores return **siblings** instead of silently picking a winner: the vector clock proves the two versions are concurrent rather than sequential.

**Cost:** the vector grows with the number of nodes that have ever written. In a system with many clients this becomes unwieldy, requiring pruning (which risks false "concurrent" verdicts). *Version vectors* — one entry per replica rather than per client — are the practical variant.

## Hybrid Logical Clocks (HLC)

The pragmatic modern answer, and worth naming because it's what many current systems use (CockroachDB, YugabyteDB, MongoDB).

An HLC timestamp is a pair: `(physical_time, logical_counter)`.

```diagram
   On event / send:
     pt = max(local_physical, last_pt)
     if pt == last_pt: counter++       else: counter = 0

   On receive(m_pt, m_counter):
     pt = max(local_physical, last_pt, m_pt)
     counter = appropriate max + 1 when times tie
```

**What you get:** timestamps that are *close to* physical time (so they're human-meaningful and usable for time-range queries), while still guaranteeing that causally related events are ordered correctly even when clocks skew. It captures causality like a Lamport clock, stays bounded in size (unlike vector clocks), and doesn't require special hardware (unlike TrueTime).

That combination — bounded size, causal correctness, physical meaning — is why HLC has become the default choice for new distributed databases.

## TrueTime and commit-wait

Spanner's approach: instead of pretending clocks are exact, **make the uncertainty explicit and wait it out**.

GPS receivers and atomic clocks in every datacenter keep skew tightly bounded. The API returns an *interval*, not a point:

```diagram
   TT.now() → [earliest, latest]     typically ~1-7ms wide

   COMMIT WAIT:
     assign the transaction timestamp T = TT.now().latest
     then WAIT until TT.now().earliest > T
     only then release locks and acknowledge
```

By waiting out the uncertainty window, Spanner guarantees that when a transaction commits, its timestamp is definitely in the past everywhere. That makes timestamps globally comparable, which gives **external consistency** (strict serializability) across regions — plus lock-free consistent snapshot reads at any past timestamp.

**The cost is explicit:** every read-write transaction pays a few milliseconds of deliberate waiting. Spanner trades latency for the strongest consistency guarantee available — a clean [PACELC](../01-fundamentals/cap-pacelc.html) "PC/EC" system.

**The insight worth stating:** you cannot eliminate clock uncertainty, but you *can* measure it and wait for it to pass. That's a fundamentally different strategy from pretending it doesn't exist.

## Choosing

| Need | Use |
|---|---|
| Display a timestamp to a human | Wall clock (accept it's approximate) |
| Measure a duration or timeout | **Monotonic clock** |
| Deterministic total order, no conflict detection | Lamport clock |
| Detect concurrent writes / conflicts | **Vector clocks** (version vectors) |
| Causal ordering with physical meaning, bounded size | **HLC** |
| Externally consistent transactions across regions | TrueTime-style bounded clocks + commit-wait |
| Ordering within one partition | A sequence number — simplest thing that works |

## The condensed version

When a design involves multiple writers to the same data:

> "I'm not going to order these by wall-clock timestamp — clock skew between servers is typically several milliseconds and can be much worse, and NTP can step a clock backwards, so last-write-wins would silently discard the write that actually happened last. For conflict *detection* I'd use version vectors so I can tell concurrent writes apart from sequential ones. For ordering with physical meaning I'd use hybrid logical clocks. And where I control the write path, the simplest correct answer is a per-entity sequence number from a single ordering point."

That answer identifies the failure, quantifies it, and gives three graded solutions ending with the simplest one — which is the shape of a strong response to nearly any distributed systems question.

:::exercise Order the events
1. Two servers with clocks 300 ms apart both write to the same key. Last-write-wins by wall clock picks one. Show how it can pick the *earlier* write.
2. Lamport timestamps give you a total order. What can you *not* conclude from `L(a) < L(b)`? What does a vector clock add?
3. TrueTime returns an interval, not a timestamp. Explain commit-wait, and compute the throughput cost if the uncertainty bound is 7 ms.
4. NTP steps your clock backwards by 2 seconds mid-transaction. Enumerate what breaks. Which of these does a monotonic clock fix?
5. Your logs from three services need to be interleaved to debug an incident. What do you need beyond wall-clock timestamps?
:::

:::paper Time in distributed systems
Lamport's *Time, Clocks, and the Ordering of Events in a Distributed System* (CACM 1978) is one of the most important papers in the field and is eight pages. Read it.

*Spanner* (Corbett et al., OSDI 2012) is TrueTime — bounding clock uncertainty with GPS and atomic clocks and then *waiting out* the uncertainty. *Logical Physical Clocks* (Kulkarni et al., 2014) is the hybrid logical clock used by CockroachDB and others.
:::
