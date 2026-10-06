---
title: LLM Gateways & Semantic Caching
summary: The layer between your applications and the model providers — one API, token budgets, routing and fallback, cost attribution — and the three kinds of caching it can do, including the semantic cache that saves money until it confidently answers the wrong question.
difficulty: Medium
scope: HLD
tags: [ai, gateway, caching, cost, routing]
prereqs: [api-gateway, rate-limiting, caching, ai-cost-model, embeddings]
unlocks: Designing the shared control point every team's model calls pass through, and knowing which caches are safe to put in it.
---

:::predict Guess first
1. Ten teams each call two model providers directly with their own API keys. When the monthly bill doubles, how would you find out which team caused it?
2. A user asks "how do I cancel my order?" and a cached answer exists for "how do I cancel my subscription?". The two sentences are very similar. Should the cache return it?
3. If your primary model provider starts returning errors halfway through streaming an answer, can you switch to a backup provider without the user noticing?
:::

## Why a gateway appears

The first model call in a company is usually a direct one: an application holds an API key and calls a provider. Within a year there are a dozen applications, several providers, keys pasted into config files, no idea which team spent what, and every team writing its own retry logic.

An **LLM gateway** is a proxy that every model call passes through. It's the same idea as an [API gateway](../02-building-blocks/api-gateway.html), specialised for one fact that changes everything: **the unit of cost and capacity is the token, not the request.** One request can be 50 tokens or 50,000, so request counts tell you almost nothing about load or spend.

```diagram
   app ──► GATEWAY ──────────────────────────────────────────► provider A
             │ 1. authenticate the caller (team, app, key)      provider B
             │ 2. check budget and token rate limit             self-hosted
             │ 3. check caches (exact, then semantic)
             │ 4. guardrails: redact PII, block policy breaks
             │ 5. route: pick provider and model
             │ 6. call, with breaker + bounded retry + fallback
             │ 7. reconcile tokens, attribute cost, log the trace
             ▼
           response streamed back to the app
```

Teams build this themselves or adopt one — LiteLLM, Portkey, Kong AI Gateway, Envoy AI Gateway and Cloudflare AI Gateway are common names. The design questions are the same either way.

## What it does

### One API, one set of keys

Applications speak one request format; the gateway translates to each provider's. Provider keys live only in the gateway, and applications get their own internal credentials that can be scoped, rotated and revoked without touching anyone's code. Switching an application from one model to another becomes a configuration change.

### Token budgets and rate limits

Two different limits sit here:

- **Provider limits** — each provider caps your tokens per minute. The gateway is the one place that sees all traffic, so it's the only place that can share that cap fairly between teams.
- **Internal budgets** — spend per team, per day or month, so one runaway job can't consume everyone's allowance.

The difficulty is that you don't know a request's cost until it finishes. The standard approach, from [rate limiting](../02-building-blocks/rate-limiting.html) applied to tokens:

```diagram
   BEFORE the call   reserve  = input tokens (countable now)
                              + max_tokens  (the most it can generate)
                     reject or queue if the reservation doesn't fit

   AFTER the call    actual   = input + tokens really generated
                     refund   = reserve − actual  back to the bucket
```

Reserving `max_tokens` is pessimistic, which is the point: it can't be overspent. A side effect worth knowing is that applications setting `max_tokens` far higher than they need tie up their own budget, which gives teams a reason to set honest limits.

### Cost attribution

Every call is tagged with team, application, feature, model, and token counts split into cached input, uncached input and output. That turns "the bill doubled" into "the summarisation feature in the support app moved to a larger model on Tuesday" — the question in this page's first box. See the [AI cost model](../06-ai-infrastructure/ai-cost-model.html) for what to aggregate.

### Routing

The gateway decides which provider and model actually serve each request:

- **By policy** — this team uses this model; regulated data only goes to approved deployments.
- **By cost** — send simple requests to a small, cheap model and hard ones to a large one. A classifier or a few rules in front can cut cost substantially, if you measure how often a small model's answer is worse.
- **By latency or health** — prefer the endpoint that is currently fastest and healthy.
- **For experiments** — split traffic between two models or prompts for an A/B test, consistently per user.

