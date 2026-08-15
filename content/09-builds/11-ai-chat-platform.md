---
title: Build a Claude-style Chat Platform
summary: The product layer over a token server — conversation state, context window management, streaming, safety, and the economics of a per-token cost model.
difficulty: Hard
scope: HLD
level: 5
prereqs: [llm-inference-serving, realtime, sharding, rate-limiting, caching]
tags: [level-5, ai, chat, streaming]
unlocks: Building a complete AI product on top of model inference.
---

## The product

A user types a message. An assistant streams a reply. The conversation continues with memory of what came before. It works across devices, handles files, and can't be trivially abused.

**The model is not the system.** [Inference serving](llm-inference-serving.html) is one component; this build is everything around it — and most of the engineering is in the "around."

## Estimation

```diagram
   10M DAU · 8 conversations/day · 6 turns each
   ~600 input tokens and ~400 output tokens per turn

   Turns:  10M × 8 × 6 / 10⁵ = 4,800 turns/s → 15,000 peak

   OUTPUT TOKENS — the number that sets your cost
     15,000 turns/s × 400 tokens = 6,000,000 tokens/s at peak

   Storage: 480M turns/day × ~2 KB = ~1 TB/day of conversation text
```

**Two conclusions.** Six million output tokens per second is a very large GPU fleet, so anything that reduces tokens generated or recomputed is directly load-bearing on cost. And a terabyte a day of text is cheap and easy — the storage layer here is genuinely simple. **Almost all the difficulty is in the token path.**

## Phase 1 — Conversation state

```diagram
   conversations   id · user_id · title · created_at · updated_at
   messages        conversation_id (PARTITION)
                   message_id (CLUSTER, ordered)
                   role · content · token_count · created_at
                   model · stop_reason · usage
```

Shard on `conversation_id` — the entire history loads from one partition, exactly as in [WhatsApp](whatsapp.html). Same reasoning, same trap avoided (sharding by user would scatter a conversation).

**Store `token_count` per message at write time.** You will need it constantly for context assembly and billing, and recounting tokens across a long history on every turn is pure waste.

**Titles are generated, not typed.** After the first exchange, ask the model for a short title asynchronously. Cheap, invisible, and it's the kind of product detail that shows you've thought past the architecture.

## Phase 2 — Context window management

**The core product problem.** A model can only look at a fixed amount of text at once — its **context window**, measured in tokens. Everything the model knows about your conversation has to be re-sent inside that window on every single turn, because the model itself remembers nothing between calls. Conversations grow without bound; the window doesn't. Something must give.

```diagram
   Budget for one turn:
     [system prompt]  fixed, maybe 1-2K tokens
     [history]        grows every turn ← the problem
     [current input]  variable
     [room to generate] must reserve this!
     ────────────────────────────────────
     must fit inside the context limit
```

Reserving generation headroom is the part people forget: if you fill the window with history, the model has no room to answer.

Strategies, and the choice is a genuine product decision:

**Truncation** — drop the oldest turns. Trivial, and the assistant abruptly forgets things the user still remembers. Users find this jarring precisely because it's silent.

**Summarization** — when history exceeds a threshold, replace old turns with a model-generated summary.

```diagram
   [system][summary of turns 1-20][turns 21-30][current]
```

Preserves the *gist* across long conversations. Costs an extra model call, loses specifics, and errors compound as summaries get re-summarized.

**Retrieval over history** — embed past turns, retrieve the relevant ones for the current question. Best fidelity for long-running conversations, most machinery. This is [RAG](rag-system.html) pointed at the conversation itself.

**Recommend: hybrid.** Keep recent turns verbatim (recency matters most), summarize the middle, and always keep the system prompt and the first user message — the first message usually establishes the task and dropping it makes the assistant lose the plot entirely.

:::goat The cost angle nobody mentions
"Context management isn't only a quality problem, it's the main cost lever. Input tokens are billed and recomputed every turn, so a conversation that carries 50K tokens of history costs roughly fifty times one carrying 1K — for the *same* answer.

That's also why prefix caching in the inference layer matters so much here: conversations are append-only, so the entire history is a cached prefix and only the new turn needs prefilling. Getting that right is worth more than any other optimization in this build."
:::

## Phase 3 — Streaming

Replies appear word by word rather than all at once, which matters because a full answer can take twenty seconds to finish. The usual transport is **server-sent events (SSE)** — one HTTP response that the server holds open and keeps writing to, which is simpler than a WebSocket and enough here because the data only flows one way.

```diagram
   client ──POST /messages──► API
                               │ create message row (status: streaming)
                               │ assemble context
                               ▼
                            inference service
                               │ tokens ──► SSE ──► client
                               ▼
                            on completion:
                               persist full text + usage
                               mark complete
```

