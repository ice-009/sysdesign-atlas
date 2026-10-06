---
title: The Transformer as a System
summary: What a forward pass actually does, where the parameters and the FLOPs live, and why prefill and decode are two completely different workloads running the same code.
difficulty: Medium
scope: Core
tags: [ai, transformer, architecture, inference]
prereqs: [tokenization, hardware-numbers]
unlocks: Reasoning about model execution as a resource-consumption problem rather than a black box.
---

:::predict Guess first
1. Inside a transformer, which part holds most of the parameters — attention or the feed-forward network?
2. Producing one token for one user means reading every weight. Could the same read produce tokens for 64 users?
3. If you store a model's weights in 1 byte instead of 2, would generating text get faster even though the maths is the same?
:::

## What we need from this

You do not need to be able to derive the training mathematics to design AI infrastructure. You need to know, precisely:

- Where the **parameters** live — the model's learned numbers, billions of them, and every one occupies GPU memory you pay for
- Where the **arithmetic** happens, because that's compute
- Which parts have **state that persists across tokens**, because that's the KV cache
- Which operations are **compute-bound** versus **memory-bandwidth-bound**, because that determines everything about batching

That's the whole agenda. The mathematics is a means to those four answers.

## The shape of a forward pass

```viz
{
  "type": "stack",
  "caption": "One forward pass. The middle block repeats 32-100+ times.",
  "layers": [
    { "label": "Token IDs → embeddings", "sub": "lookup table: vocab × d_model", "accent": "#38bdf8" },
    { "label": "× N layers: attention", "sub": "tokens exchange information — the only place they interact", "accent": "#a78bfa" },
    { "label": "× N layers: feed-forward", "sub": "per-token computation — most of the parameters", "accent": "#4ade80" },
    { "label": "Final norm → unembedding", "sub": "d_model → vocab logits", "accent": "#fbbf24" },
    { "label": "Sample", "sub": "logits → one token", "accent": "#fb7185" }
  ]
}
```

The essential structural fact: **attention is the only operation where tokens see each other.** Everything else — the feed-forward network, normalisation, the embedding lookup — operates on each token position independently.

That single asymmetry drives the entire system design. Independent per-token work parallelises trivially and needs no state. Attention needs every previous token's state, which is why the KV cache exists and why memory rather than compute ends up being the binding constraint.

## The residual stream

A useful mental model: each token position carries a running list of numbers with it through the whole model — the **residual stream**. Its length is called `d_model`, typically 4,096 or 8,192, and it's fixed for a given model. Every block *reads* that list, computes something from it, and *adds* the result back in.

```diagram
   Position i's residual stream, flowing down through layers:

     x  ──┬─────────────────────────────► + ──┬──────────────► + ──► ...
          │                               ▲   │                ▲
          └─► LayerNorm ─► Attention ─────┘   └─► LN ─► FFN ───┘
                          (reads OTHER            (reads only
                           positions)              position i)

   Nothing overwrites. Every block ADDS a contribution.
```

Two consequences worth holding onto:

1. **Gradients flow straight through the additions**, which is what makes 100-layer networks trainable at all. This is the ResNet insight applied to sequences.
2. **The stream is the interface.** Layers communicate only through it, which is why techniques like LoRA (adding a low-rank update to a weight matrix) and activation steering (adding a vector to the stream) work without retraining anything else.

## Attention, in the terms that matter for infrastructure

For each position, the model computes three projections from the residual stream:

```diagram
   Query  Q = x·W_q     "what am I looking for?"
   Key    K = x·W_k     "what do I offer to others?"
   Value  V = x·W_v     "what do I contribute if selected?"

   attention(Q,K,V) = softmax( Q·Kᵀ / √d_head ) · V
                       ─────────────────────
                       score of every position
                       against every position

   Causal masking: position i may only attend to positions ≤ i.
   That is what makes generation possible — position i's output
   does not depend on anything after it.
```

The three infrastructure-relevant facts:

**The score matrix is quadratic.** For a sequence of length `n`, `Q·Kᵀ` is `n × n` per head per layer. Doubling the context quadruples this work. A 100K-token prompt produces a 10-billion-entry score matrix per head — which is why nobody materialises it, and why FlashAttention (computing it in tiles that stay in on-chip SRAM) mattered so much.

