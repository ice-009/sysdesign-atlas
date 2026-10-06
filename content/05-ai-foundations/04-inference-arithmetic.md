---
title: The Arithmetic of Inference
summary: FLOPs per token, memory bandwidth, arithmetic intensity, and the roofline model — the calculations that tell you what a GPU can actually serve before you buy one.
difficulty: Hard
scope: Core
tags: [ai, performance, roofline, capacity]
prereqs: [attention-and-kv-cache, hardware-numbers, back-of-envelope]
unlocks: Predicting throughput, latency, and cost from a model spec and a GPU spec.
---

:::predict Guess first
1. A GPU can do about 1,000 trillion operations a second but fetch only about 3 trillion bytes. How many operations must you do per byte to keep it busy?
2. Serving 64 users at once instead of one — does each user's time per token get slower?
3. Should you compare GPUs for inference mainly on their TFLOPS rating?
:::

## The two numbers a GPU has

Every performance question about inference reduces to a comparison between two hardware capabilities: how fast the chip can calculate, and how fast it can fetch the numbers to calculate with.

A **FLOP** is one floating-point operation — a single multiply or add. Chips are rated in TFLOP/s, trillions of them per second.

```diagram
   A representative modern datacenter GPU:

     Compute:    ~1,000 TFLOP/s  (trillion operations per second)
     Bandwidth:  ~3 TB/s          (memory → compute units)

   Ratio:  1,000e12 FLOP/s ÷ 3e12 byte/s  ≈  330 FLOP per byte

   → To keep the compute units busy, you must do roughly
     330 floating-point operations for every byte you read
     from memory.

     Do fewer, and the GPU is idle waiting on memory.
```

That ratio — often called the machine balance — is the whole story. **A workload's job is to clear 330 FLOP/byte, or it will be memory-bound**, and modern accelerators have been getting *worse* at this over time: compute has grown faster than bandwidth for a decade, so the threshold keeps rising.

## Arithmetic intensity

**Arithmetic intensity** is how much calculating an operation does per byte it reads — operations divided by bytes moved. Compare that single number against the machine's 330 and you immediately know which resource is your limit: below it you're waiting on memory, above it you're waiting on the maths.

```viz
{
  "type": "axes",
  "caption": "The roofline. Below the machine balance you are bandwidth-limited, and adding compute does nothing.",
  "x": "arithmetic intensity (FLOP/byte) →",
  "y": "achieved throughput →",
  "z": "ridge point",
  "xs": "decode ≈ 1-2 · prefill ≈ 100s",
  "ys": "bandwidth-limited, then flat",
  "zs": "≈ 330 FLOP/byte"
}
```

Now compute it for the two phases.

:::derive Prefill versus decode intensity
```
   MODEL:  P parameters, BF16 (2 bytes each)

   Rule of thumb: a forward pass costs ≈ 2 FLOPs per parameter
   per token (one multiply + one add per weight).

   ── PREFILL, batch of B sequences × L tokens each ──

     FLOPs  = 2 × P × (B × L)
     Bytes  = 2 × P            ← weights read ONCE for the whole batch

     intensity = 2·P·(B·L) / (2·P)  =  B × L

     With B=8, L=1,000  →  intensity = 8,000 FLOP/byte
     8,000 ≫ 330        →  COMPUTE-BOUND, GPU saturated ✓

   ── DECODE, batch of B sequences, 1 token each ──

     FLOPs  = 2 × P × B
     Bytes  = 2 × P            ← still read ALL the weights

     intensity = 2·P·B / (2·P)  =  B

     With B=1    →  intensity = 1     ← 330× below the ridge!
     With B=64   →  intensity = 64    ← still 5× below
     With B=330  →  intensity = 330   ← finally at the ridge
```
:::

:::goat The number that justifies everything in LLM serving
**Arithmetic intensity during decode is exactly the batch size.**

At batch size 1, a GPU rated for 1,000 TFLOP/s delivers about 3 TFLOP/s of useful work — **0.3% utilisation**. You are paying for a supercomputer to run a memory copy.

Every technique in inference serving — continuous batching, chunked prefill, speculative decoding, MoE routing — is an attempt to raise this one number. And it explains why the answer to "our GPU is slow" is almost never "buy a faster GPU": you are not using the one you have.
:::

## Decode latency, from first principles

Because decode is bandwidth-bound, per-token latency follows directly from the weight bytes.

