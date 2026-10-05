---
title: Code Smells and Refactoring
summary: The warning signs an interviewer spots in a design — the god class, the switch on type, money as a double, the method that reaches through three objects — and the small, named refactoring that removes each one.
difficulty: Medium
scope: LLD
tags: [refactoring, code-smells, clean-code, lld]
prereqs: [solid]
unlocks: Spotting what's wrong with a piece of code quickly, naming it, and fixing it in small safe steps — in your own design and in "review this snippet" rounds.
---

A *code smell* is a sign that something is probably wrong — not a bug, not a crash, just a shape that tends to cause trouble later. The word is useful because it's honest: a smell is a reason to look closer, not proof.

This matters in interviews twice. First, interviewers notice smells in *your* design, and fixing one before they point it out is a strong signal. Second, some rounds hand you a messy snippet and ask "what would you change?" — a direct test of whether you can name problems and fix them in order.

The fixes have names too. Each one is a **refactoring**: a small change to the structure of code that doesn't change what it does. Knowing the names lets you say *"I'd extract a class here"* instead of waving your hands.

## The god class

**The smell:** one class that does everything. `ParkingService` that finds spots, calculates prices, prints tickets, talks to the payment gateway and sends emails. It's 900 lines long and every change touches it.

**Why it hurts:** every reason to change the system becomes a reason to change this file. Two people can't work on it at once, and a fix to pricing can break emails.

**The fix — Extract Class.** Find groups of fields and methods that are used together, and move each group into its own class.

```java
// Before: one class, five jobs
class ParkingService {
    Ticket park(Vehicle v) { /* find spot, assign, print, notify */ }
    Money  leave(Ticket t) { /* compute price, charge card, email receipt */ }
    private Money computePrice(Ticket t) { ... }
    private void  chargeCard(Money m, Card c) { ... }
    private void  emailReceipt(Ticket t, Money m) { ... }
}

// After: each job has a home; ParkingService only coordinates
class ParkingService {
    private final SpotAllocator allocator;
    private final PricingPolicy pricing;
    private final PaymentGateway payments;
    private final Notifier notifier;
    ...
}
```

This is the [single responsibility principle](solid.html) in action. The test for "is this one job?": can you describe the class without the word *and*?

## The switch on type

**The smell:** the same `switch` (or `if/else` chain) over a type code, repeated in several places.

```java
Money price(Vehicle v, Duration d) {
    switch (v.type()) {
        case CAR:   return Money.of(40 * d.toHours());
        case BIKE:  return Money.of(20 * d.toHours());
        case TRUCK: return Money.of(100 * d.toHours());
        default:    throw new IllegalStateException();
    }
}
// ...and another switch in canFit(), and another in describe()
```

**Why it hurts:** adding `ELECTRIC_CAR` means finding every switch. Miss one and it fails at runtime, maybe months later.

**The fix — Replace Conditional with Polymorphism.** Move each branch into the type it belongs to, or into a [strategy](design-patterns.html) when the behaviour should be swappable on its own.

```java
abstract class Vehicle {
    abstract Money hourlyRate();
    abstract boolean fits(SpotSize s);
}
class Car extends Vehicle {
    Money hourlyRate()          { return Money.of(40); }
    boolean fits(SpotSize s)    { return s != SpotSize.SMALL; }
}
```

A new vehicle is now a new class. Nothing else changes — the [open/closed principle](solid.html) without the jargon.

:::tip One switch is fine
A single `switch` that *creates* the right object — in a factory — is not a smell. It's the one place that has to know all the kinds. The smell is the same switch copied around the codebase.
:::

## Primitive obsession

**The smell:** using raw strings and numbers for things that have rules. Money as `double`. An email as `String`. A seat as `int row, int col` passed everywhere as a pair.

**Why it hurts:** the rules have nowhere to live, so they're repeated (or forgotten) at every use. `double` money drifts by fractions of a paisa. A `String` email can hold `"hello"`.

**The fix — Replace Primitive with Object.** Make a small value class that enforces the rule once.

```java
record Email(String value) {
    Email {
        if (!value.matches("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"))
            throw new IllegalArgumentException("not an email: " + value);
    }
}

record Money(long minor, Currency currency) { ... }   // whole paise, never double
```

Now an `Email` that exists is valid by definition, and a method that takes `Money` can't be handed a temperature by accident. This is the cheapest improvement you can make to an LLD answer, and the one interviewers notice most — see how [Splitwise](splitwise.html) uses `Money`.

## Long parameter lists and data clumps

**The smell:** a method with six parameters, or the same three values always travelling together.

```java
Booking book(String showId, int row, int col,
             String userId, String email, boolean premium)
```

`row` and `col` always go together. So do `userId` and `email`. These are *data clumps* — groups that want to be an object.

**The fix — Introduce Parameter Object.** Name the clump.

```java
record SeatRef(int row, int col) { }
Booking book(ShowId show, SeatRef seat, Customer customer, Tier tier)
```

Fewer parameters, and each one now has a type that explains itself. When construction itself takes many optional values, a [builder](design-patterns.html) is the next step.

## Feature envy

