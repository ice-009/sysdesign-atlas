---
title: KV Cache Management
summary: Prefix caching as a radix tree, tiering across HBM/DRAM/NVMe, prefill-decode disaggregation, and cache-affinity routing — squeezing more concurrency out of the resource that actually binds.
difficulty: Hard
scope: HLD
tags: [ai, kv-cache, caching, routing, serving]
prereqs: [inference-engines, caching, consistent-hashing]
unlocks: The highest-leverage optimisation available in a production LLM serving stack.
---

## Where the leverage is

From [attention and the KV cache](../05-ai-foundations/attention-and-kv-cache.html): concurrency on a GPU is set by how much KV cache fits alongside the weights. So every megabyte you save or reuse converts directly into more users served on the same hardware.

There are three independent levers, and they multiply:

```diagram
   1. MAKE IT SMALLER      GQA, quantized cache, MLA
                           → 8-32× reduction, model-side

   2. DON'T RECOMPUTE IT   prefix caching, radix trees
                           → skip prefill entirely on cache hits

   3. PUT IT SOMEWHERE     tiering to DRAM and NVMe,
      ELSE                   disaggregated pools
                           → more effective capacity than HBM
```

Lever 1 belongs to the model architecture. This page is levers 2 and 3, which are pure infrastructure and available to you regardless of which model you serve.

## Prefix caching as a radix tree

Here's the fact that makes this work: because each token's cached values depend only on the tokens *before* it, two requests that start with the same words produce byte-for-byte identical cache entries for that shared opening — no matter how differently they continue.

A simple cache keyed on the whole prompt only catches exact repeats. A **radix tree** — a tree where each branch point is a place two prompts diverged — catches every shared beginning, at every length.

```diagram
   Requests arriving:

     R1: [SYS][What is Raft?]
     R2: [SYS][What is Paxos?]
     R3: [SYS][What is Raft?][answer][And Paxos?]

   RADIX TREE OF CACHED BLOCKS

            [SYS]  ← 2,000 tokens, shared by ALL requests
              │
        ┌─────┴─────┐
   [What is      [What is
    Raft?]        Paxos?]
        │
   [answer][And Paxos?]

   R1 hits [SYS] + its own branch
   R2 hits [SYS], prefills only its branch
   R3 hits [SYS][What is Raft?][answer] — everything but
      the last few tokens
```

Every node holds physical KV blocks with a reference count. Insert a request by walking the tree as far as it matches, prefilling only the divergent suffix. Evict by LRU on leaves, never on a node with live children.

:::derive What prefix caching is worth
```
   Chat product: 2,000-token system prompt, 8-turn conversations,
   each turn adding ~500 tokens.

   WITHOUT prefix caching, prefill tokens per conversation:
     turn 1:  2,500
     turn 2:  3,000
     turn 3:  3,500
     ...
     turn 8:  6,000
     total = 34,000 tokens prefilled

   WITH prefix caching:
     turn 1:  2,500  (cold)
     turn 2:    500  (only the new turn)
     ...
     turn 8:    500
     total =  6,000 tokens prefilled

   → 5.7× less prefill compute.
     TTFT on turns 2-8 drops by roughly the same factor.
     And this is on the COMPUTE-bound phase, so it
     translates directly into GPU time saved.
```
:::

**This is why providers price cached input at a fraction of uncached input.** They are passing through a real, large cost difference — not offering a discount.

## Cache-affinity routing

Prefix caching only helps if the request lands on the replica holding the prefix. With naive round-robin, an 8-replica fleet gives you a 1-in-8 chance.

```viz
{
  "type": "flow",
  "caption": "Route by conversation, fall back on load. Cache locality is worth more than perfect balance.",
  "nodes": [
    { "id": "r", "label": "Request", "sub": "conversation_id", "col": 0, "accent": "#38bdf8" },
    { "id": "h", "label": "Router", "sub": "consistent hash + load check", "col": 1, "accent": "#a78bfa" },
    { "id": "a", "label": "Replica A", "sub": "holds this prefix", "col": 2, "accent": "#4ade80" },
    { "id": "b", "label": "Replica B", "sub": "cold for this prefix", "col": 2, "accent": "#64748b" }
  ],
  "edges": [
    { "from": "r", "to": "h" },
    { "from": "h", "to": "a", "label": "cache hit" },
    { "from": "h", "to": "b", "label": "if A is overloaded", "dashed": true }
  ]
}
```

