---
title: Serving Reasoning Models
summary: What changes when a model thinks for thousands of tokens before it answers — an output-heavy workload, KV cache that grows mid-request, minute-long responses, and budgets that turn accuracy into a dial you pay for.
difficulty: Hard
scope: HLD
tags: [ai, inference, reasoning, serving, cost]
prereqs: [inference-engines, kv-cache-management, ai-cost-model, decoding-strategies]
unlocks: Capacity-planning, pricing and designing the user experience for models that spend most of their compute thinking.
---

:::predict Guess first
1. A chat model reads 2,000 tokens and writes 400. A reasoning model reads the same 2,000 but thinks for 8,000 tokens before a 500-token answer. Roughly how much more decode work is that?
2. A request is admitted with a 2,000-token prompt. Does the GPU memory it needs stay the same while it runs?
3. A user waits 90 seconds for an answer with nothing on screen. What will they do — and what might the load balancer in between do?
:::

## What a reasoning model does differently

A **reasoning model** works a problem through in writing before it replies. It generates a long chain of intermediate steps — trying approaches, checking them, backtracking — and only then writes the answer the user sees. Those intermediate steps are called **reasoning tokens** or **thinking tokens**. Depending on the product they're hidden, summarised, or shown in full.

The first widely used examples arrived in late 2024 and early 2025 — OpenAI's o1 series, then DeepSeek-R1, followed by "thinking" modes in most major model families. They are trained largely with reinforcement learning against answers that can be checked automatically, covered in [fine-tuning](../05-ai-foundations/fine-tuning.html).

The infrastructure consequence is simple to state and changes almost everything: **the model now spends most of its compute writing tokens nobody may read.**

## Test-time compute: accuracy you buy at serving time

Traditionally a model's quality was fixed when training ended. Reasoning models add a second dial. Letting the model think longer on a problem — spending more **test-time compute** — measurably raises accuracy on hard maths, code and multi-step questions. OpenAI's 2024 write-up showed accuracy climbing steadily as thinking compute grew, roughly in proportion to its logarithm; Snell and colleagues showed that for some problems, spending extra compute at inference can beat using a much larger model.

That reframes serving:

```diagram
   CLASSIC MODEL                     REASONING MODEL

   quality fixed at training         quality partly chosen per request
   cost per request ≈ constant       cost grows with thinking length
   "which model?"                    "which model, AND how long
                                      should it think?"
```

The catch is in the shape of the curve: accuracy grows roughly with the *logarithm* of thinking tokens, while cost grows *linearly*. Each doubling of thinking buys a smaller gain than the last, at the same price. Somewhere there's a point past which more thinking isn't worth it — and it differs by question.

## The workload flips to output-heavy

[Inference arithmetic](../05-ai-foundations/inference-arithmetic.html) established that prefill (reading the prompt) is compute-bound and cheap per token, while decode (writing tokens) is memory-bandwidth-bound and expensive. Chat traffic is mostly input. Reasoning traffic is mostly output.

:::derive How the token mix changes (illustrative numbers)
```
                       input    thinking   answer    output share
   Chat turn           2,000        0        400       17%
   Reasoning request   2,000    8,000        500       81%

   Decode tokens per request:
     chat        400
     reasoning   8,500        → about 21× the decode work

   Decode is the expensive, bandwidth-bound phase, so a
   reasoning request can cost an order of magnitude more GPU
   time than a chat turn with the same prompt.
```
:::

Real thinking lengths vary enormously — a few hundred tokens for an easy question, tens of thousands for a hard proof or a long coding task — so treat these figures as the shape of the problem rather than a measurement.

## KV cache that grows while the request runs

The [KV cache](kv-cache-management.html) holds attention state for every token in a request, and it grows by one token's worth with every token generated. For chat that growth is small. For reasoning it dominates.

:::derive Concurrency, chat versus reasoning
```
   Model: 70B-class, grouped-query attention, FP8 KV cache
     KV per token ≈ 164 KB          (from inference arithmetic)
   KV budget on an 8-GPU node ≈ 520 GB

   Chat:       2,000 + 400        =  2,400 tokens
               2,400 × 164 KB     ≈  0.4 GB per request
               520 GB / 0.4 GB    ≈  1,300 concurrent

   Reasoning:  2,000 + 8,000 + 500 = 10,500 tokens
               10,500 × 164 KB    ≈  1.7 GB per request
               520 GB / 1.7 GB    ≈  300 concurrent

   → roughly 4× fewer concurrent requests on the same node,
     and each one holds its memory for far longer.
```
:::

Two scheduling problems follow:

- **Admission is a guess about the future.** A request that fits comfortably when admitted at 2,000 tokens may need five times that memory a minute later. Admit optimistically and the node runs out of memory mid-generation; reserve for the worst case and most of the memory sits idle. Real engines admit optimistically and **preempt** when memory runs short — see [inference engines](inference-engines.html).
- **Preemption gets expensive.** Evicting a request means either recomputing its context later or swapping its KV cache to host memory. For a request already 8,000 tokens into its thinking, recomputing means re-running all of that, so **swapping usually wins** for long reasoning contexts, and preempting is best avoided altogether by keeping a memory reserve.

