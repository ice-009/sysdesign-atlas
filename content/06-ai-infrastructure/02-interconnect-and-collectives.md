---
title: Interconnect & Collective Operations
summary: NVLink, InfiniBand, and the all-reduce — why the network between GPUs determines how large a model you can train, and why bandwidth hierarchy dictates parallelism strategy.
difficulty: Hard
scope: HLD
tags: [ai, networking, nccl, collectives, distributed-training]
prereqs: [gpus, networking]
unlocks: Choosing a parallelism strategy from the shape of the interconnect rather than by convention.
---

:::predict Guess first
1. GPUs inside one server talk at ~900 GB/s; across servers at ~50 GB/s. Which kind of model parallelism should go where?
2. In a ring all-reduce, does each GPU send more data when you add more GPUs?
3. One GPU in a 1,000-GPU job runs 10% slower. How much slower does the whole job run?
:::

## The hierarchy that decides everything

Multi-GPU work is constrained by a bandwidth hierarchy spanning three orders of magnitude.

A **node** here is one physical server holding 8 GPUs. The names below are just the wires between things — NVLink is the dedicated GPU-to-GPU link inside a server, PCIe is the general-purpose bus to the CPU, InfiniBand is the fast network between servers.

```diagram
   Within one GPU:      its own memory    2-8 TB/s
   GPU ↔ GPU, in node:  NVLink        400-1,800 GB/s
   GPU ↔ CPU:           PCIe               ~64 GB/s
   Node ↔ node:         InfiniBand     25-100 GB/s per GPU
   Across datacenters:  wide-area net   <1 GB/s, high latency

   → Each step down is roughly 5-10× worse.

   Every parallelism decision in distributed training is
   an attempt to keep chatty communication on a fast tier
   and infrequent communication on a slow one.
```

That's the whole design principle, and it explains the standard configuration you'll see everywhere: **tensor parallelism inside a node** (needs to communicate every layer, so it must sit on NVLink), **pipeline and data parallelism across nodes** (communicate at stage boundaries or once per step, so InfiniBand suffices).

## The collectives

A **collective** is an operation that all the GPUs perform together — not one sending to one, but the whole group participating to reach a shared result. Distributed training uses a small vocabulary of them, and knowing what each costs is enough to reason about any parallelism scheme.

```diagram
   Four GPUs, each starting with data [A] [B] [C] [D]

   ALL-REDUCE      every GPU ends with A+B+C+D
                   → gradient averaging in data parallelism
                   → the workhorse; most traffic in most jobs

   REDUCE-SCATTER  GPU_i ends with the i-th shard of A+B+C+D
                   → half of an all-reduce

   ALL-GATHER      every GPU ends with [A][B][C][D] concatenated
                   → the other half; used by ZeRO/FSDP to
                     reassemble sharded weights

   ALL-TO-ALL      GPU_i sends a different piece to every GPU
                   → MoE expert routing; the most demanding

   BROADCAST       one GPU's data goes to all
                   → distributing initial weights

   Note:  all-reduce  ==  reduce-scatter  then  all-gather
```

## The cost of an all-reduce

The obvious way — everyone sends their numbers to one designated GPU, which adds them up and sends the answer back — puts all the traffic through a single machine, and gets worse the more GPUs you add.

**Ring all-reduce** avoids that by arranging the GPUs in a circle where each only ever talks to its neighbour, passing partial sums around. No one is a bottleneck, and remarkably, the amount each GPU sends barely changes as the ring grows.

:::derive Ring all-reduce bandwidth cost
```
   N GPUs in a logical ring, S bytes of gradient each.

   Phase 1 — reduce-scatter:  N−1 steps, each GPU sends S/N
   Phase 2 — all-gather:      N−1 steps, each GPU sends S/N

   Total sent per GPU = 2 × (N−1)/N × S  ≈  2S  for large N

   → The data volume per GPU is INDEPENDENT of N.
     Adding GPUs does not increase per-GPU traffic.

   Time = 2 × (N−1)/N × S / bandwidth  +  2(N−1) × latency
          ─────────────────────────       ──────────────────
          bandwidth term                  latency term
          (constant in N)                 (grows with N)

   Concretely: 7B model, BF16 gradients = 14 GB
     over NVLink at 900 GB/s:   2 × 14 / 900   ≈  31 ms
     over InfiniBand at 50 GB/s: 2 × 14 / 50   ≈  560 ms

   If a training step's compute is 200 ms, the first is
   hideable and the second dominates the step.
```
:::

:::goat The property that makes data parallelism scale at all
Ring all-reduce moves ~2S bytes per GPU **regardless of how many GPUs you have**. That constant is why data-parallel training scales to thousands of GPUs without the network collapsing.

The catch is the **latency term**: `2(N−1)` sequential hops. At 1,000 GPUs with 5 µs per hop, that's 10 ms of pure latency before any bytes move. This is why large clusters use **tree** or **hierarchical** algorithms — reduce within each node over NVLink first, then a much smaller ring across nodes — turning `O(N)` hops into `O(log N)` or `O(nodes)`.

