---
title: Real-Time & Voice AI
summary: Speech pipelines, latency budgets measured against human conversational expectations, and interruption handling — where a 300 ms delay is the difference between natural and broken.
difficulty: Hard
scope: HLD
tags: [ai, voice, realtime, streaming, webrtc]
prereqs: [realtime, inference-engines, queueing-theory]
unlocks: Building conversational systems that feel like conversation.
---

## The budget humans enforce

Text chat tolerates a two-second wait. Speech does not. Human turn-taking has a gap distribution centred around 200 ms, and listeners register anything past roughly 500 ms as a hesitation — meaning something.

```diagram
   PERCEIVED QUALITY OF RESPONSE DELAY

     < 300 ms     natural
     300-500 ms   slightly slow, acceptable
     500-800 ms   noticeably laggy; users start to interject
     800-1500 ms  broken; users repeat themselves
     > 1500 ms    unusable as conversation

   → The entire pipeline — endpointing, transcription,
     model, speech synthesis, network — must fit in
     roughly 500 ms.
```

That budget is the constraint that determines every architectural decision below.

## The pipeline

Six stages, and the abbreviations recur below. **VAD** (voice activity detection) decides whether the microphone is picking up speech or just room noise. **WebRTC** is the browser standard for carrying live audio. **STT** turns speech into text, **TTS** turns text back into speech, and a **jitter buffer** holds a fraction of a second of audio so that packets arriving unevenly still play smoothly.

```viz
{
  "type": "flow",
  "caption": "Six stages, ~500 ms total. Every one must stream.",
  "nodes": [
    { "id": "c", "label": "Capture", "sub": "mic · VAD", "col": 0, "accent": "#38bdf8" },
    { "id": "n", "label": "Transport", "sub": "WebRTC", "col": 1, "accent": "#22d3ee" },
    { "id": "s", "label": "STT", "sub": "streaming ASR", "col": 2, "accent": "#4ade80" },
    { "id": "l", "label": "LLM", "sub": "TTFT is what matters", "col": 3, "accent": "#a78bfa" },
    { "id": "t", "label": "TTS", "sub": "streaming synthesis", "col": 4, "accent": "#fbbf24" },
    { "id": "p", "label": "Playback", "sub": "jitter buffer", "col": 5, "accent": "#fb7185" }
  ],
  "edges": [
    { "from": "c", "to": "n" }, { "from": "n", "to": "s" },
    { "from": "s", "to": "l" }, { "from": "l", "to": "t" },
    { "from": "t", "to": "p" }
  ]
}
```

:::derive Where the 500 ms goes
```
   NAIVE, sequential and non-streaming:

     endpointing (silence detection)        700 ms
     audio upload                            50 ms
     full transcription                     300 ms
     LLM full response                    1,500 ms
     full TTS synthesis                     800 ms
     audio download + jitter buffer         150 ms
                                          ────────
     total                                3,500 ms   ✗ unusable

   STREAMED AND OVERLAPPED:

     endpointing, aggressive + predictive   250 ms
     streaming STT (transcript is ready
       almost as speech ends)                50 ms
     LLM time to FIRST TOKEN                150 ms
     TTS first audio chunk from the
       first sentence                       120 ms
     jitter buffer                           60 ms
                                          ────────
     total to first audio                   630 ms

   Everything after the first chunk streams in behind
   playback and is free.

   → The wins come from streaming every stage and
     overlapping them. Nothing waits for a complete
     intermediate result.
```
:::

**The key insight: only time-to-first-audio matters.** Total generation time is irrelevant if playback starts quickly and never starves. This makes [TTFT](../05-ai-foundations/inference-arithmetic.html) the single metric to optimise on the model side — and it means a long prompt is far more costly here than in a text product, because TTFT scales with prompt length.

## Endpointing

Deciding when the user has finished speaking, and the largest single controllable term in the budget.

```diagram
   SIMPLE VAD (energy threshold + silence timer)
     wait 700 ms of silence → assume they're done
     ✗ 700 ms of pure latency added to every turn
     ✗ cuts off mid-sentence pauses
     ✗ triggers on background noise

   SEMANTIC ENDPOINTING
     stream the partial transcript to a small model:
     "is this a complete utterance?"
     "What's the weather in—"     → incomplete, keep waiting
     "What's the weather in Delhi" → complete, go now
     ✓ 200-300 ms, and more accurate

   SPECULATIVE EXECUTION
     start the LLM on the partial transcript BEFORE the
     user finishes. If they continue, cancel and restart.
     ✓ can reach near-zero perceived latency
     ✗ wasted compute on cancellations — but compute is
       cheaper than the latency it buys
```

Speculative execution is the same idea as [speculative decoding](../05-ai-foundations/decoding-strategies.html) one level up: spend cheap resources on a guess to avoid paying an expensive wait.

## Transport

| Option | Latency | Fits |
|---|---|---|
| **WebRTC** | 50–150 ms | Real-time audio. Purpose-built: UDP, adaptive jitter buffer, packet loss concealment, echo cancellation |
| **WebSocket** | 100–300 ms | Simpler; TCP head-of-line blocking hurts under loss |
| **HTTP streaming** | 200 ms+ | Output only; no good for capture |

**WebRTC is the right answer for voice**, and it's a real infrastructure commitment: STUN/TURN servers for NAT traversal, an SFU if you have multiple participants, and codec negotiation. Teams routinely start with WebSockets because it's easier and hit a quality ceiling on mobile networks that they cannot fix — TCP retransmission on a lossy link produces exactly the wrong behaviour for audio, where a late packet is worthless.

The pieces WebRTC gives you that are easy to underestimate: **acoustic echo cancellation** (without it the assistant hears itself and interrupts itself), **jitter buffering**, and **packet loss concealment**. Reimplementing these is not a weekend project.

