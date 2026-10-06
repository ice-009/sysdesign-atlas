---
title: Model Deployment & Rollout
summary: Shipping a 140 GB artifact — registries, weight distribution, warm-up, and why canarying a model needs quality gates that a service deployment never does.
difficulty: Medium
scope: HLD
tags: [ai, deployment, mlops, rollout]
prereqs: [object-storage, inference-engines]
unlocks: Rolling out a model change without a quality regression or a cold-start outage.
---

:::predict Guess first
1. A new model version is 4% worse at writing code. Will your error-rate dashboards catch it during the rollout?
2. Rolling out 140 GB of weights to 200 servers straight from object storage — roughly how long might that take, and what does it mean for rolling back?
3. A model server process starts listening on its port. Is it ready for real users?
:::

## Why this isn't a normal deployment

A container image is a few hundred megabytes, starts in seconds, and is either correct or throws an exception. A model deployment breaks every one of those assumptions.

```diagram
   SERVICE DEPLOY                 MODEL DEPLOY

   200 MB image                   70-500 GB of weights
   starts in seconds              minutes to load into HBM
   correctness is binary          quality is a distribution
   errors are visible             regressions are silent
   rollback is instant            rollback needs the old weights
                                    still resident somewhere
   canary on error rate           canary on... what, exactly?
```

The last two rows are where teams get hurt. A model that is 4% worse at code generation throws no exceptions and fires no alerts. It just quietly makes your product worse until someone notices in a week.

## The registry

Weights alone are not deployable. A model version is a bundle:

```
   model: support-classifier
   version: 2026-08-03-a7f31c
   ├── weights/               sharded safetensors
   ├── tokenizer/             config + merges + vocab
   ├── config.json            architecture, dtype, context length
   ├── generation_config      default sampling parameters
   ├── chat_template          EXACTLY the training format
   └── metadata
       ├── base model + commit
       ├── training data snapshot ID
       ├── eval results at release
       ├── quantization recipe
       └── engine version compatibility range
```

:::trap The chat template is the most common silent failure
A fine-tuned model learned one exact prompt format — special tokens, whitespace, role markers, all of it. Serve it with a slightly different template and quality degrades noticeably while nothing errors.

This happens constantly: the template lives in the training code, the serving code has its own copy, and they drift. Or the inference engine version changes its default template.

**Ship the template as part of the model artifact** and have the server load it from there, never from its own config. Then add a smoke test that renders a known conversation and asserts on the exact token IDs — not the string, the token IDs, because whitespace differences are invisible in a string diff and very visible to the model.
:::

**Content-address everything.** The version ID should be a hash of the weights plus config. Then "which model produced this output" is answerable exactly, and two deployments claiming the same version are provably identical.

## Distributing 140 GB

Rolling out to 200 replicas means moving 28 TB. Naively, that's 200 concurrent pulls from object storage.

| Method | Throughput | Notes |
|---|---|---|
| **Direct from object storage** | Limited per-connection; throttles under fan-out | Fine at small scale |
| **Parallel range requests** | 5–10× a single stream | The easy first win |
| **Regional cache / mirror** | Pay egress once per region | Standard for multi-region |
| **P2P distribution** (Dragonfly, Kraken) | Scales with fleet size | Replicas seed each other; best for large fleets |
| **Pre-baked into the node image** | Instant | Inflexible; a new model needs a new image |
| **Shared network filesystem** | One copy | The filesystem becomes a single point of failure and a bottleneck |

**Lazy loading** is the technique worth knowing: memory-map the weight file and let pages fault in as layers are first touched. The server starts accepting traffic almost immediately and the first few requests are slow while pages load. Combined with `safetensors` — designed for exactly this, zero-copy mmap with no deserialisation — startup drops from minutes to seconds.

:::derive Why a naive rollout takes hours
```
   200 replicas × 140 GB = 28 TB to distribute

   Direct from object storage, ~1 GB/s per replica,
   with a 20 GB/s aggregate throttle on the bucket:

     28,000 GB / 20 GB/s  =  1,400 s  ≈  23 minutes
     — if the throttle is the only limit, and nothing
       else is using the bucket

   With P2P distribution, effective bandwidth roughly
   doubles per round as replicas become seeders:

     1 → 2 → 4 → 8 → ... → 200 in ~8 rounds
     each round moves 140 GB at local network speed
     ≈ 3-4 minutes total

   And a rollout that takes 23 minutes means a ROLLBACK
   takes 23 minutes. That's the number that matters
   during an incident.
```
:::

