---
title: Scheduling a GPU Cluster
summary: Gang scheduling, topology awareness, preemption, and quotas — why a Kubernetes scheduler that works fine for web services does badly at allocating accelerators.
difficulty: Hard
scope: HLD
tags: [ai, scheduling, kubernetes, gpu, capacity]
prereqs: [training-at-scale, queueing-theory]
unlocks: Running a shared GPU fleet without either idle capacity or perpetually queued jobs.
---

:::predict Guess first
1. Two jobs each need 64 GPUs on a 64-GPU cluster. One grabs 40 and the other 24. What happens next?
2. A job asks for "8 GPUs". Does it matter whether they're on one server or eight?
3. A research notebook holds a GPU while its owner is at lunch. Across a big cluster, how much might idle sessions cost?
:::

## Why a normal scheduler fails

A web workload is elastic, fungible, and fast to start. Bin-pack it anywhere; if a pod is slow to schedule, nobody notices.

GPU workloads violate all three assumptions:

```diagram
   WEB POD                        DISTRIBUTED TRAINING JOB

   1 replica useful on its own    64 GPUs, useless until ALL are ready
   any node will do               placement changes speed several-fold
   starts in seconds              minutes to load weights
   can be evicted freely          eviction destroys hours of work
   ~1 GB of memory                80 GB, exclusive, non-shareable
```

Scheduling four of a job's sixty-four GPUs is not 6% progress — it is zero progress while holding four GPUs hostage. That single fact is why GPU scheduling needs its own machinery.

## Gang scheduling

A **gang** is a set of workers that are useless individually — a 64-GPU training job can't start with 63. **Gang scheduling** therefore allocates all of a job's resources together or none at all, rather than handing them out as they free up.

```diagram
   WITHOUT GANG SCHEDULING — resource deadlock

     Job A needs 64 GPUs, gets 40, waits for 24 more
     Job B needs 64 GPUs, gets 24, waits for 40 more
     Cluster has 64 GPUs total.

     → Both jobs hold resources. Neither can start.
       The cluster is 100% allocated and 0% productive,
       forever, until a human intervenes.

   WITH GANG SCHEDULING

     Job A: all 64 available? → allocate all, run.
     Job B: waits in the queue holding nothing.
     A finishes → B gets all 64.

     → 100% utilisation, no deadlock.
```

Kubernetes has no native gang scheduling. The plugins that add it — Volcano, Kueue, Coscheduling — implement `PodGroup` semantics: pods stay pending until the whole group can be placed. **This is the first thing to install on a Kubernetes GPU cluster**, and running without it is how clusters end up deadlocked at 3am.

## Topology awareness

From [interconnect and collectives](interconnect-and-collectives.html): the same eight GPUs can differ by an order of magnitude in throughput depending on placement.

```diagram
   REQUEST: 8 GPUs

   Placement A: all 8 on one node
                → NVLink at 900 GB/s between all pairs
   Placement B: 1 GPU on each of 8 nodes
                → InfiniBand at 50 GB/s

   Same request, same code. Placement B can be
   several times slower with no error and no log line.
```

So the scheduler needs to understand the physical hierarchy — GPU, node, leaf switch, rail, spine — and jobs need to express constraints against it:

- **Pack tightly** for tensor-parallel groups: same node, mandatory.
- **Rail alignment** for pipeline and data-parallel groups spanning nodes: same rail where possible.
- **Spread** for inference replicas: different nodes and racks, so one failure doesn't take out the fleet.

The inference case is worth noting because it inverts the training preference. Training wants tight packing for bandwidth; serving wants spreading for fault tolerance. A scheduler that only knows one policy will do the wrong thing for half your fleet.

:::goat "8 GPUs" is an incomplete request
The unit of allocation for distributed work is not a GPU. It is **a topology-constrained set of GPUs**.

A job specification should say: 64 GPUs, arranged as 8 nodes of 8, with the 8-GPU groups NVLink-connected and the nodes sharing a spine. Anything less and the scheduler is free to hand you a configuration that runs at a fraction of the speed.

This is the same class of problem as rack-aware replica placement in a database — the scheduler must model the physical topology because the workload's performance depends on it. The difference is that here the penalty is 5× rather than 5%.
:::

Kubernetes itself is catching up. **Dynamic Resource Allocation** (DRA), generally available since Kubernetes 1.34 in 2025, lets a pod request devices by attributes and constraints — "four GPUs in the same NVLink domain" — instead of a bare count of `nvidia.com/gpu`. Gang scheduling and quotas still come from Kueue or Volcano in most clusters.

