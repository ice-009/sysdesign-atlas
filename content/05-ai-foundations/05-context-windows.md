---
title: Context Windows & Long Context
summary: How position is encoded, why attention cost is quadratic and memory cost is linear, and what actually breaks when you extend a model to a million tokens.
difficulty: Hard
scope: Core
tags: [ai, context, attention, rope]
prereqs: [attention-and-kv-cache, inference-arithmetic]
unlocks: Deciding between long context and retrieval on cost and quality grounds rather than marketing.
---

## Two different costs, often conflated

"Context window" is quoted as a single number, but extending it stresses two separate resources with different growth rates.

```diagram
   Sequence length n:

     ATTENTION COMPUTE     O(n²)     every token attends to every token
     KV CACHE MEMORY       O(n)      one K,V per token per layer

   Doubling context:      4× the attention work,  2× the memory
   10× the context:     100× the attention work, 10× the memory
```

Both matter, at different points. Memory binds first in serving, because it limits how many *concurrent* requests fit. Compute binds during prefill, because it sets time-to-first-token for a long prompt.

:::derive What a million-token context actually costs
```
   Model: 80 layers, 8 KV heads (GQA), head_dim 128, FP8

   MEMORY
     per token = 2 × 80 × 8 × 128 × 1 byte  =  164 KB
     1,000,000 tokens × 164 KB  =  164 GB of KV cache

     → for ONE request. Two 80 GB GPUs hold nothing else.

   PREFILL COMPUTE (70B model, ~2 FLOP/param/token)
     2 × 70e9 × 1e6  =  1.4e17 FLOPs
     at 2,000 TFLOP/s effective (8 GPUs, good MFU):
       70 seconds of pure prefill

   ATTENTION, on top of that, is quadratic in n and becomes
   a significant additional term at this length.

   → A single million-token request occupies a multi-GPU node
     for over a minute before emitting one token.
```
:::

That arithmetic is why long-context pricing is superlinear, why providers meter cached versus uncached input separately, and why "we support 1M tokens" and "you should use 1M tokens" are entirely different claims.

## How the model knows where a token is

Attention is permutation-invariant on its own: shuffle the tokens and the raw mechanism computes the same thing. Position must be injected explicitly, and how it's injected determines whether the model can handle sequences longer than it saw in training.

| Scheme | Mechanism | Extrapolates? |
|---|---|---|
| **Learned absolute** | A trainable embedding per position, added to the input | No — position 5,000 has no embedding if you trained to 4,096 |
| **Sinusoidal** | Fixed sin/cos of position, added to the input | Poorly in practice |
| **ALiBi** | Add a distance-proportional penalty to attention scores | Yes, gracefully |
| **RoPE** | Rotate Q and K by an angle proportional to position | Yes, with adjustment — the modern default |

**RoPE** (rotary position embedding) is what nearly everything uses. Rather than adding a position vector, it rotates the query and key vectors in 2D subspaces by an angle proportional to their position.

```diagram
   Rotate Q at position m by angle m·θ
   Rotate K at position n by angle n·θ

   Their dot product then depends on the rotation difference:

     Q_m · K_n  ∝  cos((m − n)·θ)
                        ─────
                        RELATIVE distance only

   → The model learns "how far apart", not "which absolute slots".
     Different frequencies θ across dimension pairs give it both
     fine-grained local and coarse long-range position sense.
```

The relative property is what makes extension possible at all: a model that only ever learned relative distances has some chance of generalising to distances it hasn't seen.

## Extending a trained model's context

You rarely retrain from scratch to get longer context. Three techniques, in increasing sophistication:

- **Position interpolation.** Scale positions down so 8,000 tokens map into the 4,000-position range the model was trained on. Works, but compresses local resolution — the model becomes slightly worse at fine-grained nearby relationships.
- **NTK-aware scaling.** Scale the *frequencies* rather than the positions, and scale high-frequency (local) and low-frequency (global) components differently. Preserves local precision while extending range.
- **YaRN.** A refined frequency-scaling scheme plus a temperature correction on attention. The current standard for extending RoPE models, and it works with a short fine-tune on long sequences rather than full retraining.

All of them need some fine-tuning on long data to work well. **None of them make the quadratic attention cost go away** — they change what the model can meaningfully use, not what it costs to run.

## Sparse and windowed attention

If full attention is quadratic, attend to less.

```diagram
   FULL              SLIDING WINDOW      WITH SINKS       DILATED
   ■■■■■■■■          ■□□□□□□□            ■□□□□□□□         ■□■□■□■□
   ■■■■■■■■          ■■□□□□□□            ■■□□□□□□         □■□■□■□■
   ■■■■■■■■          ■■■□□□□□            ■■■□□□□□         ■□■□■□■□
   ■■■■■■■■          □■■■□□□□            ■□■■□□□□         □■□■□■□■
                     └ window = 3        └ always keep
   O(n²)             O(n·w)                the first few    O(n·log n)
                                           "sink" tokens
```

