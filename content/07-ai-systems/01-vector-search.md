---
title: Vector Search & ANN Indexes
summary: HNSW, IVF, and product quantization — how approximate nearest neighbour search trades a little recall for a thousand-fold speedup, and the filtering problem nobody mentions.
difficulty: Hard
scope: HLD
tags: [ai, vector-search, ann, hnsw, indexing]
prereqs: [embeddings, indexing, hardware-numbers]
unlocks: Choosing and tuning the index underneath every retrieval system.
---

:::predict Guess first
1. Comparing a query against every one of 100 million vectors — roughly how long might that take on one CPU core?
2. If a search returns 9 of the true 10 nearest results, will users usually notice?
3. A query must match only one tenant's documents, about 0.2% of the corpus. Should you search first and filter afterwards?
:::

## Why exact search doesn't work

Finding the nearest vectors to a query is trivially correct by brute force: compute the distance to every vector, keep the top *k*.

:::derive When brute force stops being viable
```
   N vectors of dimension d. One distance = ~d multiply-adds.

   1M vectors × 768 dims  =  768M FLOPs per query
     on one core (~10 GFLOP/s):  ~77 ms
     → tolerable for low QPS

   100M vectors × 768 dims  =  76.8 GFLOPs per query
     on one core:              ~7.7 seconds
     on 32 cores:              ~240 ms
     at 1,000 QPS you need 240 cores of pure distance
     computation, plus 300 GB of RAM to hold the vectors

   → brute force is fine to roughly 1M vectors at low QPS,
     and hopeless past that.
```
:::

The escape is to give up exactness. **Approximate nearest neighbour** search returns *most* of the true nearest neighbours — 95–99% — for a 100–1,000× speedup. Since embeddings are themselves approximate representations of meaning, missing the 9th-best of 10 results is usually invisible.

**Recall@k** is the metric: of the true top-k, how many did we return? Recall 0.95 at k=10 means we found 9.5 of the true 10 on average.

## HNSW

The dominant algorithm, and its name describes it: **hierarchical navigable small world**. Connect each vector to its nearest neighbours so the whole collection becomes a graph you can walk, then keep stepping toward whichever neighbour is closest to your query.

The "hierarchical" part is the trick. Build several layers — a sparse top layer with long-range links for covering ground quickly, denser layers below for precision — so a search zooms in rather than crawling. It's the same idea as a skip list, in many dimensions.

```diagram
   HIERARCHICAL NAVIGABLE SMALL WORLD

   Layer 2   ●──────────────●            few nodes, long links
             │              │            (coarse navigation)
   Layer 1   ●────●────●────●────●       more nodes, medium links
             │    │    │    │    │
   Layer 0   ●─●─●─●─●─●─●─●─●─●─●       ALL nodes, short links
                                          (fine navigation)

   SEARCH
     1. enter at the top layer
     2. greedily move to whichever neighbour is closer
        to the query, until no neighbour improves
     3. drop to the next layer down, continue from there
     4. at layer 0, keep a candidate list of size ef
        and return the best k

   Each layer roughly halves the remaining distance,
   giving O(log N) hops instead of O(N) comparisons.
```

The structure is a skip list generalised to metric space: sparse upper layers for fast coarse movement, a dense bottom layer for precision.

| Parameter | Effect | Typical |
|---|---|---|
| **M** | Links per node. Higher = better recall, more memory | 16–64 |
| **ef_construction** | Candidate list size while building. Higher = better graph, slower build | 100–500 |
| **ef_search** | Candidate list size at query time. **The runtime recall/latency dial** | 50–500 |

:::goat ef_search is the knob that matters, and it's per-query
`M` and `ef_construction` are baked in at build time — changing them means rebuilding the index, which for 100M vectors is hours.

`ef_search` is set **per query**. That means you can trade recall for latency dynamically:

- A user-facing autocomplete: `ef_search = 40`, ~2 ms, recall ~0.90. Good enough.
- A legal document search: `ef_search = 400`, ~15 ms, recall ~0.99. Worth the wait.
- Under load shedding: drop `ef_search` and degrade recall rather than queue.

That last one is genuinely useful — a graceful degradation lever that most systems don't realise they have. It's the same instinct as reducing image quality under load rather than dropping requests.
:::

**HNSW's weaknesses**, which matter in practice: memory is high (the graph is roughly `M × 2 × 4` bytes per node on top of the vectors); build time is long; and deletion is awkward — you tombstone nodes and the graph slowly degrades until you rebuild.

## IVF and product quantization

The other major family, and the one that scales to memory-constrained deployments.

```diagram
   IVF (inverted file) — partition, then search a few partitions

     Build:  k-means the vectors into nlist clusters (e.g. 4,096)
             store each vector in its cluster's list
     Query:  find the nprobe nearest centroids
             search only those lists exhaustively

     nlist = 4,096, nprobe = 32
       → search 32/4,096 = 0.8% of the data
       → ~128× speedup, some recall loss when the true
         neighbour sits in an unprobed cluster
```