## Latency: the first token that matters moved

For chat, the key latency metric is time to first token. For a reasoning model, the first *visible* token may arrive only after thousands of thinking tokens.

```diagram
   time to first ANSWER token  ≈  prefill + thinking tokens × time per token

   8,000 thinking tokens × 12 ms per token  ≈  96 seconds

   Chat users expect something within a second.
   Reasoning users may wait one to several minutes.
```

That forces product and infrastructure changes:

- **Show progress.** Stream something while the model thinks — a summary of its reasoning, a "working on: checking the second case" status, or at least a live indicator. Silence for 90 seconds reads as broken.
- **Let people cancel**, and make sure cancellation reaches the GPU and frees the slot. An abandoned reasoning request can burn a minute of decode for nothing.
- **Watch the timeouts in between.** Load balancers, proxies and API gateways often close connections that have been idle for around a minute. A long-thinking request that sends nothing can be cut off by your own infrastructure. Send periodic keep-alive events over the stream, or —
- **Go asynchronous for long tasks.** Accept the request, return an ID, run it in the background and let the client poll or receive a webhook when it's done. OpenAI added a background mode for exactly this in May 2025. It's the same shape as any long-running job — see [agent infrastructure](../07-ai-systems/agent-infrastructure.html) for durable execution.

## Serving: provision for decode

Because the work is overwhelmingly decode, the serving stack shifts:

- **More decode capacity.** In a [disaggregated](inference-engines.html) deployment — separate GPU pools for prefill and decode — reasoning traffic needs a much larger decode pool relative to prefill than chat does. The prefill-to-decode ratio becomes a tuning knob driven by your mix of chat and reasoning traffic.
- **Speculative decoding pays off more.** [Speculative decoding](../05-ai-foundations/decoding-strategies.html) speeds up the bandwidth-bound decode phase by letting a cheap drafter propose tokens that the big model verifies in one pass. Decode-heavy workloads gain the most from it, and built-in multi-token-prediction drafters make it cheap to deploy. The usual caveat holds: at very high batch sizes the GPU is busy and the gain shrinks.
- **Separate lanes.** A single 10-minute reasoning request occupies a slot that could have served dozens of chat turns. Put reasoning traffic in its own priority lane, with its own concurrency limits, so a burst of long jobs can't starve interactive chat — the same [bulkhead](../03-distributed/backpressure.html) idea as anywhere else.

## Budgets: making thinking a dial

Since accuracy grows with thinking and cost grows with it too, every reasoning platform needs a way to cap it.

**Reasoning effort or thinking budget.** Most reasoning APIs expose a control — a coarse low / medium / high effort setting, or an explicit maximum number of thinking tokens. A routine request gets a small budget; a hard one gets more.

**Budget forcing.** The *s1* paper (Muennighoff and colleagues, 2025) showed a strikingly simple technique: to cap thinking, stop the model at the budget and make it answer; to extend thinking, suppress its attempt to stop and append a word like "Wait", prompting it to keep checking. Accuracy tracked the budget — evidence that thinking length really is a controllable dial.

**Route by difficulty.** The cheapest reasoning tokens are the ones you never generate. A small classifier or a cheap model decides whether a request needs reasoning at all; easy requests go to a fast non-reasoning model or a minimal budget. This is the same [model routing](ai-cost-model.html) lever as before, with a larger payoff.

**Parallel sampling for the hardest cases.** For high-stakes problems, generate several independent attempts and pick the best with a verifier, or take the most common answer — *best-of-n* or *self-consistency*. With prefix caching, all n attempts share the cached prompt, so the prompt is paid for once; the decode cost is still n times. Reserve it for questions where being right is worth n times the cost.

## Tools inside the thinking

Newer reasoning models can call tools — search, code execution, other APIs — in the middle of their reasoning, then keep thinking with the results. A single request becomes a small [agent loop](../07-ai-systems/agent-architectures.html):

```diagram
   think ──► call search ──► think ──► run code ──► think ──► answer
     │          │                        │
     └── KV cache keeps growing through every step
```

Everything from the agent pages applies: bound the number of tool calls, enforce timeouts, and authorise tools on the user's identity. One serving detail matters too: APIs that let you carry the model's reasoning state from one call to the next (instead of discarding it) keep the prompt prefix stable, which keeps prefix caching effective across turns.

## Cost and rate limits

- **Thinking tokens are billed as output tokens** — the most expensive kind — whether or not the user sees them. Cost attribution should record reasoning tokens as their own line, as the [cost model](ai-cost-model.html) recommends.
- **`max_tokens` must include the thinking.** A limit set for chat-sized answers will cut a reasoning model off mid-thought, before it has written any answer at all.
- **Rate-limit on output tokens**, not requests. Two requests can differ by 50× in output.
- **Flat-rate pricing breaks.** As with agents, a handful of heavy reasoning users can cost more than everyone else combined. Meter, cap or tier it.

## What to watch

