---
title: An Annotated Mock Interview
summary: A full 45-minute transcript for "design Instagram," with the interviewer's scoring notes exposed at each moment — including where the candidate nearly lost points.
difficulty: Medium
scope: HLD
tags: [mock, transcript, practice]
---

:::predict Guess first
1. In the first two minutes of "design Instagram", what would an interviewer most like to hear?
2. Asked "how did you pick 10,000 followers as the threshold?", should the candidate defend the number?
3. If the Redis feed cache fails, what should a well-designed feed do?
:::

:::note How to read this
The transcript runs down the page; the boxed notes are what the interviewer was thinking and writing down. Read it once straight through, then re-read only the notes — they're the actual curriculum here.
:::

---

**Interviewer:** Let's design Instagram.

**Candidate:** Sure. Before I start, let me make sure I understand the scope, and then I'll lay out how I'd like to use the time.

So Instagram at its core is: users upload photos, follow other users, and see a feed of photos from people they follow. There's also stories, DMs, reels, search, and explore. Is there a particular part you want me to focus on, or should I pick?

**Interviewer:** You pick.

**Candidate:** Then I'll focus on **photo upload and feed generation**, and treat DMs, stories, reels, and search as out of scope. I think feed generation is where the real difficulty is. Push back if you'd rather I go elsewhere.

For time: about five minutes on requirements and estimation, then API and data model, a high-level design by roughly minute 25, and I'd like to leave a solid fifteen minutes for deep dives.

:::interview Interviewer notes — minute 2
✓ Restated the problem before designing
✓ **Cut scope explicitly** and justified the cut
✓ Announced a time plan and invited redirection

This is the strongest possible opening. Already reads L5. Most candidates start drawing boxes by now.
:::

---

**Candidate:** Functional requirements, keeping it tight:
1. Upload a photo with a caption.
2. Follow and unfollow users.
3. View a feed of recent photos from people you follow.
4. Like a photo.

Non-functional — a few questions. What scale are we targeting?

**Interviewer:** Let's say 500 million daily actives.

**Candidate:** And is the feed chronological, or ranked?

**Interviewer:** Assume chronological for now.

**Candidate:** Good, that simplifies it. I'll note that real systems rank, and I'll mention where that changes things.

Last one: is there a celebrity problem — accounts with tens of millions of followers?

**Interviewer:** Yes, assume so.

**Candidate:** That's the constraint that will shape the design, so I'm glad I asked.

So non-functional: read-heavy by a large margin; feed load needs to be fast, let's target p99 under 200 ms; eventual consistency is fine — a photo appearing two seconds late is invisible; and high availability, where a stale feed is much better than no feed.

:::interview Interviewer notes — minute 7
✓ Only four functional requirements — resisted the urge to list everything
✓ Asked about the **celebrity distribution** unprompted. This is the crux of the question, and identifying it early is a strong signal.
✓ Non-functionals are numeric and specific, not "it should be fast and scalable"
✓ Noted the chronological/ranked simplification rather than silently accepting it
:::

---

**Candidate:** Let me do estimation, but only the numbers that will change a decision.

500M DAU. Say each user uploads 0.2 photos a day and views 50.

Writes: 500 million times 0.2 is 100 million a day. A day is roughly 10⁵ seconds, so that's **1,000 uploads per second** average, call it 3,000 at peak.

Reads: 500 million times 50 is 25 billion views a day, so **250,000 per second**, 750,000 peak.

So the read-to-write ratio is **250 to 1**. That's the most important number so far — it tells me I should push work onto the write path and make reads as cheap as possible.

Storage: at 1.5 MB per photo plus thumbnails, 100 million a day is about **160 terabytes a day**. That immediately rules out storing photos in the database — they go to object storage with metadata in a database.

Metadata is much smaller: about 500 bytes a row, so 50 GB a day, 18 TB a year. That's too much for one node over five years, so we shard — but it's a routine amount, nothing exotic.

The number I actually care about most:

**Interviewer:** Go on.

**Candidate:** Fanout cost. 1,000 uploads a second times an average of, say, 200 followers, is **200,000 feed writes per second** if I materialize feeds eagerly. That's large but tractable.

But one post from a 100-million-follower account is **100 million writes from a single action**. That's the number that kills the naive design.

:::interview Interviewer notes — minute 13
✓ Said estimation is decision-driven — and then actually used every number
✓ Rounded aggressively (10⁵ seconds), no calculator theatre
✓ **Each calculation ended with a conclusion.** 160 TB → object storage. 18 TB → shard, routinely.
✓ Computed the fanout number and identified it as the design driver

This is textbook. The 100M-writes figure is exactly what I want a candidate to surface before I have to ask.
:::

---

**Candidate:** API, briefly:

`POST /v1/photos` with caption and a media ID, returns 201.
`GET /v1/feed?cursor=...&limit=20`, returns items plus a next cursor.
`POST /v1/users/{id}/follow`.

