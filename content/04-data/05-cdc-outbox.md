---
title: Change Data Capture & the Outbox Pattern
summary: How to reliably propagate database changes to search indexes, caches, and other services — without dual writes, and without losing events.
difficulty: Medium
scope: HLD
tags: [cdc, outbox, events, consistency]
prereqs: [transactions-isolation, message-queues, idempotency]
---

:::predict Guess first
1. Your code saves an order, then publishes an "order placed" event. What happens if the publish fails after the save succeeded?
2. Would publishing the event first, then saving, fix it?
3. The database already records every change it makes. Could you read events from there instead of publishing them yourself?
:::

## The dual-write problem

You update the database and you need to tell someone — reindex in Elasticsearch, invalidate a cache, publish an event, notify another service.

The obvious implementation is broken:

```diagram
   BROKEN
     db.save(order)          ✓ succeeded
     queue.publish(event)    ✗ network blip

   → the order exists; nothing downstream knows.
     Search index, cache, and every consumer are now
     permanently wrong, with no self-healing.

   BROKEN THE OTHER WAY
     queue.publish(event)    ✓
     db.save(order)          ✗ constraint violation

   → an event announcing an order that doesn't exist.
```

Two systems, no shared transaction. You cannot make two independent writes atomic by ordering them cleverly — there is always a window.

**And you can't fix it with a distributed transaction.** [2PC](../03-distributed/distributed-transactions.html) across a database and a message broker is possible in theory, unavailable in most stacks, and blocks under coordinator failure. It's the wrong tool.

The insight: **you don't need two atomic writes. You need one write, and a reliable way to derive the second from it.**

## The outbox pattern

The fix is to stop making two writes. Put the event in an ordinary table — the **outbox** — in the *same database* and the *same transaction* as the business change, so the database's own atomicity guarantees they both land or neither does. A separate process then reads that table and does the publishing.

The outbox is just a mailbox: the transaction drops a letter in it, and someone else posts it.

```diagram
   BEGIN;
     INSERT INTO orders (id, customer, total) VALUES (...);
     INSERT INTO outbox (id, aggregate, type, payload, created_at)
       VALUES (..., 'Order', 'OrderPlaced', '{...}', now());
   COMMIT;                    ← atomic: both rows or neither

           │
           ▼  relay process
   ┌──────────────────────────────────────────┐
   │ read unpublished outbox rows             │
   │ publish to Kafka/SQS                     │
   │ mark as published (or delete)            │
   └──────────────────────────────────────────┘
```

Now atomicity is a *local* transaction — trivially guaranteed. The event either exists alongside the order or neither exists.

**The relay gives at-least-once delivery**, which is exactly right: publishing can fail and be retried; a crash between publishing and marking means a duplicate, which [idempotent consumers](../03-distributed/idempotency.html) handle.

### Two ways to run the relay

**Polling.** `SELECT * FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100`. Simple, works on any database, no special permissions. Costs a little latency (your poll interval) and constant query load. Index on `(published_at, id)`, and delete or archive published rows so the table doesn't grow forever.

**Log tailing (CDC).** Read the database's replication log directly — no polling, no query load, latency in milliseconds. This is the better option at scale and leads directly to the next section.

:::trap The ordering detail people miss
With polling by auto-increment ID, a subtle bug: transaction A gets ID 100 and transaction B gets ID 101, but B **commits first**. A poller reading "everything above my last-seen ID" can read 101, advance its cursor, and then never see 100 when it commits a moment later.

Fixes: poll by "unpublished" status rather than by a monotonic cursor (so nothing can be skipped), or read from the transaction log where entries appear in commit order. Raising this unprompted is a strong depth signal — it's a real bug that ships regularly.
:::

## Change Data Capture

**Change Data Capture** takes a different route to the same goal. Every database already keeps an ordered log of what it changed, because that's how it does crash recovery and how it feeds its replicas. CDC simply reads that log and turns each committed change into an event.

The appeal: your application code doesn't change at all. It writes rows as it always did, and the events fall out of the database's own record of those writes.

```diagram
   ┌────────────┐   WAL / binlog    ┌─────────┐
   │ Postgres   │ ────────────────► │ Debezium│──► Kafka
   │  (truth)   │  logical decoding │  or     │      │
   └────────────┘                   │ similar │      ├─► search index
                                    └─────────┘      ├─► cache
                                                     ├─► data warehouse
                                                     └─► other services
```

**Why this is powerful:**

- **The application doesn't change at all.** No outbox table, no publish calls. Existing code keeps writing to the database.
- **Nothing can be missed.** The log *is* the record of what committed — there's no code path that could forget to emit.
- **Commit order is preserved**, exactly as the database saw it.
- **Low latency**, typically milliseconds.
- **Snapshot + stream.** Most CDC tools take an initial consistent snapshot and then switch to streaming, so a new consumer gets full history plus live updates.

**Costs and constraints:**

- **Events mirror your schema**, not your domain. Consumers become coupled to your table structure — a real problem, since you can no longer rename a column freely. This is the strongest argument for the outbox pattern *even when you have CDC*: the outbox lets you publish a deliberately designed event, while CDC publishes whatever your tables look like.
- **Operational setup** — replication slots, permissions, log retention. A stalled consumer holding a replication slot open prevents WAL cleanup and can **fill the primary's disk**, taking down the database. This is a genuine production hazard and an excellent detail to mention.
- **Schema changes** ripple to consumers; you want a schema registry with compatibility rules.
- **Deletes and TTL expiries** may appear differently than you expect.

