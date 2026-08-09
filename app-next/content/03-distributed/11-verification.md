---
title: How You Know It's Correct
summary: Model checking, Jepsen, and deterministic simulation — the three techniques that find distributed bugs tests cannot, and why "we tested it" is not an answer.
difficulty: Hard
tags: [distributed, correctness, testing, verification]
prereqs: [consensus, failure-modes]
unlocks: A defensible answer to "how do you know your replication protocol is right?"
---

## Why ordinary testing fails here

A distributed bug needs three things to line up: a specific interleaving of concurrent operations, a specific failure at a specific moment, and a specific piece of state. Your test suite explores maybe a dozen interleavings out of an astronomically large space, always on a healthy network, and always at the same speed.

:::derive The size of the space you aren't testing
```
   A 5-node cluster processing 100 operations, where each operation
   can interleave with any other and a node can crash between any two:

     interleavings ≈ 100! / (20!)^5     — astronomically large
     × crash points                      — multiply by ~500
     × message reorderings               — multiply again

   Your CI run explores: ~1 path, on a perfect network, at one speed.
```
:::

The bugs that survive to production are precisely the ones that need an unusual schedule. Kyle Kingsbury's Jepsen work found correctness violations in the *default configuration* of nearly every distributed database he tested — systems written by good engineers with extensive test suites.

So "we have integration tests" is not a claim about correctness. Three techniques are, in increasing order of confidence and cost.

## 1. Model checking: verify the design, not the code

Write the *protocol* in a specification language, state what must always be true, and let a tool explore every reachable state.

TLA+ is the dominant tool. You describe the system as a state machine — variables, an initial state, and the transitions allowed — then assert invariants and temporal properties.

```diagram
   A specification has three parts:

     Init      the allowed starting states
     Next      every transition the system may take
               (including crashes, message loss, reordering)
     Invariant what must be true in EVERY reachable state

   The model checker then does exhaustive search:

     enumerate all states reachable from Init via Next
     at each one, evaluate Invariant
     if it fails → print the exact sequence of steps that got there
```

That last line is what makes it worth the effort. A model checker doesn't say "something is wrong"; it hands you a minimal counterexample trace, step by step.

**What it catches:** protocol-level errors — a consensus algorithm that can elect two leaders under a specific partition-and-recovery sequence, a cache invalidation scheme with a window where a stale value can be written back, a state machine with an unreachable-but-required transition.

**What it does not catch:** anything about your actual code. A verified design implemented incorrectly is still broken. Model checking raises your confidence in the *idea*, not the artifact.

:::goat Where this is genuinely used
AWS has published on using TLA+ across S3, DynamoDB, and EBS. Their reported experience is the useful part: the specs found *design* bugs that would have required a very specific sequence of failures, several of which the engineers judged would never have been found by testing, and which would have caused data loss.

Their other finding is the one worth repeating: writing the spec was valuable even when it found nothing, because the act of stating the invariants precisely exposed disagreements about what the system was supposed to guarantee.
:::

:::trap "Formal methods are academic and impractical"
The impractical version is proving a whole implementation correct. Nobody is asking for that.

Model checking a 200-line spec of just the tricky protocol — the part where nodes coordinate — takes a few days to learn and hours to write. It is a normal engineering activity, and the counterexample traces are directly actionable.
:::

## 2. Jepsen: break a real system and check what it promised

Jepsen takes the opposite approach: run the real database on a real cluster, hammer it with concurrent clients, inflict network partitions and clock skew and process kills, record every operation's invocation and completion — then check whether the resulting history is *possible* under the consistency model the vendor claims.

```viz
{
  "type": "steps",
  "caption": "Jepsen's loop. The checker is the clever part.",
  "steps": [
    { "label": "Generate", "sub": "concurrent random ops across clients", "accent": "#38bdf8" },
    { "label": "Nemesis", "sub": "partitions, pauses, clock skew, kills", "accent": "#fb7185" },
    { "label": "Record", "sub": "invoke/complete times for every op", "accent": "#a78bfa" },
    { "label": "Check", "sub": "is this history linearizable? serializable?", "accent": "#4ade80" }
  ]
}
```

The checker (Knossos/Elle) searches for *any* valid sequential ordering consistent with the observed history and the claimed model. If none exists, the system violated its own guarantee, and Jepsen prints the specific operations that cannot be reconciled.

**Failure classes it reliably finds:**

| Anomaly | What it means |
|---|---|
| Lost update | An acknowledged write vanished |
| Stale read | A read returned a value older than a completed write |
| Dirty read | A read saw an uncommitted, later-aborted write |
| Split-brain | Two nodes both believed they were leader and both accepted writes |
| Non-monotonic reads | A client saw a value, then saw an older one |
| Phantom / G2 cycles | Serializability violated despite the claimed isolation level |

**The recurring lesson from Jepsen reports** is not that databases are badly built. It's that (a) documentation routinely overstates guarantees, (b) *default* configurations are frequently weaker than the marketed level, and (c) the interesting bugs appear during **recovery**, not during the partition — when a healed node rejoins and reconciles.

:::goat What to actually take from this
For your own systems, the transferable idea is: **record a history and check it against a model.** You do not need Clojure or Jepsen itself.

Have your integration tests log every operation with invocation and completion timestamps, run them under injected faults, and assert a property afterwards — "the ledger always balances", "no order was fulfilled twice", "every acknowledged write is readable". A property checked over a fault-injected history is worth more than a hundred assertion-per-step tests.
:::

