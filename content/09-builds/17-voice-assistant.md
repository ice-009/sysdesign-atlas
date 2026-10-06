---
title: Build a Voice Assistant
summary: A phone-quality conversational agent — the 500 ms budget, streaming every stage, barge-in handling, and what happens when a tool call is slower than a human will wait.
difficulty: Hard
scope: HLD
level: 5
prereqs: [realtime-ai, agent-architectures, realtime, inference-engines]
tags: [level-5, ai, voice, realtime, latency]
unlocks: Building for a latency budget set by human physiology rather than by an SLA document.
---

:::predict Guess first
1. A voice assistant waits for silence, transcribes, generates the full reply, then speaks it. Roughly how long might the caller wait — and how long will they tolerate?
2. Could you make the assistant feel much faster without making speech recognition, the model or speech synthesis any faster?
3. The caller interrupts halfway through the assistant's second sentence. What should the conversation history say the assistant said?
:::

## The product

A voice agent that answers phone calls, holds a conversation, looks things up, and takes actions. Thousands of concurrent calls.

**The constraint is unlike anything else in this atlas.** Elsewhere latency is a quality attribute you trade against cost. Here, exceeding 800 ms doesn't make the product worse — it makes it *not a conversation*. Users start talking over it, repeating themselves, and hanging up.

Everything below is subordinate to a budget of roughly 500 milliseconds.

## Phase 1 — The naive pipeline

Three stages run in sequence, and the abbreviations recur throughout: **STT** (speech to text, also called ASR) turns the caller's audio into words; the model decides what to say; **TTS** (text to speech) turns that reply back into audio.

```diagram
   caller speaks
     → wait for 700 ms of silence
     → upload the whole audio file
     → transcribe it fully
     → send the transcript to the LLM
     → wait for the complete response
     → synthesise the whole response to audio
     → play it

   Measured end to end:  ~3.5 seconds

   Callers interrupt at ~1.2 s, assume the line is dead
   at ~2 s, and hang up.
```

Every stage waits for the previous one to finish completely. **This works and is unusable**, which is the most instructive kind of Phase 1.

**Survives to:** a demo, and voicemail-style interactions where nobody expects a conversation.

**What breaks first:** everything, simultaneously, the moment a real person uses it.

## Phase 2 — Stream and overlap everything

The fix is not to make any stage faster. It's to stop waiting for stages to complete.

```diagram
   SEQUENTIAL                    STREAMED + OVERLAPPED

   ├─ STT ──┤                    ├─ STT (partials) ─┤
            ├─ LLM ────┤              ├─ LLM from first
                       ├─ TTS ─┤        stable transcript ─┤
                                          ├─ TTS on the first
                                            SENTENCE ─┤
                                               ├─ playback

   3,500 ms                      ~630 ms to first audio
```

The specific changes:

**Streaming STT.** Partial transcripts arrive during speech, so the transcript is essentially ready the moment the caller stops. Removes ~300 ms.

**Sentence-level TTS.** Don't wait for the full response. As soon as the model emits a sentence boundary, synthesise and start playing it. The rest streams in behind playback. Removes ~700 ms and is the single biggest win.

**Only TTFT matters.** Total generation time becomes irrelevant once playback has started and never starves. This makes the LLM optimisation target [time to first token](../05-ai-foundations/inference-arithmetic.html), which has different implications from optimising throughput — small batches, a latency lane, and short prompts.

:::goat The reframe: you are not reducing latency, you are hiding it
Nothing in Phase 2 made any component faster. STT, the model, and TTS all take exactly as long as before.

What changed is that the caller stops waiting for the *whole* answer and starts waiting only for the *first fragment* of it. The remaining work happens behind audio that is already playing.

This is the same principle as progressive rendering on the web, and it applies wherever output is consumed serially over time. The design question stops being "how fast is the pipeline" and becomes "what is the smallest thing I can start delivering, and how quickly."
:::

**Survives to:** real conversations, with a noticeable pause before each response.

**What breaks first:** the pause. It's the endpointing timer, and it's now the largest remaining term.

## Phase 3 — Endpointing

**Endpointing** is deciding that the caller has finished speaking and it's your turn. It sounds trivial and is the largest remaining delay in the whole system, because the obvious approach — wait for silence — costs you that full wait on every single turn.

```diagram
   SILENCE TIMER (700 ms)
     ✗ 700 ms added to every turn
     ✗ cuts people off when they pause mid-sentence
     ✗ triggers on background noise

   SEMANTIC ENDPOINTING (~250 ms)
     feed the partial transcript to a small fast model:
       "What's the weather in—"      → incomplete, wait
       "What's the weather in Delhi" → complete, go
     ✓ faster AND more accurate — it distinguishes a
       thinking pause from a finished thought

   SPECULATIVE START (~0 ms perceived)
     begin the LLM call on the partial transcript.
     If the caller continues, cancel and restart.
     ✓ near-zero perceived endpointing cost
     ✗ wasted model calls on cancellations
```

