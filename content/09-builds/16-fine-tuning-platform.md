---
title: Build a Fine-Tuning Platform
summary: Multi-tenant training and serving of customer-specific models — dataset validation, LoRA job scheduling, and serving 500 adapters in the memory of one base model.
difficulty: Hard
scope: HLD
level: 5
prereqs: [fine-tuning, gpu-cluster-scheduling, model-deployment, evaluation-systems]
tags: [level-5, ai, fine-tuning, lora, multi-tenant]
unlocks: The economics that make per-customer models possible at all.
---

## The product

Customers upload a dataset, get a fine-tuned model, and call it through the same API as the base model. You run the training and the serving.

The entire business depends on one technical fact: **LoRA adapters are small enough to share a base model.** Without that, serving 500 customer models means 500 × 140 GB, which is not a product.

## Phase 1 — One job, one GPU

```diagram
   POST /fine-tune {dataset_url, base_model}
        ↓
   validate the dataset
        ↓
   allocate a GPU, run LoRA training  (30-90 min)
        ↓
   save the adapter (~50 MB) to object storage
        ↓
   customer calls: POST /completions {model: "ft:cust-42:abc"}
        → load the base + this adapter, generate, unload
```

**Survives to:** a few dozen customers, occasional retraining, tolerant latency expectations.

**What breaks first:** loading and unloading an adapter per request. Each swap is a memory copy and a scheduler stall, and it destroys batching — you cannot batch requests using different adapters if you're swapping between them.

## Phase 2 — Multi-adapter serving

This is the phase that makes the product viable, and it's worth understanding precisely.

```diagram
   ONE BASE MODEL, MANY ADAPTERS, ONE BATCH

     GPU memory:
       base model weights          70 GB   (loaded once)
       adapter A (customer 42)   0.05 GB
       adapter B (customer 91)   0.05 GB
       ...
       adapter Z (200 more)        10 GB
       KV cache                    remainder

     A single batch contains requests from different
     customers. The kernel applies each request's own
     adapter during the forward pass:

       h = W·x  +  (B_i · A_i)·x    ← i varies per row
           ────     ─────────────
           shared    per-request

   → 200 "models" in the memory of one, with full
     batching efficiency.
```

:::derive The economics this unlocks
```
   500 customers, each with a fine-tuned 70B model.

   SEPARATE MODELS (full fine-tune, FP8):
     500 × 70 GB = 35,000 GB
     ÷ 80 GB per GPU = 438 GPUs, minimum, just to hold
     weights — before KV cache or any concurrency.
     → not a product

   SHARED BASE + LoRA ADAPTERS:
     70 GB base + (500 × 0.05 GB) = 95 GB
     → 2 GPUs hold every customer's model
     → the rest of the fleet is for KV cache and throughput

   ~200× reduction in the memory floor.
```
:::

The engineering that makes it work:

**Adapter cache with LRU.** Not every adapter is hot. Keep the active ones in GPU memory, the recent ones in host memory, the rest in object storage. An adapter is 50 MB — a host-to-device copy is under a millisecond, so a cache miss is cheap. Unlike KV cache, this tier is genuinely easy.

**Rank grouping.** Batched multi-adapter kernels are simplest when all adapters in a batch share a rank. Either fix the rank platform-wide (simplest, and rank 16 is fine for most tasks) or pad to a common rank within a batch.

**Route by adapter affinity.** Requests for the same adapter should prefer the replica that already has it resident — the same [cache-affinity routing](../06-ai-infrastructure/kv-cache-management.html) logic as prefix caching, with a much cheaper miss.

**Survives to:** hundreds of customers.

**What breaks first:** a customer uploads a dataset that produces a model which is worse, and blames you. You need evaluation in the pipeline.

## Phase 3 — Dataset validation and evaluation gates

Most fine-tuning failures are data failures, and they are detectable before you spend a GPU-hour.

```diagram
   VALIDATION, BEFORE THE JOB IS QUEUED

   Structural    valid JSONL, required fields present,
                 messages in the expected role sequence
   Format        renders correctly under the base model's
                 CHAT TEMPLATE — the single most common
                 cause of "the fine-tune didn't work"
   Size          enough examples (< 50 is usually pointless),
                 token count within limits
   Quality       duplicate detection, length distribution,
                 label consistency on similar inputs
   Safety        PII scan, content classification
   Leakage       overlap between the training split and any
                 held-out evaluation set

   → Reject with SPECIFIC, actionable errors:
     "line 847: 'assistant' message is empty"
     not "invalid dataset"
```

Then split, train, and evaluate automatically:

```diagram
   dataset → 90% train / 10% held-out (stratified)
        ↓
   train the adapter
        ↓
   EVALUATE on the held-out split:
     · task metric vs the BASE model — did it improve?
     · general benchmarks — did it forget everything else?
        ↓
   report both to the customer BEFORE they deploy it
```

:::goat Report the regression, not just the improvement
[Catastrophic forgetting](../05-ai-foundations/fine-tuning.html) is the default outcome. A model fine-tuned on 3,000 support tickets gets better at support tickets and measurably worse at arithmetic, code, and instruction-following at the edges.

A platform that reports only "task accuracy improved from 71% to 89%" is hiding the other half. Report both:

```
   Your task:          71% → 89%   ▲ +18
   General reasoning:  64% → 58%   ▼ −6
   Instruction follow: 91% → 87%   ▼ −4
```

Then let the customer decide, and offer the mitigation — lower rank, fewer epochs, mixing in general data. This is a trust feature: the alternative is that they discover the regression in production and conclude your platform is bad.
:::

