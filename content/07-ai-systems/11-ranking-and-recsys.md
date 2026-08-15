---
title: Ranking & Recommendation Systems
summary: Candidate generation, ranking, and re-ranking — the funnel that picks 10 items out of 100 million in under 100 milliseconds, and why each stage uses a different model.
difficulty: Hard
scope: HLD
tags: [ai, ranking, recsys, retrieval, two-tower]
prereqs: [embeddings, ml-platform, vector-search]
unlocks: The architecture behind every feed, search result page, and "recommended for you".
---

## The constraint that shapes everything

Score 100 million items for one user in 100 milliseconds. A good ranking model takes ~1 ms per item. The arithmetic doesn't work — by five orders of magnitude.

So you don't score everything. You build a funnel, where each stage is cheaper per item and handles more items than the next.

```viz
{
  "type": "steps",
  "caption": "Each stage is ~100× cheaper per item and handles ~100× more items than the next.",
  "steps": [
    { "label": "Corpus", "sub": "100,000,000 items", "accent": "#64748b" },
    { "label": "Candidates", "sub": "~1,000 · ANN + heuristics · ~10 µs/item", "accent": "#38bdf8" },
    { "label": "Ranking", "sub": "~100 · rich model, hundreds of features · ~1 ms/item", "accent": "#a78bfa" },
    { "label": "Re-ranking", "sub": "~10 · diversity, business rules, whole-slate", "accent": "#4ade80" }
  ]
}
```

:::derive Why the funnel is the only viable shape
```
   FLAT: score everything with the good model
     100,000,000 × 1 ms  =  27.8 hours per request

   FUNNEL:
     candidate generation  ANN over 100M    ~10 ms
     ranking               1,000 × 1 ms, batched on GPU
                                            ~30 ms
     re-ranking            100 items, cheap  ~5 ms
                                            ────────
                                            ~45 ms ✓

   → Six orders of magnitude, purely from applying
     expensive computation only where it changes the answer.
```
:::

## Candidate generation

Get from 100M to ~1,000 with high **recall** — the right items must be in the set, because nothing downstream can recover an item that was never retrieved. Precision doesn't matter here; ranking handles that.

Real systems run several retrievers in parallel and merge, because each has different failure modes:

| Source | Mechanism | Catches |
|---|---|---|
| **Two-tower ANN** | Embedding similarity between a user vector and item vectors | Personalised, semantic matches |
| **Collaborative filtering** | "Users like you also engaged with…" | Taste-based, non-obvious matches |
| **Content/tag match** | Same category, creator, or topic | Explicit interest signals |
| **Trending / popular** | Global engagement | Cold-start users; the safe fallback |
| **Recency** | Newest items | Freshness-sensitive feeds |
| **Follow graph** | Items from followed entities | Social products, and usually the strongest source there |

**The two-tower model** is the workhorse, and its odd shape exists for one reason: the item side must be computable *in advance*. Two separate networks — one turning a user into a vector, one turning an item into a vector — that only meet at the very end, in a single similarity comparison. Because they never interact before that point, you can embed all 100 million items overnight and, at request time, embed only the user and search.

```diagram
   TWO-TOWER (dual encoder)

     user features ──► user tower ──► user vector (256-dim)
                                              │
                                        dot product / cosine
                                              │
     item features ──► item tower ──► item vector (256-dim)

   The towers never interact until the final dot product.
   That separation is the entire point:

     · item vectors are computed OFFLINE for all 100M items
       and loaded into an ANN index
     · the user vector is computed ONCE per request
     · retrieval is then a nearest-neighbour lookup
```

The towers are trained with in-batch negatives — the same contrastive setup as [embeddings](../05-ai-foundations/embeddings.html), with users and items in place of queries and passages.

The cost of that separation is the same as with bi-encoders in retrieval: the model never sees user and item together, so it cannot learn interactions between them. That's what ranking is for.

## Ranking

Now you have 1,000 candidates and a budget of roughly a millisecond each. You can afford a model that sees user and item **jointly**, with hundreds of features.

```diagram
   FEATURES AT RANKING TIME

     user      demographics, long-term interests, recent
               activity, session context, device
     item      content features, age, creator, historical
               engagement rates, quality score
     CROSS     ← where the signal is
               user's past engagement with this creator,
               with this topic, at this hour;
               similarity between the user vector and item
               vector; how many of the user's follows
               engaged with this item
     context   time of day, session length, position on
               the page, what was just shown
```

**Cross features carry most of the predictive power.** "This user has watched 40 videos from this creator" is far more informative than any user feature or item feature alone — and it's exactly what the two-tower model structurally cannot express.

**Multi-task is standard.** A single model predicts several outcomes at once: probability of click, of a long dwell, of a like, of a share, of a report. Sharing a representation across tasks improves all of them, and it lets the final score be a weighted combination:

```
   score = w₁·P(click) + w₂·P(long_dwell) + w₃·P(share)
                                          − w₄·P(report)

   The weights are a PRODUCT decision, not a modelling one.
   They encode what the business considers valuable, and
   changing them changes the product's character far more
   than a model improvement will.
```

:::goat Optimising click-through rate degrades the product, reliably
Click-through rate — the share of shown items that get clicked — is easy to measure, available immediately, and a poor proxy for value. Optimise it hard enough and you get clickbait, thumbnails that misrepresent, and outrage — because those genuinely maximise clicks.

