---
title: Unique ID Generation
summary: Why auto-increment breaks when you shard, the Snowflake layout, UUID versions, and how to get sortable IDs without a coordinator.
difficulty: Medium
scope: HLD
tags: [id, snowflake, uuid, distributed]
prereqs: [sharding]
---

## The requirements

Every distributed system needs to mint identifiers. The requirements conflict, which is what makes it an interview question:

1. **Unique** — globally, forever, with no coordination on the hot path.
2. **Sortable by time** — so range queries work, pagination is natural, and B-tree inserts stay sequential.
3. **Compact** — 64 bits fits a `BIGINT` and an integer register; 128 bits doesn't.
4. **High throughput** — millions per second, generated locally.
5. **Non-guessable** (sometimes) — sequential IDs leak volume and enable enumeration of other users' resources.

Requirements 2 and 5 are in direct opposition; that tension is the heart of the discussion.

## Auto-increment: why it stops working

A single database's `AUTO_INCREMENT` is perfect until you shard. Then every shard would produce ID 1, 2, 3 — collisions everywhere.

**Patch 1 — stepped increments.** Shard *k* of *N* starts at *k* and steps by *N*: shard 0 gives 0, 4, 8; shard 1 gives 1, 5, 9. Works, but adding a shard breaks the scheme entirely.

**Patch 2 — a central ID service.** One database hands out IDs. Now you have a single point of failure and a network round trip on every insert.

**Patch 3 — ticket/range allocation.** The central service hands out **blocks** ("you own 10,000–19,999"). Servers allocate locally and fetch a new block when low. This is genuinely good: coordination amortizes to near zero, and it's what several large systems actually use. Downsides: IDs are only roughly time-ordered across servers, and a server that dies wastes its unused block (harmless — you have 2⁶³ of them).

## Snowflake IDs

The standard answer, and the one to lead with. A 64-bit integer, coordination-free after startup:

```diagram
   ┌─┬───────────────────────┬──────────┬────────────┐
   │0│      timestamp        │ machine  │  sequence  │
   │ │      41 bits          │ 10 bits  │  12 bits   │
   └─┴───────────────────────┴──────────┴────────────┘
     ▲         ▲                  ▲            ▲
   sign    ms since a         1024 nodes   4096 per ms
   (always custom epoch                    per node
    0 = positive)  ~69 years
```