**Attention sinks** are the surprising and important detail. When a sliding window evicts the earliest tokens, model quality collapses — far more than the lost information should account for. The cause: the model has learned to dump excess attention probability onto the first few tokens, which act as a no-op sink because softmax must sum to one. Remove them and the attention distribution is forced onto tokens that don't deserve it.

Keeping four initial tokens permanently, plus a sliding window, restores quality almost entirely (StreamingLLM). It's an excellent example of an emergent behaviour that only shows up as a systems constraint.

**Hybrid layer stacks** are where production models landed: alternate a few full-attention layers with many sliding-window layers. You get long-range capability from the full layers and linear-ish cost from the rest, with the KV cache for windowed layers bounded by the window rather than the sequence.

## Long context versus retrieval

The design question that actually comes up.

```viz
{
  "type": "compare",
  "caption": "Not a rivalry — they solve different problems and are frequently combined.",
  "left": {
    "title": "Long context",
    "items": [
      "Model sees everything; no relevance decision",
      "Cross-document reasoning works naturally",
      "Cost is superlinear in content size",
      "TTFT grows with every token you add",
      "Hard cap; no answer beyond the window"
    ]
  },
  "right": {
    "title": "Retrieval",
    "items": [
      "Only relevant chunks enter the prompt",
      "Cost is roughly flat in corpus size",
      "Scales to corpora no window could hold",
      "Adds retrieval latency and infrastructure",
      "Quality is capped by retrieval quality"
    ]
  }
}
```

:::goat The economics decide it more often than the quality does
For a 10 MB corpus (~2.5M tokens), stuffing everything into context on every request costs roughly a thousand times more than retrieving the relevant 5,000 tokens — *per request*. At any real traffic level that difference dominates every other consideration.

Long context earns its cost in specific shapes: a single large document the user just uploaded, a coding session where the whole repository context genuinely matters, or an agent trajectory that must remain coherent. It is a poor substitute for retrieval over a corpus, and an excellent complement to it — retrieve broadly, then let a long window reason over more retrieved material than a short one could hold.

The mature architecture is usually **retrieval into a long window**, not one or the other.
:::

## What degrades before the limit does

A model advertising 200K tokens does not use all 200K equally well.

**Lost in the middle.** Retrieval accuracy is high for content at the start and end of a long context and measurably lower in the middle. Practical consequence: put the most important material at the beginning or the very end of the prompt, not buried at position 90,000.

**Needle-in-a-haystack passes, reasoning fails.** Finding one distinctive fact in a long context is much easier than combining five facts scattered across it. Benchmarks that only test retrieval overstate usable context length considerably.

**Distraction.** Irrelevant content in the window measurably degrades answers, even when the relevant content is present. More context is not monotonically better — a precise 4,000-token prompt often beats a 100,000-token one containing the same information plus noise.

:::trap "Bigger context window means I don't need retrieval"
Three separate reasons this doesn't hold:

1. **Cost.** Superlinear in content, paid on every single request.
2. **Latency.** TTFT grows with prompt length, and users notice a seven-second wait before the first token.
3. **Quality.** Effective usable context is well below advertised context, and irrelevant content actively hurts.

What large windows genuinely changed is that retrieval can now be *less precise* — return 20 chunks rather than 3 and let the model sort it out. That's a real improvement, and it's an improvement to retrieval systems, not a replacement for them.
:::

## Exercise

:::exercise Choose an architecture
A legal product needs to answer questions over contract sets. Typical set: 50 contracts × 20 pages × 500 words ≈ 375,000 tokens. Queries usually concern 2–3 contracts, but some need cross-contract comparison.

1. Estimate the KV cache to hold all 375,000 tokens (80 layers, 8 KV heads, head_dim 128, FP8). How many GPUs is that for one request?
2. Estimate prefill time for a 70B model on 8 GPUs at 2,000 TFLOP/s effective. Is that an acceptable TTFT?
3. Cost per query, full context versus retrieving 8,000 tokens, at any current pricing. What's the ratio?
4. Prefix caching: the contract set is stable across a user's session of ~15 queries. How does that change (2) and (3), and what has to be true about routing for it to work?
5. Design the actual system. Where do you use retrieval, where long context, and how do you handle the cross-contract comparison case that retrieval will do badly on?
:::

:::paper Sources
*RoFormer: Enhanced Transformer with Rotary Position Embedding* (Su et al., 2021) is RoPE. *YaRN: Efficient Context Window Extension* (Peng et al., ICLR 2024) is the current extension standard.

*Efficient Streaming Language Models with Attention Sinks* (Xiao et al., ICLR 2024) is the sink phenomenon. *Lost in the Middle* (Liu et al., TACL 2024) is the positional-degradation study, and *RULER* (Hsieh et al., 2024) shows how far effective context falls short of advertised context.
:::

## What to carry forward

- Context costs **O(n²) compute and O(n) memory** — different resources, binding at different times.
- **RoPE encodes relative position by rotation**, which is what makes extension possible; YaRN is how it's done.
- **Sparse and windowed attention** trade range for cost; **attention sinks** are required for windowing to work.
- **Effective context is well below advertised context**, and irrelevant content degrades answers.
- **Retrieval into a long window** beats either alone. The deciding factor is usually cost per request, not quality.
