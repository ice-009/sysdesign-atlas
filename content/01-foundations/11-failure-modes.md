---
title: Failure Modes & Fault Tolerance
summary: Partial failure is the defining property of distributed systems. Gray failures, cascading collapse, retry storms, and the design patterns that contain them.
difficulty: Medium
scope: Core
tags: [failure, resilience, fault-tolerance]
prereqs: [availability-slas, networking]
---

:::predict Guess first
1. You send a request and get no reply. What are the possible explanations — and can you tell them apart?
2. A server passes every health check but users say the app is unusable. How can both be true?
3. Three layers each retry failed calls three times. What happens to the database when it slows down?
:::

## The defining difference

A single-machine program fails cleanly: it works or it crashes. A distributed system has a third state that doesn't exist on one machine — **partial failure**, where some components work, some don't, and *you can't tell which*.

This is the root of nearly every hard problem in this curriculum. When you send a request and get no response, you cannot distinguish between:

- the request never arrived,
- it arrived and the server died before processing,
- it was processed and the response was lost,
- everything is fine and it's just slow.

The first and second mean "safe to retry." The third means "retrying will duplicate the operation." **You cannot tell them apart, ever** — which is why [idempotency](../03-distributed/idempotency.html) isn't an optimization, it's a requirement.

## The eight fallacies

The classic list of assumptions that are false in distributed systems, and each one is a design constraint:

1. **The network is reliable** → packets drop; every call needs retries and timeouts.
2. **Latency is zero** → chatty designs are slow; batch and co-locate.
3. **Bandwidth is infinite** → payload size matters; paginate and compress.
4. **The network is secure** → encrypt in transit, authenticate service-to-service.
5. **Topology doesn't change** → nodes come and go; use service discovery, not hardcoded IPs.
6. **There is one administrator** → config drifts; make deploys reproducible.
7. **Transport cost is zero** → cross-AZ and egress bandwidth cost real money.
8. **The network is homogeneous** → MTUs, protocols, and latencies differ across paths.

## Gray failure — the worst kind

Binary failure is easy: a node dies, health checks fail, traffic reroutes, done.

**Gray failure** is when a node is *technically alive but functionally broken*. It answers health checks with 200 OK while serving real requests at 40× normal latency, or returning empty results, or accepting writes and silently dropping them. The disk is failing but hasn't failed. The runtime's garbage collector — the pause where it reclaims unused memory — is freezing the process for eight seconds at a time. A downstream dependency it needs is down but its own `/health` doesn't check that.

This is worse than a crash because **the system's failure detection actively works against you**: the node is kept in rotation, receives its full share of traffic, and poisons a fraction of every user's requests.

Defenses:

- **Deep health checks** that exercise real dependencies, not `return 200`. But keep them cheap and be careful — a deep check that fails when a *shared* dependency wobbles will remove your entire fleet at once.
- **Health check the outcome, not the process.** Latency- and error-rate-based ejection (as service meshes do with outlier detection) catches gray failure that a liveness probe never will.
- **Client-side awareness.** Load balancing on measured latency, and circuit breakers that trip per-endpoint.
- **Fail fast on your own degradation.** A node that knows its dependency is down should say so rather than hang.

:::goat Bring up gray failure unprompted
"My health check here is a real concern — a simple liveness probe won't catch a node that's up but serving 5-second responses. I'd add outlier detection at the load balancer that ejects instances whose error rate or p99 deviates from the fleet, with a cap so we can't eject more than 20% and cause a cascade." That conclusion is not obvious, and it is the one that matters.
:::

## Cascading failure

How most large outages actually happen. The pattern is a feedback loop:

```diagram
  1. One node fails or slows
         ↓
  2. Its traffic redistributes to the survivors
         ↓
  3. Survivors now run above their safe utilization
         ↓
  4. Their latency rises; queues fill; they slow further
         ↓
  5. Clients time out and RETRY, multiplying load
         ↓
  6. Next node crosses its limit and fails
         ↓
      back to step 2, faster each time
```

The system doesn't degrade gracefully — it collapses in seconds, and it often *stays* collapsed after the original trigger is gone, because the retry load alone is now enough to keep it down.

**Containment patterns:**

