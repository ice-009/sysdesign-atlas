---
title: Rate Limiter — the Same Problem at Both Levels
summary: One question, two rounds. The class design of a rate-limiting library, and the two sentences that move the same answer to a fleet of servers.
difficulty: Medium
scope: Both
tags: [lld-problem, strategy, concurrency, hld-bridge]
prereqs: [lru-cache, rate-limiting]
unlocks: Answering a question that sits on the boundary at whichever level the interviewer wants.
---

**Rate limiting** means capping how often someone can call you — 100 requests a minute per user, say — so one client can't swamp the service or run up someone else's bill.

"Design a rate limiter" is the question most often answered at the wrong altitude. In an LLD round it means: *a library inside one service, with swappable algorithms and correct counting across threads*. In an HLD round it means: *a fleet of servers sharing one limit*. Ask which — then answer that one, and offer the other in a sentence at the end.

The [case study](../case-studies/rate-limiter.html) covers the distributed version properly. This page is the class design, plus the bridge.

## 1 · Requirements (0–4)

**What it must do**
- `tryAcquire(key, permits)` — allow or reject, immediately, without blocking.
- Limits configured per user, per API key, per endpoint, or globally.
- Several algorithms available.
- On rejection, tell the caller **when to try again** — not just "no".

**Qualities that shape the design**
- `tryAcquire` runs on every single request, so it must be O(1) and well under a millisecond.
- Safe under heavy concurrent load, without one global lock.
- Bounded memory: a million different keys must not mean unbounded growth.

## 2 · The interface (4–10)

```java
interface RateLimiter {
    /** Never blocks. A rejection is a normal result, not an exception. */
    RateLimitDecision tryAcquire(String key, int permits);
}

record RateLimitDecision(boolean allowed, long remaining, Duration retryAfter) { }
```

That return type is a deliberate choice worth one sentence: *"I return a small result object rather than a boolean, because the caller needs to send back 'how many you have left' and 'try again in N seconds' headers, and I'd rather work those out where the state lives than make the caller guess."*

## 3 · The algorithms (10–22)

Four of them, one interface. Know the trade-offs — this table is the part that gets marked.

| Algorithm | What it stores per key | Memory | Weakness |
|---|---|---|---|
| Fixed window | A count and when the window started | ~16 B | **Allows 2× the limit** across a window boundary |
| Sliding log | A timestamp per request | Grows with the limit | Exact, but expensive |
| Sliding counter | Two counts and a start time | ~24 B | Approximate, but close |
| Token bucket | Tokens left, and when last topped up | ~16 B | Allows a deliberate burst (often what you want) |
| Leaky bucket | A queue of waiting requests | Grows with the queue | Perfectly smooth, but adds delay |

**Token bucket** is the usual default, because it allows a controlled burst. Picture a bucket that refills at a steady rate; each request takes one token, and when it's empty you're rejected.

```java
class TokenBucketAlgorithm implements RateLimitAlgorithm {
    public RateLimitDecision check(KeyState s, int permits, Instant now, LimitConfig cfg) {
        // Lazy refill: no timer. Just work out what would have accumulated by now.
        long elapsedNanos = now.getNano() - s.lastRefillNanos();
        double refilled = elapsedNanos * cfg.permitsPerNano();
        double tokens = Math.min(cfg.capacity(), s.tokens() + refilled);

        if (tokens >= permits) {
            s.set(tokens - permits, now);
            return RateLimitDecision.allow((long) (tokens - permits));
        }
        double shortfall = permits - tokens;
        s.set(tokens, now);
        return RateLimitDecision.reject(Duration.ofNanos((long) (shortfall / cfg.permitsPerNano())));
    }
}
```

Two things to point at while writing this:

- **Nothing runs in the background.** The state is just "tokens left" and "when we last looked", and the refill is calculated on access. That's O(1), needs no scheduler, and costs nothing for a million idle keys. It's the same trick as expiry in the [cache](../11-lld/lru-cache.html) and holds in [seat booking](seat-booking.html).
- **The rejection carries a retry time**, worked out from the shortfall and the refill rate. That's why the algorithm builds the result rather than the caller.

**Fixed window** is worth implementing too, purely so you can name its flaw:

> "A limit of 100 a minute lets someone send 100 at 11:59:59 and another 100 at 12:00:00 — 200 requests in one second, right at the seam. The sliding counter fixes that cheaply by counting part of the previous window as well: `count = previous × (fraction of window remaining) + current`. It's an approximation, but it's two numbers instead of a list of timestamps."

