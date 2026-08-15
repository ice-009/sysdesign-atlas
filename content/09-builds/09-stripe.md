---
title: Build Stripe
summary: The build where correctness beats availability, latency, and scale. Ledgers, idempotency where duplicates cost money, and reconciliation.
difficulty: Hard
scope: HLD
level: 4
prereqs: [payment-system, idempotency, transactions-isolation, distributed-transactions]
tags: [level-4, money, ledger, correctness]
unlocks: Designing for correctness first, and modelling money properly.
---

## The product

A merchant charges a customer's card. Money moves. Refunds work. Every movement is auditable years later.

**This is the one build where scale is not the problem.** 10M transactions/day is ~100 TPS average — a single tuned Postgres handles that comfortably. Diagnosing that early and redirecting to correctness is itself the senior move.

Full interview treatment in the [Payment System case study](../case-studies/payment-system.html).

## Phase 1 — The ledger, before anything else

**Never store money as a mutable balance column.** `UPDATE accounts SET balance = balance - 50` destroys history, races under concurrency, and can't answer "why is this number what it is?"

Double-entry: every transaction is a set of entries summing to zero.

```diagram
   Customer pays ₹500 for an order:

   entry  txn   account              direction  amount
   ────────────────────────────────────────────────────
   e1     t1    customer:4711        DEBIT      500.00
   e2     t1    merchant:pending     CREDIT     500.00
                                              ─────────
                                     sum = 0  ✓
```

What this buys you:

- **Entries are immutable.** A mistake is corrected with a *reversing entry*, never an update. History is the truth.
- **Balance is derived** — `SUM(credits) − SUM(debits)`. Snapshot for performance; entries stay authoritative.
- **The invariant is continuously checkable.** Every transaction sums to zero, and you can verify that on a schedule. Bugs become *detectable* rather than silent.

**Store amounts as integers in the smallest unit.** Never floats. Store the currency alongside every amount; never assume.

:::goat Lead with the data model
"Before the architecture I want to establish the ledger, because it's what makes everything else correct. Immutable, append-only, double-entry — balances derived, corrections as reversing entries. That gives auditability for free and makes the core invariant continuously verifiable."

Almost nobody opens here, and it immediately signals you've thought about money systems specifically.
:::

## Phase 2 — Idempotency

A duplicate here is a double charge. This is the most important mechanism in the build.

```diagram
   POST /charges
   Idempotency-Key: 7f3a-...-9b2c

   BEGIN;
     INSERT INTO idempotency_keys (key, request_hash, status)
       VALUES (:k, :h, 'in_progress');
     -- the UNIQUE constraint IS the atomic gate
   COMMIT;

   duplicate key?
     status = completed  → return the STORED response verbatim
     status = in_progress → 409, client retries
     request_hash differs → 422 (key reused with different params)
```

Details that separate a working implementation from a broken one:

- **Store and replay the exact response**, including the charge ID. A retry must return the *same* charge, not a fresh success.
- **Hash the request body.** A key reused with different parameters is a client bug that must fail loudly, not silently succeed.
- **Pass the key through to the card network.** Your retry must not create a second charge downstream either.

**The ambiguity is fundamental.** If you call the provider and time out, you cannot know whether the charge happened — that's the two generals problem, not a gap in your design. The resolution is to *query* by your idempotency key before retrying, and to reconcile afterwards. Saying this plainly beats pretending a retry is safe.

## Phase 3 — Ordering the saga

Payment spans systems you don't control, so [2PC is unavailable](../distributed/distributed-transactions.html). Order the steps so irreversible ones come last:

```diagram
   1. Reserve inventory      reversible (TTL expiry)
   2. Create payment intent  reversible (cancel)
   3. CHARGE THE CARD        ← PIVOT: irreversible-ish
   4. Confirm order          forward-only from here
```

The **pivot** is the point of no return — the last step you can still undo cleanly. **Before it, compensate; after it, roll forward.** If step 4 fails after the card was charged, you do not silently drop it — you retry until the order is confirmed, or issue a refund as a deliberate, recorded action. "Money taken, nothing delivered, no record" is precisely the failure this ordering prevents.

## Phase 4 — Reconciliation

**The safety net that catches everything the design missed.** Every real payment system has one; mentioning it unprompted is a strong signal.

```diagram
   Daily, against the provider's settlement report:

   in provider, not in ledger  → we lost a record; write the entries
   in ledger, not in provider  → charge never happened; reverse
   amount mismatch             → investigate (FX? partial refund?)

   Nothing auto-resolves silently. Unresolved → alert a human.
```

Plus continuous internal invariant checks: every transaction sums to zero, no account that should be non-negative is negative, the sum of all accounts is zero.

> No matter how careful the design, distributed systems produce edge cases. Reconciliation is how you find them before your customers or auditors do.

## Phase 5 — Webhooks in both directions

A **webhook** is the reverse of an API call: instead of you asking for updates, the other side posts them to a URL you registered. Payments need them in both directions.

**Inbound** (provider → you): assume the same event can arrive twice, so recognise repeats by the provider's event ID, and append every event to a log *before* acting on it. And **don't rely on webhooks alone** — poll for anything stuck in `processing` past a threshold, because a webhook that never arrives is silent.

**Outbound** (you → merchants): the [outbox pattern](../data/cdc-outbox.html) — write the event in the same transaction as the state change, with a relay publishing it. Retry with exponential backoff, sign the payload so merchants can verify authenticity, and expose a replay endpoint for when their endpoint was down.

## The decision log

| Decision | Rejected | Because |
|---|---|---|
| Immutable double-entry ledger | Mutable balance column | Destroys history; races; unauditable |
| Integer minor units | Floats/decimals | Floating-point rounding on money is a known bug class |
| Idempotency key + unique constraint | Dedupe check then insert | Only the constraint is atomic under concurrency |
| Store and replay the response | Return fresh success | A retry must yield the *same* charge |
| Query provider before retry | Blind retry on timeout | Timeout means unknown, not failed |
| Irreversible step last | Charge first | Minimizes what must be compensated |
| Forward recovery after the pivot | Compensate | Money is taken; the obligation is real |
| Reconciliation | Trust the design | Every real payment system has edge cases |
| Relational DB with real transactions | Eventually consistent store | The invariants are exactly what ACID protects |

## What you'd cut for v1

Multi-currency, payouts, subscriptions, disputes, fraud scoring. Ship: charge a card idempotently, record it in a double-entry ledger, refund, reconcile daily. That's a complete, correct payments core.

## Explaining the design

> "First: this isn't a scale problem. 10M transactions a day is about 100 TPS — one Postgres handles it. The problem is correctness and auditability, so that's where I'd spend the time.
>
> I'd start with the data model: an immutable, append-only, double-entry ledger. Balances are derived, corrections are reversing entries, amounts are integers in minor units. That makes the core invariant — entries sum to zero — continuously verifiable.
>
> Idempotency is the critical mechanism, gated by a unique constraint in the same transaction as the work, storing the response so a retry returns the identical charge. The honest part is that a provider timeout leaves the outcome genuinely unknown — that's the two generals problem — so I query by idempotency key before retrying rather than blind-retrying.
>
> Steps are ordered so the card charge is last among reversible operations. After that pivot I roll forward, never back.
>
> And regardless of all of it, daily reconciliation against the provider's settlement report — because distributed systems produce edge cases and I'd rather find them before an auditor does."

## Next

Level 5: [Build an LLM Inference Platform](llm-inference-serving.html) — the same engineering principles with GPUs as the scarce resource.
