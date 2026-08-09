---
title: Build an LLM Inference Platform
summary: Serving a large language model at scale — the KV cache, continuous batching, and why GPU memory rather than compute is the binding constraint.
difficulty: Hard
level: 5
prereqs: [back-of-envelope, message-queues, backpressure, caching, latency-throughput]
tags: [level-5, ai, gpu, inference]
unlocks: The foundation under every AI product — how tokens are actually served.
---

## The product

An API that takes a prompt and streams back generated text. Thousands of concurrent users, each expecting the first token quickly and the rest smoothly.

**This is the foundation under every other Level 5 build.** Chat products, agents, code assistants, and RAG systems all sit on top of a token server. Understand this one and the rest are composition.

:::note On specifics in this section
The architectural principles here are stable; the numbers are not. Model sizes, GPU memory, and throughput figures move fast. Treat the arithmetic as illustrative of the *shape* of the problem — the ratios and bottlenecks are what matter, not the exact values.
:::

## Phase 1 — Understand what inference actually does

Everything follows from this, so get it right before designing anything.

Generation happens one token at a time, and each token is produced by a full forward pass through the model conditioned on everything before it.

```diagram
   PREFILL — process the whole prompt at once
     "Explain consistent hashing" (5 tokens)
     → one forward pass over all 5 positions in parallel
     → COMPUTE-BOUND: lots of matrix multiplication, GPU saturated
     → produces the first output token

   DECODE — generate the rest, one token per pass
     token 1 → token 2 → token 3 → ...
     each pass processes exactly ONE new position
     → MEMORY-BANDWIDTH-BOUND: you must read the entire model's
       weights from GPU memory to produce a single token
```

**These two phases have opposite performance characteristics, and that fact drives the entire architecture.**

Prefill does enormous parallel work and keeps the GPU's compute units busy. Decode does trivial arithmetic but has to stream every weight in the model through the memory bus to produce one token. A decode step for one request leaves the GPU almost entirely idle — you're paying for the memory read regardless.

**The consequence:** decoding one request at a time is catastrophically wasteful. If you're reading all the weights anyway, you should be producing tokens for as many requests as possible in that same pass. That's batching, and it's not an optimization here — it's the difference between a viable service and an unaffordable one.

## Phase 2 — The KV cache, and why memory is the constraint

Naively, generating token N would re-process all N−1 previous tokens. That's quadratic and unusable.

The fix is to cache the intermediate attention state (the "keys" and "values") for every token already processed, so each new token only computes its own state and attends over the cache.

```diagram
   Without KV cache:  token N costs O(N)   → total O(N²)
   With KV cache:     token N costs O(1)   → total O(N)
```

Essential — and it consumes an enormous amount of GPU memory that grows with **every token of every concurrent request**:

```diagram
   KV cache per token ≈ 2 × layers × heads × head_dim × bytes_per_value

   Illustrative mid-size model:
     ~2 × 80 layers × 8192 hidden × 2 bytes ≈ 2.6 MB per token

   A 4,000-token conversation:  ~10 GB of KV cache
   On an 80 GB GPU holding ~40 GB of weights:
     ~40 GB left → only ~4 such conversations fit AT ONCE
```

:::goat The insight that reframes the whole design
**You are not scheduling compute. You are scheduling memory.**

The number of concurrent requests a GPU can serve is set by how much KV cache fits alongside the weights — not by how fast the GPU can multiply. A request with a 100K-token context consumes as much memory as twenty short ones.

Saying this early reframes the entire conversation, and it's the single highest-value observation in this build. The reflex is to reach for "add more GPUs" without first establishing what is actually scarce.
:::

## Phase 3 — Continuous batching

The naive batching strategy is *static*: collect N requests, run them together, return when all finish.

```diagram
   STATIC BATCHING — the problem
   req A ████████████████████████ 500 tokens
   req B ███                       20 tokens ─┐
   req C ████                      30 tokens ─┼─ finished, but their
   req D ██                        15 tokens ─┘  slots sit IDLE until
                                                  A completes

   → GPU utilization collapses because generation lengths
     vary enormously and the batch runs at the slowest member's pace
```

**Continuous batching** (also called in-flight batching) fixes this by operating at the *iteration* level rather than the request level:

