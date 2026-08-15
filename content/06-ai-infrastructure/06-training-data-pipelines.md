---
title: Training Data Pipelines
summary: Crawl, dedup, filter, tokenize, shard, mix — the pipeline that determines model quality more than the architecture does, and the systems problems inside each stage.
difficulty: Hard
scope: HLD
tags: [ai, data, dedup, pipeline, training]
prereqs: [lakehouse-and-batch, tokenization, bloom-filters]
unlocks: Building the data infrastructure that a training run actually depends on.
---

## Why this matters more than the model

The consistent finding across the last several years of published work: **at a fixed compute budget, data quality moves benchmark results more than architecture does.** Comparable architectures trained on differently-curated corpora differ substantially; architecture variations at the same data quality mostly don't.

That makes the data pipeline a first-class infrastructure system — and it is a genuinely hard one. Processing 15 trillion tokens means moving petabytes through a series of stages, each with its own scaling problem.

```viz
{
  "type": "steps",
  "caption": "Each stage removes a large fraction of what enters it. The pipeline is mostly a filter.",
  "steps": [
    { "label": "Acquire", "sub": "crawl, licensed corpora, code repos", "accent": "#38bdf8" },
    { "label": "Extract", "sub": "HTML → text, PDF → text, boilerplate removal", "accent": "#22d3ee" },
    { "label": "Filter", "sub": "language ID, quality heuristics, classifiers, safety", "accent": "#4ade80" },
    { "label": "Deduplicate", "sub": "exact and near-duplicate, across the whole corpus", "accent": "#a78bfa" },
    { "label": "Tokenize & shard", "sub": "to fixed-size binary shards for fast loading", "accent": "#fbbf24" },
    { "label": "Mix", "sub": "weight sources, order the curriculum", "accent": "#fb7185" }
  ]
}
```

:::derive The scale of the reduction
```
   Common Crawl, one monthly snapshot:  ~400 TB of WARC

     after HTML extraction         ~20-25%  →  ~90 TB of text
     after language filtering      ~40%     →  ~36 TB
     after quality filtering       ~25%     →  ~9 TB
     after deduplication           ~30-50%  →  ~3-5 TB

   → roughly 1% of what you downloaded survives to training.

   At ~4 characters per token, 5 TB ≈ 1.2 trillion tokens
   from one snapshot. A 15T-token corpus needs many
   snapshots plus books, code, and licensed data.
```
:::

## Extraction

Turning HTML into text sounds trivial and consumes an unreasonable amount of engineering time. Navigation, ads, cookie banners, and footers are the majority of the bytes on most pages and none of it is content.

Options, in ascending quality and cost: strip tags naively (fast, terrible); heuristic main-content extraction like Trafilatura or Resiliparse (the practical default); or a learned extractor (best, expensive at petabyte scale).

The failure mode to know: **boilerplate becomes a duplication problem.** The same cookie banner on ten million pages is ten million near-identical passages, and if it survives to training the model over-learns it. Extraction quality and deduplication effectiveness are coupled.

## Filtering

Several independent filters, cheapest first so expensive ones see less data.

| Filter | Method | Removes |
|---|---|---|
| **Language ID** | fastText classifier | Wrong-language or mixed-language documents |
| **Heuristic quality** | Rules: mean word length, symbol ratio, fraction of lines ending in punctuation, stopword presence | Machine-generated pages, keyword spam, navigation dumps |
| **Perplexity** | Score with a small model trained on known-good text | Text a language model finds bizarre |
| **Classifier** | Train on "high quality" (Wikipedia, books) vs random crawl | Low-value pages, at scale |
| **Safety** | Classifiers plus blocklists | CSAM, extreme content, PII |
| **Benchmark decontamination** | n-gram overlap against evaluation sets | Test-set leakage |

:::goat Decontamination is a measurement-integrity problem
If evaluation benchmark text is in your training data, your benchmark scores are meaningless — the model memorised the answers. This happens constantly and often unintentionally: benchmarks are published on the web, so they're in Common Crawl, and Common Crawl is in nearly every corpus.

