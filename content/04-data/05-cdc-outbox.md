---
title: Change Data Capture & the Outbox Pattern
summary: How to reliably propagate database changes to search indexes, caches, and other services — without dual writes, and without losing events.
difficulty: Medium
scope: HLD
tags: [cdc, outbox, events, consistency]
prereqs: [transactions-isolation, message-queues, idempotency]
---

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

Write the event into the *same database*, in the *same transaction*, as the business change. Then a separate process publishes it.

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

CDC reads the database's own replication log — the WAL in Postgres, the binlog in MySQL — and turns every committed change into a stream of events.

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
