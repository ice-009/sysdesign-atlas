---
title: Design a Web Crawler
summary: Politeness, frontier management, and deduplication at a scale where "have I seen this URL?" is itself a hard systems problem.
difficulty: Medium
scope: HLD
tags: [case-study, crawler, bloom-filter, queue]
prereqs: [message-queues, bloom-filters, rate-limiting]
---

:::interview Why this question
It's a distributed producer-consumer system where the interesting constraints are **external and social** — you must not overwhelm the sites you crawl. It's also the best natural home for [Bloom filters](../02-building-blocks/bloom-filters.html), and it has a subtle prioritization problem.
:::

## 1. Requirements

**Functional**
- Start from seed URLs, fetch pages, extract links, repeat.
- Store page content for downstream indexing.
- Respect `robots.txt` and crawl-delay directives.
- Recrawl pages periodically, more often for pages that change often.
- Avoid crawling the same content twice.

**Non-functional**
- **Politeness** — never overwhelm a single domain. This is a hard constraint, not a nicety.
- Scale: billions of pages.
- Robust to hostile input: crawler traps, infinite URL spaces, enormous files, malformed HTML.
- Extensible — the same pipeline should support different content types.

**Clarifying questions:** How many pages, and over what period? Is freshness important, or is this a one-time crawl? Do we need JavaScript rendering (dramatically more expensive)? Content types beyond HTML?

## 2. Estimation