The standard defence is n-gram overlap detection — flag any training document sharing, say, a 13-gram with any evaluation example — and it's imperfect: paraphrased contamination slips through, and aggressive filtering removes legitimate content.

The practical position: **decontaminate, then hold out a private evaluation set** that has never been published anywhere. A benchmark you invented and never released is the only one you can fully trust, and that's a data-infrastructure requirement rather than a modelling one.
:::

## Deduplication

The stage with the most interesting systems content, and the one with the largest measured quality effect.

**Why it matters:** duplicated data causes memorisation rather than generalisation, wastes compute on content the model already saw, and creates a train/test leakage risk. Removing duplicates has repeatedly been shown to improve quality *and* reduce the compute needed.

Two levels:

**Exact duplicates** are easy in principle: hash every document, group by hash. At 10 billion documents that's a 10-billion-key shuffle — large but a standard batch problem. A Bloom filter as a pre-pass removes most singletons cheaply before the expensive exact check.

**Near-duplicates** are the hard case, and the common one: the same article on twenty sites with different boilerplate, or a page with one word changed. Hashing doesn't help — change one character and the hash is entirely different — so you need a way to ask "are these two documents *mostly* the same?" without comparing every pair, which at 10 billion documents would be 50 quintillion comparisons.

```diagram
   MinHash + LSH, the standard approach

   1. Shingle each document into overlapping n-grams
        "the quick brown fox" → {the quick brown,
                                 quick brown fox}

   2. MinHash: hash all shingles with k independent hash
      functions; keep the MINIMUM under each.
      → a k-element signature per document

      Key property: P(minhash_i(A) == minhash_i(B))
                      == Jaccard(A, B)
      So signature agreement estimates similarity.

   3. LSH banding: split the k signatures into b bands of r.
      Two documents are CANDIDATES if any band matches exactly.

      P(candidate) = 1 − (1 − s^r)^b     for similarity s

      With b=20, r=5:  s=0.9 → 99.7% caught
                       s=0.5 →  8% caught
      → a tunable S-curve threshold

   4. Verify candidates exactly, then cluster and keep one.
```

:::derive Why LSH is necessary
```
   10 billion documents, pairwise comparison:

     10e9 × 10e9 / 2  =  5 × 10¹⁹ comparisons

   At a billion comparisons per second, that is
   1,585 YEARS.

   With MinHash + LSH:
     hash each document once            → O(N)
     group by band signature            → a shuffle, O(N)
     compare only within buckets        → O(N × bucket_size)

   → hours on a large Spark cluster instead of geological time.
```
:::

This is the same family of idea as [Bloom filters](../02-building-blocks/bloom-filters.html) — accept a controlled probability of error to turn an intractable problem into a tractable one.

## Tokenization and sharding at scale

Tokenizing 15 trillion tokens is embarrassingly parallel and I/O-bound, so the engineering is about output format rather than speed.

```diagram
   Output: fixed-size binary shards of token IDs

     shard_00000.bin   ~500 MB   uint32 token IDs, packed
     shard_00001.bin   ~500 MB
     ...

   Why this shape:

     · uint32 (or uint16 for small vocabularies) is compact
       and needs no parsing at load time — just mmap and read
     · 500 MB shards are large enough to stream efficiently
       from object storage, small enough to distribute evenly
     · sequences are pre-packed to context length, so the
       loader never has to pad or concatenate
     · an index file records document boundaries, so you can
       mask attention across documents if you want to
```

**Document packing** is the detail that matters for efficiency. Training sequences are fixed length; documents are not. Padding each document to 4,096 tokens wastes an enormous fraction of compute. So documents are concatenated with a separator and cut at the context boundary — occasionally splitting a document, which is fine. Whether attention is masked at document boundaries is a modelling choice with a real efficiency cost.

## Mixing and curriculum

The final corpus is a weighted blend, and the weights are a tuned hyperparameter.

