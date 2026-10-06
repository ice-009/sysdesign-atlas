---
title: Data Parallelism & ZeRO
summary: Replicating the model across GPUs, why optimizer state is the memory hog, and how sharding it turns a technique that hits a wall at 1B parameters into one that trains 500B.
difficulty: Hard
scope: HLD
tags: [ai, distributed-training, zero, fsdp]
prereqs: [interconnect-and-collectives, transformer-as-a-system]
unlocks: The default parallelism strategy, and knowing exactly where it stops working.
---

:::predict Guess first
1. Training a 7B model needs about 112 GB of memory but its weights are only 14 GB. What do you think fills the rest?
2. With 64 GPUs each holding an identical copy of the optimizer's statistics, is there a way to stop storing 64 copies?
3. If you double the number of GPUs and keep the per-GPU batch, has the training changed — or only got faster?
:::

## The simple version

Put a full copy of the model on every GPU and give each one a different slice of the training examples. Each computes its **gradients** — the adjustments it thinks the weights need, based on the examples it saw. Average those across all GPUs, and every copy applies the identical average, so the replicas never drift apart.

That averaging step is the entire cost of data parallelism, and everything below is about making it cheaper.

```diagram
   GPU 0: full model, batch slice 0 → gradients g₀
   GPU 1: full model, batch slice 1 → gradients g₁
   GPU 2: full model, batch slice 2 → gradients g₂
   GPU 3: full model, batch slice 3 → gradients g₃
                          ↓
            ALL-REDUCE:  ḡ = (g₀+g₁+g₂+g₃)/4
                          ↓
   every GPU applies the same ḡ → replicas stay in sync
```

It's simple, it's the default, and it scales remarkably well — up to the point where the model no longer fits on one GPU. That point arrives much sooner than people expect.

## Why it hits a wall

