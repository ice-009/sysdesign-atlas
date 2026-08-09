---
title: Build Instagram
summary: Media pipeline plus a social graph. Where read:write asymmetry starts dictating architecture and the feed becomes the hard problem.
difficulty: Medium
level: 2
prereqs: [object-storage, cdn, caching, sharding, news-feed]
tags: [level-2, feed, media, social]
unlocks: Combining a media pipeline with a social graph, and the fanout decision.
---

## The product

Post a photo. Follow people. See a feed of photos from people you follow. Like and comment.

Instagram is the [image host](image-host.html) plus a social graph — and the graph is where all the difficulty moves.

## Estimation

```diagram
   500M DAU · 0.2 posts/user/day · 50 feed views/user/day

   Writes:  500M × 0.2 / 10⁵ = 1,000 posts/s  → 3,000 peak
   Reads:   500M × 50 / 10⁵  = 250,000 QPS    → 750,000 peak
   Ratio:   250:1  ← the number that shapes everything

   Media:   1M photos/day × 1.6 MB (incl. derivatives) = 160 TB/day
   Metadata: 1M × 500 B = 500 MB/day → tiny

   FANOUT: 1,000 posts/s × 200 avg followers = 200,000 feed writes/s
           one 100M-follower account = 100M writes from ONE post
```

**A 250:1 read ratio means: move work onto the write path.** The expensive thing should happen once at write time, not 250 times at read time. That single conclusion drives the feed design.

## Phase 1 — Posts without a feed

```diagram
   POST /posts  → presigned upload → object storage
                → metadata row     → Postgres
                → async workers    → derivatives

   GET /users/{id}/posts  → query by user, newest first
```

Profile pages work. No feed yet. This ships in a week and is genuinely useful.

**Schema, sharded on `user_id`:**

```diagram
   posts       (user_id, post_id, s3_key, caption, created_at)
   follows     (follower_id, followee_id, created_at)
   likes       (post_id, user_id, created_at)
```

Shard `posts` on `user_id`: it's high-cardinality, present in the profile query, and keeps a user's posts co-located so a profile page is a single-shard read. See [Sharding](../building-blocks/sharding.html).

**Index `follows` in both directions.** You need "who do I follow" for reads and "who follows me" for fanout. Two indexes, or two tables — either way, both directions.

## Phase 2 — The feed, naively

The obvious implementation: at read time, fetch recent posts from everyone you follow and merge.

```diagram
   GET /feed
     → SELECT followee_id FROM follows WHERE follower_id = me   (200 rows)
     → SELECT * FROM posts WHERE user_id IN (...) ORDER BY created_at LIMIT 20
```

**Why this dies:** that's a 200-way scatter-gather across shards, executed 750,000 times per second at peak. Latency is bounded by the slowest shard ([tail amplification](../fundamentals/latency-throughput.html)), and cost scales with follow count, not result size.

You've put the expensive work on the frequent operation. Exactly backwards for a 250:1 ratio.

## Phase 3 — Precompute the feed (fanout on write)

Flip it. When someone posts, immediately write the post ID into every follower's precomputed feed.

```diagram
   Alice posts
      → publish event to Kafka
      → fanout worker: look up Alice's followers
      → for each: ZADD feed:{follower_id} {timestamp} {post_id}

   GET /feed → ZREVRANGE feed:{me} 0 19   ← one Redis call, ~1ms
```

Reads become a single sorted-set read. The 250:1 ratio now works *for* you.

**Trim aggressively.** Nobody scrolls past a few hundred items:

```diagram
   Keep 800 post IDs per feed.
   Active users only (opened app in 30 days): say 100M
   100M × 800 × 8 B = 640 GB → ~20 Redis nodes

   Materializing feeds for all 500M users would be 3.2 TB
   for feeds most of which are never read.
```

**Fanout is async** via [Kafka](../building-blocks/message-queues.html). The user's post request returns in ~50 ms; fanning out to 200 followers takes longer and they don't need it to have finished.

## Phase 4 — The celebrity problem

**The trigger:** an account with 100M followers posts. That's 100M Redis writes from a single action — minutes of work, and it starves every other fanout.

```diagram
   ON POST:
     followers < 10,000  → PUSH (fan out)
     followers ≥ 10,000  → don't fan out; mark as celebrity

   ON READ:
     1. read precomputed feed          (push portion)
     2. fetch recent posts from the few celebrities you follow
     3. merge by timestamp, return top 20
```

This works because follower counts follow a power law: the overwhelming majority of accounts are far below any reasonable threshold, so nearly every post is pushed and reads stay cheap. And you follow only a handful of celebrities, so the pull portion is small and bounded.

**Two refinements worth naming:**

- The threshold must be **evaluated at post time** against current follower count, and it needs **hysteresis** (promote at 10K, demote at 8K) or accounts hovering at the boundary flip between strategies on every post.
- Celebrity posts are read by everyone, so they cache at close to a 100% hit rate. The pull path is cheap precisely because it's concentrated.

## Phase 5 — Hydration and counts

The feed cache holds only IDs. Rendering needs the photo URL, author name and avatar, like and comment counts, and whether *you* liked it.

```diagram
   20 post IDs → batched multi-get across:
     · post metadata service
     · user/profile service (cached hard — profiles change rarely)
     · counts service
     · "did I like this" — per-viewer, can't be shared
```

Batch everything. Twenty sequential lookups would be 20 round trips; one batched call is one.

**Counts must never be a synchronous row update.** A viral post would make one row take 50,000 writes/s. Instead: publish like events to Kafka, aggregate in a stream processor, store rollups, and serve approximate counts. Users cannot tell the difference between 1,203,847 and "1.2M" — and the product should display the rounded version anyway, which makes the approximation invisible by design.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| Hybrid fanout (push + pull) | Pure push | One celebrity post = 100M writes |
| | Pure pull | 200-way scatter-gather on the most frequent operation |
| Materialize feeds for active users only | All users | 3.2 TB of feeds mostly never read |
| Trim feeds to ~800 items | Unbounded | Nobody scrolls that far; memory is the constraint |
| Async fanout via Kafka | Synchronous | Post must return in ~50ms; fanout takes longer |
| Counts via stream aggregation | `UPDATE ... SET count = count + 1` | Viral post = one hot row at 50K writes/s |
| Shard posts on `user_id` | Shard on `post_id` | Profile page becomes a single-shard read |
| Filter deletes at read time | Scrub every feed cache | Deleting from 100M feeds is the fanout problem again |

## What you'd cut for v1

Stories, reels, DMs, explore, search, ads. Ship: upload, follow, chronological feed, likes. And ship **pull-only fanout first** — it's simpler, has no celebrity problem, and lets you measure the real follower distribution before committing to a threshold you'd otherwise be guessing at.

## Explaining the design

> "Read:write is about 250:1, so I want the expensive work on the write path. I'd precompute feeds — on post, fan out the post ID into each follower's Redis sorted set, trimmed to 800 and only for users active in the last 30 days. That makes a feed read one cache call.
>
> The obvious problem is celebrity fanout: a 100M-follower account would generate 100M writes from one post. So it's a hybrid — push below about 10,000 followers, pull above, merged at read time. Since follower counts are power-law distributed, almost everything is pushed and reads stay cheap.
>
> I'd ship pull-only first and add push once we've measured the actual distribution."

## Next

[Build Twitter](twitter.html) — same fanout problem, but with real-time delivery and a much harder ranking layer.