**The combination that's best in practice:** write to an outbox table for *deliberate, well-designed domain events*, and use CDC to tail that outbox table. You get the low latency and guaranteed capture of CDC with the clean, decoupled contract of the outbox. This is the answer that actually holds up under scrutiny.

## What this pattern is for

**1. Keeping derived stores in sync.** [Search indexes](../02-building-blocks/search.html), caches, denormalized read models, and analytics warehouses are all *derived* from the primary database. CDC guarantees they converge — and lets you rebuild any of them from scratch by replaying.

**2. Cache invalidation.** Rather than each write path remembering to invalidate, a CDC consumer invalidates on every change. Nothing is forgotten because nothing has to remember.

**3. Cross-service integration** without the source service knowing its consumers.

**4. The strangler pattern.** Migrating off a legacy system: stream its changes into the new one, run both in parallel, verify equivalence, then cut over. CDC is the standard mechanism for large migrations with no downtime.

**5. Building an audit log** — every change, in order, with before and after values.

## The consistency contract

State this clearly whenever you propose it, because it's the tradeoff being bought:

```diagram
   DB commit ──► log ──► relay ──► broker ──► consumer ──► derived store
     t=0          t+1ms   t+10ms    t+20ms     t+50ms      t+100ms

   The derived store is EVENTUALLY consistent — typically
   tens to hundreds of ms behind, occasionally much more
   under load or during a consumer restart.
```

Consequences to design around:

- A user may write and not immediately see the change in search or a derived view. If that matters, read the user's own recent items from the primary and merge — a targeted [read-your-writes](../01-fundamentals/consistency-models.html) fix rather than making the whole pipeline synchronous.
- **Monitor consumer lag in time**, not message count. "We're 4 minutes behind" maps to user impact; "12,000 messages" doesn't.
- Consumers must be **idempotent** — the pipeline is at-least-once end to end.
- Consumers must tolerate **out-of-order arrival** across different keys. Order is only guaranteed per partition, so partition by the entity's ID.

## Comparison

| Approach | Atomicity | App changes | Coupling | Latency |
|---|---|---|---|---|
| Dual write | ✗ broken | Yes | Low | Low |
| 2PC | ✓ | Yes | High | High, blocks |
| **Outbox (polling)** | ✓ | Some | Low | Seconds |
| **CDC on tables** | ✓ | **None** | High (schema) | Milliseconds |
| **Outbox + CDC** | ✓ | Some | Low | Milliseconds |

The bottom row is the one to recommend when the design warrants it. The middle rows are fine when it doesn't — and knowing that a polling outbox is perfectly adequate for a system doing 100 events per second is as valuable as knowing the sophisticated version exists.

:::exercise Eliminate the dual write
1. Write to the database, then publish to Kafka. Enumerate every interleaving where the two diverge, including crashes.
2. Design the outbox: what goes in the transaction, what the relay does, and how the relay is made idempotent.
3. Log-based CDC versus outbox versus polling. Compare on latency, ordering guarantees, schema coupling, and operational burden.
4. Your CDC stream must not include a `password_hash` column. Where do you filter, and what happens on a schema change that adds a sensitive column?
5. A consumer needs to rebuild its state from scratch. Design the bootstrap: snapshot plus stream, and the exact handoff point between them.
:::

:::paper Getting data out of a database reliably
*Turning the Database Inside-Out* (Martin Kleppmann, 2015) is the conceptual argument for treating the log as the primary interface. Debezium's documentation is the practical reference for log-based CDC across engines.

The outbox pattern is documented most clearly in Chris Richardson's microservices patterns catalogue; the underlying problem — the dual-write — is the same one described in [vector databases](../07-ai-systems/vector-databases.html).
:::

## Check yourself

```recall
Q: What is the dual-write problem?
A: Writing to two systems — say a database and a broker — with no shared transaction. Whichever order you choose, a crash or failure between them leaves one updated and the other not, permanently.

Q: How does the outbox pattern fix dual writes?
A: Insert the event into an outbox table in the same local transaction as the business change, so both commit or neither does. A relay publishes outbox rows afterwards, at least once.

Q: Why must outbox consumers be idempotent?
A: The relay can publish and then crash before marking the row published, so it publishes again on restart. Delivery is at least once.

Q: What ordering bug hits a polling relay that follows an ID cursor?
A: Transaction A takes ID 100, B takes 101, but B commits first. The poller reads 101, advances past 100, and never sees A. Poll by "unpublished" status or read the log in commit order.

Q: What is change data capture, and why is it attractive?
A: Reading the database's replication log (WAL or binlog) and turning each committed change into an event. The application doesn't change, nothing can be missed, commit order is kept, and latency is milliseconds.

Q: Name CDC's two biggest costs.
A: Events mirror your table schema, coupling consumers to it; and a stalled consumer holding a replication slot stops WAL cleanup and can fill the primary's disk.

Q: What combination is best in practice?
A: An outbox table for deliberately designed domain events, with CDC tailing that table: CDC's latency and guaranteed capture, plus a clean contract decoupled from your tables.

Q: What must derived stores fed by CDC handle?
A: Eventual consistency (tens to hundreds of milliseconds behind), at-least-once duplicates, and ordering only within a partition — so partition by entity ID and measure lag in time, not messages.
```

## What to carry forward

- Two independent writes can't be made atomic by ordering them — derive the second from the first.
- Outbox: the event commits in the same local transaction; a relay delivers it at least once.
- CDC reads the database's own log: no app changes and nothing missed, but schema coupling and replication-slot risk.
- Outbox plus CDC on the outbox table gives the clean contract and the low latency.
- Derived stores are eventually consistent: idempotent consumers, per-entity ordering, lag measured in seconds.
