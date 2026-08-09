---
title: Durability & the Write-Ahead Log
summary: What "the write succeeded" actually promises — fsync, group commit, torn writes, and the several layers of hardware that will cheerfully lie to you about all of it.
difficulty: Medium
tags: [data, durability, wal, storage]
prereqs: [storage-engines, failure-modes]
unlocks: Knowing exactly what a database has guaranteed when it returns success.
---

## The question nobody asks precisely enough

Your database returns `OK` on a write. What just happened?

The honest range of possibilities:

```diagram
   "OK" might mean any of these:

     1. It's in the process's memory buffer          ← survives nothing
     2. It's been write()n to the OS page cache      ← survives process crash
     3. It's been fsync()'d to the drive             ← survives OS crash / power loss
     4. It's fsync()'d AND replicated to a follower  ← survives losing this machine
     5. It's fsync()'d on a majority in 3 AZs        ← survives losing a datacenter
```

Every one of these is called "durable" by someone. They differ by roughly six orders of magnitude in both safety and cost. **Knowing which one your system provides is the entire content of the durability question**, and most incidents in this area come from a team believing they had level 4 and actually having level 2.

## Why a log, rather than just writing the data

The naive approach — update the B-tree page in place and be done — fails on the crash case. A page update touches multiple pages (the leaf, maybe a parent after a split, maybe a free-space map). A crash halfway through leaves the tree structurally corrupt, and there is no way to tell which of the writes landed.

The write-ahead log solves this with one rule:

> **Write the intent to a sequential log, and fsync it, *before* modifying the actual data pages.**

```viz
{
  "type": "flow",
  "caption": "The WAL is the durable record. Data pages are a cache of it that can be rebuilt.",
  "nodes": [
    { "id": "c", "label": "Commit request", "col": 0, "accent": "#38bdf8" },
    { "id": "w", "label": "Append to WAL", "sub": "sequential write", "col": 1, "accent": "#a78bfa" },
    { "id": "f", "label": "fsync", "sub": "the durability point", "col": 2, "accent": "#fb7185" },
    { "id": "a", "label": "Ack client", "col": 3, "accent": "#4ade80" },
    { "id": "p", "label": "Apply to pages", "sub": "later, lazily, batched", "col": 4, "accent": "#fbbf24" }
  ],
  "edges": [
    { "from": "c", "to": "w" },
    { "from": "w", "to": "f" },
    { "from": "f", "to": "a" },
    { "from": "a", "to": "p", "dashed": true }
  ]
}
```

This buys three things at once:

1. **Crash recovery.** On restart, replay the log from the last checkpoint. Any change that was acknowledged is in the log; any change in the log but not in the pages gets reapplied.
2. **Sequential writes instead of random ones.** The log is append-only. As [the hardware numbers](../01-foundations/hardware-numbers.html) show, sequential writes are dramatically faster than scattered page updates — so the WAL makes commits *faster*, not slower, despite being extra work.
3. **A replication stream for free.** The log is already an ordered record of every change. Ship it to a follower and you have physical replication; decode it and you have [CDC](cdc-outbox.html).

:::goat The reframe worth having
**The log is the database. The tables are a materialised view of it.**

Once you see it this way, a lot of apparently separate machinery turns out to be the same machinery: replication is shipping the log, point-in-time recovery is replaying the log to a timestamp, CDC is decoding the log, and read replicas are the log applied elsewhere. Kafka is the same idea promoted to a product.
:::

## fsync, and everything that lies about it

`write()` does not put data on a disk. It copies bytes into the OS page cache and returns. The kernel flushes them later, whenever it feels like it — typically within 30 seconds. A power loss in that window loses the data, and your application was told the write succeeded.

`fsync()` is the call that says *actually put it on stable media and don't return until you have*. It is the single most expensive operation in a database.

