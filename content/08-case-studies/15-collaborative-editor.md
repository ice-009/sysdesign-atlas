---
title: Design a Collaborative Editor (Google Docs)
summary: Concurrent editing without conflicts — operational transformation versus CRDTs, cursor presence, and how documents are actually persisted.
difficulty: Hard
scope: HLD
tags: [case-study, crdt, ot, realtime, collaboration]
prereqs: [crdts, realtime, clocks]
---

:::predict Guess first
1. Document "HELLO". Alice inserts X at position 1 while Bob inserts Y at position 3. If each client applies the other's edit at the raw position, do they end up with the same text?
2. Should a user's own keystroke wait for the server before appearing on screen?
3. Should collaborators' cursor positions be saved to the database?
:::

:::interview Why this question
It's the one case study where the hard problem is an **algorithm**, not an architecture. Two people typing in the same paragraph at the same instant must converge to the same document, and the naive answers (locking, last-write-wins) are all obviously wrong. It's also a great test of whether you can explain a subtle mechanism clearly.
:::

## 1. Requirements

**Functional**
- Multiple users edit the same document simultaneously.
- Changes appear to others within a few hundred milliseconds.
- See collaborators' cursors and selections.
- Full version history; ability to restore.
- Offline editing that merges on reconnect.

**Non-functional**
- **Convergence** — all clients end with an identical document, always.
- **Intent preservation** — the merged result should reflect what each user meant.
- Low latency for local edits (typing must feel instant — zero perceptible delay).
- Documents up to ~100 pages with up to ~50 concurrent editors.

**Clarifying questions:** Plain text or rich text with formatting? (Rich text is substantially harder.) Do we need true offline support (pushes toward CRDTs)? Peer-to-peer or server-mediated? Max concurrent editors?

## 2. Estimation

**100M documents**, 10M DAU, 5% of sessions collaborative.

```diagram
   Concurrent editing sessions: ~500,000
   Operations: an active typist produces ~5 ops/s
     500K sessions × 2 avg active editors × 5 = 5M ops/s peak
   → but each op is tiny (~50 B) and fanout is small
     (only to others in the same document)

   Per-document broadcast: 5 ops/s × 3 collaborators
     = 15 messages/s — trivial per document

   Storage:
     document snapshots: 100M × 100 KB = 10 TB
     operation log: retained for history, compacted periodically
```

**What this decided:** this is not a throughput problem — it's a **correctness and latency** problem, sharded naturally by document. Each document is an independent, small-scale system, which is a very pleasant property worth pointing out.

## 3. Why the naive approaches fail

**Locking.** One editor at a time. Correct, and it defeats the entire purpose.

**Last-write-wins on the whole document.** Two people editing different paragraphs, one person's work vanishes. Obviously unacceptable.

**Send character positions.** This is the subtle failure and worth walking through, because it motivates everything else:

```diagram
   Document: "HELLO"

   Alice: insert "X" at position 1  → "HXELLO"
   Bob:   insert "Y" at position 3  → "HELYLO"   (concurrently)

   Naive application at Alice's client:
     "HXELLO" + insert Y at 3 → "HXYELLO"   ✗
   Naive application at Bob's client:
     "HELYLO" + insert X at 1 → "HXELYLO"   ✓

   DIVERGENCE. Same operations, different results.
```

Positions are only meaningful relative to a specific document state. Once concurrent edits exist, a raw position index is ambiguous. **This example is worth drawing in the interview** — it makes the problem concrete in fifteen seconds.

## 4. Operational Transformation

Usually shortened to **OT**, and it's the approach behind most established products.

**The idea:** an edit like "insert X at position 3" was written against the document as its author saw it. By the time it reaches you, you may have applied edits they hadn't seen, so position 3 no longer means the same place. OT adjusts — *transforms* — the incoming edit to account for the changes it didn't know about, so it lands where its author meant.

```diagram
   Alice's op:  insert("X", pos 1)
   Bob's op:    insert("Y", pos 3)

   At Alice's client, Bob's op arrives. Transform it against
   Alice's already-applied op:

     Alice inserted at position 1, which is BEFORE position 3
     → shift Bob's position by +1
     → insert("Y", pos 4)

   Result: "HXELLO" + Y at 4 → "HXELYLO"   ✓ matches Bob
```

The transformation function `T(op_a, op_b)` produces adjusted operations such that applying them in either order yields the same document.

**What makes OT hard:**

