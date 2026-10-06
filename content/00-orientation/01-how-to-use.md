---
title: How to Use This Atlas
summary: A map of the whole curriculum, how the four groups depend on each other, and the reading habit that decides whether any of it sticks.
difficulty: Easy
scope: Core
tags: [orientation, meta]
unlocks: A route through the material that matches what you're actually trying to do.
---

:::predict Guess first
1. Is it better to read a finished design first, or to try designing it yourself before reading?
2. Should you be able to read the AI infrastructure material without the core systems material?
3. What do you think makes a choice like "I'll use Cassandra" strong or weak?
:::

## What this is

A curriculum for understanding how large systems actually work — from the physics of the hardware up through distributed correctness, storage internals, and the AI infrastructure now sitting underneath a growing share of production systems.

It is built to be **learned**, not skimmed. Everything is open; there is no locked tier and no account required to read. None of this is secret — it lives in papers, engineering blogs, and conference talks. What's scarce is a coherent path through it, which is what this is trying to be.

Interview-specific advice exists, but it's confined to an [appendix](../10-appendix/what-interviewers-score.html) at the end. That placement is deliberate. Studying for an interview and understanding a subject are different activities, and organising the second around the first produces people who can recite "use consistent hashing for the cache tier" without being able to say what happens when a node joins.

## The four groups

```viz
{
  "type": "steps",
  "caption": "Later groups genuinely depend on earlier ones. The order is not decorative.",
  "steps": [
    { "label": "Core Systems", "sub": "the physics, the components, the failure modes", "accent": "#22d3ee" },
    { "label": "AI Systems", "sub": "the same reasoning with GPU memory as the scarce resource", "accent": "#c084fc" },
    { "label": "Applied Design", "sub": "whole systems, end to end", "accent": "#34d399" },
    { "label": "Appendix", "sub": "optional — interviews", "accent": "#94a3b8" }
  ]
}
```

| Group | Tracks | What it gives you |
|---|---|---|
| **Core Systems** | Orientation, Foundations, Building Blocks, Distributed Systems, Data & Storage | Why anything costs what it costs, the components you assemble, how correctness survives failure, and what happens beneath a query |
| **AI Systems** | AI Foundations, AI Infrastructure, Applied AI Systems | How models run as systems: tokens and attention, GPUs and interconnects, training and serving at scale, then retrieval, agents, and evaluation |
| **Applied Design** | Case Studies, Guided Builds, Low-Level Design, HLD Bridge | Complete designs — presented finished, or constructed phase by phase — plus the class-level half of design, and the topics that span both altitudes |
| **Appendix** | Interviews | The framework, rubrics, mock transcript, question bank |

**The AI group is not a bolt-on.** Its central claim is that inference serving is a queueing problem, KV cache management is a caching problem, distributed training is a coordination problem, and vector search is an indexing problem. If you have done the Core group properly, most of the AI material arrives as "oh — it's that idea again, with different constants." If you skip Core and start there, it will feel like a pile of unrelated jargon.

## Prerequisites, and what they're for

Every topic declares what it assumes. At the top of each page you'll see one of two states:

- **Not ready yet** — the concepts this page builds on, each linked, with a check against the ones you've marked complete.
- **Ready** — everything it assumes is done, so the page should land as *"of course, that follows"* rather than *"where did that come from?"*

:::note It guides, it never locks
Nothing is gated. Read anything in any order. The graph exists because these pages genuinely assume things — a page that says "shard on conversation ID" only makes sense if [sharding](../02-building-blocks/sharding.html) is already in your head.

Reading unprepared produces recognition. Reading prepared produces understanding. If you're short on time, read anyway and backfill the gaps the page exposes — that's a legitimate strategy, just a slower one per unit of retention.
:::

Mark a page complete with the button on it. That's what feeds the readiness check, and it's stored against your account so it follows you across devices.

## Three ways to run this

### Depth-first — "I want to actually understand systems"

The intended path. Read Core Systems in order, then choose: AI Systems if that's where you're heading, Applied Design if you want to consolidate first. Either order works; both is better.

The one change that matters: **for every case study and build, write your own design before reading the page.** Twenty minutes, on paper, timeboxed. Then read and diff.

:::goat Why the diff is the whole exercise
Reading a finished design produces *recognition* — "yes, that makes sense." Designing produces *generation* — building the thing from nothing. These are different skills, stored differently, and only one of them is what you actually do at work.

