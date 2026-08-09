---
title: Geospatial Indexing
summary: Why B-trees fail on two dimensions, and how geohash, quadtrees, S2 and H3 turn "find things near me" into a one-dimensional range query.
difficulty: Medium
tags: [geo, geohash, quadtree, proximity]
prereqs: [indexing, sharding]
---

## The problem

"Find all restaurants within 5 km of me." The naive query:

```sql
SELECT * FROM places
WHERE lat BETWEEN 18.47 AND 18.56 AND lng BETWEEN 73.80 AND 73.90;
```

Why this performs badly: a B-tree index is **one-dimensional**. An index on `(lat, lng)` can seek on `lat` efficiently, then must filter every row in that latitude band by longitude. A latitude band spans the entire planet — millions of rows to scan and discard.

Two separate indexes aren't better: the database intersects two large result sets, both huge.

**The core insight behind every solution below:** convert two dimensions into one, in a way that keeps nearby points nearby in the resulting order. Then a B-tree works again.

## Geohash

Recursively subdivide the world, encoding the choices as bits, and render as base32.

```diagram
   Split longitude [-180,180] in half:  east → 1, west → 0
   Split latitude  [-90,90]   in half:  north → 1, south → 0
   Interleave the bits, alternating lng/lat, and recurse.

   Result:  "tdr1v2q"  ← more characters = smaller box

   1 char  ≈ 5000 km      5 chars ≈ 5 km
   2 chars ≈ 1250 km      6 chars ≈ 1.2 km
   3 chars ≈ 156 km       7 chars ≈ 150 m
   4 chars ≈ 39 km        8 chars ≈ 38 m
```

**The property that makes it work:** shared prefixes mean spatial proximity. `tdr1v2q` and `tdr1v2r` are adjacent cells. So a proximity search becomes a **prefix query**, which any B-tree, key-value store, or `LIKE 'tdr1v%'` can serve:

```sql
SELECT * FROM places WHERE geohash LIKE 'tdr1v%';
```

**Two flaws you must mention:**

1. **Boundary problem.** Two points 10 metres apart can sit in different cells with completely different prefixes — right at a major grid line, they share almost no prefix. The fix: always query the target cell **plus its 8 neighbours**, then filter by true distance.

2. **Non-uniform cell size.** Cells shrink toward the poles because longitude lines converge. A "5 km" cell is 5 km at the equator and much narrower in Norway.

:::interview The full geohash answer
"I'd store a geohash prefix and query the cell plus its eight neighbours, then compute exact haversine distance and filter — the neighbour query is necessary because two nearby points can fall on opposite sides of a cell boundary and share no prefix. I'd pick precision based on the search radius: 6 characters for a ~1 km search."

Naming the boundary problem *and* the 8-neighbour fix is the whole test here. Candidates who describe geohash without it have read about it but not used it.
:::

## Quadtree

A tree that subdivides space **adaptively**: a node splits into four quadrants only when it exceeds a capacity threshold.

```diagram
   ┌─────────┬─────────┐      Dense areas (cities) subdivide deeply.
   │ ┌──┬──┐ │         │      Empty areas (ocean) stay one big node.
   │ ├──┼──┤ │         │
   │ └──┴──┘ │         │      → each leaf holds a bounded number
   ├─────────┼─────────┤        of points, so query cost is
   │         │         │        predictable regardless of density
   │         │         │
   └─────────┴─────────┘
```

**Advantage over geohash:** it adapts to density. Geohash uses fixed cell sizes, so a Manhattan cell contains 50,000 restaurants while a rural cell contains two — very different query costs. A quadtree gives every leaf roughly the same population.

**Costs:** it's an in-memory structure (not a simple index you add to a table), it must be rebuilt or rebalanced as data changes, and distributing it across machines is harder than sharding on a geohash prefix.

Good fit for a proximity service holding a large but bounded set of static points in memory. Less good for high-churn data across many nodes.

## S2 (Google) and H3 (Uber)

The two modern production systems, and knowing the difference is a strong signal.

**S2** projects the sphere onto the six faces of a cube, then applies a **Hilbert curve** to order cells within each face.

The Hilbert curve is the important part: it has better locality than the bit-interleaving of geohash — points close in 1D order are reliably close in 2D space, and the pathological boundary discontinuities are much rarer. S2 cells are also far more uniform in area than geohash cells, and every cell has a 64-bit ID, so it's just an integer range query.