```diagram
   After EVERY decode step:
     · evict any request that just emitted its stop token
     · admit a waiting request into the free slot
     · run the next step on whatever is currently resident

   req A ████████████████████████
   req B ███▓▓▓▓▓▓ ← B finishes, E admitted immediately
   req C ████▓▓▓▓▓▓▓ ← C finishes, F admitted
   req D ██▓▓▓▓▓▓▓▓▓▓

   → the batch is always full; utilization stays high
```

This is a scheduling change, not a model change, and it typically multiplies throughput several times over. It's the single most important technique in LLM serving.

**Prefill and decode interfere**, which is the subtlety worth naming. A newly admitted request needs a prefill pass — compute-heavy, and it stalls the decode steps of everyone already streaming. Serving systems handle this by chunking long prefills into pieces interleaved with decode steps, so admitting a request with a huge prompt doesn't visibly stutter everyone else's stream. If asked "what happens when someone submits a 100K-token prompt?", that's the answer.

## Phase 4 — Memory management

KV cache allocation is where naive implementations waste most of their capacity.

```diagram
   NAIVE: reserve max_context_length per request up front
     request might generate 50 tokens or 4,000 — you don't know
     → reserve for 4,000, use 50 → most of the memory is wasted
     → fragmentation makes it worse

   PAGED: allocate in fixed-size blocks, like OS virtual memory
     each request holds a block table pointing at scattered blocks
     grow by one block as generation proceeds
     → near-zero waste, no fragmentation
     → identical prefixes can SHARE blocks
```

That last property matters more than it first appears. If a thousand requests share the same long system prompt, they can share the same physical blocks for that prefix — one copy in memory instead of a thousand. For a chat product with a large system prompt, this is a very large capacity win, and it leads directly to:

**Prefix caching.** If a request's prompt begins with a prefix you've already processed, skip recomputing it entirely and reuse the cached KV blocks.

```diagram
   Multi-turn conversation:
     turn 1: [system][user₁]                    → prefill everything
     turn 2: [system][user₁][asst₁][user₂]      → the first three are
                                                  ALREADY CACHED
                                                  → prefill only user₂
```

Conversations are append-only, so **every turn after the first is mostly a cache hit.** This dramatically cuts time-to-first-token in chat, and it's the mechanism behind "cached input" pricing tiers. It's also just [caching](../building-blocks/caching.html) — the same principle as Level 1, with attention state instead of database rows.

## Phase 5 — Multi-GPU, when the model doesn't fit

A model too large for one GPU must be split.

```diagram
   TENSOR PARALLEL   split each layer's matrices across GPUs
                     every GPU works on every token
                     → needs very fast interconnect (NVLink);
                       communicates at EVERY layer
                     → use WITHIN a node

   PIPELINE PARALLEL split layers into stages across nodes
                     GPU0: layers 0-19, GPU1: layers 20-39 ...
                     → communicates only at stage boundaries
                     → tolerates slower links, use ACROSS nodes
                     → introduces pipeline bubbles
```

Rule of thumb: tensor parallelism inside a node where the interconnect is fast, pipeline parallelism across nodes where it isn't. Both add latency, so use the smallest split the model actually requires.

**Speculative decoding** is the other big lever. Since decode is memory-bandwidth-bound, verifying several tokens costs barely more than generating one. So: have a small fast model draft *k* tokens, then have the large model verify them all in a single pass. Accepted drafts are free; rejected ones cost one wasted pass. When the draft model is decent, this cuts latency substantially with no change in output distribution.

## Phase 6 — Serving architecture

```viz
{
  "type": "stack",
  "caption": "Serving stack. Note the unit of admission is tokens, not requests.",
  "layers": [
    {
      "label": "API gateway",
      "sub": "auth \u00b7 rate limit by TOKENS, not RPS",
      "accent": "#38bdf8"
    },
    {
      "label": "Admission queue",
      "sub": "priority lanes \u00b7 bounded wait \u00b7 shed when saturated",
      "accent": "#a78bfa"
    },
    {
      "label": "Router",
      "sub": "route to free KV memory \u00b7 prefer cached-prefix replica",
      "accent": "#4ade80"
    },
    {
      "label": "GPU nodes",
      "sub": "continuous batching \u00b7 paged KV cache",
      "accent": "#fb7185"
    }
  ]
}
```

