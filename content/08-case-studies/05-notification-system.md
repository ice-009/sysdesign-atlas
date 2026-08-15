---
title: Design a Notification System
summary: Multi-channel delivery at scale — push, SMS, email — with third-party providers you don't control, deduplication, user preferences, and rate limits that protect users from you.
difficulty: Medium
scope: HLD
tags: [case-study, queue, fanout, idempotency]
prereqs: [message-queues, idempotency, pub-sub]
---

:::interview Why this question
It's a queue-and-worker design where all the interesting problems come from **things outside your control**: third-party providers fail, rate limit you, and duplicate. It's an excellent test of [idempotency](../03-distributed/idempotency.html), retry discipline, and prioritization.
:::

## 1. Requirements

**Functional**
- Send notifications over push (iOS/Android), SMS, email, and in-app.
- Triggered by internal services ("order shipped", "you were mentioned").
- Users control preferences per channel and per category.
- Templates with per-user variables and localization.
- Scheduled and time-zone-aware sends.

**Non-functional**
- **At-least-once delivery, with deduplication** — a missed critical alert is bad; a duplicate is worse for trust.
- High-priority notifications (2FA codes, security alerts) delivered in seconds; marketing can wait minutes.
- Handle bursts — a broadcast to 50M users shouldn't delay someone's login code.
- Third-party provider failures must not lose notifications.

**Clarifying questions:** Are there hard-latency categories (OTP)? Do we own the templates or do callers? Broadcast/campaign support, or only per-user triggers? Is delivery-status tracking required?

## 2. Estimation

**500M users**, 10 notifications/user/day, with a peak burst of 50M in 10 minutes for a campaign.

```diagram
   Steady:  500M × 10 / 10⁵  = 50,000 notifications/s avg
                              → ~150,000 peak

   Burst:   50M / 600 s       = 83,000/s on top of steady
            → the system must absorb this WITHOUT delaying OTPs

   Storage (delivery log, 200 B/record, 90-day retention):
     5 × 10⁹/day × 200 B = 1 TB/day → 90 TB retained
```

**What this decided:** the burst number forces **priority lanes** — a single queue would put a 2FA code behind 50M marketing messages. That's the central design insight here, and it's worth stating before drawing anything.

## 3. High-level design

```diagram
   internal    ┌──────────────┐
   services ──►│ Notification │  validate · dedupe · resolve
               │     API      │  preferences · render template
               └──────┬───────┘
                      │
        ┌─────────────┼──────────────┬───────────────┐
        ▼             ▼              ▼               ▼
   ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌────────────┐
   │CRITICAL │  │  HIGH    │  │  NORMAL   │  │    BULK    │  Kafka
   │ (OTP)   │  │(txn'l)   │  │ (social)  │  │(marketing) │  topics
   └────┬────┘  └────┬─────┘  └─────┬─────┘  └──────┬─────┘
        └────────────┴──────────────┴───────────────┘
                            │  workers pull by priority
                     ┌──────┴────────┐
                     ▼               ▼
              ┌────────────┐  ┌────────────┐
              │Push workers│  │SMS workers │ ... email, in-app
              └─────┬──────┘  └─────┬──────┘
                    ▼               ▼
              APNs / FCM       Twilio etc.   ◄── external, unreliable
                    │               │
                    └───────┬───────┘
                            ▼
                  delivery status → DB + analytics
```

**Priority lanes are separate topics with separately-scaled worker pools.** Critical workers are always over-provisioned relative to their load, so an OTP never queues behind a campaign. This is [load shedding](../03-distributed/backpressure.html) applied by priority rather than by volume.

## 4. Request flow

```diagram
   1. Service calls POST /notifications with an idempotency key
   2. API validates, checks DEDUPE store (key seen in last 24h?)
   3. Resolve user preferences:
        - has the user disabled this category?     → drop
        - which channels are enabled?              → fan out
        - quiet hours in the user's timezone?      → schedule
   4. Render the template (localized)
   5. Publish one message per (user, channel) to the priority topic
   6. Worker pulls, calls the provider, records the outcome
   7. Failure → retry with backoff; exhausted → DLQ + alert
```

**Preference resolution belongs at the front**, not in the worker. Doing it once at ingest avoids doing it per-channel in every worker, and it means a disabled notification never enters a queue at all.

## 5. Deep dive — idempotency and deduplication

Two distinct problems that candidates often merge:

**1. Caller retries.** The order service times out calling you and retries. Without protection, the user gets two "order shipped" messages.

*Fix:* an idempotency key from the caller, gated by a unique constraint. Same pattern as [Idempotency](../03-distributed/idempotency.html) — insert the key first, return the stored result on a duplicate.

**2. Queue redelivery.** The worker calls the provider, the provider succeeds, and the worker crashes before acking. The message is redelivered and sent again.

*Fix:* this one is harder because the side effect is external. Layered defense:
- Pass an idempotency key **to the provider** where supported — good SMS and email providers accept one precisely for this.
- Record "sent" transactionally against the notification ID **before** acking, and check it on redelivery.
- Accept that a narrow window remains, and that a rare duplicate push is preferable to a lost one.

