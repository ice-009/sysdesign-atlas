---
title: SOLID, Practically
summary: The five principles as they're actually used in an interview — what each one looks like when violated, the one-line fix, and the sentence that earns the point.
difficulty: Medium
tags: [solid, oop, lld, principles]
prereqs: [oop-refresher]
unlocks: Narrating your class design in the vocabulary interviewers are listening for, and spotting violations in your own diagram.
---

SOLID is not a checklist to recite. It's a **vocabulary for justifying decisions you were going to make anyway**, and that's exactly why it scores: it converts "this feels cleaner" into an argument. Learn each one as *smell → fix → sentence*.

```viz
{
  "type": "steps",
  "caption": "The five, in the order they matter in an LLD round.",
  "note": "SRP and OCP win most of the points. LSP and ISP are usually one-liners. DIP is what makes your design testable.",
  "steps": [
    { "label": "S · Single responsibility", "sub": "One reason to change. Split the class that does two jobs." },
    { "label": "O · Open/closed", "sub": "New behaviour = new class, not an edited switch." },
    { "label": "L · Liskov substitution", "sub": "A subtype must survive every use of its parent." },
    { "label": "I · Interface segregation", "sub": "Small interfaces; nobody implements methods they must throw from." },
    { "label": "D · Dependency inversion", "sub": "Depend on the abstraction; inject the implementation." }
  ]
}
```

## S — Single responsibility

**The principle:** a class should have one reason to change.

**The smell:** a class name containing "and", or a class whose methods split into two obvious clusters — one about the domain, one about persistence, formatting, or notification.

```java
// Violates SRP: three reasons to change — booking rules, storage, messaging.
class BookingService {
    Booking book(...) { /* availability rules */ }
    void saveToDatabase(Booking b) { /* SQL */ }
    void sendConfirmationEmail(Booking b) { /* SMTP */ }
}

// Fixed: each collaborator changes for its own reason.
class BookingService {
    private final BookingRepository repo;
    private final NotificationSender notifier;

    Booking book(BookingRequest req) {
        Booking b = /* availability rules, the one job */;
        repo.save(b);
        notifier.send(new BookingConfirmed(b));
        return b;
    }
}
```

**The sentence:** *"I'm keeping the booking rules in the service and pushing storage into a repository and messaging behind a sender — so a change to the email template can't break availability logic."*

:::trap SRP does not mean tiny classes
The failure mode in the other direction is a design with `TicketIdGenerator`, `TicketIdValidator`, `TicketIdFormatter` — thirty classes doing one line each, and nothing you can read. "One reason to change" is about *reasons* (business rules, storage, presentation, external systems), not line count. If you can't name the second reason, don't split.
:::

## O — Open/closed

**The principle:** open for extension, closed for modification. Adding behaviour shouldn't require editing existing, working code.

**The smell:** a `switch` or `if/else` chain on a type, and the knowledge that every new type means editing it.

```java
// Violates OCP: every new vehicle type edits this method.
Money fee(Vehicle v, Duration d) {
    switch (v.type()) {
        case BIKE:  return rate(10, d);
        case CAR:   return rate(20, d);
        case TRUCK: return rate(40, d);
    }
    throw new IllegalStateException();   // and this line is a bug waiting
}

// Fixed: new pricing = new class, registered in one place.
interface PricingStrategy { Money price(Duration d); }

class FlatHourlyPricing implements PricingStrategy { /* ... */ }
class WeekendSurgePricing implements PricingStrategy { /* ... */ }

class FeeCalculator {
    private final Map<VehicleSize, PricingStrategy> strategies;
    Money fee(Vehicle v, Duration d) { return strategies.get(v.size()).price(d); }
}
```

**The sentence:** *"Pricing rules are the thing most likely to change, so I've put them behind a strategy — a new rule is a new class plus a registry entry, and nothing existing gets edited."*

This is the principle interviewers probe most, because the standard follow-up ("now add X") is literally a test of it. If your answer to "add electric-vehicle charging spots" is "I add a class", you pass. If it's "I add a case to four switches", you don't.

:::goat The switch that's actually fine
Somewhere, exactly once, something must map input to implementation — a factory, a registry, a config table. That switch is *allowed*, and pretending otherwise leads to reflection soup. OCP's real claim is: **have one such place, at the edge, not one per feature scattered through the core.** Saying that out loud shows you understand the principle rather than obeying it.
:::

