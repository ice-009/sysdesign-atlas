---
title: Mixture of Experts
summary: Decoupling parameter count from compute per token — how sparse routing works, why it complicates serving far more than dense models, and what expert parallelism costs.
difficulty: Hard
tags: [ai, moe, sparsity, routing]
prereqs: [transformer-as-a-system, inference-arithmetic]
unlocks: Understanding why frontier models are sparse, and what that does to your serving infrastructure.
---

## The constraint MoE breaks

In a dense transformer, every parameter participates in every token. So capacity and compute are welded together: a model with 10× the parameters costs 10× the FLOPs per token.

Mixture of Experts breaks the weld. Replace each feed-forward block with *many* feed-forward blocks — "experts" — and route each token to only a few of them.

```diagram
   DENSE FFN                        MoE FFN

   x ──► [ one FFN, 4d wide ] ──►   x ──► [router] ──┬─► [expert 1]
                                                     ├─► [expert 2]  ← chosen
         every token uses                            ├─► [expert 3]
         every parameter                             ├─► ...
                                                     └─► [expert 64] ← chosen
                                                          ↓
                                          weighted sum of the 2 chosen

   64 experts, top-2 routing:
     parameters:  64× a dense FFN
     FLOPs/token:  2× a dense FFN
     → 32× more capacity for 2× the compute
```

:::derive The sparse advantage, in numbers
```
   Dense 70B model:
     total parameters       70B
     active per token       70B
     FLOPs per token     ≈ 140 GFLOP

   Sparse model, 8 experts, top-2, sized to similar active count:
     total parameters      400B
     active per token       50B
     FLOPs per token     ≈ 100 GFLOP

   → 5.7× the parameters (capacity)
     at 0.7× the compute per token

   The catch, which is the whole story for serving:
     ALL 400B parameters must be RESIDENT IN MEMORY,
     because you don't know in advance which experts
     the next token will need.
```
:::

**That's the trade in one line: MoE converts a compute problem into a memory problem.** For training, where you're compute-bound, this is an enormous win. For inference, where you're already memory-bound, it is much more ambiguous — and it's why MoE serving infrastructure looks so different from dense serving.

## Routing

A small learned router — usually one linear layer — scores each expert for each token and picks the top *k*.

```diagram
   For each token's hidden state x:

     scores = softmax(x · W_router)      → one score per expert
     pick top-k (typically k = 1 or 2)
     output = Σ  score_i × expert_i(x)   over the chosen experts
              ─────────
              gate weights, so gradients reach the router

   Routing is per TOKEN, per LAYER.
   A sequence of 1,000 tokens through 60 MoE layers makes
   60,000 independent routing decisions.
```

That last point is what makes MoE serving hard: **routing is data-dependent and changes every token**, so you cannot precompute which experts a request will need.

## Load balancing, the central training problem

Left alone, routing collapses. A slightly better expert gets picked more often, receives more gradient, gets better still, and ends up receiving nearly all traffic while the others atrophy.

```diagram
   WITHOUT balancing                 WITH an auxiliary loss

   expert 1  ████████████████ 71%    expert 1  ███ 13%
   expert 2  ███ 14%                 expert 2  ███ 12%
   expert 3  █ 6%                    expert 3  ███ 13%
   expert 4  █ 4%                    expert 4  ███ 12%
   ...       (dead)                  ...       (all ~12.5%)

   → you paid for 8 experts and trained 1.5
```

The standard fix is an **auxiliary load-balancing loss** added to the training objective, penalising the correlation between how often an expert is chosen and how confidently it's chosen. It works, and it trades a little model quality for balance — a genuine cost, since you're optimising for something other than prediction.

**Capacity factor** is the other mechanism: cap how many tokens any single expert may accept per batch. Tokens beyond the cap are *dropped* — they skip the FFN entirely and pass through on the residual connection.

:::trap Token dropping is real and mostly invisible
With a capacity factor of 1.25, an expert accepts at most 1.25× its fair share. Overflow tokens receive no FFN computation in that layer at all.

At training time this is a regulariser and broadly fine. At **inference** time it's a correctness problem: the same input can produce different outputs depending on what else is in the batch, because batch composition determines which tokens overflow.

Production inference systems therefore either use a large capacity factor, or drop-free routing that reassigns overflow to the next-best expert. If you ever see nondeterministic outputs from an MoE model at temperature 0, this is the first thing to check.
:::

## Serving MoE: three genuine problems

### 1. Memory is the whole game

All experts must be resident. A 400B-parameter MoE at FP8 needs 400 GB — five 80 GB GPUs minimum, before KV cache. Meanwhile a dense model with the same *active* parameter count needs 50 GB.

You are paying for eight times the memory to get the quality of a much larger model at the compute cost of a small one. Whether that's a good deal depends entirely on whether your GPUs are memory-limited or compute-limited — and in inference they're almost always memory-limited.

### 2. Expert parallelism and all-to-all

Experts get distributed across GPUs. Each token must then travel to whichever GPU holds its chosen expert, and the results must come back.

