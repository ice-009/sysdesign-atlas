---
title: Build a RAG System
summary: Grounding a model in data it was never trained on — chunking, embeddings, vector search, and why retrieval quality decides everything.
difficulty: Hard
scope: HLD
level: 5
prereqs: [search, ai-chat-platform, cdc-outbox, caching, sharding]
tags: [level-5, ai, retrieval, vector-search]
unlocks: Making a model answer accurately over private or fresh data.
---

:::predict Guess first
1. A RAG system gives a confident wrong answer. Is the model more likely to blame, or the passages it was given?
2. A user searches for "error code E4032". Would meaning-based vector search or old-fashioned keyword search find it more reliably?
3. Retrieval returns 100 passages, but a user may only read some of them. Should permissions be checked before or after the answer is generated?
:::

## The product

Ask a question about your company's documents, your codebase, or a knowledge base. Get an answer grounded in the actual content, with citations.

**RAG** stands for retrieval-augmented generation, and the idea is simpler than the name. You can't retrain a model every time a document changes — so instead, when a question arrives, you go and find the handful of passages most likely to answer it and paste them into the prompt. The model does the reasoning; your system does the finding.

**Retrieval quality is the whole game.** A perfect model given wrong passages produces a confident wrong answer. Most RAG systems that "don't work" have a retrieval problem, not a model problem — and saying so early shows you understand where the difficulty actually lives.

## The pipeline

```diagram
   INGEST (offline)
   documents → parse → chunk → embed → index
                                          │
   QUERY (online)                         ▼
   question → embed ──────────► vector search
            └─── keyword search ──► hybrid fusion
                                          │
                                     rerank (top ~100 → top ~8)
                                          │
                                  assemble context + cite
                                          │
                                        model ──► answer
```

## Phase 1 — Chunking, which decides your ceiling

The most under-appreciated step. Get this wrong and no amount of retrieval sophistication recovers.

```diagram
   TOO SMALL (100 tokens)
     "...the timeout should be set to 30 seconds."
     → retrieves cleanly, but WHICH timeout? Context lost.

   TOO LARGE (4,000 tokens)
     an entire chapter
     → the relevant sentence is diluted; embedding averages
       across many topics and matches nothing well

   SWEET SPOT: roughly 300-800 tokens, split on SEMANTIC
   boundaries — headings, paragraphs, function definitions —
   never blindly every N characters.
```

Two techniques that consistently help:

**Overlap.** Adjacent chunks share ~10–15% of their content so a fact spanning a boundary isn't lost by both.

**Contextual prefixing.** Prepend the document title and section heading to each chunk before embedding: `"Deployment Guide > Timeouts: the timeout should be set to 30 seconds."` The chunk now carries its own context, and it retrieves far better because the embedding reflects what it's *about*, not just what it says.

**Structure-aware splitting** matters more than any parameter: split code at function boundaries, markdown at headings, tables as whole units. A table split across chunks is worse than useless — it's actively misleading.

## Phase 2 — Embeddings and the vector index

An **embedding** turns a piece of text into a long list of numbers — a point in space — positioned so that passages meaning similar things land near each other, even with no words in common. "How do I reset my password" sits close to "account recovery steps".

Retrieval then becomes geometry: find the points nearest the question's point.

```diagram
   Exact nearest neighbour over 100M vectors = scan all 100M
   → far too slow

   APPROXIMATE (HNSW): a navigable small-world graph
   → log-ish search time, ~95-99% recall
   → the recall/latency knob is explicit and tunable
```

**Sizing, because it drives cost:**

```diagram
   10M documents × ~8 chunks = 80M chunks
   1024-dim vectors × 4 bytes = 4 KB per vector
   80M × 4 KB = 320 GB of raw vectors
   + HNSW graph overhead (~1.5×) ≈ 480 GB

   → this does NOT fit on one machine's RAM comfortably
   → shard it, or quantize
```

**Quantization** is the lever: storing vectors at reduced precision cuts memory several-fold with modest recall loss. Standard practice at scale — and a good detail to mention, since it's the difference between "fits in memory" and "doesn't."

Newer schemes go further. Binary and **RaBitQ**-style quantization (SIGMOD 2024) store about one bit per dimension — 32× smaller than 4-byte floats — then re-score the shortlist with full-precision vectors to keep recall high. And for a huge corpus that's queried rarely, vector indexes on object storage (Amazon S3 Vectors, generally available since December 2025) trade higher query latency for a small fraction of the cost of keeping everything in RAM.

