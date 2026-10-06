---
title: Practice Question Bank
summary: 70+ prompts organized by the core difficulty each one tests, plus the follow-ups interviewers actually ask and a protocol for practicing alone.
difficulty: Easy
scope: HLD
tags: [practice, questions, drills]
---

:::predict Guess first
1. Is reading a prompt and imagining your answer good practice for an interview?
2. "Design a vaccine appointment scheduler" — which classic design problem does it secretly resemble?
3. When practising alone, how could you simulate an interviewer's pressure?
:::

## How to use this

Do **not** read these and imagine answers. Recognition is nearly free to acquire and nearly worthless in the room.

**The protocol:**

```diagram
   1. Pick a prompt you haven't studied.
   2. Set a 45-minute timer. Record your voice and screen.
   3. Talk continuously, as if someone is there.
   4. At minutes 15, 30, and 40, interrupt yourself with a
      hostile question from the list at the bottom.
   5. Watch the recording the next day. Score yourself
      against the four signals.
   6. Log the gap. That log becomes your real curriculum.
```

Prompts marked ★ are the highest-frequency ones. If you only do ten, do those.

---

## Fanout & feeds

*Core difficulty: write amplification, hot keys, push vs pull.*

- ★ Design Twitter / a news feed → [worked solution](../05-case-studies/news-feed.html)
- ★ Design Instagram
- Design a Reddit-style ranked front page
- Design LinkedIn's activity feed
- Design a "who viewed your profile" feature
- Design a follower/following graph service
- Design Twitter's trending topics
- Design a group activity notification digest

**Follow-ups to expect:** What if one account has 100M followers? What if a normal user goes viral mid-stream? How do deletes and unfollows work without re-fanning-out? What changes if the feed is ranked rather than chronological?

---

## Real-time & connections

*Core difficulty: stateful servers, routing to a specific socket, delivery guarantees.*

- ★ Design WhatsApp / Messenger → [worked solution](../05-case-studies/chat-system.html)
- ★ Design Slack
- Design a live comments system for a streamed event
- Design a multiplayer game lobby with presence
- Design collaborative cursors and presence
- Design a live sports score push service
- Design an online/offline status service at 500M users
- Design a video call signalling service

**Follow-ups:** Where does a user's socket live and how do you find it? What happens on deploy? How do you guarantee no message is lost? How do you handle a reconnect storm? What about mobile background delivery?

---

## Storage & data systems

*Core difficulty: partitioning, replication, consistency, storage engines.*

- ★ Design a distributed key-value store → [worked solution](../05-case-studies/key-value-store.html)
- ★ Design a distributed cache → [worked solution](../05-case-studies/distributed-cache.html)
- Design Google Drive / Dropbox (file sync) → [worked solution](../08-case-studies/file-sync.html)
- Design S3 / a blob store
- Design a distributed file system
- Design a time-series database for metrics
- Design a message queue from scratch → [worked solution](../08-case-studies/distributed-log.html)
- Design a configuration service (etcd-like)
- Design a distributed counter at 1M increments/s

**Follow-ups:** What happens during a network partition? How do you add a node without downtime? How do concurrent writes get resolved? What's your read repair strategy? How do you handle a hot key?

---

## Throughput & streaming

*Core difficulty: ingest volume, windowing, exactly-once, late data.*

- ★ Design an ad click aggregator → [worked solution](../05-case-studies/ad-click-aggregator.html)
- ★ Design a metrics & monitoring system → [worked solution](../08-case-studies/metrics-monitoring.html)
- Design a logging/observability pipeline
- Design a real-time analytics dashboard
- Design a fraud detection pipeline
- Design a recommendation feature pipeline
- Design a leaderboard for 100M players
- Design a "top K trending" service

**Follow-ups:** How do you handle events arriving hours late? Can you double-count? How do you make these numbers billable-accurate? What's your windowing strategy? What happens when a consumer falls behind?

---

## Correctness under contention

*Core difficulty: transactions, invariants, idempotency, burst traffic.*

- ★ Design Ticketmaster / seat booking → [worked solution](../05-case-studies/ticket-booking.html)
- ★ Design a payment system → [worked solution](../05-case-studies/payment-system.html)
- Design a hotel/flight booking system
- Design an inventory management system for e-commerce
- Design a digital wallet with balances
- Design a flash-sale system
- Design a coupon/voucher redemption service
- Design a distributed lock service

