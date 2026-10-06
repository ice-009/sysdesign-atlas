---
title: How to Study Systems
summary: Why reading about architecture doesn't produce the ability to do it, what decades of learning research say works instead, and how every page here is built around it — guess first, check yourself, review on a schedule.
difficulty: Easy
scope: Core
tags: [orientation, meta, learning]
unlocks: Getting durable understanding out of the rest of this atlas instead of familiarity.
---

:::predict Guess first
1. Which helps you remember more a week later: re-reading a chapter, or testing yourself on it?
2. Is it better to study a topic for three hours in one sitting, or one hour on three different days?
3. Does guessing an answer before reading help you learn — even if the guess is wrong?
:::

## The problem with reading about systems

You can read a well-written explanation of consistent hashing, follow every step, and close the tab convinced you understand it. Two weeks later, asked to design a cache tier, you will reach for `hash(key) % N` — because reading produced *familiarity*, and design requires *retrieval and application*.

This is not a discipline problem. It's a well-documented property of how memory works: the fluency you feel while reading a clear explanation comes from the explanation, not from your own knowledge. The feeling of understanding is strongest exactly when the least learning is happening.

Systems design makes this worse than most subjects, for two reasons:

1. **Every answer is "it depends."** There is no list of facts to memorise. The skill is judgement about trade-offs under constraints, and judgement is only built by making calls and finding out whether they were right.
2. **The feedback loop is broken.** A wrong architectural decision doesn't fail immediately. It fails eighteen months later at 40× the traffic, by which time you've moved teams. Most engineers get a handful of real feedback signals in a career.

So this atlas is built to manufacture the feedback that real work doesn't give you. This page explains how, and why.

## What the research says

The most cited summary of the evidence is a 2013 review by Dunlosky and colleagues, which rated ten common study techniques by how well they hold up across ages, subjects and test formats. The verdicts were blunt:

| Rating | Technique | What it means here |
|---|---|---|
| **High** | **Practice testing** — retrieving from memory, not re-reading | Every topic's *Check yourself* cards |
| **High** | **Distributed practice** — spreading study out over time | The *Review* page's schedule |
| Moderate | Interleaving — mixing different kinds of problem | Review mixes cards from every section |
| Moderate | Self-explanation and asking "why?" | The *Guess first* box and the exercises |
| Low | Re-reading | What most people do by default |
| Low | Highlighting and summarising | Useful for finding your place; weak for memory |

Three findings sit underneath the design of every page:

**Retrieval beats review.** In a classic experiment (Roediger & Karpicke, 2006), students who read a passage and then *tested themselves* remembered far more a week later than students who read it again — even though the re-readers felt more confident. Pulling something out of memory is what strengthens it; looking at it again mostly doesn't.

**Spacing beats massing.** The same total study time spread over days beats one long session, and the best gap grows with how long you need to remember: reviewing just as you're about to forget gives the most memory per minute spent. Cramming produces a good score tomorrow and very little next month.

**Guessing before learning helps — even when the guess is wrong.** Being asked a question *before* you read the answer improves memory for that material (Richland, Kornell & Kao, 2009; reviewed by Pan & Carpenter, 2023). A wrong guess opens a gap your brain wants closed, and reading then closes it.

:::goat The uncomfortable pattern
Every technique that works feels worse while you do it. Testing yourself exposes what you don't know; spacing means you've half-forgotten by the time you review; guessing means being wrong on purpose. Re-reading feels smooth and productive — and is the weakest of them all.