## Warm-up

A freshly loaded model is slow for reasons beyond loading the weights. The GPU library picks and tunes its fastest routines the first time it sees each request shape, memory pools have to be carved out, and the prefix cache is empty. All of that happens on whoever's request arrives first.

```diagram
   NAIVE                          WITH WARM-UP

   pod ready → traffic            pod starts
     ↓                              ↓
   first 100 requests are         load weights
   3-10× slow                       ↓
     ↓                            run synthetic requests at
   p99 spike visible to users       representative shapes
                                    ↓
                                  pre-populate common prefixes
                                    ↓
                                  THEN mark ready → traffic
```

A **readiness probe** is the check an orchestrator uses to decide a new instance can receive traffic. It must not pass until warm-up completes — and this is a common misconfiguration: the process is listening, so Kubernetes declares it ready and sends users straight into the slow cold requests. The probe should test "warm", not "up".

**Pre-populating the prefix cache** with your system prompts is worth doing explicitly — otherwise the first N users of each replica pay a full prefill for content that should have been cached.

## Rollout strategy

```viz
{
  "type": "steps",
  "caption": "Each gate can stop the rollout. Quality gates are the ones a service deploy doesn't have.",
  "steps": [
    { "label": "Offline eval", "sub": "golden sets, must beat the incumbent", "accent": "#38bdf8" },
    { "label": "Shadow", "sub": "mirror real traffic, compare, serve nothing", "accent": "#22d3ee" },
    { "label": "Canary 1%", "sub": "real users; watch latency AND quality", "accent": "#4ade80" },
    { "label": "Ramp", "sub": "5% → 25% → 50%, holding at each", "accent": "#fbbf24" },
    { "label": "Full", "sub": "old version stays warm for fast rollback", "accent": "#fb7185" }
  ]
}
```

**Shadow mode** is disproportionately valuable here and underused. Send real production traffic to the new model, discard its output, and compare against the incumbent's. You get real distribution coverage with zero user risk. What you cannot get from it: anything requiring user feedback, since nobody sees the output.

**Canary needs quality signals, not just error rates.** A model regression shows up as:

| Signal | Detects |
|---|---|
| Output length distribution | Truncation, runaway generation, format collapse |
| Refusal / safety-trigger rate | Over-alignment or under-alignment |
| Tool-call validity rate | Structured output degradation — very sensitive |
| Downstream conversion or task success | The thing you actually care about |
| Explicit user feedback (thumbs) | Slow signal, high value |
| Retry and regeneration rate | Users silently telling you the answer was bad |
| LLM-judge score on a live sample | Fast proxy; needs its own validation |

**Tool-call validity is the best early indicator** in an agentic product. It's binary, high-volume, computable in real time, and extremely sensitive to model changes. A drop from 98% to 94% is unambiguous and shows up within minutes.

:::goat The rollback problem is specific to models
Rolling back a service means redeploying the previous image — seconds. Rolling back a model means the previous weights must still be *somewhere fast*.

The options and their costs:
- **Keep the old version loaded on some replicas.** Instant rollback, and you're paying for double capacity during the ramp.
- **Keep it on local NVMe.** Rollback in a minute or two. Cheap. Usually the right answer.
- **Re-pull from object storage.** 20+ minutes. Unacceptable during an incident.

Decide this *before* the rollout, and write down the rollback trigger — which metric, at what threshold, for how long — so the decision isn't being made under pressure by whoever is on call. The most common failure is discovering mid-incident that rolling back takes half an hour.
:::

## A/B testing models

Beyond canarying, you often want to *measure* which model is better on live traffic.

