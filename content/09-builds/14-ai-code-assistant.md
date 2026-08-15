---
title: Build an AI Code Assistant
summary: Inline completion under a sub-500ms budget — speculative requests, cancellation, context selection from a repository, and measuring acceptance rather than uptime.
difficulty: Hard
scope: HLD
level: 5
prereqs: [llm-inference-serving, rag-system, caching, backpressure, latency-throughput]
tags: [level-5, ai, latency, developer-tools]
unlocks: Serving model output inside a latency budget where slow equals useless.
---

## The product

A developer types. Grey text appears ahead of the cursor suggesting the rest of the line or block. Tab accepts it.

**The constraint that makes this its own build:** if the suggestion arrives after the developer has typed the next character, it's worthless. Not degraded — worthless. Everything below is downstream of a latency budget an order of magnitude tighter than chat.

## Phase 1 — The latency budget

```diagram
   A developer types ~4-6 characters/second while in flow.
   A suggestion is useful only if it lands before they've
   moved past the point it applies to.

   TARGET: p50 under 200ms, p99 under 500ms, END TO END

   Budget:
     network round trip        ~30ms
     context assembly          ~20ms
     queue wait                ~20ms   ← must stay tiny
     prefill                   ~50ms
     decode 30 tokens          ~80ms
     ─────────────────────────────────
                               ~200ms
```

Compare [chat](ai-chat-platform.html), where 2 seconds to first token is perfectly acceptable. That single difference reshapes every decision:

- **Small models.** A large model cannot decode 30 tokens in 80ms. You trade raw capability for speed, and for line-level completion that trade is correct.
- **Short outputs.** Generate a line or a small block, not a function. Every token costs latency the user feels.
- **Queueing is nearly forbidden.** Time spent waiting is time subtracted from an already tight budget — so you shed rather than queue.

## Phase 2 — Fire, cancel, repeat

The request pattern is unlike anything earlier in this ladder.

```diagram
   Every keystroke potentially invalidates the in-flight request.

   t=0ms    user types "f"     → request A fires
   t=120ms  user types "o"     → request A is now STALE
                                 → CANCEL A, fire request B
   t=240ms  user types "r"     → cancel B, fire C
   t=800ms  user pauses        → C completes, suggestion shown
```

**Debounce, but only slightly.** Waiting 300ms to see if typing stopped spends more than half the budget. Typical approach: fire optimistically after a very short pause (~30–50ms) and rely on cancellation for the rest.

**Cancellation must reach the GPU.** This matters more here than anywhere else in the atlas: a large fraction of requests are abandoned before completion. If cancelled requests keep generating, you're paying for tokens nobody will ever see — and worse, they occupy KV cache slots that live requests need. Propagate the cancel through the queue and into the inference layer so the slot is freed immediately. See [LLM Inference Serving](llm-inference-serving.html).

**Client-side caching helps more than expected.** If the user types exactly what was suggested and then backspaces, you already have the answer. Cache by `(file, cursor position, prefix hash)` and serve locally with zero latency.

## Phase 3 — Context selection

The model needs relevant code, and the repository is far too large to send.

```diagram
   Available context budget: maybe 4-8K tokens
   Repository: potentially millions of lines

   PRIORITY ORDER (highest value per token):
     1. text immediately before the cursor  ← by far the most
     2. text immediately after the cursor      important signal
     3. the file's imports and type definitions
     4. recently edited / open files (strong recency signal)
     5. definitions of symbols visible at the cursor
     6. semantically similar code elsewhere in the repo
```

**Fill-in-the-middle matters.** Naive completion only sees text *before* the cursor. But code has structure after the cursor too — a closing brace, the next function, the expected return type. Models trained with fill-in-the-middle accept a prefix and a suffix and generate the span between. Using it meaningfully improves suggestion quality, and it's a nice specific to name.

**Recency beats similarity.** Files the developer touched in the last few minutes are far more predictive than semantically similar files elsewhere. A simple recency-ordered list of open and recently-edited buffers outperforms elaborate retrieval in most cases — and costs almost nothing to compute.

For cross-file understanding, a [retrieval](rag-system.html) index over the repository helps, but it must be **fast**. A 100ms retrieval step consumes half the budget. Keep the index local to the editor or extremely close, and prefer cheap lexical matching over an embedding round trip when the budget is this tight.

## Phase 4 — Serving under a tight budget

```diagram
   ┌────────────────────────────────────────────┐
   │  Editor extension                          │
   │  · debounce ~40ms · local cache            │
   │  · cancel in-flight on keystroke           │
   └────────────────────┬───────────────────────┘
                        ▼
   ┌────────────────────────────────────────────┐
   │  Edge PoP — terminate TLS close to the user│
   │  30ms of RTT is 15% of the budget          │
   └────────────────────┬───────────────────────┘
                        ▼
   ┌────────────────────────────────────────────┐
   │  Inference: small model, continuous batching│
   │  SHED on saturation — never queue deeply   │
   └────────────────────────────────────────────┘
```

