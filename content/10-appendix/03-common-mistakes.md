---
title: Common Mistakes
summary: The failure patterns that sink otherwise-competent candidates, ranked by how often they actually cost the offer — with the specific fix for each.
difficulty: Easy
scope: Both
tags: [mistakes, interview, pitfalls]
---

## 1. Designing before scoping

**The mistake:** drawing boxes in minute two.

The prompt is deliberately underspecified. "Design Twitter" could mean a system for 10,000 users or 500 million, read-heavy or write-heavy, with or without media. Every architectural decision depends on answers you haven't gathered.

**The fix:** spend the first 6–8 minutes on requirements, and **cut scope explicitly**. "I'm treating DMs, search, and ads as out of scope to focus on feed generation — push back if you'd rather I go elsewhere."

## 2. The passive candidate

**The mistake:** waiting to be told what to do next. Every "…is that what you want me to do?" costs you.

This is the most common reason strong engineers fail system design interviews. In their day job someone else sets direction; here, *you* are being evaluated on whether you can.

**The fix:** make decisions and offer off-ramps. "I'll assume 100M DAU and read-heavy — sound right?" That's a *decision with a checkpoint*, not a request for permission. Announce your plan for the time. Choose your own deep dives when the interviewer doesn't.

## 3. Buzzword architecture

**The mistake:** "I'll use Kubernetes, Kafka, Redis, Cassandra, and Elasticsearch" — stated before the access patterns are known.

Naming technologies without justification is a red flag, not a green one. It suggests you match tools to prestige rather than to requirements.

**The fix:** describe the *function* first, then name the technology with its reason. "I need a durable buffer between a spiky write path and a slow consumer — a log-based queue, so Kafka. The alternative is a direct call, which is simpler, but a consumer slowdown would become user-facing 500s."

## 4. Over-engineering

**The mistake:** proposing multi-region active-active, service meshes, and event sourcing for a system with modest requirements.

Senior engineers are evaluated on *judgment*, and judgment includes knowing what not to build. Complexity you can't justify is a liability.

**The fix:** match the solution to the scale, and **say the threshold**. "One Postgres primary handles 10K QPS comfortably. I'd shard when sustained writes approach 30K/s or the working set stops fitting in RAM." Proposing the simple thing confidently is a senior signal.

## 5. Ignoring hints

**The mistake:** the interviewer says "Interesting… what if writes were much heavier?" and you say "It'd still work" and continue.

That was not curiosity. It was a rescue, and the interviewer has now used one of their few tools to help you.

**The fix:** treat every interviewer question as a redirection. "Good point — let me reconsider. If writes are 10× what I assumed, my push-based fanout breaks down because…" Follow them immediately and visibly.

## 6. Bluffing

**The mistake:** confidently inventing details about a system you don't know.

Interviewers detect this far more reliably than candidates expect — usually within one follow-up question. And it's often fatal, because it makes every *other* claim you made suspect.

**The fix:** state your boundary honestly. "I've not operated Spanner myself. My mental model is TrueTime bounds plus Paxos groups per split, but I'd be guessing past that." This scores **better** than invention, and it costs nothing — nobody is deep everywhere.

## 7. Never going deep

**The mistake:** twelve components, none explored. A tour of your vocabulary rather than a demonstration of engineering.

Technical depth is roughly 30% of the score, and breadth cannot substitute for it.

**The fix:** budget half the interview for deep dives. Seven components with two genuinely explored beats twelve at surface level. Pick the hardest part and say why you picked it.

## 8. Estimation theater

**The mistake:** computing memory bandwidth to three significant figures, then never referencing the number again.

**The fix:** estimate only what changes a decision, say that's what you're doing, and **end each calculation with its conclusion**. "160 TB/day — that rules out blob storage in the database." The conclusion is the scored part.

## 9. Ignoring failure

**The mistake:** a design where every component works forever, with no discussion of what happens when one doesn't.

**The fix:** volunteer failure analysis. Walk the diagram and kill each box. "If the cache cluster dies, all reads hit the database — which is sized for 5% of that, so it falls over. I'd add a circuit breaker to shed load rather than take the database down." See [Failure Modes](../01-fundamentals/failure-modes.html).

## 10. The unlabeled diagram

**The mistake:** boxes connected by bare arrows.

Every interesting decision lives in those arrows. Sync or async? What protocol? What data flows? An unlabeled arrow hides exactly what's being evaluated.

**The fix:** label everything, and narrate one full request end to end. That proves the design is coherent rather than a collection of components you've heard of.

## 11. Consistency as a global choice

**The mistake:** "This system is eventually consistent."

Real systems choose per operation — the payment is strict, the view counter isn't. Declaring one setting for the whole system suggests you learned [CAP](../fundamentals/cap-pacelc.html) as a slogan rather than as a decision you make repeatedly.

**The fix:** classify the data. "Inventory and payment need linearizability — a read there drives an irreversible action. Feed and counters are eventual. The user's own posts get read-your-writes, because that's the only staleness anyone actually notices." See [Consistency Models](../01-fundamentals/consistency-models.html).

## 12. Forgetting the operational reality

**The mistake:** designing a system with no consideration of deploys, migrations, monitoring, or on-call.

Most outages are caused by *change*, not hardware — so a design that ignores change ignores the dominant failure mode.

**The fix:** mention how you'd roll it out (staged, cell by cell, with automated rollback), what you'd monitor (queue lag in *time*, p99 split by success/failure, saturation), and how you'd migrate. This is a distinctly senior differentiator that few candidates touch.

## 13. Cost blindness

**The mistake:** replicating petabytes across regions with no acknowledgment of what that costs.

**The fix:** mention cost where it's material. "At 1.5 EB/year, tiering cold content to archive storage isn't an optimization — it's the difference between viable and not." Cross-region egress, hot-tier storage, and transcoding compute are all worth naming.

## 14. Silence

**The mistake:** thinking quietly for ninety seconds.

The interviewer cannot score reasoning they can't hear, and silence reads as being stuck even when you aren't.

**The fix:** externalize. "I'm weighing two options — a queue decouples but adds latency, a direct call is simpler but couples availability. The deciding factor is whether the caller needs the result, and here it doesn't, so queue." Even "let me think for a moment about the partition key" is better than silence.

## 15. Not finishing

**The mistake:** the timer runs out mid-sentence, with no summary.

**The fix:** watch the clock. At five minutes remaining, close deliberately: bottleneck at 10×, main failure mode, what you'd cut for v1, what you'd monitor. A clean close leaves a strong final impression and covers ground the middle of the interview didn't.

---

## The rank order

If you fix only three things, fix these:

```diagram
   1. Be the one driving          (navigation ≈ 30% of the score)
   2. Justify against alternatives (tradeoffs ≈ 25%)
   3. Go deep somewhere            (depth ≈ 30%)
```

Everything else on this page is a variation on those three.
