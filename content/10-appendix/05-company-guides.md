---
title: Company-by-Company Guides
summary: What each major company's system design loop actually emphasizes, the question styles you'll see, and how to adjust your preparation for each.
difficulty: Easy
scope: Both
tags: [google, meta, amazon, netflix, uber, companies]
---

:::predict Guess first
1. Would a payments company and a ride-sharing company stress the same parts of a system design?
2. At a 50,000-user startup, how would a multi-region, cell-based design be received?
3. How much of your preparation should be company-specific?
:::

:::note A caveat worth reading
Interview processes change, and individual interviewers vary far more than company policy does. Treat these as *tendencies* — useful for prioritizing preparation, not as guarantees. The [framework](framework.html) works everywhere; these are adjustments to emphasis.
:::

## Google

**Emphasis: fundamentals and distributed systems depth.**

Google interviewers tend to probe *why* rather than *what*. Expect to be pushed several layers into a single component, and expect a preference for reasoning from first principles over naming products.

**What comes up disproportionately:**
- [Consensus](../03-distributed/consensus.html), replication, and consistency models — including the ability to explain why a choice is correct, not just that it is.
- Precise definitions. Being sloppy about "consistency" (CAP's C vs ACID's C) is noticed.
- Capacity estimation, done carefully and used.
- Large-scale data processing and indexing.

**Style:** often more abstract prompts ("design a system that stores and retrieves X at scale") rather than "design product Y." Less product framing, more systems.

**Preparation adjustment:** go deep on the [Distributed Deep Dives](../03-distributed/consensus.html) track. Be able to whiteboard Raft leader election in four minutes. Know what linearizability actually means and what it costs. Be comfortable saying "I don't know" precisely.

## Meta

**Emphasis: scale, product intuition, and pragmatic tradeoffs.**

Meta's prompts are usually recognizable products, and the interview moves fast — you're expected to reach a working design quickly and then defend choices under pressure.

**What comes up disproportionately:**
- [News feed](../05-case-studies/news-feed.html) and fanout, in many disguises.
- [Real-time delivery](../02-building-blocks/realtime.html) and messaging.
- Hot-key and celebrity problems (they live this).
- Caching strategy at extreme scale.
- Product-aware tradeoffs: "would users notice?" is a legitimate and expected argument.

**Style:** conversational and fast-paced. Interviewers interrupt with challenges; that's engagement, not hostility. Expect "what if this were 10× bigger?" repeatedly.

**Preparation adjustment:** be fast to a high-level design (aim for minute 20, not 27). Practice defending decisions under rapid-fire challenge. Get comfortable arguing from user impact — "a 200ms-stale like count is invisible to users, so I'll take the availability" is exactly the right register.

## Amazon

**Emphasis: ownership, operations, and the Leadership Principles woven into technical discussion.**

Amazon's system design interviews are more likely to include operational and cost dimensions, and to connect to how you'd actually own the system.

**What comes up disproportionately:**
- Failure handling, [idempotency](../03-distributed/idempotency.html), and retries.
- Cost consciousness — genuinely, not as a throwaway.
- Operational concerns: deployment, monitoring, on-call, runbooks.
- Service-oriented decomposition and API contracts.
- Working backwards from the customer requirement.

**Style:** expect the interviewer to probe *ownership* — "how would you know this was broken?", "what would you do at 3am?", "how much does this cost?" Behavioural threads may weave into the technical discussion.

**Preparation adjustment:** for every design, prepare the operational story — what you monitor, how you deploy, what the failure runbook says, and what it costs. Mention **reconciliation** and **dead letter queues** where relevant. Be ready to justify complexity in terms of customer benefit.

## Netflix

**Emphasis: resilience, streaming/media architecture, and operating at high availability.**

**What comes up disproportionately:**
- [Backpressure, circuit breakers, and graceful degradation](../03-distributed/backpressure.html) — this is core to their engineering culture.
- [CDN](../02-building-blocks/cdn.html) and media delivery.
- Chaos engineering and failure injection.
- Microservices at scale, and the availability tax that comes with them.

**Style:** senior-heavy, with an expectation that you've thought hard about failure. Fewer candidates, deeper conversations.