**Terminate close to the user.** Cross-continent round trips alone would blow the budget. This is one of the few AI workloads where edge presence is a hard requirement rather than an optimization.

**Shed, don't queue.** When saturated, return "no suggestion" immediately. A missing suggestion is invisible — the developer keeps typing and never knows. A suggestion arriving 900ms late is actively disruptive, because it appears after they've moved on. This inverts the usual [backpressure](../distributed/backpressure.html) instinct: here, failing fast is genuinely better than serving late.

**Batch aggressively despite the latency target.** Counterintuitive, but continuous batching adds only a few milliseconds while multiplying throughput. The cost per suggestion matters enormously at this volume — a developer generates thousands of requests per day, most of which are cancelled.

## Phase 5 — Measure acceptance, not availability

```diagram
   ACCEPTANCE RATE   suggestions accepted / suggestions shown
                     → the single most important metric

   RETENTION         accepted code still present 5 minutes later
                     → catches suggestions accepted then deleted,
                       which acceptance rate alone flatters

   LATENCY           p50/p99 to displayed suggestion
   SHOW RATE         how often you had something in time
   COST              per accepted suggestion, not per request
```

**Cost per *accepted* suggestion is the honest number.** If most requests are cancelled and a minority of shown suggestions are accepted, then your cost per useful outcome is many multiples of your cost per request. Optimizing raw request cost while acceptance drops is a net loss — and tracking the composite metric is what prevents that.

**Acceptance rate is also a quality regression detector.** A model or prompt change that hurts quality shows up here within hours, long before anyone files a complaint.

## Phase 6 — Privacy, which is a hard requirement

Source code is among the most sensitive data a company has.

- **Be explicit about what leaves the machine**, and make it configurable. Some organizations cannot send code off-premises at all.
- **Never train on user code without unambiguous, opt-in consent.** This is a trust and legal boundary, not a product tuning knob.
- **Support self-hosted deployment** for customers who require it — which is a real argument for the small-model architecture, since it can actually run on a customer's own hardware.
- **Scan for and filter secrets** in both directions: don't send an API key sitting in the context, and don't suggest one memorized from training data.
- **Retention limits.** Prompt logs containing proprietary code are a liability; keep them briefly and encrypted, or not at all.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| Small fast model | Largest available | Large models cannot decode inside the budget |
| Short completions (line/block) | Whole functions | Every token is latency the user feels |
| ~40ms debounce | 300ms debounce | Waiting spends over half the budget |
| Cancel through to the GPU | Close the connection | Abandoned requests hold KV slots and burn cost |
| Fill-in-the-middle | Prefix-only completion | Code after the cursor is real signal |
| Recency-ordered context | Embedding retrieval first | Recency predicts better and costs nothing |
| Shed on saturation | Queue | A late suggestion is worse than none |
| Edge termination | Single region | 30ms RTT is 15% of the budget |
| Continuous batching | One request at a time | Few ms of latency for a large throughput gain |
| Cost per accepted suggestion | Cost per request | Most requests are cancelled or rejected |

## What you'd cut for v1

Cross-file retrieval, fill-in-the-middle, edge deployment, self-hosting. Ship: current-file context around the cursor, a small model, single-line completions, debounce plus cancel, acceptance-rate tracking. **Instrument acceptance from day one** — without it you cannot tell whether anything you do afterwards helps.

## Explaining the design

> "The defining constraint is latency: p99 under about 500ms end to end, because a suggestion that lands after the developer has typed past it isn't degraded, it's worthless. That budget drives everything — a small fast model rather than the most capable one, short completions, and terminating at the edge because a cross-region round trip alone is a significant fraction of the budget.
>
> The request pattern is unusual: every keystroke invalidates the in-flight request, so most requests are cancelled. Cancellation has to propagate all the way to the GPU — otherwise abandoned generations keep burning tokens and holding KV cache slots that live requests need.
>
> Context selection is priority-ordered: text around the cursor first, then imports and types, then recently edited files. Recency beats semantic similarity here and costs nothing to compute. I'd use fill-in-the-middle so the model sees code after the cursor too.
>
> Under saturation I'd shed rather than queue — a missing suggestion is invisible, a late one is disruptive. That inverts the usual instinct.
>
> And I'd measure acceptance rate and cost per *accepted* suggestion rather than availability and cost per request, because most requests never produce a useful outcome."

## You've finished the ladder

That's Level 1 to Level 5 — from a single Postgres table to GPU scheduling.

Notice what carried through: **batching** to amortize a fixed cost appeared in the image pipeline and again in continuous batching. **Caching** went from Redis rows to KV blocks. **Queueing and shedding** protected a database in Level 1 and a GPU fleet in Level 5. **Retrieve-then-rerank** showed up in search, feeds, driver matching, and RAG.

The systems changed. The engineering didn't. That's the actual takeaway — and it's why the [fundamentals](../fundamentals/scalability-basics.html) are worth more than any individual architecture.
