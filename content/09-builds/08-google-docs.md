---
title: Build Google Docs
summary: Concurrent editing without conflicts. The one build where the hard problem is an algorithm rather than an architecture.
difficulty: Hard
scope: HLD
level: 4
prereqs: [collaborative-editor, crdts, realtime, clocks, leader-election]
tags: [level-4, collaboration, crdt, realtime]
unlocks: Conflict-free concurrent mutation and the OT vs CRDT decision.
---

## The product

Several people type in the same document simultaneously. Everyone converges on identical text. Cursors are visible. History is preserved. Offline edits merge on reconnect.

Full treatment in the [Collaborative Editor case study](../case-studies/collaborative-editor.html); this build shows the construction order.

## Phase 1 — Understand why it's hard

Positions are meaningless once concurrency exists. Walk this in an interview — it makes the problem concrete in fifteen seconds:

```diagram
   Document: "HELLO"

   Alice: insert "X" at position 1   → "HXELLO"
   Bob:   insert "Y" at position 3   → "HELYLO"   (concurrently)

   Applying Bob's op at Alice:  "HXELLO" + Y@3 → "HXYELLO"  ✗
   Applying Alice's op at Bob:  "HELYLO" + X@1 → "HXELYLO"  ✓

   DIVERGENCE. Same operations, different final documents.
```

A position index only means something relative to a specific document state. Locking solves it and defeats the purpose. Last-write-wins discards someone's work.

## Phase 2 — Pick a convergence strategy

**Convergence** is the requirement that every editor ends up with an identical document, whatever order the edits arrived in. Two families achieve it.

**Operational Transformation (OT)** — adjust each incoming edit to account for the edits it didn't know about, so it lands where its author meant.

```diagram
   Bob's insert@3 arrives at Alice, who already applied insert@1
   → Alice's insert was BEFORE position 3 → shift Bob's by +1
   → insert@4 → "HXELYLO"  ✓ matches Bob
```

Efficient (small ops, no per-character metadata), battle-tested, and genuinely hard to implement correctly — the transformation matrix grows with every operation type, and published algorithms have had correctness bugs found years later. Generally needs a **central server** to impose a canonical order.

**CRDTs** — give every character a globally unique, densely-orderable ID so operations commute by construction.

```diagram
   Not "insert X at position 1" but
   "insert X with id (4.5, siteA) between id 4 and id 5"

   Fractional positions mean you can ALWAYS create an ID
   between two existing ones. Sort by ID → identical document,
   regardless of arrival order.
```

Correct by construction, works peer-to-peer and offline. Costs per-character metadata and tombstones that accumulate forever (deleted characters can't be fully removed without coordination).

:::goat The decision criterion
"Both converge; they differ in where the complexity lives. OT keeps operations small and pushes complexity into transformation functions needing a central ordering point. CRDTs push it into the data structure with per-character metadata, but are correct by construction and work offline.

Since I already have a server here, I'd use a server-assigned total order — either OT or a simple sequenced log. If offline-first or peer-to-peer were core requirements, I'd take the CRDT and accept the metadata cost, because retrofitting offline support onto OT is much harder than accepting CRDT overhead up front."

Naming the *criterion* rather than declaring a winner is what scores.
:::

## Phase 3 — One owner per document

```diagram
   clients ──WebSocket──► document session server
                          (in-memory doc state + op log)
                                    │ periodic
                          ┌─────────▼─────────┐
                          │ op log (append)   │
                          │ snapshots         │
                          └───────────────────┘
```

**Route every edit for a document to a single process**, by `hash(doc_id)`. That gives a natural serialization point — ordering becomes trivial and no distributed coordination is needed. Same [partitioned ownership](../distributed/leader-election.html) pattern that beats global leader election.

**Apply locally first.** The client applies its own keystroke immediately and reconciles when the authoritative order returns. Never wait for a round trip to render the user's own typing.

## Phase 4 — Persistence

```diagram
   OP LOG      every operation, in server order, append-only
               → history, undo, replay, audit

   SNAPSHOTS   full state every N ops
               → opening loads snapshot + ops since,
                 not a replay from creation
```

This is [event sourcing](../building-blocks/pub-sub.html) applied to a document: the list of changes is the truth, and the document is what you get by replaying them. Snapshots exist for the reason event sourcing always needs them — without one, opening a three-year-old document would mean replaying every keystroke ever typed into it.

**Ops must be persisted before acknowledgment** — that's what makes recovery possible when a session server dies and another takes ownership.

## Phase 5 — Presence, and split brain

**Cursors are ephemeral.** Broadcast over the same socket, never persist, drop freely under load, debounce to ~20/s. Data whose correct durability is *zero* — a good example of classifying data by requirement.

**Split brain is the real risk.** If two servers both believe they own a document, you get divergent histories that can't be merged. Prevent with [fencing tokens](../building-blocks/distributed-locks.html) on the persistence layer: each ownership grant carries an increasing epoch, and storage rejects writes from a stale one.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| Single owner per document | Any server handles any edit | Serialization point makes ordering trivial |
| Server-assigned total order | Full peer-to-peer CRDT | A server exists anyway; far simpler |
| Local-first application | Wait for server ack | Typing must feel instant |
| Op log + snapshots | State-only persistence | History, undo, and recovery all need the log |
| Persist before ack | Ack then persist | Otherwise a crash loses acknowledged edits |
| Cursors never persisted | Store presence | Worthless when stale; pure ephemeral broadcast |
| Fencing tokens on writes | Trust ownership | Split brain produces unmergeable divergence |

## What you'd cut for v1

Rich text, offline editing, version history UI, comments, suggestions. Ship plain-text collaborative editing with cursors. **Rich text is where most of the real difficulty lives** — formatting applies to *ranges*, and ranges shift under concurrent edits, which is substantially harder than character insertion for both OT and CRDTs. Being honest about that beats glossing over it.

## Explaining the design

> "The core problem is that position indexes are meaningless under concurrency — two concurrent inserts applied in different orders produce different documents. I'd show that with a five-character example first.
>
> Both OT and CRDTs solve it. Since there's a server here anyway, I'd use it as a serialization point: route all edits for a document to one owner by hash, assign a total order, and have clients apply locally first so typing feels instant. If offline-first were a requirement I'd switch to a CRDT and accept the per-character metadata.
>
> Persistence is an append-only op log with periodic snapshots, ops durable before acknowledgment. Cursors are pure ephemeral broadcast, never persisted.
>
> The failure mode I'd guard hardest is split brain — two owners means divergent histories that can't be merged — so ownership carries a fencing token the storage layer enforces."

## Next

[Build Stripe](stripe.html) — the build where correctness beats every other property.
