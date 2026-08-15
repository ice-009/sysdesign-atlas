---
title: Model Parallelism
summary: Tensor, pipeline, and sequence parallelism — splitting a model that no single GPU can hold, and composing all of them into the 3D layout frontier runs actually use.
difficulty: Hard
scope: HLD
tags: [ai, distributed-training, tensor-parallel, pipeline]
prereqs: [data-parallelism, interconnect-and-collectives]
unlocks: Designing the parallelism layout for a model too large for any single device.
---

## Three ways to cut a model

[Data parallelism](data-parallelism.html) splits the *batch*. When the model itself won't fit, you split the model — and there are three orthogonal axes to split along.

```diagram
   A transformer layer's weight matrix, and the batch flowing through it:

   TENSOR PARALLEL      split the MATRIX across GPUs
                        every GPU sees every token
                        → communicates within EVERY layer

   PIPELINE PARALLEL    split the LAYERS across GPUs
                        GPU0: layers 0-19, GPU1: layers 20-39
                        → communicates only at stage boundaries

   SEQUENCE PARALLEL    split the SEQUENCE across GPUs
                        each GPU holds part of the token positions
                        → communicates within attention
```

Each has a different communication frequency, and that frequency determines which tier of the [bandwidth hierarchy](interconnect-and-collectives.html) it must live on.

## Tensor parallelism

Split the weight matrices themselves. The clever part is choosing splits so that consecutive operations need only one collective between them.

```diagram
   FFN BLOCK:   y = GeLU(x · W₁) · W₂

   Split W₁ COLUMN-wise:  W₁ = [W₁ᵃ | W₁ᵇ]
     GPU A computes  GeLU(x · W₁ᵃ)
     GPU B computes  GeLU(x · W₁ᵇ)
     → no communication needed: GeLU is elementwise, and each
       GPU has complete columns

   Split W₂ ROW-wise:     W₂ = [W₂ᵃ ]
                               [W₂ᵇ ]
     GPU A computes  GeLU(x·W₁ᵃ) · W₂ᵃ   → partial sum
     GPU B computes  GeLU(x·W₁ᵇ) · W₂ᵇ   → partial sum
     → ALL-REDUCE to sum the partials

   → ONE all-reduce for the whole FFN block, not two.
     Attention splits the same way, by head:
     each GPU owns whole heads, then one all-reduce after W_o.

   Total: 2 all-reduces per transformer layer
          (one after attention, one after FFN)
```

:::derive Why tensor parallelism must stay inside a node
```
   80-layer model, TP degree 8, hidden 8,192, batch 8,
   sequence 4,096, BF16.

   Each all-reduce moves the activation tensor:
     8 × 4,096 × 8,192 × 2 bytes  =  537 MB

   Per layer: 2 all-reduces
   Per forward pass: 160 all-reduces × 537 MB  ≈  86 GB moved

   Over NVLink at 900 GB/s:      ~95 ms   → tolerable
   Over InfiniBand at 50 GB/s:  ~1,720 ms → catastrophic

   → Tensor parallelism across nodes is roughly 18× worse.
     This is why TP degree is almost always ≤ 8 —
     the number of GPUs sharing an NVSwitch.
```
:::

**The upside is unique: tensor parallelism reduces single-request latency.** Every other form of parallelism buys throughput. TP splits the *work for one token* across GPUs, so each reads only its slice of the weights — which is exactly what [decode latency](../05-ai-foundations/inference-arithmetic.html) depends on. This makes it the primary tool for inference latency, not just for fitting large models.

## Pipeline parallelism

Assign consecutive layers to different GPUs, like stations on an assembly line, and feed the batch through in small pieces called **micro-batches** so the stations can work simultaneously rather than one at a time.

The catch is the same one every assembly line has: at the start of a run the later stations sit idle waiting for work to reach them, and at the end the earlier ones have nothing left to do. That idle time is the **bubble**.

