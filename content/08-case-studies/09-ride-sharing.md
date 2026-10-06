---
title: Design a Ride-Sharing Service (Uber / Lyft)
summary: Millions of moving objects, geospatial matching under a latency budget, and a trip state machine that must survive every kind of failure.
difficulty: Hard
scope: HLD
tags: [case-study, geospatial, realtime, matching]
prereqs: [geospatial, realtime, sharding]
---

:::predict Guess first
1. 5 million drivers each send their location every 4 seconds. Should each update be written to a disk-backed database?
2. Is the nearest driver as the crow flies always the fastest one to reach the rider?
3. Two riders request at once and both are offered the same driver. How do you make sure only one gets them?
:::

:::interview Why this question
Two hard problems in one: **high-frequency writes of moving locations** (a workload unlike anything else in this curriculum) and **spatial matching** under a tight latency budget. It also has a genuine state machine with money attached, so failure handling gets probed hard.
:::

## 1. Requirements

**Functional**
- Drivers broadcast their location continuously.
- A rider requests a ride from A to B; the system matches a nearby driver.
- Both parties see each other's live location during the trip.
- Trip lifecycle: requested → matched → en route → in progress → completed → paid.
- Fare estimation and calculation.

**Non-functional**
- Matching within a few seconds.
- Location updates at high volume with low latency.
- **A trip must never be lost or double-assigned.**
- Availability matters — a failure means people stranded.

**Cut:** pricing/surge algorithms (mention surge exists and is computed per zone), routing/ETA internals (assume a maps service), payments internals, driver onboarding.

**Clarifying questions:** Scale — how many concurrent drivers? Matching optimization goal: nearest driver, shortest ETA, or global efficiency? Do we support scheduled rides and pooling? (Pooling is a substantially harder matching problem — worth flagging as out of scope.)

## 2. Estimation

**5M active drivers**, 1M concurrent trips, location updates every 4 seconds.

```diagram
   LOCATION WRITES — the defining number
     5M drivers / 4 s = 1,250,000 writes/s

   → This CANNOT go to a disk-backed database. It's ephemeral,
     high-churn data where a 4-second-old value is already
     worthless. In-memory only.

   Payload: driver_id 8 + lat/lng 16 + heading/speed 8 + ts 8
            ≈ 40 B → 50 MB/s of raw location data

   Working set: 5M drivers × ~200 B (with index overhead)
              = 1 GB   ← trivially fits in memory ✓

   Matching: ~100,000 ride requests/s at peak
   Trip records: 20M trips/day × 1 KB = 20 GB/day (durable, small)
```

**What this decided:**
1. **1.25M writes/s of disposable data → Redis/in-memory geospatial index**, never Postgres.
2. **1 GB working set → it fits**, so the design is about write throughput, not storage.
3. **Trip records are small and must be durable → a separate transactional store.**

The split between *ephemeral location* and *durable trip state* is the core architectural insight. State it early.

## 3. High-level design

```diagram
   ┌─────────┐  location every 4s   ┌──────────────────┐
   │ driver  │────────────────────► │ Location service │
   │  app    │                      │  (WebSocket)     │
   └─────────┘                      └────────┬─────────┘
                                             ▼
                                   ┌──────────────────┐
                                   │  Redis GEO       │  sharded
                                   │  (sharded by     │  by city/
                                   │   geo region)    │  region
                                   └────────┬─────────┘
                                            │ query
   ┌─────────┐   request ride    ┌──────────▼─────────┐
   │  rider  │──────────────────►│  Matching service  │
   │   app   │                   └──────────┬─────────┘
   └─────────┘                              ▼
                                  ┌────────────────────┐   ┌─────────┐
                                  │   Trip service     │──►│Postgres │
                                  │  (state machine)   │   │ (trips) │
                                  └─────────┬──────────┘   └─────────┘
                                            ▼
                                  ┌────────────────────┐
                                  │ Kafka → pricing,   │
                                  │ analytics, payments│
                                  └────────────────────┘
```

## 4. Deep dive — the location pipeline

**Don't persist every update.** This is the key optimization, and the one most often implemented incorrectly.

```diagram
   Every 4 s per driver:
     1. Update the in-memory geo index         ← always
     2. Publish to Kafka                       ← for trip
                                                 replay/analytics
     3. Write to a durable database            ← NO. Never.
```

