---
title: Design an In-Memory Cache
summary: The data-structure-flavoured LLD round — O(1) LRU with a hash map and a doubly linked list, eviction and expiry behind interfaces, and how to make it thread-safe without one global lock.
difficulty: Medium
tags: [lld-problem, data-structures, caching, concurrency]
prereqs: [design-patterns, concurrency-in-lld, caching]
unlocks: Building a small library-style component with clean interfaces and defensible complexity.
---

"Design an LRU cache" is a LeetCode problem. "Design a caching library" is an LLD round: the same data structure, but now with eviction policy behind an interface, expiry, statistics, a loader, and the concurrency question. Interviewers use it because it's small enough to finish and has a real algorithmic core.

## 1 · Requirements (0–4)

**Ask first:** is this a single-process library or a cache server? bounded by entries or bytes? do we need TTL? is eviction policy fixed?

Assume: an in-process library, bounded by entry count, TTL supported, policy pluggable.

**Functional**
- `get(key)`, `put(key, value)`, `remove(key)`, `clear()`.
- Bounded capacity — on overflow, evict by policy (LRU default).
- Optional per-entry TTL.
- Optional read-through loader: on a miss, compute the value and cache it.
- Hit/miss/eviction statistics, and eviction listeners.

**Non-functional**
- `get` and `put` are **O(1)** — this is the point of the exercise.
- Thread-safe with concurrent readers and writers, without serialising everything on one lock.
- Adding a policy (LFU, FIFO) must not change the cache class.

## 2 · The core structure (4–14)

The insight the problem exists to test: **a hash map gives O(1) lookup but no order; a linked list gives O(1) reordering but no lookup. Use both, and have the map point at list nodes.**

```diagram
   map: key → node                    doubly linked list (recency order)

   ┌──────────────┐         head (most recent)              tail (LRU victim)
   │ "a" → ●──────┼──▶ ┌──────┐   ┌──────┐   ┌──────┐   ┌──────┐
   │ "b" → ●──────┼──▶ │  a   │◀─▶│  d   │◀─▶│  c   │◀─▶│  b   │
   │ "c" → ●──────┼──▶ └──────┘   └──────┘   └──────┘   └──────┘
   │ "d" → ●──────┼──▶      ▲                                ▲
   └──────────────┘         │                                │
                       get("a") moved it here          evicted first

   get(k):  map lookup O(1) → unlink node O(1) → push to head O(1)
   put(k):  insert at head; if size > capacity, unlink tail and drop from map
```

Why a *doubly* linked list: removing a node from the middle in O(1) requires knowing its predecessor. Singly linked would make `get` O(n). Say that — it's the one-line justification interviewers wait for.

```java
class Node<K, V> {
    K key; V value;                  // key is stored so eviction can remove from the map
    long expiresAtNanos;             // 0 = never
    Node<K, V> prev, next;
}

class LinkedHashRing<K, V> {         // the intrusive list, with sentinel head/tail
    private final Node<K, V> head = new Node<>(), tail = new Node<>();

    void moveToFront(Node<K, V> n) { unlink(n); pushFront(n); }
    Node<K, V> evictionCandidate()  { return tail.prev == head ? null : tail.prev; }
}
```

:::trap Why the node stores its key
When you evict the tail, you have a *node* and you need to delete the corresponding *map entry*. Without the key on the node you'd have to scan the map — O(n), and the whole design collapses. This is the most common bug in a hand-written LRU, and mentioning it unprompted is a free point.
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

/** Axis 1: which entry to drop when full. */
interface EvictionPolicy<K> {
    void recordAccess(K key);        // called on get and on put
    void recordInsert(K key);
    Optional<K> evict();             // which key to remove; policy owns its own ordering
}

/** Axis 2: what "expired" means. */
interface ExpiryPolicy {
    boolean isExpired(CacheEntry<?> entry, Instant now);
}

/** Axis 3: what to do on a miss (read-through). */
interface CacheLoader<K, V> { V load(K key); }

