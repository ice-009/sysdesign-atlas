---
title: Design a Distributed Rate Limiter
summary: A deceptively deep question. The algorithm is the easy part; the interview lives in distributed counter accuracy, latency budget, and what happens when the store is down.
difficulty: Medium
tags: [case-study, rate-limit, redis, latency]
prereqs: [rate-limiting, caching, distributed-locks]
---

:::interview Why this question
It looks like an algorithms question and isn't. Interviewers use it because a good answer must cover distributed state, atomicity, latency budgets, failure modes, and a clean availability/correctness tradeoff — all in a small enough problem to finish in 45 minutes.
:::

## 1. Requirements

**Functional**
- Limit requests per client to a configured rate.
- Multiple rules simultaneously: per-user, per-IP, per-endpoint, per-tenant.
- Return `429` with `Retry-After` and remaining-quota headers.
- Rules configurable at runtime, without a deploy.

**Non-functional**
- **Latency: sub-millisecond added to every request.** This is the hardest constraint — it's on the path of literally every request.
- Accurate enough — brief overshoot acceptable, order-of-magnitude error not.
- Highly available. The limiter must not become the reason the API is down.
- Scales to the full request volume of the platform.

**Clarifying questions:**
- Is this an edge service, a library, or a sidecar?
- How exact must limits be? ("about 1000/min" vs "never more than 1000")
- What should happen if the rate-limit store is unavailable?
- Do limits need to be global across regions?

## 2. Estimation

Assume **1M QPS** across the platform, 10M active clients, and 3 rules evaluated per request.

```diagram
   Counter operations:  1M × 3 rules = 3M ops/s

   State per counter (token bucket): tokens (8B) + last_refill (8B)
                                     + key overhead ≈ 100 B
   Active counters: 10M clients × 3 rules = 30M
   Memory: 30M × 100 B = 3 GB          ← fits comfortably in RAM

   Redis capacity: ~100K ops/s per shard (conservative, with Lua)
   → 3M / 100K = 30 shards minimum, ~50 with headroom
```

**What this decided:** 3 GB means the entire state is memory-resident — no persistence needed, since counters are recreatable and worthless after their window. 3M ops/s means the naive "one Redis" answer fails and we must shard, which then raises the question of *how* to shard.

## 3. Algorithm choice

Covered fully in [Rate Limiting](../02-building-blocks/rate-limiting.html). For this design:

**Token bucket**, because real traffic is bursty. A user opening a page fires a dozen requests at once — legitimate behaviour that a fixed window would reject while *still* permitting a 2× boundary burst from an attacker. Token bucket separates burst capacity from sustained rate, which is the distinction that matters.

Only two values are stored, and refill is computed lazily on access:

```diagram
   elapsed     = now - last_refill
   tokens      = min(capacity, tokens + elapsed × refill_rate)
   if tokens >= 1:  tokens -= 1;  ALLOW
   else:            DENY, retry_after = (1 - tokens) / refill_rate
```

No background timer, no per-tick work — the state is updated only when a request arrives.

## 4. High-level design

```diagram
   client ──► ┌──────────────────────────────────────┐
              │           EDGE / GATEWAY             │
              │  ┌────────────────────────────────┐  │
              │  │ 1. resolve rules for request   │  │
              │  │    (from local rule cache)     │  │
              │  │ 2. check LOCAL token cache     │  │──┐
              │  │ 3. if needed, check Redis      │  │  │
              │  └────────────────────────────────┘  │  │
              └──────────────┬───────────────────────┘  │
                             │ allowed                  │ 429
                             ▼                          ▼
                       upstream service            client

              ┌─────────────────────────────────┐
              │  Redis cluster (sharded by key) │  counters
              └─────────────────────────────────┘
              ┌─────────────────────────────────┐
              │  Config service → rules         │  pushed to
              └─────────────────────────────────┘  edge, cached
```

**Where to enforce:** at the edge/gateway. A rejected request should cost as little as possible — one rejected after a database round trip has already consumed the resources you were protecting.

## 5. Deep dive — distributed counters

This is the heart of the question.

### The atomicity requirement

With 50 gateway instances, `GET` then `SET` is a race — two instances read 99, both allow, both write 100. The check-and-decrement must be **atomic**.

Redis is single-threaded per shard, so a Lua script executes atomically:

```diagram
   -- KEYS[1]=bucket  ARGV: now, rate, capacity, requested
   local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
   local tokens = tonumber(b[1]) or ARGV[3]
   local ts     = tonumber(b[2]) or ARGV[1]

   tokens = math.min(ARGV[3], tokens + (ARGV[1]-ts) * ARGV[2])

   local allowed = 0
   if tokens >= tonumber(ARGV[4]) then
     tokens = tokens - ARGV[4]; allowed = 1
   end

   redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', ARGV[1])
   redis.call('EXPIRE', KEYS[1], 3600)      -- self-cleaning
   return {allowed, tokens}
```

