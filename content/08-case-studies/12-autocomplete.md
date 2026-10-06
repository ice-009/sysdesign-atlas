---
title: Design Search Autocomplete
summary: Sub-50ms suggestions at every keystroke — tries, precomputation, and the realization that the read path must never compute anything.
difficulty: Medium
scope: HLD
tags: [case-study, trie, cache, latency]
prereqs: [search, caching, indexing]
---

:::predict Guess first
1. Autocomplete fires as the user types. Is its request rate higher or lower than the number of actual searches?
2. Having found the node for "ca" in a trie, how would you get the ten most popular completions without searching everything beneath it?
3. Should a query typed by only one person ever appear as a suggestion?
:::

:::interview Why this question
The latency budget is brutal and it fires on **every keystroke**, so QPS is enormous relative to the product's actual usage. It's the clearest case study for the principle that **precomputation beats computation** — and it has a clean offline/online split that maps well onto real systems.
:::

## 1. Requirements

**Functional**
- As the user types, return the top *k* (say 10) completions for the prefix.
- Ranked by popularity, ideally personalized and location-aware.
- Reflects trending queries within hours.
- Filters offensive suggestions.

**Non-functional**
- **p99 under ~50 ms**, and ideally well under. Slower than typing speed makes the feature worse than useless.
- Enormous read volume — several requests per search.
- Eventually consistent is fine; a new trend appearing an hour later is acceptable.
- Availability: degrade to no suggestions rather than erroring.

**Clarifying questions:** How fresh must trending data be — minutes or hours? Personalized or global? Do we support typo tolerance and multi-language? What's the corpus — search queries, or a product catalog?

## 2. Estimation

**500M DAU**, 10 searches/day, ~20 characters typed per search (with debouncing, ~5 requests per search).

```diagram
   Requests: 500M × 10 × 5 / 10⁵ = 250,000 QPS avg
                                  → 750,000 QPS peak

   → 5× the volume of actual searches. This is the highest-QPS
     system in this curriculum, serving the smallest payloads.

   Corpus: ~1B distinct historical queries, but the useful set
           is far smaller — the top ~10M cover the vast majority
           of prefixes people actually type.

   Payload: 10 suggestions × ~30 B = 300 B per response
   Bandwidth: 750K × 300 B = 225 MB/s — trivial
```

**What this decided:** 750K QPS at 300 B means this is a pure **cache/memory serving problem**. Nothing may be computed at request time. And the corpus reduction (1B → 10M) is what makes it fit in memory.

## 3. The core insight

```diagram
   ONLINE (per keystroke, 750K QPS)
     prefix → LOOKUP → top 10        ← must be O(1), memory only

   OFFLINE (hourly batch)
     query logs → aggregate → rank → build the structure
                                      ← can take minutes
```

Everything expensive happens offline. The read path does a hash lookup and returns bytes. **If a candidate proposes traversing a trie and sorting children at request time, that's the mistake this question exists to catch.**

## 4. The data structure

### Trie with precomputed top-k

A **trie** (rhymes with "sky") is a tree where each step down spells out one more character, so everything under the node `ca` is a word starting with "ca". Finding a prefix therefore costs one step per letter typed, regardless of how many words you're storing.

That's the easy half. The hard half: having found the `ca` node, the *most popular* completions could be anywhere beneath it, and searching that whole subtree could mean visiting millions of nodes on every keystroke. Unacceptable.

**Store the answer at each node:**

```diagram
              (root)
                │
                c
                │
               ca ── top10: [cat, car, cake, camera, ...]
              /  \
            cat   car ── top10: [car, cars, career, ...]
             │
           cats ── top10: [cats, cats cafe, ...]

   Every node caches its own top-k, computed offline.
   Lookup = walk len(prefix) nodes, return the cached list.
```

Now a lookup is O(prefix length) with no subtree traversal — effectively constant time for realistic prefixes.

**Memory:** 10M queries averaging 20 characters, with top-10 lists at each node. Prefix sharing keeps node count well below character count; with the lists dominating, expect roughly tens of GB. That fits across a modest fleet, and it's worth noting that **the top-k lists cost far more than the trie structure itself** — an argument for storing top-k only at nodes shallow enough to be typed.

### The simpler alternative — say this too

