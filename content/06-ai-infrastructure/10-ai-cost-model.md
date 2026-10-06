---
title: The Cost Model
summary: Deriving dollars per million tokens from hardware specs, why utilization dominates every other term, and how to decide between an API and self-hosting with actual arithmetic.
difficulty: Medium
scope: HLD
tags: [ai, cost, capacity, economics]
prereqs: [inference-arithmetic, back-of-envelope, gpus]
unlocks: Making the build-versus-buy decision with numbers instead of intuition.
---

:::predict Guess first
1. The same GPUs, model and code — could cost per token differ by 4× between two companies?
2. An API charges $3 per million output tokens; self-hosting might cost $0.28. Does that make self-hosting the obvious choice?
3. A chat message costs about 2,500 tokens. Roughly how many might one agent task consume?
:::

## Building the model from the bottom

Cost per token is derivable from three quantities you already know how to compute.

:::derive Cost per million tokens, from first principles
```
   INPUTS
     H  = hourly cost of the serving node
     T  = sustained output tokens/second at full batch
     U  = average utilisation (0 to 1) — the fraction of the
          time the GPU is actually generating. You rent it by
          the hour whether or not anyone is using it, so this
          term is what turns idle capacity into cost per token.

   cost per output token = H / (3600 × T × U)

   ── WORKED EXAMPLE ──
   8× GPU node, reserved pricing:      H = $22/hour
   70B model at FP8, tensor-parallel across 8:

     TPOT (from inference arithmetic):
       8.75 GB per GPU / 3 TB/s × 1.4 overhead  ≈ 4.1 ms
       → 244 tokens/s per request

     Sustained batch of 200 concurrent decodes:
       T = 200 × 244 = 48,800 tokens/s

   At U = 1.0 (never happens):
     $22 / (3600 × 48,800)  = $0.125 per 1M output tokens

   At U = 0.45 (realistic for a product with diurnal traffic):
     $0.125 / 0.45          = $0.28 per 1M output tokens

   INPUT tokens are cheaper. Prefill is compute-bound and
   batches at very high arithmetic intensity, so it processes
   roughly 4-8× more tokens/second than decode:
     ≈ $0.04-0.07 per 1M input tokens

   CACHED input is cheaper again — it skips prefill entirely,
   costing only the memory to hold the blocks.
```
:::

## Utilization dominates everything

```diagram
   Same hardware, same model, same code:

     U = 90%   →  $0.14 / 1M tokens
     U = 60%   →  $0.21
     U = 40%   →  $0.31
     U = 20%   →  $0.63

   A 4.5× cost swing, entirely from how full the GPUs are.

   For comparison, a heroic kernel optimisation might
   buy you 15%.
```

:::goat Where to spend your engineering time
The instinct is to optimise the model — a better kernel, a smarter quantization, a faster attention implementation. Those are worth 10–30% and take weeks of specialist work.

Utilisation is worth 2–4× and the levers are ordinary infrastructure:

- **Batch and interactive lanes.** Run bulk work at large batch in the gaps left by interactive traffic. This alone often takes a fleet from 40% to 70%.
- **Multi-tenancy.** Different customers peak at different times; sharing capacity smooths the aggregate.
- **Cross-region traffic shaping.** Follow the sun — a fleet serving three time zones has a much flatter curve than one serving one.
- **Right-sized replicas.** Twenty small replicas at 40% each is much worse than eight larger ones at 90%.

The uncomfortable conclusion is that **the cost problem is usually a traffic-shaping problem, not a modelling problem.** Check your utilisation before optimising anything else.
:::

## What drives the numerator

| Lever | Effect | Cost |
|---|---|---|
| **Quantization to FP8** | ~2× TPOT and 2× memory | Small quality loss |
| **Prefix caching** | Removes most prefill in chat | Memory, routing complexity |
| **Continuous batching** | 2–4× throughput | Already table stakes |
| **Speculative decoding** | 2–3× latency at low batch | *Costs* throughput at high batch |
| **Larger batch** | More throughput | Worse TTFT |
| **GQA / smaller KV** | More concurrency → bigger batch | Model architecture choice |
| **Smaller model** | Proportionally cheaper | Quality, and it's a real quality drop |
| **Reserved capacity** | 40–70% off hourly | Commitment risk |

