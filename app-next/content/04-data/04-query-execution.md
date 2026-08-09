---
title: How a Query Actually Runs
summary: Parser to plan to execution — join algorithms, cost models, why the optimizer picks the wrong plan, and what "vectorized execution" buys you.
difficulty: Hard
tags: [data, query, optimizer, joins]
prereqs: [indexing, storage-engines]
unlocks: Reading an EXPLAIN plan and knowing which part is the problem.
---

## From text to results

SQL is declarative: you state what you want, not how to get it. Everything between the string you send and the rows you receive is the database deciding *how*, and that decision can vary the runtime by four orders of magnitude on identical data.

```viz
{
  "type": "steps",
  "caption": "Only the last stage touches data. The third stage decides everything.",
  "steps": [
    { "label": "Parse", "sub": "SQL text → syntax tree", "accent": "#38bdf8" },
    { "label": "Bind", "sub": "resolve names, types, permissions", "accent": "#22d3ee" },
    { "label": "Rewrite", "sub": "views, subquery flattening, predicate pushdown", "accent": "#4ade80" },
    { "label": "Optimize", "sub": "enumerate plans, estimate cost, pick one", "accent": "#a78bfa" },
    { "label": "Execute", "sub": "run the operator tree", "accent": "#fbbf24" }
  ]
}
```

The optimizer is where the interesting failures happen, and it fails for one structural reason: **it is guessing.** It has no idea how many rows a predicate will match, so it estimates from statistics. When the estimate is wrong, the plan is wrong, and the plan being wrong is what a "mysteriously slow query" almost always is.

## The operator tree

A plan is a tree of operators, each pulling rows from its children. The classic model — **Volcano/iterator** — gives every operator a `next()` method that returns one row.

```diagram
   SELECT u.name, count(*)
   FROM users u JOIN orders o ON o.user_id = u.id
   WHERE u.country = 'IN' AND o.created_at > '2026-01-01'
   GROUP BY u.name

        ┌─────────────────────┐
        │  HashAggregate      │  group by u.name
        └──────────┬──────────┘
        ┌──────────┴──────────┐
        │  Hash Join          │  o.user_id = u.id
        └────┬───────────┬────┘
             │           │
   ┌─────────┴──┐   ┌────┴────────────┐
   │ Index Scan │   │ Seq Scan        │
   │ users      │   │ orders          │
   │ country=IN │   │ created_at > .. │
   └────────────┘   └─────────────────┘

   Rows flow UP. Each operator pulls from its children on demand.
```

Reading a plan is reading this tree from the leaves inward: what is scanned, how it's filtered, how the intermediate results are combined, and how many rows the optimizer *thought* would flow along each edge versus how many actually did.

## The three join algorithms

Nearly every join in every relational database is one of three, and knowing which one is appropriate is most of query tuning.

| Algorithm | Cost | Best when | Fails when |
|---|---|---|---|
| **Nested loop** | O(N × M), or O(N × log M) with an index | Outer side is tiny; inner side is indexed | Outer side is large — the classic 10,000× blowup |
| **Hash join** | O(N + M), needs memory for the build side | Large unsorted inputs, equality predicate | Build side doesn't fit memory → spills to disk |
| **Merge join** | O(N + M), but requires sorted inputs | Inputs already sorted (index order, or previously sorted) | Sorting first costs O(N log N) |

```diagram
   NESTED LOOP                  HASH JOIN                MERGE JOIN

   for each row in A:           build hash table on B    both inputs sorted
     look up matches in B         (smaller side)         walk two cursors
                                for each row in A:         in lockstep
   → great if A has 10 rows       probe the table
     and B is indexed                                    → zero memory
   → catastrophic if A has      → one pass over each     → free if the inputs
     10M rows                     side, but B must         arrive sorted
                                  fit in memory
```

**The classic production incident:** statistics say a filter returns 10 rows, so the optimizer picks a nested loop. Reality is 2 million rows. The plan does 2 million index lookups instead of one hash build, and a query that should take 200 ms takes 40 minutes. Nothing changed except the data distribution.

:::goat Why plans go bad without any code changing
Three causes, in order of frequency:

1. **Stale statistics.** The table grew or the distribution shifted and `ANALYZE` hasn't run. The optimizer is planning against last month's data.
2. **Correlated predicates.** `WHERE city = 'Mumbai' AND country = 'India'` — the optimizer multiplies the two selectivities as if independent, estimating maybe 0.001 × 0.02 of the table. In reality the second predicate adds nothing once the first is applied, so the true count is ~1000× higher than estimated. Multi-column statistics or extended statistics objects fix this; most databases don't create them by default.
3. **Parameter sniffing.** The plan was compiled for `country = 'MT'` (200 rows) and cached, then reused for `country = 'IN'` (40 million rows). Same query text, wildly wrong plan.

Naming *which* of these you'd check, and in what order, is the difference between "I'd look at the query plan" and knowing what you're looking for.
:::

## Cardinality estimation, and why it's hard

Everything hinges on one number per operator: **how many rows will come out of this?** Get it right and the plan is usually right. Get it wrong and it compounds up the tree.

Estimation works from statistics gathered by sampling:

- **Histograms** — the value distribution of a column, in buckets. Answers "how many rows have `age > 40`?"
- **Distinct counts (NDV)** — how many unique values. Drives join size estimates.
- **Most-common-values lists** — explicit counts for skewed values, so a value that's 30% of the table isn't averaged away.
- **Correlation** — how well the physical row order matches the index order, which decides whether an index scan is sequential or random I/O.

