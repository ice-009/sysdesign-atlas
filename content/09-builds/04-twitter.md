---
title: Build Twitter / X
summary: Fanout at higher write volume, plus real-time delivery, trending detection, and the ranking layer that changes the feed problem entirely.
difficulty: Medium
scope: HLD
level: 2
prereqs: [news-feed, message-queues, realtime, bloom-filters, ad-click-aggregator]
tags: [level-2, feed, realtime, streaming]
unlocks: Fanout under heavy writes, trending detection, and how ranking reshapes a feed.
---

:::predict Guess first
1. Should a retweet copy the original post's text, or point to it?
2. For live timeline updates, should the server push the new posts themselves, or just a note that new posts exist?
3. A word is always popular — say "the". Is it trending?
:::

## The product

Post short text. Follow accounts. See a timeline. Retweet, reply, like. Discover what's trending.

Structurally similar to [Instagram](instagram.html), but three things differ and each changes the design: **writes are far heavier**, **delivery is expected to be near-instant**, and **trending is a real-time analytics problem sitting alongside the feed**.

## Estimation

```diagram
   400M DAU · 2 posts/user/day · 100 timeline views/day

   Writes:  400M × 2 / 10⁵    = 8,000 posts/s → 25,000 peak
   Reads:   400M × 100 / 10⁵  = 400,000 QPS   → 1.2M peak
   Ratio:   50:1  ← still read-heavy, but writes are 8× Instagram's

   Post size: 300 B text + metadata ≈ 1 KB
   Storage:  800M posts/day × 1 KB = 800 GB/day → 290 TB/year

   FANOUT: 8,000 posts/s × 200 followers = 1.6M feed writes/s
```

**1.6M feed writes/s is the headline number.** It's tractable with a partitioned Redis fleet, but it means fanout workers are a first-class service with their own capacity planning — not a background job.

## Phase 1 — Posts and timelines

Same foundation as Instagram: posts in a wide-column store partitioned by `user_id` with `created_at` clustering (so "recent posts by X" is a single-partition range scan), follows indexed both ways, feeds precomputed into Redis sorted sets.

```diagram
   posts     PARTITION user_id, CLUSTER created_at DESC   (Cassandra)
   follows   (follower_id, followee_id) — indexed both directions
   feed      Redis ZSET per user, trimmed to ~800
```

Fanout is [hybrid](instagram.html) for the same reason: accounts with tens of millions of followers can't be pushed.

## Phase 2 — The reply and retweet graph

New structure Instagram doesn't have. A post can be:

- **Original** — stands alone.
- **Reply** — points at a parent; must render in a thread.
- **Retweet** — points at an original; renders the original with attribution.
- **Quote** — a new post *embedding* an original.

```diagram
   posts
     post_id · author_id · text · created_at
     parent_id      NULL | post_id     (reply)
     retweet_of     NULL | post_id     (retweet)
     quoted_id      NULL | post_id     (quote)
```

**Retweets are the interesting case.** Don't copy the text — store a pointer. A retweet of a post that's later edited or deleted must reflect that, and duplicating text across millions of retweets would multiply storage and make deletion a fanout problem.

**But pointers cost you a hydration hop.** Rendering a timeline of retweets means fetching the originals too. Batch them, and cache originals hard — a viral post is referenced by millions of retweets, so it's the hottest possible cache key.

**Thread rendering** is a recursive walk that you must bound. Fetch the parent chain to a fixed depth (say 5) and lazy-load the rest. An unbounded thread walk is a latency cliff waiting for a pathological thread.

## Phase 3 — Real-time delivery

Instagram's feed can be seconds stale. Twitter's is expected to update live.

```diagram
   post created
      → fanout to feed caches (as before)
      → ALSO publish to a pub/sub channel per follower
      → connected clients holding a WebSocket/SSE
        receive "3 new posts" immediately
```

**The key design choice: push the notification, not the content.** Send "there are new posts" and let the client fetch them through the normal path when the user pulls to refresh. That way:

- The real-time layer carries tiny messages, so fanout is cheap.
- The read path stays exactly one code path — no divergence between "live" and "loaded" content.
- A dropped real-time message is harmless; the next refresh corrects it.

This is [SSE](../building-blocks/realtime.html) territory rather than WebSockets — delivery is server-to-client only, and SSE gives you automatic reconnection with replay for free.

## Phase 4 — Trending

Genuinely a different system: a streaming aggregation, not a feed.

```diagram
   every post → Kafka
                  │
                  ▼
        ┌────────────────────┐
        │ Stream processor   │  extract hashtags, entities
        │ · count-min sketch │  per (term, geo, time bucket)
        │ · sliding window   │
        └─────────┬──────────┘
                  ▼
        top-K per region → Redis → served from cache
```

**Why a [count-min sketch](../building-blocks/bloom-filters.html) rather than exact counts:** exact counting needs one counter per term, and there are millions of terms. A sketch is a fixed-size table that answers "roughly how often has this appeared?" in kilobytes rather than gigabytes — it may over-count slightly but never under-counts, which is fine here, because you only care which terms are near the top.

