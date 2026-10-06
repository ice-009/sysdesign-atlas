---
title: Queueing Theory & Why Latency Explodes
summary: Little's Law, the utilization curve, and the mathematical reason a system that is fine at 70% load falls apart at 85% — the most useful theory in systems engineering.
difficulty: Medium
scope: Core
tags: [fundamentals, latency, queueing, capacity]
prereqs: [latency-throughput]
unlocks: Predicting where a system will fall over, and why adding capacity sometimes doesn't help.
---

:::predict Guess first
1. A service runs fine at 70% of its capacity. Traffic grows 20%, still well under the ceiling. Roughly what happens to its latency?
2. Same total capacity: one server twice as fast, or two normal servers sharing one queue. Which gives lower waiting time?
3. Arrivals exceed what your servers can handle. Does a bigger queue help?
:::

## The observation that needs explaining

A service handles 700 requests per second with a p99 of 40 ms — meaning 99 requests in 100 finish within 40 ms, and the slowest 1% are what we're measuring. Traffic grows 20%. Now it handles 840 requests per second — well under the 1,000/s the team measured as its ceiling — and p99 is 1.2 seconds.

Nothing broke. No code changed. Load went up 20% and tail latency went up 30×.

This is not a bug, and it is not mysterious. It is the single most important curve in systems engineering, and once you have seen it you will recognise it in every incident review you ever read.

## Little's Law

The foundational result, and it is almost embarrassingly simple:

:::derive Little's Law
```
   L = λ × W

   L  = average number of items in the system  (concurrency)
   λ  = average arrival rate                    (throughput)
   W  = average time an item spends inside      (latency)
```

It holds for **any** stable system, regardless of arrival distribution, service
time distribution, or scheduling policy. No assumptions required.
:::

That generality is what makes it useful. Three quantities, and knowing any two gives you the third.

**Worked examples:**

- A service handles 2,000 req/s with an average latency of 50 ms. Concurrency is `2000 × 0.05 = 100` requests in flight. If your thread pool has 80 threads, you are already the bottleneck.
- You want 10,000 req/s and each request takes 200 ms because it waits on a slow downstream. You need `10000 × 0.2 = 2000` concurrent operations in flight. With one OS thread per request that's 2,000 threads — which is why this workload wants an event loop or async runtime, not threads. See [concurrency and the OS](concurrency-and-the-os.html).
- A queue holds 50,000 messages and consumers drain 5,000/s. Messages wait `50000 / 5000 = 10` seconds. If you've promised customers 2 seconds (an SLA — a service level agreement, the response time you're contractually on the hook for), you need 5× the consumers, and Little's Law told you that in one line.

:::goat Use it backwards
Little's Law is most powerful read in reverse. **Latency is not a property you tune; it is a consequence of concurrency divided by throughput.**

If you want lower latency and throughput is fixed by demand, the only lever is reducing how many things are in the system at once — smaller queues, tighter admission control, less work in flight. That reframing is the whole intellectual basis of [backpressure](../03-distributed/backpressure.html), and it explains why *removing* buffering often makes a system faster.
:::

## The utilization curve

Little's Law tells you the relationship between the three quantities. It does not tell you why 84% utilization is dangerous. For that you need one more result.

**Utilization** is the fraction of the time your server is busy rather than idle: arrivals divided by how many it could handle. 84% utilization means it's working 84 minutes of every 100.

For the simplest possible case — requests turning up at random moments, one server handling them one at a time — there's a standard formula. (It's called the **M/M/1 model**: arrivals are random, service times are random, one server. "Random" here means **Poisson** arrivals, which just means each arrival is independent of the last, like raindrops hitting a window rather than a metronome.) The average time in the system is:

:::derive The M/M/1 response time
```
   ρ = utilization = arrival rate / service rate      (0 ≤ ρ < 1)
   S = average service time (how long one request takes when idle)

   W = S / (1 − ρ)

   Queue wait alone:   Wq = S × ρ / (1 − ρ)
```

The `1 − ρ` in the denominator is the entire story. As ρ approaches 1,
the denominator approaches zero, and W goes to infinity.
:::

Put numbers in it. Take a service where one request takes 10 ms of actual work:

| Utilization | Multiplier `1/(1−ρ)` | Response time | Change from previous row |
|---:|---:|---:|---|
| 10% | 1.11 | 11 ms | — |
| 50% | 2.0 | 20 ms | +9 ms |
| 70% | 3.3 | 33 ms | +13 ms |
| 80% | 5.0 | 50 ms | +17 ms |
| 90% | 10 | 100 ms | +50 ms |
| 95% | 20 | 200 ms | +100 ms |
| 99% | 100 | 1,000 ms | +800 ms |
| 99.9% | 1000 | 10,000 ms | +9,000 ms |

```viz
{
  "type": "axes",
  "caption": "Response time versus utilization. The knee is not a metaphor.",
  "x": "utilization →",
  "y": "latency →",
  "z": "the knee",
  "xs": "0% to 100%",
  "ys": "S / (1 − ρ)",
  "zs": "~70-80%"
}
```

