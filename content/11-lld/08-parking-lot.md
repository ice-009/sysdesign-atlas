---
title: Design a Parking Lot
summary: The most-asked LLD question, worked end to end in the 45-minute structure — classes, allocation, pricing, the threading answer, and the four extensions interviewers really ask for.
difficulty: Medium
scope: LLD
tags: [lld-problem, strategy, entities, concurrency]
prereqs: [lld-interview-method, concurrency-in-lld]
unlocks: A rehearsed answer to the most common LLD problem, and a template that transfers to any "limited resource" system.
---

:::predict Guess first
1. Car, Bike and Truck differ only in the size of space they need. One subclass each, or something simpler?
2. With 2,000 spaces, how would you find a free one without checking every space?
3. Two cars reach the last free space at the same moment. What stops both getting it — without locking the whole car park?
:::

If you rehearse one LLD problem, rehearse this one. It comes up constantly, and its shape — hand out a limited resource, track it, charge for it, take it back — is the same shape as seat booking, hotel rooms, meeting rooms, cloud instances and library books.

:::interview What's really being tested
Whether you can break a problem into parts. There's no clever algorithm and no scale to reason about. They're watching whether your classes have clear jobs, whether you spot the things that vary, and whether you handle two cars racing for the last space.

Get to a working design by minute 25. The extensions decide the round.
:::

## 1 · Requirements (0–5)

**Ask first:** several floors? more than one entrance and exit? how is pricing worked out? which payment types? one machine, or several servers?

Assume the answers are: several floors, several gates, hourly pricing by vehicle size, cash and card, one machine for now.

**What it must do**
- A vehicle arrives at an entry gate, gets a ticket, and is given a space that fits it.
- On leaving, the fee is worked out from the time parked and paid; the space is freed.
- Spaces come in sizes; a vehicle needs one at least as big as itself.
- Display boards show how many spaces are free, by size and floor.

**Qualities that shape the design**
- **No space is ever given to two vehicles.** This is the one hard rule.
- Finding a space must not mean checking every space in the building.
- Pricing and allocation rules will change, and adding one must not mean editing what already works.

**Out of scope, and say so:** reservations, number-plate recognition, an admin UI, reporting.

## 2 · Classes (5–10)

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

Narrate these two decisions while you write, because they're the ones being marked:

- **No `Car`, `Bike`, `Truck` subclasses.** They'd differ only by the size of space they need, and an enum says that without three extra classes. *"If trucks later need special behaviour — a loading bay rule, say — I'd subclass then."*
- **`Money`, never `double`.** A small, avoidable mistake: `0.1 + 0.2` isn't `0.3` in binary floating point, and money bugs are the kind nobody forgives.

## 3 · Relationships (10–17)

```diagram
   ParkingLot   1 ──── *  Floor
   Floor        1 ──── *  ParkingSpot
   ParkingSpot  1 ──── 0..1 Ticket        occupied ⇔ has a live ticket
   Ticket       * ──── 1  Vehicle
   Ticket       1 ──── 0..1 Payment
   ParkingLot   1 ──── *  Gate
```

Then say the lookup structures out loud — they follow from the arrows and they're cheap points:

```java
// Free spots grouped by size, so allocation never scans the building.
Map<SpotSize, TreeSet<ParkingSpot>> free;      // sorted by floor, then number
Map<String, Ticket> activeTickets;             // ticket id → ticket, O(1) at exit
Map<SpotSize, AtomicInteger> freeCounts;       // what the display boards read
```

*"Allocation takes the first entry from the smallest suitable size — O(log n). Checkout is a map lookup — O(1). Nothing on the busy path walks the whole car park."*

## 4 · Interfaces and the service (17–27)

Three things vary, and all three were named in the requirements:

```java
/** Varies 1: which free space to hand out. */
interface SpotAllocationStrategy {
    Optional<ParkingSpot> allocate(VehicleSize size, Gate entry);
}
class NearestToEntranceAllocator implements SpotAllocationStrategy { }
class LowestFloorFirstAllocator implements SpotAllocationStrategy { }

/** Varies 2: what it costs. */
interface PricingStrategy {
    Money price(Ticket ticket, Instant exitTime);
}
class HourlyPricing implements PricingStrategy { }            // round up, minimum one hour
class ProgressiveHourlyPricing implements PricingStrategy { } // ₹20 first hour, ₹10 after
class FlatDayPricing implements PricingStrategy { }

/** Varies 3: how the money moves. */
interface PaymentProcessor {
    PaymentResult charge(Money amount, PaymentDetails details);
}
class CashProcessor implements PaymentProcessor { }
class CardProcessor implements PaymentProcessor { }
```

And the class that coordinates them:

```java
class ParkingLotService {
    private final SpotAllocationStrategy allocator;
    private final PricingStrategy pricing;
    private final PaymentProcessor payments;
    private final TicketRepository tickets;
    private final SpotRepository spots;
    private final Clock clock;                    // passed in, so tests can control time

    Ticket park(Vehicle vehicle, Gate entry) {
        ParkingSpot spot = allocator.allocate(vehicle.size(), entry)
                .orElseThrow(() -> new LotFullException(vehicle.size()));
        if (!spot.tryOccupy()) {                  // lost a race for this spot
            return park(vehicle, entry);          // try again, next spot
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

:::tip Passing in the clock
Taking a `Clock` instead of calling `Instant.now()` inside the class lets you test "parked for three hours and one minute" without waiting three hours. It's a two-word change, and interviewers who write tests notice it every time.
:::

## 5 · Walk it through (27–33)

> "A compact car arrives at gate 2. `park` asks the allocator for a space; the nearest-to-entrance allocator takes the closest free `MEDIUM` spot — O(log n) — and returns spot 3-14. We flip its status from free to occupied in one atomic step; if another car got there first, we recurse and take the next one. We issue a ticket stamped with the current time, save it, and the display board counts down.
>
> Three hours later at the exit, `unpark` finds the ticket in O(1). Progressive pricing gives ₹20 + 2×₹10 = ₹40. The card processor charges it, the ticket closes, and the space goes back into the free set. If the payment fails, the ticket stays open and the space stays occupied — the car doesn't leave without paying."

Notice what that last sentence does: it settles the failure behaviour before anyone asks.

## 6 · Extensions (33–40)

Rehearse these four. They're the ones that come up.

**"Add electric vehicles with charging points."**
> "A space gains a capability rather than a subclass: a `Set<Feature>` or a simple `hasCharger` flag, and a vehicle can require features. The allocator filters on that — a change inside one strategy. Charging cost is a wrapper around the existing pricing: `new ChargingSurcharge(hourlyPricing)`. Nothing existing gets edited."

**"Add monthly passes and reserved spaces."**
> "A `Subscription` class: plate, validity, optionally a reserved space. At entry the service checks for one first, and reserved spaces stay out of the general pool. A pass holder's pricing is a `SubscriptionPricing` that returns zero for covered time. The interesting question is what happens when someone else parks in a reserved space — I'd allow it and charge a penalty, since you can't physically stop them."

**"Several entrances, and the boards must stay right."**
> "Allocation already handles it — the allocator takes the entry gate. The boards become listeners: the service publishes `SpotOccupied` and `SpotReleased`, and each board updates its own counters. That keeps display logic out of the parking flow, and a mobile app is just one more listener."

**"Now it runs on five servers."**
> "In-memory atomics stop working, because each server has its own copy. Occupancy moves into shared storage: `UPDATE spots SET status='OCCUPIED', ticket_id=? WHERE id=? AND status='FREE'`, then check how many rows changed — the same compare-and-set, one layer down. The free-space index becomes a query or a Redis sorted set per size. That's the only part that changes; the strategies and the classes don't."

## 7 · Threads, if it hasn't come up yet

The shared, changing data is exactly one thing: **whether a space is taken**. The rule: one live ticket per space.

```java
class ParkingSpot {
    private final AtomicReference<SpotStatus> status = new AtomicReference<>(FREE);
    boolean tryOccupy() { return status.compareAndSet(FREE, OCCUPIED); }
    void release()      { status.set(FREE); }
}
```

*"No lock on the whole car park — that would let one car in at a time. The atomic swap means exactly one of several racing cars wins a given space, and the losers simply take the next one. The set of free spaces needs to be a concurrent collection, so `ConcurrentSkipListSet` per size."* More in [Threads and races](concurrency-in-lld.html).

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

   Classes:  ParkingLot → Floor → ParkingSpot ─0..1─ Ticket ─0..1─ Payment
                                       ▲
                                    Vehicle (plate, VehicleSize)
```

:::goat What this problem is really checking
Four things, in order. Did you spot what varies, or hard-code pricing into checkout? Did you avoid a class per vehicle type? Does finding a space avoid scanning? Can two cars race for the last one?

Everything else — display boards, gate types, receipt formats — is scenery. Spend your minutes on the four.
:::

:::exercise Prove it transferred
Redesign the same skeleton as a **hotel booking system**: rooms instead of spaces, room types instead of sizes, reservations instead of tickets, nightly rates instead of pricing, room assignment instead of allocation.

It should take about ten minutes. If it doesn't, you've memorised this answer rather than the method.
:::

## Check yourself

```recall
Q: What shape makes the parking lot transfer to other problems?
A: Hand out a limited resource, track it, charge for it, take it back — the same shape as seat booking, hotel rooms, meeting rooms and library books.

Q: How do you model vehicle types?
A: One Vehicle with a VehicleSize enum, not Car, Bike and Truck subclasses that differ only by a size; subclass later only if behaviour differs.

Q: Which lookup structures make the busy paths fast?
A: Free spots in a Map<SpotSize, TreeSet<Spot>> sorted by floor (O(log n) allocation), active tickets in a Map by ID (O(1) checkout), and per-size atomic counters for the display boards.

Q: Which three things vary, and how?
A: Spot allocation (nearest to entrance, lowest floor), pricing (hourly, progressive, flat day) and payment (cash, card) — each behind an interface injected into ParkingLotService.

Q: Why pass a Clock into the service?
A: So tests can control time — "parked three hours and one minute" — without waiting or depending on Instant.now().

Q: What happens if payment fails at the exit?
A: The ticket stays open and the space stays occupied; the car doesn't leave without paying. Saying this settles failure behaviour before anyone asks.

Q: How do you add EV charging without editing existing code?
A: A capability on the space (a feature set or hasCharger flag) that the allocator filters on, and a ChargingSurcharge decorator wrapping the existing pricing.

Q: How does the race answer change with five servers?
A: Occupancy moves into shared storage: UPDATE spots SET status = 'OCCUPIED' WHERE id = ? AND status = 'FREE', then check rows changed — the same compare-and-set one layer down. The free index becomes a query or Redis sorted set.
```

## What to carry forward

- Limited resource: allocate, track, charge, release — a template for many LLD problems.
- A size enum instead of vehicle subclasses; Money instead of double.
- Allocation, pricing and payment vary, so each sits behind an interface.
- The one shared rule — one live ticket per space — is a compare-and-set on spot status.
- Rehearse the four extensions: EV charging, passes, several gates with boards as listeners, and many servers.
