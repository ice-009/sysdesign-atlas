---
title: Retrieval Architecture (RAG)
summary: Chunking, hybrid search, reranking, and evaluation — the pipeline between a question and a grounded answer, and why retrieval quality caps everything downstream.
difficulty: Hard
scope: HLD
tags: [ai, rag, retrieval, reranking, hybrid-search]
prereqs: [vector-databases, search]
unlocks: Building retrieval that actually finds the right context, and knowing when it doesn't.
---

:::predict Guess first
1. Small chunks match queries precisely; big chunks carry context. Must the chunk you search against be the same text you hand the model?
2. A user searches for "error E-4471". Would meaning-based search, keyword search, or both find it best?
3. A RAG answer is wrong. Without more measurement, can you tell whether retrieval or generation failed?
:::

## The pipeline

Retrieval-augmented generation is a search problem with a language model at the end. The model gets most of the attention; **retrieval quality sets the ceiling on the whole system.** If the right passage isn't in the context, no amount of prompting recovers it.

```viz
{
  "type": "flow",
  "caption": "Six stages. Most RAG systems implement two of them and wonder why quality is poor.",
  "nodes": [
    { "id": "q", "label": "Query", "col": 0, "accent": "#38bdf8" },
    { "id": "t", "label": "Transform", "sub": "rewrite · expand · decompose", "col": 1, "accent": "#22d3ee" },
    { "id": "r", "label": "Retrieve", "sub": "dense + lexical, top 100", "col": 2, "accent": "#4ade80" },
    { "id": "k", "label": "Rerank", "sub": "cross-encoder, top 10", "col": 3, "accent": "#a78bfa" },
    { "id": "a", "label": "Assemble", "sub": "dedupe · order · budget", "col": 4, "accent": "#fbbf24" },
    { "id": "g", "label": "Generate", "sub": "with citations", "col": 5, "accent": "#fb7185" }
  ],
  "edges": [
    { "from": "q", "to": "t" }, { "from": "t", "to": "r" },
    { "from": "r", "to": "k" }, { "from": "k", "to": "a" },
    { "from": "a", "to": "g" }
  ]
}
```

## Chunking

The most consequential and least glamorous decision. Chunks are the unit of retrieval, so chunk boundaries determine what can ever be retrieved together.

```diagram
   TOO SMALL (100 tokens)          TOO LARGE (2,000 tokens)

   precise embeddings              embedding averages many topics
   but context is missing          → matches everything weakly
   → "It requires a restart."      → retrieves a whole chapter
     What does? Lost.                to answer one question
   → many chunks per answer        → wastes context budget
                                   → "lost in the middle" within
                                      the chunk itself
```

Strategies, in increasing sophistication:

| Strategy | How | When |
|---|---|---|
| **Fixed size + overlap** | 512 tokens, 15% overlap | The baseline. Works surprisingly well |
| **Structural** | Split on headings, paragraphs, code blocks | Almost always better — respects the author's own boundaries |
| **Semantic** | Split where consecutive-sentence embedding similarity drops | Better on unstructured prose; slower to build |
| **Recursive** | Try paragraph, then sentence, then token boundaries until under the size cap | Good general-purpose default |

:::goat Decouple what you embed from what you return
The tension — small chunks embed precisely, large chunks carry context — dissolves once you stop assuming they're the same object.

**Small-to-big:** embed 200-token chunks for precise matching, but return the surrounding 1,500-token parent section to the model. Retrieval precision *and* usable context.

**Contextual retrieval:** prepend a short generated summary of the document to each chunk before embedding it ("This chunk is from the Q3 financial report, discussing supply chain costs"). Anthropic reported this cutting retrieval failures substantially. It costs a one-time generation per chunk at index time and nothing at query time.

**Hypothetical questions:** for each chunk, generate the questions it answers, embed *those*, and map back to the chunk. Query-to-question matching is much easier than query-to-passage, because they're the same kind of text.

All three attack the same problem: the thing you should match against and the thing you should show the model are different objects.
:::

## Hybrid search