Most of these are covered elsewhere. The one worth flagging here: **routing to the smallest model that can do the job** is frequently the largest single cost lever in a product, and it's a product decision rather than an infrastructure one.

```diagram
   MODEL ROUTING

     classify the request (cheaply — a small model or a
     classifier costs ~1% of the frontier model)
       ├── simple → small model    (~20× cheaper)
       ├── medium → mid model      (~5× cheaper)
       └── hard   → frontier model

   If 70% of traffic is simple, a well-tuned router can
   cut total cost by more than half at essentially
   unchanged output quality.

   The risk to manage: misrouting a hard request to a small
   model produces a bad answer. Route conservatively and
   measure the escalation rate.
```

Routing, budgets and attribution usually live together in an [LLM gateway](../07-ai-systems/llm-gateways.html) in front of every model call.

## API versus self-hosting

The decision that gets made on vibes and should be made on arithmetic.

:::derive The crossover
```
   ASSUMPTIONS
     API price:            $3.00 / 1M output tokens
     Self-host cost:       $0.28 / 1M output tokens (from above)
     Node cost:            $22/hour = $16,060/month
     Engineering:          1.5 FTE ≈ $30,000/month fully loaded
     Fixed monthly cost:   ~$46,000

   BREAK-EVEN
     saving per 1M tokens = $3.00 − $0.28 = $2.72
     tokens needed        = $46,000 / $2.72  ≈  16.9 billion
                                                output tokens/month

     ≈ 563M output tokens/day
     ≈ 6,500 output tokens/second sustained

   That is a LOT of traffic — a large product, not a
   feature. And it assumes you reach 45% utilisation,
   which is itself work.
```
:::

The arithmetic says what practitioners find: **most teams should use an API.** Self-hosting becomes correct when at least one of these holds:

- **Volume is genuinely large** — above roughly 500M output tokens/day sustained.
- **Data cannot leave your infrastructure** — regulatory or contractual, not preference.
- **You need a custom or fine-tuned model** that no API serves.
- **Latency requires colocation** with your other services.
- **You already have GPUs** for training, and inference can backfill idle capacity — this changes the marginal cost dramatically and is the most commonly overlooked case.

The costs that get left out of self-hosting estimates: on-call for a GPU fleet, capacity planning with quarter-long lead times, model upgrade work, and the opportunity cost of the engineers doing it. The $30k/month engineering line above is not padding.

## Cost attribution

Once you're spending meaningfully, you need to know on what — and default logging won't tell you.

```
   Per request, record:
     tenant / customer ID
     model and version
     input tokens (cached and uncached, separately)
     output tokens
     feature / endpoint
     derived cost

   Aggregate by all of them. What you're looking for:

     · the top 1% of users by cost — often 40%+ of the bill
     · features whose cost per active user exceeds revenue
     · retry storms and agent loops burning tokens invisibly
     · prompts that grew over time without anyone noticing
```

:::trap Agents make cost unbounded per request
A chat request costs a bounded, predictable amount. An [agent](../07-ai-systems/agent-architectures.html) loop can call the model twenty times, each with a context that grows as the trajectory accumulates.

```
   Turn 1:  2,000 tokens
   Turn 5:  8,000   (history accumulating)
   Turn 10: 20,000
   Turn 20: 50,000

   Total for one "request": 300,000+ tokens.
   A chat message: 2,500.

   → 120× the cost, from the same user action.
```

The consequences: a per-request cost ceiling is mandatory, not optional; token budgets must be enforced in the agent loop itself; and a runaway loop needs a circuit breaker. Several companies have discovered this through a five-figure bill from a single stuck agent.
:::

**Reasoning models move cost to the output side.** A model that thinks before answering can generate 5,000–50,000 hidden reasoning tokens on a hard question, billed as output — the most expensive token type — and served by the bandwidth-bound decode phase. Most such models expose a reasoning-effort or thinking-budget setting: use a low budget for routine traffic and a high one only where accuracy pays for it, and track reasoning tokens as their own line in cost attribution. [Serving reasoning models](serving-reasoning-models.html) covers the infrastructure side.

## Pricing a product on top

If you resell, the unit economics have to be worked out per user, not per token.

