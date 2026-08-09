---
title: Design a Payment System
summary: Double-entry ledgers, idempotency where duplicates cost real money, the saga across external providers, and why reconciliation is not optional.
difficulty: Hard
tags: [case-study, ledger, idempotency, consistency]
prereqs: [idempotency, distributed-transactions, transactions-isolation]
---

:::interview Why this question
This is the case study where **correctness dominates everything**. Availability, latency, and scale all take second place to "the money must be right." It's a strong test of [idempotency](../03-distributed/idempotency.html), [distributed transactions](../03-distributed/distributed-transactions.html), and auditability, which is routinely left until it is legally required.
:::

## 1. Requirements

**Functional**
- Charge a customer for an order via an external payment provider.
- Support refunds, partial refunds, and payouts to sellers.
- Maintain an auditable record of every movement of money.
- Handle multiple currencies.

**Non-functional**
- **No lost or duplicated money.** Ever. Non-negotiable.
- Every state change must be auditable and reconstructible.
- Survive provider outages without losing transactions.
- Reasonable latency (a few seconds is acceptable — users expect payment to take a moment).

**Cut:** fraud scoring internals, PCI compliance details (mention card data never touches your servers — use provider-hosted tokenization), chargeback workflows.

**Clarifying questions:** Are we the payment processor, or integrating with one? (Assume integrating — being the processor is a different, much larger problem.) Do we hold funds (a wallet) or pass through? Multi-currency with FX?

## 2. Estimation

**10M transactions/day**, average $50.

```diagram
   Rate: 10⁷ / 10⁵ s = 100 TPS avg → ~500 TPS peak

   → Modest! This is NOT a scale problem. A single well-tuned
     Postgres handles 500 TPS comfortably.

   Storage: ledger entries (2+ per transaction, double-entry)
     10M × 4 entries × 300 B = 12 GB/day
     7-year retention (regulatory) = ~30 TB
     → large but manageable; must be immutable and archived

   The constraint here is CORRECTNESS and AUDITABILITY,
   not throughput.
```

Saying "this isn't a scale problem" early is the right diagnosis and immediately redirects the conversation to where the difficulty actually lives.

## 3. The ledger — get this right first

**Never store money as a mutable balance column.** `UPDATE accounts SET balance = balance - 50` destroys history, races under concurrency, and makes it impossible to answer "why is this number what it is?"

Use **double-entry bookkeeping**: every transaction is a set of entries that sum to zero.

```diagram
   Customer pays $50 for an order:

   entry_id  txn_id  account              direction  amount
   ─────────────────────────────────────────────────────────
   e1        t1      customer:4711        DEBIT       50.00
   e2        t1      merchant:pending     CREDIT      50.00
                                                    ─────────
                                          sum = 0  ✓

   Later, the payout to the merchant:
   e3        t2      merchant:pending     DEBIT       47.50
   e4        t2      merchant:payable     CREDIT      47.50
   e5        t2      revenue:fees         CREDIT       2.50
                                          sum = 0  ✓
```

**Properties this gives you:**

- **Entries are immutable and append-only.** A mistake is corrected with a *reversing entry*, never an update or delete. The history is the truth.
- **Balance is derived** — `SUM(credits) - SUM(debits)` for an account. Snapshot periodically for performance (a `balance_at_checkpoint` row plus entries since), but the entries remain authoritative.
- **The invariant is checkable.** Every transaction's entries must sum to zero, and you can verify this continuously. A bug that breaks it is detectable rather than silent.
- **Full auditability by construction** — you can reconstruct any account's state at any point in time.

:::goat Lead with the ledger
"Before designing the payment flow, I want to establish the data model, because it's what makes the rest correct. I'd use an immutable, append-only, double-entry ledger rather than mutable balance columns. Every transaction writes entries that sum to zero, balances are derived, and corrections are reversing entries. That gives me auditability for free, makes the core invariant continuously verifiable, and eliminates the lost-update races you'd get from updating a balance in place."

Starting here is what distinguishes designing a money system from applying generic system design to money.
:::

Currency handling detail worth stating: **store amounts as integers in the smallest unit** (cents, paise), never floats. Floating-point rounding in financial calculations is a real and well-known source of bugs. And store the currency with every amount — never assume.

## 4. The payment flow

```diagram
   1. Order service creates an order (status: pending_payment)

   2. POST /payments with an IDEMPOTENCY KEY
        → payment_intent created (status: created)
        → ledger entries: customer → pending  (reserved)

   3. Call the external provider (Stripe/Adyen/etc.)
        → pass OUR payment_id as THEIR idempotency key
        → status: processing

   4. Provider responds (or we poll / receive a webhook)
        success → status: captured, ledger entries finalized
        failure → status: failed, reversing entries written

   5. Order service is notified via an event
```

**Note the state machine.** Every payment has an explicit, durable status, and transitions are conditional updates. There is never a moment where the outcome exists only in memory or only at the provider.

## 5. Deep dive — idempotency

The single most important mechanism here, because a duplicate is a double charge.

```diagram
   POST /payments
   Idempotency-Key: 7f3a-...-9b2c
   { "order_id": 8821, "amount": 5000, "currency": "INR" }

   SERVER:
     BEGIN;
       INSERT INTO idempotency_keys (key, request_hash, status)
         VALUES (:k, :h, 'in_progress');
       -- unique constraint on `key` IS the atomic gate
     COMMIT;

     -- duplicate key error?
     --   status = completed   → return the STORED response
     --   status = in_progress → return 409, client retries
     --   request_hash differs → return 422 (key reused with
     --                          different parameters — a client bug
     --                          that must not silently succeed)
```