I'm using **cursor pagination rather than offset** — offset on a feed that's constantly gaining items shows duplicates and skips as you scroll, and it forces the database to scan and discard rows. A cursor encodes a position and is O(1) and stable.

For upload, the client gets a **presigned URL** and uploads directly to object storage — my application servers never touch the bytes. Then it calls the API with the resulting key, and I verify the object exists and matches the expected size before writing the metadata row.

**Interviewer:** Why verify?

**Candidate:** Otherwise a client can create a metadata row pointing at an object that was never uploaded, or claim a file it doesn't own. Never trust the client's "done" call.

:::interview Interviewer notes — minute 17
✓ Cursor pagination **with the reason**, unprompted
✓ Presigned upload — knows the app tier shouldn't proxy bytes
✓ Handled the verification follow-up correctly and immediately. Security instinct present without being asked.
:::

---

**Candidate:** Data model:

`photos` in Cassandra — partition key `user_id`, clustering key `created_at` descending. That makes "recent photos by a user" a single-partition range scan, which is the cheapest possible access pattern.

`follows` — the pair of user IDs, indexed in both directions. I need "who do I follow" for the read path and "who follows me" for fanout.

`feed_cache` in Redis — a sorted set per user, holding photo IDs scored by timestamp, **trimmed to about 800 entries**.

**Interviewer:** Why trim?

**Candidate:** Nobody scrolls past a few hundred items. Storing unbounded feeds would dominate memory for no benefit. Past the cached window, I generate the feed on demand — slower, but it's an interaction a very small fraction of sessions ever have.

And I'd only materialize feeds for **active** users. Someone who hasn't opened the app in 30 days doesn't need one; build it when they return. That probably cuts fanout volume by more than half.

:::interview Interviewer notes — minute 21
✓ Partition key chosen with the access pattern stated
✓ Trimming, with the reasoning
✓ **The active-users optimization is volunteered, not prompted.** This is the kind of cost-awareness that separates L5 from L4.
:::

---

*[Candidate draws the architecture: upload path through an API to object storage and Cassandra; a Kafka topic feeding fanout workers writing to Redis; a feed service reading from Redis and hydrating.]*

**Candidate:** Let me narrate one request end to end. A user uploads. The client has already put the bytes in object storage, so the API writes a metadata row to Cassandra and publishes an event to Kafka, then returns — about 50 milliseconds. Fanout happens asynchronously, because the user doesn't need it to have completed and it takes longer than the response budget.

The fanout worker looks up the author's followers and writes the photo ID into each follower's Redis feed.

On feed read, the feed service reads the sorted set, then **hydrates** — the cache holds only IDs, so I need photo URLs, author names, like counts, and whether this viewer liked it. That's a batched multi-get across a couple of services.

Now, the obvious problem with what I've drawn is celebrity fanout. Let me handle that.

:::interview Interviewer notes — minute 26
✓ Narrated a full request — the design is coherent, not a pile of boxes
✓ Explained **why** fanout is async rather than just drawing an arrow
✓ Remembered **hydration**, which many candidates forget entirely
✓ **Volunteered the flaw before I raised it.** Ownership signal.

On plan, on time, and about to go deep. Strong.
:::

---

**Candidate:** So: pure push fanout means 100 million writes for one celebrity post. Pure pull — where I fetch from everyone you follow at read time — means a 200-way scatter-gather on every feed load, at 750,000 loads per second. That's backwards given a 250:1 read ratio; I'd be making the frequent operation expensive.

So, hybrid. On post: if the author has fewer than roughly 10,000 followers, push. Above that, don't fan out at all — just store the post and mark the author as a celebrity. On read: take the precomputed feed from Redis, then separately fetch recent posts from the handful of celebrities this user follows, and merge by timestamp.

That works because follower counts follow a power law — the overwhelming majority of accounts are far below any reasonable threshold, so nearly all posts are pushed and reads stay cheap. And each user follows only a few celebrities, so the pull portion is small and bounded.

**Interviewer:** How did you pick 10,000?

**Candidate:** Honestly, I didn't — it's a starting point. The real answer is that it's a **tunable knob** balancing fanout write cost against read-time merge cost, and I'd set it from the actual follower distribution in production. I'd also want it configurable at runtime rather than in code, because we'll get it wrong initially and I don't want a deploy to fix it.

**Interviewer:** What if a normal user suddenly goes viral?

**Candidate:** Good case. The threshold has to be evaluated at post time against the current follower count, not cached — so an account that crosses it starts being pulled on its next post. The awkward case is an account hovering right at the boundary, flipping between push and pull. I'd add hysteresis: promote to celebrity at 10,000 but only demote below 8,000, so it doesn't oscillate.

:::interview Interviewer notes — minute 33
✓ Both alternatives stated with their real costs before recommending
✓ Justified the hybrid against the **read:write ratio** — connected back to the estimation
✓ On "how did you pick 10,000": did not bluff. Said it's a tunable knob, then added runtime configurability. **Honesty plus an operational upgrade.**
✓ Handled the viral edge case, then went further and identified oscillation and proposed hysteresis — I did not ask for that

