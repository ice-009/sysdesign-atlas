---
title: CRDTs — Conflict-Free Replicated Data Types
summary: Data structures that merge automatically regardless of order, the maths that makes it work, the practical types, and their real costs.
difficulty: Hard
scope: HLD
tags: [crdt, convergence, collaboration, offline]
prereqs: [consistency-models, clocks]
---

## The problem they solve

Two replicas accept writes concurrently. When they sync, which wins?

The usual answers are all bad. **Last-write-wins** silently discards data and depends on clocks you can't trust. **Surface both versions** pushes the problem onto the user. **Manual merge** requires application logic for every data type and every conflict shape.

CRDTs offer a fourth answer: design the data structure so that **concurrent updates cannot conflict** — merging is always defined, always automatic, and always produces the same result regardless of the order updates arrive in.

That last clause is the magic. Replicas that receive the same set of updates in *any* order end in the *same* state, with no coordination at all.

## The maths

Convergence follows from three algebraic properties of the merge function:

```diagram
   Commutative:   merge(a, b) = merge(b, a)
                  → order of arrival doesn't matter

   Associative:   merge(merge(a,b), c) = merge(a, merge(b,c))
                  → grouping doesn't matter

   Idempotent:    merge(a, a) = a
                  → duplicate delivery doesn't matter
```

Together these make the state a **join-semilattice**, and merge the least-upper-bound operation. State only ever moves "upward" in the lattice, so replicas monotonically converge.

The practical payoff: because merge is idempotent and commutative, you can use an **unreliable, unordered, at-least-once** transport. Duplicates are harmless, reordering is harmless, retries are harmless. This is exactly what [idempotency](idempotency.html) buys you, generalized to a whole data structure.

## Two flavours

**State-based (CvRDT)** — replicas exchange their entire state and merge it. Simple and extremely robust to network problems (any subset of messages, in any order, converges). Costly if the state is large; mitigated by *delta-CRDTs* that ship only what changed.

**Operation-based (CmRDT)** — replicas broadcast operations. Much less bandwidth, but requires exactly-once, causally-ordered delivery, which is a real infrastructure burden.

Most production systems use state-based or delta-based, because the transport requirements are so much weaker.

## The practical types

### G-Counter (grow-only)

Each replica has its own slot and only ever increments its own.

```diagram
   Replica A: {A:5, B:3, C:0}
   Replica B: {A:2, B:7, C:1}

   merge = element-wise MAX = {A:5, B:7, C:1}
   value = sum = 13
```

Element-wise max is commutative, associative, and idempotent. Increments are never lost — which is precisely what a naive `counter++` on two replicas fails to guarantee.

### PN-Counter (increment and decrement)

Two G-Counters: one for increments, one for decrements. Value = sum(P) − sum(N). You can't just decrement a G-Counter, because max() would discard it.

Use for: like counts, view counts, inventory *estimates*, vote tallies.

### G-Set / 2P-Set

A grow-only set merges by union — trivially convergent. Adding removal is where it gets interesting: a **2P-Set** keeps a separate "tombstone" set of removed elements, but then an element can never be re-added.

### LWW-Element-Set

Each element carries a timestamp for its add and remove. The later one wins. Simple, and inherits every problem of clock skew — so pair it with [logical clocks](clocks.html), not wall clocks.

### OR-Set (observed-remove)

The one that actually behaves intuitively, and worth knowing by name.

Each *add* attaches a unique tag. A *remove* deletes only the tags it has actually observed.

```diagram
   A: add("x") → {x:[t1]}          B: add("x") → {x:[t2]}
   sync → {x:[t1,t2]}

   A removes x (sees t1, t2) → removes both → {}
   Meanwhile B adds x again  → {x:[t3]}
   merge → {x:[t3]}    ← the concurrent re-add SURVIVES ✓
```

The rule "add wins over a concurrent remove" matches what users expect: if you re-added something while someone else was deleting it, your intent shouldn't be silently erased.

### Registers

**LWW-Register** — a single value with a timestamp. **MV-Register** (multi-value) — keeps all concurrent values as siblings and lets the application decide, which is honest rather than lossy.

### Sequence CRDTs (RGA, Logoot, YATA)

The hard case: collaborative text editing, where concurrent inserts at the same position must produce a sensible order without a coordinator.

The trick is to give each character a **globally unique, densely orderable identifier** — typically a fractional position plus a replica ID — so a new character can always be placed *between* two existing ones without renumbering anything.