```diagram
   A hash map from prefix → precomputed top-10 list.

   "ca" → [cat, car, cake, ...]
   "cat" → [cat, cats, cathedral, ...]

   Stored in Redis. Lookup is a single GET.
```

Slightly more memory (no prefix sharing) and dramatically simpler to build, shard, and operate. **For most systems this is the better engineering choice**, and proposing it while explaining that a trie saves memory through prefix sharing shows you're optimizing for the right thing.

:::goat Prefer the boring structure
"A trie with cached top-k at each node is the textbook answer, and it's memory-efficient because prefixes are shared. But a plain hash map from prefix to a precomputed list is simpler to build, trivially shardable by prefix hash, and serves from Redis with one GET. I'd start there and only move to a trie if memory became the binding constraint. The interesting engineering here isn't the data structure — it's the offline pipeline that builds it."

Choosing the simpler structure *for stated reasons* scores better than reciting the fancy one.
:::

## 5. The offline pipeline

```diagram
   search logs ──► Kafka
                     │
                     ▼
              ┌─────────────────┐
              │ Aggregate       │  count per query over a
              │ (hourly window) │  rolling window (e.g. 7 days,
              └────────┬────────┘  with recency weighting)
                       ▼
              ┌─────────────────┐
              │ Filter          │  offensive terms, PII,
              │                 │  single-user queries,
              └────────┬────────┘  min-frequency threshold
                       ▼
              ┌─────────────────┐
              │ Rank & build    │  compute top-k per prefix
              └────────┬────────┘
                       ▼
              ┌─────────────────┐
              │ Publish new     │  atomic swap via version
              │ version         │  pointer — never partial
              └─────────────────┘
```

**Atomic publishing matters.** Never mutate the live structure in place. Build version N+1 alongside N, verify it, then flip a pointer. This gives zero-downtime updates and instant rollback if the new version is bad — the same alias-swap pattern used for [search index](../02-building-blocks/search.html) rebuilds.

**Ranking is more than raw frequency:**
- **Recency weighting** — a query popular last week matters more than one popular last year. Exponential time decay.
- **Trending detection** — a sharp rise in rate matters more than absolute volume. A breaking news term should surface fast despite a small total count.
- **Click-through rate** — suggestions shown but never clicked should be demoted. This closes the loop between what you suggest and what's actually useful.
- **Minimum frequency threshold** — a query typed by one person must never become a suggestion. This is a **privacy requirement**, not an optimization: rare queries can contain personal information, and surfacing them leaks it. Raising this unprompted is a strong signal.

## 6. Serving architecture

```diagram
   ┌────────┐  debounced, ~50ms   ┌─────────┐   ┌──────────────┐
   │ client │────────────────────►│   CDN   │──►│ Suggest      │
   │(local  │                     │  edge   │   │ service      │
   │ cache) │◄────────────────────│ (cache) │   │ (in-memory)  │
   └────────┘                     └─────────┘   └──────┬───────┘
                                                       │
                                              ┌────────▼────────┐
                                              │ Sharded by      │
                                              │ prefix hash     │
                                              └─────────────────┘
```

**Four layers of caching, and each removes most of the remaining traffic:**

1. **Client-side.** Debounce input (~50 ms) so you don't fire on every keystroke, and cache locally — if the user types "ca" then "cat" then backspaces to "ca", that's served from memory. This alone cuts request volume substantially.
2. **CDN edge.** Prefixes are highly skewed — a small set of short prefixes covers most traffic, and they're identical for all users. A 60-second TTL at the edge absorbs the majority of requests. **This is the single biggest lever.**
3. **Service-local memory.** The structure lives in the process; no network hop to a datastore.
4. **Shard by prefix hash** so each node holds a subset and the working set fits.

**Personalization breaks edge caching**, which is the key tension. The resolution: serve the *global* suggestions from cache and merge a small personal list on the client from the user's own recent searches. You keep cacheability and get most of the perceived personalization — a genuinely good architectural answer.

## 7. Deep dives

### Typo tolerance

Users type "recieve". Exact prefix matching returns nothing, which feels broken.