Clear hire signal at senior. Probing higher now.
:::

---

**Interviewer:** What happens when the Redis feed cluster fails?

**Candidate:** Feeds are derived data, so nothing is lost — but everyone's feed read now falls through. The important design property is that **the pull path always works**, because it's the same code path I use for celebrities. So a Redis failure degrades to full pull: slower feeds, higher database load, but a functioning product.

I'd want a circuit breaker in front of the database, though. If 750,000 reads a second suddenly go from Redis to Cassandra, Cassandra is sized for a fraction of that and will fall over — which turns a cache outage into a total outage.

**Interviewer:** So you'd shed load?

**Candidate:** Yes, by priority. Serve the first page of the feed and drop the tail; drop like counts and render without them; disable explore. The core interaction survives and the periphery is sacrificed.

And I'd be careful about recovery — bringing an empty Redis cluster back into full traffic means it's cold, so 100% of reads still hit the database and it dies again. Ramp traffic gradually and pre-warm the hottest feeds.

:::interview Interviewer notes — minute 39
✓ **Designed the fallback path to be the same as an existing path.** That's not luck — that's a deliberate choice made earlier that pays off here.
✓ Identified that a cache failure cascades into a database failure
✓ Graceful degradation by feature priority, with product judgment about what's expendable
✓ **Cold-start recovery** — unprompted. Very few candidates think about recovery as its own overload event.

This is L6-flavoured reasoning.
:::

---

**Interviewer:** Two minutes left. Anything you'd add?

**Candidate:** Three quick things.

**Bottleneck at 10×:** the fanout worker pool. I'd partition it by follower ID so each worker writes to a known set of Redis shards and keeps its pipelines full.

**What I'd cut for v1:** ship pull-only. It's simpler, it has no celebrity problem, and it lets us measure the actual follower distribution before committing to a threshold. Add push once we have data.

**What I'd monitor:** fanout consumer lag measured in *time* rather than message count, because that's what maps to user impact; feed p99 split by push versus pull path; and Redis hit rate, since a drop there is the leading indicator of everything else going wrong.

:::interview Interviewer notes — minute 45
✓ Named the next bottleneck with a fix
✓ **"Ship the simpler thing first and measure"** — genuinely senior judgment. Deferred the hardest decision until there was data to make it with.
✓ Monitoring answer is specific and correct (lag in time, not count)

**Recommendation: strong hire, senior.**

What made this work, in order of weight:
1. Cut scope in minute two and managed the clock throughout
2. Every number produced a decision
3. Volunteered the design's weakness before I found it
4. Didn't bluff on the threshold question — and turned the admission into a better answer
5. Went past the question repeatedly — hysteresis and cold-start recovery, neither of which I asked for
:::

---

## What to take from this

The candidate did not know anything you don't. The transcript contains no exotic technology and no paper citations. What it contains is:

- **Scoping in the first two minutes**, out loud.
- **Numbers that end in conclusions.**
- **Alternatives named before recommendations.**
- **Self-critique before challenge.**
- **Honesty on the one question they couldn't answer** — which became the strongest moment of the interview.
- **Going one step past every question.**

Run this same transcript in your head for a different prompt. If you can produce those six behaviours consistently, the technical content largely takes care of itself.

## Check yourself

```recall
Q: What made the mock's opening strong?
A: Restating the problem, cutting scope explicitly with a reason (upload and feed in; DMs, stories, reels, search out) and announcing a time plan with an invitation to redirect.

Q: Which clarifying question shaped the whole design?
A: Whether celebrity accounts exist — the fanout number (100M writes from one post) becomes the design driver.

Q: How did the candidate use estimation?
A: Every number ended in a decision: 250:1 read ratio → push work to writes; 160 TB/day → object storage; 18 TB/year metadata → routine sharding; 200K feed writes/s → tractable fanout.

Q: How did the candidate handle "how did you pick 10,000?"
A: Without bluffing: it's a tunable knob set from the real follower distribution, configurable at runtime — then hysteresis (promote at 10K, demote at 8K) for boundary accounts.

Q: Why was the Redis-failure answer L6-flavoured?
A: The fallback was an existing path (pull), plus a circuit breaker so a cache outage doesn't cascade into the database, degradation by feature priority, and gradual cold-start recovery.

Q: What did the candidate say to close?
A: Bottleneck at 10× (partition fanout workers by follower ID), ship pull-only first and measure, and monitor consumer lag in time, feed p99 by path and Redis hit rate.

Q: Name the six behaviours that made the mock a strong hire.
A: Scoping out loud early, numbers ending in conclusions, alternatives before recommendations, self-critique before challenge, honesty on the unanswerable question, and going one step past each question.
```

## What to carry forward

- Scope and plan in the first two minutes.
- Find the constraint that drives the design and compute it.
- Volunteer the weakness, then resolve it with named alternatives.
- Turn "I don't know" into an honest, operational answer.
- Design fallbacks that reuse existing paths, and close with bottleneck, v1 cut and monitoring.