:::derive Time per output token
```
   TPOT ≈ bytes_of_weights / memory_bandwidth

   70B model, BF16 (140 GB), 3 TB/s:
     140e9 / 3e12  =  46.7 ms per token   ← way too slow
                                             for one GPU

   Same model at FP8 (70 GB):
     70e9 / 3e12   =  23.3 ms per token   ← 2× faster, same maths

   Same model, FP8, split across 4 GPUs with tensor parallelism
   (each holds 17.5 GB, all read in parallel):
     17.5e9 / 3e12 =  5.8 ms per token    ≈ 170 tokens/s

   Reality check: multiply by ~1.3-1.6 for attention over the KV
   cache, kernel launch overhead, and collective communication.
     → ~8-9 ms per token in practice, ~110-125 tokens/s
```
:::

Three conclusions that fall straight out:

1. **Quantization is a latency optimisation, not just a memory one.** Halving the bytes halves the time, because the bottleneck is bytes.
2. **Tensor parallelism reduces latency for a single request** — unusual, since parallelism normally buys throughput. It works here because each GPU reads only its slice, in parallel.
3. **Batch size does not change TPOT.** The same weight read serves the whole batch, so 64 users each get ~8 ms/token while total throughput is 64× higher. This is the most counter-intuitive fact in serving, and the reason throughput is nearly free until memory runs out.

## Time to first token

TTFT is a different calculation, because prefill is compute-bound.

:::derive TTFT for a long prompt
```
   TTFT ≈ queue_wait + (2 × P × prompt_tokens) / effective_FLOPS

   70B model, 2,000-token prompt, 4 GPUs at ~600 TFLOP/s
   effective each (real chips hit ~60% of their
   advertised peak — that fraction is called MFU):

     FLOPs = 2 × 70e9 × 2,000  =  2.8e14
     Time  = 2.8e14 / (4 × 600e12)  =  117 ms

   Plus queue wait, which under load dominates everything above.
```
:::

| Prompt length | Prefill compute | Note |
|---:|---:|---|
| 100 tokens | ~6 ms | Negligible |
| 2,000 tokens | ~117 ms | Noticeable |
| 32,000 tokens | ~1.9 s | Users feel this |
| 128,000 tokens | ~7.5 s | Plus quadratic attention on top |

**TTFT scales with prompt length; TPOT does not.** So a RAG system that stuffs 30,000 tokens of retrieved context into every prompt has made a TTFT decision, not a quality decision — and it should be measured as one.

## Putting it together: what one GPU serves

:::derive Full capacity estimate
```
   SETUP
     8× GPU node, 80 GB each = 640 GB total
     70B model, FP8 = 70 GB, tensor-parallel across all 8
       → 8.75 GB of weights per GPU
     Remaining per GPU: 80 − 8.75 − 6 (activations, workspace)
       ≈ 65 GB × 8  =  520 GB for KV cache

   KV CACHE (GQA, 8 kv heads, 80 layers, head_dim 128, FP8)
     per token = 2 × 80 × 8 × 128 × 1  =  164 KB
     520 GB / 164 KB  ≈  3.2 million tokens of cache

   CONCURRENCY
     average conversation 4,000 tokens
     3.2M / 4,000  ≈  790 concurrent conversations

   THROUGHPUT
     TPOT ≈ 8.75 GB / 3 TB/s × 1.4 overhead  ≈  4 ms
     Per-request rate: 250 tokens/s
     But batch is capped by scheduler, say 256 concurrent decodes:
       256 × 250  =  64,000 output tokens/s

   SANITY CHECK against the roofline
     intensity = batch = 256, vs ridge 330 → still slightly
     memory-bound. Consistent. Larger batches would improve
     throughput but worsen TTFT.
```
:::

That last line is the operating tension, and it never goes away.

:::goat TTFT and throughput are in direct opposition
Bigger batches raise arithmetic intensity, which raises throughput, which lowers cost per token. Bigger batches also mean longer queues, which raises TTFT.

**There is no setting that optimises both.** Production systems resolve it by splitting traffic into lanes — small batches for interactive requests, large batches for bulk and background jobs — and pricing them differently. If someone offers you a batch API at a discount, this is why: they are running your work in the high-intensity lane.
:::

## Cost per token

:::derive Deriving the price
```
   8× GPU node at roughly $30/hour (rented, on-demand)
   64,000 output tokens/s sustained at 100% utilisation

     tokens/hour  =  64,000 × 3,600  =  230M
     cost/1M output tokens = $30 / 230  =  $0.13

   At a realistic 40% average utilisation:
     $0.13 / 0.4  =  $0.33 per 1M output tokens

   Input tokens are far cheaper: prefill is compute-bound and
   batches efficiently, typically 3-5× cheaper per token.
   Cached input is cheaper again — it skips prefill entirely.
```
:::

