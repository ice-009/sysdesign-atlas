---
title: Stream Processing
summary: Event time versus processing time, watermarks, windowing, and what "exactly-once" actually means — the machinery for computing over data that never stops arriving.
difficulty: Hard
scope: HLD
tags: [data, streaming, flink, exactly-once]
prereqs: [message-queues, clocks, idempotency]
unlocks: Designing correct aggregations over unbounded, late, out-of-order data.
---

:::predict Guess first
1. A phone records a click at 09:58 offline and sends it at 10:47. Which hour should that click count towards?
2. If events can arrive hours late, when should a "clicks per 5 minutes" window publish its answer?
3. A framework promises "exactly-once". Your job sends an email for every event. Can a customer get two emails?
:::

## The shift from batch to stream

A batch job has a luxury it never acknowledges: **the data is complete.** When you run yesterday's report, yesterday is over. Every record that will ever belong to that window has arrived. You can sort, join, aggregate, and know the answer is final.

Streaming removes that. Data arrives continuously, out of order, sometimes hours late, and you have to produce answers before you know whether more input is coming.

Every hard problem in stream processing follows from that one difference.

## The two clocks

```viz
{
  "type": "compare",
  "caption": "Which clock you group by determines whether your results are correct or merely prompt.",
  "left": {
    "title": "Event time",
    "items": [
      "When the thing actually happened",
      "Embedded in the record by the producer",
      "Results are deterministic and reproducible",
      "But you must wait for stragglers"
    ]
  },
  "right": {
    "title": "Processing time",
    "items": [
      "When your operator saw the record",
      "Trivial to implement, always available",
      "Low latency, no waiting",
      "Replay gives different answers every time"
    ]
  }
}
```

```diagram
   A mobile app buffers events offline. The user goes into a tunnel
   at 09:58 and reconnects at 10:47.

     Event time of the click:       09:58
     Processing time at your job:   10:47

   "Clicks in the 09:55-10:00 window" is a question about event time.
   Answering it in processing time puts the click in the 10:45 bucket
   and the answer is simply wrong.
```

**Almost every business question is an event-time question.** Revenue per hour, sessions per user, fraud within a 5-minute window — all of these mean *when it happened*, not *when we found out*. Processing time is only acceptable for questions genuinely about your own system, like throughput monitoring.

The cost of event time is that you must decide **how long to wait** for late data. That decision is a watermark.

## Watermarks

A watermark is an assertion the system makes to itself:

> "I believe I have now seen all events with timestamp ≤ T."

It is a guess, not a fact — nothing can prove no more events are coming. But a stream never ends, so without some rule for declaring "enough", you could never publish a result at all. The watermark is that rule: the point at which a time window is considered complete enough to report on.

```diagram
   Records arriving (event times, out of order):

     10:03  10:01  10:04  10:02  10:07  10:05  [10:02 ← LATE]  10:09

   Watermark strategy: "max event time seen minus 5 minutes"

     after 10:07 → watermark = 10:02
     after 10:09 → watermark = 10:04

   When watermark passes 10:05, the 10:00-10:05 window fires.
   The late 10:02 record arrives AFTER that. Now what?
```

That last question has exactly three answers, and choosing among them is a product decision, not a technical one:

| Strategy | Behaviour | Right for |
|---|---|---|
| **Drop** | Discard records past the watermark | Monitoring, approximate dashboards |
| **Side output** | Route late records to a separate stream for inspection or manual handling | Anything where you need to know how much you're losing |
| **Allowed lateness + retract** | Keep window state open longer; re-emit a corrected result that supersedes the earlier one | Billing, analytics that must eventually be exact |

:::goat The tradeoff to state explicitly
**Watermark delay is a dial between latency and completeness, and there is no setting that gives you both.**

A 10-second watermark means results in 10 seconds, missing anything later. A 1-hour watermark catches nearly everything but your dashboard is an hour behind.

The mature answer is usually *both*: emit an early speculative result on a short watermark, then emit corrections as late data arrives, with downstream consumers designed to handle retractions. That's a real design constraint you're pushing onto consumers, so it has to be stated, not assumed.
:::

## Windows

Unbounded streams have to be cut into finite chunks before you can aggregate. Four shapes cover nearly everything:

```diagram
   TUMBLING (fixed, non-overlapping)
     [00-05][05-10][10-15]        "revenue per 5 minutes"
     each event in exactly one window

   SLIDING / HOPPING (fixed size, overlapping)
     [00────05]
        [01────06]
           [02────07]             "5-minute average, updated each minute"
     each event in size/slide windows → 5× the state

   SESSION (dynamic, gap-based)
     [ev ev ev]......[ev ev]      "user session = activity with
     gap > 30 min closes it        no 30-minute gap"
     windows have data-dependent boundaries

   GLOBAL (one window, custom trigger)
     [everything]                 "every 1,000 events" or a custom rule
```

