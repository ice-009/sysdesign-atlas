---
title: Attention & the KV Cache
summary: The cache that turns quadratic generation into linear, the memory it consumes, and why concurrency on a GPU is set by megabytes rather than by FLOPs.
difficulty: Medium
scope: Core
tags: [ai, attention, kv-cache, memory]
prereqs: [transformer-as-a-system, caching]
unlocks: The central constraint of LLM serving — scheduling memory, not compute.
---

## The problem the cache solves

Generation is autoregressive: to produce token *N*, the model runs a forward pass over the sequence so far. Done naively, that means reprocessing every previous token on every step.

:::derive Why naive generation is unusable
```
   Generating N tokens, reprocessing everything each step:

     token 1:  process 1 position
     token 2:  process 2 positions
     token 3:  process 3 positions
     ...
     token N:  process N positions
              ─────────────────────
     Total:    1+2+...+N = N(N+1)/2  =  O(N²)

   For N = 1,000:  500,000 position-passes instead of 1,000.

   → 500× more work than necessary.
```
:::

The fix follows from a property of causal attention noted on the previous page: **position *i*'s key and value vectors depend only on position *i* and the layers below it.** They are identical whether the sequence is 6 tokens long or 6,000. So compute them once, keep them, and each new token computes only its own K and V and attends over the stored set.

```diagram
   WITHOUT CACHE                    WITH CACHE

   step 3: recompute K,V for        step 3: K,V for positions 1-2
           positions 1,2,3                  already in cache
                                            compute K,V for position 3 only
   cost per token: O(N)             cost per token: O(1) compute,
   total: O(N²)                                     O(N) memory read
                                    total: O(N)
```

Cost per token becomes constant. Total generation becomes linear. **This is the single optimisation that makes LLM serving possible at all** — and the bill arrives as memory.

## What it costs

Every token of every live request holds a K and a V vector, in every layer.

:::derive KV cache size
```
   bytes per token = 2 × layers × kv_heads × head_dim × bytes_per_value
                     ─
                     one for K, one for V

   Model with 80 layers, 64 heads, head_dim 128, BF16 (2 bytes),
   standard multi-head attention (kv_heads = 64):

     2 × 80 × 64 × 128 × 2  =  2,621,440 bytes  ≈ 2.5 MB per token

   A 4,000-token conversation:   4,000 × 2.5 MB  ≈  10 GB
   A 32,000-token document:     32,000 × 2.5 MB  ≈  80 GB

   On an 80 GB GPU already holding ~40 GB of weights:
     ~40 GB left for KV
     → ~4 conversations of 4,000 tokens, concurrently
     → or ZERO conversations of 32,000 tokens
```
:::

:::goat The sentence that reframes the whole problem
**You are not scheduling compute. You are scheduling memory.**

How many concurrent requests a GPU can serve is set by how much KV cache fits alongside the weights — not by how fast the GPU multiplies. A single 100K-token request consumes as much memory as twenty short ones and should be admitted as though it were twenty requests.

Almost everyone's first instinct on "how do we serve more users" is "add GPUs" or "make the model faster." The actual question is "how do we fit more KV cache," and it has completely different answers: grouped-query attention, quantized cache, paging, offload, eviction. Getting to that question quickly is the whole skill.
:::

## Making it smaller: attention variants

Because the cache scales with `kv_heads`, the highest-leverage change is to have fewer of them.

```diagram
   MULTI-HEAD (MHA)           GROUPED-QUERY (GQA)        MULTI-QUERY (MQA)

   Q1 Q2 Q3 Q4 ... Q64        Q1 Q2 Q3 Q4 ... Q64        Q1 Q2 ... Q64
   K1 K2 K3 K4 ... K64        K1─────┘ K2─────┘          K1 ──────────┘
   V1 V2 V3 V4 ... V64        V1─────┘ V2─────┘          V1 ──────────┘

   64 KV heads                8 KV heads                 1 KV head
   baseline                   8× smaller cache           64× smaller cache
   best quality               ~no measurable loss        small quality loss
```

| Variant | KV heads | Cache per token (same model) | Quality |
|---|---:|---:|---|
| MHA | 64 | 2.5 MB | Baseline |
| GQA (8 groups) | 8 | 0.31 MB | Essentially unchanged |
| MQA | 1 | 0.04 MB | Slight degradation |

**GQA is close to free**, which is why nearly every model released since 2023 uses it. Dropping the cache 8× multiplies concurrency roughly 8× — a bigger throughput win than most hardware upgrades, obtained by changing a hyperparameter.

Two further reductions:

- **Quantized KV cache** — store K and V at FP8 or INT8. Halves or quarters the cache with modest quality impact, and it's orthogonal to GQA so the savings multiply.
- **MLA (multi-head latent attention)** — compress K and V into a shared low-rank latent and reconstruct on use. Trades a little compute for a large memory reduction; used by DeepSeek's models.

## Prefix sharing: the property that changes chat economics

Two requests beginning with identical tokens produce **identical** K and V for that prefix. There is no approximation involved — the values are bit-identical, because causal attention means a position's K and V don't depend on anything after it.

So the cache blocks for a shared prefix can be *shared*, not merely recomputed similarly.