### Fallback, breakers and retries

When a provider returns errors or rate-limit responses (HTTP 429), the gateway can retry or fall back to another provider. Three things make this harder than it looks:

1. **Per-provider circuit breakers.** If a provider is clearly failing, stop sending it traffic for a while rather than paying a timeout on every request. See [backpressure and circuit breakers](../03-distributed/backpressure.html).
2. **Fallback models are not equivalent.** A prompt tuned for one model can behave differently on another — formatting, tool calls, refusals and length all shift. Fallback is a quality decision: test the backup model on your evaluation set before trusting it in an outage.
3. **Streams can only fail over before the first token.** Once part of an answer has reached the user, switching providers means either restarting the answer visibly or stitching two models' text together. Fail over freely before streaming starts; after that, report the error.

**Retry carefully.** A retried generation costs full price again and may produce a different answer. Retry on errors that clearly happened *before* generation (connection refused, 429 with a retry-after hint), with backoff and jitter, under a retry budget — never blindly on a timeout mid-stream. Unbounded retries through a shared gateway are exactly how a provider slowdown becomes a [retry storm](../03-distributed/metastable-failures.html).

### Guardrails and logging

Because everything passes through it, the gateway is the natural place for **PII redaction**, policy classifiers and blocklists (see [guardrails](guardrails-and-abuse.html)), and for **traces**. Recording each call with the OpenTelemetry GenAI semantic conventions — standard attribute names for model, token counts and so on — means the traces fit the same tooling as the rest of your [observability](../06-ai-infrastructure/ai-observability.html). Prompts and responses in logs are sensitive data: give them a retention and access policy.

## Caching, in three layers

A cache in front of a model can save a lot of money — but the three kinds differ enormously in how safe they are.

```diagram
   LAYER              KEY                         SAFE?
   ───────────────────────────────────────────────────────────────
   exact-match        hash of the whole request   yes — identical
   response cache     (model, prompt, params)     input, same answer

   provider prompt    the provider caches the     yes — the model
   caching            processed PREFIX of a       still generates a
                      prompt; you send it again   fresh answer

   semantic cache     embedding of the prompt;    risky — returns an
                      nearest neighbour above     answer written for
                      a similarity threshold      a DIFFERENT question
```

### Exact-match caching

Hash the full request — model, system prompt, messages, sampling parameters — and store the response. Safe, because only an identical request gets the stored answer. Hit rates are low for chat, where every conversation differs, but can be high for batch jobs, retried requests and deterministic pipelines (temperature 0 classification of repeated inputs, for example).

### Provider prompt caching

This is a different thing entirely: the provider keeps the processed form of a prompt's **prefix** — the [KV cache](../06-ai-infrastructure/kv-cache-management.html) — so a later request starting with the same tokens skips recomputing them. You still get a freshly generated answer; you just pay less for the repeated input and wait less for the first token.

Pricing at the time of writing: Anthropic charges cache reads at 0.1× the base input price, with cache writes at 1.25× (five-minute lifetime) or 2× (one-hour lifetime). OpenAI caches automatically for prompts of at least 1,024 tokens and discounts cached input by 50%.

:::goat The gateway can break prompt caching without anyone noticing
Prompt caching only works on an **identical prefix**. A gateway that adds anything per-request near the top — a timestamp, a request ID, a user name, a "you are talking to team X" line — changes the prefix on every call and silently drops the cache hit rate to zero.

The rule is the one from [context engineering](context-engineering.html): stable content first, variable content last. A gateway should append, never prepend, and its own injected instructions must be byte-for-byte stable. Track the cached-input share per application; a sudden drop usually means someone changed what goes at the top.
:::

### Semantic caching

The tempting one. Embed each incoming prompt as a vector (see [embeddings](../05-ai-foundations/embeddings.html)), search a store of previous prompts for the nearest one, and if the similarity is above a threshold, return the stored answer without calling the model at all. GPTCache was an early open-source project built on this idea.