Options, cheapest first:
- **Precompute common misspellings** into the map, pointing at the correct query. Cheap, covers the long tail of frequent errors, no runtime cost. **Usually the right answer.**
- **Edit-distance search** over the trie (fuzzy matching with a bounded distance). Correct and much more expensive — it breaks the O(1) read path.
- **Edge n-grams** in a [search engine](../02-building-blocks/search.html), which handles fuzziness natively at the cost of running that system.

Since the read path must stay trivial, precomputation wins again.

### Multi-word and mid-string matching

Users expect "pizza" to match "best pizza near me". Prefix-only matching misses it. Fix by indexing **suffixes at word boundaries**: index "best pizza near me" under "best…", "pizza…", and "near…". Multiplies index size by average word count — a real cost, and a decision to make deliberately.

### Localization

Suggestions differ by country and language. Shard the structure per locale and route on the request's locale. This multiplies memory by locale count, which is why you'd only materialize locales with real traffic and fall back to a global structure otherwise.

## 8. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| Suggest service down | **Return empty suggestions, never an error.** The search box must still work. This is graceful degradation at its simplest, and saying it is worth points. |
| Shard down | That prefix range loses suggestions; others unaffected. Replicate shards so this is rare. |
| Pipeline fails | The previous version keeps serving. Suggestions go stale rather than disappearing — which is exactly why you version and swap rather than mutate. |
| Bad data published | Roll back the version pointer instantly. Verification before the swap should catch it first. |
| Cold start after deploy | Load the structure into memory *before* accepting traffic. A node serving while loading returns empty results and looks broken. |

**Follow-ups:**
- *"How do you handle a sudden trending query?"* — the hourly pipeline is too slow. Add a fast path: a streaming job detecting rate spikes that injects entries into a small "trending" overlay merged at read time. Two-tier again — a slow exact layer plus a fast approximate one, same shape as the [ad click aggregator](ad-click-aggregator.html).
- *"Why not Elasticsearch?"* — it can do this with edge n-grams, and it's a reasonable answer for a smaller system. At 750K QPS with a 50 ms budget, a purpose-built in-memory structure is far cheaper and more predictable. Naming the crossover point is the good answer.
- *"How do you prevent suggestion manipulation?"* — bots typing a query repeatedly to make it a suggestion. Requires per-user deduplication, minimum distinct-user thresholds, and anomaly detection on rate spikes.
- *"Memory too large?"* — cap trie depth (nobody's suggestions matter past ~15 characters), store fewer suggestions at deep nodes, and drop queries below a frequency floor.

## Check yourself

```recall
Q: What is the core autocomplete principle?
A: Precomputation beats computation: an offline batch builds the answers, and the read path — hundreds of thousands of QPS within ~50 ms — only looks them up.

Q: Why does autocomplete have such high QPS?
A: It fires per keystroke: about 5 requests per search even with debouncing, so ~750,000 QPS at peak for tiny 300-byte responses — a pure memory-serving problem.

Q: How does a trie serve top-k quickly?
A: Each node stores its own precomputed top-k list, so a lookup walks prefix-length nodes and returns the cached list — no subtree traversal. The lists cost far more memory than the trie itself.

Q: What simpler structure often beats a trie?
A: A hash map from prefix to precomputed top-10 list in Redis: one GET, trivially shardable by prefix hash. Move to a trie only if memory binds.

Q: What goes into ranking suggestions?
A: Recency-weighted frequency, trending detection (rate of rise), click-through rate on shown suggestions, and a minimum distinct-user threshold — a privacy requirement, since rare queries can contain personal information.

Q: How is a new suggestion set published safely?
A: Build version N+1 beside N, verify it, then atomically swap a pointer — zero downtime and instant rollback.

Q: Name the four caching layers, and the biggest lever.
A: Client debounce plus local cache, CDN edge with a short TTL (the biggest lever, since short prefixes are shared by everyone), service-local memory, and shards by prefix hash.

Q: How do you personalise without breaking edge caching?
A: Serve global suggestions from cache and merge a small personal list from the user's recent searches on the client.
```

## What to carry forward

- Nothing is computed per keystroke: offline pipeline builds, online path looks up.
- A prefix → top-k map is usually better engineering than a trie.
- Rank by recency, trend and click-through; never surface single-user queries.
- Publish by atomic version swap; on failure, serve stale or empty, never errors.
- Cache at client, edge and process; merge personal results on the client.
