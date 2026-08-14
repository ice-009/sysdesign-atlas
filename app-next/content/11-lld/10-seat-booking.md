---
title: Design Seat Booking (BookMyShow)
summary: The problem that spans both rounds — seat state machine, temporary holds with TTL, payment flow, and the exact moment the answer has to move from an in-process lock to a conditional database write.
difficulty: Medium
tags: [lld-problem, concurrency, state-machine, hld-bridge]
prereqs: [concurrency-in-lld, splitwise, idempotency]
unlocks: Handling the double-booking question at both zoom levels, and knowing when an in-memory answer stops being valid.
---

Ask for this one if you get a choice. It's the problem where LLD and HLD meet: the class model is small, but the interesting part — two users, one seat — is a correctness question that survives all the way up to a distributed system. It's also the most likely place to be asked *"and now with five servers?"*, so it's the best rehearsal for that pivot.

## 1 · Requirements (0–5)

**Ask first:** how many seats per show (hundreds, or a 100k-seat stadium)? do we need a hold-then-pay flow or is booking atomic? single server or a fleet? seat maps or general admission?

Assume: cinema-scale shows, hold-then-pay, and "start single-node, then let's scale it".

**Functional**
- Browse cities → cinemas → shows → seat map with live availability.
- Select seats and get a **temporary hold** (typically 5–10 minutes) while paying.
- Pay → hold becomes a confirmed booking. Fail or time out → seats return to the pool.
- Cancel a booking (with a refund policy).

**Non-functional**
- **A seat is sold at most once.** This is the invariant; everything else is negotiable.
- Holds must expire even if the client vanishes mid-checkout.
- Seat-map reads vastly outnumber writes and can tolerate ~1s staleness — but the *booking* decision cannot.

**Out of scope:** pricing engines, recommendations, the payment gateway internals.

## 2 · Entities (5–12)

```diagram
   City · Cinema · Screen        static-ish catalogue
   Show          id, movieId, screenId, startsAt, seatPricing
   Seat          id, screenId, row, number, SeatCategory      (physical, permanent)
   ShowSeat      showId, seatId, status, holderId?, holdExpiresAt?, bookingId?
   Hold          id, showId, seatIds[], userId, expiresAt
   Booking       id, showId, seatIds[], userId, Money amount, status, paymentId
   Payment       bookingId, amount, status, gatewayRef, idempotencyKey

   enum SeatStatus  { AVAILABLE, HELD, BOOKED }
   enum BookingStatus { PENDING, CONFIRMED, CANCELLED, EXPIRED }
```

The decision to narrate:

> "`Seat` is physical and permanent — row F, seat 12 of screen 3. `ShowSeat` is that seat *for one show*, and it's the thing with state. Modelling availability on `Seat` would be wrong the moment there are two shows on the same screen. This split is the whole data model."

## 3 · The seat state machine (12–18)

```diagram
                 hold (TTL 8 min)              confirm payment
   AVAILABLE ────────────────────▶  HELD  ─────────────────────▶  BOOKED
       ▲                             │                              │
       │      release / expire       │        cancel + refund       │
       └─────────────────────────────┴──────────────────────────────┘

   Legal transitions only. Every arrow is a conditional write:
     AVAILABLE → HELD    only if currently AVAILABLE
     HELD      → BOOKED  only if held *by this user* and not expired
     HELD      → AVAILABLE  on release, expiry, or payment failure
```

Everything correctness-related in this problem is that middle column: **a transition happens only if the current state is what you think it is.** That's compare-and-set, and it's the same sentence in memory and in SQL.

## 4 · The hold, in one process (18–26)

```java
class ShowSeat {
    private final AtomicReference<SeatState> state =
            new AtomicReference<>(SeatState.available());

    /** Exactly one of N racing callers gets true. */
    boolean tryHold(UserId user, Instant now, Duration ttl) {
        SeatState current = state.get();
        if (!current.isAvailableAt(now)) return false;        // BOOKED, or held & unexpired
        SeatState held = SeatState.heldBy(user, now.plus(ttl));
        return state.compareAndSet(current, held);            // loses cleanly if raced
    }

    boolean tryConfirm(UserId user, Instant now) {
        SeatState current = state.get();
        if (!current.isHeldBy(user, now)) return false;       // expired or not yours
        return state.compareAndSet(current, SeatState.booked(user));
    }
}
```

Note `isAvailableAt(now)`: an expired hold **is** availability. Expiry is evaluated lazily on read rather than depending on a timer having fired — a background sweeper then exists only to keep the seat map fresh for display, not for correctness. Say that distinction explicitly; it's the difference between a design that survives a dead scheduler thread and one that doesn't.

### Multi-seat holds: all or nothing

A user selecting four adjacent seats must get all four or none.

```java
class BookingService {
    HoldResult hold(ShowId showId, List<SeatId> requested, UserId user) {
        List<ShowSeat> seats = seatsFor(showId, sorted(requested));   // sorted = no deadlock
        List<ShowSeat> acquired = new ArrayList<>();

        for (ShowSeat seat : seats) {
            if (seat.tryHold(user, clock.instant(), HOLD_TTL)) {
                acquired.add(seat);
            } else {
                acquired.forEach(ShowSeat::release);      // compensate, then fail
                return HoldResult.unavailable(seat.id());
            }
        }
        Hold hold = Hold.create(showId, requested, user, clock.instant().plus(HOLD_TTL));
        holds.save(hold);
        return HoldResult.ok(hold);
    }
}
```