- **[Load shedding](../03-distributed/backpressure.html)** — reject excess work fast, at the edge, before it consumes resources. A quick 429 costs almost nothing; a request that times out after 30 s has consumed a connection, a thread, and memory the whole time.
- **Circuit breakers** — stop calling a failing dependency entirely for a cooldown, then probe with a trickle. Prevents you from being dragged down and gives the dependency room to recover.
- **Bulkheads** — separate thread pools / connection pools per dependency, so one slow downstream can't consume every worker. Named after ship compartments for exactly the reason you'd guess.
- **Capacity headroom** — run at 60–70%, not 95%, so losing a node doesn't push survivors past the knee.
- **Jittered exponential backoff** — see below.

## Retry storms and the jitter fix

Retries are necessary and are also the most common way engineers turn a small problem into an outage.

Naive retry: a service returns errors, 10,000 clients retry immediately, offered load triples, the service now cannot recover *because* it's being retried. This is a self-sustaining outage.

Three things make retries safe:

**1. Exponential backoff with jitter.** *Backoff* means waiting longer before each successive retry — 1 second, then 2, then 4. *Jitter* means adding a random amount to that wait. Without jitter, clients that failed at the same moment retry at the same moment, in synchronised waves that hit an already-struggling service together. Full jitter is the standard fix:

```diagram
  no jitter:    delay = base × 2^attempt
                → all clients retry at t = 1s, 2s, 4s, 8s  (thundering)

  full jitter:  delay = random(0, base × 2^attempt)
                → retries spread smoothly across the window
```

**2. Retry budgets.** Cap retries as a *fraction of total traffic* — e.g. retries may never exceed 10% of requests. Under widespread failure, retries stop entirely rather than amplifying. This is far more robust than per-request retry limits, which still permit fleet-wide amplification.

**3. Don't retry at every layer.** If the client retries 3×, the gateway retries 3×, and the service retries 3× against the database, one user action becomes **27 database queries**. Retry at *one* layer — usually the one closest to the user that can still make a meaningful choice — and pass failures through elsewhere.

:::trap The multiplication trap
Layered retries are extremely common in real architectures and nearly invisible in diagrams. Ask yourself "what happens when the database gets slow?" — the answer "each layer retries, so load amplifies 27× and we make it worse, so retry only at the gateway with a budget" is the design. "We retry" is not."
:::

## Timeouts

Every remote call needs one. A call without a timeout is a resource leak waiting for a bad day.

**Choosing values:** set the timeout near the p99.9 of the *healthy* latency distribution. Too tight and you fail requests that would have succeeded, adding load through retries. Too loose and you hold resources through an outage.

**Deadline propagation** is the technique that separates good designs from naive ones. Rather than each service having an independent timeout, pass a *deadline* down the call chain:

```diagram
   Client: "answer by T+300ms"
      → Gateway (spends 20ms): "answer by T+280ms"
         → Service A (spends 50ms): "answer by T+230ms"
            → Service D: sees only 230ms remain; if its work
              takes 400ms it fails IMMEDIATELY rather than
              doing work whose result nobody will wait for
```

Without deadline propagation, backends routinely complete expensive work for callers that gave up long ago — burning capacity precisely when capacity is scarce.

## Failure detection is a guess

You can never *know* a remote node has failed; you can only observe that it hasn't responded. Timeout too short → you declare healthy nodes dead, causing needless failovers and possibly **split brain**, where two halves of a cluster each decide they're in charge and both accept writes. Timeout too long → real failures go undetected and users suffer.

There's no correct answer, only a tradeoff. Adaptive detectors (phi accrual, used by Cassandra and Akka) improve on fixed thresholds by outputting a *suspicion level* based on the observed distribution of heartbeat intervals, letting callers pick their own confidence threshold. See [Gossip & Failure Detection](../03-distributed/gossip.html).

## Designing for failure — the checklist

Run any design through these questions. In an interview, volunteering two or three of them unprompted is worth a lot:

- **What happens when each component dies?** Walk the diagram, kill each box, describe the behavior.
- **Is any component a single point of failure?** Including the "boring" ones — the config service, the DNS entry, the certificate, the single Redis holding your locks.
- **What's the blast radius?** Does one bad shard take down one shard's users or everyone? [Cell-based architecture](../03-distributed/multi-region.html) exists to bound this.
- **Can it self-heal, or does it need a human?** Humans take 15+ minutes at 3am. That's your RTO floor if a human is in the loop.
- **What's the behavior under overload?** "It gets slow" is a wrong answer. "It sheds load at the edge and serves the remaining 80% at normal latency" is right.
- **Does it degrade gracefully?** Can you serve stale cache, disable a non-essential feature, or return partial results instead of failing entirely?
- **What's the recovery path?** After the outage, does traffic returning all at once re-break it? (Cold caches and empty connection pools make recovery its own overload event — the "thundering recovery" problem.)

