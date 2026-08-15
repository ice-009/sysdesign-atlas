---
title: Design a Ticket Booking System (Ticketmaster)
summary: Extreme burst traffic against a hard correctness constraint. Seat reservation without double-booking, the virtual waiting room, and why this is the case study where consistency wins.
difficulty: Hard
scope: HLD
tags: [case-study, consistency, transactions, burst]
prereqs: [transactions-isolation, distributed-locks, idempotency]
---

:::interview Why this question
Almost every other case study lets you choose availability over consistency. This one doesn't — **double-booking a seat is unacceptable**, and the traffic pattern is the most extreme in this curriculum (1000× spikes). It tests whether you can identify the small transactional core and design everything else around protecting it.
:::

## 1. Requirements

**Functional**
- Browse events and see seat availability.
- Select specific seats and hold them briefly while paying.
- Complete purchase; receive tickets.
- Release holds that aren't paid for.

**Non-functional**
- **No double-booking. Ever.** This is the hard invariant.
- Survive extreme bursts: a major tour goes on sale and 2M people arrive in the same second.
- Fair-ish access — first come, first served, not "whoever has the fastest connection."
- Browsing can be eventually consistent; booking cannot.

**Cut:** dynamic pricing, resale marketplace, recommendations, fraud detection (mention bot mitigation as important).

**Clarifying questions:** Assigned seats or general admission? (Very different — general admission is just a counter.) How long is the hold window? Is a queue/waiting room acceptable to the business? Resale in scope?

## 2. Estimation

```diagram
   NORMAL:  10,000 browse QPS, 100 bookings/s — unremarkable

   ON-SALE BURST (the real problem):
     2M users hit "buy" within ~10 seconds
     → 200,000 booking attempts/s
     → against an inventory of maybe 50,000 seats

   Ratio: 40 attempts per available seat.
   97.5% of requests MUST fail. The design's job is to make
   them fail cheaply and fairly.
```

**This reframing is the key insight and worth saying out loud:** the system's purpose during an on-sale is not to serve 200K bookings/s — it's to *reject* 199,900 of them per second without touching the database, so the 100 real bookings succeed correctly.

```diagram
   Storage: trivial. A large venue is 100K seats;
   even 10K events/year is ~10⁹ seat records. Small.
   → this is NOT a storage or scale problem. It's a
     CONTENTION and BURST problem.
```

Saying "this isn't a scale problem, it's a contention problem" early demonstrates you've correctly diagnosed the question.

## 3. Data model

```diagram
   events        event_id · venue_id · name · on_sale_at
   seats         seat_id · event_id · section · row · number · price
                 status: AVAILABLE | HELD | BOOKED
                 held_until  TIMESTAMP NULL
                 held_by     user_id NULL
   bookings      booking_id · user_id · event_id · seat_ids[]
                 status · payment_id · created_at
```

Shard by `event_id` — everything about one event stays together, so a booking transaction is **single-shard**. This avoids [distributed transactions](../03-distributed/distributed-transactions.html) entirely, which is the single most valuable modeling decision here.

**Use a relational database for the booking core.** This is a case where the correct answer is boring: you need ACID transactions and a uniqueness constraint. Say so confidently — reaching for an eventually-consistent store here would be a serious error.

## 4. The core: reserve-then-confirm

The whole design turns on one rule: **never keep a database transaction open while a human is doing something.** A transaction holds locks, and a user typing their card details takes minutes — during which those seats, and often neighbouring rows, are frozen for everyone else.

So instead of one long transaction, use two short ones with a *hold* in between. The hold is an ordinary column on the row saying "reserved for this person until this time" — data, not a lock — so the database is free the entire time the user is paying.

```diagram
   1. HOLD  (fast, transactional)
        BEGIN;
          SELECT * FROM seats
            WHERE seat_id IN (...) AND status = 'AVAILABLE'
            FOR UPDATE;                    -- lock the rows
          -- if any row is missing → someone got there first
          UPDATE seats SET status='HELD',
                 held_by = :user,
                 held_until = now() + interval '8 minutes'
            WHERE seat_id IN (...);
        COMMIT;                            -- ~1 ms, lock released

   2. PAY   (slow, external, 30s-5min — NO locks held)

   3. CONFIRM
        UPDATE seats SET status='BOOKED'
          WHERE seat_id IN (...) AND held_by = :user
            AND status = 'HELD';
        -- create the booking record in the same transaction

   4. EXPIRY: held_until passes → seat returns to AVAILABLE
```

:::goat Why the TTL is the elegant part
"The hold expiry *is* the compensating transaction. If payment fails, times out, or the user closes the tab, I don't need a saga, a coordinator, or a rollback path — the seat simply becomes available again when the TTL passes. That removes an entire class of distributed-transaction complexity by modeling the intermediate state explicitly in the domain."

This is the reserve-with-TTL pattern from [Distributed Transactions](../03-distributed/distributed-transactions.html), and it's the single best idea in this design.
:::

**Expiry implementation:** don't rely solely on a background job — check `held_until < now()` in the availability query so expired holds are *logically* free immediately, and let a periodic job do the physical cleanup. That way a lagging cleanup job never blocks sales.

## 5. Deep dive — preventing double-booking

Multiple layers, and a strong answer names more than one:

**Layer 1 — row locking.** Adding `FOR UPDATE` to a `SELECT` tells the database "I intend to change these rows, don't let anyone else touch them until I'm done". Two people going for the same seat are therefore forced into single file: the second one waits, then sees the seat is no longer available and fails cleanly.

**Layer 2 — conditional update.** Even better, make the update itself the check:

```sql
UPDATE seats SET status='HELD', held_by=:user, held_until=:t
WHERE seat_id = :s AND status='AVAILABLE';
-- 0 rows affected → someone else won. No lock needed.
```

This is optimistic concurrency, and it's cheaper than pessimistic locking under contention because nothing blocks.

**Layer 3 — a uniqueness constraint** on `(event_id, seat_id)` in the bookings table. Even if every other layer had a bug, the database physically cannot record two bookings for one seat. **This is the safety net that makes the invariant true rather than merely likely** — and proposing it shows you think in terms of guarantees rather than code paths.

**What NOT to do:** a [distributed lock](../02-building-blocks/distributed-locks.html) in Redis. As covered there, a lock can't guarantee mutual exclusion under GC pauses or partitions. When the data is already in one database, a transaction is both simpler and strictly safer. Explicitly rejecting the Redis lock is a good move.

:::trap The isolation level trap
Under the default Read Committed isolation, checking availability and then updating in two statements is a lost-update race. Either use a single conditional `UPDATE` (which is atomic on its own), or `SELECT ... FOR UPDATE`, or run the transaction at Serializable. Saying "the default isolation level won't protect this" is a genuine [isolation](../04-data/transactions-isolation.html) depth signal.
:::

## 6. Deep dive — surviving the on-sale burst

**Virtual waiting room.** The single most important mechanism, and the one real systems actually use.

```diagram
   Users arriving before/at on-sale are placed in a QUEUE
   at the edge, given a position and an ETA, and admitted
   to the purchase flow at a controlled rate.

   ┌──────────┐   ┌─────────────┐   ┌──────────────┐
   │ 2,000,000│──►│ Waiting room│──►│ Booking flow │
   │ arriving │   │ (edge, cheap│   │ ~5,000       │
   │          │   │  static     │   │ concurrent   │
   │          │   │  page + WS) │   │ users        │
   └──────────┘   └─────────────┘   └──────────────┘
```

Why it works: the queue is served by a **cheap, static, CDN-backed page**, and admitted users trickle in at a rate the booking core can actually handle. Instead of 200K QPS hitting your database, you get a steady 500 QPS. The burst is absorbed at the edge, where absorbing bursts is cheap.

It also solves **fairness**: admission is by arrival order (with a randomized draw for those who arrive simultaneously, which is fairer than rewarding the fastest network connection). Fairness here is a product requirement, and naming it is a good sign.

**Other burst defenses:**
- **Pre-scale** — this traffic is scheduled. Scale up before on-sale; don't rely on autoscaling to react in seconds.
- **Cache availability aggressively.** Browse traffic reads a cached seat map with a 1–5 s TTL. It's allowed to be stale — the authoritative check happens at hold time. Separating the *display* path (eventually consistent, cached, huge) from the *booking* path (strongly consistent, small) is the core architectural split.
- **Bot mitigation** — a large share of on-sale traffic is automated. Rate limit per account and per payment method, require pre-registration, and challenge suspicious clients. Worth raising as a real, large problem.
- **[Load shed](../03-distributed/backpressure.html) at the edge** with a fast, clear rejection rather than a timeout.

## 7. High-level design

```diagram
   ┌──────┐   ┌──────────────┐
   │ CDN  │──►│Waiting room  │  static page, WebSocket for
   └──────┘   │ (edge)       │  position updates
              └──────┬───────┘
                     │ admit at controlled rate (token bucket)
                     ▼
   ┌──────────────────────────────────────────────┐
   │              API Gateway                     │
   └───┬──────────────────────────┬───────────────┘
       ▼ browse (cached)          ▼ book (transactional)
   ┌────────────┐            ┌──────────────┐
   │ Seat map   │            │  Booking     │
   │ cache      │            │  service     │
   │ (Redis,    │            └──────┬───────┘
   │  1-5s TTL) │                   ▼
   └────────────┘            ┌──────────────┐    ┌───────────┐
         ▲                   │ Postgres     │───►│ Payment   │
         └── CDC invalidate ─┤ (sharded by  │    │ (external)│
                             │  event_id)   │    └───────────┘
                             └──────────────┘
                                    │
                             ┌──────▼───────┐
                             │ Expiry job   │ release stale holds
                             └──────────────┘
```

## 8. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| Payment provider slow/down | Holds expire naturally; seats return. User sees a clear failure. **No inventory is lost** — the TTL guarantees it. |
| Payment succeeds, confirm fails | The dangerous case. Payment taken, no ticket. Requires **forward recovery**: retry confirmation from a durable record, and reconcile. Never leave money taken with nothing delivered. |
| Database primary fails | Booking stops (correctly — better than double-selling). Failover to a synchronous replica; RPO must be zero here. |
| Expiry job down | Seats stay held past their TTL. Mitigated by checking `held_until` in queries so expiry is logical, not dependent on the job. |
| Cache stale | Users see seats that are gone; the hold attempt fails cleanly with "seat no longer available." Acceptable and expected. |

**Follow-ups:**
- *"General admission instead of assigned seats?"* — becomes a counter decrement, which is far easier: an atomic decrement with a floor, or pre-sharded counters (10 buckets of 5,000 each) to avoid a single hot row.
- *"Adjacent seats for a group?"* — the seat-selection algorithm must find contiguous blocks; hold them atomically in one transaction. Also introduces a packing problem (don't strand single seats).
- *"Multi-region?"* — **don't distribute the booking core.** Pin each event's inventory to one region — it's a natural [home-region partition](../03-distributed/multi-region.html). Browse traffic can be served globally from caches.
- *"How do you test the on-sale?"* — load test at 10× expected, with a game day. And note the part that is easy to forget: the *waiting room* must be load-tested too, since it is now the component absorbing the full burst.
