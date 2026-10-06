---
title: Build Uber
summary: A million moving objects, spatial matching under a latency budget, and a trip state machine with money attached.
difficulty: Hard
scope: HLD
level: 4
prereqs: [geospatial, realtime, ride-sharing, idempotency, distributed-locks]
tags: [level-4, geospatial, realtime, matching]
unlocks: Handling high-frequency ephemeral writes and spatial matching.
---

:::predict Guess first
1. Position data is worthless after 4 seconds; trip records must never be lost. Should they live in the same store?
2. The geo index returns 20 nearby drivers. Should you call the routing service for all of them, or for every driver in the city?
3. The ride has happened but payment fails. Should the trip be rolled back?
:::

## The product

A rider requests a ride. The system finds a nearby driver, both watch each other move on a map, the trip completes, payment settles.

**Two hard problems in one:** a write workload unlike anything earlier in this ladder, and a matching problem with a tight latency budget.

Full interview-format treatment lives in the [Ride Sharing case study](../case-studies/ride-sharing.html) — this build focuses on the phased construction.

## Estimation

```diagram
   5M active drivers, position every 4s

   LOCATION WRITES: 5M / 4s = 1,250,000 writes/s
   → This is the number that decides everything.

   Payload: ~40 B → 50 MB/s of raw position data
   Working set: 5M drivers × ~200 B = 1 GB   ← fits in memory easily

   Ride requests: ~100,000/s peak
   Trips: 20M/day × 1 KB = 20 GB/day        ← small, but must be durable
```

**The split that defines the design:** position data is *ephemeral and enormous* (1.25M writes/s, worthless after 4 seconds). Trip data is *durable and tiny* (20 GB/day, must never be lost). They belong in completely different systems.

## Phase 1 — Locations never touch a database

```diagram
   Every 4s per driver:
     1. update the in-memory geo index      ← always
     2. publish to Kafka                     ← for trip replay/analytics
     3. write to a durable database          ← NEVER
```

A 4-second-old position is already stale. Durability here is worth almost nothing, and a disk-backed store would collapse under 1.25M writes/s.

```diagram
   Redis: GEOADD drivers:pune <lng> <lat> <driver_id>
          GEOSEARCH drivers:pune FROMLONLAT <lng> <lat>
                    BYRADIUS 3 km ASC COUNT 20
```

Redis GEO is [geohash](../building-blocks/geospatial.html) over a sorted set — the right structure for exactly this.

