---
title: Database Indexing
summary: How B-tree indexes actually work, composite index ordering, covering indexes, and why the wrong index is often worse than none at all.
difficulty: Medium
scope: HLD
tags: [index, database, query, b-tree]
prereqs: [sql-vs-nosql, hardware-numbers]
---

:::predict Guess first
1. A table has 100 million rows. With a B-tree index, roughly how many entries does a lookup read instead of 100 million?
2. You have an index on (country, city, age). Can a query filtering only on city use it?
3. Is adding an index to every column a good idea? What does each index cost?
:::

## The core idea

Without an index, finding the rows that match a condition means reading every single row and checking each one — a **full table scan**. With an index, the database consults a sorted structure on the side and jumps straight to the matching rows. It's the difference between reading a book cover to cover and using its index.

In cost terms: a scan is O(n) — work grows in step with the number of rows — while an indexed lookup is O(log n), which barely grows at all.

At 100 million rows that's the difference between reading 100 million entries and reading about 27. This is why "add an index" is frequently a 1000× improvement for a few minutes of work, and why it's the *first* thing to try before any architectural change.

The cost, always worth stating: **indexes make reads faster and writes slower.** Every insert, update, or delete must maintain every index on the table. They also consume disk and — more importantly — RAM, since an index that doesn't fit in memory loses much of its advantage.

## B+ trees: the default

Nearly every relational index is a B+ tree. The properties that matter:

```diagram
                    [ 50 | 100 ]              ← internal nodes:
                   /      |     \                keys only, for routing
          [10|30]     [60|80]    [120|150]
          /  |  \      /  |  \     /  |  \
       leaves: sorted key → row-pointer, linked left-to-right
       [..]→[..]→[..]→[..]→[..]→[..]→[..]→[..]
```

- **All values live in leaves**; internal nodes only route. This keeps internal nodes small so more of them fit in memory.
- **Leaves are linked**, which makes range scans fast: find the start, then walk sideways. This is why B+ trees serve `WHERE created_at BETWEEN ...` and `ORDER BY` so well.
- **High fan-out** — each node points at hundreds of children rather than two, so the tree is wide and shallow. With ~100–500 keys per node, four levels addresses billions of rows. That's ~4 disk reads worst case, and the top levels are almost always cached.
- **Self-balancing** — depth stays uniform as data changes, so performance is predictable.

**Consequence to remember:** because B-trees are sorted, they support equality, ranges, prefix matching, and ordering. Hash indexes support equality only — faster for exact lookups, useless for anything else, which is why they're rarely the default.

## Clustered vs secondary

**Clustered index** — the table *is* the index; rows are physically stored in the index's order. There can be only one. In InnoDB this is the primary key; in Postgres, the heap is separate and there's no true clustered index.

**Secondary index** — a separate structure that maps the indexed column to a pointer telling you where the actual row lives. Following that pointer is a second lookup, sometimes called a *bookmark lookup*.

The performance consequence in InnoDB-style engines:

```diagram
   SELECT * FROM users WHERE email = 'x@y.com'

   1. Search secondary index on email     → finds primary key 4711
   2. Search clustered index for PK 4711  → finds the actual row
      ("bookmark lookup" / double lookup)
```

Two tree traversals, not one. This makes **covering indexes** (below) valuable, and it explains why a random UUID primary key hurts in InnoDB: rows are physically stored in PK order, so random keys cause page splits and fragmentation on every insert. Sequential-ish keys (auto-increment, [Snowflake IDs](unique-id-generation.html), UUIDv7) keep inserts appending to the end. That detail is a great one to raise when a design uses UUIDs.

## Dense vs sparse

A second way to classify indexes, by **how many rows get an entry**.

**Dense index** — one entry for *every* row (or every distinct key). Any lookup goes straight to its row. Every secondary index is dense: the rows aren't stored in that column's order, so there's no way to skip any.

**Sparse index** — one entry per *block* of rows, not per row. It only works when the rows are stored sorted by the indexed key, because then a block's first key tells you the range it covers.

```diagram
   Data stored sorted by key, in blocks:
     block 1: 3, 5, 8, 12      block 2: 15, 19, 22, 30      block 3: 34, 41, 47, 52

   DENSE index (every key)          SPARSE index (first key of each block)
     3 → b1   15 → b2   34 → b3       3 → block 1
     5 → b1   19 → b2   41 → b3      15 → block 2
     8 → b1   22 → b2   47 → b3      34 → block 3
    12 → b1   30 → b2   52 → b3

   Find 22 with the sparse index: the largest entry ≤ 22 is 15,
   so read block 2 and scan it.
```

