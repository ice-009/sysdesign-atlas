---
title: Context Engineering & Memory
summary: Assembling the prompt as a resource-allocation problem — cache-aware ordering, history compaction, and the memory architectures that let a system remember across sessions.
difficulty: Medium
scope: HLD
tags: [ai, context, memory, prompt, caching]
prereqs: [kv-cache-management, retrieval-architecture]
unlocks: Treating the context window as a budget to allocate rather than a box to fill.
---

## The framing

Everything a model knows about the current request arrives through the context window. Deciding what goes in it — and in what order — is a resource-allocation problem with three simultaneous constraints:

```diagram
   CAPACITY   the window is finite, and effective capacity
              is smaller than advertised

   COST       every token is billed, on every request; input
              volume usually dominates in chat products

   CACHE      only a PREFIX can be reused, so ordering
              determines your hit rate

   QUALITY    irrelevant content actively degrades answers
```

Those four pull against each other. Adding more retrieved documents raises the chance the answer is present and lowers the chance the model finds it, while costing tokens and possibly breaking your cache.

## Layout, and why order is not cosmetic

From [KV cache management](../06-ai-infrastructure/kv-cache-management.html): a cached prefix is reusable only up to the first byte that differs. So one variable token near the front invalidates everything after it.

```diagram
   ✗ BAD LAYOUT

     [timestamp: 2026-08-09 14:23:07]   ← changes every request
     [user: alice, plan: pro]
     [system prompt, 2,000 tokens]
     [tool definitions, 1,500 tokens]
     [retrieved documents]
     [conversation history]
     [current question]

     Cache hit rate ≈ 0.
     Every request re-prefills 3,500 tokens of static content.

   ✓ GOOD LAYOUT

     [system prompt, 2,000 tokens]      ← identical for everyone
     [tool definitions, 1,500 tokens]   ← identical
     ──────── shared prefix ends here ────────
     [user profile]                     ← stable per user
     ──────── per-user prefix ends here ──────
     [conversation history]             ← append-only, grows
     [retrieved documents]              ← varies per turn
     [timestamp]
     [current question]

     Global prefix cached across ALL users.
     Per-user prefix cached across their session.
     Only the tail is ever re-prefilled.
```

:::derive What the ordering is worth
```
   3,500 tokens of static prefix, 100,000 requests/day.

   Bad layout:   3,500 × 100,000 = 350M tokens prefilled daily
   Good layout:  ~0 after the first request per replica

   At uncached input pricing versus cached (typically ~10× cheaper),
   this is a large fraction of the bill for a chat product.

   And TTFT improves by the prefill time for 3,500 tokens —
   roughly 200 ms on a 70B model.

   → One reordering. No quality change. Substantial cost and
     latency improvement.
```
:::

The rule: **order by rate of change, most stable first.** It's the same principle as ordering Docker layers to maximise build cache reuse, and just as easy to get wrong.

## Managing conversation history

History grows every turn, and remember that the whole of it is re-sent on every request — the model retains nothing by itself. So cost per turn climbs steadily, and eventually the conversation simply won't fit. **Compaction** is the general name for shrinking it, and the options differ in what they throw away.

| Strategy | Mechanism | Cost |
|---|---|---|
| **Full history** | Send everything | Grows without bound; best quality |
| **Sliding window** | Keep the last N turns | Constant cost; loses early context abruptly |
| **Summarisation** | Compress older turns into a summary | Constant-ish; costs a model call; loses detail |
| **Hierarchical** | Summarise summaries as the conversation grows | Scales to very long sessions |
| **Retrieval over history** | Store turns, retrieve relevant ones | Best for long sessions with topic jumps |

:::goat Compaction breaks the prefix cache, and there's a way around it
Every strategy except "full history" **rewrites the prefix**. Replace turns 1–10 with a summary and every cached block after the system prompt is invalidated — so the turn where you compact is dramatically more expensive than the ones around it.

Two mitigations:

1. **Compact rarely, in large increments.** Paying one expensive turn every 40 is much better than a slightly expensive turn every 5.
2. **Compact at a stable boundary and keep the result stable.** If the summary of turns 1–20 is computed once and never revised, it becomes part of the cacheable prefix for the rest of the session. Recomputing the summary each turn is the worst case — you pay the model call *and* destroy the cache.

The general principle: **an append-only context is cacheable; a rewritten context is not.** Design compaction to preserve append-only-ness wherever possible.
:::

## Memory across sessions

Context handles one conversation. Memory is what persists beyond it.

```viz
{
  "type": "stack",
  "caption": "Four layers with different lifetimes, storage, and retrieval mechanisms.",
  "layers": [
    { "label": "Working memory", "sub": "the current context window · this turn", "accent": "#38bdf8" },
    { "label": "Session memory", "sub": "this conversation · full or compacted history", "accent": "#22d3ee" },
    { "label": "Long-term memory", "sub": "facts about the user · extracted, stored, retrieved", "accent": "#a78bfa" },
    { "label": "Shared knowledge", "sub": "documents and data · the RAG corpus", "accent": "#4ade80" }
  ]
}
```

