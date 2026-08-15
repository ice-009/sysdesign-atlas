---
title: The Three-Day Revision Plan
summary: What an SDE-2 interview asks for, in plain terms, and an hour-by-hour plan for the two or three days you have left.
difficulty: Easy
scope: Both
tags: [orientation, revision, interview, sde2]
unlocks: A schedule for the days before the interview, and a clear picture of what each round is scored on.
---

Two terms come up constantly here, so let's fix them first.

**HLD** is high-level design. You draw boxes — a web server, a database, a cache — and explain how they talk to each other over the network. The question sounds like *"design Twitter for 100 million users"*.

**LLD** is low-level design. You stay inside one program and design the *classes*: what objects exist, what each one does, and how they fit together. The question sounds like *"design a parking lot"*.

Same skill, different zoom level. This track is the LLD half; the [HLD Bridge](../12-hld-bridge/hld-vs-lld.html) track next door covers the other half and the overlap.

## What the interviewer is actually grading

You have two or three days. That is not enough time to *learn* design. It is plenty of time to *revise* it.

The thing that separates a pass from a fail is rarely knowledge. It is whether you can produce a complete, sensible answer in 45 minutes while saying why you chose each thing. Here is the difference in practice:

| | A weaker answer | The answer that passes |
|---|---|---|
| Requirements | Starts drawing straight away | Asks a few questions first, says what's out of scope |
| Structure | One huge class, or one huge box | A few pieces, each with one clear job |
| Choices | "I'll use Redis" | "Redis, because reads are 100× writes and slightly stale data is fine" |
| New feature | Rewrites things | Adds a class |
| Failure | Never mentions it | Says what breaks and what happens next |
| Threads | Ignored | Says which data is shared and how it's protected |

Nobody expects a brilliant new architecture. They want a calm, complete, ordinary-but-well-argued design.

:::goat The one habit worth building
Every point you score comes from **a decision plus the reason for it**. Five components you can justify beat ten you can't. When you're unsure, slow down and explain why.
:::

## The two zoom levels, side by side

```viz
{
  "type": "compare",
  "caption": "Most SDE-2 loops test both, sometimes in the same hour.",
  "left": {
    "title": "HLD — between programs",
    "items": [
      "Boxes are servers, databases, caches, queues",
      "You talk about traffic, storage and delay",
      "You produce an architecture diagram",
      "Failure means a machine dies",
      "\"Split the data by user, cache the reads\""
    ]
  },
  "right": {
    "title": "LLD — inside one program",
    "items": [
      "Boxes are classes and their methods",
      "You talk about responsibilities and change",
      "You produce a class diagram",
      "Failure means two threads clash",
      "\"Pricing is an interface, so a new rule is a new class\""
    ]
  }
}
```

The most common mistake is answering at the wrong level: estimating traffic in an LLD round, or drawing class diagrams in an HLD round. [HLD vs LLD](../12-hld-bridge/hld-vs-lld.html) shows you how to tell which one you're in within the first two minutes.

## The plan

Times are a guide. If you only have two days, drop Day 2 and fold its problems into Day 3.

### Day 1 — the vocabulary (about 4 hours)

You can't design classes fluently without the words for it. Get them back first.

| | Topic | Why now |
|---|---|---|
| 60 min | [Objects, in practice](oop-refresher.html) | What an object is *for*, and when to use an interface |
| 45 min | [SOLID, in plain English](solid.html) | The five ideas you'll narrate your design with |
| 75 min | [The patterns worth knowing](design-patterns.html) | Strategy, factory, observer, state — most of what appears |
| 45 min | [The LLD method](lld-interview-method.html) | What to do minute by minute |
| 30 min | [HLD refresher](../12-hld-bridge/hld-refresher.html), first half | Keep the other muscle warm |

Before you stop: without looking, write down the six steps of the LLD method, and the five SOLID letters with one example each. If you can't, redo the last hour instead of moving on.

### Day 2 — problems, out loud (about 4 hours)

Solving them isn't the point. **Producing an answer under time pressure** is. Set a 40-minute timer per problem. Talk out loud. Draw the classes on paper before you read the solution.

| | Problem | What it teaches |
|---|---|---|
| 40 min | [Parking Lot](parking-lot.html) | The standard way to break a problem into classes |
| 40 min | [Elevator System](elevator-system.html) | Objects whose behaviour depends on their current state |
| 40 min | [Splitwise](splitwise.html) | Handling money and splitting it exactly |
| 30 min | [Threads and races](concurrency-in-lld.html) | The follow-up question you will definitely get |
| 45 min | [HLD refresher](../12-hld-bridge/hld-refresher.html), second half | Components and the choices between them |

### Day 3 — the overlap, then taper (about 3 hours)

| | Topic | Why last |
|---|---|---|
| 40 min | [Seat Booking](../12-hld-bridge/seat-booking.html) | One problem asked at both levels |
| 30 min | [In-memory cache](lru-cache.html) | A data-structure flavoured question, very common |
| 30 min | [Rate limiter](../12-hld-bridge/rate-limiter-classes.html) | The same problem, both zoom levels |
| 45 min | Re-solve **one** Day-2 problem from scratch | Proves you can recall it, not just recognise it |
| 30 min | [The final checklist](../12-hld-bridge/final-checklist.html) | Quick recall, then stop |

:::warn Stop the night before
Spend the last two hours on the [checklist](../12-hld-bridge/final-checklist.html) and nothing else. New material the night before doesn't stick, and it pushes out what you already rehearsed. Sleep is the better investment.
:::

## Three rules for practising

They cost nothing and almost everyone ignores them.

1. **Say it out loud.** Understanding something and explaining it in order to a stranger are different skills. Only speaking closes the gap. Talk to a wall if you have to.
2. **Draw before you read.** Look at the problem, close the page, spend ten minutes on your own class diagram, *then* compare. Reading solutions teaches you to recognise them. Drawing teaches you to produce them, which is what the interview asks for.
3. **Use a timer.** Every problem here is written to be answerable in 40 minutes. If you take 70, you're practising something you can't use on the day.

:::exercise A two-minute warm-up
Pick an app you use daily — food delivery, a music player, a library catalogue. Spend five minutes listing its nouns (those become your classes). Then five minutes marking which ones obviously come in several varieties (those become your interfaces). That small exercise is the LLD interview in miniature.
:::

## If you've already read the rest of this course

The HLD material in the [Bridge](../12-hld-bridge/hld-refresher.html) track is a compressed version of [Foundations](../fundamentals/scalability-basics.html), [Building Blocks](../building-blocks/load-balancing.html) and the [Appendix](../appendix/framework.html). If you know those, skim it and put the time into the LLD problems instead — that's the side most SDE-2 candidates under-prepare.
