---
title: Idempotency & Delivery Semantics
summary: Why duplicates are guaranteed, why "exactly-once delivery" doesn't exist, and the concrete patterns that make repeated operations safe.
difficulty: Medium
tags: [idempotency, exactly-once, retries, correctness]
prereqs: [failure-modes, message-queues]
---

## Why this is unavoidable

A client sends a payment request and the connection times out. Did the charge happen?

```diagram
   client ──── POST /charge ────► server
          ◄──── ??? timeout ────

   Possibility 1: request never arrived        → safe to retry
   Possibility 2: arrived, server died first   → safe to retry
   Possibility 3: processed, response lost     → retry = DOUBLE CHARGE
   Possibility 4: still processing slowly      → retry = DOUBLE CHARGE
```

**The client cannot distinguish these.** Ever. This is not an implementation gap — it's the two generals problem, and it's provably unsolvable.

So you have exactly two options: never retry (and lose operations), or retry and make duplicates harmless. Since losing payments is worse than the alternative, essentially every real system retries — and therefore **every real system must handle duplicates.**

## Definition

An operation is **idempotent** if performing it multiple times has the same effect as performing it once.

```diagram
   IDEMPOTENT                    NOT IDEMPOTENT
   SET balance = 100             balance = balance - 50
   DELETE user 42                INSERT INTO orders ...
   PUT /users/42 {...}           POST /orders {...}
   status = 'shipped'            counter++
   add 42 to a set               append to a list
   upsert by primary key         send an email
```

Note the pattern: **assignment is idempotent, mutation relative to current state is not.** "Set to X" survives repetition; "change by X" doesn't.

HTTP semantics reflect this: `GET`, `PUT`, `DELETE`, and `HEAD` are defined as idempotent; `POST` and `PATCH` are not. That's why `PUT /users/42` with a full representation is safer than `POST /users` — but note this is only a *convention*; your implementation has to actually honor it.

## Delivery semantics, precisely

**At-most-once** — ack before processing. Messages may be lost, never duplicated. Only acceptable for disposable data (sampled metrics, presence pings).

**At-least-once** — ack after processing. Nothing is lost; duplicates **will** occur. The practical default.

**Exactly-once** — the phrase to be careful with.

:::trap "We need exactly-once delivery"
Exactly-once *delivery* is impossible over an unreliable network. The sender that receives no acknowledgment must choose: resend (risking a duplicate) or not (risking a loss). No protocol escapes this.

What is achievable is **exactly-once processing** — or more precisely, *effectively-once*: at-least-once delivery combined with idempotent consumers, so duplicate deliveries produce no additional effect.

Kafka's "exactly-once semantics" is real but narrow: it achieves atomic read-process-write **within Kafka** using transactions over offsets and output topics. The moment your consumer writes to an external database or calls a payment API, that guarantee ends and you're back to needing idempotency.

The correct interview answer: *"I'd use at-least-once delivery and make the consumer idempotent. Exactly-once delivery isn't achievable across system boundaries; exactly-once effect is, and that's what the requirement actually means."*
:::

## The patterns

### 1. Idempotency keys (the standard for APIs)

The client generates a unique key per logical operation and sends it with every attempt, including retries.

```diagram
   POST /charges
   Idempotency-Key: 7f3a-...-9b2c
   { "amount": 4999, "account": 42 }

   SERVER:
     1. Try to INSERT the key into idempotency_records.
        Unique constraint → this is the atomic gate.
     2. Insert succeeded → first attempt. Process it,
        store the response body against the key.
     3. Insert failed (duplicate key) →
          - if the stored record has a response: return it verbatim
          - if it's still in progress: return 409 / ask to retry
```

**Critical details that separate a working implementation from a broken one:**

- **The uniqueness check and the work must be in one transaction** — or the key insert must commit *first*, so two concurrent retries can't both pass the check. A `SELECT` then `INSERT` races.
- **Store the response**, not just the key. A retry must return the *same* result (same order ID, same charge ID), not a fresh 200 with no body.
- **Handle in-flight duplicates.** If the first request is still processing, the second must not proceed. Returning 409 and letting the client retry is the simplest correct behaviour.
- **Scope the key** to the account and endpoint, so keys can't collide or leak across tenants.
- **Expire keys** after ~24 hours. Retries don't arrive a week later, and the table would grow forever.

