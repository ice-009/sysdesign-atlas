---
title: The 45-Minute LLD Method
summary: What to do minute by minute in an LLD round — requirements, entities, relationships, interfaces, a walkthrough, and the "now add a feature" question that decides the result.
difficulty: Medium
scope: LLD
tags: [framework, interview, lld, structure]
prereqs: [design-patterns]
unlocks: A repeatable order of steps that gets you to a complete class design with time left over.
---

:::predict Guess first
1. In a 45-minute LLD round, at what minute should you have a complete design on the board?
2. Which part of the round do you think decides the result — the class list, the method bodies, or something later?
3. An interviewer asks for a feature your design genuinely can't absorb cleanly. Should you claim it fits anyway?
:::

An LLD round has no built-in structure. Nobody tells you to do requirements first. So candidates without a plan produce a scattered pile of classes and never reach the part that scores. Having an order fixes that, and it's most of what separates people who pass.

```viz
{
  "type": "steps",
  "caption": "A default shape for 45 minutes. Announce it in the first minute.",
  "note": "The \"now add a feature\" question at minute 35 is the real exam. Everything before it is setup.",
  "steps": [
    { "label": "0–5 · Requirements", "sub": "Ask, list the use cases, say what's out." },
    { "label": "5–10 · Entities", "sub": "The nouns, their fields, the enums." },
    { "label": "10–17 · Relationships", "sub": "Who has what, and how many." },
    { "label": "17–27 · Interfaces + service", "sub": "What varies, plus the class that runs the show." },
    { "label": "27–33 · Walkthrough", "sub": "One operation, traced through your objects." },
    { "label": "33–40 · Add a feature + threads", "sub": "The follow-ups. Where seniority shows." },
    { "label": "40–45 · Gaps and testing", "sub": "What you'd add next, and how you'd test it." }
  ]
}
```

## 0–5 · Requirements

Don't draw anything yet. Ask three to five questions, then read back the use cases as a list. Questions that pay for themselves in almost any LLD problem:

- **Scale of the design:** "Is this one machine, or do several servers share state?" This decides whether your threading answer is locks or a database.
- **Users:** "Is there one kind of user, or several with different permissions?"
- **What changes:** "Should I assume the pricing / matching / notification rules will change?" They'll say yes — and now your interfaces are *requested* rather than decorative.
- **Storage:** "Is in-memory fine, or do you want the storage layer designed too?"
- **Size:** "Roughly how many of these?" One question only, and only to justify a data-structure choice.

Then say the boundary out loud: *"I'll design ticketing, spot allocation and fee calculation. I'll leave out login, the admin dashboard and reporting unless you want them."*

:::interview Open with your plan
"Let me spend five minutes on requirements, then list the main classes, then relationships and interfaces. I'd like a working design by minute 25 so we have time for extensions. Stop me whenever."

Fifteen seconds, and everything afterwards looks deliberate rather than improvised.
:::

## 5–10 · Entities — the noun pass

Read your use cases and underline the nouns. That is your first list of classes, and it's usually 80% right.

> *"A **vehicle** enters the **parking lot** and takes a **ticket** at an **entrance gate**. A **spot** is assigned by size. On leaving, the **exit gate** works out a **fee** and takes a **payment**."*

Classes: `Vehicle`, `ParkingLot`, `Ticket`, `Gate`, `ParkingSpot`, `Money`, `Payment`. Write them in a column with two or three fields each. Don't add methods yet — you'll invent jobs nothing needs.

Two quick refinements that make the list look considered:

- **Merge near-duplicates.** `Car`, `Bike`, `Truck` → one `Vehicle` plus a `VehicleSize` enum.
- **Promote value objects.** `double amount` → `Money`. `LocalDateTime in, out` → `TimeSlot`. Unchangeable, self-checking, and safe to share between threads. See [Objects, in practice](oop-refresher.html).

## 10–17 · Relationships — the arrow pass

Now connect them out loud, in "has-a" sentences, with numbers attached. Candidates skip this step, and it's where design mistakes are cheapest to catch.

```diagram
   ParkingLot  1 ──── * Floor          one lot has many floors
   Floor       1 ──── * ParkingSpot    one floor has many spots
   ParkingSpot 0..1 ── 1 Ticket        a spot is taken ⇔ it has a live ticket
   Ticket      * ──── 1 Vehicle        many tickets over time, one vehicle each
   Ticket      1 ──── 0..1 Payment     a ticket may not be paid yet
```

Ask two things of every arrow. **Who owns the lifetime?** Deleting a floor should delete its spots; deleting a ticket must not delete the vehicle. **Which way will you actually navigate?** Links in both directions cost maintenance — keep the one you'll use.

This is also where you name your lookup structures, because they follow from the arrows: *"I'll keep free spots in a `Map<SpotSize, TreeSet<Spot>>` so finding one is O(log n) instead of scanning the building."*

## 17–27 · Interfaces and the service class

Three moves, in order.

**1. Find what varies** and put an interface there — the "different / depending on / configurable" words from the requirements. Usually one to three things: pricing, allocation, payment, notification.

**2. Add the service class** that runs the use cases. This is the object that coordinates the others:

```java
class ParkingLotService {
    private final SpotAllocator allocator;     // nearest, random or lowest floor
    private final ParkingFeeStrategy pricing;  // interface
    private final TicketRepository tickets;    // interface

    Ticket park(Vehicle v, Gate entry) { /* find spot, issue ticket, save */ }
    Receipt unpark(String ticketId, PaymentMethod m) { /* price, charge, free */ }
}
```

