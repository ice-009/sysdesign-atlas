---
title: Metastable Failures
summary: The outages that don't end when their cause does — how retries, cold caches and backlogs create feedback loops that hold a healthy system down, and the designs that let it recover on its own.
difficulty: Hard
scope: HLD
tags: [reliability, overload, retries, resilience]
prereqs: [backpressure, queueing-theory, failure-modes, caching]
unlocks: Recognising the outage shape where fixing the trigger fixes nothing, and designing systems that climb back out by themselves.
---

:::predict Guess first
1. A database slows down for 30 seconds, then returns to full speed. Can the service in front of it stay broken for hours afterwards?
2. Three layers of services each retry a failed call up to 3 times. In the worst case, how many requests can one user action cause at the bottom layer?
3. A cache cluster restarts empty while traffic is at full height. Will it fill itself back up?
:::

## The outage that outlives its cause

Most failures have a satisfying shape: something breaks, you fix it, the system recovers. A **metastable failure** breaks that pattern. A brief trigger — a slow disk, a deploy, a spike — pushes the system into a bad state, and then something in the system's own behaviour **keeps it there after the trigger is gone**.

The name comes from physics. A metastable state is stable only as long as nothing disturbs it, like a ball resting in a shallow dip at the top of a hill. A small nudge tips it into a much deeper valley, and nudging it back is far harder than tipping it in.

```diagram
   STABLE          load comfortably below capacity
                   a disturbance passes; the system recovers on its own
        │
        │  load grows, or "efficiency" work removes slack
        ▼
   VULNERABLE      still healthy — but running close to capacity,
                   with an amplifier waiting (retries, a cache, a backlog)
        │
        │  TRIGGER: a short slowdown, a deploy, a failover, a spike
        ▼
   METASTABLE      overloaded, and the overload FEEDS ITSELF
                   removing the trigger does not help
                   recovery needs a deliberate intervention
```

Bronson and colleagues named the pattern in 2021. A year later, Huang and colleagues studied 22 such failures across 11 organisations and found that **at least 4 of the 15 major AWS outages of the previous decade** had this shape. Retries were the sustaining mechanism in more than half of the cases they analysed.

The uncomfortable part: none of these systems had a bug in the usual sense. Each sustaining effect is a sensible optimisation for the common case — retrying failed calls, caching hot data, queueing work rather than dropping it. They only become dangerous together, near capacity.

## The three ingredients

Every metastable failure in the literature has the same parts:

| Part | What it is | Examples |
|---|---|---|
| **Vulnerable state** | Running with little headroom, so a small hit tips it over | 80–90% utilisation; a cache doing most of the work |
| **Trigger** | A temporary event that pushes load above capacity | A GC pause, a slow dependency, a deploy, a burst, a failover |
| **Sustaining effect** | A feedback loop that keeps load above capacity after the trigger ends | Retries, cache misses, timeouts that waste work, lease storms |

The trigger gets the blame in the incident review — "the database had a slow minute" — but the trigger is nearly irrelevant. Slow minutes happen every week. The sustaining effect is what turned a slow minute into a slow day.

## Feedback loop 1 — the retry storm

The most common loop, and the easiest to build by accident.

```diagram
   1. A dependency slows down. Some requests time out.
   2. Callers retry the timed-out requests.
   3. The dependency now receives new requests PLUS retries.
   4. It slows down further. More requests time out.
   5. More retries. Go to 3.

   The original slowdown ends — but the extra load from retries
   keeps the dependency above capacity, so it never catches up.
```

And retries stack across layers:

:::derive How retries multiply through a call chain
```
   A request passes through three services: A → B → C → database.
   Each layer tries a failed call up to 4 times (1 try + 3 retries).

   If the database is failing:
     C sends up to 4 attempts per call it receives
     B retries each failed call to C up to 4 times
     A retries each failed call to B up to 4 times

     worst case at the database:  4 × 4 × 4  =  64 attempts
                                  for ONE user request

   At 1,000 user requests/s, the database is asked for up to
   64,000/s — exactly when it is least able to cope.
```
:::

Notice that each team's retry policy is individually reasonable. Three retries is a common default. The multiplication only appears when you look at the whole chain — which is why retry policy is an architecture decision, not a per-service one.

## Feedback loop 2 — the cold cache

