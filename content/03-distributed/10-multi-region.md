---
title: Multi-Region Architecture
summary: Active-passive vs active-active, data residency, the latency floor you can't optimize away, and cell-based architecture for bounding blast radius.
difficulty: Hard
scope: HLD
tags: [multi-region, geo, disaster-recovery, cells]
prereqs: [replication, cap-pacelc, consensus]
---

## Why go multi-region

Four distinct motivations, and they demand different architectures. Establishing *which one* applies is the first move.

1. **Latency** — users far from your region pay 150–300 ms round trips. No server optimization touches that; only moving data closer does.
2. **Disaster recovery** — an entire region can fail. If that's unacceptable, you need capacity elsewhere.
3. **Data residency** — regulation may require certain users' data to physically stay in a jurisdiction.
4. **Scale** — rare, but some workloads exceed what one region can provide.

:::interview Push back before agreeing
Multi-region roughly doubles cost and multiplies complexity by considerably more. "Is this for latency, disaster recovery, or compliance? If it's DR, a warm standby with a 10-minute RTO is far cheaper than active-active. If it's latency, a CDN plus read replicas gets most of the benefit without distributing writes. I'd only go active-active for writes if we genuinely need sub-100ms writes globally or region-level availability." Interrogating the requirement is the senior move.
:::

## The latency floor

Physics sets the budget, and every design below is a response to this table:

| Route | RTT (real-world) |
|---|---|
| Same AZ | < 1 ms |
| Cross-AZ, same region | 1–2 ms |
| US East ↔ US West | ~60 ms |
| US ↔ Europe | ~80–100 ms |
| US ↔ Asia | ~150–200 ms |
| Antipodal | ~250–300 ms |

**Any synchronous cross-region operation costs at least one of these.** A write requiring acknowledgment from another continent cannot be fast. That single fact drives everything: either you accept the latency, or you accept weaker consistency.

## The patterns

### Active–passive (warm standby)

One region serves everything; another holds replicated data, ready to take over.

```diagram
   users ──► REGION A (active)  ══async replication══► REGION B
                                                       (standby)
   failover: promote B, repoint DNS/anycast
```

**Pros:** simple, no write conflicts, no distributed transactions, and your application is essentially unchanged.
**Cons:** the standby is idle capacity you pay for; failover is a real, risky operation; async replication means an RPO of seconds.

**Failover is the hard part.** Detecting region failure, promoting the database, redirecting traffic, and rehydrating caches takes 5–30 minutes if practiced and much longer if not.

The detail most designs miss: **an untested failover doesn't work.** Run regular game days that actually fail over. Otherwise the first real attempt discovers that a DNS TTL is 24 hours, a secret only exists in region A, and the standby database was three days behind.

### Active–active, partitioned writes (the sweet spot)

Both regions serve traffic, but each **entity has a home region** that owns its writes.

```diagram
   EU users → EU region (owns EU user data, writes locally)
   US users → US region (owns US user data, writes locally)

   Cross-region reads are served from async replicas
   A EU user's write always routes to the EU region
```

**This is the pattern to propose for most active-active requirements.** Both regions serve traffic and are warm (so failover is proven continuously), writes are local and fast, and — crucially — **there are no write conflicts**, because a given record has exactly one writer.

**Costs:** you need routing that knows each entity's home region; a user travelling abroad gets slower writes (usually fine); and cross-entity operations spanning regions need a [saga](distributed-transactions.html).

This also maps neatly onto **data residency** — the home region *is* the compliance boundary.

### Active–active, conflicting writes

Both regions accept writes to the same data. Now you must resolve conflicts:

- **Last-write-wins** — simple, lossy, and dependent on clocks you [can't trust](clocks.html).
- **[CRDTs](crdts.html)** — automatic convergence, when the data type allows.
- **Application merge** — correct, expensive to build for every type.

Only accept this when you truly cannot partition ownership. It's the most expensive option in engineering time and the most likely to produce subtle data bugs.

### Global consensus (Spanner-style)

Synchronous replication across regions via Paxos/Raft. Strong consistency everywhere.

**Cost:** every write pays a cross-region round trip — 100 ms+ globally, irreducibly. Correct for financial ledgers and global uniqueness constraints; wrong for a social feed.

Note the mitigation these systems use: place all replicas of a shard in *nearby* regions (e.g. three US regions) so the quorum round trip is 30 ms, not 200 ms — you get regional fault tolerance without paying the global latency.

## Data strategy

Classify your data — this is the analysis that produces a good design:

| Class | Example | Strategy |
|---|---|---|
| **Global, read-mostly** | Product catalog, config, feature flags | Replicate everywhere async; stale by seconds is fine |
| **User-partitioned** | Profiles, posts, orders | Home region per user; replicate for reads |
| **Region-local** | Sessions, caches, rate limits | Don't replicate at all — regenerate locally |
| **Globally consistent** | Balances, inventory, usernames | Consensus, or a single authoritative region |

The insight worth stating: **most data doesn't need global consistency.** Once you separate these classes, only a small core needs the expensive treatment, and everything else can be fast and local.

## Traffic routing

- **GeoDNS** — resolve to the nearest region. Universal, coarse (it sees the resolver, not the user), and slow to fail over due to TTL caching.
- **Anycast** — one IP advertised from everywhere; BGP routes to the nearest. Fast failover (route withdrawal), no DNS caching problem.
- **Application-level routing** — a lightweight global tier redirects to the correct home region. Necessary for partitioned-write architectures, because routing must follow *data ownership*, not geography.

**Capacity is the trap.** If region A fails and its traffic moves to region B, does B have room? Two regions each running at 70% cannot absorb each other. Tolerating single-region failure means running each at ≤50%, which is expensive — and this is exactly the kind of cost reasoning that distinguishes a senior answer. With three regions you only need ~33% headroom, which is why three often beats two.

## Cell-based architecture

The most valuable idea in this topic, and it applies well below multi-region scale.

Instead of one large system per region, run many independent **cells**, each a complete, self-contained stack serving a slice of users.

```diagram
   REGION
   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
   │  CELL 1  │ │  CELL 2  │ │  CELL 3  │ │  CELL 4  │
   │ lb·app·db│ │ lb·app·db│ │ lb·app·db│ │ lb·app·db│
   │ users A-F│ │ users G-M│ │ users N-S│ │ users T-Z│
   └──────────┘ └──────────┘ └──────────┘ └──────────┘
         ▲ thin routing layer maps user → cell
```

**Why this is powerful:**

- **Bounded blast radius.** A cell failing affects 1/N of users, not all of them. This changes an outage from "the product is down" to "8% of users are affected."
- **Deployment safety.** Roll out to one cell, watch, then proceed. A bad deploy is contained by construction — and since [most outages are caused by change](../01-fundamentals/availability-slas.html), this addresses the dominant failure cause directly.
- **Known scaling unit.** You've load-tested one cell, so capacity planning is multiplication rather than guesswork.
- **Testable failure.** Killing a cell in production is a survivable experiment.

**Costs:** the routing layer becomes critical (keep it dumb, static, and highly cached); cross-cell operations are awkward; per-cell overhead means lower utilization; and any truly global data must live outside the cells.

:::goat Bring up cells unprompted
It is rarely proposed, and it is what operational maturity actually looks like: rather than one large deployment per region, partition into cells of about 100K users each. That bounds the blast radius of any failure or bad deploy to a few percent of users, gives me a known scaling unit, and lets me do staged rollouts cell by cell. The tradeoff is a routing layer I need to keep extremely simple and highly available, plus lower per-cell utilization."
:::

## Things that break at multi-region scale

Worth having ready as a checklist:

- **Sequential IDs.** Two regions generating IDs from a shared sequence requires coordination on every insert. Use [UUIDv7 or Snowflake](../02-building-blocks/unique-id-generation.html) with region-encoded bits.
- **Uniqueness constraints.** "Unique username" cannot be enforced locally in two regions accepting writes. Either route all registrations through one region, or accept a reconciliation process.
- **Caches.** Invalidation across regions is asynchronous, so a stale entry can persist in one region after an update in another. Use short TTLs rather than trying to make invalidation synchronous.
- **Sessions.** Don't replicate them; use signed tokens so any region can validate without shared state.
- **Rate limits.** Global limits need cross-region coordination on the hot path. The usual answer is per-region limits at 1/N of the global budget, accepting imprecision.
- **Cross-region egress cost.** Often a genuinely large line item, and one that is routinely left out of estimates. Replicating everything everywhere is expensive in ways that show up on the bill rather than the diagram.

:::exercise Design across regions
1. Three regions, 150 ms apart. A write must be durable in two regions before acknowledgement. What is the floor write latency from each region?
2. Active-active versus active-passive versus regional sharding. For a global chat product, argue each and pick one.
3. A user travels from Singapore to London mid-session. What breaks, and how does your design handle it?
4. Region A is partitioned from B and C for 20 minutes. Walk through what each region does, and what reconciliation looks like when it heals.
5. Compute the cost difference between cross-region replication of everything versus regional sharding with cross-region reads. At what read/write ratio does each win?
:::

:::paper Geo-distribution
*Spanner* (Corbett et al., OSDI 2012) is the strongly-consistent globally-distributed design, and is explicit about the latency it pays. *Dynamo* (DeCandia et al., SOSP 2007) is the opposite pole.

*Don't Settle for Eventual: Scalable Causal Consistency for Wide-Area Storage with COPS* (Lloyd et al., SOSP 2011) is the middle ground — causal consistency across regions, which is often exactly what applications need.
:::
