---
title: What Interviewers Actually Score
summary: The rubric behind the whiteboard. Four signals decide the outcome, and knowing the architecture of a real system is only one of them — and not the heaviest.
difficulty: Easy
scope: Both
tags: [interview, rubric, signal]
---

## The thing nobody tells you

Most candidates prepare as if system design were a knowledge test: learn enough architectures, recognize which one applies, reproduce it. Then they produce a technically reasonable design, get rejected, and conclude they needed to memorize more systems.

They needed the opposite. System design interviews are **judgment tests administered through a technical medium.** The interviewer is filling out a rubric, and the rubric is mostly not about whether your design works.

Here is what that rubric looks like at essentially every large company, with the labels changed:

| Signal | Weight | What it measures |
|---|---:|---|
| **Problem navigation** | ~30% | Do you scope, prioritize, and drive — or wait to be led? |
| **Technical depth** | ~30% | When pushed on one component, do you have a floor? |
| **Tradeoff reasoning** | ~25% | Do you justify choices against alternatives and constraints? |
| **Communication** | ~15% | Can a peer follow your design and disagree productively? |

Notice what's missing: "arrived at the correct architecture." There usually isn't one. Two candidates can produce different designs for the same prompt and both get **strong hire**, because the score lives in the reasoning, not the diagram.

## Signal 1 — Problem navigation (~30%)

This is the largest single differentiator, and it is decided in the **first eight minutes**.

The prompt you're given is always underspecified on purpose. "Design Twitter" is not a specification; it's a Rorschach test. What the interviewer is watching:

- Do you ask what scale? (100K users and 500M users are different systems.)
- Do you establish read/write ratio before choosing a storage strategy?
- Do you **cut scope explicitly** — "I'm going to treat DMs, search, and ads as out of scope, and focus on feed generation, which I think is the core difficulty here. Push back if you'd rather I go elsewhere"?
- Do you allocate your own time? "We have 45 minutes; I'd like to spend 10 on requirements and high level, then go deep on fanout."

That last behavior is disproportionately powerful and almost nobody does it. A candidate who manages the clock reads as someone who has run projects.

:::trap The passive candidate
The single most common failure mode: waiting for the interviewer to tell you what to do next. Every "…is that what you want me to do?" costs you. Make a decision, state why, and offer the off-ramp: "I'll assume 100M DAU and read-heavy — sound right?" That's a *decision with a checkpoint*, not a request for permission.
:::

## Signal 2 — Technical depth (~30%)

The interviewer will pick one component and push. And push again. They are looking for your **floor** — the depth at which you stop having real answers.

The exchange usually looks like this:

> "You put a cache in front of the database. What happens when a cache node dies?"
> — "Consistent hashing means only that node's keys are affected, they'd fall through to the DB."
> "All at once?"
> — "Right, that's a thundering herd on those keys. I'd add request coalescing so only one request per key goes to the origin, and stagger TTLs with jitter so keys don't expire in lockstep."
> "How does request coalescing work across many app servers?"
> — "In-process coalescing only helps per-server. Across the fleet you'd need a short-lived distributed lock per key — set a `NX` key in Redis with a 2-second TTL; the winner refills, everyone else serves stale or retries. That trades a bit of staleness for origin protection…"

Three levels deep and still substantive. That's a senior signal. Two levels and then "…I'd have to look into it" is a mid-level signal.

**You cannot be deep everywhere.** Nobody is. The strategy is to pick 4–6 areas and be genuinely deep in them — caching, sharding, queues, consistency, and one storage engine is a good set — and be honest at the boundary elsewhere. "I've not operated Spanner myself; my mental model is TrueTime bounds plus Paxos groups per split, but I'd be guessing past that" scores *better* than confident invention. Interviewers detect bluffing far more reliably than candidates expect, and it's often fatal because it makes every other claim suspect.

## Signal 3 — Tradeoff reasoning (~25%)

Every choice needs three parts: **the choice, the alternative you rejected, and the constraint that decided it.**

Weak: "I'll use Kafka."
Mid: "I'll use Kafka because it's durable and scales."
Strong: "I'll use Kafka. The alternative is calling the downstream service directly, which is simpler, but the write path here is 50K/s spiky and the consumer is a slow batch job — I want the buffer so a consumer slowdown doesn't turn into user-facing 500s. Cost is added operational surface and end-to-end latency going from ~10ms to a few hundred. That's acceptable because this is a notification path, not a read path."

Look at the structure. Choice → alternative → constraint → cost admitted → cost justified against the *product requirement*. That last link is what senior engineers do and juniors skip.

:::goat The tell of a senior candidate
They volunteer the weaknesses of their own design before being asked. "The obvious problem with this is the celebrity fanout — one account with 100M followers generates 100M writes. Let me handle that." Self-critique is read as ownership. Waiting to be caught is read as luck.
:::

## Signal 4 — Communication (~15%)

Small weight, large blast radius — because a design the interviewer can't follow can't be scored on the other three signals.

Practical rules:

- **Draw before you talk.** Boxes and arrows first, narration second. Verbal-only architecture is very hard to follow.
- **Narrate one request end to end.** "A user hits POST /tweet. It lands on the LB, routes to the tweet service, which writes to the DB, publishes to Kafka, and the fanout worker…" This proves the design is coherent, not just a pile of components.
- **Label your arrows.** Sync or async? What protocol? What data? Unlabeled arrows hide all the interesting decisions.
- **Keep a parking lot.** When you notice something you don't want to handle yet, say "parking that, coming back if we have time" and write it in a corner. Then actually come back. It signals control rather than avoidance.

## What actively costs you

In rough order of how often they sink otherwise-fine candidates:

1. **Designing before scoping.** Drawing boxes in minute two.
2. **Buzzword architecture.** Naming technologies without justifying them. "I'll use Kubernetes, Kafka, Redis, Cassandra, and Elasticsearch" before knowing the access pattern is a red flag, not a green one.
3. **Ignoring the interviewer's hints.** "Interesting… what if the writes were much heavier?" is not curiosity. It's a rescue. Take it immediately.
4. **Over-engineering.** Proposing multi-region active-active for a system with 1,000 users. Matching the solution to the scale *is* the skill.
5. **Bluffing.** See above. Fatal and detectable.
6. **Never finishing.** Twelve components, none deep. Better: seven components with two of them genuinely explored.

## What this means for your prep

If navigation and tradeoffs are >50% of the score and neither is knowledge-based, then **reading more architectures has sharply diminishing returns after the first ~10 case studies.** Past that point your time is better spent on:

- Timed practice from a blank page (generation, not recognition).
- Saying it out loud — to a person, a webcam, or an empty room. Fluency is trained separately from knowledge.
- Building depth in a few areas until you can survive three "why?"s in a row.

Next: [The Study Plan](../00-orientation/study-plan.html) turns this into a schedule.