This is [consistent hashing](../02-building-blocks/consistent-hashing.html) on conversation ID, with one crucial addition: **a load-based escape hatch.** Pure hashing sends every request for a hot conversation to one replica, which then queues while others idle.

The standard policy — "power of two choices with cache awareness":

```
   1. Hash the conversation ID → preferred replica P
   2. If P's queue depth is within a threshold of the fleet
      average, route to P (cache hit, worth a little imbalance)
   3. Otherwise pick the least-loaded replica (cold, but fast)
```

:::goat The tradeoff is explicit and worth naming
Cache-affinity routing deliberately accepts **worse load balance** in exchange for **better cache hit rate**. That's the right trade whenever a cache miss costs more than the imbalance.

Quantify it: a cache hit saves a 2,000-token prefill, maybe 100 ms of GPU time. A 20% load imbalance costs maybe 20 ms of extra queue wait. The hit is worth 5× the imbalance, so you should tolerate quite a lot of imbalance before falling back.

Recompute that ratio for your own numbers — with short prompts the calculus flips and plain least-loaded routing wins. This is the same reasoning as [session affinity](../02-building-blocks/load-balancing.html), with a much larger prize for getting it right.
:::

## Tiering

HBM is fast and small. There is much more memory available one or two tiers away.

```diagram
   TIER          CAPACITY      BANDWIDTH        USE

   HBM           80-192 GB     2-8 TB/s         active requests
   Host DRAM     1-2 TB        ~64 GB/s PCIe    paused / recent
                               (~900 GB/s C2C)
   Local NVMe    10-100 TB     3-7 GB/s         long-tail prefixes
   Object store  unbounded     ~1 GB/s          rarely worth it

   The question at each boundary is always the same:

     transfer_time  vs  recompute_time

   Recomputing a 2,000-token prefix on a 70B model:  ~120 ms
   Transferring its KV (2,000 × 164 KB = 328 MB):
       over PCIe at 64 GB/s   →   5 ms   ✓ transfer wins easily
       over NVMe at 5 GB/s    →  66 ms   ✓ still wins
       over network at 1 GB/s → 328 ms   ✗ recompute wins
```

The crossover is a real calculation, not a heuristic, and it depends on your model size and context length. Longer contexts favour transfer (recompute is quadratic-ish in attention); shorter ones favour recompute.

**Tiered prefix caching** is where this pays off best: keep hot prefixes in HBM, warm ones in DRAM, and a long tail on NVMe. A system prompt used by every customer stays in HBM; a specific document a user uploaded yesterday lives on NVMe and is still much cheaper to fetch than to re-prefill.

## Prefill/decode disaggregation

**Disaggregation** here means splitting one job across two separate pools of machines rather than doing both on the same ones. It's worth doing because prefill and decode want opposite hardware: prefill saturates the compute units, decode sits waiting on memory. Run them together and every GPU is a compromise between the two.

```diagram
   COLOCATED                     DISAGGREGATED

   ┌──────────────────┐          ┌────────────┐    ┌────────────┐
   │  GPU pool        │          │ PREFILL    │───►│ DECODE     │
   │  prefill+decode  │          │ pool       │ KV │ pool       │
   │  interleaved     │          │            │    │            │
   └──────────────────┘          └────────────┘    └────────────┘
                                  compute-bound     bandwidth-bound
   · chunking needed to           big batches       many concurrent
     avoid stalls                 high MFU          large KV space
   · one hardware choice          scale on          scale on
     for both phases              prompt volume     output volume
   · simpler                      needs a fast KV transfer
```