NCCL picks among ring, tree, and hybrid algorithms automatically based on message size and topology. When someone says "we tuned NCCL", this is usually what they tuned.
:::

## The physical fabrics

| Fabric | Bandwidth | Where |
|---|---|---|
| **NVLink** | 400–1,800 GB/s aggregate per GPU | GPU-to-GPU inside a node, via NVSwitch |
| **NVLink C2C** | ~900 GB/s | CPU-to-GPU on integrated superchips |
| **PCIe 5.0 x16** | ~64 GB/s | Host to device; the bottleneck for offload |
| **InfiniBand NDR** | 400 Gb/s (~50 GB/s) per port | Node to node in HPC-class clusters |
| **RoCE** | Similar, over Ethernet | Node to node where Ethernet is preferred |

Two properties of the node-to-node fabric matter as much as raw bandwidth:

**RDMA** lets one node's network card write directly into another node's GPU memory, with no CPU involvement and no copy through host memory. GPUDirect RDMA is what makes multi-node training viable — without it, every gradient crosses PCIe to the CPU, over the network, and back across PCIe.

**Lossless delivery.** InfiniBand provides credit-based flow control, so packets are never dropped due to congestion. Collectives are extremely sensitive to loss: a single retransmission stalls every participant, because all-reduce cannot complete until the slowest member arrives. RoCE needs Priority Flow Control configured correctly to approximate this, and misconfigured PFC is one of the classic causes of a cluster that trains at half its expected speed.

Ethernet has been closing the gap. Meta built two 24,000-GPU clusters for Llama 3 — one on InfiniBand, one on RoCE — and reported comparable training performance once the RoCE fabric was tuned. The Ultra Ethernet Consortium published its 1.0 specification in 2025: a transport designed for AI traffic, with multipath packet spraying and congestion control that tolerate loss better than classic RoCE. Expect Ethernet-based fabrics to be the common choice for new clusters, with InfiniBand where its maturity is worth the price.

## Topology

```diagram
   FAT-TREE (typical GPU cluster)

              ┌── spine ──┐
          ┌───┴──┐    ┌───┴──┐
        leaf    leaf leaf   leaf
         │       │    │      │
       nodes   nodes nodes  nodes

   Full bisection bandwidth: any node can talk to any other
   at line rate. Expensive — switch cost grows superlinearly.

   RAIL-OPTIMISED (what large AI clusters actually build)

     GPU 0 of every node → switch 0
     GPU 1 of every node → switch 1
     ...
     GPU 7 of every node → switch 7

   Rationale: in tensor+data parallelism, GPU_i on node A
   mostly talks to GPU_i on node B (same rank in the
   data-parallel group). Give those a dedicated rail
   and you get most of the benefit of full bisection
   at a fraction of the switch cost.
```

The rail-optimised design is a good example of infrastructure shaped by the *specific* communication pattern of the workload. It's cheaper because it's less general.

:::trap Topology-unaware placement can halve your throughput
Two jobs, identical code, identical GPU count. One gets eight GPUs on one node; the other gets one GPU on each of eight nodes. The first communicates over NVLink at 900 GB/s; the second over InfiniBand at 50 GB/s.

The second job can be several times slower, and nothing in the code or the logs says why.

This is why GPU schedulers must be **topology-aware** and why gang scheduling with placement constraints is mandatory rather than nice-to-have. "Give me 8 GPUs" is an incomplete request; "give me 8 GPUs on one node, or on nodes sharing a leaf switch" is the real requirement. See [GPU cluster scheduling](gpu-cluster-scheduling.html).
:::

## Overlapping communication with compute

Communication you can hide is communication you don't pay for.

```diagram
   NAIVE                          OVERLAPPED

   ├─ forward ──┤                 ├─ forward ──┤
   ├─ backward ─┤                 ├─ backward ─────────┤
   ├─ all-reduce ─┤                  ├─ AR layer N ─┤
   ├─ optimizer ┤                      ├─ AR N-1 ─┤
                                          ├─ AR N-2 ─┤
   step = C + R                        ├─ optimizer ┤

                                  step = max(C, R) + ε

   The mechanism: gradients for layer N are ready as soon as
   layer N's backward completes — long before layer 1's.
   So start reducing layer N while layer N−1 is still
   computing. Bucket small gradients together to avoid
   paying latency per tensor.
```

PyTorch DDP does this automatically with gradient buckets (default ~25 MB). The tunable is bucket size: **larger buckets** amortise latency better but delay the start of communication; **smaller buckets** start earlier but pay more per-message overhead. On a slow fabric, larger buckets usually win.

When communication exceeds compute, no amount of overlap saves you — you're network-bound and the fix is a different parallelism strategy, gradient compression, or a faster fabric.

## Failure modes that look like performance problems

**The straggler.** Collectives are synchronous: everyone waits for the slowest. One GPU thermally throttling, one node with a degraded link, or one process doing extra work slows the *entire job* to its pace. At 1,000 GPUs, a single 10% straggler costs 10% of the whole cluster.