**Why each field is that size:**
- **41 bits of milliseconds** ≈ 69 years from your chosen epoch. Use a *custom* epoch (your project's start date), not the Unix epoch, or you burn decades of range immediately.
- **10 bits of machine ID** = 1,024 generators. Assigned via ZooKeeper/etcd, or derived from a pod ordinal or private IP.
- **12 bits of sequence** = 4,096 IDs per millisecond per node = **4M/s per node**, ~4 billion/s across the cluster.

**Properties you get:** globally unique with zero coordination after machine-ID assignment; **k-sortable** (roughly time-ordered, since the timestamp is the high-order component); compact; and locally generated, so no network call.

**The two failure modes to name — this is where the depth is:**

1. **Clock skew.** Machine IDs prevent collisions between nodes, but if a single node's clock jumps *backwards* (NTP correction, VM migration), it can regenerate timestamps it already used and produce duplicates. Standard handling: detect that `now < last_timestamp` and either spin until the clock catches up (safe, briefly blocks) or refuse to serve and alert. Never silently proceed.
2. **Sequence exhaustion.** More than 4,096 IDs in one millisecond on one node means waiting for the next millisecond. Fine in practice, but it's a bounded throughput per node and you should say so.

:::goat The clock-skew answer
"Snowflake's correctness depends on monotonic clocks per node. If NTP steps the clock backwards, I could reissue timestamps and generate duplicates. I'd track the last timestamp issued and, if the clock goes backwards by a small amount, block until it catches up; if it's a large jump, take the node out of rotation and alert rather than risk duplicates. I'd also use a monotonic clock source where available."

It is easy to overlook, and it is the single most interesting property of the scheme.
:::

## UUIDs

128 bits, generated with no coordination at all.

**UUIDv4** — 122 random bits. Collision probability is negligible (you'd need on the order of 10¹⁸ UUIDs for a 50% chance). Zero coordination, unguessable.

**The problem:** randomness destroys locality. In a clustered index (InnoDB), rows are stored in primary key order, so random keys mean every insert lands in a random page — page splits, fragmentation, and a working set that can't stay cached. On a large table this can be several times slower than sequential inserts. This is a *real* production issue and a great thing to raise.

**UUIDv7** — the modern fix, and what to recommend today. A 48-bit Unix millisecond timestamp followed by random bits:

```diagram
   ┌────────────────────┬──────┬─────────────────────┐
   │ unix_ts_ms (48)    │ ver  │  random (74 bits)   │
   └────────────────────┴──────┴─────────────────────┘
```

Time-ordered like Snowflake, uncoordinated like v4, standard across languages. It costs 128 bits instead of 64 and reveals creation time — but it solves the index-locality problem cleanly. **For most systems, UUIDv7 is the right default**, with Snowflake reserved for when 64-bit compactness genuinely matters.

**UUIDv1** — timestamp plus MAC address. Time-ordered but leaks the host MAC and orders bytes badly for sorting. Avoid.

## Sortable vs unguessable

You usually can't have both, and the correct answer is to stop trying.

Sequential and time-ordered IDs leak information: a competitor can register two accounts an hour apart and read your signup rate off the ID delta; an attacker can enumerate `/orders/1001`, `/orders/1002`.

The clean resolution is **two identifiers**:

```diagram
   internal_id  BIGINT       Snowflake/sequence — PK, joins, indexes
   public_id    TEXT         random 128-bit, base62 — URLs, APIs
```

The database gets locality and compactness; the outside world gets an opaque token. Add an index on `public_id` for lookups.

**Never rely on unguessable IDs as authorization.** Object-level access control still has to check that the requester owns the resource — an unguessable ID is defense in depth, not a permission system. Saying this is a small security-awareness signal that lands well.

## Short IDs for URLs

For a [URL shortener](../05-case-studies/url-shortener.html) you need something *human-typable* — 7 characters, not 20.

**Base62 encoding** (`0-9a-zA-Z`) of a counter gives 62⁷ ≈ 3.5 trillion combinations in 7 characters. Sequential counters make these guessable and enumerable, so the usual fix is either to encode a **pre-generated randomly-shuffled key** taken from a pool, or to encrypt the counter with a format-preserving cipher so the output looks random but remains a bijection (no collisions, ever, and no lookup table).

**Hash-then-truncate** (take the first 7 chars of an MD5) is the tempting alternative and it's worse: truncation makes collisions likely well before you exhaust the space (birthday bound), so you need a collision check and retry loop on every insert.

## Choosing

| Situation | Choice |
|---|---|
| General-purpose modern default | **UUIDv7** |
| Need 64-bit, very high throughput, time-ordered | **Snowflake** |
| Single database, no sharding planned | `BIGSERIAL` — don't over-engineer |
| Sharded SQL, want dense sequential IDs | Ticket/range allocation service |
| Public-facing, must be unguessable | Random 128-bit `public_id` + internal numeric PK |
| Short, typable codes | Base62 over a shuffled/encrypted counter |

:::interview Don't over-answer
If the prompt has one database and no sharding, `BIGSERIAL` is the correct answer and proposing a Snowflake service is over-engineering. Say the threshold out loud: "A database sequence handles this fine. I'd move to Snowflake or UUIDv7 when we shard, because that's the point at which a single sequence stops working." Matching the solution to the scale is itself the thing being tested.
:::

:::exercise Compare the schemes
1. UUIDv4 as a primary key in a B-tree with 200M rows. Explain the write amplification, and estimate the difference versus a time-ordered ID.
2. Snowflake gives 64 bits: timestamp, worker ID, sequence. Choose the bit allocation for a system needing 10,000 IDs/second/node, 500 nodes, and a 50-year lifespan.
3. Your clock steps backwards by 3 seconds due to NTP. What does a Snowflake generator do? What *should* it do?
4. You need IDs that are unguessable *and* sortable. Are those compatible? Design something that satisfies both, or explain why you cannot.
5. Compute the collision probability for a 128-bit random ID at 10^12 IDs. Is the birthday bound a real concern here?
:::

:::paper ID schemes in production
Twitter's Snowflake announcement (2010) is the origin of the timestamp-worker-sequence layout that most systems now copy. Instagram's engineering post on sharded ID generation in Postgres is a good example of doing it inside the database.

*ULID* and *UUIDv7* (RFC 9562, 2024) are the modern standards — both time-ordered, which matters enormously for B-tree insert locality. Read the RFC section on why UUIDv4 is bad as a primary key.
:::