- **Randomise by user, not by request.** Users notice inconsistency within a session, and per-request randomisation contaminates conversation history with two different models' outputs.
- **Run long enough for slow metrics.** Retention and task-completion signals take days to weeks; latency and validity take minutes.
- **Watch for interaction effects.** A model that's better in isolation can be worse combined with your prompts, which were tuned for the old one.
- **Beware novelty.** Behaviour change alone moves engagement metrics for a few days in either direction.

## Multi-model serving

Most production systems serve several models. Two shapes:

**Dedicated pools** — one model per replica set. Simple, isolated, and you pay for idle capacity per model.

**Shared base with adapters** — one base model, many [LoRA adapters](../05-ai-foundations/fine-tuning.html) loaded on demand. Enormously more efficient for many fine-tuned variants: 100 customer-specific models in the memory of one, with requests from different customers batching together.

The routing layer then needs to know which model each request wants, keep hot adapters resident, and evict cold ones by LRU — a small caching problem sitting on top of the serving stack.

:::exercise Plan a rollout
You're upgrading the model behind a coding assistant: 300 replicas, 140 GB weights, 50,000 requests/minute at peak.

1. Estimate distribution time for direct object-storage pull versus P2P. What does each imply for rollback time?
2. Design the warm-up. What synthetic requests, what shapes, how long? What does the readiness probe check?
3. Choose three canary metrics with thresholds and evaluation windows. Which gives you the fastest reliable signal?
4. Shadow mode: what do you compare, and how do you decide the new model is better when there's no ground truth?
5. Write the rollback trigger as a precise, automatable rule. What's your rollback time budget, and what does hitting it cost in idle capacity?
6. Mid-canary, tool-call validity drops from 98% to 95% but user thumbs-up rate is *up* 2%. What do you do?
:::

:::paper Sources
No canonical paper; this is operational practice. *Hidden Technical Debt in Machine Learning Systems* (Sculley et al., NIPS 2015) remains the best statement of why ML deployment differs from software deployment.

For the mechanics: the `safetensors` format documentation on zero-copy loading, and the Dragonfly / Kraken projects for P2P artifact distribution.
:::

## Check yourself

```recall
Q: Why is a model deploy unlike a service deploy?
A: 70–500 GB of weights take minutes to load, quality is a distribution rather than pass/fail, regressions are silent, and rollback needs the old weights somewhere fast.

Q: What belongs in a model artifact?
A: Weights, tokenizer, config, generation defaults, the exact chat template and metadata (base model, data snapshot, eval results, quantization recipe, engine compatibility), content-addressed.

Q: Why is the chat template the most common silent failure?
A: A model learned one exact format; serving with a drifted copy degrades quality with no error. Ship it in the artifact and smoke-test the rendered token IDs, not the string.

Q: How do you distribute huge weights quickly?
A: Parallel range requests, regional mirrors, P2P distribution (replicas seed each other — minutes instead of ~23), and lazy mmap loading of safetensors so serving starts almost immediately.

Q: Why warm up before marking a replica ready?
A: Kernel autotuning, memory pools and an empty prefix cache make first requests 3–10× slower. Run representative synthetic requests, pre-populate system prompts, and have the readiness probe test "warm", not "up".

Q: What is shadow mode good for?
A: Mirroring real traffic to the new model and comparing outputs with zero user risk and real distribution coverage — though it can't measure user feedback.

Q: Which canary signals catch model regressions?
A: Output length distribution, refusal rate, tool-call validity (the best fast indicator), task success, retries and regenerations, thumbs feedback and an LLM judge on a live sample.

Q: How should rollback and A/B testing be set up?
A: Keep the old weights on local NVMe or warm replicas, with a written, automatable rollback trigger. Randomise A/B tests by user, not request, and run long enough for slow metrics.
```

## What to carry forward

- A model version is **weights plus tokenizer plus chat template plus metadata**, content-addressed.
- **The chat template is the most common silent failure.** Ship it with the artifact; assert on token IDs.
- **Distribution time is rollback time.** P2P or local NVMe caching, decided in advance.
- **Warm up before marking ready** — CUDA graphs, kernel autotuning, prefix cache.
- **Canary on quality signals**, not error rates. Tool-call validity is the best fast indicator.
- **Shadow mode gives real distribution coverage at zero user risk.**
- **Randomise A/B by user, not request.**
