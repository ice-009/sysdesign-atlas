---
title: The Interview Framework
summary: A minute-by-minute structure for 45 minutes that keeps you driving, covers what's scored, and never leaves you stranded at minute 30 with nothing deep to say.
difficulty: Easy
tags: [framework, interview, structure]
---

## Why structure wins

The difference between candidates who pass and candidates who "knew the material" is usually not knowledge — it's **navigation**. A structured candidate reaches a complete design with two genuine deep dives. An unstructured one produces a sprawling diagram, runs out of time, and never demonstrates depth anywhere.

The structure below is a default, not a script. Announce it at the start, and deviate deliberately when the interviewer steers you.

```viz
{
  "type": "steps",
  "caption": "A default structure for 45 minutes. Announce it, then deviate deliberately.",
  "note": "Minute markers are a guide, not a script \u2014 take the interviewer's redirection over the plan every time.",
  "steps": [
    {
      "label": "0\u20132 \u00b7 Clarify",
      "sub": "Restate the problem in your own words and confirm before designing."
    },
    {
      "label": "2\u20138 \u00b7 Requirements",
      "sub": "Functional, non-functional, and an explicit scope cut."
    },
    {
      "label": "8\u201313 \u00b7 Estimation",
      "sub": "Only what changes a decision \u2014 and say so."
    },
    {
      "label": "13\u201317 \u00b7 API + data model",
      "sub": "The contract, then the schema and the partition key."
    },
    {
      "label": "17\u201327 \u00b7 High-level design",
      "sub": "Draw first, narrate one request end to end, label every arrow."
    },
    {
      "label": "27\u201340 \u00b7 Deep dives",
      "sub": "Where most of the score lives. Two or three areas, properly."
    },
    {
      "label": "40\u201345 \u00b7 Wrap up",
      "sub": "Bottleneck at 10\u00d7, failure modes, what you'd cut, what you'd monitor."
    }
  ]
}
```

:::interview Open with the plan
"Before I start, here's how I'd like to use the time: about five minutes on requirements and scope, a few on estimation, then a high-level design by minute 25, leaving fifteen-plus minutes for deep dives on the hardest parts. Push me somewhere else whenever you want."

Fifteen seconds. It signals time management, invites steering, and makes everything after it feel deliberate. Very few candidates do it.
:::

## 0–2 · Clarify and restate

Do not start designing. Restate the problem in your own words and confirm.

> "So we're building the backend for a photo-sharing app — users upload photos, follow each other, and see a feed. Is that the right framing, or is there a specific part you want me to focus on?"

This catches misunderstandings before they cost you 20 minutes, and it occasionally surfaces that the interviewer wants something narrower than you assumed.

## 2–8 · Requirements

**Functional requirements** — 3 to 5 bullet points, no more. Then, critically:

**Cut scope explicitly.**

> "There's a lot here. I'm going to treat search, DMs, and ads as out of scope and focus on the feed and upload paths, since I think feed generation is the core difficulty. Sound right?"

This is the single highest-value sentence in the first ten minutes. It demonstrates prioritization and gives the interviewer a chance to redirect you before you've invested.

**Non-functional requirements** — these determine the architecture, so be specific and *numeric*:

| Ask about | Why it changes the design |
|---|---|
| Scale (DAU, QPS) | 100K vs 500M users are different systems |
| Read:write ratio | Decides caching and replication strategy |
| Latency target | Sub-100ms rules out synchronous cross-region |
| Consistency needs | Strong vs eventual — usually varies **per operation** |
| Availability target | Three vs four nines changes failover requirements |
| Data retention | Drives storage tiering and cost |

Don't recite the list. Ask the two or three that matter for *this* problem, and state assumptions for the rest: "I'll assume 100M DAU and read-heavy at roughly 100:1 — flag if you'd rather different numbers."

## 8–13 · Estimation

Only compute what will **change a decision**. Say that you're doing so.

> "I'll size storage because it determines whether we can use one database or need to shard, and I'll compute peak read QPS because it tells me whether we need a CDN. I'll skip CPU estimates since they won't change the architecture."

Then do the math out loud, rounding aggressively (see [Back-of-the-Envelope](../01-fundamentals/back-of-envelope.html)). Finish each calculation with its **conclusion**:

> "…so 160 TB a day. That rules out storing media in the database — it goes to object storage with metadata in Postgres."

The conclusion is the part that scores. A number with no consequence is wasted time.

## 13–17 · API and data model

**API first** — it forces you to define the contract before the implementation, and it often exposes a requirement you missed.

```diagram
   POST /v1/photos        { caption, media_id } → 201
   GET  /v1/feed?cursor=  → { items[], next_cursor }
```

Use **cursor pagination**, not offset — and say why (stable under concurrent inserts, O(1) rather than scanning and discarding).

