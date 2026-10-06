---
title: Observability for AI Systems
summary: Token metrics, tracing across model calls, cost attribution, and the hard part — monitoring output quality when there is no ground truth and no exception to catch.
difficulty: Medium
scope: HLD
tags: [ai, observability, monitoring, tracing]
prereqs: [inference-engines, ai-cost-model]
unlocks: Knowing your AI system is degrading before your users tell you.
---

:::predict Guess first
1. Error rate 0.01%, p99 latency fine, every response is "200 OK" — could the AI system still be failing badly?
2. One request generates 2,000 tokens and another 100. If the system performed identically for both, what would p99 total latency mostly measure?
3. Your bill doubles overnight with no deploy and no traffic change. What might have broken?
:::

## The gap ordinary monitoring leaves

Standard observability answers: is it up, is it fast, is it erroring. All three can be perfectly green while an AI system is failing badly.

```diagram
   TRADITIONAL SIGNALS         WHAT THEY MISS

   error rate 0.01%   ✓        the model is confidently wrong
   p99 latency 800ms  ✓        answers got shorter and less useful
   CPU 40%            ✓        GPU KV cache is at 98%
   200 OK             ✓        every response says "I cannot help"

   → An AI system degrades along a dimension that
     conventional monitoring has no view of at all.
```

You need three layers: the serving layer (familiar shapes, unfamiliar units), the request layer (tracing across many model calls), and the quality layer (the genuinely hard one).

## Layer 1 — serving metrics

The unit is tokens, not requests. Everything else follows from that.

| Metric | Definition | Why it's the right one |
|---|---|---|
| **TTFT** | Queue wait + prefill | What users perceive as responsiveness |
| **TPOT** | Time per output token | Streaming smoothness; under ~30 ms feels fluid |
| **End-to-end latency** | TTFT + TPOT × output length | Dominated by output length, so it's mostly not about your system |
| **Throughput** | Tokens/second, in and out separately | Your cost denominator |
| **Goodput** | Tokens/second *meeting SLA* | The honest number |
| **KV cache utilisation** | Fraction of cache allocated | The real capacity signal — watch this, not GPU% |
| **Batch size** | Concurrent sequences per step | Directly proportional to efficiency |
| **Preemption rate** | Evictions per minute | Non-zero means admission control is too loose |
| **Queue wait** | Time from arrival to first forward pass | The controllable part of TTFT |

:::goat Percentiles on end-to-end latency are misleading here
A request generating 2,000 tokens takes 20× as long as one generating 100. So p99 end-to-end latency mostly measures **how long your longest responses were**, not how well your system performed.

Two requests can have identical TTFT and TPOT — meaning identical system performance — and differ 20× in total latency. Alerting on end-to-end p99 will page you for a change in user behaviour.

Alert on **TTFT and TPOT separately**, and treat total latency as a product metric. If you want one number, use **normalised latency**: total time divided by output tokens, which is just TPOT with extra steps and is comparable across request shapes.
:::

**GPU utilisation is nearly useless.** `nvidia-smi` reports ~100% whenever any kernel is resident, including one stalled on memory. Use **KV cache utilisation** for capacity and **MFU** for efficiency instead.

## Layer 2 — tracing

One user action can be twenty model calls, several retrievals, and a handful of tool executions. A **trace** records that whole tree — every step, nested, with its own timing — so you can see where the 40 seconds actually went. Each individual step in it is a **span**. Without one, you have a total and no way to attribute it.

```diagram
   TRACE: "summarise this repo and fix the failing test"   47.2 s

   ├─ classify intent                     0.3 s   (small model)
   ├─ retrieve repo context               1.1 s
   │   ├─ embed query                     0.08 s
   │   └─ vector search (top 40)          0.9 s
   ├─ agent loop                         44.8 s   ← here
   │   ├─ turn 1  model call              2.1 s   4.2K in / 180 out
   │   │   └─ tool: read_file             0.2 s
   │   ├─ turn 2  model call              3.4 s   6.8K in / 310 out
   │   │   └─ tool: run_tests            18.3 s   ← and here
   │   ├─ turn 3  model call              4.9 s   11K in / 520 out
   │   └─ ... 6 more turns
   └─ format response                     1.0 s

   Two findings visible immediately:
     · run_tests dominates — not a model problem at all
     · input tokens grow every turn (4.2K → 11K), so
       later turns cost multiples of earlier ones
```