**Sliding windows are a state multiplier people miss.** A 1-hour window sliding every minute means each event belongs to 60 windows, so you hold 60× the state. At scale this is the difference between a job that fits in memory and one that doesn't. If you need per-minute updates over an hour, an incremental aggregation over a tumbling window is usually far cheaper than a true sliding window.

**Session windows are the expensive ones** because boundaries are data-dependent — you cannot know a session has ended until the gap elapses, and a late event can *merge two previously separate sessions*, which means retracting both results and emitting a combined one.

## State, and why it dominates operations

A stateless map is easy. Everything interesting in streaming is stateful: aggregations, joins, deduplication, session tracking. That state can be enormous — a job tracking 100 million users' sessions holds 100 million entries — and it must survive failure.

```viz
{
  "type": "stack",
  "caption": "State management is most of what a stream processor does for you.",
  "layers": [
    { "label": "Local state store", "sub": "RocksDB on local disk, hot path", "accent": "#38bdf8" },
    { "label": "Changelog", "sub": "every mutation appended to a durable log", "accent": "#a78bfa" },
    { "label": "Checkpoint / snapshot", "sub": "periodic consistent cut to object storage", "accent": "#4ade80" },
    { "label": "Recovery", "sub": "restore snapshot, replay log from that offset", "accent": "#fbbf24" }
  ]
}
```

The critical property is that **the state snapshot and the input offset must be consistent with each other**. Restoring state from 10:00 while resuming input from 10:05 silently loses five minutes of updates; resuming from 09:55 double-counts five minutes. The snapshot must record exactly which offsets it includes.

Flink does this with the **Chandy–Lamport distributed snapshot** algorithm: inject a barrier into the stream, have every operator snapshot its state when the barrier passes, and you get a consistent cut across the whole distributed job without stopping it. This is the same idea as a [consistent snapshot](transactions-isolation.html) in a database, applied to a dataflow graph.

## "Exactly-once" — what it actually means

The most misunderstood phrase in streaming. Let's be precise, because the imprecision causes real bugs.

**You cannot have exactly-once *delivery*.** It's impossible in an asynchronous network with failures — the sender can never know whether a lost acknowledgement means the message arrived or didn't, so it must either risk losing it or risk duplicating it. This is a theorem, not a limitation of current tools.

**You can have exactly-once *effects*:** a record may physically arrive and be processed several times, but the job's stored results look exactly as though it happened once. The delivery is messy; the outcome isn't. That distinction — between how many times something ran and how many times it counted — is the whole of what the machinery below buys you.

```diagram
   What the machinery gives you:

     input offsets + operator state + output commit
       all move together, atomically, at each checkpoint

     On failure: roll back to the last checkpoint,
     replay from those offsets, recompute.
     Internal state ends up identical.

   What it does NOT give you:

     Any guarantee about side effects your code performs
     directly — an HTTP POST, an email, a payment.
     Those happen on every replay.
```

:::trap "We use Flink with exactly-once, so our side effects are safe"
Exactly-once covers state managed *by the framework* and sinks that participate in its transaction protocol. It says nothing about a `POST` you make from inside a map function.

For external effects there are exactly two correct options:

1. **A transactional sink** that participates in the checkpoint — Kafka transactions, a two-phase-commit sink, or writing to a store that supports atomic offset-plus-data commits.
2. **[Idempotent](../03-distributed/idempotency.html) writes** — upsert by a deterministic key, or deduplicate on the receiving side with an idempotency key.

If neither applies, you have at-least-once, and you should design for it explicitly rather than assume the framework covered you.
:::

## Stream joins

Joining two unbounded streams raises a question a batch join never has to answer: **how long do you keep a record around waiting for its partner?**

| Join type | Mechanism | Cost |
|---|---|---|
| **Stream–stream (windowed)** | Buffer both sides for a bounded interval; emit matches within it | State proportional to window × rate on both sides |
| **Stream–table** | Enrich each event from a materialised lookup table | Table must be replicated to every task; watch for skew |
| **Temporal / versioned join** | Join against the version of the table *as of the event's timestamp* | Requires versioned state; the correct choice for prices, rates, and config |

The temporal join is the one that's usually needed and rarely used. If you join an order stream against a `currency_rates` table, joining against the *current* rate is wrong — you want the rate that was in effect when the order was placed. Replaying the job a month later with a plain lookup gives different (and incorrect) results; a temporal join gives the same answer forever. **Reproducibility on replay is the test for whether your join is correct.**

## Choosing an engine

