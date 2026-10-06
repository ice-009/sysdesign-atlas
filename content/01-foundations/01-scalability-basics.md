---
title: Scalability Basics
summary: Vertical vs horizontal scaling, why stateless services are the whole game, and the three-axis model that tells you which direction to scale next.
difficulty: Easy
scope: Core
tags: [scaling, architecture]
prereqs: []
---

:::predict Guess first
1. One well-indexed Postgres server on a big machine: roughly how many transactions a second can it handle — hundreds, thousands, or tens of thousands?
2. 100 million requests a day sounds like a lot. What is that per second, on average?
3. Your app servers keep each user's login session in their own memory. What goes wrong when you add a second server?
:::

## What "scalable" actually means

A system is scalable if you can handle *N* times the load with roughly *N* times the resources — without redesigning it. That "without redesigning" clause is the entire difficulty. Almost any system handles 2× load fine. The question is whether getting to 100× requires new hardware or a new architecture.

The corollary worth holding onto: **scalability is not performance.** A system that serves one request in 1ms but collapses at 100 concurrent users is fast and unscalable. A system that takes 200ms but holds that at a million users is slow and scalable. They're different properties with different fixes, and conflating them is a common early stumble.

## Vertical scaling (scale up)

Buy a bigger machine. More cores, more RAM, faster disks.

**Genuinely underrated.** Modern hardware is enormous — a single server can have 128+ cores and multiple terabytes of RAM. A well-indexed Postgres instance on such a box handles tens of thousands of transactions per second and stores billions of rows. That covers the entire lifetime of most products.

**Advantages:** no distribution. No partial failure, no consistency negotiation, no distributed transactions, no cross-node latency. Every distributed systems problem in this curriculum is one you don't have.

**Limits:**
- A hard ceiling. You eventually run out of "bigger."
- The price rises faster than the power — the top-end machine costs far more than twice the mid-range one.
- It's a single point of failure and typically requires downtime to resize.

:::interview Say this out loud
When asked to design something at modest scale, propose vertical scaling explicitly and say why: "At 10K QPS — queries per second, the number of requests arriving each second — with this data volume, one large Postgres instance plus a read replica (a copy that serves reads only) handles it comfortably. I'd start there — distribution buys us scale we don't need and costs us consistency guarantees we do. Here's the point at which I'd revisit: when writes approach ~40K/s, or the working set — the slice of data actually being read day to day — stops fitting in RAM." That single paragraph signals more seniority than any architecture diagram.
:::

## Horizontal scaling (scale out)

Add more machines. This is what people mean by "scalable," and it introduces every hard problem in distributed systems: coordination, partial failure, consistency, and rebalancing.

**Advantages:** near-linear headroom, commodity hardware, redundancy as a side effect, elasticity.

**Costs:** the network is now in your critical path and it is unreliable. Data must be partitioned or replicated. Operational complexity grows faster than node count.

## The prerequisite: statelessness

Horizontal scaling of your application tier only works if any request can go to any server. That requires servers to hold **no request-specific state in local memory** — which is what "stateless" means. A stateless server remembers nothing between requests; everything it needs either arrives with the request or is fetched from somewhere shared.

The classic violation is the in-memory session:

```viz
{
  "type": "compare",
  "left": {
    "title": "Broken — state in server RAM",
    "items": [
      "login  → App-1  {session: alice}",
      "next   → App-2  {}  → 401",
      "user is silently logged out",
      "any server restart drops sessions"
    ]
  },
  "right": {
    "title": "Fixed — state externalised",
    "items": [
      "login  → App-N → Redis",
      "next   → App-M → Redis  → ok",
      "servers are interchangeable",
      "scale out by adding machines"
    ]
  },
  "caption": "Horizontal scaling requires that any request can hit any server."
}
```

Two standard fixes:

