---
title: How to Use This Atlas
summary: A map of the whole curriculum, how the four groups depend on each other, and the reading habit that decides whether any of it sticks.
difficulty: Easy
tags: [orientation, meta]
unlocks: A route through the material that matches what you're actually trying to do.
---

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
| **Applied Design** | Case Studies, Guided Builds | Complete designs — presented finished, or constructed phase by phase |
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

This covers distributed systems design and AI infrastructure. It deliberately does not cover coding practice, behavioural interviews, or low-level object-oriented design. Those are separate skills.

Next: [How to Study Systems](how-to-study.html) — the reading and practice habits that make the rest of this stick.
