---
title: Bloom Filters & Probabilistic Structures
summary: Trading exactness for orders of magnitude less memory — Bloom filters, HyperLogLog, count-min sketch, and when approximation is the correct engineering answer.
difficulty: Medium
scope: HLD
tags: [bloom-filter, hyperloglog, sketch, memory]
prereqs: [caching, hardware-numbers]
---

:::predict Guess first
1. Storing a billion URLs exactly takes about 60 GB. How small could a structure be that answers "have I seen this URL?" with 1% error?
2. A Bloom filter says an item is "probably present". Can it ever say "definitely absent" for something you actually added?
3. How much memory do you need to count roughly how many distinct visitors a site had — whether it's a thousand or a billion?
:::

## The core trade

Three questions come up constantly: *have I seen this before?* (membership), *how many different things have I seen?* (cardinality), and *how often has this one appeared?* (frequency). Answering any of them exactly means keeping the data. Answering them **approximately, with a known and tunable error rate**, takes dramatically less space — often 100× to 1000× less.

The reason this is an engineering win rather than a compromise: **many questions don't need exactness.** "Roughly how many unique visitors?" and "has this URL definitely never been crawled?" are both perfectly answerable approximately, and the memory saved often decides whether the structure fits in RAM at all — which is the difference between microseconds and milliseconds.

Knowing when approximation is *acceptable* is the judgment being tested.

## Bloom filters

**Answers:** "Is X in the set?" with two possible outcomes — **definitely not**, or **probably yes**.

It never says "no" about something that's actually there (no **false negatives**), but it sometimes says "probably" about something that was never added (a **false positive**). That lopsidedness is exactly what makes it useful: a "definitely not" is trustworthy, so you can skip an expensive lookup on the strength of it.

**Structure:** a row of *m* bits, all starting at zero, plus *k* different hash functions that each turn an item into a position in that row.

```diagram
   ADD("apple"):  h1→3, h2→7, h3→11   set those bits to 1

   index:  0 1 2 3 4 5 6 7 8 9 10 11 12
   bits:   0 0 0 1 0 0 0 1 0 0  0  1  0

   QUERY("apple"): bits 3,7,11 all set → "probably present"
   QUERY("grape"): h1→2 → bit 2 is 0   → DEFINITELY ABSENT
   QUERY("mango"): h1→3, h2→7, h3→11 all set by other items
                   → "probably present"  ← FALSE POSITIVE
```

**Sizing** — worth memorizing, because interviewers ask for the number:

```diagram
   m = -(n × ln p) / (ln 2)²          bits needed
   k = (m / n) × ln 2                 optimal hash count

   For p = 1% false positive rate:  ≈ 9.6 bits per element
   For p = 0.1%:                     ≈ 14.4 bits per element
```

**About 10 bits per element for 1% error, regardless of element size.** That's the headline. One billion URLs — averaging 60 bytes each, so 60 GB stored exactly — fits in a **1.2 GB** Bloom filter. That's the difference between a distributed store and a single machine's RAM.

**Limitations to state:**
- **No deletions.** Clearing bits would create false negatives, since bits are shared. *Counting Bloom filters* (4-bit counters instead of bits) support deletion at 4× the space.
- **No enumeration.** You can't list the contents.
- **Fixed capacity.** Error rate degrades as you exceed the design *n*. *Scalable Bloom filters* chain progressively larger filters.

**Where they're used:**
- **[Cache penetration](caching.html) defense** — reject queries for keys that don't exist before touching the database.
- **[LSM-tree](../04-data/storage-engines.html) reads** — each SSTable has a Bloom filter, so a read skips files that definitely don't contain the key. This is the single most important use in practice; without it, LSM reads would check every level.
- **Web crawlers** — "have we seen this URL?" across billions of URLs.
- **CDNs** — "cache on second hit," to avoid storing one-hit-wonder objects.
- **Deduplication pre-filters** — cheap reject, then exact check on maybe-hits.