**Follow-ups:** How do you guarantee no double-booking? What if the payment provider times out and you don't know the outcome? How do you handle 1000× traffic at the on-sale moment? What's your reconciliation process?

---

## Geospatial & matching

*Core difficulty: spatial indexing, moving objects, matching under latency budget.*

- ★ Design Uber / ride-sharing → [worked solution](../05-case-studies/ride-sharing.html)
- Design a food delivery service
- Design a proximity service (Yelp / "restaurants near me")
- Design Google Maps' routing service
- Design a geofencing / location-alert system
- Design a "find nearby friends" feature
- Design a fleet tracking system

**Follow-ups:** Why not a database with a spatial index? How do you handle 1M+ location writes/s? Why is straight-line distance the wrong ranking metric? How do you prevent double-assigning a driver?

---

## Media & content delivery

*Core difficulty: bandwidth, pipelines, CDN economics.*

- ★ Design YouTube / Netflix → [worked solution](../05-case-studies/video-streaming.html)
- Design a live streaming platform
- Design an image hosting and resizing service
- Design a podcast platform
- Design a CDN
- Design a photo storage backend at petabyte scale

**Follow-ups:** How does adaptive bitrate work and why does it help the CDN? How do you cut transcoding cost? What's your storage tiering plan? What changes for live vs on-demand?

---

## Search & retrieval

*Core difficulty: inverted indexes, ranking, index freshness.*

- ★ Design search autocomplete → [worked solution](../05-case-studies/autocomplete.html)
- Design a search engine for a large product catalog
- Design a web crawler → [worked solution](../05-case-studies/web-crawler.html)
- Design a code search system
- Design a "people you may know" service
- Design a semantic/vector search service

**Follow-ups:** How does the index stay in sync with the source of truth? How do you rebuild it without downtime? How do you handle typos? What's your ranking beyond text relevance?

---

## Infrastructure & platform

*Core difficulty: coordination, scheduling, multi-tenancy.*

- ★ Design a rate limiter → [worked solution](../05-case-studies/rate-limiter.html)
- ★ Design a job scheduler → [worked solution](../05-case-studies/job-scheduler.html)
- Design a CI/CD pipeline system
- Design a feature flag service
- Design an A/B testing platform
- Design a secrets management service
- Design a service discovery system
- Design a multi-tenant API gateway
- Design a webhook delivery service

**Follow-ups:** What happens when the coordination store is down — fail open or closed? How do you guarantee a job runs exactly once? What if a worker dies holding a claim? How do you prevent one tenant from starving others?

---

## Collaboration & sync

*Core difficulty: concurrent mutation, merge semantics, offline.*

- ★ Design Google Docs → [worked solution](../05-case-studies/collaborative-editor.html)
- Design a note-taking app with offline sync
- Design a shared whiteboard
- Design a kanban board with real-time updates
- Design a version control system
- Design a calendar with shared availability

**Follow-ups:** What happens when two people edit the same word? OT or CRDT, and why? How does undo work with multiple authors? How do you persist and replay history?

---

## AI systems

*Core difficulty: GPU memory as the scarce resource, token economics, retrieval quality, and acting safely on model output.*

- ★ Design an LLM inference service → [guided build](../09-builds/llm-inference-serving.html)
- ★ Design a ChatGPT-style chat product → [guided build](../09-builds/ai-chat-platform.html)
- ★ Design question answering over company documents (RAG) → [guided build](../09-builds/rag-system.html)
- Design an AI agent platform that can take actions → [guided build](../09-builds/ai-agent-platform.html)
- Design an AI code-completion service → [guided build](../09-builds/ai-code-assistant.html)
- Design an evaluation platform for prompt and model changes → [guided build](../09-builds/eval-platform.html)
- Design a phone-call voice agent → [guided build](../09-builds/voice-assistant.html)
- Design a multi-tenant fine-tuning service → [guided build](../09-builds/fine-tuning-platform.html)
- Design an LLM gateway for a company using several model providers → [topic](../07-ai-systems/llm-gateways.html)
- Design serving for a reasoning model whose answers take minutes → [topic](../06-ai-infrastructure/serving-reasoning-models.html)
- Design a platform that lets agents use third-party tools safely (MCP) → [topic](../07-ai-systems/agent-protocols.html)