The current position lives in memory. The *history* goes to Kafka for asynchronous processing (trip path reconstruction, fare verification, analytics). The durable database only ever sees trip-level records.

**Further reductions worth naming:**
- **Adaptive frequency** — a stationary driver doesn't need 4-second updates; a driver on a highway does. This alone can halve the write volume.
- **Only update the index on cell change.** The map is divided into small cells, and the index answers "who is in this cell". A driver moving a few metres is usually still in the same cell — so record their new coordinates, but skip rewriting the index, because the answer it gives hasn't changed.
- **Batch updates** from the connection tier rather than one write per driver per tick.

**Sharding:** by geographic region (city). Locations in Pune never need to be queried alongside locations in Berlin. Geographic sharding gives perfect locality here — the query and the data are both inherently local. Cross-region queries essentially don't exist, which is a rare and pleasant property.

## 5. Deep dive — spatial matching

Given a rider at (lat, lng), find nearby available drivers within a latency budget.

Full mechanics in [Geospatial Indexing](../02-building-blocks/geospatial.html). The practical implementation:

```diagram
   Redis: GEOADD drivers:pune <lng> <lat> <driver_id>
          GEOSEARCH drivers:pune FROMLONLAT <lng> <lat>
                    BYRADIUS 3 km ASC COUNT 20

   Redis GEO is geohash over a sorted set — exactly the
   right structure, and it handles this workload well.
```

**The matching algorithm is more than "nearest":**

```diagram
   1. Query candidates within an expanding radius
      (1 km → 3 km → 5 km; stop when enough candidates)
   2. Filter: available, correct vehicle class, not already
      assigned, acceptable rating, not about to end a shift
   3. Rank by ETA (which needs the road network, not straight-line
      distance — a driver 500 m away across a river may be
      15 minutes out)
   4. Offer to the best candidate; on decline or timeout (~15 s),
      offer to the next
```

:::goat Straight-line distance is the wrong metric
"I'd rank by ETA rather than Euclidean distance. Geospatial indexes give me candidates by straight-line proximity, which is the right *filter* because it's cheap — but the driver 500 metres away on the wrong side of a river or a one-way system may be much further in time than one 2 km away on a main road. So the index narrows millions of drivers to twenty, and then I call the routing service for real ETAs on just those twenty. Two-stage retrieval keeps the expensive computation bounded."

This retrieve-then-rank structure appears in [search](../02-building-blocks/search.html) too, and recognizing it as a general pattern reads well.
:::

**Avoiding double-assignment.** Two riders must not be matched to the same driver.

The clean solution is a **conditional update** on the driver's state:

```sql
UPDATE drivers SET status='ASSIGNED', trip_id=:t
WHERE driver_id=:d AND status='AVAILABLE';
-- 0 rows → already taken, try the next candidate
```

No distributed lock needed. The atomic compare-and-set *is* the mutual exclusion, and it's naturally fenced. Combined with a short offer TTL (if the driver doesn't accept in 15 s, the assignment expires and the driver returns to available), you get the same reserve-with-TTL pattern as [ticket booking](ticket-booking.html).

## 6. Deep dive — the trip state machine

Money and physical people are involved, so state transitions must be explicit, durable, and idempotent.

```diagram
   REQUESTED ──► MATCHED ──► DRIVER_ARRIVING ──► IN_PROGRESS
       │            │                                 │
       │            │ driver cancels                  ▼
       ▼            ▼ → back to REQUESTED         COMPLETED
   CANCELLED    (rematch)                             │
                                                      ▼
                                                 PAYMENT_PENDING
                                                      │
                                                      ▼
                                                     PAID
```

**Properties to design in, and to say out loud:**

- **Every transition is a conditional update** guarded by the current state, so a duplicate request (from a retry or a flaky mobile network) is a no-op rather than a double transition.
- **Every transition is durable before it's acknowledged.** A trip must never exist only in memory.
- **Transitions publish events** to Kafka for pricing, notifications, and analytics — asynchronously, so a slow analytics consumer can't delay a ride starting.
- **Timeouts on every waiting state.** A driver who doesn't arrive, a rider who doesn't show — each needs a defined expiry and resolution.

