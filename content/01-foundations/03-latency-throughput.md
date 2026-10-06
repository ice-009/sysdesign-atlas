---
title: Latency, Throughput & the Tail
summary: The latency numbers worth memorizing, why p99 is the only percentile that matters, and how tail latency amplifies catastrophically as you add services.
difficulty: Easy
scope: Core
tags: [latency, performance, p99]
prereqs: [scalability-basics, hardware-numbers]
---

:::predict Guess first
1. Nine requests take 10 ms and one takes 1,000 ms. What is the average — and does any request actually take that long?
2. A page makes 20 backend calls, and each is slower than its p99 one time in a hundred. What share of page loads hit at least one slow call?
3. An API takes 50 ms per request and gets 2,000 requests a second. How many requests are in flight at any moment?
:::

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

Use percentiles instead. Sort every request by how long it took; **p99** is the request 99% of the way up that list. So "p99 = 400 ms" means 99 requests in 100 finished faster than 400 ms, and one didn't.

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

**Fan-out** is when one incoming request has to ask several services (or several shards) and wait for all of their answers before it can reply. Building one feed page might mean asking thirty of them.

When a request fans out to *N* services and must wait for all of them, the slowest one decides your latency. And as *N* grows, you're rolling the dice on that slow case *N* times per request.

If each backend has a 1% chance of exceeding 100 ms:

| Fanout *N* | P(at least one slow) |
|---:|---:|
| 1 | 1% |
| 10 | 9.6% |
| 50 | 39% |
| 100 | 63% |

At a fanout of 100, **almost two thirds** of your requests hit a slow backend. Your p50 is now determined by your backends' p99. This is why large fanout architectures obsess over tail latency in a way that seems pathological from the outside.

**Mitigations, roughly in order of usefulness:**

- **Hedged requests.** If the first copy hasn't answered by roughly its usual worst case (p95), quietly ask a second copy as well, take whichever replies first, and cancel the other. Costs a few percent extra load, dramatically cuts the tail.
- **Reduce fanout.** Aggregate, batch, or precompute so one request touches fewer services.
- **Return partial results.** A feed that renders with 48 of 50 items beats a feed that renders at 900 ms. Requires the product to tolerate it — negotiate this in requirements.
- **Timeouts with fallbacks.** Every remote call needs a deadline shorter than your own SLA and a defined behavior when it fires.
- **Tail-aware load balancing.** Route by measured latency / outstanding requests rather than round-robin.

:::goat Interview gold
Bringing up tail amplification unprompted is one of the highest-value moves available: "Since the feed service fans out to 30 shards, my p99 becomes their p999 in practice. I'd add hedged reads after p95 and design the response to degrade gracefully with partial results." This is the detail you only learn by operating one of these.
:::

## Little's Law

One formula, and it's the only queueing result you need to be able to use live. It says: **the number of requests inside your system at any moment equals how fast they arrive multiplied by how long each one stays.** Nothing more exotic than that — if 100 people a second walk into a shop and each stays 30 seconds, there are 3,000 people in the shop.

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

The **knee** is the point where the curve stops rising and starts bending over. Past it, latency grows faster than throughput, queues build, clients give up waiting, their retries add *more* load, and the whole thing falls over — a **congestion collapse**, where the system is maximally busy and usefully idle at the same time. This is why you need [load shedding and backpressure](../03-distributed/backpressure.html): a system that rejects 20% of requests quickly is strictly better than one that accepts 100% and serves none of them in time.

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

## Check yourself

```recall
Q: Latency too high versus throughput too low — how do the fixes differ?
A: Latency: shorten the critical path — cache, co-locate, remove a hop, precompute. Throughput: add parallelism — more workers, more shards, batching.

Q: Why is average latency close to useless?
A: It describes no real request: nine at 10 ms and one at 1,000 ms average 109 ms — too slow for the nine and far too fast for the one. Use percentiles.

Q: A page makes 20 calls, each with a 1% chance of exceeding its p99. What share of page loads hit a slow call?
A: 1 − 0.99²⁰ ≈ 18% — nearly one in five page loads, not one in a hundred.

Q: A request fans out to 100 backends, each slow 1% of the time. What share of requests are slow?
A: About 63% (1 − 0.99¹⁰⁰). At wide fan-out, the backends' p99 becomes your median.

Q: How do hedged requests cut tail latency, and what do they cost?
A: If the first copy hasn't answered by about its p95, send the same request to a second replica and take whichever answers first. It costs a few percent of extra load.

Q: State Little's law, then use it: 5,000 requests a second at 200 ms each — how many in flight?
A: Requests in the system = arrival rate × time each spends there (L = λ × W). 5,000 × 0.2 = 1,000 in flight; cutting latency to 50 ms drops it to 250.

Q: Why does throughput fall, not just flatten, when a system is overloaded?
A: Past the knee, queues grow, requests time out, clients retry and add load, and the system ends up busy with work nobody is waiting for — congestion collapse. Shedding load early prevents it.

Q: Of the four golden signals, which is the leading indicator?
A: Saturation — how full the constrained resource is. Latency, traffic and errors tend to move after it.
```

## What to carry forward

- Latency is how long one operation takes; throughput is how many finish per second — and they have different fixes.
- Use percentiles, not averages: p99 is what users at fan-out actually feel.
- Fan-out multiplies the tail — with 100 backends, their p99 becomes your median. Hedge, reduce fan-out, accept partial results.
- Little's law (L = λ × W) sizes pools and shows that cutting latency creates capacity.
- Keep the bottleneck at 60–70% utilisation; past the knee, throughput collapses.
