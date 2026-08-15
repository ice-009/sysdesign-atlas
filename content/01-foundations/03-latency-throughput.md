---
title: Latency, Throughput & the Tail
summary: The latency numbers worth memorizing, why p99 is the only percentile that matters, and how tail latency amplifies catastrophically as you add services.
difficulty: Easy
scope: Core
tags: [latency, performance, p99]
prereqs: [scalability-basics, hardware-numbers]
---

## Two numbers people confuse

**Latency** is how long one operation takes. **Throughput** is how many operations complete per unit time. They're related but not inverse — a system can have high latency *and* high throughput if it's sufficiently parallel.

The pipeline analogy: a factory line where each item takes 10 minutes end to end (latency) but one item drops off the line every 5 seconds (throughput). Adding parallel lines raises throughput and leaves latency untouched.

Interviewers probe this because the fixes are different:

- Latency too high → shorten the critical path. Cache, denormalize, co-locate, remove a network hop, precompute.
- Throughput too low → add parallelism. More workers, more shards, more connections, batching.

## The latency ladder

Memorize these. They're order-of-magnitude figures, and order-of-magnitude is all you need — the point is knowing that a disk seek is ~1,000× a memory read, not the exact nanoseconds.

| Operation | Time | Human scale (×1B) |
|---|---:|---|
| L1 cache reference | 1 ns | 1 second |
| Branch mispredict | 3 ns | 3 seconds |
| L2 cache reference | 4 ns | 4 seconds |
| Mutex lock/unlock | 17 ns | 17 seconds |
| Main memory reference | 100 ns | 2 minutes |
| Compress 1 KB (snappy) | 2 µs | 33 minutes |
| Read 1 MB from memory | 10 µs | 3 hours |
| SSD random read | 100 µs | 1.5 days |
| Read 1 MB from SSD | 200 µs | 3 days |
| Round trip within datacenter | 500 µs | 6 days |
| Read 1 MB from disk (HDD) | 2 ms | 23 days |
| Disk seek (HDD) | 5 ms | 58 days |
| Round trip US East ↔ US West | 60 ms | 2 years |
| Round trip US ↔ Europe | 140 ms | 4.5 years |

The right-hand column is the useful one. It makes visceral why a cross-region call inside a request path is a design decision and not an implementation detail.

**Three derived facts worth having ready:**

1. **Memory is ~1,000× faster than SSD; SSD is ~20× faster than spinning disk.** This is why caching works and why the working set fitting in RAM is the single biggest performance cliff in database operations.
2. **A same-datacenter round trip (~0.5 ms) costs more than reading 1 MB from memory.** Chatty service-to-service communication is expensive: 20 sequential internal calls ≈ 10 ms of pure network before any work happens.
3. **The speed of light sets a floor.** New York ↔ London is ~5,600 km; light in fiber does ~200,000 km/s, so ~28 ms one way, ~56 ms round trip *minimum*, physically. Real-world ~70–90 ms after routing. No optimization beats this — only moving the data closer does, which is the entire argument for CDNs and multi-region.

## Why averages lie

Average latency is close to useless. Consider ten requests: nine at 10 ms, one at 1,000 ms. The average is 109 ms — a number that describes *no actual request*. It's too slow to represent the nine fast ones and far too fast to represent the slow one.

Use percentiles:

- **p50 (median)** — the typical experience.
- **p95** — the mild annoyance.
- **p99** — the number that gets you paged.
- **p999** — where your worst infrastructure behavior hides.

:::trap "Only 1% of requests are slow"
p99 does *not* mean 1% of users are unhappy. Users make many requests. If a page load issues 20 backend calls, the chance that all 20 land under p99 is 0.99²⁰ ≈ **82%** — so nearly **1 in 5 page loads** hits at least one p99-tier call.

Worse, slow requests concentrate on your *most valuable* users: the ones with the most data, most followers, most orders. Their queries scan more, their caches miss more. p99 latency is disproportionately the experience of your power users.
:::

## Tail latency amplification

This is the concept that separates people who have operated systems from people who have read about them.

When one request fans out to *N* services and must wait for all of them, the slowest response determines your latency. As *N* grows, you are effectively sampling the tail repeatedly.

If each backend has a 1% chance of exceeding 100 ms:

| Fanout *N* | P(at least one slow) |
|---:|---:|
| 1 | 1% |
| 10 | 9.6% |
| 50 | 39% |
| 100 | 63% |

At a fanout of 100, **almost two thirds** of your requests hit a slow backend. Your p50 is now determined by your backends' p99. This is why large fanout architectures obsess over tail latency in a way that seems pathological from the outside.

