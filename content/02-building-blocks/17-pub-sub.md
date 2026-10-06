---
title: Pub/Sub & Event-Driven Architecture
summary: Fanout messaging, event notification vs event-carried state vs event sourcing, and the coupling problems event-driven systems trade for the ones they solve.
difficulty: Medium
scope: HLD
tags: [pubsub, events, architecture]
prereqs: [message-queues]
---

:::predict Guess first
1. In a queue each message goes to one worker. What's different about pub/sub?
2. Should an "order placed" event carry just the order ID, or the whole order?
3. Event sourcing keeps every change forever. What happens when a user asks for their personal data to be deleted?
:::

## Pub/sub vs queues

A [queue](message-queues.html) distributes work: each message goes to **exactly one** consumer. Pub/sub distributes information: each message goes to **every** subscriber.

```diagram
   QUEUE (competing consumers)      PUB/SUB (fanout)

   producer → [q] → worker A        publisher → [topic] → sub A
                  → worker B                            → sub B
                  → worker C                            → sub C
   each msg to ONE worker           each msg to ALL subs
```

The distinction matters because it determines coupling. With a queue, the producer is choosing *work to be done*. With pub/sub, the producer is announcing *something that happened*, and it neither knows nor cares who reacts. That's the decoupling that makes event-driven architecture attractive — you can add a fifth consumer of `OrderPlaced` without touching the order service.

Log-based systems like Kafka do both: consumers in the *same* group compete (queue semantics), while different groups each get every message (pub/sub semantics).

## Three kinds of event

A distinction that clarifies most event-driven design arguments, and one worth naming explicitly.

### 1. Event notification

The event is a bare fact plus an ID.

```json
{ "type": "OrderPlaced", "order_id": "8821", "at": "2026-08-07T10:00:00Z" }
```

Consumers that need details **call back** to the order service. Tiny payloads, no duplicated data, and the producer's schema stays private.

Cost: every consumer makes a synchronous callback, so you've reintroduced runtime coupling — the order service must be up for consumers to work, and N consumers means N callbacks per event.

### 2. Event-carried state transfer

The event carries everything a consumer might need.

```json
{ "type": "OrderPlaced", "order_id": "8821",
  "customer": {...}, "items": [...], "total": 4999 }
```

Consumers are fully autonomous — they can process events while the producer is down and maintain their own local read models. This is the pattern that actually delivers the availability benefits people want from events.

Cost: larger payloads, duplicated data across services, and the payload becomes a **public contract** that's hard to change. Consumers may also act on stale state (the order changed after the event was emitted).

### 3. Event sourcing

The event log **is** the source of truth. Current state is derived by replaying events rather than stored directly.

```diagram
   AccountOpened(id=1)          →  balance 0
   Deposited(id=1, 100)         →  balance 100
   Withdrew(id=1, 30)           →  balance 70
   Deposited(id=1, 50)          →  balance 120   ← current state
                                    (a projection, rebuildable)
```

**Genuine strengths:** a complete audit trail by construction (invaluable for finance and compliance), the ability to reconstruct state at any past point in time, and the ability to build *new* projections over historical data — answering questions nobody thought to ask when the events were written.

**Genuine costs, and you should name them:** querying current state requires a projection (which is eventually consistent); events are immutable so schema evolution requires versioning and upcasting forever; you can't simply `UPDATE` a mistake, you must emit a compensating event; deleting personal data conflicts with an append-only log (a real GDPR problem, usually solved by crypto-shredding — encrypting per subject and discarding the key); and replay times grow, requiring snapshots.

**When it's right:** finance, ledgers, audit-heavy domains, and systems where "how did we get here?" is a first-class question. **When it's wrong:** ordinary CRUD, which is most software. Proposing event sourcing for a straightforward application is a classic over-engineering signal.

## CQRS

Command Query Responsibility Segregation — an ugly name for a simple idea: **stop using one model for both writing and reading.** Store writes in whatever shape keeps the data correct, and separately maintain read-shaped copies built from those writes.

```diagram
   commands ──► write model ──► events ──┬──► read model A (SQL)
              (normalized,               ├──► read model B (search)
               validates                 └──► read model C (cache)
               invariants)                    each optimized for
                                              its own queries
```

Writes optimize for correctness and invariants; reads optimize for query shape. You can have several read models, each in whatever store suits it — which is really just [polyglot persistence](sql-vs-nosql.html) driven by an event stream.

The cost is unavoidable and must be stated: **read models are eventually consistent.** A user submits a change and may not see it in a query immediately. Handle it in the UI (show the intended result optimistically) or with [read-your-writes](../01-fundamentals/consistency-models.html) on the affected path — don't pretend it isn't there.

CQRS pairs naturally with event sourcing but doesn't require it; plain [CDC](../04-data/cdc-outbox.html) from a normal database gets you most of the benefit for far less complexity.

## Delivery and ordering

Everything from [message queues](message-queues.html) applies, with fanout multiplying the consequences:

- **At-least-once means every subscriber sees duplicates.** Each one needs [idempotency](../03-distributed/idempotency.html) independently — the producer can't solve this for them.
- **Ordering is per-partition**, so events for one entity must share a partition key.
- **One slow subscriber must not block the others.** In log-based systems each consumer group has its own offset, so this comes free. With a broker doing fanout, a slow subscriber's queue grows and needs its own backpressure policy.