```diagram
   Normal:   1,000 req/s ──► cache (95% hit) ──► 50 req/s ──► database
                                                            (capacity 200/s)

   The cache cluster restarts empty.

   Now:      1,000 req/s ──► cache (0% hit) ──► 1,000 req/s ──► database
                                                               (capacity 200/s)

   The database is 5× overloaded. Queries slow down and time out.
   Timed-out queries never write their result back to the cache.
   So the cache stays empty. So the database stays overloaded.
```

The cache needs successful database reads to refill, and the overloaded database can't produce them. The system sits in its deep valley with all the hardware healthy. This is why the [caching](../02-building-blocks/caching.html) page treats a cold restart as a recovery problem, not a non-event.

## Feedback loop 3 — wasted work

The subtlest loop, and the reason throughput can fall to near zero while every machine looks busy.

```diagram
   A server takes 1 s to answer at normal load.
   Clients give up after 2 s.

   Overload makes queues longer. Requests wait 3 s in the queue,
   then take 1 s to process — 4 s in total.

   The client stopped waiting at 2 s. Every one of those answers
   is thrown away.

   The server is 100% busy producing results nobody receives.
   Useful throughput (goodput): zero.
```

A queue that serves the oldest request first is the worst possible policy here: it guarantees that every request it works on has already been abandoned. The fix is to drop requests whose deadline has passed *before* doing work on them — more on that below.

## A real one: AWS, October 2025

AWS's post-event summary for the October 19–20, 2025 outage in us-east-1 shows the shape clearly. The trigger was a race condition in DynamoDB's automated DNS management, which left a regional endpoint unresolvable. That was fixed within about three hours.

EC2 instance launches stayed broken for many hours longer. The internal system that manages EC2's physical servers keeps a lease for each one, and while DynamoDB was unreachable those leases timed out. When DynamoDB came back, the system tried to re-establish leases on a huge number of servers at once; the backlog grew faster than it could be worked through. In AWS's words, it "had entered a state of congestive collapse and was unable to make forward progress". Engineers recovered it by **throttling incoming work and restarting hosts** to clear the queues — and kept request throttling in place until the early afternoon while everything caught up.

The trigger was fixed early. The sustaining effect — a recovery backlog that grew faster than it drained — needed humans.

## Designing so the system climbs back out

The goal isn't to prevent triggers; they're inevitable. It's to make sure that when load drops back below capacity, **the system returns to health by itself**.

### Bound the amplifiers

**Retry budgets, not retry counts.** Instead of "retry each call up to 3 times", allow retries to add at most, say, 10% to the request rate — a token bucket that refills with successful calls. In normal times every failure can be retried. In an outage, retries are capped at a tenth of traffic instead of multiplying it.

**Retry at one layer only.** Usually the outermost one, which knows whether the user is still waiting. Inner layers fail fast and report the error upward.

**Exponential backoff with jitter.** Space retries out and randomise them, so a failure doesn't produce synchronised waves of retries hitting at the same instant.

**Circuit breakers.** When a dependency is clearly failing, stop calling it for a while and fail fast, giving it room to recover. See [backpressure and circuit breakers](backpressure.html).

### Don't do work nobody will receive

- **Propagate deadlines.** Each request carries "the caller gives up at time T". Every layer checks it, and a request already past T is dropped without any work.
- **Shed load early and cheaply.** Reject excess requests at the front door, before they consume database connections.
- **Serve newest first under overload.** When the queue is long, the newest requests are the ones whose clients are still waiting. Some systems switch from first-in-first-out to last-in-first-out when queueing time passes a threshold.

### Keep recovery capacity

- **Headroom is the cheapest insurance.** A system at 60% utilisation absorbs a trigger that would tip one at 90% into collapse. The [queueing](../01-foundations/queueing-theory.html) curve explains why: delay rises steeply near full utilisation.
- **Warm caches gradually.** After a cold start, admit a small share of traffic, let the cache fill, then ramp up. Pre-warm the hottest keys from a known list.
- **Throttle recovery work.** Re-establishing leases, replaying queues and reconnecting clients should all be rate-limited, so that recovering from an outage can't cause the next one.

:::goat The question that finds these before they find you
Ask of every component: **if load drops back to normal right now, does this recover by itself?**

A system that only recovers when someone intervenes has a sustaining effect somewhere — a retry policy, a cache, a backlog, a lease protocol. Ordinary load tests miss it because they ramp load up and never remove it.