**Product quantization** compresses the vectors themselves, and it's what makes billion-scale indexes fit in memory. The idea: chop each vector into short pieces, and for each piece keep only "which of these 256 standard pieces does it most resemble?" — one byte instead of thirty-two. You lose the exact values and keep enough to rank by.

:::derive PQ compression
```
   768-dim vector, float32 = 3,072 bytes

   PQ with m = 96 subvectors of 8 dims each:
     · k-means each subspace into 256 centroids (trained once)
     · store the centroid ID per subvector = 1 byte
     · vector becomes 96 bytes

   3,072 → 96 bytes  =  32× compression

   100M vectors:  307 GB  →  9.6 GB
                  (fits one machine instead of a cluster)

   Distances are computed from precomputed lookup tables —
   no decompression needed, and it's actually FASTER than
   full-precision distance because it's table lookups
   instead of arithmetic.

   Cost: recall drops. IVF-PQ typically lands at 0.85-0.95
   depending on m, versus HNSW's 0.95-0.99.
```
:::

**IVF-PQ is the standard combination**: partition with IVF, compress with PQ, and optionally re-rank the top candidates with full-precision vectors to recover most of the lost recall.

**RaBitQ** (Gao & Long, SIGMOD 2024) is the newer quantizer worth knowing. It applies a random rotation to each vector, then keeps about one bit per dimension — the same 32× saving as the PQ example — but with a proven bound on how wrong each distance estimate can be. That bound lets the search decide, candidate by candidate, whether the cheap estimate is good enough or the full vector has to be fetched, which gives PQ-level memory with steadier recall. Extended versions spend a few more bits per dimension for accuracy, and several vector databases adopted it in 2024–25.

## Choosing an index

| Index | Memory | Build | Query | Recall | Best for |
|---|---|---|---|---|---|
| **Flat (brute force)** | 1× vectors | None | Slow | 1.00 | <1M vectors, or a re-ranking stage |
| **HNSW** | 1.5–2× | Slow | Very fast | 0.95–0.99 | The default up to ~100M in RAM |
| **IVF-Flat** | ~1× | Medium | Fast | 0.90–0.98 | Large, memory available |
| **IVF-PQ** | 0.03–0.1× | Medium | Fast | 0.85–0.95 | Billion-scale, memory-constrained |
| **ScaNN** | ~0.2× | Medium | Very fast | 0.93–0.98 | Anisotropic quantization; strong on MIPS |
| **DiskANN** | Small RAM + SSD | Slow | Medium | 0.94–0.98 | Billion-scale on one machine |

**DiskANN deserves a mention** because it changes the cost structure: keep compressed vectors in RAM for navigation and the full graph on SSD, fetching only the nodes actually visited. A billion vectors on one machine with a few hundred gigabytes of SSD — a completely different infrastructure bill from a distributed in-memory index.

**Vector indexes on object storage** are the newest point on that curve. Amazon S3 Vectors (generally available December 2025, up to 2 billion vectors per index) stores and searches vectors directly in object storage: queries take around 100 ms on frequently used indexes and up to about a second otherwise, at a small fraction of the cost of keeping vectors in RAM. That suits large corpora queried occasionally — archives, long-term agent memory. Hot, latency-critical search still belongs in memory, and a common design tiers between the two.

## The filtering problem

The part that breaks most naive designs. Real queries aren't "find similar documents" — they're "find similar documents **that this user can access, in English, from the last 90 days**."

```diagram
   PRE-FILTER — filter first, then search
     apply the predicate, then brute-force the survivors
     ✓ exact, correct
     ✗ if 2% survive, that's still 2M vectors to scan
     ✗ the ANN index is useless — you can't traverse a
       graph restricted to an arbitrary subset

   POST-FILTER — search first, then filter
     get top 1,000 by similarity, drop those failing the predicate
     ✓ uses the index normally
     ✗ if the predicate is selective (0.1% match), you may
       get ZERO results back from 1,000 candidates
     ✗ recall is unpredictable and depends on the predicate

   FILTERED SEARCH — evaluate the predicate during traversal
     walk the graph, skip nodes failing the predicate,
     keep walking
     ✓ one pass, good recall
     ✗ the graph can become disconnected under a selective
       filter — you get stranded in a region with no
       passing neighbours
```

:::goat State the selectivity, then choose
The right strategy is determined by **how selective the filter is**, and this is a computable decision rather than a preference:

- **Filter passes >10%** of the corpus → post-filter with an over-fetch multiplier. Fetch `k / selectivity × safety`.
- **Filter passes <1%** → pre-filter and brute-force. The surviving set is small enough.
- **In between, or unpredictable** → filtered search with the index, and monitor recall.
- **A small set of known, high-cardinality filters** (tenant ID, language) → **partition the index by them.** A separate index per tenant makes the filter free, and it also solves multi-tenant isolation. This is by far the best option when it applies.

Naming the selectivity number is what turns this from a vague tradeoff into a decision. Most systems have one or two dominant filters, and partitioning on those is usually the answer nobody considered.
:::

## Distance metrics and one sharp edge

Cosine, dot product, and Euclidean, as in [embeddings](../05-ai-foundations/embeddings.html). For normalised vectors they rank identically.

