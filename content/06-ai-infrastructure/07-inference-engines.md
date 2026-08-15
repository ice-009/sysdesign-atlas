---
title: Inference Engines & Continuous Batching
summary: The scheduler at the heart of every LLM server — why static batching wastes most of a GPU, how iteration-level scheduling fixes it, and the prefill/decode interference nobody warns you about.
difficulty: Hard
scope: HLD
tags: [ai, inference, batching, scheduling, serving]
prereqs: [attention-and-kv-cache, queueing-theory, backpressure]
unlocks: Understanding and tuning the component that determines your serving cost.
---

## What an inference engine does

Between your HTTP handler and the GPU sits a scheduler making one decision, thousands of times a second: **which requests run in the next forward pass?**

That decision determines throughput, latency, and cost. Everything else in an inference engine — the kernels, the memory allocator, the API surface — supports it.

## Why static batching fails

The obvious approach: collect N requests, run them together, return when all are done.

```diagram
   STATIC BATCHING

   req A ████████████████████████ 500 output tokens
   req B ███░░░░░░░░░░░░░░░░░░░░░  20 tokens, then IDLE
   req C ████░░░░░░░░░░░░░░░░░░░░  30 tokens, then IDLE
   req D ██░░░░░░░░░░░░░░░░░░░░░░  15 tokens, then IDLE
                                   ░ = wasted slot

   The batch runs until the SLOWEST member finishes.
   Generation lengths vary by 10-50× in real traffic.

   → In this batch, ~70% of the slot-time is idle.
```

Two compounding problems: finished requests hold their slot doing nothing, and new arrivals wait for the whole batch to drain before they can start. Both get worse as length variance grows, and length variance in real chat traffic is enormous.

## Continuous batching

The fix is to schedule at the **iteration** level rather than the request level.

```diagram
   CONTINUOUS BATCHING (in-flight batching)

   After EVERY decode step:
     · evict any request that emitted its stop token
     · admit a waiting request into the freed slot
     · run the next step on whatever is currently resident

   req A ████████████████████████
   req B ███▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓   B finishes → E admitted here
   req C ████▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓   C finishes → F admitted
   req D ██▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
                                   ▓ = a different request

   → the batch stays full; no slot idles
```

This works because of a property established in [inference arithmetic](../05-ai-foundations/inference-arithmetic.html): each decode step is an independent forward pass over the current batch. There is no requirement that the batch membership stay constant between steps — the weights are read once regardless, and the batch dimension is just how many token vectors they multiply against.

**Reported throughput improvements are typically 2–4× over static batching**, sometimes far more with high length variance. It is the single highest-impact technique in LLM serving, and it costs nothing but scheduler complexity.

:::goat Batching here is qualitatively different from batching elsewhere
In most systems batching trades latency for throughput: you wait to accumulate a batch, so each request waits longer.

In LLM decode, **adding a request to the batch does not slow down the others**. The step time is set by reading the weights, which happens once regardless of batch size. Adding request 33 to a batch of 32 costs almost nothing until you saturate compute or run out of KV cache.

So throughput is nearly free up to the memory limit — which is why the correct instinct is "batch as much as memory allows," and why KV cache capacity, not compute, is the thing to optimise. It also means the classic latency-versus-throughput framing needs care here: the tension is real, but it enters through *queueing for admission*, not through batch execution.
:::

## Prefill/decode interference

The subtlety that makes real schedulers complicated.

Prefill is compute-bound and processes many positions at once. Decode is memory-bound and processes one. Running a large prefill in the same step as ongoing decodes means the decodes wait for it.

```diagram
   A request with a 32,000-token prompt is admitted.

   Its prefill takes ~2 seconds of GPU time.

   Meanwhile 60 users mid-conversation are streaming at
   one token every 8 ms.

   → all 60 streams STALL for 2 seconds.
     Every one of them sees a visible stutter because
     somebody else pasted a long document.
```