**Metadata filtering is where people get burned.** "Search only documents this user can access" sounds trivial and isn't: filtering *after* retrieval can leave you with nothing (all top-100 results were inaccessible), while filtering *during* graph traversal degrades the index's connectivity assumptions. Use an index that supports native filtered search, and treat permissions as a first-class part of the query rather than a post-filter.

:::trap Permissions in RAG are a real security boundary
If retrieval ignores access control, the model will happily summarize a document the user was never allowed to read — and it'll do so fluently and convincingly. Filter at retrieval time using the *requesting user's* permissions, never post-hoc on the generated answer. This is one of the most common serious bugs in production RAG systems, and raising it unprompted is a strong signal.
:::

## Phase 3 — Hybrid retrieval

Pure vector search has a specific, predictable weakness: it's bad at exact matches.

```diagram
   Query: "error code E4032"
     vector search → semantically similar error discussions
                     ...but possibly not the exact code
     keyword (BM25) → exact match, immediately

   Query: "how do I make the app faster"
     keyword  → matches on "faster", misses "optimize",
                "improve performance", "reduce latency"
     vector   → finds all of them
```

They fail in opposite directions, so run both and fuse:

```diagram
   BM25 top-100  ─┐
                  ├─► reciprocal rank fusion ──► candidates
   vector top-100 ─┘
```

Reciprocal rank fusion combines by *rank* rather than raw score, which sidesteps the problem that BM25 scores and cosine similarities aren't comparable quantities.

**Hybrid beats either approach alone in essentially every published evaluation.** Identifiers, names, error codes, and version numbers need lexical matching; conceptual questions need semantic matching. Real queries contain both.

## Phase 4 — Reranking

Two words that get used loosely. **Recall** is "did we find the right passage at all?" — retrieval's job, and it only has to land it somewhere in the top hundred. **Precision** is "is what we're about to show actually relevant?" — and since only a handful of passages fit in the prompt, something has to promote the best of that hundred into the top five. That second pass is **reranking**.

```diagram
   BI-ENCODER (retrieval)
     embed query and documents SEPARATELY, compare vectors
     → fast, precomputable, less accurate

   CROSS-ENCODER (reranking)
     process query and document TOGETHER
     → much more accurate, far too slow to run over millions
     → so run it over the ~100 candidates only
```