| Signal | Why |
|---|---|
| **Reasoning-token distribution (p50, p99)** | Cost and latency live in the long tail |
| **Truncation rate** | Requests that hit the budget before answering — the budget is too tight |
| **Time to first answer token** | The latency users actually feel |
| **KV cache utilisation and preemption rate** | Growth mid-request is the capacity risk |
| **Accuracy versus budget, per request class** | Tells you where extra thinking stops paying |

:::trap "Thinking is free accuracy, so turn it up"
It isn't free — every thinking token is a billed, bandwidth-bound output token — and it isn't always accuracy. On easy questions, long reasoning adds cost and latency for no gain, and models can talk themselves out of a correct first answer.

The mature setup measures accuracy against budget for each kind of request and sets budgets where the curve flattens: near zero for lookups and chit-chat, generous for proofs and hard debugging. Treat reasoning length as a cost you justify per request class, not a quality setting you maximise.
:::

:::goat The design question underneath
Reasoning models turn **compute per request into a product decision**. The same model can answer cheaply and quickly or slowly and carefully, and the platform decides which, request by request.

That makes the serving stack look less like a fixed-cost API and more like a scheduler of variable-length jobs — with budgets, priority lanes, asynchronous delivery and progress reporting. The engineering is familiar from batch systems and job schedulers; what's new is that the job length is chosen by the model as it goes, and you have to bound it from outside.
:::

:::exercise Plan a reasoning tier
You're adding a reasoning mode to an assistant that today serves 2,000 chat requests/minute on 8-GPU nodes with a 520 GB KV budget each. You expect 10% of requests to use reasoning, averaging 6,000 thinking tokens (p99 30,000) and 400 answer tokens, on 2,000-token prompts. Use 164 KB of KV per token and about 12 ms per output token.

1. Compute KV memory per reasoning request at the average and at p99. How many average reasoning requests fit on one node?
2. Estimate time to first answer token at the average and p99. Which UX pattern do you use for each?
3. Your load balancer's idle timeout is 60 seconds. Which requests are at risk, and what are the two fixes?
4. How much more decode work does the reasoning traffic add compared with serving the same requests as chat? What does that do to your prefill-to-decode ratio?
5. Design the budgets: which requests get reasoning at all, and what effort levels exist? How would you find where accuracy stops improving?
6. A product manager wants best-of-4 sampling on every reasoning request. Estimate the cost change and argue for where it's worth it.
:::

:::paper Sources
OpenAI's *Learning to Reason with LLMs* (2024) introduced the o1 models and showed accuracy scaling with test-time compute. *DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning* (DeepSeek-AI, 2025) describes training reasoning with verifiable rewards and released open weights.

*Scaling LLM Test-Time Compute Optimally can be More Effective than Scaling Model Parameters* (Snell et al., 2024) analyses how to spend inference compute. *s1: Simple test-time scaling* (Muennighoff et al., 2025) introduced budget forcing.
:::

## Check yourself

```recall
Q: What is a reasoning model, and what are thinking tokens?
A: A model that writes a long chain of intermediate steps before its answer; those steps are thinking (reasoning) tokens, often hidden or summarised, and they dominate its compute.

Q: What is test-time compute, and what is the catch?
A: Spending more inference compute — longer thinking — to raise accuracy per request. Accuracy grows roughly with the logarithm of thinking tokens while cost grows linearly, so each doubling buys less.

Q: How does the token mix change from chat to reasoning?
A: A chat turn of 2,000 in and 400 out is mostly input; a reasoning request adding 8,000 thinking tokens is ~80% output — about 21× the expensive, bandwidth-bound decode work.

Q: Why do reasoning requests cut concurrency?
A: The KV cache grows with every generated token: at 164 KB per token, 10,500 tokens is ~1.7 GB versus ~0.4 GB for a chat turn — about 300 versus 1,300 concurrent on a 520 GB budget.

Q: What happens to latency, and how should the product respond?
A: The first answer token waits for all the thinking (8,000 × 12 ms ≈ 96 s). Stream progress or summaries, support real cancellation, send keep-alives past proxy idle timeouts, or run long tasks asynchronously with polling or webhooks.

Q: How should serving infrastructure change for reasoning traffic?
A: Provision more decode than prefill, use speculative decoding and MTP drafters for the decode-heavy work, prefer swapping over recompute when preempting long contexts, and isolate reasoning in its own priority lane.

Q: Name three ways to control thinking cost.
A: Effort levels or thinking-token budgets, budget forcing (stop at the budget, or append "Wait" to extend), routing easy requests away from reasoning — and best-of-n only where accuracy justifies n× decode.

Q: What billing and limit changes do reasoning models need?
A: Thinking tokens are billed as output, max_tokens must include them or answers get cut off before they start, and rate limits should count output tokens rather than requests.
```

## What to carry forward

- Reasoning models **spend most of their compute on thinking tokens** — an output-heavy, decode-bound workload.
- **KV cache grows during the request**, cutting concurrency and making admission and preemption harder.
- **Time to first answer token** can be minutes: stream progress, allow cancel, beware idle timeouts, go async for long jobs.
- **Thinking is a dial**: budgets, budget forcing and difficulty routing keep it where accuracy still pays.
- **Bill, limit and monitor output tokens** — including truncation and the long tail of thinking lengths.