**The last 10% of capacity costs more than the first 90%.** Going from 10% to 80% utilization added 39 ms. Going from 80% to 95% added 150 ms. Same 15 percentage points of capacity, four times the damage.

:::goat Why the incident looked mysterious
Return to the opening example. At 700 req/s against a 1,000 req/s ceiling, ρ = 0.70 and the multiplier is 3.3. At 840 req/s, ρ = 0.84 and the multiplier is 6.25.

A 20% traffic increase produced a **1.9× increase in average latency** — and because the tail responds far more violently than the average, p99 moved by far more than that.

Saying this out loud — "we were at 70% and moved to 84%, which nearly doubles queueing delay even though we never hit the ceiling" — is the difference between explaining an incident and describing it.
:::

## Variability makes it worse

M/M/1 assumes exponentially distributed service times. Real workloads are far more variable than that: a request that hits cache takes 2 ms, one that misses and does three database queries takes 200 ms.

**Variability** here means how much request times differ from each other, not how long they are on average. A service where every request takes exactly 50 ms has no variability; one where they range from 2 ms to 2 seconds has a lot — even if both average the same.

The general result (Kingman's formula) says queue wait scales with the **square** of that variability:

:::derive Kingman's approximation
```
                ρ        c²ₐ + c²ₛ
   Wq  ≈   S × ───── × ───────────
                1−ρ         2

   c²ₐ = how spread out the arrival times are
   c²ₛ = how spread out the service times are
        (both are variance / mean², a unitless measure of
         "how uneven"; c² = 0 means perfectly regular, c² = 1
         is the ordinary random case)
```

Halving service-time variability roughly halves queue wait at any given
utilization — **without adding a single machine.**
:::

This is why the following all work, and why they work better than they seem they should:

- **Separating fast and slow requests into different pools.** Mixing a 2 ms request behind a 2 second one inflates `c²ₛ` enormously. Split them and both get faster.
- **Timeouts.** They truncate the tail of the service-time distribution, which reduces variance, which reduces queueing for everyone else.
- **Caching.** Beyond making the cached request fast, it removes the *slow* cases from the distribution.
- **Bounded batch sizes.** One giant batch is a variance bomb.

:::trap "We're only at 60% CPU, we have plenty of headroom"
Average utilization over a minute hides everything that matters. Traffic arrives in bursts; a service averaging 60% over a minute may be at 95% for the 200 ms bursts that actually generate your p99.

Also, CPU is rarely the queue that matters. The real queue is usually the connection pool, the thread pool, a downstream dependency's capacity, or a lock. Measure utilization of **the constrained resource**, at a resolution finer than the bursts.
:::

## More servers beat a faster server

Now compare one server that is twice as fast (M/M/1) against two servers of the original speed sharing one queue (M/M/2). Same total capacity.

```diagram
   M/M/1, one 2× server           M/M/2, two 1× servers, shared queue

   →→→→ [ ▓▓ ]                    →→→→ ┌─ [ ▓ ]
                                       └─ [ ▓ ]

   At ρ = 0.8:                     At ρ = 0.8:
     Wq = 4.0 × S/2 = 2.0 S          Wq ≈ 1.42 × S/1 ... but each server
     (S/2 because it's 2× faster)    handles half → effective ≈ 0.71 S

   → Two servers sharing one queue beat one server of double speed,
     because a burst can be served in parallel and a single slow
     request no longer blocks everything behind it.
```

This is the mathematical justification for horizontal scaling beyond just cost, and — importantly — for **a single shared queue rather than per-server queues**. Round-robin load balancing assigns work to a server that may already be busy while another sits idle. That is why *least-connections* or *least-outstanding-requests* balancing measurably beats round robin at high utilization. See [load balancing](../02-building-blocks/load-balancing.html).

:::goat The one-queue insight
Supermarket checkouts versus airport security. Supermarkets give each till its own queue; airports use one snake feeding many desks. The snake is strictly better — you can never be stuck behind one slow transaction while a desk is free.

Per-server queues are supermarket checkouts. A shared queue with work-stealing is the airport snake. Most load balancer misconfigurations are a supermarket.
:::

## Why queues do not fix overload

The intuition "add a buffer to absorb the spike" is right only if the spike is temporary and the buffer is small.

```diagram
   Arrival rate 1,200/s · service rate 1,000/s · unbounded queue

     t = 1s    queue = 200     wait = 0.2 s
     t = 10s   queue = 2,000   wait = 2 s
     t = 60s   queue = 12,000  wait = 12 s
     t = 300s  queue = 60,000  wait = 60 s

   The queue never recovers while λ > μ. It just converts
   "some requests fail" into "all requests are late."
```

**If arrivals exceed service capacity, no queue size saves you.** Queues absorb *variance*; they do not add *capacity*. An unbounded queue in an overloaded system produces the worst outcome available: every request is served, all of them too late to be useful, and the client has usually timed out and retried — adding more load.

The correct response to sustained overload is to **shed load**: bounded queues, admission control, and fast rejection. A rejected request costs almost nothing; a request served after the client gave up costs full capacity and delivers zero value. This is the core argument of [backpressure](../03-distributed/backpressure.html).

:::trap Coordinated omission
Your load generator sends a request, waits for the response, then sends the next. When the server stalls for 2 seconds, the generator also stops sending — so it never records the requests that *would* have arrived and waited during that stall.

The result is a latency histogram that looks great while the system is visibly broken. Real users don't pause when your server is slow; they pile up.

Fix it by measuring latency from the time a request *should* have been sent under the intended rate, not from when it actually was. Tools that do this correctly: `wrk2`, `hdrhistogram`-based harnesses. Tools that get it wrong by default: most of them.
:::

## Applying it

:::exercise Work these out
1. A service has 200 threads and each request takes 100 ms. What is its maximum sustainable throughput? (Little's Law, rearranged.)
2. That service is receiving 1,800 req/s. What is ρ? What does the M/M/1 multiplier predict for latency? Is the answer trustworthy — and why not?
3. You measure p50 = 20 ms, p99 = 900 ms. Which of these is most likely to help, and why: doubling the servers, adding a 10× larger queue, adding a 100 ms timeout, splitting slow endpoints into their own pool?
4. Your queue depth alarm fires at 10,000 messages. Consumers drain 2,000/s. How long until a message entering now is processed? Is a depth alarm even the right signal — what would you alarm on instead?
:::

Answers worth checking your reasoning against: (1) `200 / 0.1 = 2,000 req/s`. (2) ρ = 0.9, multiplier 10, so ~1 s — and it's optimistic, because real service times are more variable than exponential. (3) The timeout and the pool split, because both attack variance; a bigger queue makes it strictly worse. (4) 5 seconds — and you should alarm on **queue wait time**, not depth, because depth means nothing without the drain rate.

:::paper Sources
Little's original proof is *A Proof for the Queuing Formula L = λW* (Little, 1961). Kingman's *The Single Server Queue in Heavy Traffic* (1961) gives the variability result.

For the practical treatment: Neil Gunther's *Guerrilla Capacity Planning* covers the Universal Scalability Law, which extends this with contention and coherency terms; Gil Tene's talk *How NOT to Measure Latency* is the definitive treatment of coordinated omission.
:::

## Check yourself

```recall
Q: In the M/M/1 model, what does response time do as utilisation ρ approaches 100%, and why?
A: It goes to infinity: W = S / (1 − ρ), and the denominator heads to zero. With 10 ms of work it's 50 ms at 80%, 100 ms at 90% and 1 s at 99%.

Q: A service goes from 70% to 84% utilisation. What happens to average queueing delay?
A: The multiplier 1/(1 − ρ) rises from about 3.3 to about 6.25, so average latency nearly doubles — and p99 moves far more — even though the ceiling was never reached.

Q: Read Little's law backwards: if demand fixes throughput, what is the only lever on latency?
A: How much is in the system at once — smaller queues, admission control, less work in flight. That's the basis of backpressure, and why removing buffering can make a system faster.

Q: Kingman's formula says queue wait grows with variability. Name three ways to cut variability without adding machines.
A: Split fast and slow requests into separate pools; add timeouts to cut off the slow tail; cache, which removes slow cases; keep batches bounded.

Q: Why does a shared queue feeding many servers beat one queue per server?
A: With one queue, no request waits behind a slow one while another server sits idle — the airport snake versus supermarket checkouts. It's why least-outstanding-requests balancing beats round robin under load.

Q: Arrivals are 1,200/s and capacity is 1,000/s, with an unbounded queue. What happens over five minutes?
A: The queue grows by 200 a second without limit — 60,000 waiting and 60 s of wait after five minutes. Queues absorb variance, not overload; under sustained overload you must shed load.

Q: What is coordinated omission in a load test?
A: A generator that waits for each response before sending the next pauses when the server stalls, so it never records the requests that would have piled up. Latency numbers look fine while the system is broken.

Q: Your queue-depth alarm fires at 10,000 messages. Why is wait time a better signal than depth?
A: Depth means nothing without the drain rate: 10,000 messages at 2,000/s is a 5 s wait, at 100/s it's 100 s. Alarm on how long a message waits.
```

## What to carry forward

- **`L = λW`** — concurrency, throughput, latency. Know two, derive the third.
- **`W = S/(1−ρ)`** — the knee sits around 70–80% utilization. Plan capacity to stay left of it.
- **Variance costs as much as load.** Reducing variability lowers latency without adding hardware.
- **Many servers on one shared queue** beat a single fast server, and beat per-server queues.
- **Queues absorb variance, not overload.** Under sustained overload, shed rather than buffer.
- Measure the utilization of **the actually-constrained resource**, at burst resolution, without coordinated omission.