```diagram
   4 stages, naive scheduling — the bubble problem:

   GPU0  F1 F2 F3 F4 ................ B4 B3 B2 B1
   GPU1  .. F1 F2 F3 F4 .......... B4 B3 B2 B1 ..
   GPU2  .... F1 F2 F3 F4 ...... B4 B3 B2 B1 ....
   GPU3  ...... F1 F2 F3 F4 B4 B3 B2 B1 ........
              ↑                              ↑
              warm-up bubble          drain bubble

   bubble fraction = (stages − 1) / (micro_batches + stages − 1)

     4 stages, 4 micro-batches:   3/7  = 43% idle
     4 stages, 32 micro-batches:  3/35 =  8% idle
     8 stages, 32 micro-batches:  7/39 = 18% idle
```

:::goat The bubble is why pipeline depth is limited
Bubble fraction grows with stages and shrinks with micro-batches. So deep pipelines need many micro-batches to stay efficient — but micro-batches multiply activation memory, since every in-flight micro-batch holds its activations until its backward pass.

**1F1B scheduling** (one-forward-one-backward) is the standard fix: once the pipeline is full, alternate a forward and a backward so activations are freed as early as possible. Same bubble, far less memory — which lets you run enough micro-batches to make the bubble small.

**Interleaved 1F1B** goes further: give each GPU several non-contiguous chunks of layers (GPU0 gets layers 0–9 *and* 40–49). This shortens the effective pipeline depth per pass and cuts the bubble roughly in proportion, at the cost of more inter-stage communication.

The practical rule: keep **micro-batches ≥ 4× stages**, and prefer fewer, larger stages over many small ones.
:::

Pipeline's virtue is that it communicates only at stage boundaries — one activation tensor per micro-batch per boundary. That's tiny compared to tensor parallelism, which is why **pipeline goes across nodes and tensor stays within them.**

## Sequence and context parallelism

When the sequence is the problem — long-context training — split along the token dimension.

The complication: attention needs every position to see every other position, so you can't simply partition and forget.

```diagram
   RING ATTENTION

   Sequence of 128K tokens split across 8 GPUs, 16K each.
   Each GPU holds Q, K, V for its own block.

     for step in 1..8:
       compute attention of my Q against the K,V block I currently hold
       send my K,V block to the next GPU in the ring
       receive the previous GPU's K,V block

   After 8 steps every GPU has attended over the whole sequence,
   and each held only 1/8th of the KV at any moment.

   → Communication overlaps with computation: while computing
     attention on block i, you're already sending block i+1.
     Near-free when the blocks are large enough.
```

**Sequence parallelism** in the Megatron sense is a lighter-weight relative: tensor parallelism leaves LayerNorm and dropout replicated across GPUs, wasting activation memory. Splitting those along the sequence dimension too — with all-gather/reduce-scatter around them — removes the duplication. It's a memory optimisation that composes with tensor parallelism at almost no extra communication cost.

## Composing them: 3D (and 4D) parallelism

Real frontier runs use all of these simultaneously, arranged so each communication pattern lands on appropriate hardware.

```diagram
   1,024 GPUs = 128 nodes × 8 GPUs

     TENSOR PARALLEL   = 8   within a node, over NVLink
                             (communicates every layer)
     PIPELINE PARALLEL = 8   across 8 nodes, over InfiniBand
                             (communicates per stage boundary)
     DATA PARALLEL     = 16  across the 16 remaining groups
                             (communicates once per step)

     8 × 8 × 16 = 1,024 ✓

   Rule that generates this layout:

     TP  ≤ GPUs per node          (highest frequency → fastest link)
     PP  = enough stages to fit the model in memory
     DP  = whatever's left        (lowest frequency → slowest link)
```

:::goat The ordering rule
**Match communication frequency to link speed.** That single principle generates every parallelism layout you'll see:

- Tensor parallel communicates twice per layer → the fastest link available → within a node.
- Pipeline communicates once per stage boundary per micro-batch → medium → across nearby nodes.
- Data parallel communicates once per step, and overlaps with backward → slowest → anywhere.

If you can state that rule, you can derive the standard layout rather than memorising it, and you can adapt it when the hardware changes — which is the actual skill.
:::

Add **expert parallelism** for [MoE](../05-ai-foundations/mixture-of-experts.html) and it becomes 4D. Experts are placed within a node where possible, because all-to-all is the most demanding collective there is.

