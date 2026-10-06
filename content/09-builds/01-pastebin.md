---
title: Build Pastebin
summary: The simplest complete system design. One service, one database, one cache — and the exact numbers at which each stops being enough.
difficulty: Easy
scope: HLD
level: 1
prereqs: [back-of-envelope, sql-vs-nosql, caching]
tags: [level-1, storage, cache]
unlocks: The basic shape of every design — API, schema, cache, and the arithmetic that justifies each.
---

:::predict Guess first
1. Pastes never change after they're created. Why does that make caching unusually easy?
2. Paste bodies now total 500 GB inside database columns. What problems might that cause besides disk space?
3. Deleting 40 million expired rows every night locks the table. How could deleting a whole month be instant?
:::

## The product

A user pastes text, gets a short URL, shares it. Anyone with the URL reads the text. Optionally the paste expires, or is private.

That's it. Four operations: create, read, expire, delete.

:::interview Why start here
It's the smallest system that still has every part of a real design — an API, a schema, an ID scheme, a cache, and a storage decision. If you can't do this one cleanly in 15 minutes, the harder builds will expose that. Interviewers sometimes open with it precisely because it's a fast read on whether you scope before designing.
:::

## Phase 1 — The version that works

Start honestly. For a product with a few thousand users a day:

```viz
{
  "type": "flow",
  "caption": "Phase 1 \u2014 one service, one database. This covers most products' entire lifetime.",
  "nodes": [
    {
      "id": "c",
      "label": "Client",
      "col": 0
    },
    {
      "id": "a",
      "label": "App server",
      "col": 1
    },
    {
      "id": "d",
      "label": "Postgres",
      "sub": "pastes",
      "col": 2
    }
  ],
  "edges": [
    {
      "from": "c",
      "to": "a"
    },
    {
      "from": "a",
      "to": "d"
    }
  ]
}
```

**Schema:**

```sql
CREATE TABLE pastes (
  id          BIGSERIAL PRIMARY KEY,
  short_code  VARCHAR(8) UNIQUE NOT NULL,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ,
  is_private  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX ON pastes (expires_at) WHERE expires_at IS NOT NULL;
```

**API:**

```diagram
   POST /pastes    { content, expires_in, private }  → 201 { code }
   GET  /p/{code}                                    → 200 { content }
   DELETE /pastes/{code}                             → 204
```

**ID generation:** a database sequence, base62-encoded. Not Snowflake, not UUIDs — one database means one sequence, and that's genuinely correct here. See [Unique ID Generation](../building-blocks/unique-id-generation.html) for why the sophisticated options exist and why you don't need them yet.

**How far this goes:** comfortably to ~1,000 writes/s and tens of thousands of reads/s on one well-specified Postgres box with a read replica. That covers the entire lifetime of most products.

:::goat Say the threshold out loud
"One Postgres instance handles this. I'd revisit when sustained writes approach ~30K/s, or when the table outgrows what fits in the buffer pool. Both of those are a long way from where this product starts." Naming when you'd change your mind is the senior move — it shows the choice was deliberate rather than default.
:::

## Phase 2 — Reads outgrow the database

**The trigger:** a paste goes viral. One `short_code` receives 50,000 requests/second while your database happily serves 5,000.

The content is **immutable** — once a paste is created it never changes. That's the single most important property of this system, because it removes the hard part of caching entirely: a cached copy can never be out of date, so there's nothing to invalidate and no staleness to reason about.

```viz
{
  "type": "flow",
  "caption": "Phase 2 \u2014 content is immutable, so caching needs no invalidation.",
  "nodes": [
    {
      "id": "c",
      "label": "Client",
      "col": 0
    },
    {
      "id": "a",
      "label": "App",
      "col": 1
    },
    {
      "id": "r",
      "label": "Redis",
      "sub": "~99% hit",
      "col": 2
    },
    {
      "id": "d",
      "label": "Postgres",
      "col": 3
    }
  ],
  "edges": [
    {
      "from": "c",
      "to": "a"
    },
    {
      "from": "a",
      "to": "r"
    },
    {
      "from": "r",
      "to": "d",
      "label": "miss",
      "dashed": true
    }
  ]
}
```

```diagram
   Working set: pastes viewed in the last 24h
   Say 1M pastes/day × 10 KB average = 10 GB
   Hot 20% = 2 GB  →  fits in one Redis node with room to spare
```

**Because content is immutable, there is no invalidation problem.** Set a long TTL and never think about it again. Compare this to [caching](../building-blocks/caching.html) a mutable resource, where invalidation is the hard part — immutability is what buys you the simplicity.

**Add a CDN** in front for the read path. A paste is a static document; edge caching removes most traffic from your origin entirely. Version the URL by `short_code` (which never changes content) so you can cache aggressively.

## Phase 3 — Storage outgrows the database

**The trigger:** average paste size climbs and you're storing 500 GB of text inside database columns. Backups take hours. The memory the database reserves for hot data is now full of paste bodies, pushing out the index pages that actually needed to be there — so unrelated queries get slower too.