**Silent link degradation.** A cable or optic that has partially failed still passes traffic, at reduced bandwidth or with retransmissions. Nothing errors; the job just gets slower. Detection requires actively monitoring per-link bandwidth against expectation, not waiting for errors.

**NCCL hangs.** If one rank crashes mid-collective, the others block forever waiting for it. Without a timeout, a 1,000-GPU job sits idle burning money until someone notices. Always set `NCCL_TIMEOUT` and alarm on it.

:::goat The diagnostic that isolates it
When a distributed job is slower than expected, the ordered checklist:

1. **Run NCCL bandwidth tests** (`nccl-tests`) on the exact allocation. Compare achieved all-reduce bandwidth to theoretical. If it's low, the problem is the fabric or the placement, not your code.
2. **Check placement.** Are the ranks where you think they are? Same node? Same rail?
3. **Profile per-rank step time.** A wide distribution means stragglers; a uniform slow time means bandwidth.
4. **Compare compute time to communication time.** If communication dominates, changing hyperparameters won't help — you need a different parallelism split.

This sequence isolates the layer quickly, and it's the difference between "the cluster is slow" and "rank 47's NIC is negotiating at half rate."
:::

## Exercise

:::exercise Plan the communication
Training a 30B model, BF16, across 64 GPUs — 8 nodes of 8. NVLink 900 GB/s within a node, InfiniBand 50 GB/s per GPU across nodes. One training step computes for 400 ms.

1. Gradient size in bytes. Ring all-reduce time across all 64 GPUs over InfiniBand?
2. Hierarchical instead: reduce within each node over NVLink, then all-reduce 8 node-representatives over InfiniBand, then broadcast back within nodes. Compute each phase. How much faster?
3. What fraction of the step is communication in each case? Which is acceptable?
4. Switch to ZeRO-3, which requires an all-gather of parameters in forward *and* backward plus a reduce-scatter of gradients. Estimate the new communication volume. Is it still hideable?
5. One node's InfiniBand link degrades to 10 GB/s. What happens to the step time for the whole job? How would you detect this within an hour rather than a week?
:::

:::paper Sources
*Bandwidth Optimal All-reduce Algorithms for Clusters of Workstations* (Patarasuk & Yuan, 2009) is the ring algorithm. Baidu's 2017 "Bringing HPC Techniques to Deep Learning" post is what brought it into ML practice.

*Horovod* (Sergeev & Del Balso, 2018) is the practical system. The NCCL documentation on algorithms and protocols is the reference for what actually runs. Meta's OPT-175B logbook is the best public account of what goes wrong at scale.
:::

## Check yourself

```recall
Q: What is the bandwidth hierarchy, and the rule that follows?
A: GPU memory 2–8 TB/s, NVLink 400–1,800 GB/s, PCIe ~64 GB/s, InfiniBand 25–100 GB/s per GPU, WAN under 1 GB/s. Put chatty communication (tensor parallel) on fast tiers, infrequent (pipeline, data) on slow ones.

Q: Name the main collectives and their uses.
A: All-reduce (gradient averaging), reduce-scatter and all-gather (its two halves; ZeRO/FSDP use them), all-to-all (MoE routing, the hardest), broadcast (initial weights).

Q: What does a ring all-reduce cost?
A: Each GPU sends about 2S bytes whatever N is — why data parallelism scales — plus a latency term of 2(N−1) hops. A 14 GB gradient takes ~31 ms over NVLink, ~560 ms over InfiniBand.

Q: Why do large clusters use hierarchical all-reduce?
A: The ring's latency term grows with N (10 ms at 1,000 GPUs); reducing within nodes over NVLink first, then across a small ring of nodes, cuts hops to O(nodes) or O(log N).

Q: Why do RDMA and lossless delivery matter?
A: GPUDirect RDMA lets a NIC write straight into a remote GPU's memory with no CPU copy; a dropped packet stalls every participant in a collective, so misconfigured RoCE flow control silently halves throughput.

Q: What is a rail-optimised network?
A: GPU i of every node connects to switch i, because data-parallel peers share a rank — most of full bisection's benefit at a fraction of the switch cost.

Q: How is communication overlapped with compute?
A: Start all-reducing a layer's gradients as soon as its backward pass finishes, in ~25 MB buckets. If communication exceeds compute, change the parallelism strategy.

Q: How do you diagnose a slow distributed job?
A: Run nccl-tests on the exact allocation, check placement, look at the per-rank step-time distribution for stragglers, and compare compute with communication time.
```

## What to carry forward

- **The bandwidth hierarchy spans 3 orders of magnitude.** Match chatty communication to fast tiers.
- **Ring all-reduce moves ~2S bytes per GPU regardless of N** — that constant is why data parallelism scales.
- The **latency term grows with N**, which is why large clusters go hierarchical.
- **RDMA and lossless delivery** are what make multi-node training work; misconfigured PFC silently halves throughput.
- **Topology-unaware placement** can cost several times your throughput with no visible error.
- **Overlap communication with compute** by bucketing gradients; when communication exceeds compute, change strategy.
- **Collectives are synchronous — one straggler taxes the entire cluster.**