:::interview The correct usage pattern
A Bloom filter is a **cheap negative filter in front of an expensive exact check**, never a replacement for it. "I'd put a Bloom filter in front of the database for existence checks. A negative is definitive, so I reject immediately with no I/O. A positive means I do the real lookup — and 1% of those are wasted, which is a great trade against 60 GB of memory." That framing — false positives cost a lookup, not correctness — is the one to hold onto.
:::

## HyperLogLog

**Answers:** "How many *distinct* items have I seen?" with ~2% error in **12 KB**, regardless of whether the true count is a thousand or a billion.

Exact counting requires storing every distinct item — 1 billion 64-bit hashes is 8 GB. HLL does it in 12 KB. That's a ~700,000× reduction.

**The intuition:** hash each item and look at the leading zeros in the binary representation. Seeing a hash with 10 leading zeros is (probabilistically) evidence you've seen about 2¹⁰ distinct items, since roughly 1 in 1,024 random hashes starts that way. Tracking only the *maximum* run of leading zeros gives a rough estimate from almost no memory. HLL splits the hash space into thousands of independent buckets and combines their estimates harmonically to cut the variance.

**The property that makes it genuinely powerful:** HLL sketches are **mergeable**. Union two sketches by taking the element-wise maximum, and you get the cardinality of the union — no re-scanning. This means:

- Each server keeps its own sketch; merge them for a global count.
- Store one sketch per hour; merge 24 of them for a daily count, or 168 for a weekly count, with no reprocessing.

That composability is why it dominates analytics pipelines.

**Uses:** unique visitors, distinct search queries, unique viewers per video, cardinality estimation in query planners. Redis has it built in (`PFADD`/`PFCOUNT`).

**Don't use it when** the count must be exact — billing, compliance, or anything a customer will reconcile against their own records.

## Count-min sketch

**Answers:** "How many times have I seen X?" — with an over-estimate, never an under-estimate.

**Structure:** a 2D array of counters, *d* rows each with its own hash function.

```diagram
   INCREMENT(x): for each row i, counters[i][h_i(x)] += 1
   ESTIMATE(x):  min over rows of counters[i][h_i(x)]
```

Collisions only ever *inflate* a counter, so taking the **minimum** across rows discards rows where a collision occurred. The result is an upper bound with a tunable error.

**The killer application: heavy hitters.** Combine with a small heap to track the top-K items — trending hashtags, hot cache keys, the IPs sending the most traffic, the products viewed most. Doing this exactly requires a counter per distinct item (millions); the sketch does it in kilobytes.

Very relevant to [sharding hot spots](sharding.html): you need to *detect* a hot key before you can mitigate it, and count-min is the standard detector.

**Weakness:** rare items are relatively badly estimated (a collision with a heavy hitter dominates their count). It's designed for finding the big things, not for measuring the small ones.

## Others worth naming

- **Cuckoo filter** — like a Bloom filter but **supports deletion**, and is often smaller at low false-positive rates. The modern alternative when you need to remove items.
- **T-digest / DDSketch** — accurate **quantile** estimation (p99!) from a stream, and mergeable across servers. This is how monitoring systems compute a fleet-wide p99 without shipping every latency sample.
- **MinHash** — estimates *similarity* between sets (Jaccard index). Used for near-duplicate detection and content matching.
- **Top-K / SpaceSaving** — a dedicated heavy-hitter algorithm, often paired with count-min.

## Choosing

| Question | Structure | Memory |
|---|---|---|
| Is X in the set? | Bloom filter | ~10 bits/item at 1% error |
| Is X in the set, with deletes? | Cuckoo filter | Similar, slightly better |
| How many distinct items? | HyperLogLog | ~12 KB, ~2% error |
| How often did X occur? | Count-min sketch | KB, over-estimates |
| What are the top K? | Count-min + heap | KB |
| What's the p99? | T-digest | ~KB, mergeable |
| How similar are two sets? | MinHash | ~KB |

