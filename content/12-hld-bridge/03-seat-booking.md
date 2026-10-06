---
title: Design Seat Booking (BookMyShow)
summary: The problem that spans both rounds — seat states, temporary holds that expire, the payment flow, and the exact moment an in-memory answer stops working.
difficulty: Medium
scope: Both
tags: [lld-problem, concurrency, state-machine, hld-bridge]
prereqs: [concurrency-in-lld, splitwise, idempotency]
unlocks: Answering the double-booking question at both zoom levels, and knowing when the simple answer runs out.
---

:::predict Guess first
1. The same cinema screen has three showings a day. Where should "this seat is taken" be stored — on the seat, or somewhere else?
2. A user selects seats and then takes three minutes to pay. What stops someone else buying those seats meanwhile — and what if they close the laptop?
3. With five servers, do you need a distributed lock in Redis to stop double-booking?
:::

Ask for this one if you get a choice. It's where LLD and HLD meet: the class design is small, but the interesting part — two people, one seat — stays interesting all the way up to a distributed system. It's also the likeliest place to be asked *"and now with five servers?"*, so it's the best rehearsal for that switch.

## 1 · Requirements (0–5)

**Ask first:** how many seats per show — hundreds, or a 100,000-seat stadium? Do we hold seats while the user pays, or is booking one atomic step? One server or several? Assigned seats or general admission?

Assume: cinema-sized shows, hold-then-pay, and "start with one machine, then let's scale it".

**What it must do**
- Browse cities → cinemas → shows → a seat map showing what's free.
- Select seats and **hold** them for a few minutes while paying.
- Pay → the hold becomes a booking. Fail or run out of time → the seats go back.
- Cancel a booking, with a refund rule.

**Qualities that shape the design**
- **A seat is sold at most once.** This is the rule; everything else is negotiable.
- Holds must expire even if the user closes their laptop mid-checkout.
- The seat map is read far more than it's written and can be a second out of date — but the booking decision itself cannot.

**Out of scope:** pricing engines, recommendations, the payment provider's internals.

## 2 · Classes (5–12)

```diagram
   City · Cinema · Screen        the catalogue, rarely changes
   Show          id, movieId, screenId, startsAt, pricing
   Seat          id, screenId, row, number, category      (physical, permanent)
   ShowSeat      showId, seatId, status, holderId?, holdExpiresAt?, bookingId?
   Hold          id, showId, seatIds[], userId, expiresAt
   Booking       id, showId, seatIds[], userId, Money amount, status, paymentId
   Payment       bookingId, amount, status, gatewayRef, idempotencyKey

   enum SeatStatus    { AVAILABLE, HELD, BOOKED }
   enum BookingStatus { PENDING, CONFIRMED, CANCELLED, EXPIRED }
```

The decision to narrate:

> "`Seat` is the physical chair — row F, seat 12 of screen 3. It never changes. `ShowSeat` is that chair *for one particular show*, and that's the thing with a status. Putting availability on `Seat` would break the moment the same screen has two showings in a day. This split is the whole data model."

## 3 · The seat's states (12–18)

```diagram
                 hold (expires in 8 min)        payment confirmed
   AVAILABLE ────────────────────────▶  HELD  ─────────────────────▶  BOOKED
       ▲                                  │                             │
       │      released, or expired        │      cancelled + refunded   │
       └──────────────────────────────────┴─────────────────────────────┘

   Every arrow is a conditional change:
     AVAILABLE → HELD    only if it is currently AVAILABLE
     HELD      → BOOKED  only if held by *this* user, and not expired
     HELD      → AVAILABLE  on release, expiry, or failed payment
```

Everything correctness-related in this problem is that right-hand column: **a change happens only if the current state is what you thought it was.** That's compare-and-set, and it's the same sentence in memory and in SQL.

## 4 · Holding a seat, one server (18–26)

```java
class ShowSeat {
    private final AtomicReference<SeatState> state =
            new AtomicReference<>(SeatState.available());

    /** Exactly one of several racing callers gets true. */
    boolean tryHold(UserId user, Instant now, Duration ttl) {
        SeatState current = state.get();
        if (!current.isAvailableAt(now)) return false;        // booked, or held and still valid
        SeatState held = SeatState.heldBy(user, now.plus(ttl));
        return state.compareAndSet(current, held);            // loses cleanly if someone raced us
    }

    boolean tryConfirm(UserId user, Instant now) {
        SeatState current = state.get();
        if (!current.isHeldBy(user, now)) return false;       // expired, or not yours
        return state.compareAndSet(current, SeatState.booked(user));
    }
}
```

