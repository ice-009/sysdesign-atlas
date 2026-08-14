---
title: The 45-Minute LLD Method
summary: A minute-by-minute structure for an LLD round — requirements, entities, relationships, interfaces, method signatures, a walkthrough, and the extension question — plus what to do when you're stuck.
difficulty: Medium
tags: [framework, interview, lld, structure]
prereqs: [design-patterns]
unlocks: A repeatable sequence that gets you to a complete class design with time left for the follow-ups.
---

The [HLD framework](../appendix/framework.html) has an equivalent here, and it matters more: LLD rounds have no natural structure, so unstructured candidates produce a scattered pile of classes and never get to the part that scores.

```viz
{
  "type": "steps",
  "caption": "Default shape of a 45-minute LLD round. Announce it in the first minute.",
  "note": "The extension question at minute 35 is the real exam. Everything before it is setup.",
  "steps": [
    { "label": "0–5 · Requirements", "sub": "Clarify, list use cases, cut scope explicitly." },
    { "label": "5–10 · Entities", "sub": "The nouns, their fields, and the enums." },
    { "label": "10–17 · Relationships", "sub": "has-a / is-a, multiplicity, who owns whom." },
    { "label": "17–27 · Interfaces + classes", "sub": "Axes of variation, the service layer, signatures." },
    { "label": "27–33 · Walkthrough", "sub": "One end-to-end operation through your objects." },
    { "label": "33–40 · Extension + concurrency", "sub": "The follow-ups. Where seniority shows." },
    { "label": "40–45 · Gaps and tests", "sub": "What you'd add with more time; how you'd test it." }
  ]
}
```

## 0–5 · Requirements

Do not draw yet. Ask three to five questions, then state the use cases as a list. The questions that pay for themselves in almost any LLD prompt:

- **Scope:** "Is this a single-instance system, or do multiple servers share state?" (This decides whether the concurrency answer is locks or a database.)
- **Actors:** "Who uses it — one user type, or several with different permissions?"
- **Variation:** "Should I assume the pricing/matching/notification rules will change?" (They'll say yes. Now your strategy interfaces are *requested*, not decorative.)
- **Persistence:** "In-memory is fine for this, or do you want the storage layer designed too?"
- **Scale:** "Roughly how many X?" — one question only, and only to justify data-structure choices.

Then say the scope cut out loud: *"I'll design ticketing, spot allocation, and fee calculation. I'll leave out authentication, the admin dashboard, and reporting unless you want them."*

:::interview Open with the plan
"Let me spend five minutes on requirements, then list the core entities, then the class relationships and interfaces — I'd like a working design by minute 25 so we have time for extensions. Stop me whenever."

Same fifteen seconds as the HLD round, same effect: it makes everything afterwards look deliberate.
:::

## 5–10 · Entities — the noun pass

Read your use-case list and underline the nouns. That's your first draft of the class list, and it's almost always 80% right.

> *"A **vehicle** enters the **parking lot** and takes a **ticket** at an **entrance gate**. The **spot** is assigned by size. On leaving, the **exit gate** computes a **fee** and takes a **payment**."*

Entities: `Vehicle`, `ParkingLot`, `Ticket`, `Gate`, `ParkingSpot`, `Fee`/`Money`, `Payment`. Write them as a column with two or three fields each. Don't write methods yet — you'll invent responsibilities you don't need.

Two refinements that take one minute and make the list look considered:

- **Collapse near-duplicates.** `Car`, `Bike`, `Truck` → `Vehicle` + `VehicleSize` enum. (See [OOP](oop-refresher.html).)
- **Promote value objects.** `double amount` → `Money`. `LocalDateTime in, out` → `TimeSlot`. Immutable, self-validating, thread-safe for free.

## 10–17 · Relationships — the arrow pass

Now connect them, out loud, in "has-a" sentences with multiplicity. This is the step candidates skip and it's where most design errors are caught cheaply:

```diagram
   ParkingLot  1 ──── * Floor
   Floor       1 ──── * ParkingSpot
   ParkingSpot 0..1 ── 1 Ticket        (occupied ⇔ has an active ticket)
   Ticket      * ──── 1 Vehicle
   Ticket      1 ──── 0..1 Payment
```

Ask of each arrow: **who owns the lifecycle?** (Deleting a floor deletes its spots; deleting a ticket must not delete the vehicle.) And: **which direction do you need to navigate?** Bidirectional links are a maintenance cost — keep the one you'll actually traverse.

This is also where you state your **key lookup structures**, because they follow from the arrows: *"I'll keep a `Map<SpotSize, TreeSet<Spot>>` of free spots so allocation is O(log n) rather than a scan."*

## 17–27 · Interfaces and the service layer

Three moves, in order:

**1. Find the axes of variation** and put interfaces there — the "different/depending on/configurable" words from the requirements. Typically one to three: pricing, allocation, payment, notification.

**2. Add the service/manager class** that orchestrates the entities. This is the object with the use cases on it, and it's the one place with the transaction-like logic:

```java
class ParkingLotService {
    private final SpotAllocator allocator;     // interface: nearest / random / level-first
    private final ParkingFeeStrategy pricing;  // interface
    private final TicketRepository tickets;    // interface

    Ticket park(Vehicle v, Gate entry) { /* allocate, create ticket, persist */ }
    Receipt unpark(String ticketId, PaymentMethod m) { /* price, charge, free spot */ }
}
```

**3. Write the signatures of the two or three most important methods.** Not bodies — signatures. What goes in, what comes out, what it throws. Interviewers read a lot from a signature: `Ticket park(Vehicle, Gate)` says you thought about who's calling; `void park(String, String, int, boolean)` says you didn't.

:::tip Return types carry information
`Optional<Spot> findFreeSpot(VehicleSize)` says a full lot is a normal outcome, not an exception. `Result<Booking, BookingError>` (or a checked exception) says failures are part of the contract. Choosing deliberately between "returns empty", "returns a result object", and "throws" — and saying why — is a cheap, strong signal.
:::

## 27–33 · Walk one operation end to end

Pick the most important use case and trace it through your objects, naming every call. This is the LLD equivalent of narrating a request through the architecture, and it does two jobs: it proves the design works, and it exposes the missing class you didn't notice.

> "`park(vehicle)` on the service. It asks the `SpotAllocator` for a free spot of the right size — that's a `TreeSet` poll, so O(log n). It marks the spot occupied, creates a `Ticket` with entry time, saves it via the repository, and returns it. If no spot is free, the allocator returns empty and the service throws `LotFullException`, which the gate turns into a display message."

Say the complexity of anything non-trivial as you pass it. Say what happens on the unhappy path. Those two habits alone separate the top quartile.

## 33–40 · The extension question — this is the exam

They will ask for a change. Common ones: *"add electric charging spots", "add a monthly pass", "support multiple entrances", "add a valet", "make pricing time-of-day dependent".*

The answer has a shape:

1. **Name where it lands.** "That's a pricing change, so it's a new `PricingStrategy` implementation."
2. **Name what does *not* change.** "The gate, the ticket, and the allocator are untouched."
3. **Be honest if it does hurt.** "Multiple entrances is harder — my `Ticket` assumes one gate, so I'd add a `gateId` and make the allocator entrance-aware. That's a real change, but contained to two classes."

That third move — admitting a change is invasive and scoping it precisely — scores higher than pretending your design absorbs everything.

Concurrency almost always follows. Have the answer ready: what's shared, what guards it, and what happens under contention. [Concurrency in LLD](concurrency-in-lld.html) is the whole page on it.

## 40–45 · Close deliberately

Don't trail off. Spend the last three minutes on:

- **Known gaps.** "I've kept persistence behind a repository and not designed the schema — with more time I'd do that, plus the admin flows I cut."
- **Testing.** "Everything is constructor-injected, so I'd unit-test the fee strategies in isolation with fixed clocks, and test the service against in-memory repositories. The interesting test is two threads parking into the last spot."
- **One thing you'd revisit.** Naming your own weakest decision is a strength signal, not a confession.

## When you get stuck

```viz
{
  "type": "flow",
  "caption": "Unsticking, in order of what to try.",
  "nodes": [
    { "id": "n", "label": "List nouns", "sub": "entities from the prompt" },
    { "id": "v", "label": "List verbs", "sub": "use cases → methods" },
    { "id": "a", "label": "What varies?", "sub": "→ interfaces" },
    { "id": "w", "label": "Walk a use case", "sub": "the gap appears" }
  ],
  "edges": [
    { "from": "n", "to": "v" },
    { "from": "v", "to": "a" },
    { "from": "a", "to": "w" }
  ]
}
```

And say what you're doing while you do it. Silence reads as being lost; *"let me walk the booking flow through these classes and see what's missing"* reads as method.

:::warn The three time sinks
**Perfect naming** — pick a decent name and move on; you can rename in ten seconds if challenged. **Full method bodies** — you were asked for a design, not an implementation; write bodies only for the one or two algorithmically interesting methods. **Database schemas** — unless asked, a repository interface is enough. Each of these has cost candidates the extension question, which is the part that decides the round.
:::