Every span should carry: model and version, input tokens split into cached and uncached, output tokens, computed cost, temperature and sampling params, the prompt template version, and whether it was a retry.

**Sampling strategy matters.** Full traces are expensive at volume. Sample 1–5% uniformly for baselines, plus 100% of anything anomalous — errors, latency outliers, high cost, low confidence, negative user feedback. The anomalous traces are the ones you'll actually read.

**Prompt versioning is part of tracing.** When quality shifts, "which prompt version was this?" is the first question, and it's unanswerable unless you record it. Prompts should be versioned artifacts, not string literals in the codebase.

## Layer 3 — quality

The hard part. There is no exception when a model gives a bad answer.

**Proxy signals — cheap, fast, high volume:**

| Signal | What it catches |
|---|---|
| Output length distribution | Truncation, runaway generation, format collapse |
| Refusal rate | Alignment drift in either direction |
| Tool-call validity | Structured-output degradation — the most sensitive signal available |
| Retry / regeneration rate | Users silently saying the answer was bad |
| Conversation length | Rising turns-to-resolution means answers aren't landing |
| Fallback / escalation rate | The explicit failure path |
| Empty or near-empty responses | Prompt or template breakage |

**Direct signals — slower, more meaningful:**

- **Explicit feedback** (thumbs). Sparse — typically 1–5% of users respond — and biased toward extremes, but unambiguous when you get it.
- **Implicit feedback.** Did they copy the code? Accept the suggestion? Continue the conversation? Often far more informative than thumbs, and available on every interaction.
- **Task success.** Did the ticket get resolved, the test pass, the purchase complete? This is the real metric and it lags by hours or days.
- **LLM-as-judge on a live sample.** Score a percentage of production traffic with a model. Fast and scalable; needs its own validation against human labels, or you're monitoring a proxy for a proxy. Covered in [evaluation systems](../07-ai-systems/evaluation-systems.html).

:::goat Build the quality dashboard before you need it
The failure pattern is consistent: quality monitoring gets built after the first bad incident, in a hurry, and by then you have no baseline to compare against. "Is 94% tool-call validity bad?" is unanswerable without knowing it was 98% last month.

The minimum worth having from day one — none of it requires ground truth:
1. **Output length distribution**, plotted over time
2. **Tool-call or JSON validity rate**
3. **Refusal rate**
4. **Retry rate**
5. **Cost per request**, by feature

Five metrics, all computable from data you already have, all sensitive to model changes, prompt changes, and traffic-mix shifts. Everything more sophisticated builds on these.
:::

## Cost attribution

Covered in the [cost model](ai-cost-model.html); the observability requirement is that every span carries enough to compute cost, and that you can aggregate by tenant, feature, model, and endpoint.

What you're looking for, specifically:

```
   · top 1% of users by cost      — usually 30-50% of the bill
   · cost per feature vs its value
   · cached vs uncached input ratio, per endpoint
        → a falling ratio means prompt ordering broke
   · agent loops exceeding expected turn counts
   · retry storms — invisible in request counts, obvious in tokens
```

That third one is worth alerting on. Cache hit rate silently collapsing — because someone put a timestamp at the front of a prompt — can double your bill with no other symptom.

## Alerting

Not everything above deserves a page. A workable split:

**Page immediately:** TTFT p99 above SLA for 5 minutes; error rate above baseline; KV cache above 95% with preemptions occurring; cost rate above 2× the 7-day average; tool-call validity dropping more than 5 points.