```diagram
   A representative mixture:

     filtered web        60%    breadth
     code                15%    reasoning transfer, not just coding
     books                8%    long-form coherence
     academic / arXiv     6%    technical depth
     Wikipedia            4%    factual density
     Q&A, forums          4%    instruction-like format
     multilingual         3%    non-English capability

   Upsampling: high-quality small sources are repeated
   (2-4 epochs) while web text is seen once. Beyond ~4
   epochs on the same data, returns turn negative and
   memorisation rises.
```

**Curriculum** — changing the mixture over training — is common in the late phase: shift toward higher-quality and more instruction-like data for the final few percent of tokens. This "annealing" phase has an outsized effect on the final model's usability relative to its token count.

:::trap Data pipelines must be reproducible, and usually aren't
Six months after a training run, someone asks: what exactly was in it? Was a particular document included? Which filter version ran?

Without provenance this is unanswerable, and it has real consequences — copyright and licensing questions, a takedown request, a contamination investigation, or simply trying to reproduce a result.

Requirements to build in from the start:
- **Content-address everything.** Hash inputs and outputs at each stage.
- **Version every filter and its configuration**, in the artifact metadata.
- **Snapshot the dataset**, using a table format with time travel ([lakehouse](../04-data/lakehouse-and-batch.html)) so "the data as of that date" is a real, retrievable object.
- **Keep the document manifest** — the list of source IDs in the final corpus — even if you don't keep every intermediate.

Retrofitting provenance is close to impossible. This is a day-one design decision.
:::

## The loader

The last mile, and a frequent cause of low MFU.

- **The loader must never stall the GPU.** Prefetch several batches ahead, on separate threads, with pinned memory for fast host-to-device transfer.
- **Shard assignment must be deterministic and resumable.** Rank *r* at step *s* must read exactly the same data on a resume, or you replay or skip data silently.
- **Sequence-length balance matters.** If ranks get different amounts of real work, they become stragglers. Pre-packing to fixed length solves this by construction.
- **Streaming from object storage** beats staging petabytes to local disk, provided you prefetch aggressively enough to hide the latency.

:::exercise Design the pipeline
Build a 3-trillion-token corpus from web crawl plus code plus books.

1. Given the reduction ratios above, how much raw crawl must you acquire? At 400 TB/snapshot, how many snapshots?
2. Estimate MinHash+LSH cost for 8 billion documents: signatures at 128 hashes each, then the banding shuffle. What's the dominant cost — CPU or shuffle I/O?
3. Choose bands and rows for a 0.8 similarity threshold. Compute the detection probability at s=0.7, 0.8, 0.9. What are you accepting?
4. Design the shard format. Shard size, token width, what goes in the index. How does a 1,024-rank loader assign shards deterministically and resume mid-epoch?
5. Your mixture upsamples books 4×. How do you prevent the same book appearing 4× within one batch — and does it matter?
6. A copyright takedown arrives for a specific source. What must be true about your pipeline for you to answer "was it in the training data, and which models were affected?"
:::

:::paper Sources
*The Pile* (Gao et al., 2020) and *RefinedWeb* (Penedo et al., NeurIPS 2023) are the two most detailed public accounts of corpus construction; RefinedWeb is the strongest evidence that well-filtered web data alone can match curated corpora.

*Deduplicating Training Data Makes Language Models Better* (Lee et al., ACL 2022) is the dedup quality result. *Scaling Laws and Interpretability of Learning from Repeated Data* (Hernandez et al., 2022) covers the epoch limit. *FineWeb* (Penedo et al., 2024) documents the filtering ablations in unusual detail.
:::

## What to carry forward

- **Data quality moves results more than architecture** at fixed compute.
- **~1% of crawled bytes survive** to training. The pipeline is mostly a filter.
- **Deduplication has a large measured quality effect**; MinHash+LSH turns an O(N²) problem into O(N).
- **Decontaminate benchmarks, then hold out a private evaluation set** you never published.
- **Pack documents to fixed-length shards** — padding wastes a large fraction of compute.
- **Mixture weights are tuned hyperparameters**; late-phase annealing punches above its token count.
- **Provenance must be designed in on day one.** It cannot be retrofitted.
