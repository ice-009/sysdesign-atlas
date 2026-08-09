---
title: GPUs & Accelerators
summary: SMs, HBM, tensor cores, and the memory hierarchy that decides your kernel's speed — plus why every accelerator vendor is fighting the same battle against memory bandwidth.
difficulty: Medium
tags: [ai, gpu, hardware, accelerators]
prereqs: [hardware-numbers, inference-arithmetic]
unlocks: Reading a GPU spec sheet and predicting how your workload will actually perform on it.
---

## What a GPU is, structurally

A CPU is optimised for latency on one thread: deep pipelines, huge caches, aggressive branch prediction and speculation, all to finish a single instruction stream as fast as possible.

A GPU is optimised for throughput across tens of thousands of threads. It gives up per-thread speed almost entirely and spends the transistor budget on parallel arithmetic units and memory bandwidth.

```diagram
   CPU (a modern server socket)      GPU (a datacenter accelerator)

     16-128 complex cores              100-150 streaming multiprocessors
     ~5 GHz, deep OoO pipelines        ~1.5-2 GHz, in-order, simple
     large L1/L2/L3 per core           small caches, huge register file
     ~100-400 GB/s memory bandwidth    ~2-8 TB/s HBM bandwidth
     latency-optimised                 throughput-optimised

   The GPU hides memory latency by having ~2,000 threads per SM
   ready to run: when one warp stalls on memory, another issues
   immediately. There is no cache to save you — there is only
   more parallelism.
```

That last sentence is the design philosophy. A CPU avoids memory stalls with caches and prefetching. A GPU accepts them and covers them with concurrency.

## The memory hierarchy that matters

```viz
{
  "type": "stack",
  "caption": "Bandwidth drops by orders of magnitude at each step. Kernel optimisation is entirely about staying high in this stack.",
  "layers": [
    { "label": "Registers", "sub": "~256 KB per SM · ~100 TB/s aggregate", "accent": "#38bdf8" },
    { "label": "Shared memory / L1", "sub": "~228 KB per SM · ~20 TB/s · programmer-controlled", "accent": "#22d3ee" },
    { "label": "L2 cache", "sub": "~50-100 MB · ~7 TB/s · shared by all SMs", "accent": "#4ade80" },
    { "label": "HBM (device memory)", "sub": "80-192 GB · 2-8 TB/s · where your weights live", "accent": "#fbbf24" },
    { "label": "Host memory over PCIe/NVLink-C2C", "sub": "TBs · 60-900 GB/s · offload territory", "accent": "#fb7185" }
  ]
}
```

**Shared memory is the one that distinguishes GPU programming.** It is a software-managed scratchpad — you explicitly stage data into it, and it's roughly 100× faster than HBM. Every high-performance GPU kernel is fundamentally an exercise in tiling work so that each tile fits in shared memory and gets reused many times before being written back.

This is exactly what FlashAttention does: rather than materialising the full `n × n` attention score matrix in HBM, it processes attention in tiles that stay in SRAM, recomputing rather than storing. The arithmetic is *higher* and the runtime is much lower, because HBM traffic — not FLOPs — was the constraint.

## Tensor cores

Standard GPU cores do scalar or short-vector FMA operations. Tensor cores do a small matrix multiply-accumulate as a single instruction.

```diagram
   CUDA core:    one fused multiply-add per cycle per lane

   Tensor core:  D = A × B + C  for small matrices (e.g. 16×8×16)
                 in one instruction

   → roughly an order of magnitude more FLOP/s for
     matrix-shaped work

   Consequences that bite:

     · Only matrix multiplication benefits. Elementwise
       operations, softmax, normalisation, and activations
       run on the ordinary cores and are usually
       memory-bound anyway.

     · Dimensions must align to the tensor core tile (multiples
       of 8 or 16). A hidden size of 4,096 is fast; 4,090 can
       fall off the fast path entirely.

     · Lower precision means more throughput: FP8 is typically
       2× FP16, which is ~2× FP32.
```

:::goat Peak TFLOPS is a marketing number for inference
Advertised peak assumes dense tensor-core matrix multiplication at the lowest supported precision, perfectly shaped and perfectly fed.

Real workloads achieve:
- **Training: 35–55% of peak** (this is MFU — model FLOPs utilisation — and 50% is considered excellent)
- **Prefill: 40–60% of peak**
- **Decode at batch 1: under 1% of peak**, because it's bandwidth-bound

For inference, the three numbers that predict performance are **memory bandwidth** (sets time-per-token), **memory capacity** (sets concurrency), and **interconnect bandwidth** (sets how well you can shard). A GPU with double the FLOPS and identical bandwidth decodes at exactly the same speed.
:::

## Reading a spec sheet

The comparison that matters, in rough current-generation terms:

| Property | What it determines | Typical range |
|---|---|---|
| **HBM capacity** | Model size + KV cache = concurrency | 80–192 GB |
| **HBM bandwidth** | Decode latency, directly | 2–8 TB/s |
| **BF16/FP8 dense TFLOPS** | Prefill and training speed | 500–5,000 |
| **NVLink bandwidth** | Tensor-parallel scaling within a node | 400–1,800 GB/s |
| **Network per GPU** | Multi-node training scaling | 200–800 Gb/s |
| **Power** | Datacenter density and cost | 400–1,200 W |