**Trending is about *velocity*, not volume.** A term that's always popular isn't trending. Compare the current window's rate against a baseline — a term spiking 10× above its own trailing average is trending even at modest absolute volume. This catches breaking news, which is the entire point of the feature.

**Expect abuse.** Coordinated posting to manufacture a trend is a permanent adversarial problem: require a minimum count of *distinct* accounts, weight by account age and reputation, and detect suspiciously synchronized posting.

## Phase 5 — Ranking changes everything

The moment the timeline stops being chronological, the architecture shifts.

```diagram
   CHRONOLOGICAL           RANKED
   materialize the feed    materialize a CANDIDATE POOL
   read top 20             retrieve ~500 candidates
                           → score with a model
                           → return top 20
```

**Consequences worth naming:**

- You no longer need every post materialized in order — you need a good candidate pool, which relaxes the fanout requirement significantly.
- Scoring must fit the latency budget, so features are precomputed offline and only the final scoring runs online. This is **retrieve-then-rerank**, the same pattern as [search](../building-blocks/search.html).
- Candidates can come from sources beyond your follow graph — engagement-based recommendations, topic matches — which is how "posts you might like" appears in a following feed.

:::goat The reframe that scores
"If the timeline is ranked rather than chronological, I don't actually need to materialize every post in order — I need a good candidate pool. That relaxes the fanout problem substantially, because I'm no longer obliged to deliver every post from every followee. It's worth asking early whether the feed is ranked, because the answer changes the architecture more than any scale number does."

It is easy to miss that ranking *simplifies* fanout rather than complicating it.
:::

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| Retweets store a pointer | Copy the text | Edits/deletes must propagate; copying multiplies storage |
| Push "new posts available", not content | Push full posts | Tiny messages, one read path, dropped messages are harmless |
| SSE for live updates | WebSockets | Delivery is one-directional; SSE gives free reconnect + replay |
| Count-min sketch for trending | Exact counters | Millions of terms; approximation is completely acceptable here |
| Trending on velocity | Raw volume | Always-popular ≠ trending; breaking news is the point |
| Bounded thread depth | Recursive full walk | Unbounded recursion is a latency cliff |
| Hybrid fanout | Pure push/pull | Same celebrity math as Instagram, at 8× the write volume |

## What you'd cut for v1

DMs, spaces, lists, bookmarks, ads, ranking. Ship: post, follow, chronological timeline, like, retweet. **Trending is a separate service** — build it after the core feed works, because it shares almost nothing with it.

## Explaining the design

> "The core is the same fanout problem as any feed — hybrid push/pull with a follower threshold, because a 100M-follower account can't be fanned out. What's specific to Twitter is three things.
>
> Retweets store pointers rather than copies, so edits and deletes propagate — at the cost of a hydration hop I'd batch and cache hard.
>
> Real-time delivery pushes a *notification* that new posts exist, not the posts themselves. The client fetches through the normal path, so there's one read path and dropped messages self-correct.
>
> Trending is a separate streaming system — count-min sketch over a sliding window, ranked by velocity against a baseline rather than raw volume, because always-popular isn't trending.
>
> And I'd ask early whether the timeline is ranked, because ranking means I only need a candidate pool rather than a fully materialized ordered feed — that relaxes fanout more than any scaling technique does."

## Next

[Build WhatsApp](whatsapp.html) — where connections become stateful and losing a message is unacceptable.

## Check yourself

```recall
Q: What three things make Twitter different from Instagram?
A: Much heavier writes (~1.6 million feed writes a second), near-instant delivery expectations, and trending as a real-time analytics system beside the feed.

Q: Why do retweets store a pointer, and what does it cost?
A: Edits and deletes must propagate, and copying text into millions of retweets multiplies storage. The cost is a hydration hop — batch it and cache originals hard.

Q: Why bound thread depth?
A: Rendering a thread walks parent pointers recursively; fetch to a fixed depth (say 5) and lazy-load the rest, or one pathological thread becomes a latency cliff.

Q: How is real-time delivery designed?
A: Push a tiny "new posts available" notification over SSE, not the posts. One read path stays authoritative, fanout is cheap, and a dropped message self-corrects on refresh.

Q: How is trending computed?
A: A stream processor counts terms per region and window in a count-min sketch (kilobytes, may over-count slightly), ranking by velocity against each term's own baseline rather than raw volume.

Q: How do you resist manufactured trends?
A: Require a minimum count of distinct accounts, weight by account age and reputation, and detect suspiciously synchronised posting.

Q: How does ranking change the feed architecture?
A: You need a good candidate pool, not every post materialised in order — retrieve ~500 candidates, score with precomputed features, return 20. Ranking relaxes fanout rather than complicating it.
```

## What to carry forward

- Same hybrid fanout as Instagram, at about 8× the write volume.
- Retweets are pointers; bound thread walks.
- Live updates push notifications, not content — one read path.
- Trending is a separate streaming system ranked by velocity.
- Ask early whether the feed is ranked — it changes the architecture most.