**Preparation adjustment:** be excellent on the [Video Streaming](../05-case-studies/video-streaming.html) case study and on resilience patterns. Be ready to answer "what happens under 10× load?" with a real degradation plan rather than "we'd scale up."

## Uber / Lyft / DoorDash

**Emphasis: real-time systems, geospatial, and matching under latency constraints.**

**What comes up disproportionately:**
- [Geospatial indexing](../02-building-blocks/geospatial.html) and proximity search.
- High-frequency location updates and the ephemeral/durable data split.
- Matching algorithms and state machines with money attached.
- Surge/pricing as a streaming aggregation problem.

**Preparation adjustment:** the [Ride Sharing](../05-case-studies/ride-sharing.html) case study is the centrepiece. Know why straight-line distance is the wrong ranking metric and why location data doesn't go in a durable database.

## Stripe / payments companies

**Emphasis: correctness, ledgers, and idempotency.**

**What comes up disproportionately:**
- Double-entry ledgers and immutable records.
- [Idempotency](../03-distributed/idempotency.html) where duplicates cost real money.
- [Sagas](../03-distributed/distributed-transactions.html) across external providers.
- Reconciliation and auditability.
- API design quality — they care about this more than most.

**Preparation adjustment:** the [Payment System](../05-case-studies/payment-system.html) case study, and be ready to lead with the data model rather than the architecture. "Never store money as a mutable balance" should be reflexive.

## Microsoft / Apple / others

Generally closer to the Google model — fundamentals-focused, less product-framed, and more variable by team. The [framework](framework.html) plus solid fundamentals covers these well.

## Startups and scale-ups

**Emphasis is inverted:** they want to know you *won't* over-engineer.

Proposing a multi-region cell-based architecture for a product with 50,000 users is disqualifying here in a way it isn't at a large company. The winning answer is often "one Postgres, one cache, one queue, and here's the point at which we'd need more."

**Preparation adjustment:** practice the *small* version of every design. Be able to say what you'd build with three engineers and six months.

## What travels everywhere

Regardless of company:

```diagram
   1. Drive the conversation and manage the clock
   2. Quantify assumptions and use the numbers
   3. Justify choices against rejected alternatives
   4. Go genuinely deep somewhere
   5. Name what your design costs and how it fails
```

Company-specific preparation is worth maybe 10% of your effort. The [framework](framework.html), the [rubric behaviours](level-rubrics.html), and enough [case studies](../05-case-studies/url-shortener.html) to be fluent are worth the other 90%.

:::tip Two days before the loop
Read the relevant guide above, re-read [Common Mistakes](common-mistakes.html), and skim the [Cheat Sheet](cheat-sheet.html). Then stop. Marginal knowledge acquired the night before is worth far less than being rested and fluent.
:::

## Check yourself

```recall
Q: What does Google tend to emphasise?
A: Fundamentals and distributed-systems depth: why rather than what, consensus and consistency precisely defined, careful estimation, and abstract systems prompts.

Q: What does Meta tend to emphasise?
A: Scale, product intuition and pragmatic tradeoffs: fast high-level designs, feeds and fanout, real-time delivery, hot keys, and arguments from user impact under rapid challenge.

Q: What does Amazon tend to emphasise?
A: Ownership and operations: failure handling, idempotency, cost, deployment, monitoring and on-call, service contracts, and working backwards from the customer.

Q: What do Netflix and ride-sharing companies emphasise?
A: Netflix: resilience, graceful degradation, CDNs and chaos engineering. Uber-style: geospatial indexing, high-frequency location updates, matching and state machines with money.

Q: What do payments companies emphasise?
A: Correctness: double-entry ledgers, idempotency, sagas across providers, reconciliation, auditability and API design — lead with the data model.

Q: How do startups invert the usual emphasis?
A: They want evidence you won't over-engineer: one Postgres, one cache, one queue, and the point at which you'd need more.

Q: What travels to every company?
A: Drive and manage the clock, quantify and use numbers, justify against alternatives, go deep somewhere, and name cost and failure modes — about 90% of the value.
```

## What to carry forward

- Treat company guides as tendencies; interviewers vary more than policy.
- Shift emphasis per company: depth, product speed, operations, resilience, geospatial or correctness.
- Startups reward the small version of every design.
- Company-specific prep is ~10% of the effort; the framework and fluency are the rest.