**Persist the final message server-side, not from the client.** If the client disconnects mid-stream, the reply must still exist — otherwise the user reopens the conversation and finds their answer gone.

**Make streams resumable.** Assign the message an ID before generating; if the connection drops, the client reconnects with that ID and receives either the remaining tokens or the completed message. On mobile networks this is not an edge case, it's Tuesday.

**Support cancellation properly.** A user who stops generation should actually free the GPU slot — propagate the cancel to the inference layer rather than just closing the socket. Otherwise you keep paying to generate tokens nobody will read. Worth saying explicitly; it's a real cost leak.

## Phase 4 — Attachments

```diagram
   file → presigned upload → object storage
        → async extraction (text from PDF, OCR, transcript)
        → chunk + store extracted text
        → on send: inject relevant chunks into context
```

Same pipeline as the [image host](image-host.html), with extraction instead of resizing. A large document can't go into the context wholesale — it gets chunked and retrieved, which again is [RAG](rag-system.html).

Images to a vision-capable model are different: they consume context proportional to resolution, so downscale to the smallest size that preserves the detail the user cares about. Otherwise one screenshot silently eats a large fraction of the window.

## Phase 5 — Safety and abuse

Non-optional for anything user-facing.

```diagram
   INPUT   ──► classifier ──► block / flag / allow
                              (fast, cheap, runs before the model)
   OUTPUT  ──► streaming classifier
              ← must inspect DURING generation, since you're
                emitting tokens as they're produced
```

**Output moderation while streaming is the hard part.** You've already shown tokens to the user by the time you can judge the whole response. Practical approach: buffer a small window before emitting, classify on the fly, and be able to halt mid-stream — accepting that a modest latency cost buys you the ability to stop.

**Abuse controls** that matter: token-based rate limits (not request-based), per-account spend caps with alerting, and detection of automated patterns. Prompt injection is a genuine unsolved problem — treat model output that will be *acted upon* as untrusted input, and never let it authorize its own privileged actions. That principle becomes central in the [agent platform](ai-agent-platform.html).

## Phase 6 — Reliability and cost

**Degradation ladder** when the fleet is saturated:

```diagram
   1. queue briefly, show a "thinking" state
   2. route to a smaller/faster model variant
   3. reduce max output length
   4. shed low-priority traffic (free tier before paid)
   5. clear, honest error — never an infinite spinner
```

**Retries are dangerous here.** A retried generation costs full price again and may produce different output. Retry only on errors that clearly occurred *before* generation started; never blind-retry a stream that failed midway.

**Cost controls worth naming:** cache identical prompts (rare in chat, common in API use), route simple turns to cheaper models, cap output length by default, and monitor cost-per-conversation as a first-class metric alongside latency. In a per-token economy, cost *is* a reliability concern — an unbounded spend is an outage waiting to happen.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| Shard on `conversation_id` | `user_id` | Whole history from one partition |
| Store `token_count` at write | Recount per turn | Needed constantly for context and billing |
| Hybrid context (recent + summary) | Pure truncation | Silent forgetting is jarring to users |
| Reserve generation headroom | Fill window with history | Otherwise no room left to answer |
| Persist server-side on completion | Client sends final text | Disconnect must not lose the reply |
| Resumable streams | Fail and restart | Mobile disconnects are routine |
| Propagate cancellation to GPU | Just close the socket | Otherwise you pay for unread tokens |
| Token-based limits + spend caps | Request limits | Requests aren't the unit of cost |
| Buffered streaming moderation | Post-hoc only | You can't unshow tokens already streamed |

## What you'd cut for v1

Attachments, summarization, multi-model routing, resumable streams. Ship: conversations, streaming replies, simple truncation, input moderation, token rate limits. That's a complete product; everything else is refinement driven by real usage.

## Explaining the design

> "The model is one component — most of the engineering is around it.
>
> Conversations shard on `conversation_id` so history loads from one partition, and I store token counts at write time since I need them constantly.
>
> The core problem is context management: the window is bounded, conversations aren't. I'd keep recent turns verbatim, summarize the middle, always preserve the system prompt and the first user message, and crucially reserve headroom for the response. This is also the main cost lever, because input tokens are recomputed every turn — which is exactly why prefix caching in the inference layer matters so much here, since conversations are append-only.
>
> Streaming is SSE with the final message persisted server-side, resumable by message ID, and cancellation propagated to the GPU so a stopped generation actually frees the slot rather than burning tokens nobody reads.
>
> Safety needs input classification before the model and buffered output classification during streaming, since you can't unshow tokens.
>
> Under saturation I'd degrade rather than fail: queue briefly, fall back to a smaller model, cap output length, shed free tier first. And I'd treat cost-per-conversation as a first-class metric — in a per-token economy an unbounded spend is a reliability problem."

## Next

[Build a RAG System](rag-system.html) — grounding the model in data it was never trained on.
