---
title: The ML Platform
summary: Feature stores, training/serving skew, batch versus online inference, and drift monitoring — the classical ML infrastructure that still runs most production predictions.
difficulty: Medium
scope: HLD
tags: [ai, mlops, feature-store, ml-platform]
prereqs: [stream-processing, lakehouse-and-batch]
unlocks: The systems underneath fraud detection, ranking, pricing, and forecasting — which is most production ML.
---

## Why this isn't obsolete

Language models get the attention. Meanwhile most production ML predictions are still gradient-boosted trees and small neural networks scoring tabular features: fraud decisions, ad ranking, credit scoring, demand forecasting, churn prediction, recommendation. They're cheaper, faster, more accurate on tabular data, and far easier to explain.

They also have an infrastructure problem language models don't: **the input is computed, not given.** An LLM receives text. A fraud model receives 200 features that someone had to compute, consistently, in two different places.

## Training/serving skew

The defining failure mode of classical ML systems.

```diagram
   TRAINING                          SERVING

   Spark job over historical data    Python service, one request
   window functions, joins,          must compute the same feature
   full table scans                  from live data in <10 ms

   "average order value over
    the last 30 days"                same feature, different code,
                                     different data path
        ↓                                    ↓
   model learns from THIS            model scores THAT

   → any discrepancy means the model sees inputs at
     serving time that it never saw in training.

   Symptom: excellent offline metrics, disappointing
   production performance, and no error anywhere.
```

The discrepancies are usually mundane and invisible:

- Training computes the 30-day average **inclusive of the event day**; serving excludes it.
- Training uses a nightly snapshot; serving uses live data that's 4 hours ahead.
- Training fills nulls with the column mean; serving fills with zero.
- Timezone handling differs between the Spark job and the service.
- A categorical value present in training data no longer exists, and the encoder maps it to a different index.

:::goat Skew is not a bug you fix — it's a property you design out
Every one of those examples is a *reasonable* implementation choice made twice by different people. Code review does not catch them, because both implementations are individually correct.

The only reliable fix is architectural: **define each feature once and compute it from that single definition for both paths.** That is what a feature store is for, and it's why feature stores exist as a category rather than being a nice-to-have.

The diagnostic when you suspect skew: log the actual feature vectors at serving time, and compare their distributions against the training set. Any feature whose serving distribution differs materially from training is a skew candidate, and this comparison finds problems that no amount of code reading will.
:::

## Feature stores

```viz
{
  "type": "stack",
  "caption": "One definition, two materialisations, guaranteed consistent.",
  "layers": [
    { "label": "Feature definition", "sub": "declared once — transformation, source, entity, freshness", "accent": "#a78bfa" },
    { "label": "Offline store", "sub": "columnar, historical, point-in-time correct · training", "accent": "#38bdf8" },
    { "label": "Online store", "sub": "key-value, low latency · serving", "accent": "#4ade80" },
    { "label": "Materialisation", "sub": "batch and streaming jobs keeping both in sync", "accent": "#fbbf24" }
  ]
}
```

**Point-in-time correctness** is the offline store's essential and subtle job.

```diagram
   Training example: a transaction at 2026-03-14 09:15

   ✗ WRONG — join to the CURRENT feature value
       "customer_lifetime_value" as of today
       → includes purchases made AFTER the transaction
       → the model learns from the future
       → offline AUC is spectacular, production is useless

   ✓ RIGHT — as-of join at the event timestamp
       "customer_lifetime_value" as it was at 09:15 on 14 March
       → exactly what serving will see
```

This is **label leakage**, and it is the most common cause of a model that performs brilliantly offline and fails in production. It's also the same problem as a [temporal join](../04-data/stream-processing.html) in stream processing, and it requires the same machinery: versioned feature history with as-of semantics, not a current-value lookup.

**The online store** is a straightforward low-latency key-value problem — Redis, DynamoDB, or similar — with two demanding requirements: p99 under a few milliseconds (a scoring request may fetch 200 features), and freshness matching the feature's declared SLA.

**Materialisation** keeps them in sync. Batch features (daily aggregates) come from a scheduled job writing both stores. Streaming features ("transactions in the last 5 minutes") come from a [stream processor](../04-data/stream-processing.html) writing the online store continuously, with the same computation logged to the offline store for future training.

## Batch versus online inference

| | Batch | Online |
|---|---|---|
| **When** | Scheduled — hourly, nightly | Per request |
| **Latency** | Minutes to hours | Milliseconds |
| **Cost** | Low; amortised, spot-friendly | Higher; provisioned for peak |
| **Freshness** | As of the last run | Current |
| **Complexity** | Low — a job that writes a table | Higher — a service with SLAs |
| **Fits** | Churn scores, recommendations, forecasts | Fraud, pricing, ranking, personalisation |

**Batch is underrated.** If predictions don't depend on within-session behaviour, precomputing them nightly and serving from a key-value store is dramatically simpler, cheaper, and more reliable than a scoring service. Many "we need real-time ML" requirements are satisfied by hourly batch, and the honest question is what actually changes within the hour.