Speculative start is worth the waste. A cancelled prefill costs a few cents of GPU time; 400 ms on every turn costs the product. It's [speculative decoding](../05-ai-foundations/decoding-strategies.html)'s logic one level up: spend cheap compute on a guess to avoid an expensive wait.

**Survives to:** conversations that feel close to natural.

**What breaks first:** the caller interrupts, and the assistant keeps talking over them.

## Phase 4 — Barge-in

**Barge-in** is the caller interrupting while the assistant is still talking — the thing every human does instinctively, and the hardest correctness problem in the build.

```diagram
   CALLER STARTS SPEAKING MID-RESPONSE

   1. DETECT      is this speech, or our own audio
                  echoing back? → needs acoustic echo
                  cancellation, which is why WebRTC
   2. STOP        halt TTS playback within ~100 ms
   3. CANCEL      abort in-flight LLM generation
   4. DRAIN       discard queued TTS chunks
   5. TRUNCATE    cut the assistant's turn in the
                  conversation history to the audio that
                  ACTUALLY PLAYED
   6. LISTEN      resume capture
```

:::goat Step 5 is where voice products go subtly wrong
The model generated four sentences. Playback reached the middle of sentence two. **The caller heard two sentences.**

Record all four in the history and the model believes it said things the caller never heard. It then references information the caller doesn't have, and the caller's next utterance appears to ignore something the assistant "said". The conversation desynchronises, and neither party can tell why.

The fix requires tracking playback position — bytes actually sent to the speaker, not bytes generated — and truncating the history to match, usually with a marker so the model knows it was cut off.

Nobody notices this in a demo, because demos don't get interrupted. Every real deployment hits it in the first hour.
:::

**Survives to:** a genuinely usable product.

**What breaks first:** a tool call takes 800 ms, and the caller hears silence.

## Phase 5 — Tool calls inside the budget

An account lookup, a refund, a database query — all far slower than the conversational budget allows.

```diagram
   ✗ SILENT WAIT
     caller: "what's my balance?"
     [1.4 s of nothing]
     assistant: "Your balance is..."
     → the caller repeats the question at ~900 ms

   ✓ FILLER + PARALLEL EXECUTION
     caller: "what's my balance?"
     assistant: "Let me pull that up..."   ← starts at 400 ms
                                              synthesised while
                                              the tool runs
     [tool completes at 1.4 s, behind the filler audio]
     assistant: "...your balance is $2,340."

   The filler is not a trick. It is what a human does,
   and it converts dead air into a turn.
```

Design points:

- **Predict the tool call early.** If the model's first tokens indicate a lookup, start it before generation finishes.
- **Vary the fillers**, and match them to the tool. "Let me check that" for a lookup, "one moment while I process that" for a write.
- **Set a hard tool timeout well inside the conversational envelope** — 2 seconds, then apologise and offer an alternative. A caller will not wait 8 seconds regardless of what you say.
- **Speak before slow, irreversible actions.** "I'm going to process a refund of $40 — is that right?" is both a confirmation gate and a filler.

## Phase 6 — Serving at scale

Voice load has a shape unlike text serving.

```diagram
   CAPACITY UNIT: concurrent sessions, not requests/second

     1,000 concurrent calls, 6-minute average

     STT      1,000 continuous audio streams
              → scales with AUDIO MINUTES
     LLM      ~1 request per caller per 15 s of call
              → ~65 req/s, but each needs LOW TTFT
              → small batches, latency lane, NOT the
                bulk throughput pool
     TTS      ~1 synthesis per turn
              → scales with OUTPUT CHARACTERS
     Media    1,000 WebRTC sessions, echo cancellation
              → CPU-bound, scales with sessions

   Four different services, four different scaling
   signals, one shared latency budget.
```

**Latency variance matters more than the mean.** A p50 of 300 ms with a p99 of 1,100 ms produces a conversation that intermittently feels broken — worse than a consistent 500 ms. So: over-provision rather than queue, keep batches small, and never put voice traffic in the same pool as bulk text work.

**Prefix caching is worth a lot here.** The system prompt plus retrieved account context can be several thousand tokens, and TTFT scales with prompt length. Cache-affinity routing on the call ID turns most turns into a cache hit and takes a large chunk out of the budget.