**One round trip, atomic, self-expiring.** The `EXPIRE` matters at scale: inactive clients' counters vanish on their own, so memory tracks *active* clients rather than all clients ever seen.

### The latency problem

Even at 0.5 ms, a synchronous Redis call on every request is significant when your p50 API latency is 20 ms — and it makes Redis a hard dependency of every request.

**Two-tier counting** solves it:

```diagram
   Each gateway keeps a LOCAL bucket holding a share of the quota.

   1. Serve from the local bucket → no network call at all
   2. When local tokens run low, fetch a BATCH from Redis
      ("give me 50 tokens") in one round trip
   3. Return unused tokens periodically / on shutdown
```

Now Redis is hit once per ~50 requests instead of every request. Throughput requirement drops from 3M ops/s to ~60K, and typical added latency drops to roughly zero.

**The cost: brief overshoot.** A gateway holding 50 unspent tokens can serve them all instantly. With N gateways, worst-case overshoot is N × batch_size. Tune batch size against how strict the limit must be — and *say* that out loud:

:::goat The exactness tradeoff
"There's a real tradeoff here. Checking Redis on every request is exact but adds a network round trip to every API call and makes Redis a hard dependency. Batching token grants locally removes almost all of that latency, at the cost of overshoot bounded by gateway count times batch size. For abuse prevention, where limits are approximate anyway, I'd batch. For a hard cost-control limit against an expensive downstream — say a per-customer LLM quota — I'd check centrally and accept the latency, because there the whole point is not exceeding the number."

Same problem, two answers, chosen by requirement. That's the reasoning being scored.
:::

### Sharding

Shard by the **rate limit key** (`user:123:endpoint:/search`). Same key always hits the same shard, so no cross-shard coordination is ever needed — a rare and pleasant property.

Use [consistent hashing](../02-building-blocks/consistent-hashing.html) so adding shards doesn't remap everything. Since counters are ephemeral and short-lived, losing some during a rebalance is harmless — briefly, a few clients get a fresh allowance. That tolerance is worth naming: it means you can rebalance aggressively without a migration plan.

### Hot keys

A single very high-volume client (a large enterprise tenant, or an attacker) concentrates on one shard. Mitigations: shard that client's counter into `key:0`…`key:9` with the quota split across them, and rely on the local-batch tier which already absorbs most of the traffic for exactly the clients who send the most.

## 6. Failure modes

**The question you will be asked: what if Redis is down?**

```diagram
   FAIL OPEN                        FAIL CLOSED
   allow all traffic through        reject everything
   ✓ API stays up                   ✓ downstream protected
   ✗ no protection during the       ✗ total outage caused by
     outage — an attack lands         the protective component
```

**The answer is "it depends, and here's on what":**

- **Abuse prevention → fail open.** The limiter exists to protect against a *possible* attack; failing closed guarantees an outage to prevent a hypothetical one. Bad trade.
- **Cost control / hard quota → fail closed.** If exceeding the limit means unbounded spend or a contractual breach, rejecting is correct.
- **Best of both: degrade to local-only limiting.** When Redis is unreachable, keep enforcing per-gateway limits from local state at `global_limit / gateway_count`. You lose global precision and keep meaningful protection. **This is the answer to give** — it refuses the false binary.

**Other failures:**

| Failure | Handling |
|---|---|
| One Redis shard down | Only keys on that shard degrade to local-only. Blast radius 1/N. |
| Config service down | Gateways use their cached rules. Config must never be a hot-path dependency. |
| Clock skew across gateways | Token refill uses *elapsed* time from a monotonic clock, not absolute timestamps — so skew doesn't matter. Worth saying; it's a real trap. |
| Gateway restart | Loses local tokens. Slight under-serving; self-corrects. Preferable to over-serving. |

## 7. Details that show experience

- **Don't count rejected requests** toward the limit, or a client that trips it can never recover within the window.
- **Jitter `Retry-After`**, or every throttled client retries in the same instant.
- **Ship in log-only mode first.** You will discover your "obviously safe" limit would have broken a major customer. This is the single most practically valuable thing to say.
- **Allow-list internal traffic** — health checks shouldn't consume quota.
- **Emit metrics per rule**: allowed, denied, and *near-limit* clients. Near-limit is the leading indicator that lets you talk to a customer before they're broken.
- **Separate read and write limits** — writes are more expensive and more abusable.

## 8. Follow-ups

- *"Global limits across regions?"* — cross-region coordination on the hot path costs 100 ms+, which defeats the purpose. Standard answer: per-region limits at 1/N of the global budget, accepting imprecision. If a true global limit is required, it must be an approximate one reconciled asynchronously.
- *"How do you handle a distributed attack from many IPs?"* — per-IP limiting fails by design here. You need behavioural detection and challenges (CAPTCHA/proof-of-work) at the edge; rate limiting alone is the wrong tool, and saying so is better than pretending otherwise.
- *"Can clients cheat?"* — anything client-side is advisory. Enforce server-side, and treat client-side limiting purely as a courtesy that helps well-behaved clients stay under.