**Rate limit on tokens, not requests.** One request generating 4,000 tokens costs vastly more than one generating 20. RPS limits are meaningless here — this is a genuine difference from every earlier build in this atlas.

**Route by cache affinity.** Sending a conversation's next turn to the replica that already holds its KV prefix turns an expensive prefill into a cache hit. This is [consistent hashing](../building-blocks/consistent-hashing.html) on conversation ID, with a load-based escape hatch so a hot replica isn't overwhelmed.

**Stream over SSE.** Generation is inherently incremental and one-directional; [SSE](../building-blocks/realtime.html) gives you streaming plus automatic reconnection without WebSocket complexity.

## Phase 7 — The metrics that matter

Standard latency metrics don't describe this workload.

| Metric | Meaning | Why it matters |
|---|---|---|
| **TTFT** | Time to first token | Perceived responsiveness. Dominated by queueing + prefill. |
| **TPOT** | Time per output token | Streaming smoothness. Must beat reading speed (~30ms/token feels fluid). |
| **Throughput** | Total tokens/sec across all users | What determines your cost per token. |
| **Goodput** | Tokens/sec *meeting SLA* | The honest number — high throughput at unacceptable TTFT is worthless. |

**TTFT and throughput are in direct tension.** Bigger batches raise throughput and lengthen the queue, so TTFT degrades. This is the central operating tradeoff, and there's no setting that optimizes both. Real deployments often split traffic into latency-sensitive lanes (small batches, interactive) and throughput-oriented lanes (large batches, bulk/batch jobs).

**Autoscaling is painfully slow.** A GPU node can take minutes to provision and load tens of gigabytes of weights. You cannot scale reactively into a spike the way you would a stateless web tier. Consequences: keep warm capacity, use [admission control and load shedding](../distributed/backpressure.html) aggressively, and queue with a *bounded* wait rather than accepting unbounded latency.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| Continuous batching | Static batching | Slots idle until the slowest request finishes |
| Paged KV cache | Contiguous per-request allocation | Massive waste + fragmentation; blocks enable prefix sharing |
| Prefix caching | Recompute every turn | Conversations are append-only; most of each turn is a cache hit |
| Chunked prefill | Prefill-priority scheduling | A huge prompt would stall everyone's stream |
| Token-based rate limits | Request-based | A 4,000-token response ≠ a 20-token one |
| Cache-affinity routing | Round robin | Turns an expensive prefill into a cache hit |
| Tensor parallel in-node, pipeline across | Tensor parallel everywhere | Tensor parallelism communicates every layer; needs fast links |
| Speculative decoding | Plain decode | Decode is bandwidth-bound; verification is nearly free |
| Bounded queue + shed | Unbounded queue | GPUs scale in minutes; queues become useless latency |

## What you'd cut for v1

Speculative decoding, multi-node parallelism, prefix caching, priority lanes. Ship: one model on one GPU with continuous batching and paged attention, SSE streaming, token-based rate limiting. Continuous batching alone gets you most of the available throughput.

## Explaining the design

> "The thing to establish first is that generation has two phases with opposite characteristics. Prefill processes the whole prompt in parallel and is compute-bound. Decode produces one token per forward pass and is memory-bandwidth-bound — you stream every weight in the model to produce a single token. That means serving one request at a time wastes almost the entire GPU, so batching is mandatory rather than an optimization.
>
> The binding constraint isn't compute, it's memory: the KV cache grows with every token of every concurrent request, so concurrency is set by how much cache fits alongside the weights. I'm scheduling memory, not compute.
>
> So the core is continuous batching — evict finished requests and admit waiting ones after every decode step, so the batch stays full — plus paged KV allocation so memory isn't wasted on reservations and identical prefixes can share blocks. That last property gives prefix caching, which matters enormously for chat because conversations are append-only, so every turn after the first is mostly a cache hit.
>
> I'd rate limit on tokens rather than requests, route by cache affinity so a conversation returns to the replica holding its prefix, and stream over SSE.
>
> The operating tension is TTFT versus throughput — bigger batches improve throughput and worsen time-to-first-token. And since GPU autoscaling takes minutes, I'd hold warm capacity and shed load at the edge rather than queue into unbounded latency."

## Next

[Build a Claude-style Chat Platform](ai-chat-platform.html) — the product layer on top of this.
