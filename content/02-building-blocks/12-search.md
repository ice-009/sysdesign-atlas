---
title: Search & Inverted Indexes
summary: How full-text search works internally, why your database can't do it, relevance ranking, and keeping the index in sync with the source of truth.
difficulty: Medium
scope: HLD
tags: [search, elasticsearch, inverted-index]
prereqs: [indexing]
---

## Why not just use `LIKE`

```sql
SELECT * FROM posts WHERE body LIKE '%distributed systems%';
```

This is a full table scan — no index can help a leading wildcard. At 100M rows it's unusable. And even if it were fast, it would be *wrong* for search: no ranking, no stemming ("running" won't match "run"), no typo tolerance, no multi-word relevance, no phrase handling.

Search is a genuinely different problem requiring a different data structure.

## The inverted index

A normal index maps *document → contents*. An **inverted** index maps *term → documents containing it*.

```diagram
   Doc 1: "the quick brown fox"
   Doc 2: "the quick red fox jumps"
   Doc 3: "brown bears sleep"

   INVERTED INDEX (postings lists)
     brown  → [1, 3]
     fox    → [1, 2]
     jumps  → [2]
     quick  → [1, 2]
     red    → [2]
     sleep  → [3]
     ...

   Query "quick fox" → intersect [1,2] ∩ [1,2] = docs 1, 2
```

A query becomes a set intersection over pre-sorted postings lists — extremely fast, and independent of corpus size in the way a scan is not. Postings also store term **positions** (to support phrase queries: "quick fox" as an exact phrase requires positions to be adjacent) and **frequencies** (for ranking).

## The analysis pipeline

Text is transformed before indexing, and the *same* transformation is applied to queries. Mismatches here are the source of most "why doesn't this match?" bugs.

```diagram
   "The Runners' Feet Were Running!"
        │
   1. Character filters   strip HTML, normalize unicode
        │
   2. Tokenize            [The, Runners, Feet, Were, Running]
        │
   3. Lowercase           [the, runners, feet, were, running]
        │
   4. Stop words          [runners, feet, running]      (optional)
        │
   5. Stemming/lemma      [runner, foot, run]
        │
        ▼
   indexed terms
```

**Stemming** chops to a crude root (`running` → `run`) — fast, imperfect (`universal` → `univers`). **Lemmatization** uses a dictionary for real base forms (`feet` → `foot`, `better` → `good`) — accurate, slower.

**Stop word removal** is now often skipped: it breaks phrase queries ("to be or not to be" becomes nothing) and modern ranking already discounts common words automatically.

**Synonyms** and **n-grams** (for substring/typo matching) can be layered in. Edge n-grams — indexing `sys`, `syst`, `syste`, `system` — are how prefix autocomplete is often served.

## Relevance ranking

Matching gives you a candidate set; ranking decides the order, and ranking is the product.

**TF-IDF** — the classic intuition:
- **Term Frequency** — a term appearing often in a document suggests the document is about it.
- **Inverse Document Frequency** — a term appearing in *few* documents is more discriminating. Matching "the" tells you nothing; matching "raft" tells you a lot.