## Sharing a GPU

For inference and development, a whole accelerator is often wasteful.

| Mechanism | Isolation | Configurable at runtime | Use |
|---|---|---|---|
| **MIG** | Strong — separate SM, cache, memory paths | No, requires reconfiguration | Multi-tenant inference with latency SLAs |
| **Time slicing** | None — contexts swap | Yes | Dev, notebooks, batch |
| **MPS** | Partial — concurrent kernels, shared memory | Yes | Cooperative workloads |
| **Fractional via scheduler** | None — just accounting | Yes | Bin-packing small inference services |

The trap in the last row: several Kubernetes GPU plugins let you request "0.5 GPU", which only affects *scheduling arithmetic*. There is no enforcement — a pod that requests half a GPU can allocate all its memory and starve its co-tenant. If you need real isolation, MIG is the only option that provides it.

## Queues, priorities, and quotas

A shared cluster needs a policy for who gets capacity, and it needs to survive contention.

```diagram
   HIERARCHICAL QUOTA

     Organisation: 1,000 GPUs
       ├── Research      400 guaranteed, may burst to 700
       ├── Production    400 guaranteed, may burst to 600
       └── Experiments   200 guaranteed, may burst to 400

   Guarantee: always available on demand, reclaimed by
              preempting borrowers if necessary.
   Burst:     use idle capacity from other teams, but
              give it back when the owner returns.

   → high utilisation without any team being starved
```

**Preemption tiers** matter as much as the quotas:

- **Production inference** — never preempted.
- **Long training runs** — preempted only with a checkpoint signal and a grace period long enough to write one.
- **Batch and experiments** — freely preemptible.
- **Interactive dev** — preempted after idle timeout, aggressively. Idle notebooks holding GPUs are the single largest source of waste in most research clusters.

:::trap Preempting a training job without a checkpoint signal destroys hours of work
`SIGKILL` on a job 45 minutes past its last checkpoint discards 45 minutes of a 1,000-GPU cluster's output. That is a real, large amount of money.

The contract has to be explicit:
1. Scheduler sends a preemption warning (`SIGTERM` or a custom signal).
2. Job checkpoints — which takes minutes for a large model.
3. Job exits cleanly, or is killed after a grace period sized to the checkpoint time.
4. Job re-queues automatically and resumes from the checkpoint.

Grace periods of 30 seconds — the Kubernetes default — are useless here. This needs to be configured per workload class, and the job needs to actually handle the signal.
:::

## Capacity planning

GPU capacity behaves nothing like cloud compute.

```diagram
   ELASTIC CLOUD                  GPU CAPACITY

   scale in seconds               new hardware: weeks to quarters
   pay for what you use           reserved commitments dominate cost
   effectively unlimited          genuinely constrained supply
   autoscaling handles spikes     you must pre-provision peaks
   power is someone else's        power and cooling are YOUR limit
     problem
```

Three consequences for how you plan:

**Reserved beats on-demand, by a lot.** Reserved or committed capacity is typically 40–70% cheaper. Since GPUs can't be scaled reactively anyway, you're already holding capacity — so commit to it and stop paying the on-demand premium for a flexibility you cannot use.

**Spot capacity works for training, not serving.** With good checkpointing and elastic recovery, preemptible instances at a large discount are genuinely viable for training — you were already handling failures twice a day. For latency-sensitive inference, an eviction is an outage.

**Utilisation is the whole game.** A cluster at 40% utilisation has doubled its effective cost per unit of work. The levers are: backfilling idle capacity with preemptible batch, reclaiming idle interactive sessions, right-sizing requests (people ask for 8 GPUs and use 2), and shifting flexible work to off-peak.

:::derive What idle capacity costs
```
   256 GPUs at $2/hour = $512/hour = $4.5M/year

     at 90% utilisation → effective cost per GPU-hour: $2.22
     at 60% utilisation → $3.33
     at 40% utilisation → $5.00

   Moving from 40% to 75% utilisation on this cluster is
   worth roughly $1.9M/year — more than the salary of the
   team that would build the scheduling to achieve it.

   This is why large GPU fleets justify dedicated
   scheduling infrastructure teams. The arithmetic is
   not close.
```
:::

## Observability