**H3** uses **hexagons** instead of squares. The advantage is subtle and real: a hexagon's six neighbours are all **equidistant** from its centre, while a square's eight neighbours are not (diagonal neighbours are 1.41× further). For anything modelling movement, coverage, or spatial averaging — surge pricing zones, delivery areas, demand heatmaps — hexagons behave much better.

The catch: hexagons can't tile perfectly hierarchically (a hexagon can't be subdivided into smaller hexagons exactly), so H3's parent/child relationships are approximate. S2's squares nest perfectly.

**Choosing:** S2 when you need exact hierarchical containment and region coverage; H3 when you're doing analytics over movement or spatial aggregation.

## PostGIS and R-trees

If you're already on Postgres, the pragmatic answer is often "use PostGIS," and saying so shows you don't reach for a new system unnecessarily:

```sql
CREATE INDEX places_geo ON places USING GIST (location);

SELECT * FROM places
WHERE ST_DWithin(location, ST_MakePoint(73.85, 18.52)::geography, 5000)
ORDER BY location <-> ST_MakePoint(73.85, 18.52)::geography
LIMIT 20;
```

GiST implements an **R-tree**: nested bounding rectangles, where a search descends only into boxes that intersect the query region. It handles polygons, distance ordering, and true geodesic math correctly — and the `<->` operator does an efficient k-nearest-neighbour search directly from the index.

For millions of static points and modest QPS, this is genuinely the right answer, and it's one system instead of two.

## Moving objects — the hard case

Static points (restaurants) are easy. **Moving points** (drivers, delivery riders) are the interesting problem, and it's the core of the [ride sharing](../05-case-studies/ride-sharing.html) design.

The challenge is write volume: 1M drivers reporting position every 4 seconds is **250K writes/s**, each of which may change the driver's cell.

Design responses:

- **Keep it in memory.** Live positions belong in Redis or an in-process index, not a disk-backed database. This is ephemeral, high-churn data — durability is nearly worthless, since a 4-second-old position is already stale.
- **Redis geospatial commands** (`GEOADD`/`GEOSEARCH`) implement geohash on top of sorted sets and handle this workload well.
- **Update only on cell change.** If a driver hasn't left their cell, the index doesn't need updating — just the position value. This removes most index writes.
- **Shard by region.** Positions in Pune don't need to be in the same index as positions in Berlin. Geographic sharding is natural here and gives you locality for free.
- **Reduce frequency adaptively.** A stationary driver doesn't need 4-second updates; a fast-moving one does.

## Choosing

| Situation | Approach |
|---|---|
| Postgres already, millions of static points | **PostGIS + GiST** |
| Simple proximity, key-value store | **Geohash prefix + 8 neighbours** |
| In-memory, highly variable density | **Quadtree** |
| Region coverage, hierarchical containment | **S2** |
| Movement analytics, zones, heatmaps | **H3** |
| Live positions of moving objects | **Redis GEO**, sharded by region |

Whichever you pick, the final step is always the same and always worth stating: **the index gives you candidates, not answers.** Cells are rectangles (or hexagons) and your query is a circle, so you must compute true distance on the candidate set and filter. The index's job is to reduce millions of rows to dozens; exact math finishes the job.

:::exercise Index the map
1. 10M drivers reporting position every 4 seconds. Compute the write rate and choose an index. What breaks with a B-tree on `(lat, lng)`?
2. Geohash: two points 50 metres apart can have completely different prefixes. Show why, and say how S2 and H3 address it.
3. "Find all drivers within 2 km." Walk through the query under geohash, S2, and a quadtree. Which does the fewest comparisons?
4. Density varies by 1,000× between a city centre and a rural area. What does a fixed-resolution grid do, and what is the fix?
5. Design the moving-object update path: is it cheaper to update an index in place, or to keep positions in memory and rebuild? Estimate both.
:::

:::paper Spatial indexing
Guttman's *R-trees: A Dynamic Index Structure for Spatial Searching* (SIGMOD 1984) is the original spatial index. Google's S2 library documentation explains the Hilbert-curve cell decomposition and why it beats naive geohashing at cell boundaries.

Uber's engineering post on H3 covers hexagonal indexing and the specific reason hexagons beat squares for movement and neighbour analysis.
:::
