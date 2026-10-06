---
title: Build a Pretraining Cluster
summary: The capstone — 4,000 GPUs, 60 days, one computation that must not stop. Parallelism layout, checkpointing arithmetic, failure recovery, and the operational discipline that makes it finish.
difficulty: Hard
scope: HLD
level: 6
prereqs: [training-at-scale, model-parallelism, training-data-pipelines, gpu-cluster-scheduling]
tags: [level-6, ai, training, hpc, reliability]
unlocks: Every idea in this atlas, composed into one system at the largest scale it appears.
---

:::predict Guess first
1. Training compute is roughly 6 × parameters × tokens. Would a 200B model on 12 trillion tokens finish in 60 days on 4,000 GPUs at 40% utilisation?
2. With 500 machines that each fail about once every 50,000 hours, how often does something in the cluster fail?
3. One GPU out of 4,000 runs 20% slower but reports no errors. How much does it slow the whole job?
:::

## The task

Train a 200-billion-parameter model on 12 trillion tokens. You have 4,000 GPUs for approximately 60 days.

This is the hardest build here, and not because any individual component is novel. It is hard because **it is a single distributed computation that must make continuous progress for two months across hardware that fails twice a day**, and there is no partial credit. A run that dies on day 45 with corrupted checkpoints has produced nothing.

Nearly every idea in this atlas appears somewhere in it.

## Phase 0 — Is this even the right shape?

Before allocating anything, the compute budget and the model/data split.

:::derive Sizing the run
```
   Compute for a transformer:  C ≈ 6 × P × D
     P = parameters, D = training tokens

   P = 200e9, D = 12e12:
     C = 6 × 200e9 × 12e12  =  1.44e25 FLOPs

   4,000 GPUs at 1,000 TFLOP/s peak, 40% MFU:
     effective = 4,000 × 1e15 × 0.40  =  1.6e18 FLOP/s

     time = 1.44e25 / 1.6e18  =  9.0e6 seconds
          ≈ 104 days

   → 60 days is not enough at 40% MFU.

   Options:
     · reach 50% MFU               → 83 days   (still short)
     · reduce to 8T tokens         → 69 days
     · 6,000 GPUs                  → 69 days
     · 150B params, 9T tokens      → 59 days   ✓
       (6 × 150e9 × 9e12 = 8.1e24 → 5.1e6 s)

   The last one is also closer to compute-optimal for
   this budget. Chinchilla scaling suggests roughly
   20 tokens per parameter; 150B × 20 = 3T is
   compute-optimal, but training well past that point
   buys a model that is CHEAPER TO SERVE for the same
   quality — which is usually the right trade when
   you'll serve it for years.
```
:::

**The estimate comes first, and it changes the model.** Skipping this is how runs get started that cannot finish.

A fifth lever has become common since 2024: doing most of the matrix maths in **FP8** instead of BF16 — DeepSeek-V3 was trained this way. It raises effective throughput substantially, but it needs careful per-block scaling to stay numerically stable, so treat it as a choice you plan and validate on a small run, not a rescue for a schedule that doesn't fit.

## Phase 1 — The parallelism layout

The model is far too big for one GPU, so it must be split — and there are three different ways to split it, used together. **Tensor parallel** splits individual layers across GPUs, which means they must talk twice per layer, so they'd better be in the same box. **Pipeline parallel** gives different GPUs different layers, so they hand off once per stage. **Data parallel** gives every group a full copy of the model and different training examples, syncing once per step.

The rule that arranges them, from [model parallelism](../06-ai-infrastructure/model-parallelism.html): the more often something has to communicate, the faster the wire between the participants must be.

```diagram
   4,000 GPUs = 500 nodes × 8 GPUs
   NVLink within a node, InfiniBand across.

     TENSOR PARALLEL   = 8    within a node
                              (2 all-reduces per LAYER →
                               must be on NVLink)
     PIPELINE PARALLEL = 10   across 10 nodes
                              (one activation per stage
                               boundary → tolerates IB)
     DATA PARALLEL     = 50   across the remaining groups
                              (one gradient sync per STEP,
                               overlappable)

     8 × 10 × 50 = 4,000 ✓

   Plus ZeRO-1 within each data-parallel group to shard
   optimizer state — cheap, no extra communication.
```

