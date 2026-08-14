---
title: The Three-Day Revision Plan
summary: What an SDE-2 interview actually asks for, and an hour-by-hour plan for the two or three days you have left — LLD in the mornings, HLD refresher in the evenings.
difficulty: Easy
tags: [orientation, revision, interview, sde2]
unlocks: A concrete schedule for the days before the interview, and a clear picture of what each round is scored on.
---

You have two or three days. That is not enough time to learn design, and it is more than enough time to revise it. The failure mode this week is not ignorance — it is **breadth panic**: reading forty topics shallowly, recognising everything, being able to produce nothing under time pressure.

This section is built for the opposite. A small number of things, practised until they come out in order without thinking.

## What the SDE-2 bar actually is

The distinction that matters between an SDE-1 and an SDE-2 answer is not the number of components on the whiteboard. It's this:

| | SDE-1 answer | SDE-2 answer |
|---|---|---|
| Requirements | Starts coding/drawing immediately | Scopes first, states what is out |
| Structure | One giant class, or one giant box | Named responsibilities with clear seams |
| Choices | "I'll use Redis" | "Redis, because the read path is 100:1 and staleness of a few seconds is fine" |
| Extension | Rewrites when the requirement changes | Adds a class / adds a consumer |
| Failure | Doesn't come up | Names what breaks and what happens then |
| Concurrency | Ignored | Named the shared state and how it's guarded |

Nobody expects novel architecture from you. They expect a **competent, complete, defensible** design produced calmly in 45 minutes, with the tradeoffs said out loud.

:::goat The one sentence to internalise
Every point you score comes from a **decision plus its reason**. A design with ten components and no reasons scores below a design with five components where you said why each one is there and what you gave up. When in doubt, slow down and justify.
:::

## LLD vs HLD in one picture

```viz
{
  "type": "compare",
  "caption": "Same system, two zoom levels. Most SDE-2 loops test both, sometimes in the same hour.",
  "left": {
    "title": "HLD — between processes",
    "items": [
      "Boxes are services, caches, queues, stores",
      "Currency: QPS, latency, storage, consistency",
      "Output: architecture diagram + data model",
      "Failure = a machine or region dies",
      "\"Shard by user_id, cache the read path\""
    ]
  },
  "right": {
    "title": "LLD — inside one process",
    "items": [
      "Boxes are classes, interfaces, methods",
      "Currency: responsibilities, coupling, extensibility",
      "Output: class diagram + key method signatures",
      "Failure = a race, or a change that touches 9 files",
      "\"Strategy for pricing, so a new rule is a new class\""
    ]
  }
}
```

The two rounds reward different instincts, and the most common mistake is bringing the wrong one: estimating QPS in an LLD round (nobody asked), or drawing class diagrams in an HLD round (you'll run out of time). [HLD vs LLD](hld-vs-lld.html) draws the boundary precisely.

## The plan

Times are indicative. If you only have two days, drop Day 2 and merge its problems into Day 3.

### Day 1 — the toolkit (≈4 hours)

You cannot design classes fluently without the vocabulary. Get it back into working memory first.

| | Topic | Why now |
|---|---|---|
| 60 min | [OOP for interviews](oop-refresher.html) | Composition, interfaces, and what an object is *for* |
| 45 min | [SOLID, practically](solid.html) | The language you'll narrate your design in |
| 75 min | [The patterns worth knowing](design-patterns.html) | Strategy, factory, observer, state — 80% of what appears |
| 45 min | [The LLD method](lld-interview-method.html) | The minute-by-minute structure |
| 30 min | [HLD refresher](hld-refresher.html), first half | Keep the other muscle warm |

End of day: without notes, write down the six steps of the LLD method and the five SOLID letters with a one-line example each. If you can't, redo the last hour rather than moving on.

### Day 2 — problems, out loud (≈4 hours)

Solving is not the point; **producing an answer under time pressure** is. Set a 40-minute timer per problem, talk out loud, write the class diagram on paper before you look at the solution.

| | Problem | Teaches |
|---|---|---|
| 40 min | [Parking Lot](parking-lot.html) | The canonical entity/strategy decomposition |
| 40 min | [Elevator System](elevator-system.html) | State machines and scheduling policy |
| 40 min | [Splitwise](splitwise.html) | Modelling money, splits, and settlement |
| 30 min | [Concurrency in LLD](concurrency-in-lld.html) | The follow-up question you will definitely get |
| 45 min | [HLD refresher](hld-refresher.html), second half | Building blocks and the decision table |

### Day 3 — the bridge, then taper (≈3 hours)

| | Topic | Why last |
|---|---|---|
| 40 min | [Seat Booking](seat-booking.html) | LLD and HLD in one problem — locking, holds, payment |
| 30 min | [In-Memory Cache](lru-cache.html) | Data-structure-flavoured LLD, very common |
| 30 min | [Rate Limiter classes](rate-limiter-classes.html) | Same problem at both zoom levels |
| 45 min | Re-solve **one** Day-2 problem from scratch | Proves it's in muscle memory, not recognition |
| 30 min | [The final checklist](final-checklist.html) | Rapid-fire recall, then stop |

:::warn Stop the night before
The last two hours before sleep should be the [checklist](final-checklist.html) and nothing else. New material the night before does not land, and it displaces the things you actually rehearsed. Sleep is a better use of the time than a fourteenth pattern.
:::

## How to practise so it sticks

Three rules, all of which cost you nothing and are routinely ignored:

1. **Say it out loud.** The gap between "I understand this" and "I can explain this in sequence to a stranger" is enormous, and it only closes by speaking. Talk to a wall if you have to.
2. **Draw before you read.** Look at the problem statement, close the page, spend ten minutes producing your own class diagram, *then* compare. Reading solutions builds recognition; producing them builds recall. Only recall shows up in the interview.
3. **Time everything.** Every problem here is written to be answerable in 40 minutes. If you take 70, you are practising a skill you cannot use.

:::exercise Before you go on
Pick any system you use daily — a food delivery app, a music player, a library catalogue. Spend five minutes listing its nouns (entities), then five minutes listing the ones that would need an interface because there's obviously more than one variant. That warm-up *is* the LLD interview in miniature.
:::

## If you have already done the rest of this course

The HLD material in this section is deliberately a compression of [Foundations](../fundamentals/scalability-basics.html), [Building Blocks](../building-blocks/load-balancing.html), and the [Appendix](../appendix/framework.html). If you've read those, skim [the HLD refresher](hld-refresher.html) and spend the reclaimed time on the LLD problems — that's the side most SDE-2 candidates under-prepare.