The industry pattern is consistent: teams that optimise a single engagement metric get short-term gains and long-term retention decline. The corrections are all forms of measuring something harder:

- **Weight toward deep engagement** — completion, dwell, return visits — over the click.
- **Include explicit negative signals** — hides, reports, "not interested" — with meaningful weight.
- **Measure long-term outcomes** in holdout groups: retention at 30 days, not sessions today.
- **Constrain rather than optimise**: cap the share of low-quality content regardless of its predicted CTR.

The general point transfers beyond recommendations: **the metric you optimise becomes the product you have**, so choose it as a product decision with the same care as any other.
:::

## Re-ranking

The top 100 are individually good. That doesn't make a good *slate*.

**Diversity.** Ten near-identical items is a worse experience than eight good ones plus two different ones, even though the greedy ranking says otherwise. Maximal Marginal Relevance is the standard tool: `score = λ·relevance − (1−λ)·max_similarity_to_already_selected`.

**Business rules.** Sponsored placement, freshness quotas, creator diversity limits, regulatory constraints, and content policy — none of which the ranking model knows about.

**Position effects.** Users click position 1 far more than position 5 regardless of relevance. Training on click data therefore teaches the model that whatever was shown first is good — a feedback loop. Fixes: include position as a training feature and set it to a constant at serving time, or use inverse-propensity weighting.

**Whole-slate optimisation.** Rather than picking the top 10 independently, score the *set*. Expensive and better, and mostly used where the slate is small and valuable.

## Cold start

| Case | Approach |
|---|---|
| **New user** | Popular and trending items; onboarding interest selection; contextual signals (locale, device, referrer); explore aggressively |
| **New item** | Content-based features; a deliberate exploration budget; borrow signal from similar items |
| **New system** | Content-based only until you have interaction data; consider importing a public dataset for bootstrapping |

**Exploration is mandatory, and it costs.** A system that only shows what it already believes is good never learns whether anything else was better, and its data narrows. Allocate a percentage of impressions to exploration — epsilon-greedy is fine, Thompson sampling is better — and treat the cost as the price of not degrading over time. The [feedback loop](ml-platform.html) hazard is the same one classical ML systems face, here at much higher volume.

## The infrastructure

```diagram
   OFFLINE (hourly to daily)         ONLINE (per request)

   train ranking model               fetch user features        ~5 ms
   compute item embeddings           candidate generation      ~10 ms
   build the ANN index                 (parallel retrievers)
   precompute item features          fetch candidate features  ~10 ms
   push to the online store          rank (batched on GPU)     ~30 ms
                                     re-rank + rules            ~5 ms
                                     log everything for training
```

Two things dominate the online latency budget and are easy to underestimate:

**Feature fetching.** Ranking 1,000 candidates with 200 features each is 200,000 feature lookups. This must be a batched multi-get against the online store, and it is frequently the largest single term in the budget — bigger than the model.

**Logging.** Every impression, its features, its position, and the resulting interaction must be logged, or you have no training data for tomorrow's model. At millions of impressions per minute this is a serious data pipeline in itself, and **logging the features as they were at scoring time** — rather than recomputing them later — is what prevents [training/serving skew](ml-platform.html).

:::exercise Design a feed
A short-video feed: 50M videos, 10M daily users, 30-second p99 session start, 200 ms budget for a batch of 10 recommendations.

1. Design the candidate generation: which retrievers, how many candidates from each, and how do you merge them?
2. Two-tower model: what features go in each tower, and what does the separation prevent you from learning?
3. List ten ranking features, including at least four cross features. Which do you expect to matter most?
4. Design the multi-task objective. What do you predict, and how do you weight it? Justify the weights as a product decision.
5. Budget the 200 ms across candidate generation, feature fetch, ranking, and re-ranking. Which is largest, and what would you do if it doesn't fit?
6. A new creator uploads their first video. Trace its path through the system. How does it ever get shown, and what's your exploration budget?
7. Engagement is up 8% after a ranking change, but 30-day retention in the holdout is down 2%. What do you do?
:::

:::paper Sources
*Deep Neural Networks for YouTube Recommendations* (Covington, Adams & Sargin, RecSys 2016) is the canonical description of the candidate-generation-plus-ranking funnel.

*Sampling-Bias-Corrected Neural Modeling for Large Corpus Item Recommendations* (Yi et al., RecSys 2019) is the two-tower model with in-batch negative correction. *Recommending What Video to Watch Next: A Multitask Ranking System* (Zhao et al., RecSys 2019) covers multi-task objectives and position bias.
:::

## What to carry forward

- **The funnel exists because flat scoring is six orders of magnitude too slow.** Each stage is cheaper per item and handles more of them.
- **Candidate generation optimises recall**; ranking optimises precision. Run several retrievers in parallel.
- **Two-tower separation enables offline item embeddings** and structurally prevents learning interactions.
- **Cross features carry most of the ranking signal.**
- **Optimising CTR degrades the product.** Weight deep engagement and negative signals; measure retention in holdouts.
- **Re-ranking handles diversity, business rules, and position bias** — none of which the ranker knows.
- **Feature fetching often dominates the latency budget**, and logging features at scoring time is what prevents skew.