This is what powers modern collaborative editors built on Yjs and Automerge.

:::goat CRDT vs OT for collaborative editing
Worth knowing for the [Google Docs question](../05-case-studies/collaborative-editor.html). **Operational Transformation** transforms concurrent operations against each other to preserve intent; it needs a central server to define a canonical order, and correct transformation functions are famously difficult to get right.

**CRDTs** need no central authority and are correct by construction, at the cost of per-character metadata (which grows the document) and tombstones that must be garbage collected.

"OT is server-centric and battle-tested at scale in existing products; CRDTs are peer-to-peer capable and simpler to prove correct, but pay a metadata cost. For a server-mediated product I'd lean OT or a server-ordered log; for offline-first or peer-to-peer, CRDTs." That's a nuanced answer that shows you know both.
:::

## The real costs

State them — this is where interviews go deep, and enthusiasm without cost-awareness reads as naive.

**1. Metadata growth.** Tombstones and per-element tags accumulate. A document edited for years carries the ghosts of every deleted character. Garbage collection requires knowing every replica has seen a change — which needs coordination, the very thing CRDTs were avoiding.

**2. They converge, but not necessarily to what you wanted.** Convergence is a *technical* guarantee, not a semantic one. Two users concurrently editing the same sentence produce a merged result that is consistent everywhere and possibly nonsense. CRDTs guarantee agreement, not intent preservation.

**3. Invariants across items are impossible.** This is the big one. A CRDT counter cannot enforce "balance ≥ 0" or "no more than 100 tickets sold," because each replica accepts writes without seeing the others. Any global invariant requires coordination — that's not a CRDT limitation, it's a theorem.

**4. Not everything has a CRDT.** Counters, sets, maps, registers, and sequences do. Arbitrary business logic with cross-entity constraints doesn't.

## Where they're used

- **Collaborative editing** — Figma, Linear, and editors built on Yjs/Automerge.
- **Offline-first mobile apps** — local writes that merge on reconnect without user-visible conflicts.
- **Distributed caches and databases** — Redis CRDTs (active-active), Riak data types, Azure Cosmos DB conflict resolution.
- **Shopping carts** — the classic Dynamo example: merging carts by union means a network partition can resurrect a removed item, but never loses an added one. That asymmetry is a deliberate business decision (a spurious extra item is a minor annoyance; a lost purchase is lost revenue), which is a great illustration that consistency choices are product choices.
- **Multiplayer presence and cursors** — small, high-churn, conflict-prone state.

## When to propose one

The test is a single question: **is the data type mergeable, and are there no cross-item invariants?**

| Requirement | CRDT? |
|---|---|
| Like/view counters across regions | ✓ PN-Counter |
| Collaborative document | ✓ Sequence CRDT |
| Offline-capable notes/tasks | ✓ OR-Set / map |
| Presence, cursors, ephemeral state | ✓ LWW-Register |
| Shopping cart | ✓ OR-Set |
| **Account balance with no overdraft** | ✗ needs coordination |
| **Limited inventory / seat booking** | ✗ needs [consensus](consensus.html) |
| **Unique username assignment** | ✗ needs linearizability |

The pattern in the ✗ rows: **a global invariant that no single replica can verify alone.** When you see one, CRDTs are the wrong tool and you need [consensus](consensus.html) or a single-writer design instead. Recognizing that boundary quickly matters more than knowing every CRDT variant.

:::exercise Design a convergent type
1. A counter that can be incremented and decremented by many replicas. Design it as a CRDT. Why does a single integer not work?
2. A set with add and remove. Design one. Explain why "remove wins" and "add wins" are both valid and give different semantics.
3. A shopping cart merged after a partition: the user added item A on one device and removed it on another. What should happen? Is there a right answer?
4. CRDTs converge without coordination. What do they *not* give you? Name an invariant that no CRDT can maintain.
5. Estimate the metadata overhead of a text CRDT for a 100,000-character document with 10 collaborators. When does that become the problem?
:::

:::paper Convergent data types
Shapiro, Preguiça, Baquero & Zawirski, *A Comprehensive Study of Convergent and Commutative Replicated Data Types* (INRIA, 2011) is the foundational catalogue — state-based versus operation-based, and the lattice theory underneath.

*Delta State Replicated Data Types* (Almeida et al., 2018) fixes the bandwidth problem with state-based CRDTs. For text specifically, the Yjs and Automerge documentation explain the practical trade against operational transformation.
:::