:::derive How estimation errors compound
```
   Three-way join, each join estimated 2× too low:

     Join 1:  estimate 1,000     actual 2,000     (2× off)
     Join 2:  estimate 10,000    actual 40,000    (4× off)
     Join 3:  estimate 100,000   actual 800,000   (8× off)

   Errors MULTIPLY as they propagate up the tree.

   → Deep join trees are where optimizers fail worst, and
     why hand-written queries with 12 joins are risky even
     when each individual estimate is "close enough".
```
:::

This is a fundamental limitation, not an implementation gap. It's why some systems now use **adaptive execution**: start executing, count the rows actually produced, and re-plan the remainder if reality diverges from the estimate. Spark's AQE and modern SQL Server both do this.

:::trap "The optimizer will figure it out"
Optimizers are excellent at plans with 2–4 tables and increasingly unreliable past 8–10, because the plan space grows factorially and the estimates compound.

Practical consequences: prefer a few well-shaped queries to one enormous one; materialise intermediate results when a join tree gets deep; and check `EXPLAIN ANALYZE` for the ratio of estimated to actual rows — a ratio above ~10× at any node is the thing to fix, and fixing it usually means better statistics rather than a query rewrite.
:::

## Reading EXPLAIN properly

`EXPLAIN` shows the plan. `EXPLAIN ANALYZE` runs it and shows what actually happened, which is the only version worth looking at.

What to look for, in order:

1. **Estimated vs actual rows** at every node. This is the single highest-value signal. A 1000× discrepancy tells you the optimizer was working from bad information, and everything above that node is consequently wrong.
2. **The most expensive node**, not the top one. Time is reported cumulatively in most systems; you want the node where it was actually spent.
3. **Sequential scan on a large table** where you expected an index. Usually means the index is unusable — a function applied to the column, a type mismatch, a leading wildcard, or the optimizer correctly deciding the index isn't selective enough.
4. **Spills to disk.** "Sort Method: external merge, Disk: 480MB" means `work_mem` was too small and the sort went to disk — often a 10–100× penalty for a config value.
5. **Nested loop with a large outer side.** The blowup described above.
6. **Rows removed by filter.** If a scan reads 10M rows and filters out 9.99M, you needed a different index.

## Vectorized execution

The Volcano model's `next()`-per-row design has an overhead problem: for every single row, you pay a virtual function call, a branch, and a trip through the operator's state.

```diagram
   ROW-AT-A-TIME (Volcano)         VECTORIZED (batch-at-a-time)

   for each row:                   for each batch of ~1,024 rows:
     next() → virtual call           process the whole batch
     branch on operator type         in a tight loop
     process 1 value

   ~50-200 ns of overhead          overhead amortised over 1,024 rows
   per row per operator            → ~1-5 ns per row
                                   → the loop vectorizes to SIMD
                                   → branch predictor actually works
                                   → data stays in L1/L2
```

The gain is 10–100× on analytical scans, and it comes entirely from amortising interpreter overhead and giving the CPU a loop it can optimise. Combined with a [columnar layout](olap-columnar.html) — where a batch is a contiguous run of one column's values — it's the reason modern analytical engines (DuckDB, ClickHouse, Velox, Photon) are so much faster than traditional row engines on the same hardware.

**The other approach is compilation:** generate machine code for the specific query, eliminating the interpreter entirely. Faster still for long queries, but it pays a compile cost per query, so systems typically compile only when the query is expected to run long enough to earn it.

:::goat Where the two models each belong
Vectorized execution is a win for **analytical** queries that touch millions of rows, because the overhead being amortised is per-row.

For an **OLTP** point lookup returning one row, batching does nothing — there's nothing to amortise, and the added machinery is pure cost. This is a large part of why OLTP and OLAP engines remain architecturally distinct rather than converging: they're optimising fundamentally different quantities.
:::

## Exercise

:::exercise Predict, then explain
Take any table you have with a few million rows and:

1. Run `EXPLAIN ANALYZE` on a query with a selective `WHERE` and one join. Before reading it, predict the join algorithm and the row counts. How close were you?
2. Add a second, *correlated* predicate (two columns that imply each other). Compare estimated to actual rows. How far off is the optimizer, and why?
3. Force the wrong join algorithm (`SET enable_hashjoin = off` in Postgres, or a hint elsewhere). By how much does the runtime change? Does the ratio match what the cost model predicted?
4. Reduce `work_mem` until the sort spills to disk. Measure the difference. Was it 10× or 100×?
:::

:::paper Sources
*Access Path Selection in a Relational Database Management System* (Selinger et al., 1979) invented cost-based optimization and is still the structure every optimizer uses.

*Volcano — An Extensible and Parallel Query Evaluation System* (Graefe, 1994) is the iterator model. *MonetDB/X100: Hyper-Pipelining Query Execution* (Boncz et al., CIDR 2005) is where vectorized execution comes from.

*How Good Are Query Optimizers, Really?* (Leis et al., VLDB 2015) is the empirical demolition of cardinality estimation and the best single paper on why plans go wrong.
:::

## What to carry forward

- The plan, not the SQL, determines runtime — and the plan hinges on **cardinality estimates**.
- **Three join algorithms**, each with a regime where it's right and one where it's catastrophic.
- **Estimation errors multiply up the tree**, which is why deep join trees are fragile.
- Read `EXPLAIN ANALYZE` for **estimated vs actual rows** first; everything else is downstream of that ratio.
- **Vectorized execution** amortises interpreter overhead over batches — a 10–100× analytical win, and no help at all for point lookups.
