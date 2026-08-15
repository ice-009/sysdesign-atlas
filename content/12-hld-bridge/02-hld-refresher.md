---
title: The HLD Refresher
summary: The whole high-level-design round on one page — the 45-minute structure, the six numbers worth memorising, what each component is for, and a worked ten-minute example.
difficulty: Medium
scope: HLD
tags: [hld, framework, revision, cheatsheet]
prereqs: [hld-vs-lld, back-of-envelope]
unlocks: Walking into an HLD round with the structure, the numbers and the component trade-offs in your head.
---

This compresses [Foundations](../fundamentals/scalability-basics.html), [Building Blocks](../building-blocks/load-balancing.html) and the [Appendix](../appendix/framework.html) into what fits in your head two days before an interview. Read the first half on day 1, the second on day 2, and skim both on day 3.

## Part 1 · The structure

```viz
{
  "type": "steps",
  "caption": "45 minutes. Announce it in the first minute, then follow the interviewer when they steer.",
  "note": "Minutes 27–40 hold most of the score. Everything before them exists to buy that time.",
  "steps": [
    { "label": "0–5 · Requirements", "sub": "What it does, what matters, what you're skipping." },
    { "label": "5–10 · Estimation", "sub": "Only numbers that change a decision." },
    { "label": "10–15 · API + data", "sub": "The endpoints, the tables, and how data is split up." },
    { "label": "15–27 · The diagram", "sub": "Draw it, then follow one request through it." },
    { "label": "27–40 · Deep dives", "sub": "Two, properly. Depth beats breadth." },
    { "label": "40–45 · Wrap up", "sub": "What breaks at 10×, what fails, what you'd watch." }
  ]
}
```

**Requirements.** Three or four things it must do, then the qualities that actually shape the design: how many reads versus writes, how fast it must respond, how fresh the data must be, how much downtime is acceptable, and how big it is. Then say what you're *not* building. Scope discipline is scored.

**Estimation.** One or two numbers, each followed by "…which means". `requests per second = daily users × actions each ÷ 100,000`. Storage = number of things × size each × how long you keep them × number of copies. If a number doesn't change a decision, skip it and say you're skipping it.

**API and data.** Four or five endpoints at most. Then the tables — and always say **how the data is split across machines** and why. "Split by user id, because every read is for one user and it keeps their whole timeline on one machine" is one of the highest-value sentences in the round.

**The diagram.** Draw the boxes, then walk one write and one read through them, saying what travels along every arrow. Never leave an arrow unlabelled.

**Deep dives.** Pick the two hardest parts — usually the busiest path and the place where data can go stale — and go three levels down. Offer a choice: *"the interesting parts here are how the feed is built and how the cache is kept fresh; which would you rather I dig into?"*

**Wrap up.** "At ten times the traffic this breaks first, and here's what I'd do. If this component dies, here's what users see. I'd watch these three numbers." Three sentences, and they close the round strongly.

:::interview The two sentences that raise your score most
**At the start:** "Here's how I'd like to use the time…" — it makes everything after it look deliberate.

**Throughout:** "…which means…" — never state a number or name a component without its consequence. "300,000 reads a second, *which means* the cache is the main read path, not a nice-to-have." Decisions plus reasons is the entire marking scheme.
:::

## Part 2 · The numbers

Six facts. Everything else you can derive at the whiteboard.

```diagram
   1 day  ≈ 100,000 seconds            requests/sec = users × actions ÷ 100,000
   Peak   ≈ 3× average                 (10× for launches, sales, match days)

   Read from memory   ~100 ns    ─┐
   Read from SSD      ~100 µs     │  memory is ~1,000× faster than disk
   One network hop     ~500 µs    │  a hop costs more than reading 1 MB of memory
   Across the world   ~100 ms    ─┘  physics; only moving data closer helps

   One ordinary server:  ~50,000 requests/sec for trivial work
                         ~10,000/sec for real work · 64–512 GB memory
   One SQL primary:      ~10–50,000 writes/sec · comfortable up to ~10 TB
   Redis:                ~100,000 operations/sec per core, under a millisecond
```

**Rough sizes:** an ID is 8–16 bytes · a short text post ~300 bytes · a database row ~1 KB · a thumbnail ~10 KB · a web photo ~500 KB · an hour of 1080p video ~2 GB.

**The three conclusions** that do most of the work:

1. If the data people actually read fits in memory across a few machines, **cache it** — you've just removed most of your read traffic.
2. If storage passes ~10 TB or writes pass ~50,000/sec, **you're splitting the data across machines**, and the only question is what you split it by.
3. If a step is slow, unreliable or bursty and the user doesn't need the result immediately, **put it on a queue**.

The full tables are in [the cheat sheet](../appendix/cheat-sheet.html).

## Part 3 · What each component is for

| Component | Use it when | The trade-off to say out loud |
|---|---|---|
| **Load balancer** | Always, in front of any group of servers | Simple ones just forward traffic; smarter ones can route by URL and handle HTTPS. Health checks decide what counts as "alive" |
| **Cache** | Lots of reads, and slightly stale data is fine | Knowing when to throw it away is the hard part. Name the pattern and always set an expiry |
| **CDN** | Images, video, anything static, users spread out | Cheap speed win; changes take time to propagate. Put a version in the URL rather than trying to purge |
| **SQL database** | Related data, transactions, queries you haven't thought of yet. The default | One machine takes all the writes. Read copies add read capacity but lag slightly behind |
| **NoSQL** | You know exactly how you'll read it, and there's a lot of it | You give up joins and flexible queries for easy growth. Design the table around the one query |
| **Splitting data (sharding)** | Past one machine's storage or write limit | Queries spanning machines get hard. Pick the split key for even spread *and* for the queries you'll run |
| **Message queue** | Decouple things, absorb bursts, retry, fan out | Adds delay before the result is visible, and messages can arrive twice — so consumers must tolerate repeats |
| **Search index** | Free-text search and ranking | A second copy of the data to keep in sync; nearly real-time, not real-time |
| **Object storage** | Files — images, video, backups | Store the link in the database, never the file itself |
| **WebSockets** | The server must push, within a second | Keeping connections open makes deploys and scaling harder than plain polling |

