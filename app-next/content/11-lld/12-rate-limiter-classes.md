---
title: Rate Limiter — the Same Problem at Both Levels
summary: One prompt, two rounds. The class design of a rate-limiting library (algorithms behind a strategy, per-key state, thread safety), and the two-sentence pivot to the distributed version.
difficulty: Medium
tags: [lld-problem, strategy, concurrency, hld-bridge]
prereqs: [lru-cache, rate-limiting]
unlocks: Answering a boundary-straddling prompt at whichever altitude the interviewer wants, and switching cleanly on request.
---

"Design a rate limiter" is the prompt most likely to be interpreted at the wrong altitude. Asked in an LLD round it means: *a library inside one service, with pluggable algorithms and correct concurrent counters.* Asked in an HLD round it means: *a fleet of servers enforcing a shared limit.* Ask which — then answer the one they wanted, and offer the other in a sentence at the end.

The [HLD case study](../case-studies/rate-limiter.html) covers the distributed version in depth. This page is the class design, plus the bridge.

## 1 · Requirements (0–4)

**Functional**
- `boolean tryAcquire(key, permits)` — allow or reject, right now, with no blocking.
- Limits configured per key pattern: per user, per API key, per endpoint, or a global limit.
- Multiple algorithms available (fixed window, sliding window, token bucket, leaky bucket).
- On rejection, tell the caller **when to retry** — a `Retry-After`, not just a `false`.

**Non-functional**
- `tryAcquire` is O(1) and adds well under a millisecond — it's on every request's hot path.
- Thread-safe under high concurrency, without one global lock.
- Memory bounded: a million distinct keys must not mean unbounded growth.

## 2 · The interface (4–10)

```java
interface RateLimiter {
    /** Non-blocking. Never throws for the normal reject case. */
    RateLimitDecision tryAcquire(String key, int permits);
}

record RateLimitDecision(boolean allowed, long remaining, Duration retryAfter) {
    static RateLimitDecision allow(long remaining) { … }
    static RateLimitDecision reject(Duration retryAfter) { … }
}
```

That return type is a deliberate design choice worth one sentence: *"I return a decision object rather than a boolean, because the caller needs `X-RateLimit-Remaining` and `Retry-After` headers, and I'd rather compute them where the state lives than make the caller guess."*

## 3 · Algorithms behind a strategy (10–22)

Four algorithms, one interface. Know the tradeoffs — this table is the part of the answer that gets graded.

| Algorithm | State per key | Memory | Boundary burst | Smoothness |
|---|---|---|---|---|
| Fixed window | count + window start | 16 B | **2× at the seam** | Poor |
| Sliding window log | timestamp per request | O(limit) | None | Exact |
| Sliding window counter | 2 counts + start | 24 B | Small | Good |
| Token bucket | tokens + last refill | 16 B | Allows a deliberate burst | Good |
| Leaky bucket (queue) | queue of requests | O(queue) | None — shapes output | Perfect, but adds latency |

```java
interface RateLimitAlgorithm {
    RateLimitDecision check(KeyState state, int permits, Instant now, LimitConfig config);
}
```

**Token bucket** — the default, because it allows a controlled burst, which is what most APIs actually want:

```java
class TokenBucketAlgorithm implements RateLimitAlgorithm {
    public RateLimitDecision check(KeyState s, int permits, Instant now, LimitConfig cfg) {
        // Lazy refill: no timer, just compute what would have accrued since last touch.
        long elapsedNanos = now.getNano() - s.lastRefillNanos();
        double refilled = elapsedNanos * cfg.permitsPerNano();
        double tokens = Math.min(cfg.capacity(), s.tokens() + refilled);

        if (tokens >= permits) {
            s.set(tokens - permits, now);
            return RateLimitDecision.allow((long) (tokens - permits));
        }
        double deficit = permits - tokens;
        s.set(tokens, now);
        return RateLimitDecision.reject(Duration.ofNanos((long) (deficit / cfg.permitsPerNano())));
    }
}
```

Two things to point at while writing this:

- **Lazy refill.** No background thread adding tokens. State is `(tokens, lastRefillTime)` and the refill is computed on access — the same lazy-evaluation trick as expiry in the [cache](lru-cache.html) and holds in [seat booking](seat-booking.html). It's O(1), needs no scheduler, and works for a million idle keys.
- **The rejection carries a retry time**, computed from the deficit and the refill rate. That's why the algorithm — not the caller — builds the decision.

**Fixed window** is worth implementing too, purely so you can name its flaw out loud:

> "A limit of 100/minute lets a client send 100 at 11:59:59 and 100 at 12:00:00 — 200 requests in one second, right at the seam. Sliding window counter fixes it cheaply by weighting the previous window: `count = prev × (1 − elapsedFraction) + current`. That's an approximation, but it's two counters instead of a list of timestamps."

## 4 · Per-key state, and bounding memory (22–30)

The structure everything hangs off:

```java
class InMemoryRateLimiter implements RateLimiter {
    private final ConcurrentHashMap<String, KeyState> states = new ConcurrentHashMap<>();
    private final RateLimitAlgorithm algorithm;
    private final LimitResolver limits;        // key → LimitConfig (per-user, per-endpoint…)
    private final Clock clock;

    public RateLimitDecision tryAcquire(String key, int permits) {
        LimitConfig cfg = limits.resolve(key);
        KeyState state = states.computeIfAbsent(key, k -> KeyState.fresh(cfg, clock.instant()));
        synchronized (state) {                 // lock the key, not the map
            return algorithm.check(state, permits, clock.instant(), cfg);
        }
    }
}
```

Three deliberate decisions, each worth naming:

1. **`computeIfAbsent`, not `containsKey` + `put`.** Check-then-act is the race. (See [Concurrency in LLD](concurrency-in-lld.html).)
2. **Lock the per-key state object**, so two different users never contend. A single lock over the map would make the limiter itself the bottleneck it exists to prevent. The alternative — an all-atomic `KeyState` with a CAS loop — is faster still and worth mentioning as the next step.
3. **Bound the map.** A million keys × 32 B is fine; unbounded growth from spoofed keys is not. Evict idle keys — which is exactly the [LRU cache](lru-cache.html) you just designed, or a `Caffeine` cache with expiry-after-access longer than the window. *"An evicted key resets to full tokens, which is permissive rather than restrictive — I'd rather occasionally allow a burst than reject a legitimate user, and the window is short enough that it doesn't matter."* Naming which way an approximation errs is a strong habit.

## 5 · Where it sits (30–34)

```java
// A filter/interceptor, so business code never knows rate limiting exists.
class RateLimitFilter implements Filter {
    public void doFilter(Request req, Response res, FilterChain chain) {
        String key = keyExtractor.extract(req);          // user id, API key, or IP
        RateLimitDecision d = limiter.tryAcquire(key, 1);

        res.setHeader("X-RateLimit-Remaining", String.valueOf(d.remaining()));
        if (!d.allowed()) {
            res.setHeader("Retry-After", String.valueOf(d.retryAfter().toSeconds()));
            res.setStatus(429);                          // Too Many Requests
            return;
        }
        chain.doFilter(req, res);
    }
}
```

Details that read as experience: **429, not 403** (403 means "never"; 429 means "not now"); the headers on *allowed* responses too, so well-behaved clients can self-throttle; and a `KeyExtractor` interface, because "per user when authenticated, per IP otherwise" is a real requirement and another axis.

:::trap Fail open or fail closed?
You will be asked. The answer depends on what the limiter protects. *"For abuse protection I'd fail **open** — if the limiter itself is broken, rejecting all traffic converts a limiter outage into a total outage. For a paid-quota or safety limit, fail **closed**, because allowing unlimited usage is the worse failure. I'd make it a config flag with a per-limit default, and alert loudly either way."* Having a position, and making it depend on the purpose, is the whole point of the question.
:::

## 6 · The pivot to distributed (34–42)

If the interviewer says "now we have 20 servers", the class design survives — only the **state store** changes. Say it in that order:

> "The algorithm, the key extraction, the decision object, and the filter are unchanged. What changes is that `KeyState` can't live in one heap: 20 servers each allowing 100/min means an effective limit of 2,000. So the counter moves to shared state."

Then the three real options, with the tradeoff attached to each:

| Approach | How | Cost |
|---|---|---|
| **Centralised counter** (Redis) | Atomic `INCR`+`EXPIRE`, or a Lua script for token bucket so read-modify-write is one round trip | +0.5–1 ms per request; Redis is now a hard dependency on the hot path |
| **Local quota** | Each server gets limit/N, enforced locally | Zero latency; unfair when load is skewed — an idle server's quota is wasted |
| **Local + async sync** | Enforce locally, reconcile with a shared store every few hundred ms | Fast and roughly correct; briefly over-permissive after a spike |

**The answer to give:** *"Redis with a Lua script for exactness when the limit is a billing or safety boundary; local buckets with periodic sync when it's abuse protection and being 10% over for 200 ms is harmless. The question I'd ask to choose is: what does exceeding the limit actually cost?"*

That last question is the senior move — it makes the tradeoff about the business consequence rather than the technology. For the full treatment (Redis scripts, sharding by key, the sidecar pattern, and the client-side story), see [the rate limiter case study](../case-studies/rate-limiter.html) and [Rate Limiting](../building-blocks/rate-limiting.html).

:::goat Why this problem is a perfect two-level rehearsal
Notice what carried across the boundary unchanged: the algorithm, the lazy refill, the "which way does the approximation err" question, and the decision to bound memory. What changed was only *where the state lives* and *what it costs to read it*. That's true of most systems — the logic is portable, the state placement is the design. If you can narrate this problem at both levels in five minutes each, you can handle the interviewer who zooms without warning.
:::

:::exercise Two minutes each
(a) Your limit is 10/second and a client sends 10 requests in the first millisecond of every second — which algorithms allow it, and is that a bug? (b) A key hasn't been seen in an hour; what happened to its state, and is that safe? (c) Your Redis is down; what does `tryAcquire` return, and who decided that?
:::