Two kinds of search, with complementary blind spots. **Dense** retrieval is the embedding-based kind — it matches meaning, and [it's bad](../05-ai-foundations/embeddings.html) at exact identifiers, rare words, and negation. **Lexical** retrieval is old-fashioned keyword matching — it nails exactly those and fails at synonyms and paraphrase.

**Hybrid** means running both and combining the results, which is why it's the default in serious systems.

```diagram
   Query: "error E-4471 when saving"

   DENSE ONLY
     finds passages about "save failures" and "write errors"
     does NOT reliably find the one mentioning E-4471
     → the error code is just an unusual token to it

   BM25 ONLY
     finds every passage containing "E-4471" exactly
     misses "persistence failure" phrased differently

   HYBRID
     both, fused → the exact match AND the paraphrases
```

Combining them is harder than it sounds, because the two systems produce scores on incomparable scales. **Reciprocal Rank Fusion** sidesteps that entirely by throwing the scores away and using only *positions* — something ranked second by both lists beats something ranked first by one and fiftieth by the other:

:::derive Why RRF beats weighted score fusion
```
   RRF:   score(d) = Σ  1 / (k + rank_i(d))       k ≈ 60
                    over each retrieval system i

   Document ranked 1st by BM25 and 5th by dense:
     1/(60+1) + 1/(60+5)  =  0.0164 + 0.0154  =  0.0318

   Why ranks rather than scores:
     · BM25 scores are unbounded and corpus-dependent
     · cosine scores sit in a model-specific narrow band
     · normalising them requires per-corpus calibration
       that drifts

   Ranks are dimensionless and directly comparable.
   No tuning, no calibration, no drift.
```
:::

Hybrid retrieval is close to free to add and reliably improves recall. It should be the default, not an optimisation.

## Reranking

First-stage retrieval must be fast over millions of documents, so it uses a **bi-encoder** — query and document embedded independently, compared by distance. That independence is what allows precomputation, and it's also the quality limitation: the model never sees the query and document together.

```diagram
   BI-ENCODER (retrieval)           CROSS-ENCODER (reranking)

   embed(query)   ─┐                model([query, document])
   embed(doc)     ─┴─► cosine         → attends across BOTH
                                      → a single relevance score
   docs precomputed                 nothing precomputable
   millions in milliseconds         ~10-50 ms per pair
   ✗ no query-document interaction  ✓ full interaction, much
                                       more accurate
```

The two-stage pattern: retrieve 100 candidates with the fast bi-encoder, rerank them with the slow cross-encoder, keep the top 10. Recall from stage one, precision from stage two.

**Rerankers are usually the highest return per unit of effort in a RAG system.** They routinely move retrieval precision by 10–30 points and require no index changes, no re-embedding, and no retraining — you add a model call on 100 documents.

The cost: 100 documents at ~20 ms each is 2 seconds serially, so batch them, and consider a smaller reranker or fewer candidates if latency is tight. **ColBERT** sits between the two — token-level late interaction, more accurate than a bi-encoder and much faster than a cross-encoder — at the cost of a considerably larger index.

## Query transformation

The user's question is often not the best search query.

- **Rewriting.** "what about the second one" is meaningless standalone. Rewrite against conversation history into a self-contained query. Mandatory for multi-turn retrieval and frequently forgotten.
- **Decomposition.** "Compare our Q3 and Q4 margins" needs two retrievals, not one. Split, retrieve separately, combine.
- **HyDE.** Generate a *hypothetical answer* to the question, embed that, and search with it. Answers look like documents; questions don't. Often a solid gain, at the cost of one extra model call.
- **Expansion.** Add synonyms and related terms, mainly to help the lexical side.
- **Agentic retrieval.** Give the model search as a tool and let it run several queries — read the results, refine, search again. That's the pattern behind the "deep research" products of 2025, and it handles multi-hop questions that one retrieval can't. It costs several times the latency and tokens, so route only hard questions to it and keep single-shot retrieval for the common ones.

## Assembling the context

Retrieved chunks are not a prompt. Assembly matters more than it appears:

- **Deduplicate.** Overlapping chunks and near-duplicate documents waste budget and bias the model by repetition.
- **Order deliberately.** Given [lost-in-the-middle](../05-ai-foundations/context-windows.html), put the strongest results first and last, weakest in the middle.
- **Budget explicitly.** System prompt + retrieved chunks + history + question + *room for the answer*.
- **Attach metadata.** Source, date, and section heading, so the model can cite and can reason about recency.
- **Say what to do when there's nothing.** "If the context doesn't contain the answer, say so" measurably reduces fabrication — and it's one line.

## Evaluating retrieval separately

The most common diagnostic failure in RAG: measuring only end-to-end answer quality. When the answer is wrong you can't tell whether retrieval missed the passage or the model ignored it, and those need completely different fixes.

```diagram
   MEASURE EACH STAGE

   Retrieval    recall@k    is the right chunk in the top k?
                MRR / nDCG  how high is it ranked?
                            → needs query→relevant-chunk labels

   Reranking    same metrics, before vs after
                            → is the reranker earning its latency?

   Generation   faithfulness  is the answer supported by the
                              retrieved context?
                answer quality is it actually a good answer?

   → If recall@10 is 0.6, your ceiling is 0.6 regardless of
     the model. Fix retrieval first. Every hour spent on
     prompt engineering above a broken retriever is wasted.
```

:::goat Build the labelled set — it is a day of work and it changes everything
Take 200 real queries. For each, have someone identify which chunks actually contain the answer. That's your retrieval evaluation set, and it makes every subsequent decision measurable rather than argued.

You can bootstrap it cheaply: for each chunk, generate a question it answers with a model, then invert the mapping. Not as good as human labels, and dramatically better than nothing.

Without this set, RAG development is guesswork — people change the chunk size, feel that outputs seem better, and ship. With it, "chunk size 256 gives recall@10 of 0.71; 512 gives 0.84" is a five-minute experiment.
:::

## Failure modes worth knowing

| Failure | Symptom | Fix |
|---|---|---|
| Chunk boundary splits the answer | Answers are half-right | Overlap, structural chunking, small-to-big |
| Query and corpus vocabulary differ | Nothing relevant retrieved | Hybrid search, query expansion, fine-tuned embeddings |
| Retrieval returns near-duplicates | 10 chunks say the same thing | Dedupe; MMR for diversity |
| Model ignores the context | Answer contradicts a retrieved passage | Reorder, reduce count, prompt for citations |
| Stale index | Confidently outdated answers | Freshness SLA, show document dates |
| No relevant documents exist | Confident fabrication | Score threshold plus an explicit "I don't know" path |

That last row is the one that damages trust. **If the top result's score is below a threshold, don't generate an answer.** Say you couldn't find it. The threshold needs calibrating per model (scores aren't comparable across models), and it's worth the effort.