| System | Model | Where it fits |
|---|---|---|
| **Kafka Streams** | Library, no cluster; state in RocksDB + changelog topics | Kafka-native services; deploy as a normal app |
| **Flink** | True streaming, event time, sophisticated state and snapshots | The most complete engine; complex jobs, large state |
| **Spark Structured Streaming** | Micro-batch (continuous mode exists but is limited) | Teams already on Spark; batch/stream code sharing |
| **Materialize / RisingWave** | Incremental view maintenance over SQL | "Keep this SQL query's result always up to date" |
| **A consumer loop you wrote** | Whatever you build | Genuinely fine for stateless or small-state transforms — don't reach for a cluster to filter a topic |

:::goat Know when not to stream
Streaming buys **low latency on unbounded data**. It costs a great deal of operational complexity: state management, checkpointing, backfills, schema evolution on a running job, and debugging a system where you cannot easily re-run yesterday.

A very large fraction of "real-time" requirements are satisfied by a batch job every five minutes, which is dramatically simpler to build, test, backfill, and reason about. Ask what the latency requirement actually is and who is harmed by a five-minute delay — often nobody is, and the honest answer is that batch is correct here.

When it *is* genuinely needed — fraud detection, live pricing, alerting, [ad click aggregation](../08-case-studies/ad-click-aggregator.html) — streaming is the right tool and the complexity is earned.
:::

## Exercise

:::exercise Design the aggregation
You're computing "unique viewers per video per hour" for a video platform. Mobile clients buffer events offline for up to 24 hours.

1. Event time or processing time? What breaks if you choose the other one?
2. What watermark delay would you use, and what percentage of events do you expect to lose at that setting? How would you *measure* that rather than guess?
3. "Unique viewers" needs deduplication. Exact counts need per-window state proportional to viewer count. What does HyperLogLog cost you, and is that acceptable here? (See [Bloom filters](../02-building-blocks/bloom-filters.html) for the same family of trade.)
4. A record arrives 20 hours late. Walk through all three late-data strategies and say which you'd ship, and what you'd tell the consumers of this data.
5. The job crashes and restarts from a checkpoint 3 minutes old. What does the downstream dashboard see, and how do you keep it from double-counting?
:::

:::paper Sources
*The Dataflow Model* (Akidau et al., VLDB 2015) is the foundational paper — event time, windows, triggers, and the "what/where/when/how" framing every modern engine uses. Akidau's *Streaming 101/102* blog posts are the readable version.

*Lightweight Asynchronous Snapshots for Distributed Dataflows* (Carbone et al., 2015) is Flink's checkpointing mechanism, descended from Chandy–Lamport's *Distributed Snapshots* (1985).
:::

## Check yourself

```recall
Q: Event time versus processing time — which do business questions need?
A: Event time — when it happened. Processing time (when your job saw it) is easy but gives different answers on replay and misplaces late events; it's only fine for questions about your own system.

Q: What is a watermark?
A: The system's assertion "I've probably seen every event up to time T" — a heuristic, not a fact — which decides when a window is complete enough to emit.

Q: Name the three ways to handle data that arrives after the watermark.
A: Drop it (dashboards), send it to a side output to measure and inspect, or allow lateness and emit a corrected result that supersedes the earlier one (billing).

Q: What trade-off does the watermark delay control?
A: Latency against completeness: a short delay is fast but misses late data, a long delay is complete but slow. The mature design emits an early result and then corrections, and consumers must handle retractions.

Q: Why are sliding windows expensive?
A: Each event belongs to size ÷ slide windows — a 1-hour window sliding every minute keeps 60× the state. Incremental aggregation over tumbling windows is usually cheaper.

Q: What must a checkpoint keep consistent?
A: Operator state, input offsets and output commit, all at the same cut. Restore state from 10:00 but resume input at 10:05 and you silently lose five minutes; resume at 09:55 and you double-count.

Q: What does "exactly-once" actually mean in stream processing?
A: Exactly-once effects on framework-managed state and transactional sinks — not delivery, which is impossible. Side effects your code performs directly, like HTTP calls or emails, repeat on replay unless idempotent.

Q: Why use a temporal join for currency rates?
A: Join each order to the rate in effect at the order's event time, not the current rate. Then replaying the job a month later gives the same answer; reproducibility on replay is the correctness test.
```

## What to carry forward

- **Event time versus processing time** is the root distinction. Business questions are almost always event time.
- **Watermarks are heuristics** that trade completeness for latency. Decide the late-data policy explicitly.
- **Sliding windows multiply state**; session windows can retroactively merge.
- **State + input offset + output commit must move atomically** — that's what checkpointing buys.
- **"Exactly-once" means state semantics, not delivery.** External side effects need transactional sinks or idempotency.
- **Temporal joins**, not current-value lookups, are what make a job reproducible on replay.
- A five-minute batch job is often the correct answer. Make streaming justify itself.