| | Dense | Sparse |
|---|---|---|
| Size | One entry per row — large | One entry per block — tiny, often fits in memory |
| Lookup | Direct | Find the block, then scan within it |
| Needs sorted data? | No | Yes — sorted by the index key |
| Where you see it | Secondary indexes | The clustered order of a table; the index blocks of a B+ tree; SSTables in [LSM-tree engines](../04-data/storage-engines.html); Kafka's segment index |

Most real structures **mix the two**: a B+ tree's upper levels are sparse (one entry per child page), and its bottom level is dense. An LSM engine keeps a small sparse index per file in memory and reads one block from disk per lookup — that's how it holds billions of keys with a modest amount of RAM.

**The point to make in an interview:** *"Sparse indexes trade a short scan for a much smaller index, and they only work on sorted data. That's why storage engines keep data sorted — the sparse index fits in memory."*

## Composite indexes and the leftmost rule

An index on `(a, b, c)` sorts by `a`, then `b` within equal `a`, then `c`. This has a sharp consequence:

```diagram
   INDEX (country, city, age)

   ✓ WHERE country='IN'                          uses index
   ✓ WHERE country='IN' AND city='Pune'          uses index
   ✓ WHERE country='IN' AND city='Pune' AND age=30   fully
   ✓ WHERE country='IN' AND age=30               uses country only,
                                                 then filters age
   ✗ WHERE city='Pune'                           CANNOT use it
   ✗ WHERE age=30                                CANNOT use it
```

You can only use a **prefix** of the index. Think of a phone book sorted by (last name, first name): finding everyone named "Priya" requires reading the whole book.

**Ordering rule of thumb:**
1. Equality predicates first.
2. Then the range predicate.
3. Then columns needed only for sorting or output.

A range predicate stops the index from being used for anything after it, so `WHERE a = 1 AND b > 5 AND c = 3` uses `(a, b)` of an `(a, b, c)` index and filters `c` by scanning.

:::goat A high-value observation
"One composite index on `(user_id, created_at)` serves both `WHERE user_id = ?` and `WHERE user_id = ? ORDER BY created_at DESC LIMIT 20` — the second is the feed query, and because the index is already sorted, there's no sort step at all. That's why I'd put the timeline read on this index rather than adding two single-column indexes." Explaining *why* one index beats two is where the actual understanding lives.
:::

## Covering indexes

If an index contains **every column the query needs**, the database answers entirely from the index and never touches the table — an *index-only scan*. This eliminates the bookmark lookup and is often a 2–10× win.

```diagram
   SELECT user_id, created_at FROM posts
   WHERE user_id = 42 ORDER BY created_at DESC LIMIT 20;

   INDEX (user_id, created_at)   → covering. Never reads the table.

   SELECT user_id, created_at, body FROM posts ...
   INDEX (user_id, created_at) INCLUDE (body)  → still covering
```

Postgres's `INCLUDE` (and SQL Server's equivalent) stores extra columns in the leaves without making them part of the sort key — you get coverage without bloating the tree's search path.

## When indexes don't help

Volunteering these is a good signal because it shows you understand the planner, not just the syntax:

- **Low selectivity** — meaning the condition doesn't narrow things down much. An index on a true/false column where half the rows match is worse than a scan: the database would do one scattered read per matching row, and scattered reads are far slower than reading straight through. Planners know this and will correctly ignore your index.
- **Functions on the column.** `WHERE LOWER(email) = 'x'` can't use an index on `email`. Fix with an *expression index* on `LOWER(email)`.
- **Leading wildcards.** `LIKE '%foo'` can't use a B-tree (nothing to seek to). Needs a trigram index or a [search engine](search.html).
- **Type mismatches** that force implicit casts.
- **`OR` across different columns** — often can't use one index; sometimes resolved by a bitmap-or of two indexes, sometimes better rewritten as a `UNION`.
- **Small tables.** A scan of 500 rows already in memory beats index overhead.

## The write cost, quantified

Each index roughly adds:

- **Insert:** one B-tree insert (a few page reads/writes, possible split).
- **Update:** only if the indexed column changed — but changing an indexed column means delete + insert in that index.
- **Delete:** removal from every index.

A table with 8 indexes can be **5–10× slower to write** than the same table with one. On a write-heavy table this can be the actual bottleneck, and "we should drop the indexes nobody's queries use" is a genuinely common fix.

:::trap "Add an index to every column"
This is the most common indexing mistake in real systems. Indexes have to *earn* their place: each must serve a query that runs often enough to justify the write cost and memory footprint. Unused indexes are pure overhead — most databases expose usage statistics precisely so you can find and drop them.
:::