:::derive Checking the layout holds together
```
   MEMORY per GPU
     150B params ÷ (TP 8 × PP 10) = 1.875B params per GPU
     weights BF16          1.875e9 × 2  =  3.75 GB
     gradients             1.875e9 × 2  =  3.75 GB
     optimizer, ZeRO-1 over 50 ranks:
       1.875e9 × 12 / 50                =  0.45 GB
     activations w/ checkpointing       ≈ 25 GB
     framework + fragmentation          ≈  8 GB
                                          ───────
     total                              ≈ 41 GB  ✓ fits 80 GB
     → headroom for a longer sequence or a bigger
       micro-batch

   PIPELINE BUBBLE
     with 80 micro-batches, 10 stages:
       (10−1)/(80+10−1) = 10.1% idle
     interleaved 1F1B roughly halves it → ~5%

   TENSOR-PARALLEL TRAFFIC (per forward pass)
     activation tensor per all-reduce:
       micro-batch 2 × seq 8,192 × d 12,288 × 2 B ≈ 400 MB
     2 all-reduces × 96 layers = 192 × 400 MB ≈ 77 GB
     over NVLink at 900 GB/s ≈ 85 ms — hideable ✓
     over InfiniBand it would be ~1.5 s — confirms TP
     must stay in-node
```
:::

Every one of those numbers is checkable before you allocate a single GPU, and getting one wrong costs days.

## Phase 2 — Data

The [training data pipeline](../06-ai-infrastructure/training-data-pipelines.html) has to be finished before the run starts, because you cannot fix the corpus at day 30 without invalidating everything before it.

```diagram
   REQUIRED BEFORE THE RUN BEGINS

   · 9T tokens, filtered, deduplicated, decontaminated
   · pre-packed into fixed-length sequences, in shards
     (~500 MB each, uint32 token IDs, mmap-able)
   · a deterministic, resumable shard assignment:
       rank r at step s reads exactly the same data
       on a resume — or you silently replay or skip data
   · the mixture weights fixed, with the late-phase
     annealing schedule decided
   · a content-addressed snapshot ID recorded, so the
     exact corpus is reconstructible in two years

   LOADER REQUIREMENTS
   · prefetch several batches ahead, pinned memory
   · never stall the GPU — a loader stall shows up as
     mysteriously low MFU and takes days to diagnose
   · stream from object storage; staging 9T tokens
     to local disk on 500 nodes is not worth it
```

**The data loader's resumability is a correctness requirement, not a convenience.** A resume that replays 30 minutes of data or skips it produces a model trained on a subtly wrong distribution, and nothing will tell you.

## Phase 3 — Checkpointing

A **checkpoint** is a full snapshot of the run, written to storage so a crash costs you minutes rather than weeks. Note what has to go in it: not just the model's weights, but the optimiser's own accumulated state — the running averages it uses to decide how big each adjustment should be. Restarting without those doesn't resume the run, it disturbs it.

:::derive The checkpoint budget
```
   CHECKPOINT SIZE
     weights   BF16     150e9 × 2  =  300 GB
     Adam momentum FP32 150e9 × 4  =  600 GB
     Adam variance FP32 150e9 × 4  =  600 GB
     master weights FP32            =  600 GB
                                      ────────
     total                          ≈ 2.1 TB

   WRITE TIME
     sharded across 4,000 ranks in parallel,
     aggregate 40 GB/s to object storage:
       2,100 / 40  ≈  53 seconds

     With async checkpointing (device→host copy, then
     background upload) the TRAINING PAUSE is only the
     copy: ~12 seconds.

   FAILURE RATE
     500 nodes, node MTBF ~50,000 h
     cluster MTBF = 50,000/500 = 100 hours
     → a failure roughly every 4 days
     → over 59 days: ~14 failures

   OPTIMAL INTERVAL (Young's formula)
     √(2 × 12 s × 360,000 s)  ≈  2,939 s  ≈  49 minutes

   COST OF FAILURES
     14 × (avg 25 min lost work + 4 min restore + 3 min
           restart)  ≈  7.5 hours  ≈  0.5% of the run  ✓
```
:::

Tiered: a fast local-NVMe checkpoint every ~15 minutes for node-level faults, and a full durable checkpoint to object storage every ~50 minutes. Keep the last several object-storage checkpoints — you will need to roll back past a loss spike.

## Phase 4 — Automatic recovery

At a failure every four days, manual restart means someone paged fourteen times over two months, each costing hours. Everything must be automatic.

```viz
{
  "type": "steps",
  "caption": "Twelve minutes, unattended, at 3am. Any human step costs hours.",
  "steps": [
    { "label": "Detect", "sub": "NCCL timeout · heartbeat loss · health probe", "accent": "#fb7185" },
    { "label": "Isolate", "sub": "cordon the node, tag it for diagnosis", "accent": "#fbbf24" },
    { "label": "Replace", "sub": "pull from the 3% warm spare pool", "accent": "#a78bfa" },
    { "label": "Reform", "sub": "rebuild process groups, verify topology", "accent": "#38bdf8" },
    { "label": "Restore", "sub": "load the checkpoint, reposition the loader", "accent": "#4ade80" },
    { "label": "Verify", "sub": "one step, check the loss is continuous", "accent": "#22d3ee" }
  ]
}
```