**Details that matter and that candidates miss:**

- **Store and replay the exact response**, including the payment ID. A retry must return the *same* payment, not a fresh success.
- **Hash the request body** and compare. If a client reuses a key with different parameters, that's a bug — fail loudly rather than returning a response for a different payment.
- **Pass idempotency through to the provider.** Your retry to Stripe must not create a second charge either. Good providers accept an idempotency key precisely for this.
- **Expire keys** after ~24h.

**The unavoidable ambiguity:** if you call the provider and time out, you don't know whether the charge happened. You cannot know. The resolution is to **query the provider by your idempotency key** before retrying, and to reconcile afterwards. Stating that this ambiguity is fundamental — rather than pretending a retry is safe — is exactly right.

## 6. Deep dive — the distributed transaction

Payment spans systems you don't control: your ledger, the provider, the order service, inventory.

**2PC is unavailable** (you can't enlist Stripe in a transaction). So: a [saga](../03-distributed/distributed-transactions.html) with careful ordering.

```diagram
   Order the steps so IRREVERSIBLE ones come LAST:

   1. Reserve inventory        (reversible: TTL expiry)
   2. Create payment intent    (reversible: cancel)
   3. CHARGE THE CARD          ← irreversible-ish (refund is
                                 a new transaction, visible to
                                 the customer)
   4. Confirm order            (forward-only from here)

   The PIVOT is step 3. Before it, abort by compensating.
   After it, we must roll FORWARD — the money is taken, so
   the order must be fulfilled or explicitly refunded.
```

**Forward recovery after the pivot** is the key idea. If step 4 fails after the card was charged, you do *not* silently drop it — you retry until the order is confirmed, and if it truly cannot be, you issue a refund as a deliberate, recorded action. "Money taken, nothing delivered, no record" is the failure mode this design exists to prevent.

## 7. Deep dive — reconciliation

**The safety net that catches everything the design missed.** Every real payment system has one, and its absence is usually discovered during the first reconciliation dispute.

```diagram
   Daily (and continuously):

   1. Fetch the provider's settlement report
   2. Compare, transaction by transaction, against our ledger
   3. Classify every discrepancy:
        - in provider, not in ledger  → we lost a record;
                                        write the missing entries
        - in ledger, not in provider  → charge never happened;
                                        reverse
        - amount mismatch             → investigate; likely FX
                                        or a partial refund
   4. Alert on anything unresolved; nothing auto-resolves silently
```

Also run **internal invariant checks continuously**: every transaction's entries sum to zero; no account that should be non-negative is negative; the sum of all accounts is zero.

The framing to use: *"No matter how careful the design, distributed systems produce edge cases. Reconciliation is how you find them before your customers or auditors do."*

## 8. Storage and consistency choices

```diagram
   ledger_entries   (Postgres, append-only, never UPDATE/DELETE)
     partition by month for archival
     index: (account_id, created_at), (transaction_id)

   payments         (Postgres — state machine, transactional)
   idempotency_keys (Postgres — unique constraint is the gate)
   provider_events  (append-only log of every webhook received)
```

**Use a relational database with real transactions.** Confidently. This is a case where the boring answer is correct and reaching for an eventually-consistent store would be a serious error — the invariants are exactly what ACID exists to protect.

**Shard by account or customer** if needed, keeping a transaction's entries on one shard. At 500 TPS you almost certainly don't need to.

**Replication must be synchronous** — RPO zero. Losing acknowledged payment records on failover is not acceptable, so accept the write-latency cost.

## 9. Failure modes & follow-ups

| Failure | Behaviour |
|---|---|
| Provider times out | Unknown outcome. **Query by idempotency key** before retrying; never blind-retry a charge. Reconciliation catches the rest. |
| Provider down | Queue the payment, retry with backoff, inform the user it's processing. Never lose the intent. Consider a fallback provider. |
| We charge but fail to record | The dangerous case. Reconciliation detects it against the settlement report and writes the missing entries. |
| Webhook delivered twice | Provider webhooks are at-least-once. Dedupe on the provider's event ID; store every event in the append-only log first. |
| Webhook never delivered | **Don't rely on webhooks alone.** Poll for the status of any payment stuck in `processing` past a threshold. |
| Database failover | Sync replication means no committed payment is lost. Brief write unavailability is correct behaviour. |

**Follow-ups:**
- *"Multi-currency?"* — store amount and currency together; record the FX rate *used* on the transaction (not a live lookup at read time, or historical reports change). Ledger accounts are per-currency; FX is an explicit transaction between them.
- *"Refunds?"* — a new transaction with reversing entries, never a deletion or update of the original. Partial refunds are partial reversals. The original charge remains visible forever, which is what auditors require.
- *"How do you test this?"* — provider sandbox environments, deterministic replay of the ledger, property-based tests asserting the sum-to-zero invariant, and chaos testing of the timeout paths specifically, since that's where the ambiguity lives.
- *"Wallets / holding balances?"* — the ledger already handles it: a customer wallet is just another account. Payouts move between accounts. This is where the double-entry model pays off, because you don't need a new mechanism.