Notice `isAvailableAt(now)`: **an expired hold counts as available.** Expiry is judged when the seat is read, rather than depending on a timer having fired. A background sweeper then exists only to keep the displayed map tidy — not for correctness. Say that distinction out loud; it's the difference between a design that survives a dead scheduler thread and one that doesn't.

### Four seats together, or none

Someone picking four seats side by side must get all four or nothing.

```java
class BookingService {
    HoldResult hold(ShowId showId, List<SeatId> requested, UserId user) {
        List<ShowSeat> seats = seatsFor(showId, sorted(requested));   // sorted = no deadlock
        List<ShowSeat> acquired = new ArrayList<>();

        for (ShowSeat seat : seats) {
            if (seat.tryHold(user, clock.instant(), HOLD_TTL)) {
                acquired.add(seat);
            } else {
                acquired.forEach(ShowSeat::release);      // give back what we took, then fail
                return HoldResult.unavailable(seat.id());
            }
        }
        Hold hold = Hold.create(showId, requested, user, clock.instant().plus(HOLD_TTL));
        holds.save(hold);
        return HoldResult.ok(hold);
    }
}
```

Two things to say while writing it. **Sort the seat IDs**, so two people grabbing overlapping seats always take them in the same order and can't deadlock. And **the rollback loop is a compensating action** — undoing earlier steps by hand because there's no transaction spanning them. That's the small-scale version of a saga; see [Distributed Transactions](../distributed/distributed-transactions.html).

## 5 · Payment, and not charging twice (26–33)

```viz
{
  "type": "steps",
  "caption": "The booking flow. Every step is safe to retry.",
  "note": "The hold is what makes a slow payment safe: the user gets 8 minutes, and the seats can't vanish underneath them.",
  "steps": [
    { "label": "1 · Hold", "sub": "Flip seats to HELD for 8 minutes. Return a hold id." },
    { "label": "2 · Create booking", "sub": "PENDING, amount worked out, idempotency key issued." },
    { "label": "3 · Pay", "sub": "Charge the card, tagged with that key." },
    { "label": "4 · Confirm", "sub": "HELD → BOOKED for this holder. Booking CONFIRMED." },
    { "label": "5 · Or unwind", "sub": "Failure or timeout → release the seats, booking EXPIRED." }
  ]
}
```

An **idempotency key** is a unique string sent with a payment so that if the same request arrives twice, the provider charges once and returns the original result.

Three failure cases to raise before you're asked:

- **The user abandons checkout.** The hold expires; the seats are available again next time anyone reads them. No cleanup needed for correctness.
- **The payment succeeds but the confirmation doesn't** (the server dies between steps 3 and 4). This is the dangerous one: money taken, no seats. The fix is that the payment carries the booking's idempotency key, and a **reconciliation job** — a scheduled task that compares payments against bookings — either finishes the booking or refunds it if the seats were resold. Say the word "reconciliation"; real systems have one and most candidates never mention it. See [Idempotency](../distributed/idempotency.html).
- **The user double-clicks Pay.** Same key, so the provider charges once and the second call returns the first result.

:::goat The hold is the whole design
Without it you have two bad options: lock the seats for the entire payment (which can take a minute, and people abandon), or take the money and then discover the seat is gone.

The hold turns a hard distributed-transaction problem into **a short lease plus an undo** — a bounded window where a seat is neither free nor sold. Every ticketing, ride-hailing and inventory system does some version of this. If you take one transferable idea from this page, take that one.
:::

## 6 · Now with five servers (33–40)

This is the switch the interviewer is waiting for. `AtomicReference` lives in one program's memory; with five servers each has its own copy, and both sell the seat. The answer moves down a layer, and the *shape* is identical:

```sql
-- The same compare-and-set, written in SQL.
UPDATE show_seats
   SET status = 'HELD', holder_id = :user, hold_expires_at = :now + interval '8 minutes'
 WHERE show_id = :show
   AND seat_id = :seat
   AND (status = 'AVAILABLE'
        OR (status = 'HELD' AND hold_expires_at < :now));   -- an expired hold is available
-- Then check how many rows changed. 1 = you got it. 0 = someone else did.
```

Four points, in this order:

1. **The row is the lock.** A single conditional `UPDATE` is atomic in any relational database, so you don't need a separate distributed lock — and saying so shows judgement. Wrap the multi-seat case in one transaction, and keep sorting the IDs so rows are always locked in the same order.
2. **Splitting the data is natural.** Everything for a show is keyed by show, so split by show. One wildly popular show is a hot spot, but it's bounded by the number of seats — the "10,000 people, one seat" storm is a *read* storm, not a write storm.
3. **Reads and writes take different paths.** The seat map comes from a cache that may be a second stale, with a "seats may have gone" note in the UI; the booking write always goes to the real database. Optimistic display, authoritative write. See [Caching](../building-blocks/caching.html).
4. **Expiry at scale.** Judging expiry in the `WHERE` clause keeps correctness independent of any sweeper. A periodic job then flips expired rows back purely so the cached map and the analytics look right.

:::trap Don't reach for a Redis lock first
A common answer is "I'd take a distributed lock in Redis". It works, but it's more machinery than a conditional `UPDATE` on the row you were about to write anyway, and it adds failure modes: the lease can expire mid-operation, clocks drift, and you need fencing tokens to be safe.

Use a distributed lock when the thing you're protecting *isn't* a row you can conditionally update. Showing you know the difference is the point. See [Distributed Locks](../building-blocks/distributed-locks.html).
:::

## 7 · Extensions

**"Add a queue for a big on-sale."**
> "A virtual waiting room. Users get a place in line and are let in at a rate the booking tier can handle. It protects the database from a 100× spike and it's more honest than a spinning wheel — 'you are number 4,120' beats a timeout. That's a pure HLD addition; no class in the booking model changes."

**"Different seat categories and dynamic pricing."**
> "Pricing is a strategy keyed on category and show — the same 'thing that varies' as in every other problem here. Early-bird and surge pricing become new implementations without touching the seat logic."

**"Group bookings that must be together."**
> "That's a rule about which seats to offer: find a run of k free seats in one row. A bitmap per row makes that a fast bit-scan, cheap enough to do on every request."

**"Cancellations and refunds."**
> "`BOOKED → CANCELLED` puts the show-seats back to available and issues a refund through the same idempotency-keyed path. How much you refund is a policy — another strategy, based on how close to showtime it is."

:::exercise The ninety seconds to rehearse out loud
Set a four-minute timer and answer only this: *"Two users click the last seat at the same instant. Walk me through what happens — first on one server, then on five."*

If you can do that cleanly and in order, naming the rule and the mechanism, you have the single most valuable answer in this whole section ready to go.
:::

## Check yourself

```recall
Q: Seat versus ShowSeat?
A: Seat is the permanent physical chair; ShowSeat is that chair for one show and carries the status. Putting availability on Seat breaks as soon as a screen has two showings.

Q: What rule governs every seat state change?
A: Compare-and-set: AVAILABLE → HELD only if still available, HELD → BOOKED only if held by this user and unexpired. The same idea in memory and in SQL.

Q: How do holds expire without depending on a timer?
A: An expired hold counts as available whenever the seat is read (in code or in the WHERE clause). A background sweeper only tidies the displayed map.

Q: How do you hold four seats as all-or-nothing?
A: Sort the seat IDs so overlapping requests lock in the same order (no deadlock), take each with compare-and-set, and on any failure release those already taken — a compensating action.

Q: Why is the hold the whole design?
A: It turns a hard distributed transaction into a short lease plus an undo: seats can't vanish during payment, and abandoned checkouts free themselves.

Q: What if payment succeeds but confirmation never happens?
A: The payment carries the booking's idempotency key, and a reconciliation job compares payments with bookings — finishing the booking or refunding if the seats were resold.

Q: How does the race answer change with five servers?
A: One conditional UPDATE … WHERE status = 'AVAILABLE' OR the hold has expired, then check rows changed. The row is the lock; use a transaction and sorted IDs for several seats.

Q: How do reads and writes differ at scale?
A: The seat map comes from a cache that may be a second stale, with a "may have gone" note; the booking write always goes to the database. Shard by show; a big on-sale gets a virtual waiting room.
```

## What to carry forward

- Separate the permanent seat from the per-show seat that carries status.
- Every transition is a conditional change; the same sentence works in memory and SQL.
- Holds are leases judged at read time — no correctness depends on a sweeper.
- Idempotency keys plus reconciliation cover the "charged but not booked" gap.
- Prefer a conditional UPDATE on the row to a distributed lock.