**Three write reductions worth naming:** adaptive frequency (a stationary driver doesn't need 4-second updates), skip the index write when the driver hasn't left their cell, and batch from the connection tier rather than one write per tick.

**Shard by city.** Positions in Pune are never queried alongside Berlin. Geographic sharding gives perfect locality — the query and the data are both inherently local, and cross-region queries essentially don't exist.

## Phase 2 — Matching is two-stage

```diagram
   1. RETRIEVE  expanding radius (1km → 3km → 5km) from the geo index
                → ~20 candidates, cheap
   2. FILTER    available · vehicle class · not assigned · rating
   3. RANK      call the routing service for REAL ETAs on those 20
   4. OFFER     to the best; on decline/timeout (~15s), next
```

**Straight-line distance is the wrong ranking metric**, and saying so is the highest-value observation here. A driver 500m away across a river may be 15 minutes out; one 2km away on a main road is 4 minutes. The spatial index is a cheap *filter* that narrows millions to twenty; real ETAs are computed only on those twenty.

This shape — a cheap step that narrows millions to a shortlist, then an expensive step applied only to the shortlist — is called **retrieve-then-rank**, and it's the same pattern behind [search](../building-blocks/search.html) results and ranked feeds. Recognising it as general is worth points.

## Phase 3 — No double-assignment

Two riders must not be matched to the same driver.

```sql
UPDATE drivers SET status='ASSIGNED', trip_id=:t
WHERE driver_id=:d AND status='AVAILABLE';
-- 0 rows → already taken, try the next candidate
```

**No distributed lock needed.** That single statement only succeeds if the driver is still available at the moment it runs, so exactly one rider can win — the check and the change are one step, and a slow or paused server can't sneak in later. Pair it with a short expiry on the offer: if the driver doesn't accept within 15 seconds, the assignment lapses and they return to available. Same reserve-with-TTL pattern as [ticket booking](../case-studies/ticket-booking.html), and explicitly rejecting a Redis lock here (per [Distributed Locks](../building-blocks/distributed-locks.html)) is a strong move.

## Phase 4 — The trip state machine

```diagram
   REQUESTED → MATCHED → ARRIVING → IN_PROGRESS → COMPLETED
       │          │                                    │
       ▼          ▼ driver cancels → rematch           ▼
   CANCELLED                                    PAYMENT_PENDING → PAID
```

Every transition is a **conditional update guarded by current state**, so a duplicate request from a flaky mobile network is a no-op rather than a double transition. Every transition is durable before it's acknowledged. Every waiting state has a timeout.

**After the pivot — once the ride has happened — you roll forward, never back.** If payment fails, the trip stays in `PAYMENT_PENDING` and retries. The ride physically occurred; there's nothing to compensate.

## Phase 5 — Live tracking

```diagram
   driver position → pub/sub channel trip:{trip_id}
   rider's app subscribes over WebSocket
```

A channel per active trip with exactly two subscribers. Fanout is bounded by *trip* count, not driver count — which is what keeps it cheap.

**Interpolate on the client.** Send every 4s but animate smoothly between points, or the marker teleports. Small detail, real product awareness.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| Positions in memory only | Durable database | 1.25M writes/s of data worthless after 4s |
| Shard geo by city | Global index | Queries are inherently local; perfect locality |
| Rank by ETA | Straight-line distance | Rivers and one-way systems break Euclidean assumptions |
| Two-stage retrieve-then-rank | Route to all candidates | Routing calls are expensive; bound them to ~20 |
| Conditional UPDATE for assignment | Distributed lock | CAS is atomic, fenced, and simpler |
| Offer TTL | Explicit rollback | Expiry *is* the compensating action |
| Forward recovery after ride | Compensating transaction | The ride happened; it can't be undone |

## What you'd cut for v1

Pooling, surge, scheduled rides, multiple vehicle classes. Ship: request → match nearest available → track → complete → charge. **Pooling especially** — it's a dynamic vehicle routing problem with detour constraints, genuinely much harder, and flagging that honestly beats hand-waving it.

## Explaining the design

> "The defining number is 1.25M location writes per second. That's ephemeral data — worthless after four seconds — so it lives in an in-memory geo index sharded by city, never a durable database. Trip state is the opposite: small, transactional, must never be lost, so that's Postgres.
>
> Matching is two-stage: the geo index cheaply narrows millions of drivers to twenty candidates, then I call routing for real ETAs on just those twenty. Straight-line distance is the wrong metric — a driver across a river is close in space and far in time.
>
> Double-assignment is prevented with a conditional UPDATE guarded on status, not a distributed lock — the compare-and-set is atomic and naturally fenced. An offer TTL handles the driver who never responds, so expiry is the compensation rather than an explicit rollback."

## Next

[Build Google Docs](google-docs.html) — where the hard problem is an algorithm, not an architecture.

## Check yourself

```recall
Q: What split defines the Uber build?
A: Ephemeral, enormous position data (~1.25 million writes a second, worthless after seconds) in an in-memory geo index, versus durable, tiny trip data in Postgres.

Q: Why do locations never touch a durable database?
A: A 4-second-old position is stale, so durability buys nothing, and a disk-backed store would collapse under 1.25 million writes a second. History goes to Kafka.

Q: Name three ways to cut location writes.
A: Adaptive update frequency, skipping the index write when a driver hasn't left their cell, and batching from the connection tier.

Q: What is retrieve-then-rank in matching?
A: The geo index cheaply narrows millions of drivers to ~20 by straight-line distance; the expensive routing service computes real ETAs only for those 20.

Q: How is double assignment prevented?
A: UPDATE drivers SET status = 'ASSIGNED' WHERE driver_id = ? AND status = 'AVAILABLE' — check and change in one step — plus a 15-second offer TTL as the compensation.

Q: What rules govern the trip state machine?
A: Transitions conditional on the current state (duplicates are no-ops), durable before acknowledgement, a timeout on every waiting state, and forward recovery after the ride.

Q: How is live tracking kept cheap?
A: One pub/sub channel per active trip with two subscribers — fanout scales with trips, not drivers — and the client interpolates between 4-second updates.
```

## What to carry forward

- Separate ephemeral positions (memory, sharded by city) from durable trips (SQL).
- Match in two stages: cheap spatial filter, expensive ETA rank on a shortlist.
- A conditional update with an offer TTL replaces distributed locks.
- Trip transitions are conditional, durable and timed; recover forwards after the ride.
- Cut pooling from v1 — it's a much harder routing problem.