**Ticket, don't page:** gradual quality drift; cost per request trending up; cache hit rate declining; MFU below target.

**Dashboard only:** length distributions, per-feature breakdowns, model mix.

:::trap Alert on rates and distributions, not absolute counts
"More than 100 refusals per hour" fires on a traffic spike and stays silent during a real regression at low traffic. Use **refusal rate**, and compare against a rolling baseline rather than a fixed threshold.

The same applies to output length: a fixed "average length below 50 tokens" threshold breaks the moment your traffic mix changes. Alert on the *distribution shifting* relative to last week — a KS test or a simple percentile comparison — not on an absolute value.
:::

## Exercise

:::exercise Instrument a system
A customer-support assistant: retrieval, then a model call, then optional escalation to a human. 200,000 conversations/day.

1. Define your trace spans and the attributes on each. What lets you answer "why was this conversation slow and expensive?"
2. Pick five quality proxies for this product specifically. For each, say what regression it would catch and what would make it fire falsely.
3. Escalation rate is your clearest quality signal. What else moves it besides model quality, and how do you separate those?
4. Design the sampling: what fraction of traces do you keep, and what triggers 100% capture?
5. Write three alerts as precise rules — metric, comparison, window, threshold. Which pages and which tickets?
6. Cost per conversation rises 40% over two weeks with no deploy. List five candidate causes and the metric that distinguishes each.
:::

:::paper Sources
No canonical paper. OpenTelemetry's GenAI semantic conventions are becoming the de facto standard for span attributes and are worth adopting rather than inventing your own.

For the quality side, the practical literature is mostly vendor and practitioner writing — Eugene Yan's posts on evaluating LLM products are the most useful single body of it. *Hidden Technical Debt in Machine Learning Systems* (Sculley et al., 2015) is the origin of "you cannot monitor an ML system like a service."
:::

## Check yourself

```recall
Q: Why isn't traditional monitoring enough for AI systems?
A: Error rate, latency and status codes can all be green while the model is confidently wrong, answers got shorter, the KV cache is full, or every reply is a refusal.

Q: Which serving metrics matter?
A: TTFT and TPOT separately, input and output throughput, goodput, KV-cache utilisation (the real capacity signal), batch size, preemption rate and queue wait.

Q: Why is end-to-end p99 latency misleading?
A: It mostly measures how long the longest responses were — a change in user behaviour, not system performance. Alert on TTFT and TPOT; use latency per output token if you want one number.

Q: What should every trace span carry?
A: Model and version, cached and uncached input tokens, output tokens, cost, sampling parameters, prompt template version and retry flag. Keep 1–5% of traces plus 100% of anomalies.

Q: Name five quality proxies that need no ground truth.
A: Output-length distribution, tool-call or JSON validity, refusal rate, retry/regeneration rate and cost per request — build their baselines from day one.

Q: What direct quality signals exist?
A: Explicit thumbs (sparse, biased), implicit feedback (copied, accepted, continued), task success (lags hours or days) and an LLM judge on a live sample, itself validated against humans.

Q: Why alert on the cached-input ratio?
A: A collapsing cache hit rate — say, a timestamp moved to the front of a prompt — can double the bill with no other symptom.

Q: How should AI alerts be written?
A: On rates and distribution shifts against a rolling baseline, never absolute counts. Page on SLA breaches, KV pressure, cost spikes and validity drops; ticket gradual drift.
```

## What to carry forward

- **Traditional monitoring can be entirely green while quality collapses.**
- **Alert on TTFT and TPOT separately.** End-to-end p99 mostly measures output length.
- **KV cache utilisation is the capacity signal**; GPU utilisation is close to meaningless.
- **Trace every model call** with tokens, cost, model version, and prompt version.
- **Five quality proxies cost nothing and need no ground truth**: length, validity, refusal, retry, cost.
- **Build the quality baseline before the incident.** Without history, no number is interpretable.
- **Alert on rates and distribution shifts**, never absolute counts.