```diagram
   worker:
     claim (conditional update: status pending → sending)
     ← if the claim fails, another worker has it. Skip.
     call provider with idempotency_key = notification_id
     mark sent
     ack the message
```

:::goat The honest answer
"I can't get exactly-once here, because the side effect is a third-party API call. What I can do is make duplicates *rare* — a conditional claim so two workers don't process the same notification, an idempotency key passed to the provider, and a status check before sending. Then I choose the failure direction deliberately: for a security alert I'd rather send twice than not at all, so I retry aggressively. For a marketing message the reverse, so I don't retry past one attempt."

Choosing the *direction* of the failure per category is the senior move here.
:::

## 6. Deep dive — third-party providers

You depend on services you don't control, which is the defining constraint.

**They rate limit you.** Providers cap your send rate. Exceeding it gets you throttled or blocked. So your workers need **client-side rate limiting** matched to the provider's contract — a [token bucket](../02-building-blocks/rate-limiting.html) per provider, shared across workers via Redis.

**They fail.** Circuit breakers per provider. When one trips, either queue (for non-urgent) or **fail over to a secondary provider** (for critical). Multi-provider support for SMS and email is standard practice, and mentioning it shows operational awareness.

**They're slow.** A worker blocked for 30 s on a provider call is a worker doing nothing. Use async I/O and bound concurrency; don't let one slow provider consume the whole pool ([bulkheads](../01-fundamentals/failure-modes.html)).

**They report asynchronously.** Delivery receipts arrive by webhook, minutes later. You need a callback endpoint that maps provider message IDs back to your notification IDs, so "sent" and "delivered" are separate states.

**Device tokens expire.** APNs/FCM return errors for stale tokens. Process these and prune, or you'll accumulate dead tokens and waste capacity forever.

## 7. Deep dive — the burst

50M notifications in 10 minutes, without disturbing anything else.

```diagram
   1. Campaigns go to the BULK topic — physically separate
      from critical lanes.
   2. Bulk workers are RATE-CAPPED to leave provider headroom
      for transactional traffic.
   3. Expand the audience lazily: enqueue a "campaign job",
      and let workers page through the recipient list.
      DON'T materialize 50M messages up front.
   4. Respect quiet hours per timezone, so it naturally spreads
      across the day rather than firing at once.
```

Point 3 matters: expanding 50M recipients into a queue at once creates a huge backlog, consumes broker storage, and makes cancellation nearly impossible. Paging through the audience keeps the queue shallow and lets you **stop a campaign mid-flight** — which someone will eventually need at 2am.

## 8. Deep dive — protecting users from you

A subtle requirement that is easy to miss, and expensive to retrofit.

**Per-user rate limits.** If a user is mentioned 500 times in a thread, they should not get 500 pushes. Apply a limiter per user per category, and **aggregate**: "50 new mentions" instead of 50 notifications.

**Digest/batching windows.** Hold low-priority notifications briefly and coalesce. Improves user experience and cuts volume dramatically.

**Quiet hours** in the user's local timezone, with an explicit override for critical categories.

**Unsubscribe honoured everywhere**, including in-flight queued messages — check preferences again *in the worker*, not just at ingest, because a user may have opted out while the message sat in a queue.

## 9. Storage

```diagram
   notifications  (Cassandra — high write volume, time-ordered)
     partition: user_id     clustering: created_at DESC
     → "my notification history" is a single-partition scan

   preferences    (SQL or KV, heavily cached)
     user_id → {channel, category} → enabled, quiet_hours, timezone

   device_tokens  (KV)
     user_id → [{token, platform, last_seen}]

   dedupe         (Redis, 24h TTL)
     idempotency_key → notification_id
```

Preferences are read on **every** notification, so they must be cached aggressively — and invalidated on change via [CDC](../04-data/cdc-outbox.html).

## 10. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| Provider down | Circuit breaker opens; critical fails over to secondary, others queue. Queue depth alarms. |
| Worker pool saturated | Queues grow. Critical lane unaffected (separate pool). Bulk lane sheds/delays. |
| Preferences service down | Serve from cache. If cold, **fail closed for marketing, open for critical** — don't spam users on a cache miss. |
| Dedupe store down | Accept the duplicate risk and keep sending. Losing notifications is worse. |
| Template rendering fails | Send to DLQ, alert. Never send a half-rendered message to users. |

**Follow-ups:**
- *"How do you handle a user with 10 devices?"* — fan out per device; track delivery per device; prune stale tokens on provider error.
- *"Exactly-once?"* — not achievable across a third-party boundary. Explain the layered mitigation above and pick a failure direction per category.
- *"Scheduled notifications?"* — a time-bucketed store (e.g. sorted set per minute) scanned by a scheduler that publishes to the normal pipeline. See [Job Scheduler](job-scheduler.html).
- *"How do you test this?"* — a sandbox provider mode plus a shadow lane; never send real messages from a test environment. Practical and rarely mentioned.
