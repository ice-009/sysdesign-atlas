---
title: OOP That Interviewers Actually Test
summary: The handful of object-oriented ideas that show up in every LLD round — encapsulation as invariant protection, composition over inheritance, interfaces at the axes of variation, and value vs entity objects.
difficulty: Medium
tags: [oop, lld, fundamentals]
prereqs: [hld-vs-lld]
unlocks: Turning a problem statement into a set of objects with clear responsibilities, and defending each one.
---

Nobody will ask you to define polymorphism. They will ask you to design something, and then watch whether your objects have any point to them. This page is the subset of OOP that changes the shape of your answer.

## An object is an invariant with a door

The textbook line is "data plus behaviour". The useful line is: **an object exists to protect a rule about its data.**

```java
// Not an object. A struct with extra steps.
class Account {
    public double balance;
}

// An object: the rule "balance never goes negative" lives with the data,
// and there is no way in that bypasses it.
class Account {
    private long balanceMinor;   // money in minor units, never a double

    void withdraw(long amount) {
        if (amount <= 0) throw new IllegalArgumentException("amount must be positive");
        if (amount > balanceMinor) throw new InsufficientFundsException(id, amount);
        balanceMinor -= amount;
    }

    long balance() { return balanceMinor; }
}
```

The second version can be reasoned about locally: no code anywhere in the system can make the balance negative, because there is no path to the field. The first version's rule lives in whoever happens to touch it — which means it lives nowhere.

:::interview How to say it
When you make a field private, say *why*: "I'll keep `balance` private and expose `withdraw` — the invariant is that it never goes below zero, and I want exactly one place enforcing that." That's a sentence about design. "I'll make it private because encapsulation" is a sentence about a textbook.
:::

Two consequences worth stating in an interview when they apply:

- **Getters and setters are not encapsulation.** `getBalance`/`setBalance` is a public field with ceremony. Expose *operations* (`withdraw`, `deposit`), not fields.
- **Tell, don't ask.** If you find yourself pulling data out of an object to make a decision about that object, the decision belongs inside it. `if (order.getItems().isEmpty())` scattered in five places wants to be `order.isEmpty()`.

## Composition over inheritance

This is the single highest-value OOP idea in an LLD interview, because the classic problems (parking lot, pizza shop, notification system) are all traps that reward it.

Inheritance gives you one axis of variation. The moment your problem has two, the class count explodes:

```diagram
   Inheritance, two axes:              Composition, two axes:

   Notification                        Notification
     ├── EmailUrgent                      ├── Channel   (email | sms | push)
     ├── EmailNormal                      └── Priority  (urgent | normal)
     ├── SmsUrgent
     ├── SmsNormal                      3 + 2 = 5 classes
     ├── PushUrgent                     adding WhatsApp = +1
     └── PushNormal
                                        A third axis (locale, 4 values):
   3 × 2 = 6 classes                      inheritance → 24 classes
   adding WhatsApp = +2                   composition → 9
```

The rule of thumb interviewers listen for: **inherit only when the subclass genuinely is a substitutable kind of the parent and you expect that hierarchy to stay one level deep.** Otherwise, hold a reference.

```java
// is-a: a Car is a Vehicle. Fine — one axis, real substitution.
class Car extends Vehicle { }

// has-a: an Order is not a DiscountPolicy. Hold one instead.
class Order {
    private final DiscountPolicy discount;      // swappable at runtime
    private final List<OrderLine> lines;

    Money total() { return discount.apply(subtotal()); }
}
```

:::trap The inheritance answer that fails
Asked to design a parking lot, a lot of candidates open with `class Car extends Vehicle`, `class Bike extends Vehicle`, `class Truck extends Vehicle`. It isn't wrong, but it's the least interesting decision in the problem, and if the subclasses only differ by a size field, you've written three classes to store an enum. Say it out loud: *"Vehicle types only differ by the spot size they need, so I'd model that as a `VehicleSize` enum on `Vehicle` rather than a subclass per type — unless behaviour differs, and then I'd subclass."* That single sentence is worth more than the hierarchy.
:::

## Interfaces belong at the axes of variation

An interface earns its place when there is — today or plausibly tomorrow — **more than one implementation**. Not before. `UserServiceInterface` with exactly one `UserServiceImpl` behind it is noise, and experienced interviewers notice.

The way to find real axes, in order:

1. Read the requirements for the words *"different", "depending on", "either… or", "configurable", "for now"*. Each one is an axis.
2. Ask what the interviewer might add as a follow-up. "Now support a new payment method" is the most-asked follow-up in existence — so payment is an axis.
3. Everything else stays a concrete class until proven otherwise.

```java
interface PricingStrategy {                 // axis: how a fee is computed
    Money price(Duration parked, VehicleSize size);
}

interface PaymentMethod {                   // axis: how money moves
    PaymentResult charge(Money amount);
}

// Not an axis: there is exactly one way to be a ticket.
final class Ticket { /* ... */ }
```

## Entities vs value objects

A distinction that instantly makes a design look considered, and takes one sentence to explain.

| | Entity | Value object |
|---|---|---|
| Identity | Has an ID; two entities with equal fields are still different | *Is* its fields; two with equal fields are the same |
| Mutability | Usually mutable over its lifecycle | Immutable |
| Examples | `User`, `Ticket`, `ParkingSpot`, `Order` | `Money`, `TimeSlot`, `Address`, `Coordinates` |
| Equality | Compare IDs | Compare all fields |

```java
// Value object: immutable, self-validating, equality by value.
record Money(long minorUnits, Currency currency) {
    Money {
        if (currency == null) throw new IllegalArgumentException("currency required");
    }
    Money plus(Money other) {
        if (!currency.equals(other.currency)) throw new CurrencyMismatchException();
        return new Money(minorUnits + other.minorUnits, currency);
    }
}
```

Two payoffs to mention: value objects are **automatically thread-safe** (nothing can change), and they kill a whole class of bug where a shared object mutates under someone's feet. When the concurrency follow-up arrives, "most of my domain is immutable value objects, so the only shared mutable state is X" is a strong opening. See [Concurrency in LLD](concurrency-in-lld.html).

## Enums with behaviour

A small trick that reads as fluent, especially for state machines and type-driven pricing:

```java
enum VehicleSize {
    MOTORCYCLE(1), COMPACT(2), LARGE(3);

    private final int units;
    VehicleSize(int units) { this.units = units; }

    boolean fitsIn(SpotSize spot) { return units <= spot.units(); }
}
```

The alternative — a `switch` on the enum scattered across the codebase — is the thing Open/Closed exists to prevent. See [SOLID](solid.html).

## The four questions to ask of every class you draw

Run these before you commit a box to the board. They take ten seconds each and catch most bad designs:

1. **What is its one job?** If the answer needs an "and", split it.
2. **What invariant does it protect?** If none, it might be a value object or a data holder — fine, but say so.
3. **Who does it depend on, and is that a concrete class or an interface?** Concrete is fine unless the axis is real.
4. **If the interviewer adds a feature, does this class change or does a new one appear?** New class is the answer you want.

:::exercise Two minutes
Take `class Order { List<Item> items; String status; double total; void checkout() {...} }`. Name three invariants it should protect, one field that should be a value object, and one axis of variation hiding in `checkout()`. (Answers: total matches the lines; status transitions are legal; items non-empty at checkout · `total` should be `Money` · payment and/or discount is the axis.)
:::
