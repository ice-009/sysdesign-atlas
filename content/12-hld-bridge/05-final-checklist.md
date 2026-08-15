---
title: The Night-Before Checklist
summary: Rapid-fire recall for both rounds — the sequences, the trigger table, the answers to the six questions you're most likely to be asked, and what to do in the first and last two minutes.
difficulty: Easy
scope: Both
tags: [revision, checklist, interview]
prereqs: [hld-refresher, rate-limiter-classes]
unlocks: A last pass that reinforces what you rehearsed instead of adding anything new.
---

Read this the evening before and again in the twenty minutes before the call. Nothing here is new — that's the point. If something on this page doesn't ring a bell, go back to that page for ten minutes, then come back. Do not start anything new tonight.

## The two sequences, from memory

Cover the right column and recite them.

| LLD, 45 minutes | HLD, 45 minutes |
|---|---|
| 0–5 Requirements + scope cut | 0–5 Requirements + scope cut |
| 5–10 Entities (the nouns) | 5–10 Estimation (only what decides something) |
| 10–17 Relationships + lookup structures | 10–15 API + data model + **partition key** |
| 17–27 Interfaces at the axes, service layer, signatures | 15–27 Draw it, narrate one request end to end |
| 27–33 Walk one operation through the objects | 27–40 Two deep dives, properly |
| 33–40 Extension question + concurrency | 40–45 10× bottleneck, failure, monitoring |
| 40–45 Gaps + how you'd test it | |

## The trigger table

| The requirement says | You reach for |
|---|---|
| "different / depending on / configurable" | Strategy behind an interface |
| "create the right kind of X" | Factory (one place that knows the mapping) |
| "notify everyone when Y happens" | Observer — and mention queues at scale |
| "behaves differently while it's in state Z" | State: enum + transition table, or state classes |
| "optional add-ons that combine" | Decorator |
| "undo / schedule / queue an action" | Command |
| "integrate with this third party" | Adapter |
| "exactly one instance" | One instance, injected — not a static `getInstance()` |
| "many optional constructor params" | Builder, validating in `build()` |
| "where does the data come from" | Repository interface, in-memory impl for the interview |

## Six questions you will probably be asked

**"Two threads/users do this at once."**
> Name the shared state. Name the invariant. Then: compare-and-set in memory (`AtomicReference`, `computeIfAbsent`), or a conditional `UPDATE … WHERE status = 'expected'` with a row-count check across servers. Exactly one wins; the loser gets a clean error. Never "I'd synchronise everything".

**"Now add feature X."**
> Where it lands (usually a new strategy implementation) · what does *not* change · and honestly, if it is invasive, exactly which two classes it touches and why.

**"How would you test this?"**
> Constructor injection means unit tests with in-memory fakes and an injected `Clock`. Policy classes tested in isolation. One concurrency test with a `CountDownLatch` releasing N threads at once, asserting exactly one success. Run it thousands of times, because races are probabilistic.

**"What breaks at 10×?"**
> Name one specific component, the limit it hits, and the fix. Cache memory → more nodes with consistent hashing. Single primary writes → shard by key K. Fan-out latency → move it off the queue.

**"Why did you choose that database / that key?"**
> Access pattern first, then the property you need (transactions? scan? scale?), then the tradeoff you accepted. "Point lookups by code, no relationships, 91 TB — so a sharded KV store, and I give up ad-hoc queries."

**"What would you do differently with more time?"**
> Have one real answer ready. Naming your own weakest decision reads as judgement, not weakness.

## Phrases that carry weight

- *"…which means…"* — after every number and every component. Never state a fact without its consequence.
- *"The invariant here is…"* — before any concurrency answer.
- *"That's the axis of variation, so it goes behind an interface."*
- *"I'd start with the simple version and move to X when Y — here's the trigger."*
- *"Let me state my assumption: …"* — whenever you're about to guess.
- *"I could add a factory here, but there's one implementation, so I'd keep it concrete."* — judgement beats pattern-count.

## Things that quietly cost points

- `double` for money. Use minor units in a `long`.
- A subclass per enum value (`Car`, `Bike`, `Truck` differing only by size).
- Getters and setters on everything, with the rules living outside the object.
- An interface with exactly one implementation and no second one coming.
- `synchronized` on every method as the concurrency answer.
- Scanning a collection where a map or a sorted set was obvious.
- Unlabelled arrows on an HLD diagram.
- Estimation arithmetic that changes no decision.
- Silence longer than about ten seconds. Narrate what you're weighing.

## First two minutes, last two minutes

**First two.** Restate the problem in your own words. Ask your three or four clarifying questions. State the scope cut. Announce your plan for the time. That's it — no drawing, no classes, no `new`.

**Last two.** Summarise the design in four sentences. Name the one thing you'd revisit. Name what breaks first under growth. Ask a real question about the team or the system they run — it's the only part of the interview where you get to be curious rather than examined.

## If you go blank

1. Go back to the requirements list and read it out loud. The next step is nearly always written there.
2. Say what you're doing: *"Let me walk the main flow through what I have and find the gap."* Method beats silence.
3. Ask a clarifying question. It's legitimate, it buys thinking time, and it often surfaces the missing constraint.
4. Start from the nouns. Entities → relationships → what varies. That path always produces something.

:::goat The actual bar
They are not looking for the design they'd have drawn. They are hiring someone they'd be comfortable handing an ambiguous problem to. So: scope it, decide, say why, admit what you traded away, and stay easy to talk to for 45 minutes. A confident, complete, medium-sophistication design with clear reasoning beats a clever one you can't finish or defend. Every single time.
:::

Now close the laptop. Sleep is worth more than a fifteenth pattern.
