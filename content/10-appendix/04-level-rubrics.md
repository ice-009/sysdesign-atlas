---
title: Level Rubrics — L4 vs L5 vs L6
summary: What "senior" actually means to an interviewer, the specific behaviours that map to each level, and how to calibrate your answers to the role you're targeting.
difficulty: Medium
scope: Both
tags: [levels, rubric, seniority]
---

## Why levels matter

The same design, presented two different ways, can be a strong hire at L4 and a no-hire at L6. Interviewers aren't scoring the architecture — they're scoring **the level of engineering judgment the architecture reveals**.

Naming conventions differ (Google L3–L6, Meta E3–E6, Amazon SDE I–III / Principal), but the underlying progression is consistent:

```diagram
   L4 / E4    Solves a well-defined problem correctly
   L5 / E5    Defines the problem, then solves it, and knows
              what the solution costs
   L6 / E6    Sees the system in its organizational and
              operational context; makes decisions others
              will live with for years
```

Note that **you are usually not calibrated by what you know** — you're calibrated by what you *do* with what you know.

## L4 (mid-level) — competence

**What's expected:**
- Knows the components: load balancers, caches, queues, databases, replication.
- Produces a working design for a moderately complex system.
- Does capacity estimation when prompted.
- Answers depth questions on at least one area.
- Responds well to guidance.

**What's tolerated:** needing hints to identify bottlenecks; missing some failure modes; being led through the structure; limited depth outside one or two areas.

**What a strong L4 looks like:** a clean, correct design with clear communication and one area of genuine depth. Prompted for tradeoffs, they give real ones.

**Common L4 ceiling:** they design what was asked, correctly, and never question the requirements or volunteer the design's weaknesses.

## L5 (senior) — judgment

This is the level most people are interviewing for, and the bar shifts from *"can you build it?"* to *"do you know what you're choosing?"*

**What's expected in addition to L4:**

- **Drives the interview.** Sets scope, manages time, chooses deep dives without being asked.
- **Justifies every significant choice against an alternative**, with the constraint that decided it.
- **Volunteers weaknesses** before being asked. "The obvious problem with this is celebrity fanout — let me handle it."
- **Quantifies.** Numbers appear in the reasoning, and each one changes a decision.
- **Handles failure explicitly.** Not "it's highly available" but "if this shard's primary fails, writes for those users stop for ~15 seconds during failover; reads continue from replicas."
- **Knows what not to build.** Proposes the simple solution confidently and states the threshold at which it stops working.
- **Real depth in several areas**, and honest boundaries elsewhere.

**The single clearest L5 tell:** *unprompted tradeoff articulation.* An L4 says "I'll use Cassandra." An L5 says "I'll use Cassandra — write-heavy, known partition key, and I can accept eventual consistency here because a stale like count for 200ms is harmless. If I needed read-your-writes I'd reconsider."

**Common L5 gaps:** designing the system in isolation, with no thought to how it gets built, migrated, deployed, or operated by a team.

## L6 (staff) — context

At this level the technical design is assumed. What's assessed is whether you see the system in its full context.

**What's expected in addition to L5:**

- **Interrogates the requirement itself.** "Is this for latency, disaster recovery, or compliance? If it's DR, a warm standby with a 10-minute RTO is far cheaper than active-active — the answer changes the whole architecture."
- **Migration and rollout are part of the design.** Not "here's the system" but "here's how we get from what exists today to this, incrementally, without downtime, with a rollback at each step."
- **Blast radius thinking.** [Cells](../03-distributed/multi-region.html), staged rollouts, bounded failure domains. Recognizes that [most outages come from change](../01-fundamentals/availability-slas.html), not hardware.
- **Cost as a first-class constraint.** "Cross-region replication of this volume is a large line item — I'd replicate only the transactional core and regenerate derived data locally."
- **Organizational awareness.** "This boundary means two teams coordinate on every release, which is a real cost. I'd draw it differently." Service boundaries are also team boundaries.
- **Operability.** What's on the dashboard, what pages someone at 3am, what the runbook says, what a new engineer needs to understand.
- **Simplification.** Actively removes complexity. "We don't need a service mesh at 15 services — a shared client library gets us retries and mTLS for a fraction of the operational cost."

**The clearest L6 tell:** they change the *problem*, not just the solution — reframing a hard technical requirement into an easier one by questioning a product assumption or moving a boundary.

## Side-by-side

The same question, "how do you handle the celebrity fanout problem?":

| Level | Answer |
|---|---|
| **L4** | "We'd fan out asynchronously with a queue so the post request doesn't block." |
| **L5** | "Push fanout breaks here — a 100M-follower account generates 100M writes from one post. I'd go hybrid: push below ~10K followers, pull above, merged at read time. Costs read-time merge complexity and a threshold to tune, but it caps worst-case write amplification while keeping reads cheap for the vast majority of users." |
| **L6** | Everything in L5, plus: "I'd also ask whether we need chronological ordering at all — if the feed is ranked, we're not obliged to materialize every post, which changes the fanout problem substantially. And operationally: the threshold is a config value I'd want tunable at runtime, because we'll get it wrong initially and I don't want a deploy to fix it. I'd roll this out behind a flag on 1% of users and compare feed latency and staleness before ramping." |

Note that the L6 answer isn't more technical. It's more *contextual* — it questions the requirement, plans the rollout, and anticipates being wrong.

## Calibrating your own answers

**If you're targeting L5**, force these three habits:

1. After every choice, add "…the alternative would be X, but Y decided it."
2. Before the interviewer finds a flaw, name it yourself.
3. Give a number for every claim about scale.

**If you're targeting L6**, add these three:

4. Question at least one requirement out loud.
5. Describe how you'd roll it out and how you'd roll it back.
6. Mention cost, blast radius, or team boundaries at least once.

:::goat The cheapest level-up
The single highest-leverage upgrade from L4-flavoured to L5-flavoured answers is **saying the alternative you rejected**. It takes eight extra words and it converts a statement into a demonstration of judgment. Most candidates know the alternatives perfectly well and simply don't say them.
:::

## What doesn't move you up

Worth stating plainly, because candidates waste preparation here:

- **Knowing more technologies.** Naming ten databases doesn't beat justifying two.
- **More components in the diagram.** Complexity without justification signals the opposite of seniority.
- **Reciting papers.** Knowing how Raft works matters; reciting it without knowing when *not* to use consensus doesn't.
- **Being fast.** Reaching a design in 15 minutes and then having nothing to add is worse than a considered design at 25.

## A note on down-levelling

If you're interviewing for L6 and perform at L5, many companies will offer L5 rather than reject. That means the downside of aiming high is usually small — but it also means the *specific* L6 behaviours are what you need to demonstrate, and they are largely non-technical: requirement interrogation, rollout planning, cost, and organizational impact.

If you have those instincts from real work, **make them audible.** Interviewers cannot score what you don't say.