Details that decide whether this works:

- **Warm spares — 3% (15 nodes).** A replacement must be available immediately, not queued behind provisioning.
- **Pre-flight health checks on every node before it joins.** Run a GPU self-test, check the memory's error-correction counters for a chip going bad, measure actual bandwidth to a neighbour, and check it isn't already running hot. A node that answers "yes I'm up" but negotiated its network link at half speed becomes a permanent drag on all 4,000 GPUs.
- **Verify the loss after restore.** A resume that loads the wrong checkpoint or misplaces the loader shows up as a loss discontinuity. Check it automatically and halt if it jumps.
- **Global batch size must stay constant.** If you resume on fewer data-parallel ranks, adjust gradient accumulation to compensate, or your learning-rate schedule silently no longer matches the run.

## Phase 5 — Watching for the failures that don't error

Every GPU must finish each step before any of them can start the next, so the slowest one sets the pace for all 4,000. A **straggler** — one machine quietly running at 80% — therefore costs you 20% of the entire cluster, and nothing logs an error.

```diagram
   THE THREE THAT COST THE MOST

   STRAGGLER
     one GPU 20% slow → the whole 4,000-GPU job is 20% slow
     → 800 GPUs' worth of waste from one bad part
     detect: per-rank step-time DISTRIBUTION, not the mean
             alert when p99/p50 > 1.15

   SILENT DATA CORRUPTION
     a marginal GPU produces wrong results with no error
     symptom: loss spike, or slow divergence, no log line
     detect: per-rank gradient-norm outliers
             periodic deterministic self-test kernels
             cross-replica loss comparison on identical data

   LOSS INSTABILITY
     spikes are normal; the question is recovery
     · recovers in a few hundred steps → continue
     · doesn't recover → roll back to a checkpoint before
       the spike, SKIP the implicated data batches, resume
     detect: a human looking at the loss curve daily,
             plus automated spike alerting
```

The daily human look at the loss curve is not replaceable. Published logbooks from large runs are full of judgment calls a threshold would have got wrong.

## Phase 6 — Operating discipline

```diagram
   THE RUNBOOK, WRITTEN BEFORE DAY 1

   Automated, no human:      node failure, NCCL timeout,
                             transient loss spike
   Page someone:             loss diverging, MFU dropping
                             >15%, checkpoint write failing,
                             >3 failures in an hour
   Human decision required:  roll back past a spike, change
                             a hyperparameter, extend or
                             stop the run

   DAILY REVIEW
     loss curve · MFU trend · tokens vs schedule ·
     failure log · straggler report · spend to date

   NEVER, MID-RUN, WITHOUT A ROLLBACK PLAN
     · change the learning-rate schedule
     · change the data mixture (except the planned anneal)
     · upgrade the framework or drivers
     · change the parallelism layout

   Every one of those has ended a run somewhere.
```

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| 150B × 9T over 200B × 12T | The original spec | 200B doesn't finish in 60 days at achievable MFU |
| TP 8 × PP 10 × DP 50 | ZeRO-3 across all 4,000 | ZeRO-3's all-gathers are network-bound at this scale |
| TP within the node only | TP across nodes | 2 all-reduces per layer; ~18× slower over InfiniBand |
| Interleaved 1F1B | Naive pipeline schedule | Halves the bubble from 10% to ~5% |
| Activation checkpointing | Store all activations | Activations wouldn't fit; +33% compute is worth it |
| Async sharded checkpointing | Synchronous single-writer | 53 s pause → 12 s, at a 49-minute interval |
| Tiered local + object storage | Object storage only | Node-level faults recover in seconds from local NVMe |
| 3% warm spares | Provision on demand | Provisioning latency dominates recovery time |
| Pre-flight health checks | Trust the scheduler | A half-rate link is a permanent tax with no error |
| Constant global batch on resume | Let it shrink with the cluster | The LR schedule silently stops matching the run |
| Daily human loss review | Fully automated monitoring | Spike-recovery judgment isn't reducible to a threshold |

## What you'd cut for v1

Nothing. That's the honest answer, and it's what makes this build different from every other one here.

There is no viable minimum version of a 60-day 4,000-GPU run. Without automatic recovery it doesn't finish. Without correct checkpointing you lose the run. Without a resumable data loader you train on a subtly wrong distribution and never know. Without straggler detection you pay 20% for two months.

