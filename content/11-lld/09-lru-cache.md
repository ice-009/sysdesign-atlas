---
title: Design an In-Memory Cache
summary: The data-structure flavoured round — an LRU cache with O(1) reads and writes, eviction and expiry behind interfaces, and how to make it thread-safe without one big lock.
difficulty: Medium
scope: LLD
tags: [lld-problem, data-structures, caching, concurrency]
prereqs: [design-patterns, concurrency-in-lld, caching]
unlocks: Building a small library-style component with clean interfaces and defensible costs.
---

"Implement an LRU cache" is a coding puzzle. "Design a caching library" is an LLD round: the same data structure, but now with a swappable eviction rule, expiry, statistics, a loader, and the threading question. Interviewers like it because it's small enough to finish and has a real algorithmic core.

A **cache** keeps recently used answers in memory so you don't have to recompute or refetch them. It's deliberately small, so something must be thrown out when it fills up. **LRU** — least recently used — means the thing you haven't touched for longest goes first.

## 1 · Requirements (0–4)

**Ask first:** a library inside one program, or a cache server? bounded by number of entries or by memory? do entries expire? is the eviction rule fixed?

Assume: in-process library, bounded by entry count, expiry supported, rule swappable.

**What it must do**
- `get(key)`, `put(key, value)`, `remove(key)`, `clear()`.
- Fixed capacity — when full, throw something out according to the rule.
- Optional expiry time per entry.
- Optional loader: on a miss, work the value out and keep it.
- Hit and miss counts, and a way to be told when something is evicted.

**Qualities that shape the design**
- `get` and `put` must be **O(1)** — constant time regardless of size. This is the point of the exercise.
- Safe for many threads at once, without funnelling everything through one lock.
- Adding a new eviction rule must not change the cache class.

## 2 · The core structure (4–14)

Here's the insight the problem exists to test.

- A **hash map** finds a key instantly, but knows nothing about order.
- A **linked list** can reorder instantly, but finding something means walking it.

So use both, and have the map point at nodes *inside* the list.

```diagram
   map: key → node                    doubly linked list, most recent first

   ┌──────────────┐         head (just used)              tail (evict me next)
   │ "a" → ●──────┼──▶ ┌──────┐   ┌──────┐   ┌──────┐   ┌──────┐
   │ "b" → ●──────┼──▶ │  a   │◀─▶│  d   │◀─▶│  c   │◀─▶│  b   │
   │ "c" → ●──────┼──▶ └──────┘   └──────┘   └──────┘   └──────┘
   │ "d" → ●──────┼──▶      ▲                                ▲
   └──────────────┘         │                                │
                       get("a") moved it here          thrown out first

   get(k):  look up in the map O(1) → unlink the node O(1) → put at front O(1)
   put(k):  insert at front; if too big, unlink the tail and drop it from the map
```

Why the list must be **doubly** linked: to remove a node from the middle in constant time you need to know the node before it. With a singly linked list, `get` becomes O(n) and the whole design falls apart. Say that — it's the one-line justification interviewers wait for.

```java
class Node<K, V> {
    K key; V value;                  // the key is stored so eviction can clean the map
    long expiresAtNanos;             // 0 = never
    Node<K, V> prev, next;
}
```

:::trap Why the node stores its own key
When you evict the tail you have a *node*, and you still need to delete the matching *map entry*. Without the key on the node you'd have to search the whole map — O(n), and the design collapses.

This is the most common bug in a hand-written LRU. Mentioning it before you're asked is a free point.
:::

## 3 · Interfaces (14–22)

```java
interface Cache<K, V> {
    Optional<V> get(K key);
    void put(K key, V value);
    void put(K key, V value, Duration ttl);
    void remove(K key);
    CacheStats stats();
}

/** Varies 1: which entry to throw out when full. */
interface EvictionPolicy<K> {
    void recordAccess(K key);        // called on every get and put
    void recordInsert(K key);
    Optional<K> evict();             // which key to remove
}

/** Varies 2: what counts as expired. */
interface ExpiryPolicy {
    boolean isExpired(CacheEntry<?> entry, Instant now);
}

/** Varies 3: what to do on a miss. */
interface CacheLoader<K, V> { V load(K key); }

/** Varies 4: who wants to know something was evicted. */
interface EvictionListener<K, V> { void onEvicted(K key, V value, EvictionCause cause); }
```

Now the rules become independent classes:

- **`LruPolicy`** — the linked list above. Using something moves it to the front; eviction takes from the back.
- **`LfuPolicy`** — least *frequently* used. Keep counts, and group keys by count so you can find the coldest in constant time. Mention that the naive version (a map of counts, scanned to find the smallest) is O(n).
- **`FifoPolicy`** — insertion order only. A plain queue.
- **`TinyLfuPolicy`** — if you want to sound current: a small sketch of what's been seen recently sits in front of an LRU and refuses to admit one-hit wonders. This is what the Caffeine library does. One sentence, no more.

**Say this:** *"The cache owns the storage and the map; the policy owns the ordering. Swapping LRU for LFU is a constructor argument, and the cache class never knows which it got."*

## 4 · Expiry — check on read, sweep in the background (22–28)

```java
Optional<V> get(K key) {
    Node<K, V> node = map.get(key);
    if (node == null) { stats.miss(); return loadIfPossible(key); }

    if (expiry.isExpired(node, clock.instant())) {     // checked when read
        removeInternal(node, EvictionCause.EXPIRED);
        stats.miss();
        return loadIfPossible(key);
    }
    policy.recordAccess(key);
    stats.hit();
    return Optional.of(node.value);
}
```

The design point, and it transfers everywhere: **expiry is checked when something is read, so correctness never depends on a timer having fired.** A background sweeper is then only an optimisation — it reclaims memory held by entries nobody reads — rather than something the design relies on. Say that split out loud.

The alternative worth naming: a queue ordered by expiry time, which evicts precisely but costs you a second ordering structure to maintain on every write. For a cache, checking on read plus random sampling (what Redis does) is the better trade.

## 5 · Making it thread-safe (28–36)

Start with the honest simple answer, then improve it. That sequence is itself the right way to answer.

**Level 1 — one lock.** `synchronized` on every method. Correct, easy to explain, and it funnels all traffic through a single gate. Fine at low concurrency; say you'd start here and measure.

**Level 2 — split it into segments.** Divide the keys into N independent buckets, each with its own map, list and lock. A key's bucket is decided by its hash. Now N threads working on different keys never wait for each other. The cost is that anything global — total size, overall eviction — spans buckets, so you cap capacity per bucket instead. This is how `ConcurrentHashMap` used to work and how most real caches still bound memory.

```java
class StripedCache<K, V> implements Cache<K, V> {
    private final Segment<K, V>[] segments;         // each: map + list + its own lock

    private Segment<K, V> segmentFor(K key) {
        return segments[spread(key.hashCode()) & (segments.length - 1)];
    }

    public Optional<V> get(K key) { return segmentFor(key).get(key); }   // one short lock
}
```

**Level 3 — the reading problem.** Even with segments, plain LRU turns **every read into a write**, because reading reorders the list. Readers end up fighting each other.

The production answer: **record reads into a buffer and apply them in batches**. A read appends to a lock-free ring buffer and returns immediately; one maintenance task drains the buffer and does the reordering. Recency becomes slightly approximate and throughput goes up enormously. That's what Caffeine does, and knowing it is a genuine differentiator.

:::goat The trade-off worth naming
An LRU's ordering doesn't have to be perfect. Evicting the third-least-recently-used instead of the very last one costs you a slightly lower hit rate — and nothing else.

So **trading precision for concurrency is nearly free here**, which is exactly why real caches sample, batch and approximate. Knowing which of your rules are hard (a seat is sold once) and which are soft (this entry is the coldest) is the judgement the whole round is testing.
:::

## 6 · Extensions

**"Bound it by memory, not entry count."**
> "Add a `Weigher` that sizes an entry; the cache tracks total weight and evicts until it's under the limit. Same structure, different accounting — and it's another injected interface rather than a change to the core."

**"Read-through caching."**
> "That's the `CacheLoader`. The subtlety is the **stampede**: a thousand simultaneous misses on the same key shouldn't cause a thousand loads. One load per key, with everyone else waiting on the same result — `computeIfAbsent` on a future does it."

**"Now make it distributed."**
> "Different problem, and I'd say so. The data structure stops being the interesting part; placement and invalidation become it. Consistent hashing to decide which node holds a key, and the hard question is invalidating copies. See [Distributed Cache](../case-studies/distributed-cache.html) — but I'd check the interviewer wants that zoom level first."

**"How would you test it?"**
> "Deterministic unit tests for the policy with an injected clock: put three entries, read the first, insert a fourth, assert the second was evicted. Then a threading test — many threads hammering overlapping keys, asserting size never exceeds capacity — run thousands of times."

:::exercise Write the eviction path from memory
Five minutes, no notes: what happens on `put` when the cache is full? Every step, in order, including the map entry, the list node, the stats and the listener.

(Insert node at the front → add to map → size++ → if over capacity: take `tail.prev` → unlink it → remove its key from the map → count an eviction → notify the listener.)
:::