## 4 · Per-key state, and bounding memory (22–30)

```java
class InMemoryRateLimiter implements RateLimiter {
    private final ConcurrentHashMap<String, KeyState> states = new ConcurrentHashMap<>();
    private final RateLimitAlgorithm algorithm;
    private final LimitResolver limits;        // key → which limit applies
    private final Clock clock;

    public RateLimitDecision tryAcquire(String key, int permits) {
        LimitConfig cfg = limits.resolve(key);
        KeyState state = states.computeIfAbsent(key, k -> KeyState.fresh(cfg, clock.instant()));
        synchronized (state) {                 // lock this key, not the whole map
            return algorithm.check(state, permits, clock.instant(), cfg);
        }
    }
}
```

Three deliberate decisions worth naming:

1. **`computeIfAbsent`, not "check then put".** The gap between checking and putting is a race. See [Threads and races](../11-lld/concurrency-in-lld.html).
2. **Lock the per-key object**, so two different users never wait for each other. One lock over the whole map would make the limiter the very bottleneck it exists to prevent.
3. **Bound the map.** A million keys at ~32 bytes is fine; unlimited growth from made-up keys is not. Evict idle ones — which is exactly the [cache](../11-lld/lru-cache.html) you just designed. *"An evicted key comes back with a full bucket, which is generous rather than strict. I'd rather occasionally allow a burst than wrongly reject a real user, and the window is short enough that it doesn't matter."* Saying which way an approximation errs is a strong habit.

## 5 · Where it sits (30–34)

```java
// A filter, so business code never knows rate limiting exists.
class RateLimitFilter implements Filter {
    public void doFilter(Request req, Response res, FilterChain chain) {
        String key = keyExtractor.extract(req);          // user id, API key, or IP address
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

Details that read as experience: **429, not 403** (403 means "never"; 429 means "not right now"); send the headers on successful responses too, so well-behaved clients can slow themselves down; and make key extraction an interface, because "per user when signed in, per IP otherwise" is a real requirement.

:::trap Fail open, or fail closed?
You will be asked. It depends on what the limiter protects.

*"For abuse protection I'd fail **open** — if the limiter itself breaks, rejecting everything turns a limiter outage into a total outage. For a paid quota or a safety limit, fail **closed**, because letting usage run free is the worse outcome. I'd make it a setting per limit, and alert loudly either way."*

Having a position, and making it depend on the purpose, is the whole point of the question.
:::

## 6 · Moving it to twenty servers (34–42)

If the interviewer scales it up, the class design survives — only **where the counter lives** changes. Say it in that order:

> "The algorithm, the key extraction, the result object and the filter are all unchanged. What changes is that the count can't live in one server's memory: twenty servers each allowing 100 a minute means an effective limit of 2,000. So the counter moves somewhere shared."

Then the three real options, each with its cost:

| Approach | How | What it costs |
|---|---|---|
| **One shared counter** (Redis) | Atomic increment, or a small script so read-and-write is one round trip | Half a millisecond per request, and Redis becomes a hard dependency |
| **Divide the limit** | Each server gets limit ÷ N and enforces it alone | No added delay; unfair when traffic is uneven, since an idle server's share is wasted |
| **Local, synced periodically** | Enforce locally, reconcile every few hundred milliseconds | Fast and roughly right; briefly too generous after a spike |

**The answer to give:** *"Redis with a script when the limit is a billing or safety boundary and must be exact. Local buckets with periodic syncing when it's abuse protection and being 10% over for 200 milliseconds is harmless. The question I'd ask to decide is: what does exceeding the limit actually cost us?"*

That last question is the senior move — it makes the trade-off about the business consequence rather than the technology. The full treatment is in [the case study](../case-studies/rate-limiter.html) and [Rate Limiting](../building-blocks/rate-limiting.html).

:::goat Why this is the perfect two-level rehearsal
Notice what crossed the boundary unchanged: the algorithm, the lazy refill, the question of which way the approximation errs, and the decision to bound memory. What changed was only *where the state lives* and *what it costs to read it*.

That's true of most systems — the logic travels, the placement of state is the design. If you can narrate this problem at both levels in five minutes each, you can handle an interviewer who zooms without warning.
:::

:::exercise Two minutes each
(a) Your limit is 10 a second and a client sends 10 in the first millisecond of every second — which algorithms allow that, and is it a bug? (b) A key hasn't been seen for an hour; what happened to its state, and is that safe? (c) Redis is down; what does `tryAcquire` return, and who decided that?
:::