- **The transformation functions must satisfy convergence properties**, and getting them right for all operation-pair combinations is famously difficult. Published algorithms have had correctness bugs found years after deployment.
- **Complexity explodes with operation types.** Insert/delete on plain text is manageable. Add formatting, tables, images, and lists, and the pairwise transformation matrix becomes very large.
- **It generally requires a central server** to impose a canonical order on operations. Each client transforms against that order.

**Why products still use it:** it's efficient (operations are small, no per-character metadata), it produces intuitive results for text, and it's battle-tested at scale.

## 5. CRDTs

The alternative: make the edits impossible to conflict in the first place, so nothing ever needs transforming. "Commute" is the mathematical word — apply them in either order and you get the same document.

The trick for text is to stop using positions at all. Give every character its own permanent identifier, ordered so that you can always mint a new one *between* any two existing ones. An insert then says "put X between these two specific characters", which stays true no matter what else happened.

```diagram
   Instead of "insert X at position 1", say:
     "insert X with id (4.5, siteA) between id 4 and id 5"

   Fractional positions mean you can ALWAYS create an
   identifier between two existing ones, without renumbering.
   Ties broken by site ID.

   Both clients sort by identifier → identical document,
   regardless of arrival order.
```

Deletion marks a character as a **tombstone** rather than removing it, so a concurrent insert next to it still has a valid anchor.

**Advantages:** no central server required (peer-to-peer capable), correct by construction (much easier to prove and test), and offline editing merges naturally — which is a genuine product capability, not just an implementation detail.

**Costs, all real:**
- **Per-character metadata.** Each character carries an identifier, which can be several times the size of the character itself. Modern implementations (Yjs, Automerge) mitigate this heavily by run-length encoding contiguous ranges from the same author.
- **Tombstones accumulate.** A document edited for years carries every deleted character. Garbage collection requires knowing all replicas have seen the deletion — which needs coordination, the very thing CRDTs avoid.
- **Convergence ≠ intent.** Two users editing the same word converge to a consistent result that may be nonsense. CRDTs guarantee agreement, not sensibility.

## 6. Choosing — the answer to give

:::goat The comparison that scores
"Both solve convergence; they differ in where the complexity lives. **OT** keeps operations small and pushes complexity into transformation functions that need a central server to order operations — efficient, proven at scale, and genuinely hard to implement correctly. **CRDTs** push complexity into the data structure with per-character metadata, but are correct by construction and work peer-to-peer and offline.

For a server-mediated product where I control the ordering point, I'd lean toward a server-ordered operation log — either OT or a simpler server-assigned sequence — because the metadata cost is real at document scale. If offline-first editing or peer-to-peer sync were a core requirement, I'd use a CRDT and accept the metadata overhead, because retrofitting offline support onto OT is much harder than accepting CRDT overhead up front."

Naming the *decision criterion* — offline/P2P requirement — rather than declaring one universally better is what makes this a strong answer.
:::

There's also a pragmatic third option worth mentioning: since a server is present anyway, it can simply **assign a total order** to incoming operations and rebroadcast. Clients apply operations in server order, using a small amount of local transformation for optimistic display. This is simpler than full OT and adequate for many products.

Recent research has narrowed the gap between the two. **Eg-walker** (Gentle & Kleppmann, EuroSys 2025) stores only the plain operation history, as OT does, and builds CRDT state temporarily only while merging concurrent branches — so everyday memory use is close to OT's, while offline merges keep CRDT-style correctness. **Fugue** (Weidner & Kleppmann, 2023) fixes a classic CRDT anomaly where two people typing at the same spot get their words interleaved character by character.

## 7. Architecture

```diagram
   ┌────────┐  WebSocket  ┌────────────────────┐
   │client A│◄───────────►│                    │
   └────────┘             │  Document session  │  one owner per
   ┌────────┐             │  server            │  document
   │client B│◄───────────►│  (in-memory doc    │  (routed by
   └────────┘             │   state + op log)  │   doc_id hash)
   ┌────────┐             │                    │
   │client C│◄───────────►│                    │
   └────────┘             └─────────┬──────────┘
                                    │ periodic
                          ┌─────────▼──────────┐
                          │ Persistence        │
                          │  - op log (append) │
                          │  - snapshots       │
                          └────────────────────┘
```

**One server owns each document.** This is the key architectural decision: routing all edits for a document to a single process gives you a natural serialization point, so ordering is trivial and no distributed coordination is needed. Route by `hash(doc_id)` — the same [partitioned ownership](../03-distributed/leader-election.html) pattern that avoids global leader election.

**Local-first application:** the client applies its own edit **immediately** to local state (so typing feels instant), sends it to the server, and reconciles when the authoritative order comes back. Never wait for a server round trip before showing the user their own keystroke.