:::derive What durability costs
```
   fsync on NVMe SSD          ~50-500 µs
   fsync on SATA SSD          ~1 ms
   fsync on spinning disk     ~5-10 ms  (a full rotation)
   fsync on network storage   ~1-10 ms  (EBS and friends)

   A transaction system doing one fsync per commit:

     NVMe:     1 / 0.0002 s  =  ~5,000 commits/s  (single-threaded)
     EBS:      1 / 0.002 s   =    ~500 commits/s

   → With one fsync per commit, your commit rate is a hardware
     constant. No amount of CPU helps.
```
:::

**Group commit** is the standard escape. Rather than fsyncing per transaction, collect all transactions that commit within a small window, write them as one log batch, and fsync once for the group.

```diagram
   WITHOUT group commit          WITH group commit

   T1 → fsync (200 µs)           T1 ┐
   T2 → fsync (200 µs)           T2 ├→ one batched write
   T3 → fsync (200 µs)           T3 ┘  → one fsync (250 µs)
   ...                                → ack all three

   1,000 txns = 200 ms           1,000 txns in ~20 fsyncs = ~5 ms

   Cost: each transaction waits up to one window (~1 ms) longer.
   Benefit: throughput scales with batch size, not fsync latency.
```

This is a **throughput-for-latency trade**, and it's the same shape as batching everywhere else in systems — right down to continuous batching on GPUs in the AI Infrastructure track. Under load the batches grow naturally, so the system gets *more* efficient exactly when it needs to.

:::trap Every layer in the stack has lied about fsync at some point
- **Consumer SSDs** have historically acknowledged flushes while data sat in a volatile write cache. Enterprise drives have power-loss-protected caches (a capacitor) and are honest; consumer drives frequently are not.
- **`fsync()` on Linux used to lose errors.** Before 4.13, if a writeback error occurred, the error was reported to *one* fsync caller and then the dirty page was marked clean. A subsequent fsync returned success on data that was never written. Postgres shipped a fix — "fsyncgate", 2018 — that now panics rather than retrying, because retrying is unsafe.
- **Virtualised and network storage** adds another cache layer with its own semantics.
- **`fsync` on a file does not guarantee the directory entry.** Creating a file and fsyncing it can still leave the file absent after a crash unless you also fsync the parent directory.

The practical takeaway: durability claims must be tested with actual power loss (or a fault-injecting block layer), not assumed from documentation.
:::

## Torn writes and why checksums are mandatory

Filesystems and drives guarantee atomicity for a *sector* (512 B or 4 KB). Databases use pages of 8–16 KB. A crash mid-write can therefore leave a page with the first 4 KB new and the rest old — a **torn page**. The page is not corrupt in any way the hardware can detect; it's simply a mixture of two versions.

Three standard defences:

| Approach | Mechanism | Used by |
|---|---|---|
| **Full-page writes** | After each checkpoint, the first modification to a page writes the whole page to the WAL, so recovery can restore it wholesale | PostgreSQL |
| **Doublewrite buffer** | Write the page to a scratch area and fsync, then write it in place; recovery prefers the intact copy | MySQL/InnoDB |
| **Copy-on-write** | Never overwrite a page; write a new one and atomically swap a pointer | ZFS, LMDB, SQLite WAL mode |

All three cost write amplification. Copy-on-write avoids the torn-write problem entirely by construction, which is why it keeps reappearing in modern designs — but it trades the problem for fragmentation and garbage collection.

**Independently: checksum every page.** Storage silently corrupts data — bit rot, misdirected writes where the drive writes correct data to the wrong location, firmware bugs. Without checksums, corruption is discovered when a query returns nonsense, and by then it has been faithfully replicated to every follower and every backup. With checksums, it's caught on read and can be repaired from a replica.

## Checkpoints: keeping recovery bounded

If the log grew forever, recovery would mean replaying everything since the database was created. A **checkpoint** bounds this: flush all dirty pages to disk, record "everything before log position X is safely applied", and discard (or archive) the log before X.

```
   Recovery time ≈ time to replay the log since the last checkpoint

   Frequent checkpoints:  fast recovery, but constant background
                          write I/O, and latency spikes when a
                          checkpoint storms the disk
   Rare checkpoints:      minimal steady-state I/O, but recovery
                          can take many minutes

   → the tuning knob is literally an RTO decision
```