**The cut is to the scale, not the machinery.** Do a 7B run on 64 GPUs for three days first, with every one of these mechanisms in place, and find out which ones you got wrong when the cost of being wrong is three days rather than two months. Every team that has done this successfully did the small run first.

## Explaining the design

> "The first thing is the compute estimate, because it changes the model. At `6PD` FLOPs, 200B parameters on 12T tokens is 1.4e25, which at 40% MFU on 4,000 GPUs is 104 days — the run as specified doesn't fit the budget. So I'd resize to roughly 150B on 9T, which finishes in about 59 days and is also a better serving trade.
>
> The parallelism layout comes from matching communication frequency to link speed: tensor parallel 8 inside the node because it all-reduces twice per layer and needs NVLink; pipeline across 10 nodes because it only communicates at stage boundaries; data parallel 50 for the rest, since gradient sync happens once per step and overlaps with backward. ZeRO-1 inside the data-parallel groups shards optimizer state for free.
>
> Then it's a reliability problem. At 500 nodes the cluster MTBF is about 100 hours, so I expect 14 failures over the run. Checkpoints are 2.1 TB; sharded and async they cost a 12-second pause, which by Young's formula puts the optimal interval near 50 minutes and total failure cost at about half a percent of the run. Recovery has to be entirely automatic — detect, cordon, pull a warm spare, reform the process groups, restore, verify the loss is continuous.
>
> The failures that actually hurt are the silent ones: a straggler running 20% slow taxes all 4,000 GPUs, and silent data corruption from a marginal GPU produces wrong gradients with no error at all. Both need active detection — per-rank step-time distributions and gradient-norm outliers — because neither will ever raise an exception.
>
> And I'd do a three-day 7B run on 64 GPUs first with all of this machinery in place. There's no way to test a two-month run except by doing a short one properly."

## Where to go from here

This is the last build. If the arithmetic above felt tractable — the memory budget, the bubble fraction, the checkpoint interval, the failure rate — then the material has done its job. Every number came from a page in this atlas, and the whole thing is [queueing theory](../01-foundations/queueing-theory.html), [failure arithmetic](../01-foundations/availability-slas.html), [checkpointing](../04-data/wal-and-durability.html), and [caching](../02-building-blocks/caching.html), with unusually large constants.

## Check yourself

```recall
Q: Why does the compute estimate come first?
A: C ≈ 6PD: 200B × 12T = 1.44e25 FLOPs, ~104 days on 4,000 GPUs at 40% MFU — the spec can't finish, so the model changes (e.g. 150B on 9T in ~59 days, also cheaper to serve).

Q: How are tensor, pipeline and data parallelism laid out?
A: Match communication frequency to link speed: tensor parallel 8 inside a node over NVLink (2 all-reduces per layer), pipeline 10 across nodes (one hand-off per stage), data parallel 50 for the rest (one overlappable sync per step), with ZeRO-1 sharding optimizer state.

Q: What must a resumable data loader guarantee?
A: Rank r at step s reads exactly the same data after a resume — otherwise data is silently replayed or skipped and the model trains on the wrong distribution.

Q: What goes into a checkpoint, and how big is it?
A: Weights plus optimizer state — Adam momentum, variance and FP32 master weights — about 2.1 TB for 150B parameters. Sharded async writes pause training only ~12 s.

Q: How do you pick the checkpoint interval?
A: Young's formula: √(2 × checkpoint cost × MTBF). With a 12 s pause and a 100-hour cluster MTBF that's ~49 minutes, putting failure cost near 0.5% of the run.

Q: What must automatic recovery do?
A: Detect (NCCL timeout, heartbeat), cordon the node, pull a warm spare after pre-flight health checks, rebuild process groups, restore and reposition the loader, verify loss continuity, and keep the global batch constant.

Q: Name the three silent failures that cost most.
A: Stragglers (one slow GPU slows all 4,000 — watch the step-time distribution), silent data corruption (gradient-norm outliers, self-test kernels), and loss spikes that don't recover (roll back and skip the batches).

Q: What is the honest "v1" of a pretraining run?
A: Nothing can be cut from the machinery — cut the scale instead: a few-day 7B run on 64 GPUs with every mechanism in place, to find mistakes cheaply.
```

## What to carry forward

- Estimate compute first; it decides the model size and token count.
- Lay out parallelism by communication frequency versus link speed.
- Data must be fixed, deterministic and resumable before day one.
- Size checkpoints and intervals from the failure rate; recover automatically.
- Hunt silent failures, review the loss daily, and rehearse on a small run.