**The fix: separate metadata from content.**

```diagram
   Postgres (metadata — small, indexed, queryable)
     short_code · created_at · expires_at · size · s3_key

   Object storage (content — large, cheap, CDN-friendly)
     pastes/2026/08/aB3xK9p.txt
```

This is the same move as the [object storage](../building-blocks/object-storage.html) pattern in every media system: **the database holds pointers, the object store holds bytes.** Your database shrinks from 500 GB to a few GB, backups take minutes, and the working set fits in RAM again.

Keep small pastes (say under 4 KB) inline in the database — the extra round trip to object storage isn't worth it for content that fits in a single row comfortably. That hybrid is a nice detail to mention.

## Phase 4 — Expiry at scale

**The trigger:** you have 500M pastes and the nightly `DELETE FROM pastes WHERE expires_at < now()` locks the table for 20 minutes.

Three fixes, in increasing sophistication:

1. **Batch the delete.** `DELETE ... LIMIT 10000` in a loop with a pause. Simple, effective, and enough for most systems.
2. **Lazy expiry.** Check `expires_at` on read and treat expired pastes as absent. Physical cleanup becomes a background concern rather than a correctness one.
3. **Partition by expiry month.** Store each month's pastes in its own physical table (a *partition*) behind one logical table. Deleting a month is then just dropping that table — the database updates one piece of bookkeeping instead of visiting 40 million rows. Instant, and nothing gets locked. This is the right answer at large scale.

Combine 2 and 3: lazy expiry makes correctness immediate, partition drops make cleanup free.

## The decision log

Rehearse these. Each is a choice, a rejected alternative, and the deciding constraint.

| Decision | Rejected | Because |
|---|---|---|
| Database sequence for IDs | Snowflake, UUID | One database means one sequence. Snowflake solves a sharding problem we don't have. |
| Base62 encoding | Raw integers | 8 chars gives 218 trillion combinations and stays typable. |
| Cache with long TTL | Short TTL + invalidation | Content is immutable, so staleness is impossible. |
| Metadata in SQL, content in object storage | All-in-database | 500 GB of TEXT destroys backup times and buffer pool efficiency. |
| Lazy expiry + partition drops | Nightly bulk DELETE | Bulk deletes lock the table; partition drops are instant. |
| 302 redirects (if shortening) | 301 | Preserves the ability to disable abusive pastes. |

## What you'd cut for v1

Private pastes, syntax highlighting, edit history, user accounts, and analytics. Ship create-and-read with expiry. Everything else is a feature request you haven't validated.

## Explaining the design

You will not get 45 minutes on Pastebin — it's a warm-up. Compress it:

> "This is read-heavy with immutable content, which makes it unusually cacheable. I'd start with one Postgres instance and a Redis cache, with content in object storage once average paste size makes the table unwieldy. IDs come from a database sequence, base62-encoded — no need for Snowflake without sharding. The interesting problems are expiry at scale, where I'd use lazy checks plus partition drops rather than bulk deletes, and the viral-paste case, which the CDN absorbs because the content never changes."

Ninety seconds, and it covers storage, caching, IDs, expiry, and the hot-key case. Then ask what they'd like to go deeper on.

## Next

[Build an Image Host](image-host.html) — same shape, but now the bytes are large and the write path has to do work.

## Check yourself

```recall
Q: How far does Phase 1 Pastebin go?
A: One Postgres box with a read replica handles ~1,000 writes/s and tens of thousands of reads/s — most products' entire lifetime. Name when you'd revisit (~30,000 writes/s, or the table outgrowing the buffer pool).

Q: Why a database sequence for paste IDs?
A: One database means one sequence; Snowflake solves a sharding problem you don't have. Base62 makes it short — 8 characters give 218 trillion codes.

Q: What makes Pastebin's cache trivial?
A: Content is immutable, so a cached copy can never be stale — long TTLs, no invalidation — and a CDN can absorb a viral paste.

Q: Why move paste bodies to object storage?
A: 500 GB of TEXT makes backups take hours and fills the buffer pool with bodies, evicting index pages and slowing unrelated queries. The database keeps pointers; object storage keeps bytes; small pastes stay inline.

Q: How do you expire hundreds of millions of pastes?
A: Lazy expiry (treat expired as absent on read) for immediate correctness, plus partitioning by expiry month so cleanup is dropping a partition — instant, no locks. Batched deletes suffice at smaller scale.

Q: How do you present Pastebin in ninety seconds?
A: Read-heavy, immutable, so very cacheable; one Postgres plus Redis, bodies in object storage once large; sequence IDs; lazy expiry with partition drops; the CDN absorbs viral pastes.
```

## What to carry forward

- Start with one service and one database, and say when you'd change.
- Immutability removes cache invalidation entirely.
- Databases hold metadata and pointers; object storage holds bytes.
- Lazy expiry plus partition drops beats bulk deletes.
- Warm-up questions are graded on scoping and compression.