The benefits are real: each pool batches homogeneous work, so both run near their own optimum; TPOT stops being disturbed by other people's prefills; and the two pools scale independently, which matters because prompt volume and output volume move differently.

The cost is the KV transfer — 328 MB for a 2,000-token prefix. Over NVLink or InfiniBand with RDMA that's a few milliseconds and worth it. Over anything slower it isn't.

**When it's worth the complexity:** high traffic with high prompt-length variance, strict TPOT targets, or heterogeneous hardware where you genuinely want compute-dense parts for prefill and bandwidth-dense parts for decode. For a modest single-node deployment, chunked prefill in one pool is simpler and nearly as good.

:::trap Cache invalidation exists here too, and it's subtle
A cached prefix is only valid for the exact model weights that produced it. On a model upgrade, an adapter change, or a quantization change, **every cached block is garbage** — and it won't error, it will produce quietly wrong attention.

Requirements:
- Key every cache entry by `(model_version, adapter_id, quantization, tokens)`, not just the tokens.
- Flush completely on any weight change.
- Be careful with LoRA: two requests with the same prompt but different adapters have *different* K and V and must not share blocks.

This is a correctness bug with no visible symptom, which puts it in the worst category. It's worth an assertion in the cache lookup path.
:::

## Eviction

Standard LRU is wrong here, because entries differ enormously in value.

| Signal | Why it matters |
|---|---|
| **Reference count** | Never evict blocks a live request is using |
| **Recency** | LRU baseline |
| **Prefix length** | A 4,000-token cached prefix saves far more than a 100-token one |
| **Hit frequency** | A shared system prompt is worth vastly more than one user's document |
| **Recompute cost** | Scales with length and model size |

A reasonable scoring function: `value = hit_rate × recompute_cost × recency_decay`. In practice, protecting a small set of known-hot prefixes (the system prompts, the common tool definitions) explicitly, and running LRU over the rest, captures most of the benefit with far less machinery.

:::exercise Design the cache layer
A coding assistant: 30,000 daily users, each with sessions averaging 40 requests. Each request includes a 6,000-token system prompt plus tool definitions (identical for everyone), 0–50,000 tokens of file context (per-user, mostly stable within a session), and a short instruction. Served on 16 replicas.

1. KV bytes for the shared 6,000-token prefix (164 KB/token). Across 16 replicas, how much HBM does keeping it resident cost — and how much prefill does it save per day?
2. Design the cache key hierarchy. What's shared globally, what's per-user, what's per-request?
3. File context averages 20,000 tokens and changes slowly within a session. Where should it live — HBM, DRAM, or NVMe? Compute the transfer-versus-recompute crossover.
4. Design the routing. What do you hash on, and what's your load-imbalance tolerance? Justify it with the ratio from the callout above.
5. A user's session hits a replica that's at 95% memory. Walk through the options and pick one.
6. You deploy a new model version. What must happen to the cache, and how do you avoid a thundering herd of cold prefills at cutover?
:::

:::paper Sources
*SGLang: Efficient Execution of Structured Language Model Programs* (Zheng et al., NeurIPS 2024) introduced RadixAttention — prefix caching as a radix tree.

*DistServe: Disaggregating Prefill and Decoding* (Zhong et al., OSDI 2024) and *Splitwise* (Patel et al., ISCA 2024) are the disaggregation papers. *Mooncake* (Qin et al., 2024) is a production KV-cache-centric architecture with tiering, from Moonshot AI.
:::

## What to carry forward

- Three multiplying levers: **make the cache smaller, don't recompute it, put it somewhere else.**
- **A radix tree captures every shared prefix**, not just exact matches — 5×+ prefill reduction in chat.
- **Cache-affinity routing trades load balance for hit rate.** Quantify the ratio; it usually favours affinity heavily.
- **Tiering is a transfer-versus-recompute calculation** at every boundary, and it's computable.
- **Disaggregation** lets prefill and decode each run at their own optimum, at the cost of a KV transfer.
- **Key the cache by model version and adapter** — stale blocks are a silent correctness bug.