The wall is not the weights. It's everything else training requires — and most of that is **optimizer state**. The optimizer doesn't just apply each gradient; it keeps running statistics per parameter (how that weight has been trending, and how erratic it's been) so it can adapt the step size. Adam, the standard choice, keeps two such numbers per parameter, in full precision, which ends up dwarfing the model itself.

:::derive The memory bill for training
```
   P parameters, BF16 compute with an Adam optimizer:

     weights                 2P bytes
     gradients               2P bytes
     Adam momentum (FP32)    4P bytes
     Adam variance (FP32)    4P bytes
     FP32 master weights     4P bytes
                            ─────────
     total                  16P bytes    (before activations)

   For a 7B model:   16 × 7e9  = 112 GB
   For a 13B model:  16 × 13e9 = 208 GB
   For a 70B model:  16 × 70e9 = 1.12 TB

   → An 80 GB GPU cannot data-parallel train a 7B model.
     The weights are only 14 GB of that 112 GB —
     OPTIMIZER STATE IS 75% OF THE BILL.
```
:::

:::goat The observation that unlocked large-model training
Every one of those N GPUs is holding an **identical copy** of the optimizer state. That's N copies of the same 12P bytes, and there is no reason for it — each GPU only needs the optimizer state for the parameters it's about to update.

ZeRO (Zero Redundancy Optimizer) removes the duplication: shard the optimizer state, then the gradients, then the parameters themselves across the data-parallel group, and gather what you need, when you need it, then throw it away.

The reframe is that data parallelism was never really about replication — it was about *convenience*. Once you're willing to pay some communication to avoid redundancy, the same technique trains models an order of magnitude larger.
:::

## The ZeRO stages

```viz
{
  "type": "steps",
  "caption": "Each stage shards more and communicates more. Stage 3 is FSDP.",
  "steps": [
    { "label": "Stage 0", "sub": "plain DDP — everything replicated · 16P bytes/GPU", "accent": "#38bdf8" },
    { "label": "Stage 1", "sub": "shard optimizer state · 4P + 12P/N", "accent": "#22d3ee" },
    { "label": "Stage 2", "sub": "+ shard gradients · 2P + 14P/N", "accent": "#4ade80" },
    { "label": "Stage 3", "sub": "+ shard parameters · 16P/N", "accent": "#a78bfa" }
  ]
}
```

:::derive Memory per GPU at each stage
```
   7B model (P = 7e9), 64 GPUs, 16P bytes total = 112 GB

   Stage 0 (DDP)   16P            = 112 GB    ✗ doesn't fit
   Stage 1          4P + 12P/N    =  28 + 1.75  = 29.8 GB  ✓
   Stage 2          2P + 14P/N    =  14 + 2.04  = 16.0 GB  ✓
   Stage 3         16P/N          =        1.75 =  1.8 GB  ✓

   Stage 3 at 64 GPUs uses 1.6% of the memory DDP needs.
   The same arithmetic on a 175B model:
     Stage 3, 1,024 GPUs:  16 × 175e9 / 1024  ≈  2.7 GB/GPU
```
:::

**Stage 3 is the interesting one**, because sharding parameters means no GPU holds the full model. Before computing a layer, the GPUs all-gather that layer's parameters; after computing, they discard them.

```diagram
   ZeRO-3 forward pass, per layer:

     all-gather layer L's parameters from all ranks
     compute layer L
     free the gathered parameters immediately
     → move to layer L+1

   Backward pass: the same, plus a reduce-scatter of gradients.

   Communication per step ≈ 1.5× DDP's all-reduce volume,
   but spread across many small operations rather than one
   large one — which makes it easier to overlap and harder
   to make efficient.
```

**FSDP** (Fully Sharded Data Parallel) is PyTorch's native implementation of the same idea, organised around wrapping modules rather than a separate library. Same mechanics, different ergonomics, and it's what most new PyTorch code uses.

## The communication cost, honestly

| Strategy | Memory per GPU | Communication per step |
|---|---|---|
| DDP | 16P | 2P (one all-reduce) |
| ZeRO-1 | 4P + 12P/N | 2P |
| ZeRO-2 | 2P + 14P/N | 2P |
| ZeRO-3 | 16P/N | ~3P (gathers in fwd + bwd, plus reduce-scatter) |

ZeRO-3 costs roughly 1.5× the communication for a ~10× memory reduction at scale. On NVLink that trade is almost free. Across nodes on a slow fabric it can dominate the step time.

**Practical rule:** use the *lowest* stage that fits. If ZeRO-2 fits your model, don't pay for stage 3. Many teams reach for FSDP by default and are network-bound for no reason.

## Activation memory, the other half

Everything above is parameter-related. Activations — the intermediate values saved during forward for use in backward — are a separate and often larger term.

:::derive Activation memory
```
   Roughly:  batch × seq_len × d_model × layers × bytes × k

   where k ≈ 10-20 depending on what the framework saves.

   batch 8, seq 4,096, d_model 8,192, 80 layers, BF16, k = 12:

     8 × 4,096 × 8,192 × 80 × 2 × 12  ≈  515 GB

   → Activations alone exceed the parameter memory by a
     wide margin at long sequence lengths.
```
:::

**Activation checkpointing** (also called gradient checkpointing) is the standard answer: don't save intermediate activations; save only the input to each transformer block, and recompute the rest during backward.

```
   Memory:  O(layers) → O(√layers) or just the block boundaries
   Compute: +33% (one extra forward pass through each block)

   → Almost always worth it. Trading a third more compute for
     a several-fold memory reduction is a good deal when
     memory is what's stopping you from running at all.
```

**Sequence-length scaling is the thing to watch.** Activation memory is linear in sequence length (and attention's is quadratic without FlashAttention). Doubling context doubles this term, which is why long-context training needs sequence parallelism — covered in [model parallelism](model-parallelism.html).

## Batch size and the correctness question

Data parallelism multiplies the effective batch size: 64 GPUs × 16 per GPU = 1,024 global batch. That's a *training dynamics* change, not just a throughput change.

- **Learning rate must scale.** Linear scaling (LR ∝ batch size) with a warmup period is the standard recipe. Without it, large-batch training diverges or converges worse.
- **Large batches generalise worse**, past a point. There's a critical batch size beyond which more parallelism buys throughput and costs sample efficiency — you take fewer, better-estimated steps, and the total tokens needed goes up.
- **Gradient accumulation** decouples the two: run *k* micro-batches, accumulate gradients, all-reduce once. This gets you a large effective batch on few GPUs, and it reduces communication frequency by *k*.

:::trap Scaling efficiency is not measured in GPUs
"We scaled to 512 GPUs" says nothing without efficiency. The number that matters:

```
   scaling efficiency = throughput(N GPUs) / (N × throughput(1 GPU))
```

At 60% efficiency on 512 GPUs, you're getting 307 GPUs of work and paying for 512. The missing 40% is communication that didn't overlap, stragglers, and load imbalance.

Report **MFU** (model FLOPs utilisation) instead — actual useful FLOPs divided by peak. It's honest and comparable across cluster sizes. 40–50% MFU on a large training run is good; below 30% means something is wrong and worth a day of investigation.
:::

## When data parallelism is not enough

```diagram
   Decision path:

     Model fits on one GPU with optimizer state?
       → DDP. Simplest, fastest. Stop here.

     Model fits, optimizer state doesn't?
       → ZeRO-1 or 2. Cheap, no extra communication.

     Model weights don't fit on one GPU?
       → ZeRO-3 / FSDP. Works surprisingly far.

     ZeRO-3 is network-bound, or a single LAYER doesn't fit?
       → Tensor parallelism within a node.

     Still too large, or too many nodes for ZeRO-3?
       → Add pipeline parallelism across nodes.

     Sequence length is the constraint?
       → Sequence / context parallelism.
```

Real frontier training runs combine all of these — "3D parallelism" — with data parallelism as the outermost dimension. That composition is the subject of the next page.

:::exercise Plan a training run
Train a 13B model on 128 GPUs of 80 GB, BF16, Adam. NVLink within 8-GPU nodes, InfiniBand at 50 GB/s across.

1. Total training memory at 16P bytes. Per-GPU memory under DDP, ZeRO-1, ZeRO-2, ZeRO-3. Which fit?
2. At sequence length 8,192 and micro-batch 4, estimate activation memory per GPU (use k=12, d_model=5,120, 40 layers). Does your chosen stage still fit? What does activation checkpointing change?
3. Communication per step for ZeRO-2 versus ZeRO-3. If a step computes for 350 ms, which is hideable?
4. Global batch size at micro-batch 4 across 128 GPUs. Is that above the critical batch size for a 13B model? What would you do about it — and what does gradient accumulation change?
5. You measure 28% MFU. List four things you'd check, in order.
:::

:::paper Sources
*ZeRO: Memory Optimizations Toward Training Trillion Parameter Models* (Rajbhandari et al., SC 2020) is the original and unusually clear about the memory accounting.

*PyTorch FSDP: Experiences on Scaling Fully Sharded Data Parallel* (Zhao et al., VLDB 2023) is the production write-up. *Training Deep Nets with Sublinear Memory Cost* (Chen et al., 2016) is activation checkpointing. *An Empirical Model of Large-Batch Training* (McCandlish et al., 2018) is the critical-batch-size result.
:::

## Check yourself

```recall
Q: What is the memory bill for training with Adam?
A: ~16 bytes per parameter: BF16 weights and gradients (2 + 2), FP32 momentum and variance (4 + 4) and FP32 master weights (4). For 7B that's 112 GB, 75% of it optimizer state.

Q: What insight does ZeRO exploit?
A: Every data-parallel GPU holds an identical copy of optimizer state, gradients and parameters. Shard them across the group and gather each piece only when needed.

Q: Give the ZeRO stages and their memory per GPU.
A: Stage 1 shards optimizer state (4P + 12P/N), stage 2 adds gradients (2P + 14P/N), stage 3 adds parameters (16P/N) — 7B on 64 GPUs drops from 112 GB to ~1.8 GB.

Q: What does ZeRO-3 cost, and what is the practical rule?
A: About 1.5× DDP's communication — all-gathers in forward and backward plus a reduce-scatter — in many small operations. Use the lowest stage that fits.

Q: What is activation checkpointing?
A: Save only each block's input and recompute the rest during backward: ~33% more compute for a large memory cut. Activations can exceed parameter memory at long sequence lengths.

Q: How does data parallelism change training dynamics?
A: It multiplies the global batch: scale the learning rate (linear scaling with warmup), watch the critical batch size beyond which sample efficiency drops, and use gradient accumulation to decouple batch from GPU count.

Q: Why report MFU instead of GPU count?
A: Useful FLOPs ÷ peak is honest and comparable; 60% scaling efficiency on 512 GPUs is 307 GPUs of work. 40–50% MFU is good, under 30% means investigate.

Q: When do you move beyond data parallelism?
A: When ZeRO-3 is network-bound or a single layer doesn't fit (add tensor parallelism in-node), too many nodes (add pipeline), or sequence length binds (sequence parallelism).
```

## What to carry forward

- **Optimizer state is 75% of the training memory bill**, not the weights.
- **ZeRO shards the redundant copies**: stage 1 optimizer, stage 2 gradients, stage 3 parameters.
- **Use the lowest stage that fits.** Stage 3 costs ~1.5× communication for ~10× memory.
- **Activations are a separate, often larger term.** Checkpointing trades 33% compute for a large memory win.
- **Large batches change training dynamics** — scale the learning rate, watch the critical batch size.
- **Report MFU, not GPU count.** 40–50% is good; under 30% means investigate.