The edge case: **maximum inner product search (MIPS) is not the same problem as nearest neighbour.** With unnormalised vectors, the highest dot product may be far away in Euclidean distance — a large-magnitude vector at a wide angle can beat a close one. Graph-based indexes assume the triangle inequality holds, which it doesn't for inner product, so HNSW on unnormalised vectors can silently lose recall.

The fixes: normalise and use cosine (usual answer), or use an index built for MIPS (ScaNN). If your recommendation system deliberately encodes popularity in the magnitude, you need the second.

## Operations

**Building costs real time.** HNSW on 100M × 768-dim vectors is hours on a large machine. Plan for it; parallelise across shards; and never make it part of a request path.

**Updates are the awkward part.** HNSW handles insertion well and deletion badly — tombstones accumulate and recall degrades. The standard pattern is a large immutable base index plus a small in-memory delta index, searched together and merged periodically. Exactly the [LSM tree](../04-data/storage-engines.html) pattern, applied to vectors.

**Memory is the binding cost.** Compute the full budget — vectors, graph overhead, metadata, and *double it* for the rebuild window when both indexes are live. That last term is the one people forget until the rebuild OOMs.

:::exercise Choose and size an index
50M documents, 1,024-dim embeddings. Queries filter by `tenant_id` (500 tenants, roughly uniform) and `language` (80% English). Target: 20 ms p99, recall ≥ 0.95, 500 QPS.

1. Raw vector memory at float32. At int8.
2. HNSW with M=32: total memory including graph overhead. Does it fit on a 256 GB machine — with room to rebuild?
3. IVF-PQ at 32× compression: memory, and expected recall. Would re-ranking the top 200 with full vectors recover it?
4. `tenant_id` has 500 values and is always in the query. Argue for partitioning by tenant. What breaks — and what happens to your largest tenant?
5. The language filter passes 80%. Pre-filter, post-filter, or filtered search? Compute the over-fetch multiplier if you post-filter.
6. 100,000 documents are added daily and 5,000 deleted. Design the update strategy and say how often you rebuild.
:::

:::paper Sources
*Efficient and Robust Approximate Nearest Neighbor Search Using Hierarchical Navigable Small World Graphs* (Malkov & Yashunin, TPAMI 2018) is HNSW.

*Product Quantization for Nearest Neighbor Search* (Jégou, Douze & Schmid, TPAMI 2011) is PQ. *DiskANN* (Subramanya et al., NeurIPS 2019) is the SSD-based approach. *Accelerating Large-Scale Inference with Anisotropic Vector Quantization* (Guo et al., ICML 2020) is ScaNN. ANN-Benchmarks (Aumüller et al.) is the standard empirical comparison.
:::

## Check yourself

```recall
Q: When does brute-force vector search stop working?
A: Around a million vectors at low QPS: 100M × 768 dims is ~77 GFLOPs per query — seconds on a core, hundreds of cores at 1,000 QPS.

Q: What does approximate nearest-neighbour search trade?
A: A few percent of recall (returning ~95–99% of the true top-k, measured as recall@k) for a 100–1,000× speedup — invisible since embeddings are approximate anyway.

Q: How does HNSW search?
A: A layered proximity graph like a skip list: start at the sparse top layer, greedily move toward the query, drop a layer, and keep an ef-sized candidate list at the dense bottom — about O(log N) hops.

Q: Why is ef_search the important HNSW knob?
A: It's set per query, unlike M and ef_construction — so you can trade recall for latency per use case and lower it under load as graceful degradation.

Q: How do IVF and product quantization scale to billions?
A: IVF clusters vectors and searches only the nprobe nearest lists (e.g. 0.8% of the data); PQ stores each sub-vector as a 1-byte centroid ID — 32× compression with table-lookup distances. Re-rank the top with full vectors.

Q: What do RaBitQ, DiskANN and object-storage indexes change?
A: RaBitQ: ~1 bit per dimension with proven error bounds. DiskANN: compressed vectors in RAM and the graph on SSD, a billion vectors on one machine. S3 Vectors: search from object storage at ~100 ms–1 s for a fraction of the cost.

Q: How do you choose a filtering strategy?
A: By selectivity: above ~10% post-filter with over-fetch; below ~1% pre-filter and brute-force; in between, filtered traversal. For a dominant filter like tenant ID, partition the index.

Q: Name two operational traps in vector search.
A: Inner-product search on unnormalised vectors breaks graph indexes (normalise or use ScaNN), and deletions degrade HNSW — use a base index plus a delta index, and budget double memory for rebuilds.
```

## What to carry forward

- **Brute force dies around 1M vectors.** ANN trades a few percent recall for 100–1,000×.
- **HNSW is the default**: `ef_search` is a per-query recall/latency dial, usable for graceful degradation.
- **IVF-PQ gets 32× compression** with lookup-table distances — how billion-scale fits in memory.
- **DiskANN moves the graph to SSD**, changing the cost structure entirely.
- **Filtering strategy is decided by selectivity.** Partition the index on your dominant filter where you can.
- **MIPS is not NN** — normalise, or use an index built for it.
- **Budget memory for the rebuild window**, when two indexes are live at once.
