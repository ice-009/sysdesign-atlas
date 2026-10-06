---
title: Design a Message Queue (Kafka-like)
summary: A queue that keeps messages instead of deleting them — topics split into append-only logs, consumers that track their own position, replication that decides when a message is truly safe, and the disk tricks that let one machine move gigabytes a second.
difficulty: Hard
scope: HLD
tags: [case-study, messaging, log, replication]
prereqs: [message-queues, consensus, idempotency]
---

:::predict Guess first
1. A traditional queue deletes a message once it's read. What becomes possible if messages are kept for a week instead?
2. Messages for order #8821 must arrive in order, but the topic has 64 partitions. How do you keep them in order?
3. A message is on the leader but not yet on any follower, and the leader dies. Should consumers have been allowed to read it?
:::

:::interview Why this question
Most candidates have *used* a message queue; this asks them to *build* one. It tests the idea of a log as a storage structure, replication with a precise definition of "safely written", consumer groups, and delivery guarantees — plus why sequential disk access is fast. It's also the foundation under [stream processing](../04-data/stream-processing.html) and much of [pub/sub](../02-building-blocks/pub-sub.html), so the ideas pay off widely.
:::

## 1. Requirements

**Functional**
- Producers publish messages to named **topics**.
- Consumers read messages in the order they were written (for related messages).
- Several independent consumer groups can each read the full stream — billing, analytics and search all read `orders`.
- A consumer can **rewind** and re-read from an earlier point.
- Messages are kept for a set time (say 7 days), whether or not anyone has read them.

**Non-functional**
- **Durable:** a message the system has acknowledged is never lost, even if a machine dies.
- **High throughput:** a million messages a second.
- **Low latency:** a few milliseconds from publish to readable.
- **Ordering per key:** all messages about order #8821 arrive in the order they were sent.