### 2. Natural idempotency

Design the operation so repetition is inherently harmless — the cheapest option when available.

```sql
-- not idempotent
UPDATE accounts SET balance = balance - 50 WHERE id = 42;

-- idempotent: conditional on a state that changes
UPDATE accounts SET balance = balance - 50, version = 8
WHERE id = 42 AND version = 7;      -- second run: 0 rows
```

Also: `INSERT ... ON CONFLICT DO NOTHING`, upserts keyed by a business identifier, and set membership (adding an existing element is a no-op).

### 3. Deduplication table

The consumer-side equivalent for message queues: record processed message IDs and skip repeats.

```diagram
   BEGIN;
     INSERT INTO processed (msg_id) VALUES (?);  -- unique; fails on dupe
     ... do the work ...
   COMMIT;
```

Putting the dedupe insert **in the same transaction as the work** is what makes it correct. If they're separate, a crash between them either loses the work or loses the dedupe record.

Bound the table with a TTL, and use a [Bloom filter](../02-building-blocks/bloom-filters.html) in front if the volume is very high (a definite "not seen" avoids a database round trip).

### 4. State machines

Model the entity's lifecycle explicitly and make transitions conditional:

```diagram
   pending → authorized → captured → settled
                    ↘ failed

   "capture" applied to an already-captured payment:
   the transition is invalid → no-op, return current state
```

The state machine makes idempotency a structural property rather than a bolt-on. It also makes the system easy to reason about during incidents — you can always ask "what state is this in?"

## The hard cases

**Non-idempotent side effects you don't control.** Sending an email, charging a third-party API, dispatching a physical package. You can't undo them, so you must not repeat them.

The pattern: **record the intent transactionally, perform the effect once, record completion.**

```diagram
   BEGIN; INSERT INTO outbox(intent='send_email', id=X); COMMIT;

   worker:
     claim row X (conditional update: status pending → sending)
     call the email API with X as its idempotency key
     mark X sent
```

Push idempotency onto the external service where possible — good payment and email providers accept idempotency keys precisely for this. Where they don't, accept a small duplicate risk and design for detection rather than prevention (a duplicate email is recoverable; a duplicate charge needs reconciliation and refund).

**Ordering plus retries.** A retried message may arrive after later messages, so a retry can apply stale data. Fix with version checks (reject writes carrying an older version) or last-write-wins on a monotonic sequence number — see [Clocks](clocks.html).

**Partial failure across systems.** The database write succeeded, publishing the event failed. Retrying re-does the database write. This is what the [outbox pattern](../04-data/cdc-outbox.html) exists to solve: make the event part of the same transaction, so there's nothing to coordinate.

## The short answer

When any design involves retries, queues, or payments, say this early — it's a fast, high-value signal:

> "This path has to be idempotent, because the queue is at-least-once and the client will retry on timeout. I'll take an idempotency key from the client, gate it with a unique constraint in the same transaction as the work, and store the response so a retry returns the identical result rather than creating a second order. Exactly-once delivery isn't something I can get from the transport, so I'm getting exactly-once *effect* from the consumer instead."

:::exercise Make it safe to retry
1. A payment API times out. The client does not know whether the charge happened. Design the retry protocol so that it is safe, and be specific about what the server stores.
2. Where does the idempotency key come from? Compare: client-generated UUID, hash of the request body, and a key derived from business identity. Which survives a client restart?
3. How long must you retain idempotency records? What happens at expiry, and how do you choose the window?
4. Two concurrent requests with the same idempotency key arrive simultaneously. Walk through the race and design the fix.
5. Now the hard one: a request is idempotent at your API but calls a downstream that is not. What can you do?
:::

:::paper Exactly-once, honestly
*Life beyond Distributed Transactions: an Apostate's Opinion* (Pat Helland, CIDR 2007) is the essential paper — it argues that at scale you give up distributed transactions and build on idempotence and retries instead, and it is still the clearest statement of why.

Stripe's engineering post on idempotency keys is the best practical reference for the API-level pattern.
:::