```diagram
   "How do I reset my password?"   ──embed──►  [0.12, -0.40, ...]
                                                     │
                                           nearest-neighbour search
                                                     │
   stored: "How can I reset my password?"   similarity 0.97 ≥ 0.92
                                                     │
                                           return the stored answer
                                           (no model call)
```

When it works, a hit costs an embedding and a lookup — a tiny fraction of a generation — and returns in milliseconds. The problem is that **"similar" is not "same"**, and the cache cannot tell the difference.

## How semantic caches go wrong

**False hits.** Embeddings place sentences with the same words and structure close together even when one word changes the meaning entirely:

```diagram
   "How do I cancel my order?"          similarity ≈ high
   "How do I cancel my subscription?"   → different answer needed

   "Is it safe to take ibuprofen with alcohol?"
   "Is it safe to take ibuprofen without food?"

   "Refund policy for orders over $100"
   "Refund policy for orders under $100"
```

Embeddings are notoriously weak at negation, numbers and small qualifying words — exactly the words that change answers. A false hit is worse than a miss: the user gets a fluent, confident answer to a question they didn't ask.

**Context-dependent answers.** "What's my order status?" has a different correct answer for every user. "Summarise the attached document" depends on the attachment. Any answer that depends on who is asking, what they attached, or what time it is cannot be shared across requests by prompt text alone.

**Multi-turn conversations.** "What about the second one?" means nothing without the conversation before it. Embedding only the last message matches unrelated conversations; embedding the whole history makes hits vanishingly rare.

**Staleness.** A cached answer about prices, policies or availability goes out of date while still matching new questions perfectly.

**Cross-tenant leakage.** A shared cache can hand one customer's answer — possibly containing their data — to another customer who asked something similar. That's a data breach, not a quality bug.

**Thresholds don't transfer.** A similarity of 0.92 means different things for different embedding models, and moves when you upgrade the model. The threshold must be calibrated on your own data, per model.

**Low hit rates.** Conversational traffic is rarely repetitive enough. Many teams find that after excluding everything unsafe to cache, the remaining hit rate is too small to justify the risk.

:::derive Is a semantic cache worth it?
```
   1,000,000 requests a day. A model call costs $0.01.
   Semantic cache hit rate: 20%. Embedding + lookup: ~$0.0001.

   SAVED
     200,000 hits × $0.01                =  $2,000
     minus 1,000,000 lookups × $0.0001   =  −$100
                                         ≈  $1,900 a day

   THE QUALITY BILL
     Suppose 3% of hits are FALSE hits — wrong answers.
     200,000 × 3%                        =  6,000 wrong answers a day

   If a wrong answer costs a support ticket at $2:
     6,000 × $2                          =  $12,000 a day

   → the cache loses about $10,000 a day.

   Break-even false-hit rate:  $1,900 / (200,000 × $2)  ≈  0.5%

   → unless you can MEASURE hit precision above ~99.5%,
     this cache costs more than it saves.
```
:::

The numbers change per product, but the shape doesn't: the savings scale with the hit rate, and the damage scales with the hit rate times the false-hit rate times what a wrong answer costs. A cheap model call and an expensive mistake make semantic caching a bad trade.

## A safe semantic cache

If the traffic genuinely suits it — a support FAQ, product documentation questions, the same fifty questions asked thousands of times — design it defensively:

- **Scope the key.** Only match within the same tenant, the same model, the same system-prompt version, and the same hash of any context (attachments, retrieved documents, user-specific data). Most of the dangerous hits disappear.
- **Cache only what is safe to share.** Answers that don't depend on the user, the time or private data. Exclude anything with personal data at write time.
- **Short TTLs**, and invalidate when the underlying content (the policy, the price list, the docs) changes.
- **A strict threshold, calibrated per embedding model** on labelled pairs of "same question" and "different question".
- **Measure hit precision.** Sample cached hits, have someone label whether the cached answer was right for the new question, and track the false-hit rate continuously. Without this number you are guessing.
- **Consider a cheaper alternative first:** a curated FAQ with retrieval, where the answers were written to be reused, or simply relying on prompt caching to make repeated prefixes cheap.

