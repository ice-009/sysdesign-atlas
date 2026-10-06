---
title: Design a News Feed (Twitter / Facebook)
summary: The definitive fanout question. Push vs pull, the celebrity problem, and why the correct answer is a hybrid with an explicit threshold.
difficulty: Hard
scope: HLD
tags: [case-study, fanout, feed, cache]
prereqs: [caching, sharding, message-queues]
---

:::predict Guess first
1. When someone posts, should the post be written into every follower's feed right away, or gathered when each follower opens the app?
2. A celebrity with 100 million followers posts once. Under the first approach, how many writes is that?
3. A user posts and doesn't see it in their own feed for five seconds. Will they notice?
:::

:::interview Why this question
It's the most common hard prompt at Meta and appears everywhere else. The whole design turns on one decision — how the feed is materialized — and every other choice is downstream of it. Get to that decision fast; don't spend 15 minutes on the write path for posts.
:::

## 1. Requirements

**Functional**
- Users post text (plus optional media).
- Users follow other users.
- A user's home feed shows recent posts from people they follow, newest first.
- Feed is paginated and infinitely scrollable.

**Non-functional**
- Feed load must be fast — this is the app's core interaction. Target p99 under ~200 ms.
- Read-heavy by a large factor.
- Eventual consistency is acceptable: a post appearing a few seconds late is invisible to users.
- Highly available; a stale feed beats no feed.

**Cut explicitly:** ranking/ML ordering (assume reverse-chronological, and *say* real systems rank), ads, DMs, search, notifications. Cutting scope out loud is scored.

