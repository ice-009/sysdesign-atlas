---
title: SOLID, in Plain English
summary: The five principles as they're actually used in an interview — the problem each one fixes, a small before-and-after, and the sentence that earns the point.
difficulty: Medium
scope: LLD
tags: [solid, oop, lld, principles]
prereqs: [oop-refresher]
unlocks: Explaining your class design in the words interviewers listen for, and spotting problems in your own diagram.
---

SOLID is five rules of thumb for arranging classes. It isn't a checklist to recite — it's **a way of justifying decisions you were going to make anyway**, which is exactly why it scores. It turns "this feels cleaner" into an argument.

Learn each one as three things: the problem, the fix, and the sentence you say.

```viz
{
  "type": "steps",
  "caption": "The five, in the order they matter in an LLD round.",
  "note": "The first two win most of the points. The middle two are usually one-liners. The last one is what makes your design testable.",
  "steps": [
    { "label": "S · One job per class", "sub": "If describing it needs the word \"and\", split it." },
    { "label": "O · Add, don't edit", "sub": "New behaviour should mean a new class." },
    { "label": "L · Children must stand in", "sub": "A subclass has to work wherever the parent did." },
    { "label": "I · Small interfaces", "sub": "Nobody should implement methods they can't support." },
    { "label": "D · Depend on interfaces", "sub": "Take collaborators in, don't create them inside." }
  ]
}
```

## S — Single responsibility: one job per class

**The problem:** a class that does several unrelated things. Every one of those things is a reason for someone to edit it, and edits break neighbours.

**How to spot it:** the class name contains "and", or its methods fall into two obvious groups — some about the actual rules, some about saving to a database or sending email.

```java
// Three jobs: booking rules, storage, and messaging.
class BookingService {
    Booking book(...) { /* availability rules */ }
    void saveToDatabase(Booking b) { /* SQL */ }
    void sendConfirmationEmail(Booking b) { /* SMTP */ }
}

// Fixed: each helper changes for its own reason.
class BookingService {
    private final BookingRepository repo;
    private final NotificationSender notifier;

    Booking book(BookingRequest req) {
        Booking b = /* availability rules — the one job */;
        repo.save(b);
        notifier.send(new BookingConfirmed(b));
        return b;
    }
}
```

**Say this:** *"The booking rules stay in the service. Storage goes behind a repository and messaging behind a sender, so changing the email template can't break availability logic."*

:::trap It does not mean tiny classes
The opposite mistake is a design with `TicketIdGenerator`, `TicketIdValidator` and `TicketIdFormatter` — thirty classes of one line each and nothing you can read straight through.

"One job" is about *reasons to change* — business rules, storage, display, outside systems — not about line count. If you can't name the second reason, don't split it.
:::

## O — Open/closed: add rather than edit

**The problem:** every new case means editing a working method, and editing working code is how you break it.

**How to spot it:** a `switch` or a chain of `if`s on a type, where you know each new type means coming back here.

```java
// Every new vehicle type edits this method.
Money fee(Vehicle v, Duration d) {
    switch (v.type()) {
        case BIKE:  return rate(10, d);
        case CAR:   return rate(20, d);
        case TRUCK: return rate(40, d);
    }
    throw new IllegalStateException();   // and this line is a bug in waiting
}

// Fixed: a new price rule is a new class, registered in one place.
interface PricingStrategy { Money price(Duration d); }

class FlatHourlyPricing implements PricingStrategy { /* ... */ }
class WeekendSurgePricing implements PricingStrategy { /* ... */ }

class FeeCalculator {
    private final Map<VehicleSize, PricingStrategy> strategies;
    Money fee(Vehicle v, Duration d) { return strategies.get(v.size()).price(d); }
}
```

**Say this:** *"Pricing is the thing most likely to change, so it sits behind an interface. A weekend surcharge becomes a new class, and nothing that already works gets edited."*

Interviewers probe this one most, because their standard follow-up — "now add X" — is a direct test of it. If your answer is "I add a class", you pass. If it's "I add a case to four different switches", you don't.

:::goat The switch that's allowed
Somewhere, exactly once, something has to turn input into the right object — a factory, a registry, a config table. **That** switch is fine. Pretending otherwise leads to unreadable reflection tricks.

The real claim is: have one such place, at the edge, instead of one per feature scattered through the middle. Saying that shows you understand the principle rather than just obeying it.
:::