**3. Write the signatures of the two or three most important methods.** Not the bodies — the signatures. What goes in, what comes out, what can go wrong. Interviewers read a lot from these. `Ticket park(Vehicle, Gate)` says you thought about the caller. `void park(String, String, int, boolean)` says you didn't.

:::tip Return types say things
`Optional<Spot> findFreeSpot(VehicleSize)` says a full car park is a normal outcome, not an error. `Result<Booking, BookingError>` says failure is part of the contract. Choosing deliberately between "returns nothing", "returns a result object" and "throws" — and saying why — is a cheap, strong signal.
:::

## 27–33 · Walk one operation through

Pick the most important use case and trace it through your objects, naming each call. This does two jobs: it proves the design works, and it exposes the class you forgot.

> "`park(vehicle)` on the service. It asks the allocator for a free spot of the right size — that's a `TreeSet` poll, so O(log n). It marks the spot taken, creates a `Ticket` with the entry time, saves it, and returns it. If nothing is free, the allocator returns empty and the service throws `LotFullException`, which the gate turns into a message on the display."

Two habits while you narrate: **say the cost** of anything non-trivial ("that's O(log n)"), and **say what happens when it fails**. Together they put you in the top quartile.

## 33–40 · "Now add a feature" — this is the exam

They will ask for a change. Common ones: *add electric charging spots, add a monthly pass, support several entrances, add valet parking, make pricing depend on time of day.*

Answer in three parts:

1. **Where it lands.** "That's a pricing change, so it's a new `PricingStrategy` implementation."
2. **What does *not* change.** "The gate, the ticket and the allocator are untouched."
3. **Be honest when it does hurt.** "Several entrances is harder — my `Ticket` assumes one gate, so I'd add a `gateId` and make the allocator entrance-aware. That's a real change, but it's contained to two classes."

That third move — admitting a change is invasive and scoping it precisely — scores higher than pretending your design absorbs everything.

Threading questions almost always follow. Have the answer ready: what's shared, what protects it, what happens when two things collide. [Threads and races](concurrency-in-lld.html) is the whole page on it.

## 40–45 · Close on purpose

Don't trail off. Spend the last three minutes on:

- **Known gaps.** "I've hidden storage behind a repository rather than designing the schema. With more time I'd do that, plus the admin flows I cut."
- **Testing.** "Everything is passed in through constructors, so I'd test the fee strategies on their own with a fixed clock, and test the service against in-memory fakes. The interesting test is two threads taking the last spot."
- **One thing you'd revisit.** Naming your own weakest decision reads as confidence, not doubt.

## When you get stuck

```viz
{
  "type": "flow",
  "caption": "Unsticking, in the order to try it.",
  "nodes": [
    { "id": "n", "label": "List nouns", "sub": "classes from the problem" },
    { "id": "v", "label": "List verbs", "sub": "use cases → methods" },
    { "id": "a", "label": "What varies?", "sub": "→ interfaces" },
    { "id": "w", "label": "Walk a use case", "sub": "the gap shows up" }
  ],
  "edges": [
    { "from": "n", "to": "v" },
    { "from": "v", "to": "a" },
    { "from": "a", "to": "w" }
  ]
}
```

And narrate while you do it. Silence reads as being lost. *"Let me walk a booking through these classes and see what's missing"* reads as method.

:::warn Three ways to waste ten minutes
**Perfect names.** Pick a decent one and move on; renaming takes seconds if challenged.

**Full method bodies.** You were asked for a design. Write bodies only for the one or two genuinely interesting methods.

**Database schemas.** Unless asked, a repository interface is enough.

Each of these has cost candidates the "add a feature" question, which is the part that decides the round.
:::

## Check yourself

```recall
Q: Name the seven steps of the 45-minute LLD method.
A: Requirements (0–5), entities (5–10), relationships (10–17), interfaces and the service class (17–27), walk one operation through (27–33), add a feature and threads (33–40), gaps and testing (40–45).

Q: Which requirement questions pay off in almost any LLD problem?
A: One machine or many servers sharing state? One kind of user or several? Will pricing or matching rules change? In-memory or designed storage? Roughly how many? Then state what's out of scope.

Q: How do you find the first list of classes?
A: Underline the nouns in the use cases — usually 80% right. Merge near-duplicates (Car, Bike, Truck into Vehicle plus a size enum) and promote primitives to value objects such as Money and TimeSlot.

Q: What two questions do you ask of every relationship?
A: Who owns the lifetime (deleting a floor deletes its spots; deleting a ticket mustn't delete the vehicle)? Which way will you actually navigate? Lookup structures follow from the arrows.

Q: Why write method signatures, and what do return types say?
A: Interviewers read a lot from them: Ticket park(Vehicle, Gate) shows thought about the caller. Optional says "empty is normal", a Result type makes failure part of the contract, and throwing marks it exceptional.

Q: How do you answer "now add a feature"?
A: Say where it lands (a new strategy class), what doesn't change, and — if it does hurt — admit it and scope the change precisely to the classes affected.

Q: What wastes ten minutes in an LLD round?
A: Perfect names, full method bodies and database schemas nobody asked for — each has cost candidates the add-a-feature question that decides the round.
```

## What to carry forward

- Announce the plan in the first minute; aim for a working design by minute 25.
- Nouns become classes, has-a sentences with numbers become relationships, "depending on" words become interfaces.
- Walk one operation through out loud, saying the cost and what happens on failure.
- "Now add a feature" is the exam: where it lands, what stays untouched, and honesty about what hurts.
- Close on purpose: known gaps, how you'd test it, one decision you'd revisit.