:::trap "Our semantic cache has a 40% hit rate"
A hit rate alone says nothing about whether the cache is helping. A cache that returns the nearest stored answer for every question has a 100% hit rate and is useless.

The numbers that matter are **hit precision** — the share of hits whose cached answer was actually right for the new question — and the cost of the wrong ones. Report them together, from a labelled sample, or don't report the hit rate at all.
:::

:::exercise Design the gateway
Your company has 15 applications calling two providers and one self-hosted model. Monthly spend is growing 30% a month and nobody can explain why. Last month a provider outage took down every application for an hour.

1. Draw the gateway's request path. Which checks happen before the model call and which after?
2. Design the token budgets: what is reserved before a call, what is reconciled after, and what happens when a team's daily budget runs out?
3. Write the fallback policy. Which errors trigger it, when may a streaming request fail over, and what must be true of the backup model first?
4. The support app sends a 6,000-token system prompt on every call. What do you check to make sure prompt caching is working, and what gateway behaviour would break it?
5. The support team asks for a semantic cache. Using the derivation's method, what hit precision would they need for it to pay off if a call costs $0.004 and a wrong answer costs $1? How would you measure it?
6. A customer reports seeing another company's order details in an answer. List every place in your design that could have caused it.
:::

:::paper Sources
Provider documentation is the reference for prompt caching: Anthropic's *Prompt caching* guide and OpenAI's *Prompt caching* guide describe the prefix rules, lifetimes and pricing. The OpenTelemetry *Semantic Conventions for Generative AI* define standard trace attributes for model calls.

GPTCache (Zilliz) is an early open-source semantic cache and a useful reference for the design. For the underlying weakness, the [embeddings](../05-ai-foundations/embeddings.html) page covers why vector similarity struggles with negation and small qualifiers.
:::

## Check yourself

```recall
Q: Why does a gateway for model calls differ from an ordinary API gateway?
A: The unit of cost and capacity is the token, not the request — one call can be 50 or 50,000 tokens — so limits, budgets and attribution must all be counted in tokens.

Q: How do you enforce a token budget before you know a request's cost?
A: Reserve input tokens plus max_tokens before the call, reject or queue if it doesn't fit, then refund the difference once the actual output is known.

Q: Why is falling back to another provider not automatic?
A: The backup model isn't prompt-equivalent — formatting, tool calls and refusals change — so test it first; and a streaming answer can only fail over before its first token reaches the user.

Q: How should a gateway retry failed model calls?
A: Only on errors that clearly happened before generation, with backoff and jitter under a retry budget and per-provider circuit breakers — retries cost full price and can cause retry storms.

Q: How does provider prompt caching differ from response caching?
A: The provider reuses the processed prefix of a prompt, so repeated input is cheaper (Anthropic reads at 0.1× base price; OpenAI 50% off for prompts of 1,024+ tokens) but the answer is still freshly generated.

Q: How can a gateway silently break prompt caching?
A: By injecting anything per-request — a timestamp, request ID or user name — near the top of the prompt, changing the prefix every time. Append variable content; never prepend it.

Q: Why are semantic caches dangerous?
A: Similar is not same: "cancel my order" and "cancel my subscription" embed close together, and answers can depend on the user, attachments, conversation history or time — a false hit gives a confident wrong answer.

Q: What makes a semantic cache safe enough to consider?
A: Keys scoped by tenant, model, system-prompt version and context hash; only shareable FAQ-like answers; short TTLs; a per-model calibrated threshold; and continuously measured hit precision on a labelled sample.
```

## What to carry forward

- **A gateway is the one place that sees every model call** — use it for keys, token budgets, routing and cost attribution.
- **Budget in tokens**: reserve input plus `max_tokens`, reconcile after.
- **Fallback is a quality decision** and streams can only fail over before the first token; retry under a budget.
- **Keep prefixes stable** so provider prompt caching keeps working.
- **Semantic caching trades a small saving for confident wrong answers**; only scoped, measured, FAQ-like caches are worth it.
