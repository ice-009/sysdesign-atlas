---
title: Availability, SLAs & Redundancy Math
summary: What the nines cost, why serial dependencies destroy availability, and how error budgets convert reliability from an argument into a number.
difficulty: Medium
scope: Core
tags: [availability, reliability, sla]
prereqs: [back-of-envelope, scalability-basics]
---

## The nines, in minutes

**Availability** is the fraction of time your system is actually working: uptime divided by total time. People quote it as a number of nines — "three nines" means 99.9% — and that shorthand is how availability targets get written into contracts and design docs.

The table below is worth internalising, because the interesting column is not the percentage but the downtime it buys you.

| Availability | Downtime/year | Downtime/month | Downtime/week |
|---|---|---|---|
| 90% ("one nine") | 36.5 days | 72 h | 16.8 h |
| 99% | 3.65 days | 7.2 h | 1.68 h |
| 99.9% ("three nines") | 8.76 h | 43.8 min | 10.1 min |
| 99.99% ("four nines") | 52.6 min | 4.4 min | 1.01 min |
| 99.999% ("five nines") | 5.26 min | 26 s | 6 s |

The key insight: **each nine costs roughly 10× more than the last.** Going from 99% to 99.9% might mean adding a replica and health checks. Going from 99.99% to 99.999% means running in several regions at once with all of them live (**active-active**), switching away from a broken one automatically within seconds (**failover**), no human step anywhere in recovery, and an organisation that can ship changes without taking anything offline. That's a different company, not a different architecture.

:::interview Push back on unrealistic targets
When a requirement says "it should be highly available," push it into numbers and ask *what the availability is worth*. "Do we need four nines? That implies under five minutes of downtime a month, which rules out any manual failover step and means multi-AZ minimum. Three nines gives us 43 minutes and is dramatically cheaper. Which is right for this product?" Turning a vague adjective into a costed decision is exactly the senior behavior being tested.
:::

## Serial dependencies multiply

This is the most important and least intuitive fact about availability.

If a request must pass through several components **in series**, and each can independently fail, the availabilities multiply:

```diagram
   [LB 99.99%] → [App 99.9%] → [Cache 99.9%] → [DB 99.95%]

   0.9999 × 0.999 × 0.999 × 0.9995 = 0.9974
                                   ≈ 99.74%  →  ~23 hours/year
```

Every component was "highly available." The system is not. **Adding a dependency always lowers availability** unless it's optional.

Two consequences that make good interview material:

1. **Microservices have an availability tax.** A request touching 10 services each at 99.9% yields 0.999¹⁰ = 99.0% — 3.65 days of downtime a year. This is why mature microservice architectures invest so heavily in fallbacks, caching, and circuit breakers (a switch that stops calling a failing service for a while, instead of piling on requests that will time out anyway): they're buying back the availability that splitting things up spent.
2. **Make dependencies optional.** If the recommendation service being down means "show popular items instead" rather than "return 500," it's no longer in your serial chain. Converting hard dependencies into soft ones is often the cheapest availability improvement available.

## Redundancy adds nines

Parallel redundancy works the opposite way — you fail only if *all* replicas fail:

```diagram
   A_system = 1 − (1 − A_component)^N

   One 99% node:       99%       → 3.65 days/yr down
   Two 99% nodes:      99.99%    → 52 min/yr
   Three 99% nodes:    99.9999%  → 31 s/yr
```

Redundancy is spectacularly effective on paper. In reality it's limited by three things:

- **Correlated failure.** Two nodes in the same rack share a power supply and a switch. Same AZ shares utility power and cooling. Same region shares a control plane. The math above assumes independence, and independence is exactly what you're paying for when you spread across AZs and regions.
- **The failover mechanism itself.** If detecting failure takes 30 s and promoting a replica takes 60 s, you have a 90-second outage no matter how many replicas exist. Failover time frequently dominates the availability calculation.
- **Shared fate through software.** A bad deploy, a poisoned cache entry, or a config change hits every replica simultaneously. This is why staged rollouts and canaries matter more than replica count for real-world availability.

:::goat Say this about correlated failure
"Three replicas gives me six nines *if failures are independent* — but they're not. In one AZ they share power and network, so I'd place them across three AZs. That drops the correlated-failure risk to region-level events, which is where I'd stop unless the SLA requires multi-region." Naming the independence assumption and then attacking it is a distinctly senior move.
:::

## SLA vs SLO vs SLI

These get used interchangeably and shouldn't be:

- **SLI (Indicator)** — the actual measurement. "Proportion of HTTP requests returning non-5xx in under 300 ms."
- **SLO (Objective)** — your internal target for that indicator. "99.9% over a rolling 28 days." This is what engineering builds toward.
- **SLA (Agreement)** — the contract with customers, including **penalties**. Typically set *looser* than the SLO, deliberately, so you breach your internal target long before you owe anyone money.

Common structure: SLA 99.9%, SLO 99.95%, and alerting that fires well before either.

## Error budgets

The single most useful reframe in reliability engineering.