**K and V for past tokens never change.** Because of causal masking, position 5's key and value are identical whether the sequence is 6 tokens long or 6,000. So you compute them once and cache them. That cache is the [KV cache](attention-and-kv-cache.html), and it is the dominant consumer of GPU memory in serving.

**Q for the current token is all you need to move forward.** During generation you have one new query attending over a cached set of keys and values. This is a tiny amount of arithmetic against a large amount of memory — the defining characteristic of the decode phase.

## Where the parameters live

```diagram
   Per layer, for d_model = d, FFN hidden = 4d:

     Attention:  W_q, W_k, W_v, W_o   →  4 × d²      params
     FFN:        W_up (d→4d), W_down (4d→d)
                                      →  8 × d²      params
                                        ────────────
     Total per layer                  ≈ 12 × d²

   → The feed-forward network holds TWO THIRDS of the
     parameters. Attention gets all the attention; the FFN
     gets most of the memory and most of the FLOPs.
```

:::derive Parameter count for a 70B-class model
```
   d_model = 8,192      layers = 80      vocab = 128,000

   Per layer:      12 × 8,192²  =  12 × 67.1M   ≈  805M
   All layers:     805M × 80                    ≈ 64.4B
   Embedding:      128,000 × 8,192              ≈  1.05B
   Unembedding:    128,000 × 8,192              ≈  1.05B
                                                  ───────
   Total                                        ≈ 66.5B

   Memory for weights:
     FP32 (4 bytes)   ≈ 266 GB   → needs 4 GPUs just to hold it
     BF16 (2 bytes)   ≈ 133 GB   → 2 GPUs
     FP8  (1 byte)    ≈  67 GB   → fits one 80 GB GPU, barely
     INT4 (0.5 byte)  ≈  33 GB   → comfortable, with quality cost

   → Precision is not a micro-optimisation. It decides how many
     GPUs you need, which decides your cost per token.
```
:::

This is why [quantization](quantization.html) is a first-order infrastructure concern rather than a research curiosity.

## The two phases

The same weights, the same code, and two workloads with opposite performance characteristics.

```viz
{
  "type": "compare",
  "caption": "Same model, same kernel, opposite bottlenecks. Everything in serving follows from this.",
  "left": {
    "title": "PREFILL — process the prompt",
    "items": [
      "All prompt positions in parallel",
      "Big matrix × big matrix",
      "High arithmetic intensity",
      "COMPUTE-BOUND — GPU saturated",
      "Produces the first output token"
    ]
  },
  "right": {
    "title": "DECODE — generate the rest",
    "items": [
      "One position per forward pass",
      "Big matrix × single vector",
      "Reads every weight to emit one token",
      "MEMORY-BANDWIDTH-BOUND — GPU idle",
      "Repeats once per output token"
    ]
  }
}
```

:::goat The single most important sentence in AI infrastructure
**Decoding one request at a time wastes almost the entire GPU.**

A decode step must stream all 133 GB of weights from HBM to produce a single token. The arithmetic involved is trivial — a matrix-vector product per layer. The GPU's compute units sit nearly idle while the memory bus works flat out.

But if you're reading all the weights anyway, you can multiply them against *64 different token vectors* for almost exactly the same cost. The weights are read once and amortised across the whole batch.

**This is why batching in LLM serving is not an optimisation. It is the difference between a viable service and an unaffordable one** — and it's the same amortisation argument as [group commit](../04-data/wal-and-durability.html) in a database, with a much steeper payoff.
:::

The arithmetic behind that claim is worked out in [inference arithmetic](inference-arithmetic.html), which is the next page and the one that makes all of this quantitative.

## Variations you'll encounter

| Variation | Change | Why |
|---|---|---|
| **Pre-norm** | Normalise before each block rather than after | Trains stably at depth; universal in modern models |
| **RMSNorm** | Drop the mean-centring from LayerNorm | Same quality, cheaper |
| **SwiGLU** | Gated activation; FFN hidden ≈ 8/3·d across three matrices | Better quality per parameter |
| **RoPE** | Rotate Q and K by position rather than adding a position embedding | Relative positions, extrapolates better — see [context windows](context-windows.html) |
| **GQA / MQA** | Several query heads share one K/V head | **Shrinks the KV cache several-fold** — the biggest serving win of the last few years |
| **MoE** | Many FFN experts; route each token to a few | Many more parameters, same FLOPs per token — see [mixture of experts](mixture-of-experts.html) |

