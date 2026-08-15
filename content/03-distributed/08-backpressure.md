---
title: Backpressure, Load Shedding & Circuit Breakers
summary: How systems collapse under overload, why accepting every request is the wrong instinct, and the three mechanisms that keep degradation graceful.
difficulty: Medium
scope: HLD
tags: [backpressure, load-shedding, circuit-breaker, resilience]
prereqs: [queueing-theory, message-queues]
---

## The counterintuitive premise

The instinct under overload is to accept every request and try your best. That instinct destroys systems.

A system running past its knee doesn't serve everyone slowly — it serves *no one*. Queues grow, latency exceeds client timeouts, clients retry, offered load increases, and throughput goes to zero while every resource is fully consumed. See the saturation curve in [Latency & Throughput](../01-fundamentals/latency-throughput.html).

**The correct behaviour under overload is to do less work, deliberately.** Rejecting 20% of requests quickly so the other 80% succeed at normal latency is strictly better than accepting 100% and completing none of them within their deadline.

The one-line version — "under overload, shed rather than queue" — compresses the whole argument, and it is the right default.

## Backpressure

**Backpressure is the ability of a slow consumer to tell a fast producer to slow down.** It's a property of the whole pipeline, not a component you add.

```diagram
   WITHOUT backpressure
   producer 10K/s ──► [ unbounded queue ] ──► consumer 1K/s
                       grows 9K/s → OOM, or latency
                       climbs until every item is stale

   WITH backpressure
   producer ──► [ bounded queue ] ──► consumer 1K/s
                  full → producer BLOCKS or is REJECTED
                  → the pressure propagates upstream
```

**The key design rule: every queue must be bounded.** An unbounded queue doesn't remove a bottleneck; it hides one, converting a throughput problem into a memory problem plus unbounded latency. Work processed hours late is often worse than work rejected immediately — a notification about a meeting that already ended has negative value.

**Mechanisms:**

- **Bounded buffers** that block or reject on full.
- **TCP flow control** — the original backpressure; the receive window naturally throttles the sender. If you're not reading from a socket, the sender stalls. Free, and often overlooked.
- **Reactive streams / request-N protocols** — the consumer explicitly requests *N* items; the producer never sends more than requested. This is pull-based rather than push, which makes backpressure structural.
- **Credit-based flow control** — the consumer grants credits; producing consumes them. Same idea, common in messaging systems.
- **Blocking calls** — sometimes the simplest correct answer. A blocked thread *is* backpressure, propagating naturally up the call chain.

**Where backpressure fails:** at the boundary with the outside world. You cannot make users slow down. At the edge, backpressure becomes **load shedding** — the only remaining option is to say no.

## Load shedding

Deliberately dropping work you can't complete in time.

**Shed early and cheaply.** A request rejected at the edge costs nothing. One rejected after a database round trip has already consumed a connection, a thread, memory, and downstream capacity — the most expensive way to fail.

**Shed by priority, not at random.** This is where the design gets interesting, and where it is tempting to stop too early.

```diagram
   Priority classes, shed from the bottom up:

   CRITICAL   checkout, payment, login       never shed
   HIGH       core reads, add-to-cart        shed at 95% load
   MEDIUM     recommendations, related items shed at 85%
   LOW        analytics, prefetch, batch     shed at 70%
```

The user completing a purchase succeeds while the recommendation carousel silently disappears. That's graceful degradation implemented as a load policy — and it requires product knowledge, which is exactly why it reads as a senior answer.