**The smell:** a method that's more interested in another class's data than its own.

```java
class InvoicePrinter {
    String line(Order o) {
        long total = 0;
        for (Item i : o.items()) total += i.price() * i.qty();
        if (o.customer().isPremium()) total = total * 90 / 100;
        return "Total: " + total;
    }
}
```

`InvoicePrinter` is doing `Order`'s arithmetic. If the discount rule changes, you have to know to look in the printer.

**The fix — Move Method.** Put the calculation on the class that owns the data.

```java
class Order {
    Money total() { ... }          // the rule lives next to the data it uses
}
class InvoicePrinter {
    String line(Order o) { return "Total: " + o.total(); }
}
```

## Reaching through objects

**The smell:** a chain of calls that walks through several objects.

```java
String city = booking.getCustomer().getAddress().getCity();
```

This line knows that bookings have customers, customers have addresses, and addresses have cities. Change any link and it breaks. The rule it breaks has a name — the **Law of Demeter**: talk to your friends, not to your friends' friends.

**The fix — Hide Delegate.** Ask the nearest object for what you need and let it decide how to get it.

```java
String city = booking.customerCity();
```

Don't overdo it: chains over plain data (`config.db().url()`) or fluent builders are fine. The smell is when the chain exposes *behaviour* you'd otherwise have to change in many places.

## Boolean flag arguments

**The smell:** `render(document, true)` — what does `true` mean?

**Why it hurts:** a flag usually means the method does two different things, and every caller has to know which is which.

**The fix:** split it into two well-named methods — `renderPreview(doc)` and `renderFull(doc)` — or use an enum when there really are several modes.

## Shotgun surgery and divergent change

Two smells that are mirror images, and worth naming as a pair:

- **Shotgun surgery:** one change forces edits in many classes. Adding a currency means touching `Order`, `Invoice`, `Refund`, `Report` and `Ledger`. The fix is to gather the scattered logic into one place — often a value object like `Money`.
- **Divergent change:** one class changes for many unrelated reasons. `UserService` changes for login rules, for profile fields, *and* for email templates. The fix is to split it — the god class again, seen from the outside.

## Duplicated code — with a caution

**The smell:** the same logic in two places. They'll drift apart, and a bug fixed in one stays in the other.

**The fix — Extract Method,** or Extract Class if the duplicate is larger.

The caution: two pieces of code that look the same today aren't always the same *idea*. Merging a tax calculation and a shipping calculation because both multiply by 1.18 couples two things that will change for different reasons. A common rule of thumb is the *rule of three*: tolerate it twice, extract it the third time.

## The opposite smell: building for a future that never comes

**Speculative generality** is the smell of over-engineering — an interface with one implementation and no second in sight, an abstract factory for objects that never vary, configuration for things nobody configures.

In an interview this is the more common failure. Candidates who have just learned patterns use six of them on a vending machine. An interface earns its place when there's a **real, named second case** — "pricing differs on weekends" — not when "it might change someday".

:::goat The sentence that makes over-engineering safe
*"I've kept this as a plain class for now. If we need a second pricing rule, I'd extract a `PricingPolicy` interface here — that's a two-minute change because nothing else depends on how the price is computed."*

Saying where you *would* add flexibility, without adding it yet, shows judgment in both directions.
:::

## Refactoring safely

The point of refactoring is to change structure without changing behaviour. That only works in small steps:

1. **Have a test that pins down current behaviour** before you start — even a rough one.
2. **Make one named change** — extract a method, move a field.
3. **Run the tests.** Green means the behaviour is unchanged.
4. Repeat. Commit often, so any step can be undone.

Big rewrites fail because nobody can tell which of forty changes broke something. Forty small refactorings, each tested, almost never do.

## In the interview

**When reviewing a snippet,** work in this order, and say each item aloud:

1. **Correctness first** — bugs, races, money as `double`, missing validation.
2. **Then the biggest structural smell** — usually a god class or a repeated switch.
3. **Then the small ones** — names, flag arguments, long parameter lists.
4. **Name the refactoring** for each: "extract class", "replace conditional with polymorphism", "introduce parameter object".

**In your own design,** leave yourself a line for the end: *"With more time I'd pull the notification code out of the service into its own class — it's the next thing that will change."* It shows you can see your own design's weak point, which is exactly what a senior engineer does.

:::exercise Find the smells
```java
class OrderManager {
    double process(String customerEmail, List<Object[]> items,
                   boolean express, String coupon) {
        double total = 0;
        for (Object[] it : items) total += (double) it[1] * (int) it[2];
        if (coupon != null && coupon.equals("SAVE10")) total = total * 0.9;
        if (express) total += 99.0;
        Db.save(customerEmail, total);
        Mailer.send(customerEmail, "Your total is " + total);
        return total;
    }
}
```
List every smell you can, and the refactoring for each. You should find at least six: money as `double`, a hidden data clump in `Object[]`, a boolean flag, a magic coupon string (the coupon rule wants to be a strategy), one method doing pricing *and* saving *and* mailing, and a `String` email with no validation. Then decide which one you'd fix first, and why.
:::