**1B pages/month**, average page 500 KB (HTML plus assets we don't fetch — HTML alone ~100 KB).

```diagram
   Rate: 10⁹ / (30 × 10⁵ s) = ~400 pages/s sustained
         with peaks and retries → ~1,000 pages/s

   Bandwidth: 1,000 × 100 KB = 100 MB/s ingest (~800 Mbps)

   Storage:
     raw HTML compressed ~20 KB × 10⁹ = 20 TB/month
     with a few months retained → ~100 TB

   URL frontier: ~10B known URLs
     Storing them exactly: 10¹⁰ × 60 B = 600 GB
     → too large for memory. This is the design's key problem.

   Bloom filter for "seen": 10¹⁰ × 10 bits = 12.5 GB
     → fits in memory across a few nodes ✓
```

**What this decided:** the "have I seen this URL?" check happens for every extracted link — hundreds of thousands per second — and the exact set doesn't fit in memory. This is what makes a Bloom filter the right tool rather than a clever optimization.

## 3. High-level design

```diagram
   ┌──────────────────────────────────────────────────────┐
   │                   URL FRONTIER                       │
   │  priority queues × per-domain queues                 │
   │  (politeness + priority enforced here)               │
   └───────────────────────┬──────────────────────────────┘
                           ▼
                  ┌─────────────────┐
                  │ Fetcher workers │  DNS → HTTP GET
                  │  (many, async)  │  with timeouts
                  └────────┬────────┘
                           ▼
                  ┌─────────────────┐
                  │ Content store   │  raw HTML → object storage
                  └────────┬────────┘
                           ▼
                  ┌─────────────────┐
                  │ Parser          │  extract links, text,
                  │                 │  metadata
                  └────────┬────────┘
                           ▼
              ┌────────────────────────┐
              │ URL filter & dedup     │  robots · Bloom filter
              │                        │  · normalization
              └────────────┬───────────┘
                           │ new URLs
                           └──────────► back to the FRONTIER
```

It's a cycle, and the frontier is where all the intelligence lives.

## 4. Deep dive — the frontier and politeness

This is the heart of the question.

**The constraint:** you may hit `example.com` at most once every *N* seconds (respecting its crawl-delay), regardless of how many URLs from that domain you have queued. Meanwhile you want to keep thousands of workers busy.

**The two-layer queue design:**

```diagram
   FRONT QUEUES — prioritization
     Q1 (high priority: news, frequently-changing)
     Q2 (medium)
     Q3 (low)
       │ a selector picks from these by weighted policy
       ▼
   BACK QUEUES — politeness
     one queue PER DOMAIN
     b1: example.com    b2: wikipedia.org    b3: ...

     A worker is assigned a back queue. It fetches one URL,
     then waits the required delay before the next from
     that same queue.

   A mapping table routes each domain to exactly one back queue,
   which guarantees only one worker is ever hitting a domain.
```

**Why two layers:** the front queues decide *what's important*; the back queues decide *what's polite*. Separating them means you can prioritize aggressively without ever violating a rate limit — and one busy domain can't starve everything else, because workers pull from other back queues meanwhile.

:::goat Politeness is the design constraint
"The naive design is one big queue of URLs and a pool of workers. That breaks politeness immediately — a site with a million pages would have every worker hammering it simultaneously, which gets you blocked and is genuinely abusive. So the frontier needs per-domain queues with one worker assigned per domain at a time, and a delay enforced between fetches. Prioritization happens in a separate layer feeding those queues."

Recognizing that the external social constraint *shapes the architecture* is what this question tests.
:::

**Domain-level state** — `robots.txt` (cached with a TTL), crawl delay, last-fetch time, and error rate — lives in a store keyed by domain and is consulted before every fetch.

## 5. Deep dive — deduplication

Three distinct deduplication problems, and only the first is obvious.

**1. URL deduplication.** Has this URL been seen?

```diagram
   Normalize first — this matters more than the data structure:
     lowercase host, strip default ports, resolve ./ and ../,
     sort or strip tracking query params, remove fragments (#),
     decide on trailing-slash policy

   http://Example.com:80/a/../b/?utm_source=x#top
     → http://example.com/b

   Then: Bloom filter (12.5 GB for 10B URLs at 1% FP)
     - "definitely not seen"  → crawl it
     - "probably seen"        → check the exact store, or just skip
```

The 1% false-positive rate means we occasionally skip a page we haven't crawled. **That's an acceptable loss** for a web crawler — there are always more pages — and stating that tradeoff explicitly is the point of using the filter. If it weren't acceptable, you'd do an exact lookup on positives.

**2. Content deduplication.** Different URLs, identical content — mirrors, print versions, session-ID variants. Hash the normalized content (a checksum of the extracted text, not the raw HTML, since ads and timestamps differ) and skip duplicates.

**3. Near-duplicate detection.** Pages that differ only in a sidebar or timestamp. **SimHash** or MinHash produces fingerprints where similar documents have similar hashes, so you can detect near-duplicates without pairwise comparison. Worth naming — it's the standard tool and shows breadth.

## 6. Deep dive — traps and hostile input

The web is adversarial, and listing these unprompted reads as experience:

- **Infinite URL spaces.** A calendar with "next month" links forever, or faceted-search URLs with combinatorial parameters. Defenses: cap crawl depth, cap URLs per domain, detect repeating path patterns (`/a/b/a/b/a/b`), and monitor the ratio of new URLs to useful content per domain.
- **Enormous files.** Set a max content-length and stream with a hard cap; a worker downloading a 10 GB file is a worker lost.
- **Slow servers.** Aggressive connection and read timeouts. A slow site must not hold a worker for a minute.
- **Redirect loops.** Cap redirect chains (~5) and detect cycles.
- **Malformed HTML.** Parsers must never crash on input; treat parsing as untrusted-input handling.
- **Spider traps intended to poison crawlers** — random generated content, hidden links. Quality scoring per domain, and demote or blocklist domains producing endless low-value pages.

## 7. Prioritization and freshness

Not all pages deserve equal attention.

**Priority signals:** inbound link count (a PageRank-like signal), domain authority, observed update frequency, content type, and depth from the seed.

**Recrawl scheduling** should be *adaptive*:

```diagram
   Track change frequency per URL.
     A news homepage changes hourly    → recrawl hourly
     A static about page never changes → recrawl monthly

   Estimate a change rate per page and schedule the next
   crawl accordingly. Use HTTP conditional requests
   (If-Modified-Since / ETag) — a 304 response costs
   almost nothing and tells you nothing changed.
```

Conditional requests are the cheap win here: you learn "unchanged" for a fraction of the bandwidth, which lets you recrawl far more aggressively for the same cost.

## 8. Distributed operation

**Partition by domain hash.** Each crawler node owns a set of domains, which naturally enforces politeness (only one node ever fetches a given domain) and keeps `robots.txt` and delay state local.

**Extracted URLs get routed** to the node owning that domain — a shuffle step, but the volume is manageable and it keeps all per-domain state on one node.

**DNS is a bottleneck people forget.** Every fetch needs a resolution, and DNS is often slow (tens to hundreds of ms) and rate-limited by resolvers. Run a local caching resolver and cache aggressively with your own TTL policy. This is a genuinely common real-world crawler bottleneck and a great detail to mention.

## 9. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| Fetcher worker dies | Its in-flight URLs are requeued after a lease timeout. At-least-once fetching means occasional duplicate fetches — harmless. |
| A domain starts erroring | Exponential backoff per domain; after repeated failures, demote and retry much later. Don't hammer a site that's down. |
| Frontier node lost | Its domains are reassigned; the queue state must be durable, so back queues live in a persistent store, not memory. |
| Bloom filter lost | Rebuild from the durable URL store. Until then, some pages are recrawled — wasteful, not incorrect. |
| Storage full | Backpressure into the frontier: stop fetching rather than dropping content. Bounded queues throughout. |

**Follow-ups:**
- *"JavaScript-rendered pages?"* — needs a headless browser per fetch, which is roughly 10–100× the cost in CPU and memory. Answer: render selectively, based on whether the static HTML looks content-free. Acknowledging the cost difference is the key point.
- *"How do you keep the index fresh?"* — adaptive recrawl above, plus sitemaps and change-notification protocols where sites publish them.
- *"Detect when you've crawled 'enough' of a site?"* — track the new-unique-content rate per domain; when it falls below a threshold, deprioritize.
- *"Distributed politeness with multiple crawler clusters?"* — domain ownership must be globally exclusive, so the domain→node mapping needs to be authoritative and consistent. This is a coordination problem best solved with a [consensus-backed](../03-distributed/consensus.html) assignment table rather than independent hashing per cluster.