**Chunked prefill** is the standard fix: split a long prefill into chunks of, say, 512 tokens, and interleave them with decode steps.

```diagram
   WITHOUT CHUNKING          WITH CHUNKING

   [────── prefill ──────]   [pf][d][pf][d][pf][d][pf][d]
   [d][d][d][d][d][d]

   decode stalls 2 s          each decode step delayed by
                              one chunk's worth (~30 ms)
                              prefill takes slightly longer
                              overall, nobody stutters
```

This is the same idea as spreading a database checkpoint over its interval rather than storming the disk: convert one large disruptive operation into many small ones with bounded impact.

**Disaggregation** takes it further — run prefill and decode on *different GPU pools*, transferring the KV cache between them. Each pool can then be sized, batched, and even hardware-matched for its own characteristics. It costs a KV cache transfer over the interconnect and is developed further in [KV cache management](kv-cache-management.html).

## The scheduler's decisions

Every iteration, the scheduler must decide:

| Decision | Considerations |
|---|---|
| **Admit a waiting request?** | Is there KV cache for its prompt plus expected generation? Would admitting it starve running requests? |
| **How much prefill this step?** | Chunk size trades TTFT for decode smoothness |
| **Preempt anyone?** | Under memory pressure: evict a request's KV and re-prefill later, or swap it to host memory |
| **Which waiting request first?** | FIFO, shortest-first, priority class, or deadline |
| **Stop this request?** | Stop token, max length, client disconnect, or budget exceeded |

:::trap Admission control needs an estimate of output length, which you don't have
To decide whether a request fits, you'd like to know how much KV cache it will eventually need — which depends on how many tokens it generates, which is unknowable in advance.

Three strategies, all imperfect:
- **Optimistic** — admit, and preempt if you run out. Best throughput; occasional visible stalls when a preemption hits.
- **Conservative** — reserve for `max_tokens`. No preemption, and badly underutilised because most requests generate far less than their cap.
- **Predictive** — estimate from the prompt, the endpoint, or historical distribution. Better than either, and wrong sometimes.

Most production engines are optimistic with preemption, because preemption is recoverable and underutilisation is permanent. Requiring clients to set an honest `max_tokens` helps considerably, which is a good reason to make it a required parameter.
:::

## Preemption

When memory runs out with requests in flight, something must give.

```diagram
   Option 1 — RECOMPUTE
     drop the request's KV blocks entirely
     when resumed, re-prefill its whole context
     cost: one full prefill (expensive for long contexts)
     benefit: frees memory immediately, no transfer

   Option 2 — SWAP
     copy KV blocks to host memory over PCIe
     copy back on resume
     cost: 2 × transfer over ~64 GB/s PCIe
     benefit: no recomputation

   Crossover: swapping wins when the context is long enough
   that re-prefill costs more than 2× the PCIe transfer.
   For short contexts, recompute is cheaper.

   Option 3 — DON'T GET HERE
     admission control that keeps a memory reserve
```

The third is the real answer. Preemption is a safety valve, and a system that preempts regularly is a system whose admission control is too loose.

## Scheduling policy and fairness

**FCFS** is the default and is vulnerable to head-of-line blocking — a 100K-token prompt at the front delays everyone behind it.

**Shortest-job-first** minimises average waiting time (a classic result), but you don't know job length in advance and long requests can starve.

**Priority lanes** are what production systems actually do: separate interactive traffic from batch, give interactive smaller batches and admission preference, and let batch traffic run at large batch sizes in the leftover capacity. This resolves the throughput/TTFT tension by refusing to pick one — the same reasoning as separating fast and slow endpoints to reduce [queueing variance](../01-foundations/queueing-theory.html).

**Fairness across tenants** needs explicit accounting. A single user submitting a thousand long requests will consume the whole batch under FCFS. Per-tenant token budgets with weighted fair queueing is the standard answer, and the unit must be tokens rather than requests.

## What to measure