**What breaks first:** training jobs queue behind each other, and a customer waiting six hours for a thirty-minute job is unhappy.

## Phase 4 — The training scheduler

```diagram
   JOB QUEUE with fair scheduling

     tiers:      free (best effort, preemptible)
                 paid (guaranteed start within 1 hour)
                 enterprise (dedicated capacity)

     per-tenant concurrency cap  → no one customer floods
     gang scheduling             → multi-GPU jobs get all
                                   or nothing
     preemption                  → free-tier jobs yield to
                                   paid, with a checkpoint
                                   signal and a grace period
     spot instances for free tier → checkpointed every
                                   ~10 minutes, resumes
                                   automatically
```

All of this is [GPU cluster scheduling](../06-ai-infrastructure/gpu-cluster-scheduling.html) with tenants attached. The specific additions for this product:

- **Cost estimation before queueing.** Dataset size and epoch count give a good estimate of GPU-minutes; show it, and let the customer confirm.
- **Hard job cost ceilings.** A dataset 100× larger than expected should fail admission, not consume a day of GPU time.
- **Checkpointing even for short jobs.** A 40-minute job on spot capacity that loses 35 minutes of work is worse than one that resumes from minute 30.

## Phase 5 — Versioning and rollout

Customers retrain. They need to compare, roll out gradually, and roll back.

```diagram
   ft:customer-42:v1   (deployed, 100% of their traffic)
   ft:customer-42:v2   (trained, evaluated, not deployed)

   Customer-facing controls:
     · compare v1 vs v2 on their own held-out set
     · deploy v2 to a percentage of their traffic
     · promote or roll back

   Platform-side:
     · both adapters resident during the split — cheap,
       they're 50 MB
     · per-version metrics and cost attribution
     · adapters are immutable; a retrain is a NEW version,
       never an overwrite
```

Immutability is the important one. A customer who overwrites v1 and finds v2 worse has no way back, and "which adapter produced this output" becomes unanswerable — which matters for support and for compliance.

## Phase 6 — Isolation and multi-tenancy

The security surface of a platform that runs customer data through shared infrastructure:

| Boundary | Risk | Control |
|---|---|---|
| **Training data** | Leaking into another customer's model | Per-tenant storage with separate encryption keys; no cross-tenant batching in training |
| **Adapters** | Serving customer A's adapter to customer B | Adapter ID resolved from the authenticated tenant, never from the request body |
| **Prefix cache** | Cached KV shared across tenants | Key the cache by `(tenant, model, adapter, tokens)` |
| **Base model** | Shared by design | Fine — it's public weights |
| **Logs and traces** | Prompts containing customer data | Per-tenant retention and redaction policy |

**The adapter-resolution one is the sharp edge.** If the request specifies `model: "ft:cust-91:abc"` and the server trusts it, any authenticated customer can invoke any other customer's model. Resolve the adapter from the tenant's own namespace and reject anything outside it.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| LoRA adapters | Full fine-tuning per customer | 200× memory reduction; full FT makes the product impossible |
| Shared base, batched multi-adapter | Adapter swap per request | Swapping destroys batching, which is where all the throughput is |
| Fixed platform-wide rank | Per-customer rank | Simplifies batched kernels; rank 16 suffices for most tasks |
| Validate before queueing | Fail during training | Most failures are data failures and are detectable in seconds |
| Auto-evaluate on a held-out split | Trust the customer to evaluate | They mostly won't, and will blame the platform |
| Report general-benchmark regression | Report task improvement only | Forgetting is the default; hiding it destroys trust later |
| Immutable versioned adapters | Overwrite on retrain | No rollback, and no answer to "which model produced this" |
| Adapter resolved from tenant identity | Trust the model ID in the request | Otherwise any customer can invoke any other's model |
| Spot + checkpointing for free tier | On-demand for everything | Training tolerates preemption; it's the natural fit |

## What you'd cut for v1

Phases 4–6. Ship: dataset validation, LoRA training on a fixed rank, automatic held-out evaluation with both metrics reported, and multi-adapter serving. That's the product. Fair scheduling, gradual rollout, and spot capacity are optimisations you add when the queue and the bill justify them.

**Do not cut:** dataset format validation against the chat template, and multi-adapter serving. Skip the first and most fine-tunes silently fail; skip the second and the unit economics don't work.

## Explaining the design

> "The whole product rests on LoRA. Full fine-tuning a 70B model per customer would need 438 GPUs just to hold 500 customers' weights. With adapters at 50 MB against a shared base, it's two GPUs — a 200× reduction — and crucially, requests from different customers still batch together because the adapter is applied per row inside the kernel. Without that batching property the economics don't work at all.
>
> Around that, the platform is mostly validation and scheduling. Most fine-tuning failures are data failures, and nearly all of them — wrong format, too few examples, template mismatch — are detectable in seconds before you spend a GPU-hour. So validation is aggressive and errors are specific.
>
> After training I'd automatically evaluate on a held-out split against both the customer's task and general benchmarks, and report both. Catastrophic forgetting is the default outcome, and a platform that only reports the improvement is setting the customer up to discover the regression in production.
>
> The scheduling is standard multi-tenant GPU work — fair queues, gang scheduling, spot with checkpointing for the free tier, since training tolerates preemption well.
>
> The security detail I'd call out: the adapter must be resolved from the authenticated tenant's namespace, never from the model ID in the request. Trusting that string means any customer can invoke any other customer's model."

## Next

[Build a Pretraining Cluster](pretraining-run.html) — the same problems at the scale where the hardware itself becomes the design constraint.