## 3. Deterministic simulation: the one that scales

The most practical technique for a team building its own system, and the least widely known.

Run the entire distributed system — every node — in a single process, on a single thread, with **every source of nondeterminism replaced by a seeded pseudorandom generator**: time, network delivery order, thread scheduling, disk latency, random numbers, failure injection.

```diagram
   REAL SYSTEM                    SIMULATED SYSTEM

   wall clock                 →   virtual clock, advanced by the sim
   OS scheduler               →   deterministic task ordering from seed
   real network               →   in-memory queues, seed-chosen delays,
                                  reordering, duplication, partitions
   real disk                  →   in-memory model with injected latency,
                                  torn writes, and fsync failures
   random()                   →   seeded PRNG

   Consequences:

     · a whole cluster-hour runs in seconds — no real waiting
     · a failing run is reproducible EXACTLY from its seed
     · you can search millions of schedules, not a dozen
```

The two properties that matter:

**Speed.** Because there is no real waiting, simulated time advances as fast as the CPU can compute. A day of cluster operation with hundreds of failures can run in under a minute. You run millions of randomised scenarios overnight.

**Reproducibility.** A failure is a seed. Hand the seed to a colleague and they get a byte-identical failure. You can attach a debugger and step through the exact interleaving that broke it. Compare this to the usual distributed-systems debugging experience: a heisenbug that appeared once in staging three weeks ago.

FoundationDB is the canonical example — they built the simulator *before* the database, and credit it as the reason FoundationDB survived Jepsen without a single violation found. TigerBeetle, Antithesis, and several newer systems use the same approach.

:::trap Determinism is invasive and must be designed in
You cannot bolt this onto an existing codebase easily. Every call to `now()`, `rand()`, `spawn`, or a socket has to route through an abstraction the simulator can substitute. A single stray `System.currentTimeMillis()` or background thread reintroduces nondeterminism and silently destroys reproducibility.

That's the real cost — not the simulator, but the discipline of never touching the outside world directly. Teams that adopt it early get enormous value; teams that try to retrofit it usually give up.
:::

## Choosing among them

| Technique | Verifies | Cost | Finds |
|---|---|---|---|
| Model checking (TLA+) | The design | Days to learn, hours to write | Protocol logic errors |
| Property tests + fault injection | Your code, shallowly | Low | Common ordering and retry bugs |
| Jepsen-style history checking | A running system | Moderate | Consistency-model violations |
| Deterministic simulation | Your whole implementation | High upfront, low ongoing | Nearly everything, reproducibly |
| Chaos engineering in production | The real system + operations | Ongoing | Operational and dependency failures |

They are complementary, and the ordering is roughly a maturity ladder. A useful default for a team building something with real correctness requirements:

1. **Write the invariants down first**, in plain language. Half the value arrives here, before any tooling.
2. **Model-check the protocol** if there is a novel coordination scheme. If you are using off-the-shelf Raft, someone already did this.
3. **Property-test with fault injection** — this is cheap and catches the common retry, ordering, and idempotency bugs. See [idempotency](idempotency.html).
4. **Check histories against a model** in integration tests.
5. **Deterministic simulation** if you are building storage or consensus yourself, and you intend to maintain it for years.

:::goat The honest answer to "how do you know it's correct?"
"I don't prove the implementation correct. I do three things: I state the invariants explicitly, I model-check the coordination protocol so I know the *design* can't violate them, and I run the implementation under injected faults while checking the resulting operation history against those same invariants. What I get is not proof — it's that the failure modes I can imagine are covered, and the ones I can't are more likely to be found by randomised search than by tests I wrote by hand."

That answer is honest about its limits, which is what makes it credible.
:::

## Exercise

:::exercise Find the invariants
Take a system you know — or the [payment system](../08-case-studies/payment-system.html) case study — and write down:

1. Three invariants that must hold in **every** reachable state, phrased so they could be checked mechanically. ("No money is created or destroyed" is a good one; "the system is consistent" is not.)
2. For each, the specific failure sequence most likely to violate it. Be concrete about *when* the crash happens.
3. Which of the five techniques above would be most likely to find that sequence, and why the cheaper ones wouldn't.
4. One invariant you could start asserting in your existing integration tests **this week**, at essentially no cost.
:::

:::paper Sources
Kyle Kingsbury's Jepsen reports (jepsen.io) are the best distributed-systems reading available anywhere, and they're free — start with the Elle paper for the checker's theory.

Chris Newcombe et al., *How Amazon Web Services Uses Formal Methods* (CACM, 2015) is the industrial case for TLA+. Leslie Lamport's *Specifying Systems* is the reference text.

For simulation: FoundationDB's "Testing Distributed Systems w/ Deterministic Simulation" talk (Will Wilson, Strange Loop 2014), and the FoundationDB paper (SIGMOD 2021).
:::

## What to carry forward

- Distributed bugs need **specific schedules**; ordinary tests explore almost none of the space.
- **Model checking verifies the design.** Cheap, actionable counterexamples, no guarantee about your code.
- **History checking verifies a running system** against a claimed consistency model. Most violations show up during *recovery*, not during the partition.
- **Deterministic simulation** turns "unreproducible heisenbug" into "here's the seed" — the highest-value technique, and the one you must design in from the start.
- Whatever you use: **state the invariants explicitly first.** That step alone finds disagreements about what the system is supposed to guarantee.