If your SLO is 99.9%, you have implicitly authorized **0.1% unreliability** — about 43 minutes a month. That's not failure; that's *budget*.

```diagram
   Error budget = (1 − SLO) × total requests

   SLO 99.9%, 100M requests/month
   → budget = 100,000 failed requests/month
```

What this changes:

- **Budget remaining → ship faster.** Risky migrations, aggressive experiments, faster rollouts.
- **Budget exhausted → freeze features**, work reliability until the window resets.

This converts the perennial argument between "move fast" and "keep it stable" into arithmetic. Error budgets are the concrete answer to "how do you balance velocity and reliability?" — they convert a values argument into an arithmetic one.

## MTBF, MTTR, and where to spend

```diagram
   Availability = MTBF / (MTBF + MTTR)

   MTBF = mean time between failures   (how often it breaks)
   MTTR = mean time to recovery        (how long you're down)
```

Both levers work, but they cost very differently. Halving your failure rate typically means eliminating whole classes of bugs and hardware faults — expensive and slow. Halving recovery time means better detection, faster rollback, and automated failover — usually cheaper and more achievable.

```diagram
   MTBF 30 days, MTTR 60 min   → 99.86%
   MTBF 30 days, MTTR  5 min   → 99.99%   (same failure rate!)
   MTBF 90 days, MTTR 60 min   → 99.95%
```

**Cutting MTTR from 60 to 5 minutes bought two nines without preventing a single failure.** That's why mature organizations obsess over rollback speed, feature flags, and one-click failover: it's the highest-leverage reliability work available.

## Availability vs durability

Frequently conflated; completely different.

- **Availability** — can I reach the data *right now*?
- **Durability** — will the data still exist later?

S3-class object storage advertises ~99.999999999% (eleven nines) durability but ~99.99% availability. Translation: the service may be briefly unreachable, but your bytes are not going to be lost. Those are different guarantees achieved by different mechanisms — durability by erasure coding and multi-AZ replication, availability by request routing and capacity.

The interview-relevant version: **a system can be unavailable and lose nothing, or available and lose data.** Async replication with fast failover gives you high availability and a window of data loss (your RPO). Sync replication gives durability at the cost of write latency and availability during partitions.

## RPO and RTO

The two numbers that define your disaster recovery posture, and worth naming explicitly:

- **RPO (Recovery Point Objective)** — how much data you can afford to lose, measured in time. RPO = 5 min means async replication with ≤5 min lag, or 5-minute backups.
- **RTO (Recovery Time Objective)** — how long recovery may take. RTO = 1 min rules out restoring from backup; you need a hot standby.

| Strategy | RPO | RTO | Relative cost |
|---|---|---|---|
| Nightly backup | 24 h | hours | ★ |
| Backup + WAL shipping | minutes | ~1 h | ★★ |
| Async replica, manual failover | seconds | ~10 min | ★★★ |
| Async replica, auto failover | seconds | <1 min | ★★★★ |
| Sync replica (multi-AZ) | 0 | seconds | ★★★★★ |
| Multi-region active-active | 0 | ~0 | ★★★★★★ |

Asking "what's the acceptable RPO here?" instead of asserting a replication strategy is a small move that reads very well: it shows you know the answer depends on the business, not the technology.

## What actually causes outages

Worth knowing, because it redirects where you focus in a design discussion. Across published post-mortems, the dominant causes are consistently:

1. **Change** — deploys, config pushes, schema migrations, certificate expiry. The large majority of incidents.
2. **Dependency failure** — a downstream service degrading and the failure propagating.
3. **Capacity / traffic** — organic spikes, retry storms, [cascading failure](../03-distributed/backpressure.html).
4. **Hardware / infrastructure** — the one people design for most and which causes the fewest incidents.

The implication is uncomfortable and worth saying out loud: **redundancy protects against the rarest cause.** Deploy safety, gradual rollouts, and fast rollback protect against the most common one. A design answer that includes "canary deploys with automated rollback on SLO regression" addresses more real-world downtime than a third replica does.

:::exercise Do the availability arithmetic
1. Your service depends on 6 others, each at 99.9%. What is your ceiling before you write any code? How many nines can you honestly promise?
2. You add a redundant replica of the weakest dependency, at 99.9% each, independent. What does the pair give you? What assumption is doing all the work in that calculation?
3. Your SLO is 99.9% monthly. How many minutes of error budget is that? You have a 40-minute incident on the 3rd. What is your remaining budget, and what should that change about the rest of the month?
4. A dependency is available 99.99% of the time but has a p99 of 8 seconds. Is it "available"? Answer both formally and practically, and say what you would do about it.
:::

:::paper Reliability engineering, formally
Google's *Site Reliability Engineering* (Beyer et al., 2016, free online) chapters on service level objectives and error budgets are the standard reference, and the error-budget framing is the durable idea.

For the underlying mathematics, any reliability engineering text covers series and parallel system availability; the useful insight is that dependencies compose multiplicatively and redundancy composes as one minus the product of failure probabilities.
:::