| Metric | Meaning | Watch for |
|---|---|---|
| **TTFT** | Time to first token | Dominated by queue wait under load, not prefill |
| **TPOT** | Time per output token | Should be stable; spikes mean interference |
| **Throughput** | Total tokens/s across all users | Your cost denominator |
| **Goodput** | Tokens/s *meeting SLA* | The honest number |
| **KV cache utilisation** | Fraction of cache in use | The real capacity signal |
| **Preemption rate** | Requests evicted per minute | Above ~0 means admission is too loose |
| **Queue depth and wait** | Requests waiting, and for how long | Wait time is the actionable one |

:::goat Goodput is the number that keeps you honest
A system can report excellent throughput while every request exceeds its latency target — you achieved that throughput by queueing everyone.

Goodput counts only tokens delivered within the SLA. It falls when you over-batch, which is exactly the behaviour throughput alone rewards.

The related operational point: **GPU autoscaling takes minutes**, because a node must be provisioned and tens of gigabytes of weights loaded. You cannot scale reactively into a spike the way a stateless web tier does. So the response to overload has to be admission control and load shedding at the edge, with warm capacity held in reserve — [backpressure](../03-distributed/backpressure.html) applied to a resource that genuinely cannot be added quickly.
:::

## The engines

| Engine | Emphasis |
|---|---|
| **vLLM** | PagedAttention, continuous batching, broad model support. The common default |
| **TensorRT-LLM** | Compiled kernels, lowest latency on NVIDIA hardware, heavier build step |
| **SGLang** | RadixAttention for aggressive prefix caching; strong on structured and multi-turn workloads |
| **TGI** | Hugging Face's server; good ergonomics and ecosystem integration |
| **llama.cpp** | CPU and consumer GPU, aggressive quantization, local deployment |

They differ far less than they used to — continuous batching and paged KV are table stakes. Current differentiation is in prefix caching sophistication, quantization support, structured output, and how well the scheduler handles mixed workloads.

:::exercise Tune a scheduler
A 70B model on 8 GPUs. 200 concurrent users. Prompts average 2,000 tokens (p99: 30,000). Outputs average 400 tokens (p99: 2,000). SLA: TTFT under 1 s, TPOT under 50 ms.

1. With static batching at size 32, estimate slot waste given the output length distribution. What throughput are you losing?
2. A p99 prompt (30,000 tokens) arrives. Without chunked prefill, how long do the other 199 streams stall? Compute it from prefill FLOPs.
3. Choose a prefill chunk size. What does it do to TTFT for the long request, and to TPOT for everyone else? Show the trade.
4. KV cache is 164 KB/token and you have 400 GB available. How many concurrent requests at average length? At p99 length?
5. Design the admission policy: what do you check before admitting, what reserve do you hold, and what do you do when a request would exceed available memory?
6. You measure 95% throughput but 60% goodput. What is happening, and what's the single change you'd make?
:::

:::paper Sources
*Orca: A Distributed Serving System for Transformer-Based Generative Models* (Yu et al., OSDI 2022) introduced iteration-level scheduling — the origin of continuous batching.

*Efficient Memory Management for LLM Serving with PagedAttention* (Kwon et al., SOSP 2023) is vLLM. *SARATHI* (Agrawal et al., 2023) is chunked prefill and the interference analysis. *DistServe* (Zhong et al., OSDI 2024) is prefill/decode disaggregation.
:::

## What to carry forward

- **Static batching wastes most of the GPU** because generation lengths vary 10–50×.
- **Continuous batching schedules per iteration** — evict and admit after every decode step. 2–4× throughput for free.
- **Adding to the batch doesn't slow the others** — batch until memory runs out.
- **Prefill stalls decode.** Chunked prefill bounds the damage; disaggregation eliminates it.
- **Admission control needs an output-length estimate you don't have.** Be optimistic and preempt, or require honest `max_tokens`.
- **Priority lanes**, not one setting, resolve the TTFT/throughput tension.
- **Measure goodput, not throughput.** GPU capacity cannot be autoscaled reactively.
