---
title: Routes Through the Material
summary: Four concrete paths — a full depth-first curriculum, an AI-infrastructure route, a "just make me competent at work" route, and a three-week interview sprint.
difficulty: Easy
scope: Core
tags: [plan, schedule, orientation]
unlocks: A specific next page to open, instead of a table of contents to stare at.
---

:::predict Guess first
1. Is reading all the topics front to back a good plan?
2. Can you skip the core systems material if you only care about AI infrastructure?
3. In a three-week interview sprint, what should matter more — reading more case studies, or live mock interviews?
:::

## Pick the one that matches your goal

There are 159 topics here. Reading them front to back is a valid plan and a slow one. These four routes exist because "learn system design" usually means one of four different things.

| Route | For | Rough time |
|---|---|---|
| **A — The full curriculum** | Understanding systems properly, no deadline | 4–6 months at a few hours/week |
| **B — AI infrastructure** | Working on or moving into ML/LLM infrastructure | 6–10 weeks |
| **C — Competent at work** | Being useful in design reviews on Monday | 3–4 weeks |
| **D — Interview in three weeks** | Exactly what it says | 3 weeks |

All four assume the habits from [How to Study Systems](how-to-study.html) — particularly estimating before you look and designing before you read. Without those, every route degrades into reading.

---

## Route A — The full curriculum

The intended path. Depth-first, in prerequisite order, interleaving application with theory so nothing sits unused long enough to decay.

**Phase 1 — Foundations (3–4 weeks).** The whole Foundations track in order. Do the exercises; they're the point. By the end you should be able to do capacity arithmetic out loud without a calculator, and explain from first principles why a service at 85% utilization has terrible tail latency.

**Phase 2 — Building Blocks (4–5 weeks).** Twenty-one components. After every three or four, open a [case study](../08-case-studies/url-shortener.html) that uses them and read only as far as the section that applies. Application within 48 hours is what makes them stick.

**Phase 3 — Distributed Systems (3–4 weeks).** The hardest track, and the one that changes how you think. Read [consensus](../03-distributed/consensus.html) twice — once for the mechanism, once after you've designed something that needs it.

**Phase 4 — Data & Storage (2–3 weeks).** What actually happens beneath a query. Short track, high density.

**Phase 5 — Applied (4–6 weeks).** All nineteen case studies and the classic builds. **Design each one cold for twenty minutes before reading.** One per session; do not batch them. If you also want the class-level half of design — objects, interfaces, concurrency inside one process — the [Low-Level Design](../11-lld/three-day-plan.html) track slots in here and is largely independent of the rest.

**Phase 6 — AI Systems (6–8 weeks).** The three AI tracks, then the AI builds. By this point the Core material makes them read as variations rather than new subjects.

**Checkpoint at the end of each phase:** pick a system you haven't studied, design it in 45 minutes with no reference, and note where you stalled. The stalls tell you whether to move on or go back.

---

## Route B — AI infrastructure

For someone who needs to be effective on ML or LLM infrastructure and doesn't have four months. This route takes the shortest honest path — you cannot skip the Core prerequisites, because the AI material is built directly on them, but you can take a narrow slice.

**Week 1 — the physics.**
[Hardware numbers](../01-foundations/hardware-numbers.html) · [Latency & throughput](../01-foundations/latency-throughput.html) · [Queueing theory](../01-foundations/queueing-theory.html) · [Back-of-envelope](../01-foundations/back-of-envelope.html)

Non-negotiable. Inference serving is a memory-bandwidth problem wearing a queueing problem's clothes, and neither makes sense without these.

**Week 2 — the components you'll reuse.**
[Caching](../02-building-blocks/caching.html) · [Message queues](../02-building-blocks/message-queues.html) · [Load balancing](../02-building-blocks/load-balancing.html) · [Consistent hashing](../02-building-blocks/consistent-hashing.html) · [Backpressure](../03-distributed/backpressure.html) · [Networking](../01-foundations/networking.html)

Every one of these reappears in the AI tracks with GPUs substituted for servers.

**Weeks 3–4 — models as systems.** The whole AI Foundations track. This is where the arithmetic that governs everything else gets established.

**Weeks 5–7 — the machines.** The whole AI Infrastructure track. Heaviest section here; take it slowly.

**Weeks 8–10 — the product layer.** Applied AI Systems, then the AI builds.

**Detour when needed:** if you'll work on training data or evaluation, add [stream processing](../04-data/stream-processing.html) and [lakehouse & batch](../04-data/lakehouse-and-batch.html) after week 2.

---

## Route C — Competent at work

You want to contribute usefully to design discussions and stop nodding at words you can't define. Three to four weeks, breadth over depth.

**Week 1 — vocabulary with substance.**
[Scalability basics](../01-foundations/scalability-basics.html) · [Hardware numbers](../01-foundations/hardware-numbers.html) · [Latency & throughput](../01-foundations/latency-throughput.html) · [Queueing theory](../01-foundations/queueing-theory.html) · [Availability math](../01-foundations/availability-slas.html)

Queueing theory is the highest-value page in this atlas for day-to-day work. It explains most production incidents you'll ever read a writeup of.

**Week 2 — the components in your stack.**
[Caching](../02-building-blocks/caching.html) · [Load balancing](../02-building-blocks/load-balancing.html) · [SQL vs NoSQL](../02-building-blocks/sql-vs-nosql.html) · [Indexing](../02-building-blocks/indexing.html) · [Replication](../02-building-blocks/replication.html) · [Message queues](../02-building-blocks/message-queues.html)