Researchers call these *desirable difficulties* (Robert Bjork's term). If studying feels easy, it is probably not doing much. If it feels like effort, with the occasional "I should have known that", it is working.
:::

## How every page is built

Each topic in the atlas follows the same shape, so the evidence above is built in rather than left to willpower:

```viz
{
  "type": "steps",
  "caption": "The same four steps on every page. Each one targets a finding above.",
  "steps": [
    { "label": "Guess first", "sub": "two or three questions before you read — type a guess", "accent": "#d946ef" },
    { "label": "Read", "sub": "the explanation, derivations and exercises", "accent": "#38bdf8" },
    { "label": "Check yourself", "sub": "recall cards — answer before you reveal", "accent": "#4ade80" },
    { "label": "Carry forward", "sub": "the handful of ideas to keep", "accent": "#fbbf24" }
  ]
}
```

**Guess first.** Every page opens with a box of two or three questions — usually a number to estimate or an outcome to predict. Type an answer, however rough, before reading on. On the iPad edition your guesses are saved, and the *Check yourself* section shows them again at the end so you can see how far you moved.

**Check yourself.** Near the end, five to eight cards. Read the question, answer it in your head or out loud — *properly*, not "I'd know it if I saw it" — and only then reveal the answer. Grade yourself honestly. A card you got half-right is a card you got wrong.

**What to carry forward.** The few ideas worth keeping from the page. It's a summary for finding your place later, not a substitute for the cards.

## The Review page

Reading a page and checking yourself once is the start, not the end. Without review, most of it is gone in a month. The iPad edition's **Review** page fixes that by scheduling every card you've learned.

```diagram
   You read a topic       its cards join your deck (up to 10 new a day)
           │
           ▼
   Review shows a card    you answer, reveal, then grade:
                          Again · Hard · Good · Easy
           │
           ▼
   The scheduler          estimates how well you know it, and brings
                          it back just before you'd forget it
           │
           ▼
   1 day → 4 days → 2 weeks → 2 months → …   (it stretches each time
                                             you remember it)
```

The scheduler is **FSRS**, an open-source algorithm whose memory model was fitted to hundreds of millions of real flashcard reviews (Ye, Su & Cao, KDD 2022). For each card it tracks how stable your memory is and how hard the card is for you, predicts the chance you'd recall it today, and schedules the next review for when that chance falls to your target — 90% by default. Cards you know well quickly drift months apart; cards you keep missing stay close.

How to use it well:

- **Grade honestly.** *Again* when you couldn't produce the answer. *Hard* when you got there with effort or partly. *Good* when it came normally. *Easy* only when it was instant. Inflating grades just schedules the card too far out, and you forget it.
- **Do your due cards before reading anything new.** Ten to fifteen minutes. Review first, then learn.
- **Keep the deck small and daily.** Ten new cards a day is plenty. A short session every day beats a long one every weekend, which is the spacing effect at work.
- **Expect some cards to come back wrong.** At a 90% target, about one in ten reviews should be a miss. If you never miss, raise the target or add new cards; if you miss a lot, lower the number of new cards per day.
- **The mix is deliberate.** Review interleaves cards from different topics and never shows two from the same page in a row. Switching between caching, consensus and tokenization feels slower — that's interleaving doing its job.

On the website, cards reveal their answers but aren't scheduled; the Review page lives in the offline [iPad edition](/ipad), which syncs your deck when you're signed in.

## A daily routine

```diagram
   Every day (30-60 min)
     1. Review          due cards first                     10-15 min
     2. Learn           one or two topics: guess, read,     20-40 min
                        do the exercise, check yourself
     3. Apply           design one small piece from         10 min
                        scratch, or trace one request

   Every week
     · One case study or build — designed on paper for 20 minutes
       BEFORE reading it
     · One cold, timed design from the question bank, out loud

   Every month
     · Re-design a system you did weeks ago; compare the two attempts
```

## The four habits behind it

The page structure handles the mechanics. These habits are what make it pay.

### 1 · Estimate before you look

The *Guess first* box is the formal version of a habit worth having everywhere: before reading any number, write your guess. *How much does a cache miss cost relative to a hit? How many queries per second can one Postgres instance take? How much GPU memory does a 4,000-token conversation use?*

After a few dozen of these you stop needing the reference — you know a memory access is ~100 ns and a cross-continent round trip ~100 ms and can derive most of what lies between. [Back-of-envelope estimation](../01-foundations/back-of-envelope.html) and [the hardware numbers](../01-foundations/hardware-numbers.html) are the explicit pages; the habit matters more than either.

### 2 · Generate before you consume

For every case study and build: **spend twenty timeboxed minutes designing it yourself first.** Paper, whiteboard, a text file. Then read. This is the *generation effect* — producing an answer, even a poor one, beats reading a good one.

```viz
{
  "type": "compare",
  "caption": "Same page, same time spent. The order changes what you keep.",
  "left": {
    "title": "Reading first",
    "items": [
      "Read the design → \"makes sense\"",
      "Feel prepared",
      "No question was ever formed",
      "Retain very little"
    ]
  },
  "right": {
    "title": "Designing first",
    "items": [
      "Sketch your own for 20 minutes",
      "Discover you don't know how to shard this",
      "Read → \"oh, THAT's why they partitioned by conversation\"",
      "Retain most of it — you had a question when you read"
    ]
  }
}
```

**Keep the sketches.** Re-designing the same system three months later and comparing with your first attempt is the clearest measure of progress available.

### 3 · Trace one request all the way down

Take one operation — "user posts a comment" — and follow it through every layer without skipping: DNS, TLS, the load balancer's choice, the connection pool, auth, the business logic, the database write (which index, when the WAL is fsynced, when the replica sees it), cache invalidation (before or after commit?), the response, the render.

Every step where you'd say "and then it… gets saved" is a gap. The real questions surface on their own: if the client retries after a timeout, is the comment posted twice? If the replica is 200 ms behind, does the user see their own comment? That last one is [read-your-writes consistency](../01-foundations/consistency-models.html), and finding it by tracing is worth more than reading its definition.

### 4 · Be specifically wrong

Vague understanding hides behind vague statements. "We'd add caching to improve performance" can't be wrong, so it teaches nothing. Force yourself into claims that could be checked:

| Vague | Falsifiable |
|---|---|
| "Add a cache" | "A 90% hit rate on a 200 ms query gets p50 to ~20 ms and cuts database load 10×" |
| "It won't scale" | "At 5,000 writes/s one Postgres primary saturates on WAL fsync" |
| "Use a queue" | "A queue decouples the 200/s producer from the 50/s consumer, at the cost of ~30 s of lag at peak" |
| "Shard the database" | "Shard by user_id — and the global 'top posts' query becomes a scatter-gather" |

Some of the right-hand claims will turn out wrong. That's the mechanism: a claim precise enough to be wrong is one you can learn from.

## What order to read in

The prerequisite graph handles ordering — follow the readiness banners. Two things it doesn't tell you:

**Don't read a whole track before applying any of it.** After each Building Blocks page, look at a case study that uses it. The interleaving matters more than the sequence.

**Revisit foundations after applying them.** [CAP](../01-foundations/cap-pacelc.html) read cold is a definition. Re-read after designing a multi-region system, it describes a problem you now recognise. The cards help here: when one keeps coming back wrong, re-read its page.

:::trap Marking pages complete is not progress
The progress ring records what you've read, which is only loosely related to what you can do. Better signals: the share of Review cards you recall at their due date, and how far you get designing a system cold.

The real test: pick a system from the [question bank](../10-appendix/question-bank.html), design it in 45 minutes with no reference material, and note where you stall. The stalls are the truth. Do it monthly.
:::

## A realistic pace

Depth beats coverage, consistently and by a lot.

- **One or two topics per session**, with the guesses made, the exercise done and the cards checked, beats six pages skimmed.
- **One case study a week**, designed first and then read, beats four read passively.
- **Twenty minutes tracing a real system** beats an hour reading about a hypothetical one.

Getting through Core Systems properly takes most people a couple of months at a few hours a week. Going faster is possible and produces familiarity rather than skill — fine if familiarity is what you need, as long as you know that's the trade.

:::exercise Start now
Before reading any further:

1. Write down an estimate for each — no looking:
   - Requests per second one modern server handles for a simple JSON API
   - Latency of a same-datacenter network round trip
   - Rows in a Postgres table before you need to think about sharding
   - Fraction of a 10,000-machine fleet that fails on an average day
2. Pick a system you've worked on. Trace one request through it, writing each step. Mark every step where you're guessing.
3. Count the guesses. That number is your starting point.
4. Open the next page and make the *Guess first* guesses before reading a word of it.
:::

:::paper On learning, not systems
*Improving Students' Learning With Effective Learning Techniques* (Dunlosky, Rawson, Marsh, Nathan & Willingham, Psychological Science in the Public Interest, 2013) is the review behind the ratings table. *Test-Enhanced Learning* (Roediger & Karpicke, Psychological Science, 2006) is the retrieval-practice experiment.

*The Pretesting Effect* (Richland, Kornell & Kao, 2009) and Pan & Carpenter's review *Prequestioning and Pretesting Effects* (Educational Psychology Review, 2023) cover guessing first. *A Stochastic Shortest Path Algorithm for Optimizing Spaced Repetition Scheduling* (Ye, Su & Cao, KDD 2022) is the model behind FSRS. *Make It Stick* (Brown, Roediger & McDaniel, 2014) is the readable book-length summary of all of it.
:::

## Check yourself

```recall
Q: Why does reading a clear explanation mislead you?
A: The fluency you feel comes from the explanation, not your knowledge — the feeling of understanding peaks when the least learning happens.

Q: Which study techniques does the evidence rate highest and lowest?
A: Practice testing and distributed (spaced) practice rate highest; interleaving and self-explanation moderate; re-reading, highlighting and summarising lowest (Dunlosky et al., 2013).

Q: What did Roediger and Karpicke (2006) find?
A: Students who tested themselves after reading remembered far more a week later than those who re-read — even though the re-readers felt more confident.

Q: Why guess before reading?
A: Prequestions improve memory for the material they target, even when the guess is wrong — the error opens a gap that reading closes.

Q: What are desirable difficulties?
A: Bjork's term for techniques that feel harder but work better — testing, spacing, guessing, interleaving. Easy-feeling study usually isn't doing much.

Q: How does the Review page schedule cards?
A: FSRS estimates each card's memory stability and difficulty, predicts your chance of recall, and brings it back when that falls to your target (90% by default), stretching intervals as you remember.

Q: How should you grade review cards?
A: Again if you couldn't produce the answer, Hard if partly or with effort, Good if it came normally, Easy only if instant. Inflated grades schedule cards too far out.

Q: What does a good daily routine look like?
A: Due Review cards first (10–15 min), then one or two topics with guesses, exercise and cards, then ten minutes applying — designing a small piece or tracing a request.
```

## What to carry forward

- **Fluency while reading comes from the writing, not your knowledge.** Distrust it.
- **Practice testing and spacing are the two techniques the evidence rates highest** — re-reading and highlighting the lowest.
- **Guess first, check yourself, review on a schedule** — every page is built for it.
- **Grade honestly and review daily**, due cards before new reading.
- **Design before you read, trace one request, make falsifiable claims.**