Retrieve broadly and cheaply, rerank narrowly and expensively. Same **retrieve-then-rerank** shape as [search](../building-blocks/search.html), [feed ranking](twitter.html), and [Uber's matching](uber.html) — recognizing it as a general pattern is worth points on its own.

Reranking typically produces the single largest quality jump in a RAG pipeline for the least architectural change.

## Phase 5 — Generation and citations

```diagram
   [system: answer ONLY from the provided context;
            if it isn't there, say so; cite sources]
   [retrieved chunk 1 — with source id]
   [retrieved chunk 2 — with source id]
   ...
   [user question]
```

**Order matters.** Models attend unevenly across long contexts, with material at the beginning and end weighted more heavily than the middle. Put the strongest passages at the edges rather than burying them.

**Citations must be verifiable, not generated.** Have the model reference chunk IDs, then map those to real sources in your application code. Asking the model to produce URLs invites fabricated ones.

**Handle "not in the context" explicitly.** The failure mode of RAG is a fluent, confident answer built from irrelevant passages. Instruct the model to decline, and consider a relevance threshold below which you don't call the model at all — if the best match scores poorly, answering is worse than saying "I don't have that."

## Phase 6 — Keeping the index fresh

The index is a **derived store**. The documents are the source of truth.

```diagram
   source → [CDC / webhooks] → change queue
                                    │
                          ┌─────────▼─────────┐
                          │ re-chunk, re-embed│
                          │ upsert by chunk id│
                          │ delete removed    │
                          └───────────────────┘
```

Same [CDC](../data/cdc-outbox.html) pattern as keeping a search index in sync — and the same rule applies: **never dual-write.** Write the document, let the pipeline derive the index.

**Deletes matter more than you'd expect.** A document removed from the source must leave the index promptly, or the model will cite content that no longer exists — or that the user is no longer allowed to see. Treat deletion as high-priority, not eventual.

**Re-embedding is a migration.** Changing the embedding model invalidates every vector. Build the new index alongside the old, verify, then flip an alias — the same zero-downtime pattern as a search reindex.

## Phase 7 — Evaluation

Without measurement you're guessing, and RAG failures are quiet.

```diagram
   RETRIEVAL     recall@k    is the right chunk retrieved at all?
                 MRR         how highly is it ranked?

   GENERATION    faithfulness  is the answer supported by the context?
                 relevance     does it answer the question?

   → keep a labelled question/answer set and re-run it on
     EVERY change to chunking, embeddings, or prompts
```

Attribute failures correctly: if recall@50 is poor, no prompt change will help — fix retrieval. If retrieval is good but answers are wrong, the problem is generation. Debugging the wrong half is the most common way teams waste months here.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| 300–800 token semantic chunks | Fixed-size splits | Too small loses context; too large dilutes the signal |
| Contextual prefixes on chunks | Raw chunk text | Chunk carries its own context; retrieves far better |
| Hybrid (BM25 + vector) | Vector only | Vector search is weak on exact identifiers and codes |
| Rerank top-100 → top-8 | Use retrieval order | Biggest quality gain per unit of complexity |
| Filter by permission at retrieval | Post-filter results | Post-filtering leaks data and can empty the result set |
| Cite chunk IDs mapped in code | Model-generated URLs | Models fabricate plausible citations |
| CDC-driven index updates | Dual write | Index is derived; dual writes diverge permanently |
| Alias flip for re-embedding | In-place rebuild | Zero downtime, instant rollback |
| Strongest passages at context edges | Arbitrary order | Attention is uneven across long contexts |

## What you'd cut for v1

Reranking, hybrid search, contextual prefixes, incremental updates. Ship: fixed semantic chunking, vector search, top-5 into the prompt, full reindex nightly. Then **measure** — and add reranking first, because it's the largest single quality gain available.

## Explaining the design

> "I'd frame this as a retrieval problem rather than a model problem, because that's where these systems actually fail — a perfect model given the wrong passages gives a confident wrong answer.
>
> Ingest is parse, chunk, embed, index. Chunking sets the ceiling: 300 to 800 tokens on semantic boundaries with overlap, and I'd prepend document and section titles so each chunk carries its own context.
>
> Retrieval is hybrid — BM25 and vector search fused by reciprocal rank — because vector search is weak on exact identifiers and keyword search is weak on paraphrase. Then rerank the top 100 down to the top 8 with a cross-encoder, which is usually the biggest quality gain available.
>
> Two things I'd be careful about. Permissions have to be applied *at retrieval time* with the requesting user's access, not as a post-filter — otherwise the model will happily summarize documents the user can't read. And citations should reference chunk IDs that my code maps to sources, because models will fabricate plausible URLs.
>
> The index is derived from the documents via CDC, never dual-written, and re-embedding is an alias flip. Throughout, I'd hold a labelled eval set and re-run it on every change, so I can tell whether a regression is in retrieval or generation."

## Next

[Build an AI Agent Platform](ai-agent-platform.html) — where the model stops answering and starts acting.

## Check yourself

```recall
Q: Why is retrieval quality "the whole game" in RAG?
A: A perfect model given the wrong passages produces a confident wrong answer; most RAG systems that "don't work" have a retrieval problem.

Q: What makes good chunks?
A: 300–800 tokens split on semantic boundaries (headings, paragraphs, functions, whole tables) with ~10–15% overlap, and a contextual prefix of document and section title before embedding.

Q: How big is a vector index, and how do you shrink it?
A: 80 million chunks × 1024 dims × 4 bytes ≈ 320 GB, ~480 GB with HNSW overhead. Shard, or quantize — down to about 1 bit per dimension with full-precision re-scoring of the shortlist.

Q: Why must permissions be applied at retrieval time?
A: Post-filtering can empty the results, and ignoring access control lets the model fluently summarise documents the user may not read. Filter with the requesting user's permissions inside the query.

Q: Why hybrid retrieval, and how are results fused?
A: Vector search misses exact identifiers; BM25 misses paraphrase. Run both and merge with reciprocal rank fusion, which combines by rank because the scores aren't comparable.

Q: What does reranking add?
A: A cross-encoder reads query and passage together — far more accurate but too slow for millions — so it reorders the ~100 retrieved candidates down to ~8. Usually the biggest quality gain for the least change.

Q: How should citations and "not found" be handled?
A: The model cites chunk IDs that application code maps to real sources (models fabricate URLs), and it's told to decline when the context lacks the answer — or isn't called below a relevance threshold.

Q: How do you tell whether a failure is retrieval or generation?
A: Measure recall@k and MRR for retrieval, faithfulness and relevance for answers, on a labelled set re-run every change. Poor recall@50 means no prompt change will help.
```

## What to carry forward

- Treat RAG as a retrieval problem first.
- Chunk semantically with context prefixes; that sets the ceiling.
- Hybrid retrieval plus a cross-encoder rerank; permissions inside the query.
- Cite by chunk ID, decline when unsupported, order strong passages at the edges.
- The index is derived via CDC; re-embed by alias flip; evaluate every change.
