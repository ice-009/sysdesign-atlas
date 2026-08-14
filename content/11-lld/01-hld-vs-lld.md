---
title: HLD vs LLD — What Each Round Wants
summary: Where the boundary sits, how to tell which round you're in within the first two minutes, and what to do when the interviewer slides from one to the other mid-question.
difficulty: Easy
tags: [interview, framework, hld, lld]
prereqs: [three-day-plan]
unlocks: Recognising which zoom level a question is asking for, and switching between them deliberately.
---

Both rounds say "design X". They score completely different things, and answering at the wrong altitude is the single most common way a prepared candidate loses a round they could have passed.

## The boundary

The line is the **process boundary**.

- **HLD** is about things that talk over a network. If two boxes on your diagram could be in different datacentres, you're doing HLD.
- **LLD** is about things that talk over a method call. If two boxes are in the same address space, sharing memory, you're doing LLD.

Everything else follows from that. Network calls fail partially, arrive out of order, and cost milliseconds — hence retries, idempotency, replication, consistency. Method calls don't fail partially — hence the concerns become coupling, extensibility, and (the one that bites) shared mutable state between threads.

```viz
{
  "type": "stack",
  "caption": "Zoom levels. An SDE-2 loop usually samples the middle two; staff loops push up, machine-coding rounds push down.",
  "layers": [
    { "label": "Product / requirements", "sub": "What are we even building, and for whom" },
    { "label": "HLD · services and stores", "sub": "QPS, partitioning, caching, consistency, failure" },
    { "label": "LLD · classes and interfaces", "sub": "Responsibilities, seams, extension points, concurrency" },
    { "label": "Code · methods and data structures", "sub": "Signatures, invariants, complexity" }
  ]
}
```

## Telling them apart in the first two minutes

| Signal | You're in HLD | You're in LLD |
|---|---|---|
| The prompt | "Design Twitter" | "Design a parking lot" |
| Scale mentioned | "…for 100M users" | Usually absent |
| Whiteboard hint | "Draw the architecture" | "What classes would you have?" |
| Follow-up flavour | "What happens if that region goes down?" | "Now add a new payment type" |
| The interviewer's job title | Often a senior/staff engineer | Often your future teammate |

The tell is the **scale clause**. If the prompt contains a number of users, they want HLD. If the prompt is a physical or bounded system — parking lot, elevator, chess, vending machine, ATM, library — they want LLD, and mentioning sharding will read as evasion.

:::trap "Design a rate limiter" is both
Some prompts sit exactly on the boundary: rate limiter, cache, notification system, logger, task scheduler. Don't guess. Ask one sentence: *"Do you want the class design for this as a library inside a service, or the distributed architecture across a fleet?"* You'll get a straight answer, and asking it is itself a signal of seniority. [Rate Limiter classes](rate-limiter-classes.html) works the same prompt at both levels.
:::

## What gets scored, concretely

**In HLD**, points come from: scoping, back-of-envelope numbers that *change a decision*, a data model with a stated partition key, a request walked end to end, two genuine deep dives, and naming your bottleneck at 10× traffic. Depth beats breadth — one deep dive done properly outweighs six components listed.

**In LLD**, points come from: the entity list, correct relationships (has-a vs is-a), interfaces at the points where variation actually exists, method signatures that read well, a walkthrough of one operation through your objects, thread safety, and how cleanly a new requirement lands. Extensibility beats completeness — a small design that absorbs change beats a large one that enumerates today's features.

:::interview The altitude sentence
Whichever round you're in, say the altitude out loud in your first minute. *"I'll design this as a single service's class model — I'll assume it runs on one node, and I'll flag where that assumption breaks."* Now you and the interviewer are looking at the same picture, and if it's the wrong one they'll correct you at minute two instead of minute thirty.
:::

## When they slide from one to the other

This is common in SDE-2 loops and it catches people out. You've spent 25 minutes on an HLD for a notification system and the interviewer says: *"Let's zoom into the delivery service. What does the code look like?"*

That is not a new question. It's a **request to go one level down on a box you already drew**. Handle it in three moves:

1. **Name the box.** "So this is the worker that pulls from the queue and delivers to a channel."
2. **Restate its contract.** "It takes a `Notification`, picks a channel, sends, and reports the result." That contract is the class you're about to design.
3. **Find the variation.** Channels differ (email, SMS, push) — so `Channel` is an interface and the worker depends on it. Retry policy differs per channel — so that's a strategy too.

Every zoom-in is the same three moves: name the box, state its contract, find the axis of variation. The reverse direction — LLD to HLD — is rarer, and the move is: "if I run many of these, what state is shared, and where does it live?"

```viz
{
  "type": "flow",
  "caption": "The zoom-in move. The box you drew in HLD becomes the class diagram in LLD.",
  "nodes": [
    { "id": "svc", "label": "Delivery svc", "sub": "one HLD box" },
    { "id": "contract", "label": "Its contract", "sub": "send(Notification)" },
    { "id": "vary", "label": "What varies?", "sub": "channel, retry, format" },
    { "id": "cls", "label": "Interfaces", "sub": "Channel, RetryPolicy" }
  ],
  "edges": [
    { "from": "svc", "to": "contract" },
    { "from": "contract", "to": "vary" },
    { "from": "vary", "to": "cls" }
  ]
}
```

## The shared vocabulary

A few words carry weight in both rounds, and using them precisely is free credibility:

- **Idempotent** — running it twice has the same effect as once. In HLD it's about retried network calls; in LLD it's about a method you can safely call again after a partial failure. Same word, same discipline.
- **Contract** — what a component promises regardless of how it's built. A REST endpoint in HLD, an interface in LLD.
- **Coupling** — how much a change over here forces a change over there. Services coupled by a synchronous call in HLD; classes coupled by `new` in LLD.
- **Single writer** — the cheapest way to avoid a race, at both levels. One partition owner in HLD; one thread or one lock owner in LLD.

:::goat Why the same ideas keep appearing
HLD and LLD aren't different subjects. They're the same subject — *managing dependency and change* — applied at different distances. Sharding is partitioning state so writers don't collide. So is giving each thread its own object. Interfaces are contracts so callers survive a swap. So are versioned APIs. Once you see that, the two rounds stop feeling like two syllabi and you can carry an argument across the boundary, which is exactly what senior candidates sound like.
:::