| Signal | Why |
|---|---|
| **Allocated vs used GPUs** | The gap is your waste — pods holding idle GPUs |
| **MFU per job** | Whether allocated GPUs are doing useful work |
| **Queue wait by priority** | Is the quota policy actually working? |
| **Gang scheduling failures** | Fragmentation preventing large jobs from placing |
| **Preemption rate and lost work** | Whether the policy is too aggressive |
| **Fragmentation** | Free GPUs that are unusable because they're scattered |

**Fragmentation is the subtle one.** A cluster can be 30% free and unable to place a single 8-GPU job because the free GPUs are spread one per node. Defragmentation — draining and repacking — is worth doing periodically, and is much easier if jobs checkpoint well.

:::exercise Design the policy
A 512-GPU cluster shared by three teams: inference (needs 150 GPUs, latency-critical, 24/7), research training (bursty, jobs of 8–128 GPUs, hours to days), and experimentation (many 1–2 GPU notebooks).

1. Design the quota hierarchy: guarantees and burst limits for each. Justify the numbers.
2. Preemption tiers and grace periods. What does the research team have to implement to be safely preemptible?
3. A 128-GPU job is queued; 140 GPUs are free but spread across 40 nodes. What happens, and what's your fix — both immediate and structural?
4. Notebooks average 8% GPU utilisation. Design the reclamation policy. What's the false-positive risk, and how do you keep researchers from working around it?
5. Estimate current utilisation and the annual saving from getting it to 80%. What would you build first?
6. The inference team asks for 150 dedicated GPUs that nobody else may ever touch. Make the counter-argument, with numbers.
:::

:::paper Sources
*Large-scale Cluster Management at Google with Borg* (Verma et al., EuroSys 2015) is the foundational cluster-scheduling paper — quotas, priorities, and preemption all trace back to it.

*Gandiva* (Xiao et al., OSDI 2018) and *Tiresias* (Gu et al., NSDI 2019) are the deep-learning-specific schedulers, covering job introspection and time-slicing. The Volcano and Kueue documentation are the practical Kubernetes references.
:::

## Check yourself

```recall
Q: Why do normal schedulers fail for GPU jobs?
A: Distributed jobs are useless until every GPU is ready, placement changes speed several-fold, startup takes minutes, eviction destroys work, and GPUs are exclusive.

Q: What is gang scheduling, and why is it mandatory?
A: Allocate all of a job's resources together or none. Without it, two jobs can each hold part of the cluster and wait forever — 100% allocated, 0% productive. Kubernetes needs Volcano or Kueue for it.

Q: How should placement differ for training and inference?
A: Training packs tightly — tensor-parallel groups on one node, data-parallel peers on the same rail. Inference spreads replicas across nodes and racks for fault tolerance.

Q: Which GPU sharing gives real isolation?
A: Only MIG. Time slicing and MPS share hardware, and "0.5 GPU" requests in Kubernetes plugins are scheduling arithmetic with no enforcement.

Q: How do hierarchical quotas work?
A: Each team gets a guarantee (always available, reclaimed by preempting borrowers) and a burst limit using others' idle capacity — high utilisation without starvation.

Q: What must preempting a training job include?
A: A warning signal, a grace period long enough to write a checkpoint (minutes, not the 30-second default), a clean exit, and automatic re-queue and resume.

Q: How is GPU capacity planned unlike cloud compute?
A: Hardware takes weeks to quarters and power is your limit, so reserve capacity (40–70% cheaper), use spot only for checkpointed training, and push utilisation.

Q: Why is utilisation the whole cost story?
A: 256 GPUs at $2/hour cost $5/useful hour at 40% utilisation versus $2.22 at 90%; reaching 75% saves ~$1.9M a year — via backfill, reclaiming idle sessions, right-sizing and defragmentation.
```

## What to carry forward

- **Gang scheduling is mandatory** — partial allocation of a distributed job is zero progress plus a deadlock risk.
- **Topology awareness is worth several times your throughput.** "8 GPUs" is an incomplete request.
- Training wants **tight packing**; inference wants **spreading**. Both policies must exist.
- **MIG is the only sharing mechanism with real isolation**; fractional GPU requests are accounting only.
- **Hierarchical quotas with burst and preemption** give high utilisation without starvation.
- **Preemption needs a checkpoint signal and a real grace period**, not the 30-second default.
- **Utilisation is the whole cost story** — 40% to 80% is worth more than any hardware upgrade.