```diagram
   $20/month subscription. Cost $0.28/1M output tokens,
   $0.05/1M input.

   A typical user: 60 conversations/month, 8 turns each,
   ~2,500 input and ~400 output tokens per turn.

     input:  60 × 8 × 2,500 = 1.2M   → $0.06
     output: 60 × 8 ×   400 = 192K   → $0.05
     total ≈ $0.11/month → 99% gross margin ✓

   A power user: 50× that volume
     total ≈ $5.50/month → 72% margin ✓ still fine

   An agent user: 20 tool calls per task, 40 tasks/month,
   average 60,000 tokens per task
     2.4M tokens × mixed rate ≈ $8-15/month → thin or negative

   → Flat-rate pricing works for chat and breaks for agents.
     This is why agentic products meter, cap, or price by
     usage while chat products don't have to.
```

:::exercise Build the model for a real product
A support automation product: 500 customers, 2,000 tickets/day each. Each ticket makes 3 model calls (classify, retrieve-and-answer, quality check) at ~4,000 input and ~600 output tokens.

1. Daily and monthly token volume, input and output separately.
2. Cost at API pricing. Cost self-hosted at $0.28/$0.05 per 1M, assuming you reach 50% utilisation.
3. Break-even given $46k/month fixed. Are you over or under it?
4. The classify call could use a model 20× cheaper. What does that save, and what's the risk?
5. The 4,000 input tokens are 3,000 of stable system prompt plus retrieved context. What does prefix caching change?
6. Traffic is 5× higher 09:00–17:00 in each customer's local time, across three continents. What's your utilisation curve, and what would you do about it?
:::

:::paper Sources
There's no canonical paper here — this is operational knowledge. The most useful public sources are provider pricing pages (for the current shape of input/output/cached tiers) and *Efficiently Scaling Transformer Inference* (Pope et al., MLSys 2023) for the throughput model underneath the arithmetic.

For the general discipline, the FinOps Foundation's material on unit economics transfers directly, with tokens in place of requests.
:::

## Check yourself

```recall
Q: What is the cost-per-token formula?
A: Node price per hour ÷ (3,600 × sustained tokens/s × utilisation). A $22/hour node at 48,800 tokens/s is ~$0.13 per million output tokens at full load, ~$0.28 at 45%.

Q: Why does utilisation dominate cost?
A: It swings cost 2–4× (90% → $0.14, 20% → $0.63), far more than a heroic 15% kernel win. Levers: batch lanes, multi-tenancy, follow-the-sun traffic, right-sized replicas.

Q: Why are input and cached tokens cheaper?
A: Prefill is compute-bound and batches at high intensity (~4–8× more tokens/s than decode); cached input skips prefill entirely.

Q: What is model routing, and its risk?
A: A cheap classifier sends simple requests to small models and hard ones to the frontier model — cutting cost by more than half when most traffic is simple. Misrouting gives bad answers, so route conservatively and watch escalations.

Q: Where is the API-versus-self-host break-even?
A: With ~$46K/month fixed (node plus 1.5 engineers) and $2.72 saved per million tokens: ~17 billion output tokens a month, ~500M a day — a large product.

Q: When is self-hosting right despite the arithmetic?
A: Genuinely huge volume, data that can't leave your infrastructure, a custom model no API serves, colocation for latency, or idle training GPUs that inference can backfill.

Q: What should cost attribution record?
A: Per request: tenant, model and version, cached and uncached input, output (and reasoning) tokens, feature and cost — to find the top 1% of users, unprofitable features and runaway loops.

Q: Why do agents and reasoning models break flat pricing?
A: Agents re-send growing context each step (300,000+ tokens per task versus 2,500 per chat message) and reasoning models emit thousands of hidden output tokens. Meter, cap or budget them.
```

## What to carry forward

- **Cost = node price / (throughput × utilisation).** Three terms; utilisation is usually the worst one.
- **Utilisation swings cost 2–4×** — more than any kernel optimisation. Check it first.
- **Model routing** is often the biggest product-level lever: route to the smallest sufficient model.
- **Break-even for self-hosting is roughly 500M output tokens/day** unless you have GPUs already or a data-residency requirement.
- **Attribute cost per tenant, feature, and cached-versus-uncached** — the top 1% of users is usually 40% of the bill.
- **Agents make per-request cost unbounded.** Budgets and circuit breakers are mandatory.