Two things to say while writing it: **sort the seat IDs** so concurrent multi-seat holds acquire in the same order (no circular wait), and **the rollback loop is a compensating action** — the LLD-scale version of a saga. See [Distributed Transactions](../distributed/distributed-transactions.html).

## 5 · Payment and idempotency (26–33)

```viz
{
  "type": "steps",
  "caption": "The booking flow. Every step is retry-safe.",
  "note": "The hold is what makes payment latency safe: the user has 8 minutes, and the seats can't vanish underneath them.",
  "steps": [
    { "label": "1 · Hold", "sub": "CAS seats to HELD, TTL 8 min. Return hold id." },
    { "label": "2 · Create booking", "sub": "PENDING, amount computed, idempotency key issued." },
    { "label": "3 · Pay", "sub": "Gateway charge, keyed by the idempotency key." },
    { "label": "4 · Confirm", "sub": "HELD → BOOKED for this holder. Booking CONFIRMED." },
    { "label": "5 · Or unwind", "sub": "Failure/timeout → release seats, booking EXPIRED." }
  ]
}
```

The three failure cases you should raise before being asked:

- **User abandons checkout.** The hold expires by TTL; seats become available on the next read. No cleanup required for correctness.
- **Payment succeeds but confirmation fails** (process crash between step 3 and 4). This is the dangerous one: money taken, no seats. The fix is that the payment carries the booking's **idempotency key**, and a reconciliation job re-drives any `PENDING` booking with a successful payment to `CONFIRMED` — or refunds it if the hold has since expired and the seats were resold. Say the word "reconciliation"; it's what real systems have and most candidates omit. See [Idempotency](../distributed/idempotency.html).
- **User double-clicks Pay.** The same idempotency key means the gateway charges once and the second call returns the first result.

:::goat The hold is the whole design
Without a hold, you either lock seats for the duration of a payment (which can take a minute, and users abandon) or you take the money and discover the seat is gone. The hold converts a distributed-transaction problem into a **short lease plus a compensating action** — a bounded window where the seat is neither free nor sold. Every ticketing, ride-hailing, and inventory system does some version of this. If you take one transferable idea from this page, take that one.
:::

## 6 · Now with five servers (33–40)

This is the pivot the interviewer is waiting for. `AtomicReference` lives in one JVM's heap; with a fleet, each server has its own copy and both sell the seat. The answer moves one layer down, and the *shape* is identical:

```sql
-- The same compare-and-set, expressed in the database.
UPDATE show_seats
   SET status = 'HELD', holder_id = :user, hold_expires_at = :now + interval '8 minutes'
 WHERE show_id = :show
   AND seat_id = :seat
   AND (status = 'AVAILABLE'
        OR (status = 'HELD' AND hold_expires_at < :now));   -- expired holds are available
-- Then check the affected row count. 1 = you got it. 0 = someone else did.
```

Four points to make, in this order:

1. **The row is the lock.** A single-statement conditional update is atomic in any relational database; you don't need a distributed lock for this, and saying so shows judgement. Wrap the multi-seat case in one transaction so it's all-or-nothing, and sort seat IDs to keep the row-lock order consistent.
2. **Partitioning is natural.** All state for a show is keyed by `show_id`, so shard by show. A single popular show is the hot partition, and it's bounded by the seat count — the "10k people, one seat" storm is a *read* storm, not a write storm.
3. **Reads and writes take different paths.** The seat map is served from cache with ~1s staleness and a "seats may have been taken" caveat in the UI; the booking write always goes to the primary. Optimistic display, authoritative write. See [Caching](../building-blocks/caching.html).
4. **Expiry at scale.** Lazy expiry in the `WHERE` clause keeps correctness independent of any sweeper. A periodic job then flips expired rows back to `AVAILABLE` purely so the cached seat map and analytics look right.

:::trap Don't reach for Redis locks first
A common answer is "I'd use a distributed lock in Redis". It works, but it's strictly more machinery than a conditional `UPDATE` on the row you were going to write anyway, and it adds failure modes: lease expiry mid-operation, clock skew, and the need for fencing tokens. Use a distributed lock when the resource *isn't* a row you can conditionally update. Mention that you know the difference — see [Distributed Locks](../building-blocks/distributed-locks.html).
:::

## 7 · Extensions

**"Add a queue for high-demand releases (concert on-sale)."**
> "A virtual waiting room: users get a queue token, admitted at a rate the booking tier can absorb. It protects the database from a 100× spike and makes the experience honest — 'you are number 4,120' beats a timeout. That's a pure HLD addition; no class in the booking model changes."

**"Different seat categories and dynamic pricing."**
> "Pricing is a strategy keyed on category and show — the same axis as every other problem here. `PricingStrategy.price(showSeat, whenBooked)` covers early-bird and surge without touching the seat machine."

**"Group bookings that must be adjacent."**
> "That's an allocation policy over the seat map: find a run of k contiguous available seats in a row. A per-row availability bitmap makes it a bit-scan, which is fast enough to do on every request."

**"Cancellations and refunds."**
> "`BOOKED → CANCELLED` releases the show-seats back to `AVAILABLE` and issues a refund through the same idempotency-keyed payment path. The refund amount is a policy — another strategy, by time-to-showtime."

:::exercise The one to rehearse out loud
Set a timer for four minutes and answer only this: *"Two users click the last seat at the same instant. Walk me through what happens, on one server and then on five."* If you can do that cleanly, in order, naming the invariant and the mechanism, you have the most valuable ninety seconds of this entire section rehearsed.
:::
