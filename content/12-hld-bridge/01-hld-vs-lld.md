---
title: HLD vs LLD — Telling the Rounds Apart
summary: Where the line between the two sits, how to work out which round you're in within two minutes, and what to do when the interviewer moves from one to the other mid-question.
difficulty: Easy
scope: Both
tags: [interview, framework, hld, lld]
prereqs: [three-day-plan]
unlocks: Recognising which zoom level a question wants, and switching on purpose rather than by accident.
---

Both rounds open with the same three words: "design a something". They score completely different things. Answering at the wrong level is the most common way a prepared candidate loses a round they could have passed.

## The line is the program boundary

Here's the whole distinction in one rule.

- **HLD** covers things that talk to each other **over a network**. If two boxes in your drawing could sit in different buildings, you're doing HLD.
- **LLD** covers things that talk to each other **inside one running program**, by calling methods. Same memory, same process.

Everything else follows from that one difference. Network messages can get lost, arrive late, or arrive twice — so HLD worries about retries, copies of data, and what happens when a machine dies. Method calls don't get lost — so LLD worries about different things: keeping classes easy to change, and stopping two threads from corrupting shared data.

```viz
{
  "type": "stack",
  "caption": "Zoom levels. An SDE-2 loop usually samples the middle two.",
  "layers": [
    { "label": "Product", "sub": "What are we building, and for whom" },
    { "label": "HLD · servers and databases", "sub": "Traffic, storage, delay, what happens when it breaks" },
    { "label": "LLD · classes and interfaces", "sub": "Jobs, boundaries, extension, threads" },
    { "label": "Code · methods and data structures", "sub": "Signatures, rules, speed" }
  ]
}
```

## Working out which one you're in

| Clue | It's HLD | It's LLD |
|---|---|---|
| The question | "Design Twitter" | "Design a parking lot" |
| Scale mentioned? | "…for 100 million users" | Usually not mentioned |
| What they ask you to draw | "Draw the architecture" | "What classes would you have?" |
| The follow-up | "What if that whole region goes down?" | "Now add a new payment type" |
| Who's interviewing | Often a senior engineer | Often your future teammate |

The strongest clue is **a number of users**. If the question mentions scale, they want HLD. If it's a bounded physical thing — parking lot, lift, chess, vending machine, ATM, library — they want LLD, and talking about splitting the database will look like avoidance.

:::trap Some questions are deliberately both
A few sit exactly on the line: rate limiter, cache, notification system, logger, task scheduler.

Don't guess. Ask one sentence: *"Would you like the class design for this as a library inside one service, or the distributed architecture across a fleet of servers?"* You'll get a straight answer, and asking is itself a mark of seniority. [Rate Limiter](rate-limiter-classes.html) works the same question at both levels.
:::

## What earns points in each

**In HLD:** scoping the problem, doing arithmetic that actually changes a decision, a data model with a stated rule for splitting the data, walking one request end to end, two proper deep dives, and naming what breaks first at ten times the traffic. Depth beats breadth — one component explained properly outweighs six merely listed.

**In LLD:** listing the entities, getting the relationships right (has-a versus is-a), putting interfaces where things genuinely vary, method signatures that read well, walking one operation through your objects, thread safety, and how cleanly a new requirement lands. Here, ability to absorb change beats completeness — a small design that bends beats a big one that lists every feature of today.

:::interview Say the altitude out loud
Whichever round you're in, state your zoom level in the first minute: *"I'll design this as the class model for a single service. I'll assume one machine to start with, and I'll flag where that assumption breaks."*

Now you and the interviewer are looking at the same picture. If it's the wrong one, they'll correct you at minute two rather than minute thirty.
:::

## When they move from one to the other

This happens constantly in SDE-2 loops and it catches people out. You've spent 25 minutes on the architecture of a notification system, and the interviewer says: *"Let's zoom into the delivery service. What does the code look like?"*

That is not a new question. It's an invitation to go one level down **on a box you already drew**. Three moves:

1. **Name the box.** "This is the worker that takes jobs off the queue and delivers them."
2. **State what it promises.** "It takes a notification, picks a channel, sends it, reports the result." That promise is the class you're about to design.
3. **Find what varies.** Channels differ (email, SMS, push) — so `Channel` is an interface. Retry rules differ per channel — so that's another one.

Every zoom-in is those same three moves. Going the other way is rarer; the move there is: "if I run many copies of this, what data is shared, and where does it live?"

```viz
{
  "type": "flow",
  "caption": "Zooming in: the box you drew becomes the classes you design.",
  "nodes": [
    { "id": "svc", "label": "Delivery svc", "sub": "one box in HLD" },
    { "id": "contract", "label": "What it promises", "sub": "send(Notification)" },
    { "id": "vary", "label": "What varies?", "sub": "channel, retries, format" },
    { "id": "cls", "label": "Interfaces", "sub": "Channel, RetryPolicy" }
  ],
  "edges": [
    { "from": "svc", "to": "contract" },
    { "from": "contract", "to": "vary" },
    { "from": "vary", "to": "cls" }
  ]
}
```

## Words that mean the same thing at both levels

Using these precisely is free credibility.

- **Idempotent** — doing it twice has the same effect as doing it once. In HLD that's about a network call being retried; in LLD it's about a method that's safe to call again after a half-finished attempt.
- **Contract** — what something promises, regardless of how it's built. An API endpoint in HLD, an interface in LLD.
- **Coupling** — how much changing this forces you to change that. Services joined by a direct call in HLD; classes joined by `new` in LLD.
- **Single writer** — the cheapest way to avoid two things clashing, at either level. One server owning a slice of data in HLD; one thread owning an object in LLD.

:::goat Why the same ideas keep coming back
HLD and LLD aren't two subjects. They're one subject — *keeping things independent so they can change* — seen from two distances.

Splitting a database by user is separating data so writers don't collide. Giving each thread its own object is the same move. Interfaces let you swap an implementation without touching callers; versioned APIs do that across a network. Once you see it, the two rounds stop feeling like two syllabuses, and you can carry an argument across the boundary — which is exactly what senior candidates sound like.
:::
