---
title: The Night-Before Checklist
summary: Quick recall for both rounds — the two running orders, the trigger table, answers to the six questions you're most likely to get, and what to do in the first and last two minutes.
difficulty: Easy
scope: Both
tags: [revision, checklist, interview]
prereqs: [hld-refresher, rate-limiter-classes]
unlocks: A last pass that reinforces what you rehearsed instead of adding anything new.
---

:::predict Guess first
1. The night before an interview, is learning one more design pattern a good use of the evening?
2. You go blank in the middle of a round. What could you say in the next ten seconds?
3. What do you think the interviewer is ultimately deciding?
:::

Read this the evening before, and again in the twenty minutes before the call. Nothing here is new — that's the point. If something doesn't ring a bell, go back to that page for ten minutes and come back. Don't start anything new tonight.

## The two running orders

Cover the right column and say them out loud.

| LLD, 45 minutes | HLD, 45 minutes |
|---|---|
| 0–5 Requirements, and what's out of scope | 0–5 Requirements, and what's out of scope |
| 5–10 The classes (the nouns) | 5–10 Estimation — only what decides something |
| 10–17 Relationships and lookup structures | 10–15 API, data, and how it's split |
| 17–27 Interfaces where things vary, plus the service class | 15–27 Draw it, then follow one request through |
| 27–33 Walk one operation through the objects | 27–40 Two deep dives, properly |
| 33–40 "Now add a feature", then threads | 40–45 What breaks at 10×, failure, monitoring |
| 40–45 Gaps, and how you'd test it | |

## The trigger table

| The requirement says | Reach for |
|---|---|
| "different / depending on / configurable" | A strategy behind an interface |
| "create the right kind of X" | A factory — one place knows the mapping |
| "tell everyone when Y happens" | Observer — and mention queues at scale |
| "behaves differently while it's in state Z" | A state machine: enum plus a table of legal moves |
| "optional extras that combine" | Decorator |
| "undo / schedule / queue an action" | Command |
| "also support this other provider" | Adapter |
| "there must be exactly one" | One instance, passed in — not a static `getInstance()` |
| "lots of optional settings" | Builder, validating in `build()` |
| "where does the data come from" | A repository interface, in-memory for the interview |

## Six questions you'll probably get

**"Two users do this at the same time."**
> Name the shared data. Name the rule a clash would break. Then: compare-and-set in memory, or `UPDATE … WHERE status = 'expected'` with a row-count check across servers. Exactly one wins; the loser gets a clean error. Never "I'd just synchronise it".

**"Now add feature X."**
> Where it lands (usually a new strategy) · what does *not* change · and if it is invasive, exactly which two classes it touches and why.

**"How would you test this?"**
> Constructor injection means unit tests with in-memory fakes and a clock you control. Policy classes tested on their own. One threading test with N threads released together, asserting exactly one success — run thousands of times, because races are probabilistic.

**"What breaks at ten times the traffic?"**
> Name one specific component, the limit it hits, and the fix. Cache memory → more nodes. One database taking all writes → split by key. Slow fan-out → move it onto a queue.

**"Why that database, or that split key?"**
> How you read the data first, then the property you need, then what you gave up. "Lookups by one key, no relationships, 91 TB — so a key-value store split by hash, and I give up flexible queries."

**"What would you do differently with more time?"**
> Have one real answer ready. Naming your own weakest decision reads as judgement.

## Phrases that carry weight

- *"…which means…"* — after every number and every component. Never state a fact without its consequence.
- *"The rule that must hold here is…"* — before any threading answer.
- *"That's the thing most likely to change, so it goes behind an interface."*
- *"I'd start simple and move to X when Y happens — here's the trigger."*
- *"Let me state my assumption:…"* — whenever you're about to guess.
- *"I could add a factory here, but there's only one implementation, so I'd keep it simple."*

## Things that quietly cost points

- `double` for money. Use whole paise in a `long`.
- A subclass per enum value (`Car`, `Bike`, `Truck` differing only by size).
- Getters and setters on everything, with the rules living outside the class.
- An interface with one implementation and no second one coming.
- `synchronized` on every method as the threading answer.
- Scanning a list where a map or a sorted set was obvious.
- Unlabelled arrows on a diagram.
- Arithmetic that changes no decision.
- Silence longer than about ten seconds. Say what you're weighing.

## First two minutes, last two minutes

**First two.** Say the problem back in your own words. Ask your three or four questions. State what you're leaving out. Say how you'll use the time. No drawing, no classes yet.

**Last two.** Summarise the design in four sentences. Name the one thing you'd revisit. Name what breaks first as it grows. Then ask a real question about their team or their system — it's the only part of the hour where you get to be curious rather than examined.

## If you go blank

1. Reread the requirements out loud. The next step is almost always written there.
2. Say what you're doing: *"Let me walk the main flow through what I have and find the gap."* Method beats silence.
3. Ask a clarifying question. It's legitimate, it buys thinking time, and it often surfaces the constraint you were missing.
4. Go back to the nouns. Classes → relationships → what varies. That path always produces something.

:::goat The actual bar
They are not looking for the design they would have drawn. They're deciding whether they'd be comfortable handing you a vague problem and walking away.

So: scope it, decide, say why, admit what you traded away, and be easy to talk to for 45 minutes. A confident, complete, ordinary design you can defend beats a clever one you can't finish. Every time.
:::

Now close the laptop. Sleep is worth more than a fifteenth pattern.

## Check yourself

```recall
Q: What does the trigger table map?
A: Requirement phrases to tools: "different" → strategy, "create the right kind" → factory, "tell everyone" → observer, "behaves differently in a state" → state machine, "undo" → command, "another provider" → adapter.

Q: How do you answer "two users do this at the same time"?
A: Name the shared data and the rule a clash breaks, then a compare-and-set in memory or UPDATE … WHERE status = expected across servers. Exactly one wins; the loser gets a clean error.

Q: How do you answer "how would you test this?"
A: Constructor injection gives in-memory fakes and a controllable clock; test policies on their own; one threading test releasing N threads together, run thousands of times.

Q: Name four things that quietly cost points.
A: Money as double, a subclass per enum value, getters and setters with rules outside the class, one-implementation interfaces, blanket synchronized, scanning where a map was obvious, unlabelled arrows, pointless arithmetic, long silences.

Q: What belongs in the first and last two minutes?
A: First: restate the problem, ask three or four questions, state what's out, say how you'll use the time. Last: summarise in four sentences, name what you'd revisit and what breaks first, then ask them a real question.

Q: What do you do if you go blank?
A: Reread the requirements aloud, narrate ("let me walk the main flow and find the gap"), ask a clarifying question, or go back to nouns → relationships → what varies.
```

## What to carry forward

- Nothing new the night before — recall, then sleep.
- Know both running orders and the trigger table cold.
- Have short answers ready for races, new features, testing, 10× growth, choices and hindsight.
- The bar is "could we hand them a vague problem?" — scope, decide, justify, admit trade-offs.