/** Axis 4: who cares that something was evicted. */
interface EvictionListener<K, V> { void onEvicted(K key, V value, EvictionCause cause); }
```

Now the policies are independent classes:

- **`LruPolicy`** — the linked list above; access moves to front, evict from tail.
- **`LfuPolicy`** — frequency counts with buckets by count; evict from the lowest non-empty bucket. Mention that a naive `Map<K, Integer>` + scan is O(n) and the bucketed version keeps it O(1).
- **`FifoPolicy`** — insertion order only; a plain queue.
- **`TinyLfuPolicy`** — if you want to sound current: an admission filter (a small count-min sketch) in front of an LRU, which is what Caffeine does. One sentence, no more.

**Say this:** *"The cache owns storage and the hash map; the policy owns ordering. Swapping LRU for LFU is a constructor argument, and the cache class doesn't know which it has."*

## 4 · Expiry — lazy plus a sweeper (22–28)

```java
Optional<V> get(K key) {
    Node<K, V> node = map.get(key);
    if (node == null) { stats.miss(); return loadIfPossible(key); }

    if (expiry.isExpired(node, clock.instant())) {     // lazy: checked on read
        removeInternal(node, EvictionCause.EXPIRED);
        stats.miss();
        return loadIfPossible(key);
    }
    policy.recordAccess(key);
    stats.hit();
    return Optional.of(node.value);
}
```

The design point, which transfers to [seat booking](seat-booking.html) and everywhere else: **expiry is evaluated on read, so correctness never depends on a timer firing.** A background sweeper is then an optimisation — it reclaims memory held by entries nobody reads — not a correctness requirement. State that split explicitly.

The alternative worth naming: a `DelayQueue` or a min-heap by expiry time, which gives precise eviction at the cost of a second ordering structure to maintain on every write. For a cache, lazy plus sampling (what Redis does — random sample, delete the expired ones) is the better tradeoff.

## 5 · Thread safety (28–36)

Start with the honest simple answer, then improve it — that sequence is itself the right way to answer:

**Level 1 — one lock.** `synchronized` on every method. Correct, trivially explainable, and it serialises all traffic through one monitor. Fine for low concurrency; say that you'd start here and measure.

**Level 2 — striped locks.** Partition the key space into N segments, each with its own map, list, and lock. `lock = locks[hash(key) % N]`. Concurrency scales with N; the cost is that global operations (`size()`, total-capacity eviction) span segments, so bound capacity **per segment**. This is how `ConcurrentHashMap` worked pre-Java 8 and how most real caches still bound memory.

```java
class StripedCache<K, V> implements Cache<K, V> {
    private final Segment<K, V>[] segments;         // each: map + list + its own lock

    private Segment<K, V> segmentFor(K key) {
        return segments[(spread(key.hashCode())) & (segments.length - 1)];
    }

    public Optional<V> get(K key) { return segmentFor(key).get(key); }   // one lock, held briefly
}
```

**Level 3 — the read-path problem.** Even with striping, plain LRU makes *every read a write* (it reorders the list), so readers contend. The production answer: **buffer the access records and replay them in batches**. Reads append to a lock-free ring buffer and return immediately; a single maintenance task drains the buffer and applies the reordering. Recency becomes slightly approximate, throughput goes up by an order of magnitude. That's what Caffeine does, and knowing it is a genuine differentiator.

:::goat The tradeoff to name out loud
An LRU cache's ordering does not have to be exact. Evicting the 3rd-least-recently-used instead of the very least costs you a marginally lower hit rate — and nothing else. So **trading precision for concurrency is nearly free here**, which is exactly why real caches sample, batch, and approximate. Recognising which of your invariants are hard (a seat is sold once) and which are soft (this entry is the coldest) is the judgement the whole round is testing.
:::

## 6 · Extensions

**"Size by bytes, not entries."**
> "A `Weigher<K,V>` interface; the cache tracks total weight and evicts until it's under the limit. Same structure, different accounting — and it's another injectable axis rather than a change to the core."

**"Read-through and write-through."**
> "Read-through is the `CacheLoader` above. The subtlety is the **thundering herd**: 1,000 concurrent misses on the same key shouldn't trigger 1,000 loads. Per-key single-flight — `ConcurrentHashMap.computeIfAbsent` on a future — so one thread loads and the rest await the same result."

**"Now make it distributed."**
> "Different problem, and I'd say so: the data structure stops being the interesting part and partitioning, replication, and invalidation become it. Consistent hashing for placement, and the hard question is invalidation across nodes. See [Distributed Cache](../case-studies/distributed-cache.html) — but I'd confirm the interviewer wants that zoom level first."

**"How do you test it?"**
> "Deterministic unit tests for the policy with an injected clock — put three entries, access the first, insert a fourth, assert the second was evicted. Then a concurrency test: N threads hammering get/put on overlapping keys with an assertion that size never exceeds capacity, run for thousands of iterations."

:::exercise Write the eviction path from memory
Five minutes, no notes: `put` on a full cache. Every step, in order, including what happens to the map entry, the list node, the stats, and the listener. (Insert node at head → map.put → size++ → if size > capacity: node = tail.prev → unlink → map.remove(node.key) → stats.eviction() → listener.onEvicted(SIZE).)
:::
