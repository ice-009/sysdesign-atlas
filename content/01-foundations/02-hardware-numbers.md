---
title: The Numbers Underneath Everything
summary: The memory hierarchy, and where the latency figures every engineer half-remembers actually come from — derived from physics and clock rates rather than memorised.
difficulty: Easy
scope: Core
tags: [fundamentals, hardware, latency, memory]
prereqs: []
unlocks: The ability to reason about where time goes in a system instead of guessing.
---

## Why start with hardware

Almost every design decision in this atlas is a decision about **where data lives**. Cache or database. Memory or disk. Local disk or object storage. Same rack or another continent.

Those choices only make sense if you know what each option costs, and the costs are not arbitrary — they fall out of physics and clock rates. Once you can derive them, you stop memorising a table and start reasoning.

The single most important fact: **the gaps between levels are enormous, and they are not linear.** Each step down the hierarchy is roughly 10× to 1000× slower than the one above it.

## The hierarchy

```viz
{
  "type": "stack",
  "caption": "Each layer is bigger and dramatically slower than the one above it.",
  "layers": [
    { "label": "CPU register", "sub": "~1 KB · <1 ns", "accent": "#38bdf8" },
    { "label": "L1 cache", "sub": "~64 KB/core · ~1 ns", "accent": "#22d3ee" },
    { "label": "L2 cache", "sub": "~1 MB/core · ~4 ns", "accent": "#4ade80" },
    { "label": "L3 cache", "sub": "tens of MB, shared · ~15 ns", "accent": "#a78bfa" },
    { "label": "Main memory (DRAM)", "sub": "hundreds of GB · ~80 ns", "accent": "#fbbf24" },
    { "label": "NVMe SSD", "sub": "TBs · ~50-100 µs", "accent": "#fb7185" },
    { "label": "Network / remote storage", "sub": "unbounded · 0.2 ms to 150 ms", "accent": "#f472b6" }
  ]
}
```

## Deriving the numbers

You do not need to remember these. You need to remember **three anchors** and derive the rest.

:::derive The three anchors
```
1. A modern CPU core runs at roughly 3 GHz
   → one clock cycle ≈ 0.33 ns
   → a core retires a few instructions per cycle

2. Light travels ~30 cm per nanosecond in vacuum,
   ~20 cm per nanosecond in fibre (refractive index ~1.5)
   → 1000 km of fibre ≈ 5 ms one way, 10 ms round trip

3. DRAM access ≈ 80 ns ≈ 240 clock cycles
   → a cache miss costs you a couple of hundred
     instructions' worth of time
```
:::

Everything else follows.

**Why L1 is ~1 ns:** it's physically adjacent to the core, a few clock cycles away. There is no mystery — it's close, so it's fast.

**Why DRAM is ~80 ns:** the memory controller has to select a row in a DRAM bank, wait for the sense amplifiers, and drive the result back across the bus. That's roughly 240 cycles. During a DRAM stall a modern out-of-order core will try to find other work, but there is only so much independent work available.

**Why a same-datacenter round trip is ~0.5 ms:** the fibre distance inside a datacentre is short, so cable length is not the cost — the cost is switching. Every hop through a switch adds queueing and serialisation. Two to four hops each way, plus kernel network stack traversal on both ends, lands you around half a millisecond.

**Why cross-continent is ~70 ms:** New York to London is about 5,500 km of fibre. At 20 cm/ns that's 27 ms one way, 55 ms round trip — and real routes are not straight lines, so 70–80 ms is typical. **No amount of engineering will fix this.** It is the speed of light in glass.

:::goat The consequence people miss
Because propagation delay is irreducible, **the only way to make a cross-region read fast is to not do it** — replicate the data closer to the reader, and accept the [consistency cost](consistency-models.html) of doing so.

That single fact is the reason [CDNs](../02-building-blocks/cdn.html), edge caches, read replicas, and regional sharding all exist. They are all the same idea: move the data to where the question is asked, because you cannot move the answer faster than light.
:::

## The table, with reasoning attached

| Operation | Time | Relative to L1 | Where it comes from |
|---|---:|---:|---|
| L1 cache reference | 1 ns | 1× | ~3 cycles, adjacent to the core |
| Branch mispredict | 3 ns | 3× | Pipeline flush, ~10–20 cycles |
| L2 cache reference | 4 ns | 4× | ~12 cycles |
| Mutex lock/unlock (uncontended) | 15 ns | 15× | An atomic operation + cache coherence traffic |
| L3 / last-level cache | 15 ns | 15× | Shared across cores, further away |
| Main memory reference | 80 ns | 80× | DRAM row activation + bus transfer |
| Compress 1 KB | 1 µs | 1,000× | Real computation, thousands of cycles |
| Read 1 MB sequentially from memory | 20 µs | 20,000× | Bandwidth-bound: ~50 GB/s |
| Datacenter round trip | 500 µs | 500,000× | Switching + kernel stack, not distance |
| NVMe random read (4 KB) | 100 µs | 100,000× | Flash read + controller + PCIe |
| Read 1 MB sequentially from NVMe | 300 µs | 300,000× | ~3 GB/s sequential |
| Disk seek (spinning) | 5 ms | 5,000,000× | Physical arm movement |
| Cross-continent round trip | 70 ms | 70,000,000× | Speed of light in fibre |

:::math Rescaling to human time
If an L1 reference took **1 second**, then:

- main memory would take **1.5 minutes**
- an SSD read would take **1.5 days**
- a datacenter round trip would take **6 days**
- a spinning disk seek would take **2 months**
- a cross-continent round trip would take **2.2 years**