**BM25** is the modern default (it's what Elasticsearch and Lucene use). It refines TF-IDF in two important ways: term frequency **saturates** (the 50th occurrence of a word adds almost nothing over the 10th, which stops keyword stuffing from winning), and it normalizes for **document length** so a short, focused document isn't beaten by a long rambling one that happens to mention the term more times.

**Beyond text relevance**, production search blends in signals that matter more to users than lexical matching: recency, popularity/engagement, personalization, geographic distance, and business rules. A typical architecture retrieves a few hundred candidates cheaply with BM25, then re-ranks them with an expensive model — **retrieve then rerank**, which is worth naming.

**Vector / semantic search** embeds text into vectors and retrieves by nearest neighbor (HNSW is the standard index), matching meaning rather than words — "how do I fix a flat tire" matches a document about "repairing a puncture." Modern systems combine both: **hybrid search** runs BM25 and vector retrieval in parallel and fuses the rankings, because lexical search still wins on exact identifiers, names, and rare terms.

## Architecture

Search engines shard the index and replicate each shard:

```diagram
   query ──► coordinator
               │  scatter to every shard (query touches all)
               ├──► shard 1 (replicas) → top 10 local
               ├──► shard 2 (replicas) → top 10 local
               └──► shard 3 (replicas) → top 10 local
               │
               ▼  gather, merge, globally rank, return top 10
```

Two consequences worth stating:

- Search is inherently **scatter-gather**, so latency is the slowest shard's — [tail amplification](../01-fundamentals/latency-throughput.html) applies, and shard count is a latency/throughput tradeoff, not just a capacity one.
- Deep pagination is brutal: page 100 at 10/page means every shard must return 1,000 results for merging. Prefer `search_after`/cursor pagination over offsets, and cap how deep users can page.

Documents are written to immutable **segments** that are periodically merged. Immutability makes reads lock-free and caching easy; the cost is that updates are "delete + reinsert" (the old version is tombstoned and reclaimed at merge time), and deletes don't free space until a merge runs.

**Near-real-time, not real-time:** newly indexed documents become visible only after a *refresh* (typically ~1 s in Elasticsearch). Knowing that search is eventually consistent by design — and that forcing per-write refreshes destroys throughput — is a good depth signal.

## Keeping the index in sync

The search index is a **derived** store; the database is the source of truth. Getting data from one to the other is where real designs go wrong.

**Dual write (avoid).** The application writes to both the DB and the index. If the second write fails, they diverge permanently, and there's no self-healing.

**[Outbox / CDC](../04-data/cdc-outbox.html) (correct).** Write to the database; a relay reads the transaction log or an outbox table and updates the index asynchronously.

```diagram
   app → DB (source of truth)
           │ WAL / outbox
           ▼
       CDC relay → transform → bulk index → search cluster
```

Guarantees the index converges to the database, survives index downtime (events queue up), and lets you rebuild the entire index from scratch by replaying — which you *will* need to do when the mapping changes.

**Bulk, don't trickle.** Indexing one document per request is an order of magnitude more expensive than batching. Buffer for a second or a thousand documents and submit in bulk.

**Reindexing strategy.** Analyzers and mappings change and can't always be applied in place. The standard pattern: build a new index alongside the old, then atomically flip an **alias** from `posts_v1` to `posts_v2`. Zero downtime, instant rollback.

:::interview State the consistency boundary
"The search index is derived and eventually consistent — typically a second or two behind, occasionally more under load. That's fine for discovering posts, but it means a user might publish and not immediately find their own post in search. If the product needs that, I'd read the user's own recent items from the primary database and merge them into the results rather than making the whole index synchronous."

Naming the staleness *and* the targeted fix, rather than making the entire pipeline synchronous, is exactly the right instinct.
:::

## When you don't need a search engine

Worth volunteering, because adding Elasticsearch is a large operational commitment:

- **Prefix/autocomplete only** → a trie, or a Postgres index on `LOWER(name) text_pattern_ops`, or Redis sorted sets. See [Search Autocomplete](../05-case-studies/autocomplete.html).
- **Small corpus (< ~1M docs), simple queries** → Postgres full-text search (`tsvector` + GIN index) is genuinely good and removes an entire system from your architecture.
- **Exact matching / filtering** → that's just a database query with an index.
- **Fuzzy name matching only** → trigram indexes (`pg_trgm`).

The instinct to reach for the smallest sufficient tool — and to say "Postgres FTS handles this until we're past a few million documents or need real relevance tuning" — reads as maturity rather than ignorance.

:::exercise Build the index
1. 50M documents averaging 800 words. Estimate the inverted index size before and after compression. Which posting lists dominate?
2. A query is three terms. Walk through the intersection, and say why posting lists are stored sorted by document ID.
3. BM25 has two tuning parameters. What does each control, and what happens at the extremes?
4. A user searches for an exact error code and gets nothing useful. Diagnose it — is this an analysis problem, a ranking problem, or a coverage problem? How would you tell?
5. Design the freshness path: a document is edited and must be searchable within 30 seconds over a 50M-document index. What does that cost?
:::

:::paper Information retrieval foundations
Robertson and Zaragoza's *The Probabilistic Relevance Framework: BM25 and Beyond* (2009) is the definitive treatment of the ranking function everything still uses.

*Introduction to Information Retrieval* (Manning, Raghavan & Schütze, Cambridge 2008, free online) is the textbook — chapters 1–6 cover inverted indexes, tolerant retrieval, and scoring. For modern hybrid retrieval, see [retrieval architecture](../07-ai-systems/retrieval-architecture.html).
:::