**Week 3 — the things that break.**
[Failure modes](../01-foundations/failure-modes.html) · [Idempotency](../03-distributed/idempotency.html) · [Backpressure](../03-distributed/backpressure.html) · [Consistency models](../01-foundations/consistency-models.html) · [Durability & the WAL](../04-data/wal-and-durability.html)

This week is what makes you useful in an incident review.

**Week 4 — apply it.** [Trace one request](how-to-study.html) through a system you own, end to end, writing down every step. Then read two case studies closest to what your team builds.

---

## Route D — Interview in three weeks

The least effective use of this material and the right choice under a real deadline. Optimise for coverage of the question space, not understanding.

**Week 1 — structure and numbers.**
Read the [appendix framework](../10-appendix/framework.html) and [cheat sheet](../10-appendix/cheat-sheet.html) first. Then [back-of-envelope](../01-foundations/back-of-envelope.html) and [hardware numbers](../01-foundations/hardware-numbers.html) until the arithmetic is automatic. Then [CAP/PACELC](../01-foundations/cap-pacelc.html) and [consistency models](../01-foundations/consistency-models.html).

**Week 2 — eight case studies, one per day, in this order:**
[URL shortener](../08-case-studies/url-shortener.html) → [rate limiter](../08-case-studies/rate-limiter.html) → [news feed](../08-case-studies/news-feed.html) → [chat](../08-case-studies/chat-system.html) → [notifications](../08-case-studies/notification-system.html) → [ride sharing](../08-case-studies/ride-sharing.html) → [ad click aggregator](../08-case-studies/ad-click-aggregator.html) → [job scheduler](../08-case-studies/job-scheduler.html).

Twenty-five minutes designing cold, then read. Backfill concepts **only** when a case study exposes a gap — open the page, read it, come back.

**If your loop includes a low-level design round** — most SDE-2 loops do — swap two of those case studies for the [three-day LLD plan](../11-lld/three-day-plan.html). It's a separate skill with its own structure, and no amount of architecture practice prepares you for "design a parking lot."

**Week 3 — AI questions and mocks.**
AI system design now appears in loops at most companies building on models. Read [LLM inference serving](../09-builds/llm-inference-serving.html) and [RAG](../09-builds/rag-system.html) at minimum. Then [common mistakes](../10-appendix/common-mistakes.html), the [annotated mock](../10-appendix/annotated-mock.html), and **two live mocks with an actual human**. The mocks are the part that matters; everything else is preparation for them.

:::goat What the sprint actually costs you
This route produces the ability to give a good account of eight specific systems and to recognise the shape of a ninth. It does not produce the ability to reason about a system you've never seen, which is what the question is really testing and what a good interviewer will probe for.

If you have the time, Route A. If you don't, run Route D without pretending it's the same thing, and come back to Route A afterwards — the material is more interesting when nothing depends on it.
:::

---

## Regardless of route

**Review before you read.** On the iPad edition, start each session with your due *Review* cards — ten to fifteen minutes — then move on to new pages. It's what stops week 1 from evaporating by week 6. See [How to Study Systems](how-to-study.html) for how the schedule works.

**Track your stalls, not your reading.** Once a month, design a random system from the [question bank](../10-appendix/question-bank.html) in 45 minutes with no reference. Where you stall is the only honest measure of progress.

**Keep your sketches.** Redesigning the same system three months later and diffing against your first attempt shows improvement that a progress bar cannot.

**Interleave, always.** No more than about a week of pure theory before applying some of it. Concepts decay fast when unused, and the decay is invisible until you try to use them.

:::exercise Choose and commit
1. Pick your route and write down the finish date.
2. Open the first page of week 1 now, not later.
3. Before reading it, write down what you already think you know about the topic. Compare afterwards — that comparison is the first rep of the habit that makes all of this work.
:::

## Check yourself

```recall
Q: What are the four routes?
A: A — the full curriculum (4–6 months); B — AI infrastructure (6–10 weeks); C — competent at work (3–4 weeks); D — interview in three weeks.

Q: What is Route A's order?
A: Foundations, Building Blocks, Distributed Systems, Data & Storage, then Applied (case studies and builds designed cold first, plus LLD if wanted), then the AI tracks — with a cold 45-minute design checkpoint after each phase.

Q: Why can't Route B skip core material?
A: The AI material is built on it: hardware numbers, latency, queueing and estimation first, then caching, queues, load balancing, consistent hashing and backpressure, before AI foundations and infrastructure.

Q: What does Route C cover?
A: Vocabulary with substance (scalability, hardware numbers, latency, queueing, availability), the components in your stack, the things that break (failure, idempotency, backpressure, consistency, durability), then tracing a real request.

Q: What does Route D do, and what does it cost?
A: Framework and numbers, eight case studies designed cold, LLD if the loop has it, AI builds, then live mocks. It covers specific systems but not reasoning about unseen ones — come back to Route A afterwards.

Q: What applies regardless of route?
A: Review due cards before reading, track your stalls with a monthly cold design, keep your sketches, and never go more than a week of theory without applying it.
```

## What to carry forward

- Pick the route that matches your goal and commit to a finish date.
- Every route depends on guessing first and designing before reading.
- Review daily so earlier weeks don't evaporate.
- Measure progress by where you stall, not by pages read.