This is why "just add a cache" is the most reliable optimisation in systems work, and why a design that crosses regions on the critical path is usually a design that has already lost.
:::

## Sequential versus random is the other big gap

Latency numbers alone are misleading, because devices are far better at sequential access than random access.

```diagram
   NVMe SSD, same device:

     Random 4 KB reads     ~100 µs each, ~500K IOPS with deep queues
       → effective throughput on scattered small reads: ~2 GB/s

     Sequential read       ~3-7 GB/s streaming

   Spinning disk, same device:

     Random 4 KB reads     ~5-10 ms each  → ~150 IOPS  → ~0.6 MB/s
     Sequential read       ~200 MB/s

       → the gap on a spinning disk is over 300×
```

**Two reasons this matters far beyond disks:**

1. **It is why B-trees and LSM trees exist.** Both are designs for turning random writes into sequential ones. See [storage engines](../04-data/storage-engines.html) — the entire field of storage engineering is a response to this one asymmetry.
2. **It applies to memory too.** DRAM reads happen in 64-byte cache lines. Reading one byte costs the same as reading 64. An array walked in order is prefetched by the hardware and runs near memory bandwidth; a linked list chased through scattered addresses pays a full miss per node. The same data structure can be 10× apart in speed depending purely on layout.

:::trap "Memory is random access, so layout doesn't matter"
The name is a historical artifact. DRAM is *addressable* at random, but not *fast* at random. Row activation, cache lines, and hardware prefetching all reward locality.

This is why a columnar layout can beat a row layout by an order of magnitude on an analytical scan ([OLAP & columnar](../04-data/olap-columnar.html)), and why an array of structs and a struct of arrays perform completely differently on identical data.
:::

## Bandwidth, and where it caps out

Latency tells you how long one operation takes. **Bandwidth tells you how many you can have in flight.** Systems usually die of bandwidth, not latency.

| Path | Typical bandwidth |
|---|---|
| L1 cache | ~1 TB/s per core |
| DRAM | 50–100 GB/s per socket |
| PCIe 5.0 x16 | ~64 GB/s |
| NVMe SSD | 3–7 GB/s |
| Datacenter NIC | 25–400 Gb/s (≈3–50 GB/s) |
| Internet egress to a user | 1–100 Mb/s, wildly variable |

Two things fall out of this table.

**Egress is the narrowest pipe in most products.** A service that comfortably reads 5 GB/s from local NVMe may only be able to ship 3 GB/s to the network and far less to actual users. Bytes-on-the-wire is usually the real constraint — which is why compression, pagination, and field selection matter more than they look.

**GPU work inverts the usual intuition.** GPU memory (HBM) runs at 2–8 TB/s, but a single decode step in a language model has to stream *every weight in the model* through that bus to produce one token. The AI Foundations track works this out in detail; the binding constraint there turns out to be exactly this table applied to different hardware.

## Failure rates belong in this table too

Hardware is also a source of numbers you need for [availability math](availability-slas.html).

| Component | Rough annual failure rate |
|---|---|
| Spinning disk | 1–5% |
| SSD | 0.5–2% |
| Server (any cause) | 2–4% |
| Rack switch (top-of-rack) | ~1% |
| Whole-datacenter event | Rare, but assume it happens |

:::math The number that changes system design
In a fleet of **10,000 servers** at a 3% annual failure rate:

```
10,000 × 0.03 = 300 failures per year
300 / 365     ≈ 0.8 failures per day
```

**At that scale, something is always broken.** Not occasionally — continuously. A design that treats failure as an exceptional path is wrong at 10,000 machines, and this arithmetic is why every idea in [distributed systems](../03-distributed/consensus.html) assumes partial failure as the normal condition.
:::

## Exercise

:::exercise Estimate before you look
For each of these, write down your estimate, then check it against the tables above:

1. A service returns a 200 KB JSON response. What is the minimum time to get those bytes to a user on a 20 Mb/s connection — ignoring all server-side work?
2. A request handler does 50 sequential Redis calls, each a datacenter round trip. What is its floor latency? What if you pipeline them into one round trip?
3. A batch job reads 1 TB from local NVMe sequentially. What's the floor? What if it reads the same 1 TB as random 4 KB records?
4. You have a hash table with 10M entries that doesn't fit in L3. Roughly how many lookups per second can one core do, assuming each is a cache miss?

Answers to check against: (1) ~80 ms, and that's before the server does anything. (2) ~25 ms versus ~0.5 ms — a 50× win from one change. (3) ~3 minutes versus ~7 hours. (4) ~12M/s at best, in practice far fewer because you also pay for the hash and the probe.
:::

:::paper Where these numbers came from
Jeff Dean's "Latency Numbers Every Programmer Should Know" (Google, 2009) is the origin of the canonical table; Peter Norvig's earlier "Teach Yourself Programming in Ten Years" carried an ancestor of it. Colin Scott's interactive version tracks how the numbers have drifted with hardware generations.

Ulrich Drepper's *What Every Programmer Should Know About Memory* (2007) is the long-form treatment of the memory hierarchy — dated in its specifics, still unmatched on the mechanisms.
:::

## What to carry forward

- Three anchors: **0.33 ns per clock, 20 cm per ns in fibre, 80 ns to DRAM.** Derive the rest.
- The hierarchy spans **eight orders of magnitude**. Which level your data sits on dominates everything else about your design.
- **Sequential beats random** everywhere — in DRAM, on SSDs, catastrophically on spinning disks. Most storage design is a response to this.
- **Propagation delay is irreducible.** Cross-region latency can only be avoided, never optimised.
- At fleet scale, **failure is continuous**, not exceptional.