The interesting layer is long-term memory, and it's mostly an extraction and retrieval problem rather than a modelling one:

**Write path.** After a conversation (or periodically during it), extract durable facts — "prefers TypeScript", "works at Acme", "timezone IST". Store them with a timestamp, a source reference, and a confidence.

**Read path.** At the start of a conversation, retrieve relevant memories and inject them into the stable per-user prefix. Retrieval can be simple — recent plus frequently-accessed is often enough — or embedding-based for large memory stores.

The hard parts are not the storage:

- **Contradiction.** "I use Python" then later "I've switched to Go." You need supersession, not accumulation — timestamped facts where newer wins for the same slot, rather than both sitting in the context confusing the model.
- **Decay.** A preference from two years ago is probably stale. Time-weight retrieval, or expire.
- **Over-extraction.** Storing everything means retrieving noise. Extract sparingly and prefer precision.
- **User control.** People must be able to see and delete what's remembered. This is a product requirement and increasingly a legal one, and it's much easier if memories are discrete records rather than an opaque embedding blob.

:::trap Memory is a privacy surface, and it's easy to build one accidentally
Persisted memory means user data outliving the conversation, which brings requirements a stateless chat product doesn't have:

- **Deletion must actually delete** — including from the vector index, backups within the retention window, and any caches.
- **Never cross tenant or user boundaries.** A memory retrieval bug that surfaces one user's facts to another is a serious data breach, not a quality issue.
- **Sensitive content shouldn't be silently retained.** Health, financial, and credential-shaped data extracted into "memory" is a liability you didn't intend to take on.
- **It must be inspectable.** "Why does it think I work at Acme?" needs an answer with a source.

Design the deletion path before the write path. Retrofitting deletion onto a memory system that was built append-only is genuinely painful.
:::

## Budgeting the window

Explicit allocation beats "fill it until it's full."

```diagram
   128K context window, an agent doing code work:

     system prompt + tools        4,000    fixed
     user memory                  1,000    capped
     retrieved code context      40,000    capped, reranked to fit
     conversation history        30,000    compacted to fit
     current message              2,000
     ──────────────────────────────────
     used                        77,000
     RESERVED FOR OUTPUT         16,000    ← must be reserved
     headroom                    35,000    ← for growth mid-task

   Rules that follow:
     · every category has a cap; nothing grows unbounded
     · output space is reserved FIRST, not left over
     · when a category exceeds its cap, IT compacts —
       it does not steal from another
```

**Reserving output space is the one people miss.** Filling 126K of a 128K window leaves room for a two-thousand-token answer, and the generation truncates mid-sentence. The failure looks like a model problem and is a budgeting bug.

## Instructions in the prompt

Beyond content, the shape of the instruction matters and is cheap to get right:

- **Put instructions before the data**, not after — though with a long context, repeating the key instruction at the end helps, since the end of the window is a high-attention position.
- **Be explicit about the failure case.** "If the context doesn't contain the answer, say you don't know" measurably reduces fabrication.
- **Use structure.** XML tags or markdown headings around documents help the model distinguish content from instruction, and make prompt-injection attempts easier to spot.
- **Version prompts as artifacts.** They are code. They need review, versioning, and a rollback path, and every trace should record which version ran.

:::exercise Design the context layout
A coding agent: 200K context window. Per request it has a 6,000-token system prompt with tool definitions, up to 100,000 tokens of repository context, conversation history that grows about 3,000 tokens per turn, and user preferences.

1. Write the layout in order, marking each segment's cache tier (global, per-user, per-session, per-request).
2. Allocate the budget across categories, including reserved output. Justify each cap.
3. Repository context exceeds 100,000 tokens. How do you select what to include, and how does that interact with caching across turns?
4. At turn 30 history is 90,000 tokens. Design the compaction: when it triggers, what it produces, and how you keep it from destroying the cache every turn thereafter.
5. Design the memory write path: what gets extracted, when, and how contradictions are resolved.
6. A user says "forget everything you know about me." List every place data has to be removed from — be exhaustive.
:::

:::paper Sources
*Lost in the Middle* (Liu et al., TACL 2024) is the positional-attention result that drives ordering decisions.

*MemGPT: Towards LLMs as Operating Systems* (Packer et al., 2023) frames context management as virtual memory paging and is the clearest treatment of the hierarchy. Anthropic's prompt caching documentation is the practical reference for cache-aware ordering.
:::

## What to carry forward

- **Order by rate of change, most stable first.** Only a prefix caches; one variable token at the front costs you everything.
- **Compaction breaks the cache.** Compact rarely, in large increments, and keep the result stable.
- **An append-only context is cacheable**; a rewritten one is not.
- **Memory is extraction plus retrieval**, and the hard parts are contradiction, decay, and deletion.
- **Design the deletion path before the write path.**
- **Budget explicitly and reserve output space first**, or generations truncate.