**Utilisation is the dominant term.** Halving your utilisation doubles your unit cost, which is why traffic shaping, batch lanes, and multi-tenancy matter far more to margin than a 10% kernel improvement. This gets developed in the [AI cost model](../06-ai-infrastructure/ai-cost-model.html).

:::trap Comparing GPUs on TFLOPS
For inference, peak TFLOPS is close to irrelevant — decode never gets near it. The numbers that predict your serving performance are:

1. **Memory bandwidth** — sets TPOT
2. **Memory capacity** — sets concurrency
3. **Interconnect bandwidth** — sets how well tensor parallelism scales

A GPU with 2× the FLOPS and the same bandwidth will decode at the *same speed*. One with 1.5× the bandwidth is 1.5× faster on the workload that matters. Vendors lead with FLOPS because it's the larger number.
:::

## Exercise

:::exercise Estimate a deployment
A 13B model, BF16, on a single 80 GB GPU with 2 TB/s bandwidth and 400 TFLOP/s. GQA with 8 KV heads, 40 layers, head_dim 128.

1. Weight memory? Remaining for KV cache after 5 GB of overhead?
2. KV bytes per token, and total tokens of cache that fit?
3. TPOT for a single request. Does it change at batch 32?
4. What batch size do you need to reach the ridge point? Can you fit that many 2,000-token conversations in memory — and if not, which resource binds first?
5. TTFT for a 4,000-token prompt at 50% MFU.
6. Now quantize to FP8. Redo (1)–(3). Which improved most, and why?
:::

Worth checking: in (4) most people find *memory* binds before they reach compute saturation, which is the normal situation and the reason KV cache reduction is the highest-leverage optimisation available.

:::paper Sources
*Roofline: An Insightful Visual Performance Model for Multicore Architectures* (Williams, Waterman & Patterson, CACM 2009) is the model this page applies.

*Efficiently Scaling Transformer Inference* (Pope et al., MLSys 2023) is the definitive analytical treatment of inference cost, including the batch-size and parallelism tradeoffs. Kipply Chen's "Transformer Inference Arithmetic" is the most accessible write-up of the same maths.
:::

## Check yourself

```recall
Q: What is machine balance, and why does it matter?
A: Compute ÷ bandwidth — about 1,000 TFLOP/s ÷ 3 TB/s ≈ 330 FLOP per byte. Workloads below it wait on memory; above it they wait on maths.

Q: What is the arithmetic intensity of prefill and of decode?
A: Prefill: batch × prompt length (thousands — compute-bound). Decode: exactly the batch size — 1 at batch 1, which is ~0.3% utilisation.

Q: How do you estimate time per output token?
A: TPOT ≈ weight bytes ÷ memory bandwidth (×1.3–1.6 for overheads). A 70B model is ~47 ms in BF16, ~23 ms in FP8, ~6 ms split four ways by tensor parallelism.

Q: What changes TPOT, and what doesn't?
A: Quantization and tensor parallelism reduce it (fewer bytes per GPU); batch size doesn't, because one weight read serves the whole batch — so throughput is nearly free until memory runs out.

Q: How do you estimate time to first token?
A: Queue wait + 2 × parameters × prompt tokens ÷ effective FLOPS. It scales with prompt length — a 32K-token prompt on a 70B model is ~1.9 s — so stuffing long context is a TTFT decision.

Q: Why are throughput and TTFT in tension?
A: Bigger batches raise intensity and throughput (cheaper tokens) but lengthen queues (worse TTFT). Systems split interactive and bulk lanes — hence discounted batch APIs.

Q: What dominates cost per token?
A: Utilisation: an 8-GPU node at ~$30/hour serving 64,000 tokens/s costs ~$0.13 per million output tokens at full load, ~$0.33 at 40%. Input is cheaper; cached input cheaper still.

Q: Which GPU specs predict inference performance?
A: Memory bandwidth (TPOT), memory capacity (concurrency) and interconnect bandwidth (tensor-parallel scaling) — not peak TFLOPS, which decode never approaches.
```

## What to carry forward

- Compare **arithmetic intensity** against the machine balance (~330 FLOP/byte) to know your bottleneck.
- **Prefill intensity = batch × length** (compute-bound). **Decode intensity = batch** (memory-bound).
- **TPOT ≈ weight bytes / bandwidth.** Quantization and tensor parallelism both reduce it; batch size does not.
- **TTFT scales with prompt length**; TPOT doesn't. Long retrieved context is a TTFT decision.
- **Throughput and TTFT are in direct tension.** Separate lanes rather than seeking one setting.
- **Utilisation dominates cost per token** — more than any kernel-level optimisation.
- Judge GPUs on **bandwidth, capacity, and interconnect**, not TFLOPS.