:::derive Which GPU for which job
```
   Workload: serve a 70B model at FP8 (70 GB) to many users

     Need: capacity > 70 GB + KV cache
           bandwidth as high as possible (decode latency)
           FLOPS: secondary

     → capacity and bandwidth win; a high-FLOPS,
       low-bandwidth part is the wrong purchase


   Workload: pretrain a model for months

     Need: FLOPS (this is compute-bound)
           interconnect (gradient all-reduce every step)
           capacity: matters, but parallelism can compensate

     → FLOPS and interconnect win


   The same accelerator is rarely optimal for both, which is
   why fleets are heterogeneous and why "inference GPUs" and
   "training GPUs" are increasingly different products.
```
:::

## Power, cooling, and why they became architectural

A modern accelerator draws up to ~1,200 W. Eight in a node is ~10 kW before CPUs, networking, and storage.

```diagram
   Traditional air-cooled datacenter rack:   6-15 kW
   One 8-GPU AI node:                        ~10-14 kW

   → ONE node fills a conventional rack.

   Consequences:
     · liquid cooling is no longer exotic, it's required
     · power delivery is a hard constraint on how many
       GPUs fit in a building
     · you cannot simply add GPUs to an existing datacenter
     · "GPU shortage" is frequently a power and cooling
       shortage wearing a different name
```

This is why capacity planning for AI infrastructure involves megawatts and lead times measured in quarters, not an autoscaling group. It's also why [autoscaling GPU capacity is slow](gpu-cluster-scheduling.html) in a way that has no equivalent in stateless web serving.

## Multi-instance GPU and sharing

A whole accelerator is wasteful for a small model. Three sharing mechanisms, with real differences:

| Mechanism | Isolation | Notes |
|---|---|---|
| **MIG (hardware partitioning)** | Strong — separate SMs, cache slices, and memory paths | Fixed partition sizes; must be configured before workloads start; genuine QoS |
| **Time slicing** | Weak — contexts swap on the same hardware | Easy, no config; noisy neighbours affect each other's latency badly |
| **MPS (multi-process service)** | Medium — concurrent kernels, shared memory space | Better utilisation than time slicing, no memory protection |

For multi-tenant inference where you must guarantee latency, **MIG** is the only one that actually isolates. For a research cluster where fairness matters more than predictability, time slicing is fine.

## The other accelerators

| Accelerator | Distinguishing idea |
|---|---|
| **TPU** | Systolic array rather than SMs; very high matmul density; 2D/3D torus interconnect that scales to thousands of chips without a switch fabric |
| **Trainium / Inferentia** | AWS silicon; cost-optimised per unit of throughput; requires its own compiler stack |
| **AMD Instinct** | Competitive hardware, particularly on memory capacity; the gap is software maturity, and ROCm has been closing it |
| **Groq / Cerebras** | Bet on enormous on-chip SRAM instead of HBM — eliminating the bandwidth bottleneck entirely for models that fit |

That last row is the interesting architectural bet. If decode is bandwidth-bound because weights live in HBM, then putting the weights in SRAM — hundreds of megabytes of it, or a whole wafer's worth — removes the bottleneck rather than optimising around it. The constraint becomes total on-chip memory, so it works for models that fit and not at all for models that don't.

:::trap CUDA is the actual moat, and it's a real cost
Competitive silicon exists. The gap is the software: CUDA has fifteen years of kernels, libraries, profilers, and — crucially — every framework, inference engine, and research codebase assumes it.

Porting a training stack to a different accelerator is usually weeks to months of work, and you inherit whatever kernel coverage the vendor has for your specific operations. The bill for a cheaper accelerator includes that engineering time and the ongoing cost of being a smaller user base when something breaks.

This is improving — PyTorch's compiler backends, Triton, and OpenXLA all abstract over hardware — but "cheaper per FLOP" and "cheaper in total" remain different claims.
:::

## Exercise

:::exercise Choose hardware from requirements
You must serve a 70B model at FP8 to 500 concurrent users, average 4,000-token conversations, target TPOT under 30 ms. Two options: GPU A has 80 GB at 3.4 TB/s and 1,000 TFLOP/s FP8; GPU B has 192 GB at 8 TB/s and 2,500 TFLOP/s FP8, at 2.4× the hourly price.

1. Weight memory and KV cache needed (assume 164 KB/token). How many of each GPU do you need to hold it all?
2. TPOT for each configuration, assuming tensor parallelism across the GPUs you counted.
3. Cost per hour for each configuration. Cost per million output tokens?
4. Which is cheaper? Does the answer change at 50 concurrent users instead of 500 — and why?
5. Your traffic is bursty, peaking at 3× average for two hours a day. How does that change the calculation, given that GPU capacity cannot be scaled in minutes?
:::

:::paper Sources
The NVIDIA CUDA C++ Programming Guide's memory-hierarchy chapters are the primary reference, dry but authoritative.

*FlashAttention* (Dao et al., NeurIPS 2022) is the clearest demonstration of trading FLOPs for HBM traffic. *In-Datacenter Performance Analysis of a Tensor Processing Unit* (Jouppi et al., ISCA 2017) is the TPU paper and an unusually good piece of systems writing on why the architecture looks the way it does.
:::

## What to carry forward

- GPUs are **throughput machines** that hide memory latency with thousands of threads, not caches.
- **Shared memory is the lever** — high-performance kernels tile work to stay out of HBM. FlashAttention is the canonical example.
- **Tensor cores only accelerate matmul**, and want aligned dimensions.
- For inference, judge on **bandwidth, capacity, interconnect** — not peak TFLOPS.
- **Power and cooling are hard constraints**; one 8-GPU node fills a conventional rack.
- **MIG is the only sharing mechanism with real isolation.**
- **CUDA is the moat**; a cheaper accelerator has an engineering bill attached.