## Other index types worth naming

- **Hash** — O(1) equality, no ranges, no ordering.
- **Bitmap** — one bitmap per distinct value; excellent for low-cardinality columns combined with AND/OR in analytical workloads. Poor for high-write OLTP.
- **GIN / inverted** — maps each token/element to the rows containing it. Powers full-text search, JSONB containment, and array membership.
- **GiST / R-tree / [geospatial](geospatial.html)** — multi-dimensional; the basis of "points within this bounding box."
- **Partial index** — indexes only rows matching a predicate: `WHERE status = 'pending'`. If 99% of orders are complete and you only ever query pending ones, the index is 1% of the size and stays in RAM. Underused and very effective.
- **LSM-tree** — not a B-tree at all; see [Storage Engines](../04-data/storage-engines.html) for why write-heavy systems use it instead.

## Reading a query plan

The practical skill behind all of this. `EXPLAIN ANALYZE` and look for:

- **Seq Scan** on a large table with a selective predicate → missing or unusable index.
- **Index Scan** vs **Index Only Scan** → the latter means covering; the former means bookmark lookups.
- **Rows estimated vs actual** wildly different → stale statistics, so the planner is choosing badly. Often the real bug.
- **Sort** steps that an index ordering could have avoided.
- **Nested Loop** with a large outer relation → usually a missing index on the join key.

Check the plan before adding anything: a large discrepancy between estimated and actual rows usually means stale statistics, and no index fixes that.

:::exercise Design the indexes
A table of 200M orders: `(order_id, customer_id, status, created_at, total, region)`.

1. Queries: "recent orders for a customer", "all pending orders in a region", "daily revenue by region". Design the minimum set of indexes.
2. For each index, state its size relative to the table and its cost on write.
3. Why is a composite index on `(customer_id, created_at)` different from two separate indexes? Which query shapes does each serve?
4. A covering index would avoid a heap lookup. Compute when that is worth the extra width.
5. One query is `WHERE lower(email) = ?` and is doing a sequential scan despite an index on `email`. Explain, and give two fixes.
:::

:::paper How indexes actually work
Bayer and McCreight's 1972 paper introduced the B-tree; Comer's *The Ubiquitous B-Tree* (Computing Surveys, 1979) is the readable survey. Goetz Graefe's *Modern B-Tree Techniques* (2011) covers everything that happened since.

*How Good Are Query Optimizers, Really?* (Leis et al., VLDB 2015) shows how index choice interacts with cardinality estimation — the reason a perfect index sometimes goes unused.
:::

## Check yourself

```recall
Q: Why is a B+ tree only about four levels deep for billions of rows?
A: Each node points at hundreds of children, so the tree is wide and shallow — four levels of 100–500 keys address billions of rows, and the top levels stay cached.

Q: What do B-tree indexes support that hash indexes don't?
A: Ranges, prefixes and ordering, because the keys are sorted and leaves are linked. Hash indexes only answer exact equality.

Q: What is the leftmost-prefix rule for a composite index on (a, b, c)?
A: Only a prefix of the index can be used: a, then a and b, then all three. A query on b or c alone can't use it, and a range on b stops c from being used.

Q: Why does one index on (user_id, created_at) beat two single-column indexes for a feed query?
A: WHERE user_id = ? ORDER BY created_at DESC LIMIT 20 reads the rows already in order from one index, with no sort step.

Q: What is a covering index, and why is it faster?
A: One that contains every column the query needs, so the database answers from the index alone and skips the lookup into the table — often a 2–10× win.

Q: Dense versus sparse index: what's the trade, and what does a sparse index require?
A: Dense has one entry per row and goes straight to it; sparse has one entry per block — tiny, often in memory — then scans the block. Sparse only works on data sorted by the key.

Q: Name three reasons a query might ignore an index you created.
A: Low selectivity (half the rows match), a function on the column like LOWER(email), a leading wildcard (LIKE '%foo'), an implicit type cast, or a table small enough that scanning is cheaper.

Q: A table has eight indexes and writes are slow. What's going on?
A: Every insert, delete and indexed-column update must maintain every index, which can make writes 5–10× slower. Drop indexes no query uses — databases expose usage statistics to find them.
```

## What to carry forward

- An index turns an O(n) scan into an O(log n) lookup — and taxes every write and some RAM.
- B+ trees are sorted and shallow, so they serve equality, ranges and ordering.
- Order composite indexes equality first, then range, then sort or output columns; only a prefix is usable.
- Covering indexes skip the table; partial indexes keep hot subsets small; sparse indexes rely on sorted data.
- Read the query plan before adding anything — stale statistics are often the real bug.