**Clarifying questions:**
- Reverse-chronological or ranked? (Huge difference — say you'll assume chronological and note where ranking would change things.)
- Follower distribution — do we have celebrity accounts with tens of millions of followers?
- How far back does the feed go? Do we need the full history or just recent?

## 2. Estimation

**500M DAU**, average 200 follows, 2 posts/user/day, 50 feed loads/user/day.

```diagram
   Writes:  500M × 2 / 10⁵     = 10,000 posts/s avg → 30,000 peak
   Reads:   500M × 50 / 10⁵    = 250,000 feed loads/s → 750,000 peak

   Read:write ≈ 25:1

   Post storage: 500 B × 1B posts/day = 500 GB/day → 180 TB/yr

   FANOUT COST (the number that matters):
     10,000 posts/s × 200 avg followers = 2,000,000 feed writes/s
     One celebrity post @ 100M followers = 100M writes from ONE action
```

**What this decided:** 2M feed-writes/s is large but tractable with a partitioned cache. The 100M-writes-from-one-post figure is what kills naive push and forces the hybrid. **Compute this number explicitly in the interview** — it's the justification for the entire design.

## 3. API

```diagram
   POST /v1/posts            { text, media_ids }  → 201 {post_id}
   GET  /v1/feed?cursor=...&limit=20              → posts + next_cursor
   POST /v1/users/{id}/follow                     → 204
```

Use **cursor pagination**, not offset. Offset pagination on a feed that's constantly gaining items shows duplicates and skips as you scroll — the cursor encodes a position (post ID / timestamp) and is stable and O(1).

## 4. The core decision: fanout

**Fanout** is what happens to one post on its way to many timelines. The only real question in this design is *when* that work happens: at the moment someone posts, or at the moment someone opens the app. Everything else follows from that choice.

### Fanout on write (push)

When a user posts, immediately write the post ID into every follower's precomputed feed list.

```viz
{
  "type": "fanout",
  "source": "Alice posts",
  "caption": "Fanout on write \u2014 cheap reads, expensive writes.",
  "targets": [
    "follower feed",
    "follower feed",
    "follower feed",
    "follower feed"
  ],
  "note": "one post \u2192 N cache writes \u00b7 a celebrity makes N unbounded"
}
```

**Pros:** reads are trivially cheap — a single cache read, ~1 ms. Since reads outnumber writes 25:1, you're moving work to the cheaper side of the ratio.

**Cons:** writes are expensive and *unbounded*. A celebrity post is 100M writes. It also wastes enormous work on inactive users — writing into the feed of someone who hasn't opened the app in a year.

### Fanout on read (pull)

Store posts once. At feed load, query the posts of everyone the user follows and merge.

```diagram
   Alice loads feed ──► fetch recent posts from each of her
                        200 followees, merge, sort, take 20
```

**Pros:** writes are O(1) — one insert. No wasted work, no celebrity problem at all.

**Cons:** reads are expensive — a 200-way scatter-gather on every feed load, at 750K reads/s. And feed load is the most frequent, most latency-sensitive operation in the product. This is precisely backwards for the ratio.

### The hybrid (the answer)

```diagram
   ON POST:
     if author.follower_count < THRESHOLD (~10,000):
         PUSH — fan out to all followers' feed caches
     else:
         DON'T fan out. Store the post; mark author as "celebrity"

   ON FEED READ:
     1. read precomputed feed from cache        (push portion)
     2. fetch recent posts from the few celebrities this
        user follows                            (pull portion)
     3. merge by timestamp, return top N
```

**Why this works:** almost all users are below the threshold, so almost all posts are pushed and reads stay cheap. The handful of accounts that would cause 100M-write storms are pulled instead — and since each user follows only a few celebrities, the pull portion is a small, bounded fetch (say 5 accounts, not 200).

**Refinements worth mentioning:**

- **Only fan out to active users.** Someone who hasn't opened the app in 30 days doesn't need a materialized feed; build it on demand when they return. This can cut fanout volume by more than half.
- **Cache celebrity posts aggressively.** Every follower requests the same few posts, so the hit rate approaches 100%.
- **The threshold is tunable**, and it's a knob you'd tune from production data rather than pick a priori.

:::goat Say the threshold reasoning out loud
"I'd set the boundary around 10,000 followers, but the real point is it's a tunable knob balancing fanout write cost against read-time merge cost. I'd measure the distribution — follower counts follow a power law, so the vast majority of accounts are far below any reasonable threshold, meaning we get cheap reads for nearly everyone while capping worst-case write amplification."
:::

## 5. Storage design

```diagram
   posts          (Cassandra — write-heavy, append-only, time-ordered)
     partition: user_id      clustering: created_at DESC
     → "recent posts by user X" is a single-partition range scan

   follows        (sharded SQL or KV)
     (follower_id, followee_id)  — index both directions:
       "who do I follow"  (for pull)  and
       "who follows me"   (for fanout)

   feed_cache     (Redis — the materialized feeds)
     key:   feed:{user_id}
     value: sorted set of post_ids scored by timestamp
     TRIMMED to ~800 entries
```

**The trim is important.** Nobody scrolls past a few hundred items; storing unbounded feeds would dominate memory. Beyond the cached window, fall back to generating the feed on demand — slower, and it's an interaction ~0.1% of sessions ever have.

```diagram
   Feed cache memory:
     500M users × 800 post_ids × 8 B = 3.2 TB
   → but only ACTIVE users need one. Say 20% active in 7 days:
     100M × 800 × 8 B = 640 GB → ~20 Redis nodes at 32 GB ✓
```

That calculation — and the decision to materialize only active users — is exactly the kind of scoping that makes an expensive design affordable.

## 6. High-level design

```diagram
   POST ──► ┌───────────┐    ┌─────────┐
            │Post service│──►│Cassandra│ (source of truth)
            └─────┬─────┘    └─────────┘
                  │ publish
                  ▼
            ┌──────────┐    ┌───────────────┐
            │  Kafka   │───►│Fanout workers │
            └──────────┘    └───────┬───────┘
                            look up followers
                            if not celebrity → write to feed caches
                                    │
                                    ▼
   FEED ──► ┌───────────┐    ┌──────────────┐
   READ     │Feed service│──►│Redis feed    │ push portion
            │           │    │cache         │
            │           │    └──────────────┘
            │           │──► celebrity posts (pull portion, cached)
            │           │──► hydrate post content + author + counts
            └───────────┘
```

**Why fanout is async via Kafka:** the user's post must return in ~50 ms. Fanning out to 200 followers takes longer than that, and the user doesn't need it to have happened. Publishing an event and returning immediately is the right call — and it gives you retry and buffering for free.

**Hydration** is the step that is easy to overlook: the feed cache holds only post IDs. Rendering needs post text, author name and avatar, like/comment counts, and whether *this* user liked it. That's a multi-get against several services — batch it, cache it, and be aware this is where [tail latency amplification](../01-fundamentals/latency-throughput.html) bites.

## 7. Deep dives

### Fanout worker throughput

2M feed-writes/s sounds alarming; it's a pipelined Redis `ZADD` workload.

```diagram
   Per post: look up followers (1 read), then N sorted-set adds
   Batch with pipelining: ~50K ZADDs/s per Redis node
   2M / 50K = 40 nodes  — consistent with the 20-node memory
                          estimate plus headroom ✓
```

Partition fanout work by **follower ID** so each worker writes to a known set of Redis shards, which keeps pipelines full.

### Ordering and consistency

Feeds are eventually consistent, and that's fine — except for one case users *do* notice: **their own posts**. A user who posts and doesn't immediately see it in their feed reports a bug.

Fix with a targeted [read-your-writes](../01-fundamentals/consistency-models.html): merge the user's own recent posts from the primary store into their feed at read time. Cheap, and it solves the only staleness anyone perceives.

### Handling unfollows and deletes

Removing a post means removing it from potentially millions of feed caches — another unbounded fanout. Better: **filter at read time.** Keep a small set of deleted post IDs (or check post existence during hydration) and drop them when assembling the response. Hydration already fetches post content, so a deleted post naturally disappears.

Same for unfollows: don't scrub the cache, filter at read.

### Ranking

If asked to move beyond chronological: retrieve a candidate set (the merged feed, a few hundred items), then **rerank** with a model scoring engagement probability. The architecture barely changes — you fetch more candidates and add a ranking step before returning. Precompute features offline; keep the online scoring within your latency budget. Naming "retrieve then rerank" is enough to show you know how it works.

## 8. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| Fanout workers lag | Feeds go stale by minutes. Degraded, not broken. Alert on consumer lag in *time*. |
| Redis feed shard dies | Those users' feeds rebuild on demand (pull path) — slower but functional. **Design the pull path to always work**, so it doubles as the fallback. |
| Cassandra shard down | Posts by users on that shard unavailable; feed renders without them (partial results beat errors). |
| Celebrity posts | Never fanned out by design; served from a near-100%-hit-rate cache. |

**Follow-ups:**
- *"What if a normal user suddenly goes viral?"* — the threshold must be dynamic, evaluated at post time against current follower count, and an account can cross it between posts. Also worth handling: an account near the threshold that flips back and forth.
- *"How would you add stories/ephemeral content?"* — different shape: small, expiring, viewed once. Pull works better; TTL handles cleanup.
- *"Feed for a user following 5,000 accounts?"* — the merge cost at read time grows; cap the pull portion and rely more heavily on push for these users.
- *"Multi-region?"* — feed caches are regional and rebuildable, so don't replicate them. Replicate posts and follows; regenerate feeds locally. Recognizing that derived data shouldn't cross regions is a good instinct.

## Check yourself

```recall
Q: What is the one number that justifies the news-feed design?
A: Fanout cost: 10,000 posts/s × 200 followers = 2 million feed writes a second, and one celebrity post with 100 million followers = 100 million writes from a single action.

Q: Fanout on write versus fanout on read?
A: Write (push): each post goes into every follower's cached feed — reads are one cache lookup, writes unbounded. Read (pull): store once and merge followees' posts at load — cheap writes, a 200-way scatter-gather on every load.

Q: What is the hybrid fanout design?
A: Push for authors below a tunable threshold (~10,000 followers); pull for the few celebrities a user follows, merged at read time. Cheap reads for nearly everyone, capped write amplification.

Q: Name two refinements to the hybrid.
A: Only fan out to recently active users (build others' feeds on demand), and cache celebrity posts aggressively — every follower requests the same few.

Q: How is the feed cache stored and bounded?
A: A Redis sorted set of post IDs per user, scored by time and trimmed to ~800, only for active users — about 640 GB rather than 3.2 TB.

Q: What is hydration, and why does it matter?
A: The cache holds only post IDs; rendering needs text, author, counts and "did I like it" from several services. Batch and cache it — this is where tail-latency amplification bites.

Q: How do you handle deletes and unfollows?
A: Filter at read time instead of scrubbing millions of caches: hydration finds a deleted post missing, and unfollowed authors are dropped when assembling the response.

Q: Why use cursor pagination for feeds?
A: Offset pagination on a constantly growing list shows duplicates and skips; a cursor (post ID or timestamp) is stable and O(1).
```

## What to carry forward

- Compute the fanout number first — it justifies the whole design.
- Hybrid fanout: push for normal authors, pull for celebrities, merged at read.
- Materialise feeds only for active users and trim them; fall back to the pull path.
- Fan out asynchronously via a queue; fix read-your-writes for the author's own posts.
- Filter deletes and unfollows at read time; regenerate derived feeds per region.