Grouped-query attention is the one to notice. It is a modest quality tradeoff for a large reduction in KV cache size, and because KV cache is what limits concurrency, it directly multiplies how many users one GPU can serve.

:::trap "Bigger model = proportionally slower"
Not in the regime that matters. Decode is memory-bandwidth-bound, so decode latency scales with **bytes of weights read**, not with FLOPs.

A model with 2× the parameters at the same precision is roughly 2× slower to decode. But the same model quantized from BF16 to FP8 is roughly **2× faster**, despite being mathematically identical in structure — because you halved the bytes crossing the memory bus.

This is why quantization gives speedups that look impossible if you're thinking in FLOPs, and it's the clearest sign that you should be thinking in bytes instead.
:::

## Exercise

:::exercise Size a model yourself
For a model with `d_model = 4,096`, 32 layers, vocabulary 32,000:

1. Estimate the total parameter count using `12 × d²` per layer plus embeddings. Compare to the published size of a 7B-class model — how close is the approximation, and what does it omit?
2. How much GPU memory do the weights need at BF16? At FP8? Which GPUs can hold it, leaving room for activations and KV cache?
3. Attention is 4·d² per layer and the FFN is 8·d². If you doubled only the FFN width, what happens to parameters, to FLOPs per token, and to decode latency?
4. During decode, roughly how many bytes must cross the memory bus per token at BF16? On a GPU with 3 TB/s of bandwidth, what does that imply for maximum tokens/second for a single request — and does batching change that number?
:::

Check your reasoning on (4): you read essentially all the weights, so ~14 GB at BF16; at 3 TB/s that's ~4.7 ms per token, about 210 tokens/s. Batching does *not* change per-token latency — it multiplies total throughput, because the same weight read serves every request in the batch.

:::paper Sources
*Attention Is All You Need* (Vaswani et al., NeurIPS 2017) is the original architecture. *The Illustrated Transformer* (Jay Alammar) is the best visual explanation.

For the infrastructure-relevant view: *FlashAttention* (Dao et al., 2022) on why the quadratic score matrix is never materialised, and *GQA: Training Generalized Multi-Query Transformer Models* (Ainslie et al., 2023) for the KV cache reduction.
:::

## Check yourself

```recall
Q: What four things does infrastructure need from the transformer?
A: Where the parameters live (memory), where the arithmetic happens (compute), what state persists across tokens (the KV cache), and which operations are compute- versus bandwidth-bound (batching).

Q: What is the one place tokens interact?
A: Attention. Feed-forward, normalisation and embedding lookups work on each position independently, which is why only attention needs past state.

Q: What is the residual stream?
A: A running vector of d_model numbers carried by each position; every block reads it and adds its result back. It makes deep networks trainable and is why LoRA and activation steering work.

Q: Why can past keys and values be cached?
A: Causal masking means a position's K and V never change as the sequence grows, so compute them once — the KV cache, the dominant consumer of serving memory.

Q: Where do the parameters live in a layer?
A: About 12d² per layer: attention 4d² (Q, K, V, O) and the FFN 8d². The FFN holds two thirds of parameters and FLOPs.

Q: How much memory does a 70B-class model need for weights?
A: About 266 GB in FP32, 133 GB in BF16, 67 GB in FP8 and 33 GB in INT4 — precision decides how many GPUs you need.

Q: Why is batching the most important idea in serving?
A: Decode streams every weight to produce one token, leaving compute idle; the same weight read can serve a whole batch at almost no extra cost.

Q: What does decode latency scale with?
A: Bytes of weights read, not FLOPs — so a model quantized from BF16 to FP8 decodes about 2× faster. Grouped-query attention shrinks the KV cache several-fold.
```

## What to carry forward

- **Attention is the only place tokens interact.** Everything else is per-position and embarrassingly parallel.
- The **residual stream** is the interface; every block reads it and adds back.
- **The FFN holds two thirds of the parameters and FLOPs**, despite attention getting the attention.
- **Past K and V never change** → cache them → that cache dominates serving memory.
- **Prefill is compute-bound; decode is memory-bandwidth-bound.** The same code, opposite bottlenecks.
- **Decode latency scales with bytes of weights**, not FLOPs — which is why quantization is a speedup.