**Then the data model.** Entities, key fields, and — most importantly — **the partition key with justification**:

> "I'll shard on `user_id`: high cardinality, present in the majority of queries, and it keeps a user's data co-located so a profile page is a single-shard read. The cost is that global queries become scatter-gather, which I'd handle with a separate index."

Key, reason, named cost, mitigation. That's the shape of every good design statement.

## 17–27 · High-level design

**Draw first, talk second.** Boxes and arrows, then narration.

Rules that make a diagram legible:
- **Label every arrow** — sync or async? What protocol? What data?
- Keep it to **6–9 components**. More is not better; it's just less depth per box.
- **Narrate one request end to end.** "A user posts. It hits the LB, routes to the post service, which writes to Cassandra, publishes to Kafka, and the fanout worker picks it up…" This proves the design is coherent rather than a pile of components.

Then **volunteer the weakness**:

> "The obvious problem with this is celebrity fanout — one account with 100M followers generates 100M writes from a single post. Let me handle that."

Self-critique before being caught reads as ownership. Waiting to be caught reads as luck.

## 27–40 · Deep dives — the main event

**This is where most of the score lives**, and it's where unstructured candidates never arrive.

**Choose 2–3 areas.** Either take the interviewer's hint (always — a hint is a rescue, not curiosity) or pick the genuinely hardest part and say why:

> "I think the two hardest problems here are feed fanout and the hot-partition risk from celebrity accounts. I'd like to go deep on fanout first."

**Structure each dive the same way:**

```viz
{
  "type": "steps",
  "caption": "Structure every deep dive the same way. Repetition is what makes it automatic.",
  "steps": [
    {
      "label": "State the problem",
      "sub": "Precisely, with a number attached."
    },
    {
      "label": "Give 2\u20133 approaches",
      "sub": "With their real tradeoffs, not strawmen."
    },
    {
      "label": "Recommend one",
      "sub": "Naming the constraint that decided it."
    },
    {
      "label": "Name what it costs",
      "sub": "Volunteer the weakness before you're asked."
    },
    {
      "label": "Handle the edge case",
      "sub": "The one that breaks your own recommendation."
    }
  ]
}
```

Expect three layers of "why?" Have a floor, and be honest when you reach it: *"I've not operated Spanner myself — my mental model is TrueTime bounds plus Paxos groups per split, but I'd be guessing past that."* That scores **better** than confident invention, which interviewers detect reliably and which makes every other claim suspect.

## 40–45 · Wrap up

Don't trail off. Close deliberately:

**Bottlenecks:** "The first thing to break at 10× is the fanout worker pool; I'd shard it by follower ID."

**Failure modes:** walk the diagram and kill one box. "If Redis dies, feeds rebuild from the pull path — slower but functional, which is why I made sure the pull path always works."

**What I'd cut for v1:** "I'd ship with pull-only fanout and add push once we understand the follower distribution. Simpler, and it defers the hardest part until we have data."

**What I'd monitor:** "Fanout consumer lag in time, feed p99, and cache hit rate."

That last set is unusual and lands well — it shows you think about running the system, not just drawing it.

## The dial: matching scale to solution

The most common failure at senior levels is **over-engineering**. Proposing multi-region active-active for a system with 1,000 users signals that you match technologies to prestige rather than to requirements.

```diagram
   < 10K users      one server + one database. Genuinely.
   < 1M users       LB + few app servers + primary/replica + cache
   < 10M users      + CDN, + queues, + read replicas, maybe shard
   < 100M users     sharding, multi-AZ, dedicated services
   > 100M users     multi-region, cells, custom infrastructure
```

Say the threshold out loud: *"At this scale one Postgres primary handles it. I'd revisit when sustained writes approach 30K/s."* That's a senior signal, not a naive one.

## Recovery moves

**You're stuck.** Say so and reason aloud: "I'm weighing two options here — let me think through which constraint decides it." Silence is the only wrong answer.

**You realize you made a mistake.** Correct it plainly and move on: "Actually, sharding by user_id breaks the conversation query — let me use conversation_id instead." Catching your own error is a positive signal, not a negative one.

**You're running out of time.** Prioritize out loud: "We have five minutes — I'd rather go deep on the storage layer than sketch the remaining services. Is that the right call?"

**The interviewer challenges you.** Take it seriously; don't defend reflexively. "That's a fair point — if writes are that heavy, my assumption about push fanout breaks. Let me reconsider." Changing your mind under good argument is exactly what a colleague does.

## The one-line summary

**Drive the conversation, quantify your assumptions, justify against alternatives, go deep somewhere, and name what your design costs.** Every element of the [rubric](../10-appendix/what-interviewers-score.html) is covered by that sentence.