**Out of scope:** per-message routing rules and priorities (that's the "smart broker" family — see the two families in [Message Queues](../02-building-blocks/message-queues.html)).

## 2. Estimation

**1M messages/s, 1 KB each, 3 copies, kept 7 days, read by 3 consumer groups.**

```diagram
   Incoming:      1M × 1 KB                    = 1 GB/s
   Disk writes:   × 3 copies                   = 3 GB/s across the cluster
   Outgoing:      × 3 consumer groups          = 3 GB/s

   Stored:        1 GB/s × 604,800 s (7 days)  ≈ 600 TB
                  × 3 copies                   ≈ 1.8 PB

   One machine: 12 disks × 8 TB = 96 TB, keep ~70% full → ~67 TB usable
                1.8 PB / 67 TB                 ≈ 27 machines (for space)
   Writes per machine: 3 GB/s / 27            ≈ 110 MB/s — easy for sequential disk
```

**What this decided:** storage space, not speed, sets the machine count — *if* writes are sequential. That's the design's central bet: turn every write into an append at the end of a file.

## 3. The core idea — a log, not a queue

A traditional queue deletes a message once a consumer takes it. A log **keeps every message in order** and lets each reader remember where it is.

```diagram
   topic "orders", partition 0  (append-only; offsets only grow)

   offset:   0    1    2    3    4    5    6    7    8   ← appended here
            [m0][m1][m2][m3][m4][m5][m6][m7][m8]
                      ▲                   ▲
          billing group at offset 2       analytics group at offset 6

   Reading doesn't delete. Each group just remembers its own offset.
```

This one change gives you most of the requirements for free:

- **Many independent readers** — each group has its own offset; they never interfere.
- **Rewind** — set the offset back.
- **A slow reader doesn't affect a fast one.**
- **Retention is by time, not by reading** — delete whole old files after 7 days.

**Partitions** make it scale. A topic is split into, say, 64 partitions, each its own log, spread across machines. A message goes to partition `hash(key) % 64`, so all messages with the same key — the same order id — land in the same partition, in order. **Ordering is guaranteed within a partition, never across them.**

## 4. High-level design

```diagram
   producers ──"orders", key=8821──▶ leader of partition hash(8821) % 64
                                          │
   ┌──────────── broker 1 ───────────┐   │   ┌──────────── broker 2 ───────────┐
   │ orders-p0  LEADER               │◀──┘   │ orders-p0  follower (copies)    │
   │ orders-p1  follower             │       │ orders-p1  LEADER               │
   └─────────────────────────────────┘       └─────────────────────────────────┘
                     ▲                                      ▲
                     └──────── controller (a small consensus group) ────────┘
                               knows: which broker leads each partition,
                               which copies are in sync, which brokers are alive

   consumer group "billing":  consumer A ← p0, p1     consumer B ← p2, p3 …
```

- **Brokers** store partitions. Each partition has one **leader** that takes all writes and reads, and **followers** on other brokers that copy it.
- A **controller** — a small cluster agreeing by [consensus](../03-distributed/consensus.html) — holds the cluster's map: who leads what, and who's alive. It's the only part that needs consensus; the data path doesn't. (Kafka ran this on ZooKeeper until Kafka 4.0, in 2025, made its own Raft-based controller, KRaft, the only option.)
- **Consumers in a group split the partitions** among themselves. Each partition is read by exactly one consumer in the group, which is what keeps per-partition ordering.

## 5. Deep dive — storage, and why it's fast

Each partition is a directory of **segment files**, about 1 GB each. New messages append to the newest segment; when it's full, a new one starts.

```diagram
   orders-p0/
     00000000000000000000.log     offsets 0 – 1,048,575         (sealed)
     00000000000001048576.log     offsets 1,048,576 – …         (sealed)
     00000000000002097152.log     ← active: appends go here
     + a small index per segment:  every ~4 KB, "offset N is at byte B"
```

**Finding an offset:** pick the segment by its starting offset (binary search over file names), then use its index to jump close to the right byte. **Retention:** delete whole segment files older than 7 days — no per-message deletes, no fragmentation.

Why one machine moves gigabytes a second:

- **Sequential writes.** Appending to the end of a file is the fastest thing a disk does — hundreds of MB/s even on spinning disks, far beyond random writes.
- **The operating system's page cache.** Recently written data stays in memory, so consumers that are keeping up read from RAM, not disk.
- **Zero-copy sends.** To serve a consumer, the broker asks the OS to send file bytes straight from the page cache to the network socket, without copying them through the application.
- **Batching.** Producers send many messages per request, compressed together; the broker writes the batch as-is and consumers receive it as-is.

**Say this:** *"The broker is mostly a thin layer over append-only files. Writes are sequential, recent reads come from the page cache, and data goes from cache to socket without copying — so throughput is limited by the network, not the disk."*

**Log compaction** is an option for some topics: instead of deleting by age, keep only the **latest message per key**. That turns a topic into a durable table of "current value per key" — useful for things like user settings.

## 6. Deep dive — replication, and when a message is safe

The leader appends a message; followers fetch from the leader and append the same bytes. The questions that matter: *when do we tell the producer "done"?* and *what can consumers see?*

```diagram
   leader:      [0][1][2][3][4][5][6]        holds 0–6
   follower A:  [0][1][2][3][4][5]           holds 0–5
   follower B:  [0][1][2][3][4]              holds 0–4
                               ▲
                 high-water mark = 5: offsets 0–4 are on every in-sync copy
                 consumers may read up to offset 4, no further
```

- **In-sync replicas (ISR):** the copies that are keeping up (within a few seconds). A follower that falls behind is dropped from the set until it catches up.
- **High-water mark:** the highest offset present on *every* in-sync copy. Consumers only see messages below it. That's what guarantees a consumer never reads a message that could later vanish when a leader dies.
- **Acknowledgement:** with `acks=all`, the producer hears "done" only when every in-sync copy has the message. Combine with "at least 2 copies must be in sync" and an acknowledged message survives any single machine failure.

**When a leader dies,** the controller promotes a follower *from the in-sync set*, which has every acknowledged message by definition.

:::goat The trade-off to name
*"What if every in-sync copy is gone?"* You choose: wait for one of them to come back (no data loss, the partition is unavailable meanwhile), or promote an out-of-date copy (available again now, but recent acknowledged messages are lost). This is called an **unclean leader election**, and it's a setting.

*"For payments I'd never allow it — I'd rather be down than lose messages. For click-tracking I might allow it."* That's [CAP](../01-fundamentals/cap-pacelc.html) as a configuration switch, and explaining it per use case is what a senior answer sounds like.
:::

## 7. Deep dive — consumer groups and delivery guarantees

**Assignment.** A group coordinator (on one of the brokers) tracks which consumers are alive and assigns partitions among them. When a consumer joins, leaves or stops sending heartbeats, partitions are **rebalanced**. Two consequences worth saying:

- **More consumers than partitions is pointless** — extras sit idle. The partition count is the ceiling on a group's parallelism, so choose it generously up front.
- During a rebalance, consumption pauses briefly. Newer designs move only the partitions that need to move, rather than stopping everyone.

**Where offsets live.** Each group commits "I've processed up to offset N" — stored in the cluster itself, in an internal compacted topic. On restart, a consumer resumes from its last commit.

**Delivery guarantees come from *when* you commit:**

| Commit the offset… | If the consumer crashes in between | Guarantee |
|---|---|---|
| after processing | reprocessed on restart | **at-least-once** — duplicates possible |
| before processing | skipped on restart | **at-most-once** — losses possible |

At-least-once is the usual choice, with consumers that are [idempotent](../03-distributed/idempotency.html) — processing the same message twice has the same effect as once.

**Exactly-once, honestly.** Inside the log system it's achievable: producers get an id and number their messages so the broker drops retried duplicates, and a *transaction* can write output messages and the consumer's offset commit together, all or nothing. But once a consumer does something *outside* — sends an email, charges a card — exactly-once is back to being your job, through idempotency keys. Say both halves.

## 8. Scaling and operations

**Adding partitions breaks key ordering.** `hash(key) % 64` becomes `% 128`, so a key's new messages go to a different partition than its old ones. That's why you over-provision partitions at creation.

**Adding brokers means moving data.** New brokers start empty; partitions are reassigned by copying them over, throttled so the copy doesn't starve live traffic.

**Hot partitions.** A skewed key — one giant customer — overloads one partition. Fixes: a better key, or a key with a small random suffix for that customer (giving up strict ordering for them).

**Tiered storage.** Keep recent segments on local disk and move older ones to [object storage](../02-building-blocks/object-storage.html). Retention can then be months, at object-storage prices, while the brokers only hold the hot tail.

**Diskless topics** go a step further. In the cloud, brokers copying data to followers in other availability zones pay for every byte that crosses a zone — often the largest line on a Kafka bill. A diskless design has brokers batch incoming messages and write them straight to object storage, which already replicates across zones. Brokers become stateless, and any broker can serve any partition. The cost is latency: an object-storage write takes hundreds of milliseconds rather than a few. WarpStream (acquired by Confluent in 2024) built a Kafka-compatible system this way, and Apache Kafka accepted KIP-1150 for diskless topics in March 2026. Choose per topic: classic replication where latency matters, diskless for high-volume logs where a second of delay doesn't.

## 9. Failure modes & follow-ups

**A broker dies.** Its leaderships move to in-sync followers within seconds; producers and consumers refresh the map and carry on. When it returns, it catches up from the new leaders before rejoining the in-sync set.

**A consumer falls far behind.** If its *lag* exceeds retention, the oldest unread messages are deleted before it reads them. Alert on lag well before that point — it's the single most important number to watch.

**A poison message** that crashes the consumer every time. Count failures per message; after a few, write it to a dead-letter topic and move on, so one bad message doesn't block the partition forever.

**"Why not just use a database table as a queue?"**
> "It works at small scale. But consumers poll with `SELECT … FOR UPDATE SKIP LOCKED`, deletes fragment the table, and many independent readers each need their own copy or flags. A log makes multiple readers, replay and retention free, and turns every write into an append."

:::exercise Design decisions
1. A topic needs ordering per customer and peaks at 200,000 messages/s; one consumer handles 5,000/s. How many partitions, at minimum? How many would you create, and why more?
2. Replication factor 3, at least 2 in sync, `acks=all`. Which failures lose no acknowledged data? Which make the partition stop accepting writes?
3. A consumer commits offsets every 5 seconds, after processing, and crashes 4 seconds after its last commit. What happens to the messages from those 4 seconds — and what must the consumer's code guarantee?
4. Estimate storage for 30 days instead of 7, with tiered storage keeping only 1 day on brokers. How many brokers does disk space now require?
:::

:::paper Further study
*Kafka: a Distributed Messaging System for Log Processing* (Kreps, Narkhede & Rao, NetDB 2011) is the original design, built around the ideas in sections 3 and 5.

*The Log: What every software engineer should know about real-time data's unifying abstraction* (Jay Kreps, 2013) is an essay arguing that the append-only log is the central structure behind databases, replication and stream processing.
:::

## Check yourself

```recall
Q: Why is a log better than a queue for many consumers?
A: Reading doesn't delete; each consumer group keeps its own offset. Independent readers, rewind and slow readers come free, and retention is by time — delete whole old segment files.

Q: How do partitions scale a topic while keeping order?
A: Each partition is its own log; a message goes to hash(key) % partitions, so one key always lands in one partition. Order is guaranteed within a partition, never across them.

Q: Why can one broker move gigabytes a second?
A: Sequential appends to segment files, recent reads served from the OS page cache, zero-copy sends from cache to socket, and compressed producer batches stored as-is.

Q: What are the ISR and the high-water mark?
A: In-sync replicas are copies keeping up with the leader. The high-water mark is the highest offset on every in-sync copy; consumers only read below it, so they never see a message that could vanish on failover.

Q: What is an unclean leader election?
A: If every in-sync copy is gone: wait (no loss, unavailable) or promote a stale copy (available, but acknowledged messages are lost). A per-topic setting — never for payments, maybe for clicks.

Q: How do commit timing and delivery guarantees relate?
A: Commit after processing gives at-least-once (crashes cause reprocessing — make consumers idempotent); commit before gives at-most-once. Exactly-once holds inside the log via idempotent producers and transactions, not for external side effects.

Q: Why over-provision partitions up front?
A: Partition count caps a group's parallelism, and adding partitions later changes hash(key) % N, breaking per-key ordering.

Q: What do tiered storage and diskless topics change?
A: Tiered storage moves old segments to object storage for cheap long retention. Diskless topics write everything to object storage, removing costly cross-zone replication and making brokers stateless, at the cost of hundreds of milliseconds of latency.
```

## What to carry forward

- Keep messages in an append-only log; consumers track their own offsets.
- Partition by key: ordering per partition, parallelism capped by partition count.
- Sequential writes, page cache and zero-copy make the broker network-bound.
- acks=all with in-sync replicas and a high-water mark defines "safely written".
- At-least-once plus idempotent consumers; object storage extends retention or replaces replication.
