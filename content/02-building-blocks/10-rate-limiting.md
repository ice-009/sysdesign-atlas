---
title: Rate Limiting
summary: The five algorithms with their exact tradeoffs, where to enforce limits, and how to make counters correct across a distributed fleet.
difficulty: Medium
scope: HLD
tags: [rate-limit, throttling, protection]
prereqs: [caching, queueing-theory]
---

## Why it exists

Rate limiting protects a system from consuming more of itself than it has. Four distinct motivations, and naming which one applies changes the design:

1. **Abuse prevention** — credential stuffing, scraping, spam.
2. **Fairness** — one tenant can't starve the others (noisy neighbor).
3. **Cost control** — every request to an expensive downstream (an LLM, a payment provider, an SMS gateway) costs money.
4. **Stability** — shedding excess load is what keeps you from [cascading failure](../01-fundamentals/failure-modes.html).

The response is normally `429 Too Many Requests` with a `Retry-After` header, plus `X-RateLimit-Limit`, `-Remaining`, and `-Reset` so well-behaved clients can self-regulate.

## The five algorithms

### 1. Fixed window counter

Count requests per fixed interval; reset at the boundary.

```diagram
   key = user:123:minute:1042      counter++, TTL 60s
   allow if counter <= limit
```

**Pro:** trivially simple, one counter per key, minimal memory.
**Con:** the **boundary burst**. With a limit of 100/min, a client can send 100 at 10:00:59 and 100 more at 10:01:00 — 200 requests in one second, twice the intended rate.

Fine for coarse quotas ("10,000 API calls per day"); poor for protecting against bursts.

### 2. Sliding window log

Store a timestamp per request; count those inside the trailing window.

```diagram
   ZADD  user:123  now  request_id          (sorted set)
   ZREMRANGEBYSCORE user:123 -inf (now-60s)  drop expired
   ZCARD user:123 → count, allow if < limit
```

**Pro:** exactly correct. No boundary artifacts, no approximation.
**Con:** memory is O(requests) per key. A limit of 10,000/hour means storing 10,000 timestamps per user. At a million users that's untenable.

Use when limits are small and precision matters (e.g. 5 login attempts per 15 min).

### 3. Sliding window counter

The practical compromise. Keep counters for the current and previous fixed windows, and interpolate:

```diagram
   estimate = current_count
            + previous_count × (overlap fraction of previous window)

   At 10:01:15 with 1-min windows:
   75% of the window still overlaps the 10:00 window
   → estimate = count(10:01) + count(10:00) × 0.75
```

**Pro:** O(1) memory (two counters), smooths the boundary burst, accurate in practice — measured error is typically well under 1%.
**Con:** an approximation; assumes requests were spread evenly within the previous window.

**This is the default answer for API rate limiting** and what most production limiters use.

### 4. Token bucket

A bucket holds up to *B* tokens, refilled at *R* tokens/sec. Each request consumes one; empty bucket means reject.

```diagram
   ┌─────────────┐  refill R tokens/sec, cap B
   │  ● ● ● ● ●  │
   │  ● ● ●      │  request → take 1 token
   └─────────────┘  no token → 429
```

**Pro:** **allows bursts up to B while enforcing an average rate of R.** This matches real traffic, which is bursty by nature — a user opening a page fires 12 requests at once and that's legitimate. Only two values need storing (token count, last refill time), computed lazily on access.

**Con:** two parameters to tune, and a burst can briefly overload a downstream that can't absorb it.

**Best general-purpose choice** when you want to be permissive to real users and strict on sustained abuse. Cost-control limits (API quotas) usually want this.

### 5. Leaky bucket

Requests enter a queue that drains at a fixed rate. Overflow is rejected.

**Pro:** perfectly smooth output — the downstream sees a constant rate regardless of input shape. Ideal when the thing you're protecting genuinely cannot handle bursts (a legacy system, a third-party API with a hard per-second cap).

**Con:** no burst tolerance at all, and queuing adds latency. Requests wait rather than failing fast, which is sometimes worse.

### Choosing

| Need | Algorithm |
|---|---|
| Simple daily/monthly quota | Fixed window |
| Exact small limits (login attempts) | Sliding window log |
| General API limiting | **Sliding window counter** |
| Allow natural bursts, cap the average | **Token bucket** |
| Protect a burst-intolerant downstream | Leaky bucket |

:::interview Name the tradeoff, not just the algorithm
"I'd use token bucket. Real user traffic is bursty — a page load fires a dozen requests — and fixed windows would reject legitimate use while still allowing a 2× boundary burst from an attacker. Token bucket lets me set burst capacity separately from sustained rate, which is the distinction that actually matters here."
:::

## What to limit on