## 8. Persistence

```diagram
   OPERATION LOG (append-only)
     every op, in server order, with author and timestamp
     → enables history, undo, replay, and audit

   SNAPSHOTS (periodic)
     full document state every N operations
     → opening a document loads the last snapshot plus
       the ops since, instead of replaying from creation
```

This is [event sourcing](../02-building-blocks/pub-sub.html) applied to a document, with snapshots for the reason event sourcing always needs them: replay time grows without bound otherwise.

**Compaction:** old operations can be collapsed into snapshots and archived once no client needs them for history. Keep enough for the version-history feature the product promises.

## 9. Presence and cursors

Separate from the document data, and much simpler:

- **Cursor positions and selections** are ephemeral, high-churn, and worthless when stale. Broadcast over the same WebSocket, **never persist**, and drop freely under load.
- Cursor positions must be expressed relative to the same identifiers as the document model — a raw index breaks as soon as someone types above you.
- Debounce updates (~20/s max) and coalesce; nobody needs every mouse movement.

This is a good example of data whose correct durability is *zero*, and saying so shows you classify data by requirement rather than treating it all the same.

## 10. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| Client disconnects mid-edit | Buffer operations locally; on reconnect, send the buffer with the last-known server sequence and receive missed ops. This is why op logs matter. |
| Document server dies | Another node takes ownership and rebuilds from the last snapshot plus the op log. Brief interruption; **no data loss because ops were persisted before acknowledgment**. |
| Two servers own the same document | Split brain — divergent histories. Prevent with [fencing tokens](../02-building-blocks/distributed-locks.html) on the persistence layer, so the stale owner's writes are rejected. |
| Very large document | Split into sections with independent op streams; load lazily. Editing page 90 shouldn't require the whole document in memory. |
| Slow client | Bound its outbound queue; if it falls too far behind, force a full resync from a snapshot rather than buffering unbounded ops. |

**Follow-ups:**
- *"Rich text formatting?"* — formatting is an operation over a *range*, and ranges shift under concurrent edits. Substantially harder than plain text for both OT and CRDTs. Being honest that this is where most of the real complexity lives is better than glossing over it.
- *"Undo in a collaborative context?"* — undo must remove *your* operation, not the last global one. Requires selective undo, which means generating an inverse operation and transforming it against everything since. Genuinely subtle.
- *"Access control?"* — enforce at the session server on connect and on each operation; a permission revoked mid-session must terminate the connection.
- *"Why not just lock paragraphs?"* — some products do exactly this, and it's a legitimate simplification. It trades true concurrency for a dramatically simpler implementation. Naming it as a valid product-level tradeoff rather than dismissing it reads well.

## Check yourself

```recall
Q: Why do raw character positions fail in collaborative editing?
A: A position only means something relative to one document state; after concurrent edits, applying "insert at 3" lands in different places on different clients, and they diverge.

Q: What does operational transformation do?
A: It adjusts an incoming operation against the operations it hadn't seen (an insert before position 3 shifts it to 4), so every client converges. It usually needs a central server to order operations.

Q: What makes OT hard?
A: Transformation functions must be correct for every pair of operation types — famously error-prone — and the matrix explodes with formatting, tables and lists.

Q: How do text CRDTs avoid conflicts?
A: Every character gets a permanent identifier that can always be minted between two others, so inserts say "between these two characters"; deletes leave tombstones. All clients sort by ID and converge.

Q: What do CRDTs cost?
A: Per-character metadata (mitigated by run-length encoding in Yjs and Automerge), tombstones that need coordination to collect, and convergence that doesn't guarantee sensible intent.

Q: OT or CRDT — what decides it?
A: Whether offline-first or peer-to-peer editing is a core requirement. Server-mediated: a server-ordered log or OT. Offline or P2P: a CRDT, accepting metadata overhead up front.

Q: What is the key architectural decision?
A: One server owns each document (routed by hash of doc ID), giving a natural ordering point with no distributed coordination; fencing tokens stop a stale owner writing.

Q: How are documents persisted?
A: An append-only operation log (history, undo, replay) plus periodic snapshots, so opening loads the last snapshot and the operations since — event sourcing with snapshots.
```

## What to carry forward

- The hard problem is an algorithm: positions break under concurrency.
- OT transforms operations with a central order; CRDTs give characters stable IDs and converge by construction.
- Choose by the offline and peer-to-peer requirement.
- One owner per document, local-first edits, op log plus snapshots.
- Presence is ephemeral — broadcast it, never persist it.