## Choosing a layout

| Constraint | Response |
|---|---|
| Model fits on one GPU | No model parallelism. Use DDP or ZeRO |
| A single layer doesn't fit | Tensor parallelism, degree = ceil(layer size / GPU memory) |
| Model doesn't fit but layers do | Pipeline, or ZeRO-3 — try ZeRO-3 first, it's simpler |
| Sequence length is the constraint | Sequence/context parallelism |
| Inference latency matters | Tensor parallelism — the only one that reduces single-request latency |
| Inference throughput matters | Fewer TP shards, more replicas |

:::trap ZeRO-3 versus pipeline is not obvious, and people get it backwards
ZeRO-3 also lets a model exceed one GPU's memory, and it's far simpler — no manual layer assignment, no bubble, no schedule to tune.

Prefer **ZeRO-3** when: you have fast interconnect across all participating GPUs, the model is up to roughly 100B, and you value engineering simplicity. It's the right default.

Prefer **pipeline** when: you're crossing many nodes with limited bandwidth (pipeline moves far less data), you're beyond ~200B parameters, or ZeRO-3's frequent all-gathers are provably network-bound.

The honest heuristic: **start with ZeRO-3, measure MFU, and add pipeline only when you've demonstrated you're network-bound.** Teams routinely start with 3D parallelism because that's what the papers describe, then spend weeks tuning a schedule they didn't need.
:::

## Inference is a different problem

Everything above is framed around training. Inference changes the objective.

- **Tensor parallelism reduces TPOT** by splitting the weight read. TP=8 on a 70B model can be ~8× faster per token than TP=1 (minus collective overhead), and it's the standard way to hit aggressive latency targets.
- **Pipeline parallelism does not help latency** — a token still traverses every stage sequentially. It helps only when the model doesn't fit otherwise, and it adds inter-stage latency per token.
- **The KV cache shards with tensor parallelism**, so TP also multiplies the cache capacity available, which raises concurrency.
- **Beyond TP=8, collective overhead dominates.** More replicas beat more shards past that point.

:::exercise Design the layout
Train a 175B model on 512 GPUs of 80 GB — 64 nodes × 8, NVLink within, InfiniBand 50 GB/s across.

1. Training memory at 16 bytes/parameter. Minimum GPUs to hold it, ignoring activations.
2. Propose a TP × PP × DP layout summing to 512. Justify each factor from the frequency-to-link rule.
3. With 64 micro-batches, compute the pipeline bubble fraction for your PP degree. Would interleaved 1F1B be worth it?
4. Estimate tensor-parallel all-reduce volume per forward pass at sequence 4,096, batch 2 per GPU. Confirm it's hideable on NVLink.
5. Now serve the same model for inference at 20 ms TPOT. What layout, and how many GPUs per replica? How does it differ from the training layout, and why?
:::

:::paper Sources
*Megatron-LM: Training Multi-Billion Parameter Language Models Using Model Parallelism* (Shoeybi et al., 2019) is tensor parallelism; the follow-up *Efficient Large-Scale Language Model Training on GPU Clusters* (Narayanan et al., SC 2021) is the definitive 3D parallelism paper including the bubble analysis.

*GPipe* (Huang et al., NeurIPS 2019) and *PipeDream* (Narayanan et al., SOSP 2019) are the pipeline scheduling originals. *Ring Attention with Blockwise Transformers* (Liu, Zaharia & Abbeel, 2023) is context parallelism.
:::

## What to carry forward

- **Three orthogonal splits**: tensor (the matrices), pipeline (the layers), sequence (the tokens).
- **Tensor parallelism communicates twice per layer** → must stay on NVLink, degree ≤ 8.
- **Pipeline bubbles** = (stages−1)/(micro-batches+stages−1). Keep micro-batches ≥ 4× stages; use 1F1B.
- **Ring attention** splits long sequences with communication overlapped behind compute.
- **Match communication frequency to link speed** — that one rule generates every layout.
- **Start with ZeRO-3; add pipeline only after proving you're network-bound.**
- For inference, **only tensor parallelism reduces latency**, and only up to about 8.