The test that catches it: push load well past capacity for a few minutes, **then drop it back to normal** and watch goodput. If goodput stays low after the overload ends, you've found a metastable state in staging instead of in production. It's the most direct way to measure how close a system sits to the edge.
:::

:::trap "We'll just add more capacity"
More capacity widens the healthy zone, which helps — but it doesn't remove the sustaining effect. A retry storm that multiplies load 64× will overwhelm double the capacity just as surely as the original.

Capacity buys margin. Bounded retries, deadlines and load shedding remove the feedback loop. You need both, and only the second actually makes the system recover by itself.
:::

## What to watch

| Signal | Why it matters |
|---|---|
| **Goodput vs throughput** | Busy-but-useless is the signature of wasted work |
| **Retry rate as a share of traffic** | A rising share is an amplifier warming up |
| **Queue time vs client timeout** | Once queueing exceeds the timeout, every answer is wasted |
| **Cache hit rate** | A falling hit rate puts the database in the firing line |
| **Utilisation headroom** | How big a trigger it would take to tip you over |

:::exercise Find the feedback loop
A checkout service calls an inventory service, which calls a database. Checkout retries 3 times with a 1 s timeout; inventory retries 3 times with a 500 ms timeout. The database normally runs at 70% of capacity. One afternoon a slow index rebuild makes database queries take 600 ms for two minutes.

1. Trace what happens to load at the database during those two minutes. What's the worst-case multiplier?
2. The rebuild finishes. Does the system recover? Which effect, if any, keeps it down?
3. Redesign the retry policy so the worst-case multiplier is at most 1.1×. Where should retries live?
4. Inventory's queue is first-in-first-out. Explain why that makes things worse during overload, and what you'd change.
5. Design a staging test that would have found this problem before production.
:::

:::paper Sources
*Metastable Failures in Distributed Systems* (Bronson, Aghayev, Charapko & Zhu, HotOS 2021) named and defined the pattern. *Metastable Failures in the Wild* (Huang et al., OSDI 2022) is the empirical study — 22 failures from 11 organisations, including the AWS outage count and the dominance of retries.

AWS's post-event summary of the October 2025 us-east-1 outage is an unusually detailed real example. Marc Brooker's posts on retries, backoff and metastability (brooker.co.za) are the best practitioner writing on the subject.
:::

## Check yourself

```recall
Q: What makes a failure metastable rather than an ordinary overload?
A: A brief trigger pushes the system into overload, and a feedback loop in the system's own behaviour keeps it there after the trigger is removed — so fixing the cause doesn't restore service.

Q: Name the three ingredients of a metastable failure.
A: A vulnerable state (little headroom plus an amplifier), a temporary trigger (slowdown, deploy, spike, failover) and a sustaining effect (retries, cold cache, wasted work, recovery backlogs).

Q: How common are metastable failures, according to Huang et al. (OSDI 2022)?
A: At least 4 of the 15 major AWS outages in the previous decade had this shape, and retries were the sustaining effect in more than half of the 22 failures studied.

Q: How do retries multiply through a call chain?
A: Each layer's attempts multiply: three layers each trying up to 4 times can send 4 × 4 × 4 = 64 requests to the bottom for one user action — when it is least able to cope.

Q: Why does a cold cache stay cold under full load?
A: The database is overloaded by the misses, queries time out, and timed-out reads never refill the cache — so the cache stays empty and the database stays overloaded.

Q: What is the wasted-work loop?
A: Under overload, requests wait in queue past the client's timeout, so the server spends all its effort on answers nobody receives — busy machines, near-zero goodput. FIFO queues make it worse.

Q: Name four designs that let a system recover by itself.
A: Retry budgets (retries capped at ~10% of traffic) at one layer with jittered backoff, circuit breakers, deadline propagation with early load shedding (and newest-first under overload), and gradual cache warming with throttled recovery work.

Q: How do you test for metastability?
A: Push load well past capacity, then drop it back to normal and watch goodput. If it stays low after the overload ends, there's a sustaining effect to remove.
```

## What to carry forward

- **Some outages outlive their trigger** because the system's own behaviour sustains the overload.
- The sustaining effects are **ordinary optimisations** — retries, caches, queues — interacting near capacity.
- **Bound every amplifier**: retry budgets at one layer, jittered backoff, circuit breakers.
- **Never do work nobody will receive**: propagate deadlines, shed early, serve newest first under overload.
- **Keep headroom and throttle recovery**, and test by overloading then removing load.