This is a direct, quantifiable trade between steady-state performance and [recovery time objective](../01-foundations/availability-slas.html) — one of the few places where an availability target maps onto a single config value. Most databases spread checkpoint writes over the interval to avoid the I/O storm.

## Durability across machines

Local fsync protects against power loss. It does nothing about the machine being destroyed, so real durability is replication — and the setting that matters is whether commit waits for a follower.

| Mode | Commit waits for | Loses on primary failure | Cost |
|---|---|---|---|
| Async replication | Local fsync only | Everything not yet shipped | Fastest |
| Semi-sync | One follower's *receipt* | Data received but not fsynced | +1 network RTT |
| Sync replication | One follower's fsync | Nothing acknowledged | +1 RTT +1 fsync |
| Quorum (majority) | Majority fsync | Nothing acknowledged | +1 RTT, tolerates a slow node |

**Quorum is usually the right answer** at the cost of a cross-AZ round trip, because it doesn't stall on a single slow follower — the majority proceeds without the laggard. See [quorums](../03-distributed/quorums.html) and [replication](../02-building-blocks/replication.html).

:::goat Say the number
"With async replication, my RPO is the replication lag — call it a few seconds of acknowledged writes lost if I lose the primary. For the payments ledger that's unacceptable, so I'd use quorum commit across three AZs and accept about a millisecond of extra commit latency. For the analytics event stream, async is fine; losing two seconds of clickstream is not a real cost."

Naming the RPO in seconds and tying it to the specific data is what separates a considered answer from "we use replication."
:::

## Exercise

:::exercise Trace the failure
A service writes an order to Postgres (async replica, `synchronous_commit = off`), then publishes an event to Kafka (`acks=1`), then returns 200 to the user.

1. `synchronous_commit = off` means Postgres acks before the WAL is fsynced. Exactly what is lost if the machine loses power one millisecond after the 200?
2. `acks=1` means the Kafka leader acked without waiting for followers. What is lost if that broker's disk dies?
3. Construct the sequence where the user sees a successful order, the database has no record of it, and Kafka *does* — and say what the downstream consumer will do.
4. Now fix it: what's the smallest set of changes that makes "user saw 200" imply "the order exists"? What did it cost in latency?
:::

Reasoning to check against: (1) up to `wal_writer_delay` (default 200 ms) of committed transactions — acknowledged and gone. (2) Any messages the leader hadn't replicated; `acks=all` with `min.insync.replicas=2` is the fix. (3) Kafka publish succeeds, Postgres loses the commit, consumer processes an order with no row behind it — a dangling side effect. (4) `synchronous_commit = on` plus quorum replication, and publish via the [outbox pattern](cdc-outbox.html) inside the same transaction instead of a separate call. Cost: roughly one cross-AZ round trip on the commit path.

:::paper Sources
*ARIES: A Transaction Recovery Method Supporting Fine-Granularity Locking and Partial Rollbacks Using Write-Ahead Logging* (Mohan et al., 1992) is the paper every WAL implementation descends from.

*Can Applications Recover from fsync Failures?* (Rebello et al., USENIX ATC 2020) is the empirical study of exactly what happens when fsync fails — the source of much of the fsyncgate discussion. The PostgreSQL "fsyncgate 2018" mailing-list thread is worth reading in full for how a whole industry discovered a shared wrong assumption at once.
:::

## What to carry forward

- **"Durable" has at least five meanings.** Know which one you have; assume the weakest until proven otherwise.
- **Log first, fsync, then ack.** The log is the database; pages are a materialised view.
- **fsync is a hardware constant** — group commit is how you get throughput without it.
- **Torn writes are real**; full-page writes, doublewrite, or copy-on-write are the three defences. Checksum everything regardless.
- **Checkpoint frequency is an RTO decision** expressed as a config value.
- Local fsync survives power loss; **only replication survives losing the machine.**