```diagram
   1,000 concurrent requests, all with the same 2,000-token
   system prompt:

     Without sharing:  1,000 × 2,000 × 2.5 MB  =  5,000 GB
     With sharing:         1 × 2,000 × 2.5 MB  =      5 GB

     → 1,000× reduction on the shared portion
```

And within a conversation:

```diagram
   Multi-turn chat is append-only:

     turn 1: [system][user₁]                       → prefill all
     turn 2: [system][user₁][asst₁][user₂]         → first 3 CACHED,
                                                      prefill only user₂
     turn 3: [system][user₁][asst₁][user₂][asst₂][user₃]
                                                   → prefill only user₃

   Every turn after the first is mostly a cache hit.
```

**This is the mechanism behind "cached input" pricing tiers**, and it is why time-to-first-token in a long conversation is often *lower* than in a short fresh one. It also creates a routing requirement: send a conversation's next turn to the replica that already holds its prefix, or you throw the hit away. That's [consistent hashing](../02-building-blocks/consistent-hashing.html) on conversation ID, with a load-based escape hatch — developed further in [KV cache management](../06-ai-infrastructure/kv-cache-management.html).

:::goat The prompt-ordering consequence
Because only a *prefix* can be shared, **the order of your prompt determines your cache hit rate**.

```
   BAD:   [timestamp][user profile][system prompt][documents][question]
          → the timestamp changes every request, so NOTHING
            after it can be shared. Hit rate ≈ 0.

   GOOD:  [system prompt][documents][user profile][timestamp][question]
          → the large stable content is a shared prefix.
            Hit rate ≈ high.
```

One variable token at the front destroys the entire cache. This is a real and commonly-made mistake, and it's invisible in testing — the system works perfectly, just at several times the cost and latency it should have.
:::

## Paged allocation

The naive allocator reserves `max_context_length` per request up front, because you don't know how long the generation will be.

```diagram
   NAIVE (contiguous, reserve max)
     request may generate 50 tokens or 4,000 — unknown at admission
     → reserve for 4,000, typically use 50
     → most reserved memory is wasted
     → freed blocks of varying sizes fragment the pool

   PAGED (fixed-size blocks, like OS virtual memory)
     allocate in blocks of e.g. 16 tokens
     each request holds a block table pointing at scattered blocks
     grow by one block as generation proceeds
     → near-zero waste, no external fragmentation
     → identical prefixes SHARE physical blocks, copy-on-write
```

This is virtual memory, applied to attention state, and the analogy is exact: a block table is a page table, prefix sharing is shared read-only pages, and a fork-on-write when two sequences diverge is copy-on-write. Reported utilisation improvements from PagedAttention were in the range of 2–4× more concurrent requests on the same hardware.

:::trap "The KV cache is a cache, so I can just evict under pressure"
It is a cache in the sense of storing recomputable data, and not in any of the ways that make caches easy.

- Evicting an **active** request's cache doesn't free you from the work — you must recompute it before the next token, which means a full prefill mid-generation and a visible stall.
- Eviction granularity matters: dropping the *middle* of a sequence is not possible without changing the model's output, because attention needs all of it.
- The real policies are: **preempt** a whole request (evict all its blocks, re-prefill later — trading latency for the ability to admit someone else), **swap** its blocks to CPU memory, or **shed** it at admission.

Choosing among preempt, swap, and reject under memory pressure is the scheduler's central decision, and it's a scheduling problem, not a caching problem.
:::

## Exercise

:::exercise Work the memory budget
A model has 60 layers, 8 KV heads, head_dim 128, and is served in BF16 on an 80 GB GPU. The weights occupy 35 GB.

1. Compute the KV cache bytes per token. How many total tokens of cache fit in the remaining memory?
2. Your workload averages 3,000 tokens per conversation. How many concurrent conversations fit? What if 5% of them are 60,000 tokens?
3. Your system prompt is 3,000 tokens and is identical for every user. With prefix sharing, how much memory does it consume across 200 concurrent users? Without?
4. You quantize the KV cache to FP8. Recompute (1) and (2). Is that a bigger or smaller win than upgrading to a 141 GB GPU — and which costs more?
5. A request arrives that needs 40,000 tokens of cache and you have 8 GB free. Argue for each of: reject it, preempt two active requests, swap blocks to CPU memory. What does each cost, and what would you actually do?
:::

:::paper Sources
*Efficient Memory Management for Large Language Model Serving with PagedAttention* (Kwon et al., SOSP 2023) is the vLLM paper and the origin of paged KV allocation — one of the most directly applicable systems papers of recent years.

*Fast Transformer Decoding: One Write-Head is All You Need* (Shazeer, 2019) introduced MQA; *GQA* (Ainslie et al., EMNLP 2023) is the grouped generalisation. *SGLang / RadixAttention* (Zheng et al., 2024) covers prefix caching as a radix tree.
:::

## What to carry forward

- The KV cache turns **O(N²) generation into O(N)** — non-optional, and paid for in memory.
- **Cache size = 2 × layers × kv_heads × head_dim × bytes**, per token, per request.
- **Concurrency is set by how much cache fits alongside the weights.** You schedule memory.
- **GQA is a near-free 8× reduction**; quantized cache and MLA stack on top of it.
- **Identical prefixes share blocks exactly** — so put stable content first and route by cache affinity.
- **Paged allocation** removes reservation waste and fragmentation, and is literally OS virtual memory.
- Under pressure the choice is **preempt, swap, or reject** — not evict.