```diagram
   EXPERT PARALLELISM, 8 GPUs, 64 experts (8 each)

     each GPU embeds its own tokens
       ↓
     ALL-TO-ALL:  every GPU sends each token to the GPU
                  holding its routed expert
       ↓
     each GPU runs its experts on whatever it received
       ↓
     ALL-TO-ALL:  send results back to the originating GPU
       ↓
     continue to the next layer

   TWO all-to-all collectives PER MoE LAYER.
   60 MoE layers → 120 all-to-all operations per forward pass.
```

All-to-all is the most demanding collective there is — every node talks to every other node. On NVLink inside a node it's tolerable; across nodes over InfiniBand it becomes the dominant cost. This is why MoE serving strongly prefers to keep expert parallelism *within* a node, and why interconnect bandwidth matters even more for MoE than for dense models. See [interconnect and collectives](../06-ai-infrastructure/interconnect-and-collectives.html).

### 3. Load imbalance at inference

Balancing losses shape the *average* over training. A single inference batch can still be badly skewed — if all requests are code, the code-ish experts get hammered while others idle.

```diagram
   Batch of 64 tokens, 8 GPUs holding 8 experts each:

     GPU 0:  31 tokens routed here   ← everyone waits for this
     GPU 1:   3 tokens
     GPU 2:   1 token
     ...
     GPU 7:   0 tokens

   The step takes as long as GPU 0. The other seven are idle.
   Effective utilisation: ~25%.
```

Mitigations: larger batches (averaging smooths skew), replicating hot experts across GPUs, or dynamically rebalancing expert placement based on observed traffic. None of them fully solves it, and MoE serving efficiency is genuinely harder to achieve than dense.

## Design variations

| Choice | Options | Effect |
|---|---|---|
| **Experts per layer** | 8 to 256+ | More = more capacity, worse balance, more all-to-all |
| **Top-k** | 1 or 2, occasionally more | k=1 halves compute and communication; k=2 gives better quality and gradient flow |
| **Shared expert** | One expert every token always uses | Captures common patterns; lets routed experts specialise |
| **Fine-grained experts** | Many small experts rather than few large | More routing combinations, better specialisation |
| **MoE layer frequency** | Every layer, or every other | Alternating reduces communication substantially at modest quality cost |
| **Routing granularity** | Per token, or per sequence | Per-sequence routing is far cheaper to serve and less expressive |

Recent frontier designs (DeepSeek-V3, Mixtral, and others) converged on **many fine-grained experts plus a shared expert**, which balances better and specialises more than a few large experts.

:::goat When MoE is the wrong choice
MoE is the right architecture when you are **compute-limited and memory-rich** — which describes large-scale training precisely.

It is frequently the wrong choice for inference on constrained hardware:

- Batch size 1, memory-limited: you pay for all the parameters and get the FLOPs of a small model, with the worst of both. A dense model of the same memory footprint would be strictly better.
- Edge or single-GPU deployment: the memory requirement alone rules it out.
- Latency-critical serving: two all-to-all collectives per layer add real, hard-to-hide latency.

MoE earns its keep at high batch sizes on multi-GPU nodes with fast interconnect, where the memory is amortised across many concurrent requests and communication overlaps with compute. That's a specific operating regime, not a general improvement.
:::

## Exercise

:::exercise Compare two deployments
Model A: dense, 70B parameters. Model B: MoE, 8 experts, top-2, 300B total, ~55B active. Both FP8, on 80 GB GPUs with 3 TB/s bandwidth.

1. Minimum GPUs to hold weights for each? What's left for KV cache in each case?
2. Estimate TPOT for each at batch 1. Which is faster, and why is that surprising relative to their parameter counts?
3. At batch 128, how does the comparison change? Which resource binds in each?
4. Model B is served with expert parallelism across 4 GPUs. How many all-to-all operations per token, given 60 MoE layers? At 10 µs per collective, what does that add to TPOT?
5. Your traffic is 80% code queries. Sketch what the routing distribution probably looks like and what it does to utilisation. Propose two mitigations and say what each costs.
:::

:::paper Sources
*Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer* (Shazeer et al., ICLR 2017) is the original. *Switch Transformers* (Fedus, Zoph & Shazeer, JMLR 2022) simplified it to top-1 and is the most readable treatment of the balancing problem.

*GShard* (Lepikhin et al., 2021) introduced capacity factors and expert parallelism. *Mixtral of Experts* (Jiang et al., 2024) and the *DeepSeek-V3 Technical Report* (2024) document the fine-grained plus shared-expert design now in use.
:::

## What to carry forward

- MoE **decouples capacity from compute per token** — many parameters, few active.
- It **converts a compute problem into a memory problem**: all experts must be resident.
- **Routing is per token, per layer, and data-dependent** — nothing can be precomputed.
- **Load balancing needs an auxiliary loss**; capacity factors cause token dropping, which is a correctness issue at inference.
- **Two all-to-all collectives per MoE layer** make interconnect bandwidth decisive.
- MoE wins at **high batch, multi-GPU, fast interconnect**. At batch 1 on limited memory, a dense model of the same footprint is better.