**Mitigations, roughly in order of usefulness:**

- **Hedged requests.** Send to a second replica if the first hasn't answered by, say, p95; take whichever returns first, cancel the other. Costs a few percent extra load, dramatically cuts the tail.
- **Reduce fanout.** Aggregate, batch, or precompute so one request touches fewer services.
- **Return partial results.** A feed that renders with 48 of 50 items beats a feed that renders at 900 ms. Requires the product to tolerate it — negotiate this in requirements.
- **Timeouts with fallbacks.** Every remote call needs a deadline shorter than your own SLA and a defined behavior when it fires.
- **Tail-aware load balancing.** Route by measured latency / outstanding requests rather than round-robin.

:::goat Interview gold
Bringing up tail amplification unprompted is one of the highest-value moves available: "Since the feed service fans out to 30 shards, my p99 becomes their p999 in practice. I'd add hedged reads after p95 and design the response to degrade gracefully with partial results." This is the detail you only learn by operating one of these.
:::

## Little's Law

The one queueing theory result you should be able to use in a live discussion:

```diagram
    L  =  λ  ×  W

    L = concurrent requests in the system
    λ = arrival rate (requests/sec)
    W = average time in system (sec)
```

It's exact and assumption-free for any stable system. Immediate applications:

- **Sizing a thread pool.** 2,000 QPS with 50 ms average service time → L = 2000 × 0.05 = **100 concurrent requests**. You need ~100 workers (plus headroom); 20 will queue and collapse.
- **Diagnosing saturation.** If concurrency is pinned at your pool size and latency is climbing while throughput is flat, you're queueing, not computing. Adding CPU won't help — reduce W or raise L.
- **Connection pools.** Same math. A database pool of 20 with 10 ms queries supports 2,000 QPS *at best*, and only if nothing ever slows down.

:::math Worked example
An API must serve 5,000 QPS at 200 ms p50. Concurrency = 5000 × 0.2 = **1,000 in-flight requests.** With 40 threads per server you'd need 25 servers just to hold the concurrency — before considering CPU. If instead you cut latency to 50 ms, concurrency drops to 250 and you need ~7 servers. **Latency reduction is capacity creation.** That equivalence follows directly from Little's Law, and it is worth stating explicitly.
:::

## The saturation curve

Throughput does not rise linearly to a ceiling and plateau. It rises, flattens, and then *falls*:

```diagram
 throughput
     │        ╭──────╮
     │      ╭─╯      ╰──╮        ← collapse: queues grow, timeouts
     │    ╭─╯           ╰───╮      fire, clients retry, load
     │  ╭─╯                 ╰──╮   increases, latency explodes
     │╭─╯
     └──────────────────────────► offered load
       linear   knee    overload
```

Past the knee, latency grows faster than throughput, queues build, clients time out, retries add *more* load, and the system falls over — congestion collapse. This is why you need [load shedding and backpressure](../03-distributed/backpressure.html): a system that rejects 20% of requests quickly is strictly better than one that accepts 100% and serves none of them in time.

**Rule of thumb:** target ~60–70% utilization of your bottleneck resource in steady state. The remaining headroom absorbs traffic spikes, failovers, and deploys. Running at 95% "for efficiency" means the first surprise is an outage.

## What to measure

Four golden signals, and know which is which:

- **Latency** — p50/p99, and *split successful from failed requests*, since fast errors otherwise flatter your numbers.
- **Traffic** — QPS, concurrent connections.
- **Errors** — rate and class (4xx vs 5xx tell different stories).
- **Saturation** — how full the constrained resource is. The leading indicator; the other three are lagging.

:::exercise Compute the fan-out tail
1. A request fans out to 20 backends and needs all of them. Each has a p99 of 10 ms. What fraction of requests exceed 10 ms? What is your effective p99 in terms of the backend's percentiles?
2. Now add hedging: after 8 ms, send a duplicate to a second replica and take the first response. Estimate the new tail and the extra load. Is the trade worth it?
3. Your p50 is 20 ms and p99 is 900 ms. List four distinct causes that produce that shape, and the measurement that distinguishes each.
4. A dashboard shows average latency of 45 ms and users complain constantly. Explain the discrepancy in one sentence, and say what you would put on the dashboard instead.
:::

:::paper The tail-latency literature
Jeff Dean and Luiz André Barroso's *The Tail at Scale* (CACM, 2013) is the essential paper: why p99 dominates user experience at fan-out, and the techniques — hedged requests, tied requests, micro-partitioning — that address it.

Gil Tene's talk *How NOT to Measure Latency* is the definitive treatment of coordinated omission and why most published latency numbers are optimistic by an order of magnitude.
:::
