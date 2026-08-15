---
title: Training at Scale — the Operational Reality
summary: Checkpointing, failure arithmetic at 10,000 GPUs, MFU, stragglers, and determinism — what actually consumes a training team's time, which is not the model.
difficulty: Hard
scope: HLD
tags: [ai, training, reliability, checkpointing, mfu]
prereqs: [model-parallelism, failure-modes, availability-slas]
unlocks: Running a multi-week training job without losing it.
---

## The failure arithmetic

A large training run is a single distributed computation across thousands of machines that must all make progress together, for weeks. This is an unusual reliability posture: unlike a web service, **any single failure stops everything.**

:::derive Mean time between failures at scale
```
   Assume a per-GPU-node MTBF of ~50,000 hours
   (optimistic — includes GPU faults, HBM ECC errors,
    NIC failures, host issues, power events)

   1,250 nodes (10,000 GPUs):

     cluster MTBF = 50,000 / 1,250  =  40 hours

   → Something fails roughly TWICE A DAY.

   Over a 60-day training run:  ~36 failures expected.

   Without automatic recovery, at 4 hours of human response
   time each, that's 144 hours — 10% of the run — spent
   restarting. And that assumes someone is always awake.
```
:::

Published logbooks bear this out. Meta's OPT-175B run recorded dozens of hardware failures over two months; the Llama 3 paper reports a comparable rate. **This is not a sign of a badly built cluster — it's the arithmetic of large numbers**, exactly as in [failure modes](../01-foundations/failure-modes.html), with the difference that here a single failure halts the entire job rather than degrading a fraction of traffic.

The consequences shape everything: **checkpointing must be fast and frequent, recovery must be automatic, and the job must tolerate losing nodes.**

## Checkpointing

A checkpoint must capture everything needed to resume bit-identically: model weights, optimizer state, learning-rate schedule position, RNG states, and the data loader's position.

:::derive Checkpoint size and time
```
   175B parameters:
     weights        (BF16)   350 GB
     Adam momentum  (FP32)   700 GB
     Adam variance  (FP32)   700 GB
     master weights (FP32)   700 GB
                            ────────
     total                  2.45 TB per checkpoint

   Writing to object storage at 10 GB/s aggregate:
     245 seconds  ≈  4 minutes

   Every 30 minutes:  4/30 = 13% of the run spent writing
   → unacceptable
```
:::

Three techniques make this tractable, and production runs use all three:

**Sharded checkpointing.** Each rank writes only its own shard, in parallel, to separate objects. With 1,024 ranks writing simultaneously, aggregate bandwidth is enormous and wall-clock time collapses. Requires the loader to handle resharding when you resume on a different topology.

