---
title: Embeddings
summary: What a vector actually encodes, why cosine similarity is the metric, how dimensionality trades quality against cost, and the operational problem nobody plans for — re-embedding.
difficulty: Medium
tags: [ai, embeddings, vectors, retrieval]
prereqs: [transformer-as-a-system, indexing]
unlocks: The representation underneath every retrieval, recommendation, and clustering system.
---

## The idea

An embedding maps a piece of content — text, an image, a product — to a fixed-length vector of floats, arranged so that **geometric closeness corresponds to semantic similarity**.

```diagram
   "how do I reset my password"     → [0.021, -0.14, 0.87, ...]
   "forgot my login credentials"    → [0.019, -0.13, 0.85, ...]   ← close
   "what is the capital of Peru"    → [-0.61, 0.44, -0.02, ...]   ← far

   No shared words between the first two. The vectors are
   close anyway, because they mean the same thing.
```

That last line is the entire value proposition. Keyword search cannot connect "reset password" to "forgot credentials"; embeddings can, because they were trained to.

## How they're trained

Nearly all modern text embeddings come from **contrastive learning**: show the model pairs that should be close and pairs that should be far, and optimise the geometry directly.

```diagram
   For each anchor a with a known positive p and negatives n₁..nₖ:

     maximise    sim(a, p)
     minimise    sim(a, nᵢ)  for all i

   InfoNCE loss:

     L = −log [  exp(sim(a,p)/τ)                       ]
              [ ─────────────────────────────────────  ]
              [ exp(sim(a,p)/τ) + Σ exp(sim(a,nᵢ)/τ)   ]

   Positive pairs come from: question/answer, title/body,
   translation pairs, or two crops of the same image.
```

:::goat Why in-batch negatives made this work
Explicitly collecting hard negatives for every anchor is expensive. The trick that unlocked scale: within a training batch, treat **every other example's positive as a negative** for this anchor. A batch of 1,024 gives you 1,023 free negatives per example.

This is why embedding models train with enormous batch sizes, and why batch size directly determines embedding quality — more negatives means a sharper contrast signal. It's a rare case where a systems constraint (how much fits in GPU memory) is directly a model-quality constraint.

**Hard negative mining** takes it further: find examples that are *nearly* correct — retrieved by an earlier model but actually wrong — and use those. Distinguishing "reset password" from "change password settings" is a much stronger training signal than distinguishing it from "capital of Peru."
:::

## Similarity metrics

| Metric | Formula | Behaviour |
|---|---|---|
| **Cosine** | `a·b / (‖a‖‖b‖)` | Angle only; magnitude-invariant. The default |
| **Dot product** | `a·b` | Angle *and* magnitude; magnitude can encode importance or popularity |
| **Euclidean (L2)** | `‖a − b‖` | Distance in space |

For **normalised** vectors (‖v‖ = 1), all three are monotonically equivalent — ranking by one ranks identically by the others, since `‖a−b‖² = 2 − 2(a·b)`. Most embedding models emit normalised vectors precisely so that this holds and any index works.

**Cosine is the default** because embedding magnitude usually reflects nothing you care about — text length, token frequency — rather than semantic strength. Dot product is preferred in recommendation systems, where you *want* magnitude to encode popularity so that popular items rank higher for equally-relevant matches.

:::trap Cosine similarity values are not comparable across models
A cosine of 0.85 means nothing on its own. Different models occupy different regions of the space: one may put all real text between 0.7 and 0.95, another between 0.1 and 0.6.

Consequences:
- A relevance threshold tuned for one model is meaningless for another.
- Scores from two different models cannot be averaged or compared.
- "Similarity above 0.8" as a business rule will silently break on a model upgrade.

**Calibrate thresholds empirically per model**, on your data, and re-calibrate on every model change. Better still, use rank rather than absolute score wherever you can.
:::

## Dimensionality

Typical text embeddings are 384 to 4,096 dimensions. The choice is a direct cost decision.

:::derive What dimensions cost at scale
```
   100 million documents:

     384 dims  × 4 bytes  =  1.5 KB/doc  →  154 GB
     768 dims  × 4 bytes  =  3.1 KB/doc  →  307 GB
   1,536 dims  × 4 bytes  =  6.1 KB/doc  →  614 GB
   3,072 dims  × 4 bytes  = 12.3 KB/doc  →  1.2 TB

   HNSW index overhead adds roughly 1.5-2× on top.

   → 3,072 dims at 100M docs is ~2 TB of RAM for the index.
     384 dims is ~300 GB. Same corpus, 6.5× the infrastructure.

   Query cost scales with dimension too: every distance
   computation is O(d).
```
:::

**Matryoshka embeddings** are the elegant answer. Train so that the first *k* dimensions are independently useful — truncating a 3,072-dim vector to its first 256 gives a valid, if slightly weaker, embedding. This enables a two-stage retrieval that gets most of the quality at a fraction of the cost:

```diagram
   Stage 1:  search the 256-dim index over 100M docs → top 1,000
             (cheap: 12× less memory, 12× faster distance calcs)
   Stage 2:  re-rank those 1,000 with the full 3,072-dim vectors
             (exact, and only 1,000 comparisons)

   → near-full quality at a small fraction of the index cost
```