The key determines who gets throttled, and getting it wrong is its own failure:

- **API key / user ID** — the right choice for authenticated traffic. Precise and fair.
- **IP address** — the only option pre-auth, but blunt: an entire office or mobile carrier NAT shares one IP, so you punish thousands of users together. Use generous limits and combine with other signals.
- **Endpoint** — expensive endpoints deserve tighter limits (`/search` at 10/min, `/profile` at 1000/min).
- **Tenant / organization** — for B2B, the account is the unit of fairness.
- **Global** — a system-wide ceiling as a last line of defense.

In practice you apply several tiers simultaneously and the most restrictive wins.

## Distributed rate limiting

Here's the real problem. With 50 application servers, per-server counters mean the effective limit is 50× your intended one.

### Centralized store (the standard answer)

All servers read/write counters in a shared Redis:

```diagram
   -- atomic, single round trip via Lua
   local n = redis.call('INCR', KEYS[1])
   if n == 1 then redis.call('EXPIRE', KEYS[1], window) end
   return n
```

**Correct and simple.** Must be atomic — a separate `GET` then `SET` races under concurrency. Redis is single-threaded per shard, so `INCR` is naturally atomic; anything more complex goes in a Lua script.

**Costs:** ~0.5 ms added to every request, and Redis becomes a dependency on your hot path. **Decide the failure mode explicitly:** if Redis is down, do you *fail open* (allow everything — availability over protection) or *fail closed* (reject — protection over availability)? For abuse prevention, fail open is usually right; for cost control against an expensive downstream, fail closed. Being asked "what if Redis is down?" and having a considered answer is a real differentiator.

### Local counters with async sync

Each server keeps a local counter and periodically reconciles with a central store, adjusting its local allowance.

Fast (no synchronous network call) and resilient, at the cost of accuracy — brief overshoot is possible between syncs. Right when your limits are approximate ("about 1000/min") and latency is precious.

### Token allocation

A central coordinator hands out *batches* of tokens to each server (e.g. "you may serve 200 requests"). Servers spend locally and request more when low. Dramatically fewer central round trips; slightly lossy when a server dies holding unspent tokens. This is how very high-throughput limiters work.

## Where to enforce

```diagram
   Client ──► CDN/Edge ──► API Gateway ──► Service ──► DB
              ▲             ▲                ▲
         volumetric    per-user quotas   business rules
         DDoS, bots    the main tier     (e.g. 3 transfers/day)
```

**Enforce as early as possible.** A request rejected at the edge costs you nothing; one rejected at the service has already consumed a connection, a thread, and possibly a database round trip. But business-logic limits ("max 5 password resets per day") need application context and must live deeper.

Client-side self-limiting is a courtesy, never a control — it helps well-behaved clients avoid tripping limits and does nothing against attackers.

## Details that show experience

- **Return the right headers.** `Retry-After` lets clients back off intelligently instead of hammering.
- **Add jitter to `Retry-After`**, or every throttled client retries in the same instant — the [thundering herd](caching.html) again.
- **Don't count rejected requests toward the limit**, or a client that trips the limit can never recover within the window.
- **Separate read and write limits.** Writes are usually more expensive and more abusable.
- **Warn before enforcing.** Log-only mode first, so you discover that your "obviously safe" limit would have broken a major customer.
- **Allow-list internal traffic** — health checks and internal service calls shouldn't consume user quota.
- **Make limits configurable at runtime.** During an incident you want to tighten limits without a deploy.

For a full end-to-end design of a rate limiting service — including capacity math, storage, and failure handling — see the [Rate Limiter case study](../05-case-studies/rate-limiter.html).

:::exercise Build the limiter
1. Fixed window, sliding window log, sliding window counter, token bucket, leaky bucket. For each: memory per client, burst behaviour, and the specific failure it has.
2. A 100 req/min fixed window lets a client send 200 requests in 2 seconds. Show the interleaving. Which algorithms prevent it?
3. Distributed limiting across 20 API servers with a shared Redis. What does each check cost in latency, and how would you reduce it without losing much accuracy?
4. Redis is down. What does your limiter do — fail open or fail closed? Argue both, then pick one and say what protects you from the downside.
5. Now limit on *tokens* rather than requests, for an LLM API. What changes, and why does a request-based limit fail here?
:::

:::paper Algorithms and fairness
The token bucket and leaky bucket come from ATM network traffic shaping; the classic reference is Turner's 1986 work on the leaky bucket. Stripe's engineering post on rate limiters and Cloudflare's on sliding-window counters are the best practical write-ups.

For fairness across tenants, the weighted fair queueing literature (Demers, Keshav & Shenker, SIGCOMM 1989) transfers directly.
:::