**The hybrid** is common and sensible: precompute a base score in batch, adjust it online with a handful of real-time features. You get most of the freshness benefit for a fraction of the online complexity.

## Drift

Models degrade because the world moves, and nothing errors when they do.

```diagram
   DATA DRIFT        the input distribution changes
                     new customer segment, a new product line,
                     an upstream schema change
                     → detect: KS test or PSI on each feature,
                       serving vs training distribution

   CONCEPT DRIFT     the relationship between input and label
                     changes — fraud patterns adapt, user
                     preferences shift
                     → detect: only via labels, which lag

   LABEL DELAY       the fundamental problem: a chargeback
                     arrives 60 days after the transaction,
                     so you learn today's model is failing
                     in two months

   PREDICTION DRIFT  the output distribution shifts
                     → the earliest available signal, and it
                       needs no labels. Watch it.
```

**Prediction drift is the practical monitor.** If your fraud model's average predicted probability moves from 0.02 to 0.06 with no known cause, something changed — upstream data, feature computation, or the population. You get this signal immediately, without waiting for labels.

**Feedback loops are the subtle hazard.** A fraud model that blocks transactions never learns whether they were actually fraudulent. A recommender that only shows popular items only collects data on popular items. Both narrow over time. The standard mitigation is deliberate exploration — let a small percentage through unblocked, or show some randomised recommendations — accepting a known cost to keep the training data representative.

## The registry and lineage

Every model in production needs a traceable answer to: what data, what code, what features, what performance.

```
   model: fraud-scorer-v4
   ├── training data snapshot   (table format snapshot ID)
   ├── feature definitions      (versioned, with hashes)
   ├── training code commit
   ├── hyperparameters
   ├── offline metrics          (by segment, not just aggregate)
   ├── validation results
   └── approval record          (who signed off, when)
```

This is not bureaucracy. **"Why did this model decline my loan?"** is a legally answerable question in several jurisdictions, and answering it requires knowing exactly which model version scored the application, on which feature values, from which definitions. Reconstructing that after the fact without lineage is not possible.

The same [snapshot and time-travel](../04-data/lakehouse-and-batch.html) machinery that makes datasets reproducible is what makes this work.

## Serving patterns

- **Embedded model.** Load into the application process. Lowest latency, no network hop; couples deployment of the model to deployment of the app.
- **Model server.** A dedicated service (Triton, TorchServe, KServe). Independent deployment, better hardware utilisation, one network hop.
- **Serverless.** Fine for low, spiky traffic; cold starts hurt.
- **Edge.** On-device for privacy or offline operation; hard to update and hard to monitor.

For a small tree model, **embedded is usually right** — it's a few milliseconds of CPU and the operational simplicity is worth a lot. Model servers earn their keep for GPU-backed models or when many services share one model.

:::trap Shadow deployment is the cheapest safety net available and is routinely skipped
Run the new model alongside the old on live traffic. Score everything with both. Serve only the old one's output. Compare.

You get real production distribution coverage — including all the inputs your test set never contained — at zero user risk and the cost of extra compute. It catches feature pipeline bugs, distribution mismatches, and latency regressions before anyone is affected.

It cannot catch anything requiring the new model's decisions to take effect (a fraud model's true positive rate depends on what it blocks). For that you need a controlled rollout. But shadow first, always.
:::

:::exercise Design the platform
A payments company scoring every transaction for fraud: 5,000 TPS peak, p99 budget 50 ms for the whole decision, 300 features, labels (chargebacks) arriving 30–90 days later.

1. Categorise the features: which are batch, which are streaming, which are computed from the request itself? Give three examples of each.
2. Design the online store: what's the key, what's the value, what latency budget per lookup given 300 features and 50 ms total?
3. Point-in-time correctness: write out the join for a training example, and say precisely what goes wrong without it.
4. Labels lag 30–90 days. Design the monitoring that tells you the model is degrading *before* labels arrive.
5. The model blocks 2% of transactions. Those never get labels. Design the exploration policy and quantify what it costs.
6. Design the rollout for a new model version: shadow, canary, full. What do you compare at each stage, and what's the rollback trigger?
:::

:::paper Sources
*Hidden Technical Debt in Machine Learning Systems* (Sculley et al., NIPS 2015) is the foundational paper on why ML systems accumulate operational debt — training/serving skew, entanglement, feedback loops.

*Feature Stores for ML* (the Feast and Tecton documentation) covers point-in-time correctness clearly. *The ML Test Score* (Breck et al., IEEE Big Data 2017) is a practical readiness rubric worth running against any production ML system.
:::

## What to carry forward

- **Classical ML still runs most production predictions**, and its hard problem is that features must be computed identically in two places.
- **Training/serving skew is designed out, not debugged out** — one definition, two materialisations.
- **Point-in-time correctness prevents label leakage**, the top cause of great offline metrics and poor production results.
- **Batch inference is underrated.** Ask what actually changes within the hour.
- **Prediction drift is the earliest signal** and needs no labels.
- **Feedback loops narrow your data.** Deliberate exploration is the cost of keeping it representative.
- **Lineage is a legal requirement**, not paperwork. Shadow-deploy before every rollout.