## Interruption

Barge-in — the user speaking while the assistant is talking — is what separates a demo from a product, and it is genuinely hard.

```diagram
   WHEN THE USER STARTS SPEAKING MID-RESPONSE:

     1. detect it, distinguishing speech from
        echo of your own audio  (needs AEC)
     2. stop TTS playback immediately
     3. cancel in-flight LLM generation
     4. cancel queued TTS synthesis
     5. TRUNCATE THE CONVERSATION HISTORY to what was
        actually PLAYED, not what was generated
     6. start listening

   Step 5 is the one everyone gets wrong.
```

:::goat Truncating history to what was heard
The model generated four sentences. Playback reached the middle of sentence two when the user interrupted. **The user heard two sentences.**

If you record all four in the conversation history, the model believes it said things the user never heard, and the conversation desynchronises — it references information the user doesn't have, and the user's follow-up appears to ignore something the model "said".

The fix requires tracking playback position and truncating the assistant turn to the audio that actually reached the speaker, usually with a marker: `"...as I was saying— [interrupted]"`.

This is a state-synchronisation problem between two systems with different clocks, and it's the kind of detail that separates voice products that feel natural from ones that feel subtly wrong in a way users can't articulate.
:::

## Cascaded versus end-to-end

```viz
{
  "type": "compare",
  "caption": "Speech-to-speech models remove pipeline latency and give up controllability.",
  "left": {
    "title": "Cascaded — STT → LLM → TTS",
    "items": [
      "Each stage swappable and debuggable",
      "Text transcript for logging, moderation, tools",
      "Mature tooling; any LLM works",
      "Loses tone, emotion, and emphasis at the text boundary",
      "Latency accumulates across three models"
    ]
  },
  "right": {
    "title": "End-to-end speech-to-speech",
    "items": [
      "Audio in, audio out — one model",
      "Preserves prosody, emotion, timing",
      "Lower latency; no intermediate boundaries",
      "Harder to moderate, log, and integrate with tools",
      "Less control over exactly what is said"
    ]
  }
}
```

Cascaded remains the practical default for anything needing tool use, moderation, or auditable transcripts — which is most business applications. End-to-end wins on naturalness and latency, and is advancing quickly. A common hybrid: end-to-end for the conversational path, with a parallel STT stream feeding logging and moderation.

## Serving characteristics

Voice load differs from text load in ways that matter for capacity planning:

- **Sessions are long-lived and stateful.** A ten-minute call holds resources throughout, so you provision for *concurrent sessions*, not requests per second.
- **Latency variance is the enemy**, not average latency. A p99 of 900 ms with a p50 of 300 ms produces a conversation that intermittently feels broken — which is worse than one that's consistently slightly slow. Sacrifice mean latency for a tighter distribution.
- **Batching is constrained.** Large batches raise TTFT, and TTFT is the whole product here. Voice traffic should run in a small-batch, latency-optimised lane, separate from bulk text work.
- **Multiple models per session.** STT, LLM, and TTS each need capacity, and they scale on different signals — STT on audio minutes, LLM on tokens, TTS on output characters.

## Monitoring

| Metric | Target |
|---|---|
| **Time to first audio** | < 500 ms p95 — the headline number |
| **Endpointing delay** | < 300 ms |
| **Audio underruns** | ≈ 0; playback starving is very audible |
| **Interruption handling latency** | < 100 ms from detection to silence |
| **Word error rate** | Tracked by accent, language, and noise condition |
| **Turn-taking anomalies** | Both talking, or long awkward gaps |
| **Session drop rate** | Network and infrastructure health |

**Audio underruns deserve special attention.** If TTS can't keep ahead of playback, the audio gaps — and a gap mid-word is far more jarring than a slightly later start. The mitigation is a small output buffer: hold 200 ms of synthesised audio before starting playback, trading a little initial latency for robustness against synthesis jitter. It's the same [jitter buffer](../02-building-blocks/realtime.html) reasoning as any streaming media system.

:::exercise Budget a voice agent
A phone support agent: answers calls, looks up account details, and can process refunds.

1. Allocate the 500 ms budget across all six pipeline stages. Which are you most likely to exceed?
2. The system prompt plus retrieved account context is 8,000 tokens. What does that do to TTFT, and what would you do about it? (Consider prefix caching.)
3. Design the endpointing. Simple VAD, semantic, or speculative? What does each cost in latency and compute?
4. A refund requires a tool call taking 800 ms. That blows the budget. Design the interaction — what does the user hear?
5. The user interrupts mid-sentence to correct the account number. Walk through all six interruption steps, being precise about what goes in the history.
6. Capacity: 500 concurrent calls, average 6 minutes. What do you provision for STT, LLM, and TTS, and on what signal does each scale?
:::

:::paper Sources
*Whisper* (Radford et al., ICML 2023) is the standard open speech recognition model; the streaming variants are what production systems use.

For turn-taking timing, the linguistics literature is the right source — Stivers et al., *Universals and cultural variation in turn-taking in conversation* (PNAS 2009) is where the ~200 ms gap figure comes from. The WebRTC specifications and the `libwebrtc` documentation cover echo cancellation and jitter buffering.
:::

## What to carry forward

- **Humans enforce a ~500 ms budget.** Past 800 ms, conversation breaks down.
- **Stream and overlap every stage.** Only **time to first audio** matters; the rest streams behind playback.
- **Endpointing is the largest controllable term.** Semantic endpointing or speculative execution beats a silence timer.
- **WebRTC, not WebSockets** — you need echo cancellation, jitter buffering, and loss concealment.
- **On interruption, truncate history to what was actually played**, not what was generated.
- **Provision for concurrent sessions**, run voice in a small-batch latency lane, and optimise for tight latency variance rather than low mean.