**Asynchronous checkpointing.** Copy the state to CPU memory quickly (fast — it's a device-to-host transfer), then write to storage in the background while training continues. Training pauses for the copy, not for the upload.

**Tiered frequency.** Frequent lightweight checkpoints to fast local NVMe; occasional full checkpoints to durable object storage. Local recovers a node fault in seconds; remote survives losing the rack.

```diagram
   Checkpoint interval versus expected loss:

     interval too long   → lose up to a full interval of work
                            on each failure
     interval too short  → spend all your time writing

     Optimal interval ≈ √(2 × checkpoint_cost × MTBF)

     checkpoint cost 60 s, MTBF 40 h (144,000 s):
       √(2 × 60 × 144,000)  ≈  4,157 s  ≈  70 minutes
```

That is Young's formula, from HPC. It is the same reasoning as [checkpoint tuning in a database](../04-data/wal-and-durability.html) — trading steady-state cost against recovery time — with much bigger numbers on both sides.

## Elastic training and automatic recovery

Manual restart is not viable at twice-a-day failure rates. The recovery path must be automated end to end.

```viz
{
  "type": "steps",
  "caption": "Every step here must be automatic. Any human in the loop costs hours per failure.",
  "steps": [
    { "label": "Detect", "sub": "NCCL timeout, health probe, or heartbeat loss", "accent": "#fb7185" },
    { "label": "Isolate", "sub": "cordon the bad node, drain it from the pool", "accent": "#fbbf24" },
    { "label": "Reconfigure", "sub": "reform process groups on healthy nodes", "accent": "#a78bfa" },
    { "label": "Restore", "sub": "load the last checkpoint, reshard if topology changed", "accent": "#38bdf8" },
    { "label": "Resume", "sub": "reposition the data loader, continue", "accent": "#4ade80" }
  ]
}
```

The subtle requirements:

- **Spare capacity.** Hold 2–5% of nodes idle so a replacement is available immediately rather than waiting on a provisioning queue.
- **Health checks that run before the job does.** A GPU with correctable ECC errors climbing, a link negotiating at half rate, thermal throttling — catch these at allocation time, not three hours into a run.
- **Data loader position must be checkpointed.** Resuming and replaying the same data is a correctness bug that shows up as subtly worse convergence and is very hard to diagnose.
- **Global batch size should stay constant** across a topology change, or your learning-rate schedule no longer matches the run. Adjust gradient accumulation to compensate for fewer data-parallel ranks.

:::trap Silent data corruption is the failure you'll miss
GPUs occasionally produce wrong results without any error at all — a faulty memory cell whose error-correction misses it, a marginal chip running hot. Nothing throws, nothing logs. The gradients are simply wrong, and training quietly absorbs them.

Symptom: the loss spikes, or diverges slowly, or converges to a worse value, and nothing indicates why.

Detection: monitor gradient norms per rank and alert on outliers; periodically run a deterministic self-test kernel with a known answer; compare loss across data-parallel replicas on identical data. Meta's Llama and OPT logbooks both describe hunting exactly this class of fault.

The default assumption should be that at 10,000 GPUs, **some of your hardware is quietly wrong right now.**
:::

## MFU — the number to report

**Model FLOPs Utilisation** answers one question: of all the arithmetic your GPUs *could* have done, what fraction went into actually training the model? Everything else — waiting for the network, idle pipeline stages, recomputation, stragglers — shows up as the missing percentage. It's the single number that tells you whether a cluster is earning its cost.

:::derive Computing MFU
```
   Model FLOPs per token ≈ 6 × parameters
     (2 forward + 4 backward, per parameter)

   MFU = (6 × P × tokens_per_second) / (GPUs × peak_FLOPS)

   Example: 70B model, 512 GPUs at 1,000 TFLOP/s peak,
   achieving 400,000 tokens/second:

     numerator   = 6 × 70e9 × 4e5     = 1.68e17 FLOP/s
     denominator = 512 × 1e15         = 5.12e17 FLOP/s
     MFU         = 33%
```
:::

| MFU | Reading |
|---|---|
| >50% | Excellent; near the practical ceiling for large models |
| 35–50% | Good; typical for well-tuned large runs |
| 25–35% | Acceptable; there is probably 20% available |
| <25% | Something is wrong. Investigate before scaling further |

**Where the missing FLOPs go**, in rough order of frequency: communication that didn't overlap with compute, pipeline bubbles, activation recomputation (a deliberate ~33% tax), stragglers, data loading stalls, and kernel launch overhead on small operations.

:::goat Why MFU beats every other efficiency metric
GPU utilisation as reported by `nvidia-smi` shows ~100% whenever *any* kernel is running — including a kernel that's stalled on memory doing nothing useful. It is close to meaningless for this purpose.

Scaling efficiency depends on your single-GPU baseline, so it isn't comparable across teams.

MFU is an absolute, comparable, honest measure of how much of the hardware you rented is doing arithmetic that contributes to the model. It's also directly a cost number: doubling MFU halves the cost of your run.
:::

## Stragglers

Because every collective is synchronous, the job runs at the speed of its slowest rank.

```diagram
   1,000 GPUs, one running 20% slow:

     entire job runs 20% slower
     999 GPUs idle for 20% of every step
     → cost of one bad GPU ≈ 200 GPUs' worth of waste
```

Causes, roughly in order of how often they turn up: thermal throttling on one node, a degraded network link, an unbalanced data shard (one rank getting longer sequences), CPU contention on the data loader, and a noisy co-tenant on shared infrastructure.

Detection requires **per-rank step-time distributions**, not averages. A histogram immediately distinguishes "everything is slow" (a bandwidth or configuration problem) from "one rank is slow" (a straggler to evict). Averaging hides exactly the signal you need.

## Determinism and reproducibility

Fully deterministic large-scale training is achievable but expensive:

- Seed every RNG, per rank, and checkpoint the RNG states.
- Use deterministic kernel implementations — several fast reductions are nondeterministic because floating-point addition isn't associative.
- Fix the data order, and checkpoint the loader's position.
- Pin library and driver versions.
- Keep the topology identical on resume, since collective algorithms depend on it.

The cost is typically 5–15% throughput. Most production runs accept nondeterminism and rely on statistical reproducibility — two runs converge to similar quality without being bit-identical.

**Determinism earns its cost when debugging.** A loss spike you cannot reproduce is a loss spike you cannot fix. A common compromise: run deterministically for the first few thousand steps (where instability lives), then relax.

## The observability you need

| Signal | Why | Alert on |
|---|---|---|
| Loss and gradient norm | Divergence, instability | Spike, NaN, or a sustained rise |
| Per-rank step time | Stragglers | p99/p50 ratio above ~1.15 |
| MFU | Efficiency regressions | Sustained drop below baseline |
| Tokens/second | Progress against schedule | Behind projected completion |
| GPU temperature, power, ECC | Impending hardware failure | Correctable ECC rate climbing |
| NCCL collective time | Fabric degradation | Time above expected for the message size |
| Checkpoint write duration | Storage degradation | Growing trend |

**The loss curve is the primary signal** and should be watched by a human at least daily. Loss spikes are normal in large runs; the question is whether it recovers within a few hundred steps. If not, the standard playbook is to roll back to a checkpoint before the spike, skip the data batches involved, and resume — data quality issues are a common cause.

:::exercise Plan for failure
Train a 100B model on 2,000 GPUs (250 nodes) for 45 days. Node MTBF 50,000 hours. Checkpoint is 1.4 TB; storage sustains 20 GB/s aggregate.

1. Expected failures over the run. Cluster MTBF in hours.
2. Checkpoint write time. Optimal interval by Young's formula.
3. At that interval, total time lost per failure (lost work + restore + restart), and total lost across the run. What fraction of the 45 days?
4. Async checkpointing cuts the training pause to 15 s. Recompute (2) and (3). Is the engineering worth it?
5. Your MFU is 31%. List five candidate causes in the order you'd investigate, and say what measurement distinguishes each.
6. Design the health check that runs before a node joins the job. What do you test, and how long can it take?
:::

:::paper Sources
*OPT: Open Pre-trained Transformer Language Models* (Zhang et al., 2022) — the accompanying logbook is the most candid public account of what goes wrong during a large run. *The Llama 3 Herd of Models* (Meta, 2024) has an excellent infrastructure and reliability section.

*A First-Order Approximation to the Optimum Checkpoint Interval* (Young, CACM 1974) is the checkpoint-interval formula. *PaLM* (Chowdhery et al., 2022) introduced MFU as a reporting standard.
:::

## What to carry forward

- **At 10,000 GPUs something fails twice a day.** Recovery must be fully automatic.
- **Checkpoint sharded and asynchronously**; interval ≈ √(2 × cost × MTBF).
- **Checkpoint the data loader position** — replaying data is a silent correctness bug.
- **Silent data corruption is real.** Monitor per-rank gradient norms and run self-tests.
- **Report MFU**, not GPU utilisation or scaling efficiency. 40–50% is good.
- **One straggler taxes the whole cluster** — watch per-rank step-time distributions, not averages.
- **Determinism costs 5–15% and buys debuggability.** Consider it for the unstable early phase.