**Cascaded or speech-to-speech?** Since late 2024, speech-to-speech models — one model that hears audio and speaks audio, such as those behind OpenAI's Realtime API — skip the STT and TTS hops and pick up tone of voice that a transcript loses. The trade-offs are less control: tool calls and moderation are harder to inspect, and there's no natural transcript to audit. Many production agents stay cascaded, or use a hybrid — a speech model for the conversation with a text transcript running beside it for tools and records. Whichever you pick, the rest of this page still applies: streaming, endpointing, barge-in truncation and fillers.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| Stream and overlap every stage | Sequential pipeline | 3.5 s → 630 ms with no component made faster |
| Sentence-level TTS | Synthesise the full response | The single largest saving; the rest streams behind playback |
| Semantic endpointing | Fixed silence timer | Faster *and* more accurate; the timer is pure added latency |
| Speculative LLM start | Wait for a confirmed endpoint | Wasted prefills are cheaper than 400 ms per turn |
| WebRTC | WebSocket | Echo cancellation, jitter buffer, loss concealment — all required, none trivial |
| Truncate history to played audio | Record the full generation | Otherwise the conversation desynchronises invisibly |
| Filler speech during tool calls | Silent wait | Dead air past ~700 ms causes the caller to repeat themselves |
| Voice in a dedicated small-batch lane | Shared throughput pool | Big batches raise TTFT, and TTFT is the entire product |
| Provision for concurrent sessions | Provision for RPS | Sessions are long-lived and hold resources throughout |
| Cascaded STT→LLM→TTS | End-to-end speech model | Needs tool calls, moderation, and auditable transcripts |

## What you'd cut for v1

Phases 5 and 6. Ship Phases 1–4: a streamed, overlapped pipeline with semantic endpointing and correct barge-in, on WebRTC, for a few dozen concurrent calls. That is a working voice assistant.

**Do not cut:** streaming, or history truncation on interruption. Without streaming it isn't a conversation; without correct truncation it desynchronises and you will spend weeks not understanding why the model says strange things.

## Explaining the design

> "The defining constraint is that human turn-taking gaps are around 200 ms, and past 800 ms people stop treating it as conversation — they interrupt and repeat themselves. So the entire pipeline has about 500 ms.
>
> The naive sequential version is 3.5 seconds. Getting to 630 ms doesn't require making any component faster; it requires streaming every stage and overlapping them, so the caller waits for the *first fragment* rather than the whole answer. Sentence-level TTS is the biggest single win — start playing the first sentence while the model is still generating the third.
>
> That makes time-to-first-token the only model metric that matters, which pushes voice into a small-batch latency lane rather than the bulk throughput pool, and makes prefix caching valuable since TTFT scales with prompt length.
>
> Endpointing is the next largest term. A silence timer costs its full duration on every turn, so I'd use semantic endpointing — a small model deciding whether the utterance is complete — and speculatively start generation on partial transcripts, cancelling if the caller continues. Wasted prefills are much cheaper than 400 ms per turn.
>
> The correctness detail I'd flag is barge-in. When a caller interrupts, you have to truncate the conversation history to the audio that *actually played*, not what was generated. Otherwise the model believes it said things the caller never heard and the conversation quietly desynchronises. That one is invisible in a demo and appears within an hour of real use."

## Next

[Build a Pretraining Cluster](pretraining-run.html) — the opposite extreme, where a job runs for weeks and nobody is waiting on a 500 ms budget.

## Check yourself

```recall
Q: What latency budget does a voice assistant have, and why?
A: About 500 ms. Human turn gaps are ~200 ms, and past ~800 ms callers interrupt, repeat themselves and hang up — it stops being a conversation.

Q: How does streaming cut 3.5 s to ~630 ms with no faster component?
A: Streaming STT partials, starting the LLM on a stable transcript, and synthesising and playing the first sentence while the rest generates. The caller waits for the first fragment, not the whole answer.

Q: Which model metric matters for voice, and what follows?
A: Time to first token only — so a small-batch latency lane separate from bulk traffic, short prompts, and prefix caching via call-ID affinity.

Q: Silence timer versus semantic endpointing versus speculative start?
A: A timer adds its full wait every turn and cuts off pauses. A small model judging whether the utterance is complete is faster and more accurate. Starting the LLM on partials and cancelling if speech continues hides endpointing almost entirely.

Q: What are the barge-in steps?
A: Detect real speech (with echo cancellation), stop playback within ~100 ms, cancel generation, drain queued audio, truncate history to what actually played, and resume listening.

Q: Why truncate history to the audio that played?
A: Otherwise the model believes it said sentences the caller never heard, references them, and the conversation silently desynchronises.

Q: How do you handle a slow tool call?
A: Start it early from the model's first tokens, speak a matching filler ("let me pull that up") while it runs, cap it at ~2 s, and confirm slow irreversible actions out loud.

Q: How is voice capacity planned?
A: By concurrent sessions, not requests a second: STT scales with audio minutes, the LLM needs low TTFT, TTS with output characters, media with sessions. Variance matters more than the mean, so over-provision rather than queue.
```

## What to carry forward

- Human physiology sets the budget: about 500 ms end to end.
- Hide latency by streaming and overlapping stages; play the first sentence early.
- Semantic endpointing and speculative starts remove the silence wait.
- Barge-in must truncate history to the audio that actually played.
- Fill tool waits with speech; provision for sessions and low TTFT variance.