:::exercise Build and measure
An internal engineering wiki: 15,000 pages, ~2,000 words each, heavy on code blocks and tables. Queries are engineer questions, often naming specific services, error codes, and config keys.

1. Choose a chunking strategy. What do you do with code blocks and tables — and what breaks if you split them?
2. Why is pure dense retrieval likely to do badly here? Design the hybrid setup and the fusion.
3. Build the evaluation set: how do you get 200 labelled queries without a week of manual work?
4. Baseline recall@10 is 0.62. Rank these by expected gain per unit of effort, with reasoning: add a reranker, switch chunking to structural, add BM25, fine-tune the embedding model, use small-to-big.
5. Queries often reference "the auth service" when documents say "identity-svc". Which of the above helps? What else would?
6. Design the "no good answer" path: what threshold, calibrated how, and what does the user see?
:::

:::paper Sources
*Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks* (Lewis et al., NeurIPS 2020) named RAG. *Dense Passage Retrieval* (Karpukhin et al., 2020) is the dense retrieval foundation.

*ColBERT* (Khattab & Zaharia, SIGIR 2020) is late interaction. *Precise Zero-Shot Dense Retrieval without Relevance Labels* (Gao et al., 2022) is HyDE. *Reciprocal Rank Fusion* (Cormack et al., SIGIR 2009) is the fusion method. Anthropic's "Contextual Retrieval" write-up (2024) documents the chunk-summary technique.
:::

## Check yourself

```recall
Q: What sets the ceiling on a RAG system?
A: Retrieval quality: if the right passage isn't in the context, no prompt recovers it. If recall@10 is 0.6, the system's ceiling is 0.6.

Q: Which chunking strategies work best?
A: Structural splitting on headings, paragraphs and code blocks usually beats fixed size; recursive splitting is a good default; keep tables and code whole.

Q: How do you decouple what you embed from what you return?
A: Small-to-big (embed 200-token chunks, return the parent section), contextual retrieval (prefix each chunk with a document summary) and hypothetical questions (embed the questions a chunk answers).

Q: Why reciprocal rank fusion for hybrid search?
A: BM25 and cosine scores are on incomparable scales; RRF sums 1/(k + rank) per system, so ranks fuse with no calibration or drift.

Q: Why is a reranker usually the best return on effort?
A: A cross-encoder reads query and passage together — far more accurate than a bi-encoder — and reranking ~100 candidates to 10 lifts precision 10–30 points with no index change.

Q: Name three query transformations.
A: Rewrite multi-turn questions into standalone queries, decompose comparisons into separate retrievals, HyDE (search with a hypothetical answer), expansion, and agentic retrieval for multi-hop questions.

Q: How should retrieved context be assembled?
A: Deduplicate, put the strongest passages first and last, budget explicitly with room for the answer, attach source and date metadata, and say what to do when the answer isn't there.

Q: How do you build a retrieval evaluation set quickly?
A: Take ~200 real queries and label which chunks answer them, or bootstrap by generating a question per chunk and inverting the mapping; then measure recall@k and MRR separately from answer faithfulness.
```

## What to carry forward

- **Retrieval quality caps the whole system.** Measure it separately from answer quality.
- **Decouple what you embed from what you return** — small-to-big, contextual summaries, hypothetical questions.
- **Hybrid dense + BM25 with RRF** should be the default; ranks fuse better than scores.
- **A reranker is the highest return per unit of effort** in most RAG systems.
- **Rewrite multi-turn queries** into standalone ones before retrieving.
- **Assembly matters**: dedupe, order strongest first and last, budget for the answer.
- **Build a 200-query labelled set.** It converts arguments into experiments.
