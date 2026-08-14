---
title: Design a Parking Lot
summary: The canonical LLD question, worked end to end in the 45-minute structure — entities, allocation strategy, pricing strategy, the concurrency answer, and the four extensions interviewers actually ask for.
difficulty: Medium
tags: [lld-problem, strategy, entities, concurrency]
prereqs: [lld-interview-method, concurrency-in-lld]
unlocks: A rehearsed answer to the most-asked LLD problem, and a template that transfers to any bounded-resource system.
---

If you only rehearse one LLD problem, rehearse this one. It's asked constantly, and its shape — allocate a scarce resource, track it, price it, release it — is the same shape as seat booking, hotel rooms, EC2 instances, meeting rooms, and library books.

:::interview Why this question
It's a filter for whether you can decompose. There's no algorithmic trick, no scale to reason about — just whether your objects have clear jobs, whether you find the axes of variation, and whether you handle two cars racing for the last spot. Get to a working design by minute 25; the extensions decide the round.
:::

## 1 · Requirements (0–5)

**Ask first:** multi-floor? multiple entrances/exits? pricing model? payment types? single instance or several servers?

Assume the answers are: multi-floor, several gates, hourly pricing by vehicle size, cash and card, single instance for now.

**Functional**
- A vehicle enters at an entry gate, gets a ticket, and is assigned a spot that fits it.
- On exit, the fee is computed from the parked duration and paid; the spot frees.
- Spots come in sizes; vehicles need a spot of at least their size.
- Display boards show free counts per size, per floor.

**Non-functional**
- No spot is ever double-assigned (the only hard invariant).
- Allocation and checkout are O(log n) or better — no scanning every spot.
- Pricing rules and allocation policy will change; adding either must not edit existing classes.

**Out of scope (say it):** reservations, licence-plate recognition, an admin UI, reporting.

## 2 · Entities (5–10)

```diagram
   ParkingLot      id, name, floors[]
   Floor           number, spots[], DisplayBoard
   ParkingSpot     id, size, status, currentTicketId?
   Vehicle         licensePlate, VehicleSize
   Ticket          id, spotId, plate, entryTime, gateId, status
   Payment         ticketId, Money amount, method, paidAt, txnId
   Gate            id, type (ENTRY | EXIT)

   enum VehicleSize { MOTORCYCLE, COMPACT, LARGE }
   enum SpotSize    { SMALL, MEDIUM, LARGE }
   enum SpotStatus  { FREE, OCCUPIED, OUT_OF_SERVICE }
```

Two decisions to narrate while writing this, because they're the ones being graded:

- **No `Car`/`Bike`/`Truck` subclasses.** They'd differ only by required size, and an enum expresses that without three classes. *"If trucks later need behaviour — a loading-bay rule, say — I'd subclass then."*
- **`Money`, not `double`.** Immutable value object over minor units. Floating-point money in an interview is a small, avoidable ding.

## 3 · Relationships (10–17)

```diagram
   ParkingLot   1 ──── *  Floor
   Floor        1 ──── *  ParkingSpot
   ParkingSpot  1 ──── 0..1 Ticket        (occupied ⇔ has an active ticket)
   Ticket       * ──── 1  Vehicle
   Ticket       1 ──── 0..1 Payment
   ParkingLot   1 ──── *  Gate
```

And the lookup structures the arrows imply — say these explicitly, they're cheap points:

```java
// Free spots by size, so allocation never scans.
Map<SpotSize, TreeSet<ParkingSpot>> free;      // ordered by (floor, spotNumber)
Map<String, Ticket> activeTickets;             // ticketId → ticket, O(1) checkout
Map<SpotSize, AtomicInteger> freeCounts;       // display boards read this
```

*"Allocation is a `pollFirst` on the smallest sufficient size — O(log n). Checkout is a map lookup — O(1). Nothing in the hot path scans the lot."*

## 4 · Interfaces and services (17–27)

Three axes of variation, all named in the requirements:

```java
/** Axis 1: which free spot to hand out. */
interface SpotAllocationStrategy {
    Optional<ParkingSpot> allocate(VehicleSize size, Gate entry);
}
class NearestToEntranceAllocator implements SpotAllocationStrategy { }
class LowestFloorFirstAllocator implements SpotAllocationStrategy { }

/** Axis 2: what it costs. */
interface PricingStrategy {
    Money price(Ticket ticket, Instant exitTime);
}
class HourlyPricing implements PricingStrategy { }          // ceil to the hour, min 1
class ProgressiveHourlyPricing implements PricingStrategy { } // 1st hour ₹20, then ₹10
class FlatDayPricing implements PricingStrategy { }

/** Axis 3: how money moves. */
interface PaymentProcessor {
    PaymentResult charge(Money amount, PaymentDetails details);
}
class CashProcessor implements PaymentProcessor { }
class CardProcessor implements PaymentProcessor { }
```

The service that orchestrates them:

```java
class ParkingLotService {
    private final SpotAllocationStrategy allocator;
    private final PricingStrategy pricing;
    private final PaymentProcessor payments;
    private final TicketRepository tickets;
    private final Clock clock;                    // injected — testable time

    Ticket park(Vehicle vehicle, Gate entry) {
        ParkingSpot spot = allocator.allocate(vehicle.size(), entry)
                .orElseThrow(() -> new LotFullException(vehicle.size()));
        if (!spot.tryOccupy()) {                  // CAS; lost the race
            return park(vehicle, entry);          // retry with the next spot
        }
        Ticket ticket = Ticket.issue(spot, vehicle, clock.instant(), entry.id());
        tickets.save(ticket);
        spot.attach(ticket.id());
        return ticket;
    }

    Receipt unpark(String ticketId, PaymentDetails details) {
        Ticket ticket = tickets.findActive(ticketId)
                .orElseThrow(() -> new UnknownTicketException(ticketId));
        Money amount = pricing.price(ticket, clock.instant());
        PaymentResult result = payments.charge(amount, details);
        if (!result.successful()) throw new PaymentFailedException(result.reason());

        ticket.close(clock.instant(), result.transactionId());
        spots.byId(ticket.spotId()).release();    // back into the free set
        return new Receipt(ticket, amount, result.transactionId());
    }
}
```

:::tip The `Clock` injection
Passing a `Clock` instead of calling `Instant.now()` inside the class is a two-word change that lets you unit-test "parked for 3 hours 1 minute" without waiting three hours. Interviewers who write tests for a living notice it every time.
:::

## 5 · Walk it through (27–33)

> "A compact car arrives at gate 2. `park` asks the allocator for a spot; the nearest-to-entrance allocator polls the `MEDIUM` free set ordered by distance from gate 2 — O(log n) — and returns spot 3-14. We CAS its status from FREE to OCCUPIED; if another car beat us, we recurse and take the next one. We issue a ticket with entry time from the injected clock, persist it, and the display board decrements. Three hours later at the exit gate, `unpark` looks up the ticket in O(1), the progressive pricing strategy computes ₹20 + 2×₹10 = ₹40, the card processor charges it, the ticket closes, and the spot goes back into the free set. If the charge fails, the ticket stays open and the spot stays occupied — the car doesn't leave without paying."

Note what that last sentence does: it defines the failure behaviour before being asked.

## 6 · Extensions (33–40)

Rehearse these four — they're the ones that come up.

**"Add electric vehicles with charging spots."**
> "Spot gains a capability, not a subclass: a `Set<Feature>` (or a boolean `hasCharger`) plus a `Vehicle` that can require features. The allocator filters on required features — that's a change inside one strategy. Pricing for charging is a decorator over the existing strategy: `new ChargingSurcharge(hourlyPricing)`. No existing class is edited."

**"Add monthly passes / reserved spots."**
> "A `Subscription` entity (plate → validity, optionally a reserved spot). At entry, the service checks for an active subscription first; reserved spots are excluded from the general free pool. Pricing for a pass holder is a `SubscriptionPricing` strategy returning zero for covered time. The interesting question is what happens when someone parks in a reserved spot — I'd allow it and charge a penalty, since physically preventing it isn't possible."

**"Multiple entrances, and the display boards must stay accurate."**
> "Already handled for allocation — the allocator takes the entry gate. Boards are observers: the service publishes `SpotOccupied`/`SpotReleased` events and each board updates its counters. That keeps display logic out of the parking flow, and adding a mobile app is one more subscriber."

**"Now it runs on five servers."**
> "In-process CAS stops working, so occupancy has to move to shared state. `UPDATE spots SET status='OCCUPIED', ticket_id=? WHERE id=? AND status='FREE'` and check the affected row count — same compare-and-set, one layer down. The free-spot index becomes a query or a Redis sorted set per size. That's the only part of the design that changes; the strategies and entities are untouched."

## 7 · Concurrency, if not already covered

The shared state is exactly one thing: **spot occupancy**. The invariant: one active ticket per spot.

```java
class ParkingSpot {
    private final AtomicReference<SpotStatus> status = new AtomicReference<>(FREE);
    boolean tryOccupy() { return status.compareAndSet(FREE, OCCUPIED); }
    void release()      { status.set(FREE); }
}
```

*"No lock on the lot — that would serialise every entry. The CAS makes exactly one of N racing cars win a given spot, and the losers simply take the next one. The free-spot set itself needs to be concurrent, so a `ConcurrentSkipListSet` per size."* More: [Concurrency in LLD](concurrency-in-lld.html).

## The class diagram, compressed

```diagram
                        ┌────────────────────┐
                        │ ParkingLotService  │
                        └─────────┬──────────┘
        ┌─────────────────┬───────┴────────┬──────────────────┐
        ▼                 ▼                ▼                  ▼
 SpotAllocation      Pricing         Payment            TicketRepository
   Strategy          Strategy        Processor            (interface)
   (interface)      (interface)      (interface)
        │                 │                │
   Nearest /          Hourly /         Cash /
   LowestFloor        Progressive      Card
                      / FlatDay

   Entities:  ParkingLot → Floor → ParkingSpot ─0..1─ Ticket ─0..1─ Payment
                                        ▲
                                     Vehicle (plate, VehicleSize)
```

:::goat What this problem is really testing
Four things, in order: (1) did you find the axes of variation, or hard-code pricing into checkout; (2) did you avoid a subclass explosion for vehicle types; (3) does your allocation avoid scanning; (4) can two cars race for the last spot. Everything else — display boards, gate types, receipt formats — is scenery. Spend your minutes on the four.
:::

:::exercise Transfer it
Redesign the same skeleton for a **hotel booking system**: rooms (spots) of types (sizes), reservations (tickets), nightly rates (pricing strategy), and room assignment (allocation strategy). It should take you ten minutes, and if it doesn't, you've memorised the answer rather than the method.
:::
