---
title: Message Queues
summary: Why async decoupling changes a system's failure behavior, the log vs broker distinction, delivery semantics, ordering, and dead letter handling.
difficulty: Medium
scope: HLD
tags: [queue, kafka, async, decoupling]
prereqs: [scalability-basics, queueing-theory]
---

## What a queue actually buys you

A queue sits between a producer and a consumer, holding work until it can be processed. It looks like a small addition and it changes four properties of your system at once:

1. **Decoupling.** The producer doesn't know or care who consumes, how many consumers there are, or whether they're up. You can add consumers without touching the producer.
2. **Buffering.** Traffic spikes are absorbed by the queue instead of by your database. A 10× burst becomes a temporarily deeper queue rather than an outage.
3. **Load leveling.** A slow consumer no longer causes user-facing latency — the queue depth grows, the user already got their response.
4. **Retry and durability.** A failed message stays available to retry, instead of vanishing into a dropped HTTP call.

The cost, which you must name to score well: **you have traded latency and simplicity for resilience.** The work now happens "eventually," you need to handle duplicates, ordering gets complicated, debugging spans systems, and you've added a component that itself can fail.

:::interview When to introduce a queue
Say it as a decision, not a reflex: "The email send takes 800ms and can fail independently of the order. I don't want that in the user's request path, so I'll publish an event and let a worker handle it. The user gets a 200 in 50ms and the email is retried on failure. The tradeoff is that the email is no longer guaranteed to have been sent when we respond — which is fine, because the user's contract is 'order placed', not 'email delivered'."
:::

## Two families

The most useful distinction, and one that is frequently blurred.

### Traditional brokers (queue semantics)
*RabbitMQ, ActiveMQ, SQS*

The broker tracks per-message state. A consumer takes a message, acknowledges it, and the broker **deletes** it. Messages are distributed among consumers — each message goes to exactly one.

- Rich routing (topics, headers, fanout exchanges), per-message TTL, priority queues, and delayed delivery.
- Individual message acknowledgment means one poison message doesn't block others.
- Consumers are simple: no offset management.
- Throughput is lower (per-message bookkeeping), and once consumed, a message is gone — you can't replay.

### Log-based systems (stream semantics)
*Kafka, Pulsar, Kinesis, Redpanda*

An append-only, partitioned, durable log. Consumers track their own **offset**; messages are retained by time or size policy regardless of consumption.

```diagram
   Partition 0:  [m0][m1][m2][m3][m4][m5][m6][m7]...
                              ▲            ▲
                       consumer-B     consumer-A
                       offset=3       offset=7

   Independent consumer groups read the same data at
   their own pace. Nothing is deleted on read.
```

- **Replay.** Reset the offset and reprocess history — invaluable for bugs, backfills, and new consumers that need the past.
- **Multiple independent consumers** of the same stream, each with its own position.
- **Very high throughput** — sequential disk writes, zero-copy reads, batching. Hundreds of MB/s per broker.
- **Ordering within a partition** is guaranteed.
- Costs: no per-message ack (a stuck message blocks its partition), coarser retry semantics, more operational complexity, and consumer parallelism is capped by partition count.

**Choosing:** need replay, event sourcing, multiple consumers, or very high throughput → log. Need complex routing, per-message priority/TTL, or simple task distribution → broker. "Kafka for the event backbone, SQS/RabbitMQ for task queues" is a common and defensible combination.

## Delivery semantics

A guaranteed follow-up question. Be precise.

**At-most-once** — fire and forget. Acknowledge before processing. Messages can be lost, never duplicated. Acceptable only for disposable telemetry.

**At-least-once** — acknowledge *after* processing. If the consumer crashes mid-work, the message is redelivered. **Duplicates are guaranteed to happen eventually.** This is the practical default for nearly everything.

**Exactly-once** — the one to be careful about.

:::trap "Exactly-once delivery"
True exactly-once *delivery* is impossible over an unreliable network — it's equivalent to the two generals problem. A sender that gets no acknowledgment cannot know whether the message arrived, and must choose between resending (possible duplicate) and not (possible loss).