## Graceful degradation, concretely

The most valuable pattern here, because it is product-aware rather than purely technical. Rank your features by criticality and define what happens when each dependency fails:

| Dependency down | Naive behavior | Degraded behavior |
|---|---|---|
| Recommendation service | 500 on homepage | Show trending/popular list |
| Cache cluster | Hammer DB until it dies | Serve stale entries; shed low-priority reads |
| Search index | Search page errors | Fall back to prefix match on primary DB |
| Image CDN | Broken page | Serve placeholder, text still renders |
| Analytics pipeline | Blocks checkout | Fire-and-forget; drop events |
| Payment provider | Checkout fails | Queue the order, capture asynchronously, notify |

The pattern in every row: **the core transaction survives; the periphery is sacrificed.** Deciding which is which is a product decision, and making it explicitly — rather than letting the failure decide for you — is the whole idea.

:::exercise Trace a gray failure
A service is healthy on every dashboard: the process is up, health checks pass, CPU is 30%, error rate is 0.01%. Users report that the app is unusable.

1. List six distinct conditions that produce exactly this signature.
2. For each, name the single metric that would have revealed it.
3. Your health check returns 200 whenever the process is running. Rewrite it so it would have caught at least three of your six.
4. Now the metastable case: the trigger has been removed and the system is still down. What kind of feedback loop is keeping it there, and what breaks the loop?
:::

:::paper How distributed systems actually fail
*Simple Testing Can Prevent Most Critical Failures* (Yuan et al., OSDI 2014) analysed 198 real production failures in distributed systems and found the majority were triggered by error-handling code that was itself never tested.

*Gray Failure: The Achilles' Heel of Cloud-Scale Systems* (Huang et al., HotOS 2017) is the paper on components that are up but useless. *Metastable Failures in Distributed Systems* (Bronson et al., HotOS 2021) explains why some outages don't recover when the trigger is removed.
:::

## Check yourself

```recall
Q: A request gets no response. Why does that make idempotency a requirement?
A: The request may never have arrived, may have died mid-processing, or may have succeeded with the reply lost — and you can't tell which. Retrying must be safe even if the work already happened.

Q: What is a gray failure, and why is it worse than a crash?
A: A node that passes health checks while serving slow, empty or wrong responses. Failure detection keeps it in rotation, so it poisons a share of every user's requests.

Q: How do you catch gray failures that a liveness probe misses?
A: Judge outcomes, not process: eject instances whose error rate or p99 deviates from the fleet (outlier detection), with a cap so you never eject too many at once.

Q: Describe the feedback loop behind a cascading failure.
A: One node slows or fails, its traffic moves to the survivors, they pass their safe utilisation and slow down, clients time out and retry, and the next node fails — faster each round, often staying down after the trigger is gone.

Q: Why add jitter to exponential backoff?
A: Without it, clients that failed together retry together, in waves that hit a struggling service at once. Full jitter — a random wait up to the backoff — spreads retries out.

Q: Why are retry budgets more robust than per-request retry limits?
A: A budget caps retries as a share of all traffic (say 10%), so under widespread failure retries stop instead of multiplying load across the whole fleet.

Q: Why can't you choose a "correct" failure-detection timeout?
A: Too short and healthy nodes are declared dead, causing needless failovers or split brain; too long and real failures go unnoticed. Adaptive detectors like phi accrual output a suspicion level instead.

Q: What does graceful degradation look like when the payment provider is down?
A: Keep the core transaction alive: queue the order, capture payment later, and tell the customer — rather than failing checkout. Decide what to sacrifice ahead of time.
```

## What to carry forward

- Partial failure is the defining property of distributed systems: silence can't tell you what happened, so retries must be safe.
- Gray failures pass health checks; detect them by outcomes — latency and error outliers.
- Cascades come from redistributed load plus retries; contain them with load shedding, circuit breakers, bulkheads and headroom.
- Make retries safe: jittered backoff, a fleet-wide retry budget, and retries at one layer only.
- Propagate deadlines, and decide in advance what degrades so the core transaction survives.