**Shard trips by `trip_id`** (or by city). Trip state is small and transactional; keep it in a relational store where you get real transactions.

## 7. Live tracking during the trip

Rider and driver each need the other's live position.

```diagram
   Driver's location update → pub/sub channel trip:{trip_id}
   Rider's app subscribes to that channel over WebSocket
```

This is the [real-time delivery](../02-building-blocks/realtime.html) problem, scoped narrowly: a channel per active trip, with exactly two subscribers. Simple, and it means location fanout is bounded by trip count rather than driver count.

**Client-side smoothing matters:** send updates every ~4 s but interpolate the marker's movement on the client, so the map animates smoothly rather than teleporting. A small detail that shows product awareness.

## 8. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| Driver app loses connectivity | Location goes stale. After ~30 s, mark unavailable and exclude from matching. If mid-trip, the trip continues — buffer locations on device and upload on reconnect. |
| Redis geo shard dies | That city loses matching until failover. **Bounded blast radius by design** — one city, not the platform. Drivers re-register position on reconnect, so the index rebuilds within seconds. |
| Matching service dies mid-offer | The offer TTL expires; the driver returns to available; the rider's request is retried. No state is lost because the request is durable. |
| Trip DB primary fails | New trips can't start (correct — better than losing trips). Failover with zero RPO; in-progress trips continue on the client and reconcile after. |
| Payment fails after trip | Trip stays in `PAYMENT_PENDING`; retry asynchronously. The ride already happened — this is **forward recovery**, not compensation. |

**Follow-ups:**
- *"Surge pricing?"* — compute demand/supply ratios per geographic cell ([H3 hexagons](../02-building-blocks/geospatial.html) are well suited, since neighbours are equidistant) on a rolling window, published as a multiplier. Eventually consistent by nature and fine.
- *"Ride pooling?"* — a much harder matching problem: you're now solving a dynamic vehicle routing problem with detour constraints. Batch matching over short windows beats greedy per-request assignment. Flagging the difficulty honestly is better than hand-waving.
- *"Why not a database with PostGIS?"* — it would handle the *queries* fine, but not 1.25M writes/s of ephemeral data. The read pattern suits it; the write pattern doesn't. Naming exactly which half fails is the precise answer.
- *"How do you prevent a driver gaming location?"* — server-side plausibility checks (speed between updates, GPS accuracy metadata), and never trust client-reported distance for fare calculation — recompute from the recorded path.

## Check yourself

```recall
Q: What is the defining number in ride-sharing, and what does it force?
A: 5 million drivers ÷ 4 s ≈ 1.25 million location writes a second of data worthless after seconds — so an in-memory geospatial index, never a disk database. The working set is only about 1 GB.

Q: What is the core architectural split?
A: Ephemeral location (in memory, history to Kafka) versus durable trip state (small, transactional, in a relational store).

Q: How do you cut location write volume?
A: Never persist each update, adapt frequency to movement, only rewrite the index when a driver changes cell, and batch updates from the connection tier.

Q: Why shard locations by city?
A: Queries and data are inherently local — Pune never needs Berlin — so there are essentially no cross-shard queries, and a failed shard affects one city.

Q: How does matching work beyond "nearest"?
A: Query candidates in an expanding radius from the geo index, filter by availability and vehicle class, rank by road-network ETA from a routing service, then offer one at a time with a ~15 s timeout.

Q: How do you prevent double-assigning a driver?
A: A conditional UPDATE … SET status = 'ASSIGNED' WHERE status = 'AVAILABLE' — 0 rows means taken, try the next — plus an offer TTL that returns an unaccepted driver to available.

Q: What properties must trip state transitions have?
A: Conditional on the current state (retries are no-ops), durable before acknowledgement, events published asynchronously, and a timeout on every waiting state.

Q: Why not PostGIS for live locations?
A: It handles the queries fine but not 1.25 million writes a second of ephemeral data — the read pattern suits it, the write pattern doesn't.
```

## What to carry forward

- Separate ephemeral, high-churn location from durable trip records.
- Keep live locations in memory, sharded by city; send history to a log.
- Retrieve candidates by straight-line proximity, then rank by real ETA.
- A conditional update plus an offer TTL prevents double assignment without locks.
- Trip transitions are conditional, durable and timed; payment failures recover forwards.