Quantizing the vectors themselves stacks on top: `float32 → int8` is 4× smaller with small recall loss; binary embeddings (1 bit per dimension, Hamming distance) are 32× smaller and fast enough to brute-force, typically used as a first-stage filter.

## What embeddings are bad at

Understanding the failure modes matters more than understanding the successes, because the failures are what break production retrieval.

**Negation.** "Documents about cats" and "documents not about cats" embed close together. The word "not" barely moves the vector. This breaks a surprising number of real queries.

**Exact identifiers.** Order number `SKU-99381`, an error code, a person's name, a version string. These need lexical matching; embeddings treat them as approximately-similar-looking strings. This is the single strongest argument for **hybrid search** — combining BM25 with dense retrieval — covered in [retrieval architecture](../07-ai-systems/retrieval-architecture.html).

**Numeric and temporal comparison.** "Orders over $500" or "articles from last week" are filter predicates, not similarity questions. They belong in metadata filters.

**Long documents.** A single vector for a 50-page document averages everything into mush. This is why chunking exists, and why chunk size is one of the most consequential parameters in a retrieval system.

**Domain shift.** A model trained on web text will underperform on legal contracts, medical notes, or your internal jargon. Fine-tuning on in-domain pairs is usually the single largest available quality improvement.

## The operational problem: re-embedding

The part nobody plans for.

**Embeddings from different models are not comparable.** Not "slightly different" — completely incomparable, different spaces with no meaningful relationship. So upgrading your embedding model means re-embedding your entire corpus.

```diagram
   100M documents, 500 tokens each = 50B tokens to re-embed

     compute cost:    substantial, though embedding models
                      are far cheaper than generative ones
     wall-clock:      hours to days on a GPU fleet
     index rebuild:   HNSW construction on 100M vectors is
                      itself hours
     storage:         you need BOTH indexes live during the
                      migration → double the memory

   And you cannot mix: a query embedded with the new model
   cannot search vectors embedded with the old one.
```

Design for this from the start:

- **Version every vector** with the model that produced it.
- **Build the new index alongside the old**, dual-write new documents to both.
- **Shadow-evaluate** the new index on real traffic before switching.
- **Cut over atomically** per index, never per document.
- **Keep the source text**, always. If you only stored vectors, you cannot re-embed at all — a genuinely unrecoverable position that people do get into.

:::goat Ask "how do we re-embed?" on day one
Every vector database design review should include the migration story, because it is the one operation that is nearly impossible to retrofit and certain to be needed — models improve every few months.

The specific things to establish: is the source text retained; is the model version stored per vector; can two indexes coexist; and what does the memory bill look like during the overlap. A system that can't answer these is one model upgrade away from either a very long outage or being stuck on an obsolete model permanently.
:::

## Beyond text

The same machinery, different encoders:

- **Multimodal (CLIP-style)** — image and text encoders trained into a *shared* space, so you can search images with a text query. The joint space is the whole trick.
- **Code** — trained on code/docstring pairs; substantially better than text models on code search.
- **Two-tower recommendation** — user and item encoders trained so that a user's vector is close to items they engaged with. Retrieval becomes nearest-neighbour search, which is what makes candidate generation over 100M items feasible. See [ranking and recsys](../07-ai-systems/ranking-and-recsys.html).

:::exercise Design the embedding layer
A support knowledge base: 2 million articles, average 1,200 words. Queries are user questions. Some queries reference ticket IDs and error codes.

1. Chunking: what size, and what overlap? What does a 200-token chunk lose versus a 1,000-token one, and what does it gain?
2. Choose dimensionality. Compute index memory for 384, 768, and 1,536 dims, including ~1.7× HNSW overhead. What would you pick and why?
3. A query is "error code E-4471 in the billing module". What does pure dense retrieval do with this? Design the fix.
4. You want to upgrade the embedding model. Write the migration plan, including what the memory bill looks like at peak and how you'd validate before cutting over.
5. Fine-tuning on in-domain pairs is available. Where do the training pairs come from in a support product, and what's your evaluation set?
:::

:::paper Sources
*Efficient Estimation of Word Representations in Vector Space* (Mikolov et al., 2013) is word2vec, where the geometry idea starts. *Sentence-BERT* (Reimers & Gurevych, EMNLP 2019) made sentence embeddings practical.

*Dense Passage Retrieval* (Karpukhin et al., EMNLP 2020) is the in-batch negatives technique. *Learning Transferable Visual Models From Natural Language Supervision* (Radford et al., ICML 2021) is CLIP. *Matryoshka Representation Learning* (Kusupati et al., NeurIPS 2022) is the truncatable-dimension idea.
:::

## What to carry forward

- Embeddings put **semantic similarity into geometry**; contrastive training with in-batch negatives is how.
- **Cosine is the default**; scores are **not comparable across models**, so calibrate thresholds per model.
- **Dimensionality is a direct infrastructure cost.** Matryoshka truncation plus quantization is how you cut it.
- They fail on **negation, exact identifiers, numeric filters, and long documents** — which is why hybrid search exists.
- **Re-embedding is the hard operational problem.** Keep the source text, version every vector, plan for dual indexes.