## L — Liskov substitution

**The principle:** anywhere the parent works, the child must work too — same guarantees, no new exceptions, no stricter inputs.

**The smell:** an override that throws `UnsupportedOperationException`, or a caller doing `if (x instanceof Y)` before deciding what to call.

```java
// The classic: Square is-a Rectangle mathematically, not behaviourally.
class Rectangle { void setWidth(int w); void setHeight(int h); }
class Square extends Rectangle {
    void setWidth(int w)  { this.w = w; this.h = w; }   // surprises every caller
}

// A more realistic one:
class ReadOnlyAccount extends Account {
    void withdraw(long amount) { throw new UnsupportedOperationException(); }
}
```

**The fix:** model the difference as a capability rather than a subtype — separate `Readable` and `Writable` interfaces, or make the shared thing an interface both implement, rather than one extending the other.

**The sentence:** *"I won't subclass here — a read-only account can't honour `withdraw`, so it isn't substitutable. I'll split the interface instead."*

## I — Interface segregation

**The principle:** no client should depend on methods it doesn't use.

**The smell:** a fat interface (`Machine` with `print`, `scan`, `fax`) whose implementations stub out half the methods.

```java
// Fat: a simple printer must implement three things it can't do.
interface Machine { void print(Doc d); void scan(Doc d); void fax(Doc d); }

// Segregated: implement exactly what you are.
interface Printer { void print(Doc d); }
interface Scanner { void scan(Doc d); }

class BasicPrinter implements Printer { }
class MultiFunction implements Printer, Scanner { }
```

In an LLD round this usually appears as a one-line judgement rather than a whole design, and the useful heuristic is: **interfaces should be sized to the caller's need, not the implementer's capability.** A `NotificationSender` that only needs `send` shouldn't be handed a `Channel` interface with `connect`, `send`, `flush`, `close`, and `stats`.

## D — Dependency inversion

**The principle:** high-level policy shouldn't depend on low-level detail; both depend on an abstraction. In practice: **don't `new` your collaborators — take them in the constructor.**

```java
// Violates DIP: the service is welded to MySQL and to a real SMTP server.
class OrderService {
    private final MySqlOrderRepo repo = new MySqlOrderRepo();
    private final SmtpMailer mailer = new SmtpMailer();
}

// Fixed: depends on interfaces, wired from outside.
class OrderService {
    private final OrderRepository repo;
    private final Mailer mailer;

    OrderService(OrderRepository repo, Mailer mailer) {   // injected
        this.repo = repo;
        this.mailer = mailer;
    }
}
```

Two payoffs worth naming, because they're the reason anyone cares:

- **Testability.** `new OrderService(new InMemoryOrderRepo(), new FakeMailer())` — no database, no network, tests run in milliseconds. If you're asked "how would you test this?", this is the answer.
- **Swappability.** In-memory today, Postgres tomorrow, and the service doesn't notice. In an interview you can legitimately say "I'll use an in-memory repository for this design; the interface means swapping in a real store changes one wiring line."

**The sentence:** *"Everything is constructor-injected against interfaces, so I can run the whole thing in memory in a test and swap real infrastructure in at the composition root."*

## Using SOLID under time pressure

You will not have time to discuss all five. Spend your words where they pay:

| Moment in the interview | Principle to name |
|---|---|
| Splitting your first big class | SRP |
| Putting an interface at an axis of variation | OCP (and DIP for the injection) |
| Asked "now add a new type of X" | OCP — and *show* it, don't just say it |
| Asked "how would you test this?" | DIP |
| You catch yourself writing `instanceof` | LSP — say why you're avoiding it |

:::warn Don't narrate the acronym
Never say "this satisfies the Single Responsibility Principle" as a standalone claim — it sounds memorised and invites a challenge. Say the *consequence* and let the principle be implied: "a change to how we charge cards can't break how we allocate spots." If the interviewer wants the label, they'll supply it themselves.
:::

:::exercise Spot the violations
`class ReportGenerator { void generate(String type) { if (type.equals("pdf")) {...} else if (type.equals("csv")) {...} } void email(Report r) {...} void saveToDisk(Report r) {...} }` — name two violated principles and the two-class fix. (OCP: the type chain wants a `ReportFormat` interface. SRP: generation, delivery, and persistence are three reasons to change.)
:::