## L — Liskov substitution: a child must stand in for its parent

**The problem:** code written against the parent breaks when handed a child.

**How to spot it:** an overridden method that throws "not supported", or callers writing `if (x instanceof Y)` before deciding what to call.

```java
// The classic. A square is a rectangle in maths, not in behaviour.
class Rectangle { void setWidth(int w); void setHeight(int h); }
class Square extends Rectangle {
    void setWidth(int w)  { this.w = w; this.h = w; }   // surprises every caller
}

// A more realistic one:
class ReadOnlyAccount extends Account {
    void withdraw(long amount) { throw new UnsupportedOperationException(); }
}
```

**The fix:** model the difference as a *capability* rather than a family tree — separate `Readable` and `Writable` interfaces, or have both classes implement a shared interface instead of one extending the other.

**Say this:** *"I won't subclass here. A read-only account can't honour `withdraw`, so it can't stand in for an account. I'll split the interface instead."*

## I — Interface segregation: keep interfaces small

**The problem:** one big interface forces classes to implement methods that make no sense for them.

**How to spot it:** implementations with half their methods stubbed out or throwing.

```java
// Too big: a simple printer must implement two things it cannot do.
interface Machine { void print(Doc d); void scan(Doc d); void fax(Doc d); }

// Split: implement exactly what you are.
interface Printer { void print(Doc d); }
interface Scanner { void scan(Doc d); }

class BasicPrinter implements Printer { }
class MultiFunction implements Printer, Scanner { }
```

In an LLD round this is usually a single judgement rather than a whole design. The useful rule: **size an interface to what the caller needs, not to everything the implementation can do.** Something that only needs `send` shouldn't be handed an interface with `connect`, `send`, `flush`, `close` and `stats`.

## D — Dependency inversion: take your collaborators in

**The problem:** a class that creates its own helpers with `new` is welded to them. You can't test it without a real database, and you can't swap anything.

**The fix:** accept them as constructor arguments, typed as interfaces. This is called *dependency injection*, and it's less grand than it sounds.

```java
// Welded to MySQL and to a real mail server.
class OrderService {
    private final MySqlOrderRepo repo = new MySqlOrderRepo();
    private final SmtpMailer mailer = new SmtpMailer();
}

// Handed its collaborators instead.
class OrderService {
    private final OrderRepository repo;
    private final Mailer mailer;

    OrderService(OrderRepository repo, Mailer mailer) {   // injected
        this.repo = repo;
        this.mailer = mailer;
    }
}
```

Two payoffs, and they're the reason anyone cares:

- **You can test it.** `new OrderService(new InMemoryOrderRepo(), new FakeMailer())` — no database, no network, tests finish in milliseconds. When asked "how would you test this?", this is the answer.
- **You can swap things.** In-memory today, Postgres tomorrow, and the service never notices. In an interview you can say "I'll use an in-memory repository here; swapping in a real database changes one line of wiring."

**Say this:** *"Everything is passed in through the constructor as an interface, so I can run the whole thing in memory in a test and plug real infrastructure in at startup."*

## Using these when the clock is running

You won't have time for all five. Spend the words where they pay:

| When this happens | Name this one |
|---|---|
| You split your first big class | One job per class (S) |
| You put an interface where things vary | Add-don't-edit (O), and injection (D) |
| Asked "now add a new kind of X" | Add-don't-edit — and *show* it, don't just claim it |
| Asked "how would you test this?" | Dependency injection (D) |
| You catch yourself writing `instanceof` | Substitution (L) — say why you're avoiding it |

:::warn Don't recite the acronym
Never say "this satisfies the Single Responsibility Principle" as a standalone claim. It sounds memorised and invites a challenge you don't need.

Say the *consequence* and let the principle be obvious: "changing how we charge cards can't break how we allocate parking spots." If the interviewer wants the label, they'll supply it themselves.
:::

:::exercise Find the two problems
`class ReportGenerator { void generate(String type) { if (type.equals("pdf")) {...} else if (type.equals("csv")) {...} } void email(Report r) {...} void saveToDisk(Report r) {...} }`

Which two principles does it break, and what's the fix?

(Add-don't-edit: the type chain wants a `ReportFormat` interface. One job: generating, emailing and saving are three different reasons to edit this class.)
:::