## When to say no

Approximation is wrong when a human will reconcile the number against something else. Billing, financial reporting, inventory, legal/compliance counts, and anything a customer sees next to a dollar sign need exact answers — the cost of "your invoice is within 2%" is not a memory cost.

A useful hybrid worth proposing: **approximate on the hot path, exact in batch.** Serve a real-time trending list from a count-min sketch, and recompute the authoritative daily numbers from the raw event log overnight. You get low-latency approximate answers *and* exact records, which is very often the right architecture.

:::exercise Size a filter
1. Derive the optimal number of hash functions for a Bloom filter with `m` bits and `n` elements. What is the resulting false-positive rate?
2. You need a 1% false-positive rate for 100M elements. How many bits per element, and how much total memory? Compare to storing the keys in a hash set.
3. An LSM tree uses a Bloom filter per SSTable to avoid disk reads. At a 1% FP rate and 10 SSTables, how many unnecessary disk reads per lookup of a missing key?
4. Why can you not delete from a Bloom filter? Name two structures that solve this and their costs.
5. Your filter is at 50% fill and the FP rate has exceeded target. What are your options, and what does each cost?
:::

:::paper Probabilistic membership
Burton Bloom's *Space/Time Trade-offs in Hash Coding with Allowable Errors* (CACM, 1970) is the original and is four pages long.

*Cuckoo Filter: Practically Better Than Bloom* (Fan et al., CoNEXT 2014) supports deletion and is often smaller at the same false-positive rate. For the wider family, *Sketching Algorithms* (Cormode's survey) covers HyperLogLog and Count-Min Sketch, which trade exactness for space the same way.
:::

## Check yourself

```recall
Q: What are a Bloom filter's two possible answers, and which can be wrong?
A: "Definitely not present" or "probably present". It never gives false negatives, but sometimes gives false positives, so a "no" is trustworthy and can skip an expensive lookup.

Q: About how many bits per element does a Bloom filter need for a 1% false-positive rate?
A: About 10 (9.6), whatever the element size — so a billion URLs fit in about 1.2 GB instead of 60 GB.

Q: Why can't you delete from a plain Bloom filter, and what can you use instead?
A: Bits are shared between items, so clearing one could create false negatives. Counting Bloom filters (4× the space) or cuckoo filters support deletion.

Q: What's the single most important real-world use of Bloom filters?
A: LSM-tree reads: each SSTable has a filter, so a lookup skips files that definitely don't contain the key instead of checking every level.

Q: What does HyperLogLog estimate, in how much memory, and what makes it so useful?
A: The number of distinct items — about 2% error in 12 KB, at any scale. Sketches merge by element-wise max, so per-server or per-hour sketches combine into global or weekly counts without rescanning.

Q: How does a count-min sketch estimate frequency, and which way is it wrong?
A: Each item increments one counter in each of several rows; the estimate is the minimum across rows. Collisions only inflate counters, so it over-estimates, never under-estimates.

Q: What is the classic use of a count-min sketch?
A: Heavy hitters: with a small heap it tracks the top-K items — trending tags, hot cache keys, noisiest IPs — in kilobytes. It's the standard hot-key detector.

Q: When is approximation the wrong answer, and what's the common hybrid?
A: Whenever someone reconciles the number — billing, finance, inventory, compliance. Hybrid: approximate on the hot path (a live trending list) and recompute exact numbers in batch from the raw log.
```

## What to carry forward

- Probabilistic structures trade a known, tunable error for 100–1000× less memory — often the difference between RAM and disk.
- A Bloom filter is a cheap negative filter in front of an exact check: about 10 bits per item for 1% error.
- HyperLogLog counts distinct items in 12 KB and merges across servers and time windows.
- Count-min sketches over-estimate frequency and find heavy hitters; t-digest estimates quantiles like p99.
- Never approximate numbers people reconcile; approximate live, compute exactly in batch.