1. **Externalize state** — sessions in Redis, uploads in object storage, everything durable in the database. Application servers become interchangeable and disposable.
2. **Signed tokens** — put the state in a token the client carries (a JWT: a small blob of user data, signed by you so it can't be forged). No lookup at all, but cancelling one early becomes hard, and its contents can go stale. Usually paired with short expiry plus a refresh token.

Sticky sessions (the LB pins a user to a server) are the tempting third option and mostly a trap: they break load distribution, make deploys disruptive, and turn a single server crash into user-visible logouts.

:::goat The reframe
"Scaling the application tier" is nearly a solved problem once it's stateless — add machines behind a load balancer. **Essentially all real difficulty in scaling lives in the stateful layer:** databases, caches, queues. When you get a design prompt, spend your time there. Spending most of your attention on the stateless tier is a sign you have not yet found the actual constraint.
:::

## The three axes

A useful model borrowed from the "scale cube": there are exactly three directions to scale, and they compose.

```viz
{
  "type": "axes",
  "x": "X — Clone",
  "xs": "add identical replicas",
  "y": "Z — Partition",
  "ys": "shard users A–M / N–Z",
  "z": "Y — Decompose",
  "zs": "split into services",
  "caption": "The three axes of scaling. Real systems use all three at once."
}
```

**X — cloning.** Run *N* identical copies behind a load balancer. Cheapest and first. Solves stateless read/compute load. Solves nothing about data volume, since every clone holds the same data.

**Y — functional decomposition.** Split by responsibility: auth service, feed service, media service. Each scales and deploys independently, and each can pick its own datastore. Costs: network calls between services, distributed debugging, and the risk of a distributed monolith if boundaries are drawn badly.

**Z — data partitioning.** Split the data itself; each node owns a subset. This is [sharding](../02-building-blocks/sharding.html), and it's the only axis that solves *data volume* and *write throughput*. It's also the most expensive to undo.

Real systems apply all three: a sharded database (Z), fronted by several stateless service types (Y), each running many replicas (X).

## Load, and the two kinds of it

"Scale" means nothing until you say *which* load. Always separate:

- **Read scale** — solved with replicas and caches. Comparatively easy, because reads can be served from stale-but-close copies.
- **Write scale** — solved with partitioning, batching, and async processing. Genuinely hard, because writes must be ordered and durable somewhere authoritative.

A 100:1 read/write ratio (typical for social products) and a 1:1 ratio (typical for ingest/telemetry) demand different architectures. Establish this ratio in the first two minutes of any interview.

## Scaling by removing work

The most underrated technique. Before adding machines, ask what work can disappear:

- **Cache it** — the fastest request is the one that never reaches your database.
- **Do it later** — reply "got it, working on it" (`202 Accepted`), put the job on a queue, and finish it in the background. That turns *how long the user waits* into *how much work per hour you get through*, which is a far easier problem.
- **Do it in bulk** — 1,000 individual inserts versus one batch insert of 1,000 rows can differ by 50× in cost.
- **Push it to the edge** — a [CDN](../02-building-blocks/cdn.html) serving static assets removes the majority of requests from your origin for many products.
- **Don't do it at all** — approximate counts instead of exact ones, sample your telemetry, expire old data.

:::math A quick sanity check
100M daily requests sounds huge. Divide: 100M / 86,400s ≈ **1,160 QPS** average. Apply a 3× peak factor: ~3,500 QPS. A handful of application servers and one well-tuned database handle that. Most "we need massive scale" instincts don't survive division — always do the division first, out loud.
:::

## What to say when asked "how would you scale this?"

A reliable ordering, cheapest and least disruptive first:

1. **Measure.** Which resource is saturated — CPU, memory, disk IO, network, or a lock? Scaling the wrong axis does nothing.
2. **Optimize.** A missing index, an N+1 query (fetching a list, then firing one more query per row instead of a single join), a response nobody capped the size of. Frequently a 10× win for a few hours of work.
3. **Cache.** Kill the repeated reads.
4. **Scale up.** Bigger box. Boring, effective, no new failure modes.
5. **Scale out reads.** Read replicas, plus a CDN for static content.
6. **Async the writes.** Queue everything that isn't needed for the response.
7. **Shard.** Last, because it's hardest to reverse.

Walking down that list in order is the discipline itself: you scale by evidence rather than by reflex.

:::exercise Find the serial fraction
Some part of any system can't be done in parallel — one lock, one counter, one database write path. That share is the **serial fraction**, and **Amdahl's Law** says it caps your speedup no matter how many machines you add. If 5% is serial, 20× is your ceiling even with infinite hardware.

1. A service handles 1,000 req/s on one machine. On 8 machines it handles 6,400 req/s. What is the effective serial fraction, and what does Amdahl's Law predict for 64 machines?
2. Name three things in a typical web service that are *actually* serial across all instances, even when the app tier is stateless.
3. Your throughput improves from 1 to 8 machines, then *declines* from 16 to 32. Amdahl's Law cannot produce a decline. What can — and what would you measure to confirm it?
4. Pick a service you know. Which single component would you have to fix first to double its capacity, and how do you know it's that one rather than the one that looks busiest?
:::

:::paper Where scaling arguments come from
Gene Amdahl's 1967 argument — "Validity of the Single Processor Approach to Achieving Large Scale Computing Capabilities" — is the origin of the observation that the serial fraction bounds your speedup. John Gustafson's 1988 rebuttal ("Reevaluating Amdahl's Law") is the reason the pessimism is overstated in practice: problem sizes grow with the machine.

Neil Gunther's **Universal Scalability Law** extends both with a coherency term, which is what actually bends real throughput curves downward past a point rather than merely flattening them.
:::

## Check yourself

```recall
Q: What is the difference between scalability and performance?
A: Performance is how fast one request is. Scalability is whether N times the load needs only about N times the resources, without a redesign. A system can be fast and unscalable, or slow and scalable.

Q: Why is vertical scaling "genuinely underrated"?
A: One big modern machine — 128+ cores, terabytes of RAM — runs a Postgres that handles tens of thousands of transactions a second, and it avoids every distributed-systems problem: partial failure, consistency, cross-node latency.

Q: What does "stateless" ask of an app server, and why does scaling out depend on it?
A: It keeps nothing request-specific in its own memory between requests, so any request can go to any server. Then you scale by adding servers behind a load balancer.

Q: Why are sticky sessions mostly a trap?
A: Pinning users to servers breaks load spreading, makes deploys disruptive, and turns one crash into visible logouts. Move the state out of the server instead.

Q: Of the three scaling axes — clone, decompose, partition — which one helps with data volume and write throughput?
A: Partitioning (sharding), where each node owns a subset of the data. Clones all hold the same data, and decomposing splits code, not data.

Q: Do the division: 100M requests a day is how many a second on average, and at a 3× peak?
A: About 1,160 a second on average (100M ÷ 86,400) and about 3,500 at peak — a few app servers and one well-tuned database.

Q: Asked "how would you scale this?", what comes before adding machines?
A: Measure which resource is saturated, then optimise (missing indexes, N+1 queries), cache, and scale up. Only then add read replicas, make writes asynchronous, and — last — shard.

Q: Amdahl's law: if 5% of the work can't run in parallel, what's the most speed-up any number of machines can give?
A: 20× (1 ÷ 0.05). The serial part — one lock, one counter, one write path — sets the ceiling.
```

## What to carry forward

- Scalability means N times the load costs about N times the resources without a redesign; it is not the same as speed.
- Start vertical: one big machine avoids every distributed problem and covers most products for their whole life.
- Stateless app servers make the app tier the easy part; the real difficulty lives in databases, caches and queues.
- Always do the division — requests a day to requests a second — and separate read scale (replicas, caches) from write scale (partitioning, async).
- Scale in order: measure, optimise, cache, scale up, replicate reads, queue writes, shard last.