**Other shedding dimensions:** shed by cost (reject expensive queries first), shed the *oldest* queued requests (they're closest to their deadline and least likely to still be wanted — "LIFO under overload" is counterintuitive and correct), and drop requests whose [deadline](../01-fundamentals/failure-modes.html) has already passed without doing any work at all.

**Adaptive concurrency limits** are the modern approach: rather than a static "max 500 concurrent requests," measure latency continuously and adjust the limit to keep the system at its throughput knee — essentially TCP congestion control applied to service calls (Netflix's concurrency-limits and Gradient algorithms work this way). Naming this is a nice depth signal, because static limits are always wrong at some point.

## Circuit breakers

Protect *yourself* from a failing dependency. Without one, calls to a dead service consume your threads and connections while you wait for timeouts — the dependency's outage becomes yours.

```diagram
        ┌────────────┐  failure rate > threshold   ┌──────────┐
        │   CLOSED   │ ──────────────────────────► │   OPEN   │
        │ calls pass │                             │ fail fast│
        └────────────┘ ◄──────────────────────────┐│ no calls │
              ▲          probe succeeded          │└──────────┘
              │                                   │      │ after cooldown
              │        ┌────────────────┐         │      ▼
              └────────│   HALF-OPEN    │◄────────┘
                       │ allow a trickle│
                       └────────────────┘
                              │ probe failed → back to OPEN
```

- **Closed** — normal. Track the failure rate over a rolling window.
- **Open** — fail immediately without calling. This is the point: you stop wasting resources *and* you stop hammering a struggling dependency, giving it room to recover.
- **Half-open** — after a cooldown, allow a few probes. Success closes the breaker; failure reopens it.

**Details that matter:**

- **Trip on rate, not count.** "50% of the last 100 calls failed" adapts to traffic; "20 failures" trips instantly at high volume and never at low volume.
- **Require a minimum volume.** 2 failures out of 3 calls is noise, not a signal.
- **Breakers need fallbacks.** An open breaker must produce *something* — cached data, a default, a degraded response. A breaker that just returns errors faster has only changed your failure's latency.
- **Scope them per dependency, and often per endpoint.** One slow endpoint on a service shouldn't take out calls to its healthy ones.
- **Pair with [bulkheads](../01-fundamentals/failure-modes.html)** — separate connection/thread pools per dependency, so exhaustion is contained even before the breaker trips.

## Retries: the amplifier

Retries interact badly with overload and deserve explicit attention, because they are the most common way a small problem becomes an outage.

- **Exponential backoff with full jitter.** Without jitter, clients that failed together retry together, producing synchronized load waves against an already-struggling service.
- **Retry budgets.** Cap retries as a *fraction of total traffic* (e.g. ≤10%). Under widespread failure, retries stop entirely rather than amplifying. Far more robust than per-request limits, which still allow fleet-wide amplification.
- **Retry at one layer only.** Client 3× → gateway 3× → service 3× = **27 database queries per user action**.
- **Never retry on 4xx.** A bad request stays bad. Retry only on timeouts, 5xx, and connection failures.
- **Don't retry when the circuit is open.** The breaker already knows.

## Putting it together

The layered defense, and reciting this structure answers most "what happens under load?" questions completely:

```viz
{
  "type": "stack",
  "caption": "Layered defence \u2014 shed early, where a rejection costs nothing.",
  "layers": [
    {
      "label": "Edge",
      "sub": "rate limit \u00b7 shed low-priority \u00b7 absorb volumetric attacks",
      "accent": "#38bdf8"
    },
    {
      "label": "Gateway",
      "sub": "adaptive concurrency \u00b7 deadline propagation \u00b7 priority classes",
      "accent": "#a78bfa"
    },
    {
      "label": "Service",
      "sub": "bounded queues \u00b7 bulkheads \u00b7 circuit breakers \u00b7 fail fast",
      "accent": "#4ade80"
    },
    {
      "label": "Data",
      "sub": "connection pool limits \u00b7 query timeouts \u00b7 read replicas",
      "accent": "#fbbf24"
    }
  ]
}
```

Plus the operational side: run at 60–70% utilization so a node loss doesn't push survivors past the knee, and **load test past the breaking point** so you know where the knee is and what failure looks like — rather than discovering both during an incident.

:::goat The answer to "what happens under 10× load?"
"It should degrade, not collapse. At the edge I'd rate limit per client and shed low-priority traffic first — recommendations and analytics go before checkout does. Internally, every queue is bounded and every dependency has its own pool and a circuit breaker, so one slow downstream can't consume all my threads. Requests past their deadline are dropped without work rather than served late. The goal is that at 10× we serve maybe 30% of requests at normal latency, instead of accepting everything and serving nothing — and that we recover on our own once the spike passes, without needing someone to restart things."

That answer covers shedding, prioritization, bulkheads, breakers, deadlines, and self-recovery. It's close to a complete resilience design in one paragraph.
:::

:::exercise Shed load correctly
1. Arrivals at 1,200/s, service capacity 1,000/s, unbounded queue. Plot latency over 5 minutes. When does the first request exceed a 2-second timeout?
2. Bound the queue at 500. What changes? Compute the rejection rate at steady state.
3. Design an adaptive concurrency limit using Little's Law. What do you measure, and how do you decide to increase or decrease the limit?
4. Under overload, which requests should you shed? Design a priority scheme, and say what happens to the deprioritised traffic.
5. A request has already exceeded its client's deadline while sitting in your queue. What should you do with it, and how do you know?
:::

:::paper Load shedding and flow control
*Using Load Shedding to Survive a Success Disaster* (Google SRE Book, chapter 22 on cascading failures) is the practical reference and is free online.

Netflix's `concurrency-limits` library and its design notes apply TCP congestion-control algorithms (Vegas, gradient) to service concurrency — an unusually direct transfer of an idea between layers. See also [queueing theory](../01-foundations/queueing-theory.html) for why unbounded queues do not help.
:::