## Part 4 · The starting diagram

Most designs are this picture with two or three boxes changed. Start here and justify each deviation.

```diagram
   Client ─▶ CDN ─▶ LB ─▶ API gateway ──▶ Servers ──▶ Cache ──▶ Main database
                          (auth,             │                     │
                           rate limit)       │                     ├─▶ Read copies
                                             │                     └─▶ Split by key
                                             ▼
                                      Message queue ──▶ Workers ──▶ Search index
                                                               └──▶ File storage
                                                               └──▶ Analytics
```

- **The top row** is what the user waits for. Keep it fast and simple.
- **Everything below the queue** is what the user doesn't wait for: notifications, indexing, thumbnails, analytics.

Deciding what goes below the line is most of the design. *"The write returns as soon as it's safely stored; indexing, notifications and fan-out all happen off the queue"* covers a lot of ground in one breath.

## Part 5 · The five deep dives that come up everywhere

Have a paragraph ready on each.

**1 · Caching.** Look in the cache first, fall back to the database, and put the answer in the cache — with an expiry. Say what you cache, where, and how it gets thrown away. Name the two hard cases: **a stampede** (a popular item expires and a thousand requests hit the database at once — let one of them do the work while the rest wait) and **a hot key** (one item so popular it overloads a single cache node — copy it to several). See [Caching](../building-blocks/caching.html).

**2 · Splitting the data.** Say the key and why. Splitting by ranges lets you scan but creates hot spots; splitting by hash spreads evenly but kills range queries; [consistent hashing](../building-blocks/consistent-hashing.html) makes adding machines cheap. Always mention the celebrity problem and one fix.

**3 · Freshness.** Where do you need the absolute truth, and where is slightly-behind fine? The good answer is per operation, not per system: "the booking write must be exact — it's one conditional update on one row; the seat map can be a second out of date, and the screen says so." See [CAP and PACELC](../fundamentals/cap-pacelc.html).

**4 · Failure.** For each major box: what happens when it dies, and what does the user see? Cache down → slower, and the database takes the load. Queue backed up → things happen late, not never. Whole region down → fail over, and say how much data you'd lose. Retries need spacing, randomness and a way to detect duplicates, or your retries become the outage.

**5 · Ten times the traffic.** Name the first thing to break and the fix. This is the closing question, and candidates fumble it because they never worked out which box is nearest its limit.

## Part 6 · A worked ten-minute example

*"Design a URL shortener"* — how the pieces above go together under time pressure.

> **Requirements.** Make a short link, redirect it, optional expiry. Far more reads than writes, redirects must be fast, and it must basically never be down — a dead shortener breaks every link ever shared. Out of scope: accounts, analytics dashboards, spam scanning.
>
> **Estimation.** 100 million new links a day ÷ 100,000 = **1,000 writes/sec**, about 3,000 at peak. A hundred reads per write → **100,000 reads/sec**, 300,000 at peak. 500 bytes each × 100 million × 5 years ≈ **91 TB**. *Which means:* too big for one machine, so split it; and 300,000 reads a second of tiny unchanging values is the perfect cache workload.
>
> **API.** `POST /urls {long_url} → {short_url}`, and `GET /{code}` → redirect. Use a temporary redirect, not a permanent one: browsers cache permanent redirects forever, so you could never disable a bad link.
>
> **Data.** `urls(code, long_url, created_at, expires_at)`, split by the hash of the code. Every lookup is by code, so there are no range queries to preserve and hashing spreads load evenly.
>
> **Design.** CDN → load balancer → stateless servers → Redis (code → URL, roughly 99% hit rate, because a few links get most of the traffic) → the split store. Writes go to the store and populate the cache.
>
> **Deep dive: making codes.** Three options. Random seven characters with a uniqueness check — 3.5 trillion possibilities, but a read before every write. A counter converted to base 62 — compact, but guessable and it needs one shared counter. Or give each server a block of numbers in advance — no coordination per request, small gaps when a server restarts. I'd take the pre-allocated blocks with a random suffix.
>
> **Failure and growth.** If the cache dies, all 300,000 reads a second hit the store — so keep a small local cache on each server and a circuit breaker. Records never change once written, so copies are trivially consistent. At ten times the traffic the limit is cache memory, and the fix is more cache nodes.

That's the whole round in six paragraphs. The long version is in [the case study](../case-studies/url-shortener.html).

:::warn Four ways prepared candidates still lose
**No scope cut** — designing everything, finishing nothing. **Numbers with no conclusion** — five minutes of arithmetic that changes nothing. **Breadth over depth** — twelve components named, none explained. **Drawing in silence** — three minutes of boxes with no words.

Every one of those is a time-management failure rather than a knowledge failure, which is why the structure at the top of this page is the most valuable thing on it.
:::

:::exercise Ten minutes, out loud
Do the same six-paragraph treatment for **a pastebin with expiring notes**, or **a notification service**. Speak it, don't write it.

If you dry up, the missing piece is almost always the "…which means…" after a number.
:::