Recognition is nearly free to acquire and nearly worthless on its own. An hour spent generating is worth several spent reading. The gap between your sketch and the written design is your real curriculum; everything you got right is review.
:::

### Problem-first — "I'm building something specific"

Start from the [case study](../08-case-studies/url-shortener.html) or [build](../09-builds/pastebin.html) nearest your problem and follow prerequisite links backwards whenever something doesn't make sense. You'll cover less ground and retain more of it, because every concept arrives attached to a problem you actually have.

The builds are especially suited to this: each starts from the simplest version that works and states the concrete number at which it breaks. Stop at the phase matching your real scale. Most products never need phase four, and building it anyway is the most common form of wasted engineering.

### Interview-first — "my loop is in three weeks"

Read the [appendix](../10-appendix/framework.html) first, then work through case studies, backfilling concepts only when one exposes a gap. This is the least effective way to use this material and the correct choice when you have three weeks. There's no point pretending otherwise.

## How pages are structured

**Every topic** opens with a *Guess first* box — two or three questions to answer before reading — and ends with *Check yourself* recall cards and a short *What to carry forward*. The [next page](how-to-study.html) explains why: guessing first and testing yourself afterwards are the two cheapest ways to make reading stick, and on the iPad edition the cards feed a spaced-review deck.

**Concept pages** open with the problem the concept exists to solve, then the mechanism — *why* it works, not just what it does — then the tradeoffs, then when it's the wrong choice. Where a number is asserted, the arithmetic behind it is shown.

**Case studies** present a finished design: requirements, estimation, API and data model, high-level design, deep dives, failure modes.

**Guided builds** construct the same kind of system in phases, each transition triggered by a concrete number that broke the previous version.

You'll see recurring callouts:

:::derive Derivation
The arithmetic worked out in full, so you can check the claim rather than trust it.
:::

:::goat The deeper point
The insight underneath the mechanism — usually the thing that connects it to something else in the atlas.
:::

:::trap Common misconception
A belief that is widespread, plausible-sounding, and wrong in a way that matters.
:::

:::paper Primary source
Where the idea comes from, so you can read the original.
:::

:::exercise Work it out
Something to do rather than read. These are the highest-value part of any page.
:::

## The habit that matters

**Always state the tradeoff, not just the choice.**

"I'll use Cassandra" is a weak position even when Cassandra is correct. "I'll use Cassandra — the access pattern is write-heavy with a known partition key, and I can accept eventual consistency on the read path because a stale like count for 200 ms is harmless; if I needed read-your-writes here I'd reconsider" is a strong position even if the conclusion turns out wrong.

The difference isn't presentation. A choice without its tradeoff is a memorised association, and it doesn't transfer to the next problem. A choice with its tradeoff is a piece of reasoning you can rerun when the constraints change — which they always do.

## Scope

This covers distributed systems design, AI infrastructure, and — in its own track — low-level, class-level design. It deliberately does not cover coding practice or behavioural interviews; those are separate skills. Algorithm practice is the one place the atlas points outside itself, to LeetCode, from the HLD and LLD plan.

Next: [How to Study Systems](how-to-study.html) — the reading and practice habits that make the rest of this stick.

## Check yourself

```recall
Q: What are the atlas's four groups?
A: Core Systems (foundations, building blocks, distributed, data), AI Systems (AI foundations, infrastructure, applied), Applied Design (case studies, builds, LLD, HLD bridge) and the optional interview Appendix.

Q: Why isn't the AI group a bolt-on?
A: It reuses core ideas with GPUs as the scarce resource: serving is queueing, the KV cache is caching, training is coordination, vector search is indexing. Without Core it reads as jargon.

Q: What do the readiness banners do?
A: They show which prerequisites a page assumes and which you've completed. Nothing is locked — reading unprepared gives recognition, prepared gives understanding.

Q: What are the three ways to run the atlas?
A: Depth-first (Core in order, then AI or Applied), problem-first (start from the nearest case study or build and follow prerequisites backwards), and interview-first (appendix, then case studies) under a deadline.

Q: Why design before reading a case study?
A: Reading gives recognition; designing gives generation, the skill you actually use. The gap between your sketch and the page is your real curriculum.

Q: What is the one habit the atlas asks for?
A: State the trade-off, not just the choice — the alternative, the constraint and the cost — so it's reasoning you can rerun when constraints change, not a memorised association.
```

## What to carry forward

- Read Core first; the AI and applied material build on it.
- Readiness banners guide but never lock.
- Pick depth-first, problem-first or interview-first to match your goal.
- Design before you read, and always state the trade-off.
