---
title: How Guided Builds Work
summary: The difficulty ladder, what a "build" contains, and how the readiness check tells you when a design will actually make sense to you.
difficulty: Easy
scope: HLD
level: 1
tags: [orientation, guide]
unlocks: Knowing which build to start with and how to use the readiness checks.
---

## The difference from the case studies

The [Case Studies](../case-studies/url-shortener.html) track presents finished designs in interview format — requirements, estimation, API, high-level design, deep dives. That is the finished artifact — the design as you would present it.

**Guided Builds are different.** They construct each system in **phases**, the way you'd actually build it:

```viz
{
  "type": "steps",
  "caption": "Each phase transition is triggered by a concrete number, not a vibe.",
  "steps": [
    {
      "label": "Phase 1",
      "sub": "The naive version that genuinely works \u2014 and the scale it survives to."
    },
    {
      "label": "Phase 2",
      "sub": "What breaks first, and the smallest fix that addresses it."
    },
    {
      "label": "Phase 3",
      "sub": "What breaks next, once that fix is in place."
    },
    {
      "label": "Phase N",
      "sub": "The version that handles the full stated scale."
    }
  ]
}
```

Why this shape matters: the skill being built is **matching a solution to a scale**. Candidates who jump straight to the final architecture look like they've memorized a diagram. Candidates who say *"here's the simple version, and here's the specific number at which it stops working"* look like engineers.

Every phase transition in these builds is triggered by a concrete number, not a vibe.

## The difficulty ladder

| Level | What it teaches | Builds |
|---|---|---|
| **1 — Foundations** | The shape of a design. One service, one database, one cache. | Pastebin, Image Host |
| **2 — Scale** | Fanout, storage tiering, read/write asymmetry. | Instagram, Twitter |
| **3 — Real-time & Media** | Persistent connections, streaming, bandwidth. | WhatsApp, Netflix |
| **4 — Hard Constraints** | Geospatial, concurrent mutation, money. | Uber, Google Docs, Stripe |
| **5 — AI Platforms** | GPU scheduling, token streaming, retrieval, agents. | LLM Serving, Claude-style Chat, RAG, Agents, Code Assistant |

Levels 1–4 are the classic interview canon. **Level 5 is the material that's become unavoidable** — AI infrastructure questions now appear in loops at every company building on models, and almost no preparation material covers them properly.

## The readiness check

Every build declares its prerequisites. At the top of each page you'll see one of two states:

**Not ready yet** — a list of concepts to study first, each linking to the topic that covers it, with a checkmark against the ones you've already marked complete.

**Ready** — every prerequisite is marked complete, so the build will land as *"of course, that follows"* rather than *"where did that come from?"*

:::note It guides, it doesn't lock
Nothing is gated. You can read any build at any time. The check exists because these designs assume things — a build that says "shard on `conversation_id`" only makes sense if [sharding](../building-blocks/sharding.html) is already in your head. Reading it cold produces recognition; reading it prepared produces understanding.

If you're short on time, read anyway and backfill the gaps the build exposes. That's a legitimate strategy — it's [Track A](../start/how-to-use.html).
:::

Mark a topic complete with the **Mark complete** button on its page. That's what feeds the check.

## What's inside a build

Each one follows the same structure:

1. **The product in one paragraph** — what users actually do.
2. **The naive version** — the smallest thing that works, with the scale it survives to.
3. **Phased evolution** — each phase opens with the number that broke the previous one.
4. **The decision log** — every significant choice, its rejected alternative, and the constraint that decided it. This is the part you rehearse for interviews.
5. **What you'd cut for v1** — because knowing what *not* to build is the harder judgment.
6. **Interview framing** — how to compress a multi-phase build into 45 minutes.

## How to use them

**If you're preparing for interviews:** do the build cold first. Sketch your own phases on paper for 20 minutes, then read and diff. The gap is your curriculum.

**If you're building something real:** start at Phase 1 and stop at the phase that matches your actual scale. Most products never need Phase 4, and building it anyway is the most common form of wasted engineering.

**If you're learning:** read the whole ladder in order. Level 1 to Level 5 is a genuine progression — Level 5's AI systems reuse queueing, batching, caching, and sharding from Levels 1–4, just with GPUs as the scarce resource instead of database connections.

## A note on the AI builds

Level 5 covers systems that didn't exist in most interview prep two years ago. The technical substance — continuous batching, KV cache management, vector retrieval, agent orchestration — is drawn from published research and engineering writing, and I've explained it from first principles rather than assuming familiarity.

Two things to keep in mind: this domain moves faster than any other in this atlas, so treat specific figures (model sizes, throughput numbers, hardware specs) as illustrative of the *shape* of the problem rather than current fact. And the architectural principles — batching to amortize fixed costs, caching to avoid recomputation, queueing to smooth load — are the same ones from Level 1. That's the point.

Start with [Pastebin](pastebin.html) if you're new, or jump to [LLM Inference Serving](llm-inference-serving.html) if you want the hardest thing here.