What systems actually provide is **exactly-once processing**: at-least-once delivery plus idempotent consumers, or a transactional read-process-write within one system (Kafka's transactions do this for Kafka-to-Kafka pipelines only).

The correct interview answer: "I'd use at-least-once delivery and make the consumer idempotent — dedupe on a message ID, or make the operation naturally idempotent with an upsert. Exactly-once delivery isn't achievable across systems; exactly-once *effect* is, and that's what matters." See [Idempotency](../03-distributed/idempotency.html).
:::

## Ordering

Global ordering across a distributed queue requires a single partition, which caps throughput at one machine. That's rarely acceptable, so real systems use **partial ordering**:

```diagram
   partition = hash(ordering_key) mod num_partitions

   All events for user 42       → same partition → ordered
   All events for conversation X → same partition → ordered
   Across different users        → no ordering guarantee (fine)
```

Choose the ordering key as the entity whose events must be sequential. This is exactly the [partition key](sharding.html) decision, with the same hot-spot risks.

**Ordering is also broken by retries and concurrency**, which candidates often miss:

- If a consumer processes messages concurrently, order is lost regardless of partitioning.
- If a failed message is retried later while subsequent ones succeeded, order is lost.
- Producer-side retries can reorder unless the producer enforces sequencing (Kafka's idempotent producer does this with sequence numbers).

The robust design response: **prefer commutative or version-checked operations over relying on order.** "Set status to X if version > current" survives reordering; "increment" doesn't care about order; "apply this delta" does.

## Consumer groups and scaling

Parallelism comes from partitions:

```diagram
   6 partitions, 3 consumers  → 2 partitions each     ✓ balanced
   6 partitions, 6 consumers  → 1 each                ✓ max parallel
   6 partitions, 8 consumers  → 2 consumers IDLE      ✗ wasted
```

**Partition count is your parallelism ceiling**, and it's awkward to increase later because it changes the key→partition mapping (breaking ordering for in-flight keys). Over-provision partitions up front — the same "pre-split generously" logic as virtual shards.

**Rebalancing** happens when consumers join or leave: partitions are reassigned. Naive rebalancing stops all consumption briefly ("stop the world"); modern protocols do it incrementally. Frequent rebalances — usually caused by consumers exceeding poll timeouts during slow processing — are a classic production pathology worth mentioning.

## Backpressure and queue depth

**Queue depth is your most important metric.** Interpret it correctly:

- **Stable depth** → producers and consumers are balanced. Healthy.
- **Growing depth** → consumers are behind. Either a spike (self-correcting) or under-provisioned consumers (not).
- **Depth at zero always** → possibly over-provisioned, but fine.

Alert on **consumer lag in time** ("we're 4 minutes behind"), not just message count — it's the number that maps to user impact.

An unbounded queue is a trap: it converts a throughput problem into a memory/disk problem plus unbounded latency. Messages processed hours late are often worse than useless — a notification about an event that already passed. Options: bounded queues that reject producers (real [backpressure](../03-distributed/backpressure.html)), TTLs that drop stale messages, or priority lanes so important work isn't stuck behind bulk work.

## Dead letter queues

Some messages will never succeed: malformed payloads, references to deleted entities, bugs. Without a DLQ, such a message is retried forever — burning capacity and, in a log-based system, **blocking its entire partition**.

```diagram
   consume → process → fail → retry (backoff) → fail → ...
                                     │
                              after N attempts
                                     ▼
                          ┌──────────────────┐
                          │  Dead Letter Q   │ → alert, inspect,
                          └──────────────────┘   fix, replay
```

Practices worth naming: keep the original message plus the error and stack trace; alert on DLQ arrivals (a non-empty DLQ is a bug, not a normal state); make replay a first-class operation; and distinguish retriable errors (timeout, 503) from permanent ones (validation failure) so you don't waste retries on messages that can never succeed.

## The outbox pattern

The most important queue-related correctness problem, and excellent material for a deep dive.

You need to update the database *and* publish an event. Two systems, no shared transaction:

```diagram
   BROKEN:
     BEGIN; INSERT order; COMMIT;
     publish("order_created")     ← crash here: order exists,
                                    nobody downstream knows

   BROKEN (other order):
     publish("order_created")
     BEGIN; INSERT order; COMMIT; ← fails: event for an
                                    order that doesn't exist
```

**The fix:** write the event into an `outbox` table *in the same database transaction* as the business change. A separate process reads the outbox and publishes, marking rows sent.

```diagram
   BEGIN;
     INSERT INTO orders ...;
     INSERT INTO outbox (event, payload) VALUES (...);
   COMMIT;                        ← atomic: both or neither

   [relay] poll outbox / read WAL → publish → mark sent
```

Now the event is published at-least-once and never diverges from the data. Combined with an idempotent consumer, you get exactly-once *effect*. See [CDC & Outbox](../04-data/cdc-outbox.html).

## Queue vs direct call

Don't use a queue for everything. A direct synchronous call is right when the caller genuinely needs the result to respond, when latency budget is tight, or when the operation is trivially fast and reliable. Adding a queue there costs latency and complexity for nothing.

| Use a queue | Use a direct call |
|---|---|
| Caller doesn't need the result | Caller needs the result now |
| Work is slow or bursty | Work is fast and predictable |
| Failure should be retried later | Failure should surface immediately |
| Multiple independent consumers | Exactly one known consumer |
| Load smoothing is valuable | Latency budget is tight |

:::exercise Design for the failure cases
1. A consumer processes a message and crashes before acknowledging. What happens under at-least-once? What must the consumer have done to make that safe?
2. A poison message sits at the head of a partition. Adding consumers does not help. Explain why, and design the fix.
3. Producers send 1,200 msg/s; consumers drain 1,000/s. Plot queue depth and consumer lag over 10 minutes. When does the system recover, and what should you alarm on?
4. You need strict ordering per user but parallelism across users. Design the partitioning, and say what happens when you add partitions later.
5. Compare a log-based queue and a visibility-timeout queue for: replay, ordering, per-message retry, and consumer scaling. Which would you pick for a payment pipeline?
:::

:::paper Log-structured messaging
*Kafka: A Distributed Messaging System for Log Processing* (Kreps, Narkhede & Rao, NetDB 2011) is the original design; Jay Kreps' essay *The Log: What every software engineer should know about real-time data's unifying abstraction* is the conceptual argument and is worth reading in full.

*Amazon SQS* and Google Pub/Sub's documentation cover the visibility-timeout model, which is a genuinely different design from the log model and suited to different problems.
:::