**Follow-ups:** What limits how many users one GPU serves? How do you rate-limit when one request can be 20 tokens or 20,000? What does prefix caching change? How do you stop retrieval leaking documents a user can't see? What happens when a web page the agent reads contains instructions? How would you know a prompt change made answers worse?

---

## Product-shaped prompts

These wrap familiar difficulties in unfamiliar clothes. Good practice at recognizing the underlying problem.

- Design an airline check-in system
- Design a parking garage availability system
- Design a vaccine appointment scheduler
- Design a food-truck locator
- Design an online exam proctoring system
- Design a queue-management system for a clinic
- Design a warehouse robot task dispatcher
- Design a subscription billing system

**The drill:** for each, name the case study it resembles before designing. "Vaccine appointments is ticket booking — limited inventory, extreme burst, no double-booking."

---

## Hostile questions to interrupt yourself with

Use these during solo practice. Pick three at random.

**Scale:**
- "What breaks first at 10× traffic?"
- "What if there were 100× the data?"
- "What's your single biggest bottleneck right now?"

**Failure:**
- "Kill your database primary. What happens in the next 60 seconds?"
- "The cache cluster restarts empty under full load. Walk me through it."
- "This dependency is up but responding in 8 seconds. What does your system do?"
- "There's a network partition between your two regions. Now what?"

**Correctness:**
- "Can this ever double-charge / double-book / double-send?"
- "Two users do this at exactly the same instant. What happens?"
- "The client retries after a timeout. Is that safe?"

**Simplicity:**
- "Why not just one Postgres box?"
- "Can you remove a component and still meet the requirements?"
- "What would you build with three engineers in six weeks?"

**Operations:**
- "How would you know this is broken before a user tells you?"
- "How do you deploy this without downtime?"
- "How do you migrate from the existing system to this one?"
- "What does this cost per month, roughly?"

---

## A 20-session plan

If you have four weeks and can do five sessions a week:

```diagram
   Week 1  URL shortener · rate limiter · distributed cache
           key-value store · news feed
   Week 2  chat · notification system · job scheduler
           autocomplete · web crawler
   Week 3  video streaming · ride sharing · ticket booking
           ad click aggregator · payment system
   Week 4  collaborative editor · + 4 product-shaped prompts
           you haven't seen, cold, fully timed
```

Week 4 matters most: **unfamiliar prompts, cold, timed.** That's the only condition that actually resembles the interview.

## Check yourself

```recall
Q: What is the solo practice protocol?
A: An unstudied prompt, a 45-minute timer, recorded and spoken continuously, self-interruptions with hostile questions at minutes 15, 30 and 40, then next-day review against the four signals and a logged gap.

Q: Why doesn't reading prompts and imagining answers work?
A: Recognition is nearly free to acquire and nearly worthless in the room; only generating a design out loud under time pressure resembles the interview.

Q: What are the core difficulties the prompt families test?
A: Fanout and hot keys; stateful connections; partitioning and consistency; ingest, windowing and exactly-once; correctness under contention; geospatial matching; bandwidth; index freshness; coordination; merge semantics; GPU memory and token economics.

Q: What is the product-shaped prompt drill?
A: Name the case study an unfamiliar prompt resembles before designing — vaccine appointments is ticket booking: limited inventory, extreme burst, no double-booking.

Q: Name hostile questions to interrupt yourself with.
A: What breaks first at 10×? Kill the primary — next 60 seconds? Can this double-charge? Why not one Postgres box? How would you know it's broken before a user does?

Q: What do AI-system interviews probe?
A: What limits users per GPU (KV cache), token-based rate limits, prefix caching, permission-aware retrieval, prompt injection through read content, and how you'd detect a quality regression.

Q: What matters most in the 20-session plan?
A: Week 4: unfamiliar prompts, cold and fully timed — the only condition that resembles the real interview.
```

## What to carry forward

- Practise by generating designs out loud, timed, never by imagining.
- Group prompts by core difficulty, and name the familiar problem inside an unfamiliar prompt.
- Interrupt yourself with hostile questions on scale, failure, correctness, simplicity and operations.
- Finish with cold, timed, unseen prompts.