## The coupling you traded for

Event-driven architecture removes *runtime* coupling and replaces it with *schema* coupling, plus new operational problems. Be explicit about these. Knowing the limits of your own design is the difference between a considered choice and a lucky one.

**Schema evolution.** Once five services consume `OrderPlaced`, its shape is a promise you can't change on your own. You need to only ever *add* fields, to version the event, and to keep a **schema registry** — a shared record of every event's agreed shape, which rejects a change that would break existing consumers before it ships.

**No global view.** A request that spans six services asynchronously has no stack trace. Distributed tracing with a correlation ID propagated through every event is mandatory, not optional.

**Debugging is genuinely harder.** "Why didn't this email send?" becomes an archaeology exercise across consumer lag, dead letter queues, and logs in six places.

**Eventual consistency leaks to users.** "I placed the order but it doesn't appear in my history" is a support ticket caused by architecture.

**Emergent cycles.** Service A emits an event that triggers B, which emits an event that triggers A. Nobody designed this; it assembled itself over three quarters. Event choreography makes control flow invisible.

:::goat Choreography vs orchestration
Worth raising when a design gets event-heavy. **Choreography** — each service reacts to events independently — is maximally decoupled and makes the overall business process impossible to see in any one place. **Orchestration** — a coordinator explicitly drives the steps — centralizes the process so it's visible, testable, and monitorable, at the cost of a component that knows about everyone.

"I'd use choreography for side effects like notifications and analytics, where nobody needs to see the whole flow. For the order fulfillment process itself I'd use an orchestrator — a [saga](../03-distributed/distributed-transactions.html) coordinator — because I need to know what state each order is in and be able to compensate when a step fails." That distinction is easy to miss and changes the design.
:::

## When not to use events

- **The caller needs the answer.** A query is a query. Don't make "get the user's balance" asynchronous.
- **Strong consistency is required.** Events are eventually consistent by nature; an invariant spanning services usually means the boundary is drawn wrong.
- **Two services only.** A direct call is simpler, debuggable, and adequate.
- **The team is small.** Event-driven architecture front-loads complexity in exchange for later flexibility. With three engineers and one deployable, you're paying the cost and collecting none of the benefit.

:::exercise Fan-out arithmetic
1. A topic has 10,000 subscribers and receives 1,000 messages/second. Compute the delivery rate. Where does that break first?
2. One subscriber is slow. Design the system so it does not slow down the other 9,999 — name the mechanism and what it costs.
3. Compare fan-out on write and fan-out on read for a notification system with a heavily skewed subscriber distribution. Where is the crossover?
4. A subscriber is offline for 6 hours. What happens to its messages under a log-based system and under a push-based one?
5. You need exactly-once delivery to a subscriber that sends emails. Explain why that is impossible, then design something that achieves the outcome anyway.
:::

:::paper Publish-subscribe as a paradigm
*The Many Faces of Publish/Subscribe* (Eugster et al., Computing Surveys 2003) is the survey that categorises the design space — topic-based, content-based, and type-based.

*Wormhole: Reliable Pub-Sub to Support Geo-replicated Internet Services* (Sharma et al., NSDI 2015) is Facebook's system and covers ordering and delivery guarantees across regions.
:::

## Check yourself

```recall
Q: Queue versus pub/sub: who gets each message, and what does that say about coupling?
A: A queue gives each message to one worker — the producer is assigning work. Pub/sub gives it to every subscriber — the producer announces what happened and doesn't know who reacts, so new consumers need no producer change.

Q: Event notification versus event-carried state transfer: what does each cost?
A: A bare ID keeps payloads small and schemas private, but every consumer calls back, re-coupling them at runtime. Carrying full state makes consumers autonomous even when the producer is down, but payloads grow and become a public contract.

Q: What is event sourcing good for, and when is it the wrong choice?
A: A complete audit trail, state at any past moment, and new projections over history — great for ledgers and audit-heavy domains. Wrong for ordinary CRUD, where it's over-engineering.

Q: How do event-sourced systems handle a GDPR deletion request?
A: Crypto-shredding: encrypt each person's data with their own key and discard the key, since the log itself can't be edited.

Q: What is CQRS, and what cost must you state?
A: Separate models for writing (correctness, invariants) and reading (shaped for each query), fed by events or CDC. Read models are eventually consistent, so handle the lag with optimistic UI or read-your-writes.

Q: What coupling does event-driven design add in place of runtime coupling?
A: Schema coupling: an event consumed by five services is a contract. Only add fields, version events, and use a schema registry that rejects breaking changes.

Q: Choreography versus orchestration?
A: Choreography: services react to events independently — decoupled, but the overall process is invisible. Orchestration: a coordinator drives the steps — visible and able to compensate. Use choreography for side effects and orchestration for core workflows.

Q: When shouldn't you use events?
A: When the caller needs the answer, when strong consistency spans services, when there are only two services, or when the team is small — you pay the complexity without the benefit.
```

## What to carry forward

- Queues assign work to one consumer; pub/sub announces facts to all subscribers.
- Choose deliberately between thin notifications, event-carried state and full event sourcing.
- CQRS splits write and read models; its read side is eventually consistent.
- Events trade runtime coupling for schema coupling, harder debugging and visible lag — use registries and tracing.
- Choreograph side effects, orchestrate core workflows, and use plain calls when the caller needs the answer.
