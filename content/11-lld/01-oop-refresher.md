---
title: Objects, in Practice
summary: The handful of object-oriented ideas an LLD interview actually tests — what an object is for, why you should hold objects rather than inherit from them, and where interfaces belong.
difficulty: Medium
scope: LLD
tags: [oop, lld, fundamentals]
prereqs: [three-day-plan]
unlocks: Turning a problem statement into a set of classes with clear jobs, and defending each one.
---

:::predict Guess first
1. A class has a public balance field, and every caller checks it never goes negative. What will eventually happen?
2. Notifications vary by channel (email, SMS, push) and by priority (urgent, normal). With one subclass per combination, how many classes is that — and after adding WhatsApp?
3. Two users have identical names and details. Are they the same user? Is ₹50 from one wallet the same as ₹50 from another?
:::

Nobody will ask you to define polymorphism. They will ask you to design something and then watch whether your classes have any point to them. This page covers only the ideas that change your answer.

## An object protects a rule

The textbook says an object is "data plus behaviour". That's true but not useful. Here's the useful version:

**An object exists to protect a rule about its data.**

An *invariant* is the word for such a rule — something that must always be true, no matter what code runs. "A bank balance is never negative" is an invariant.

```java
// Not really an object. It's a box of data with a class keyword.
class Account {
    public double balance;
}

// An object: the rule lives with the data, and there is no way in
// that skips the check.
class Account {
    private long balanceMinor;   // money in paise/cents, never a double

    void withdraw(long amount) {
        if (amount <= 0)
            throw new IllegalArgumentException("amount must be positive");
        if (amount > balanceMinor) throw new InsufficientFundsException(id, amount);
        balanceMinor -= amount;
    }

    long balance() { return balanceMinor; }
}
```

Why the second one is better: no code anywhere can make the balance negative, because no code can reach the field. In the first version the rule has to be repeated by every piece of code that touches `balance` — which means, in practice, that some of them forget.

:::interview How to say it in the room
When you make a field private, say *why*. "I'll keep `balance` private and expose `withdraw`, because the rule is that it never goes below zero and I want one place enforcing that."

That's a sentence about design. "It's private because encapsulation" is a sentence about a textbook, and interviewers hear the difference.
:::

Two things that follow, worth saying when they come up:

- **Getters and setters are not encapsulation.** A `getBalance`/`setBalance` pair is just a public field with extra steps. Expose *actions* (`withdraw`, `deposit`), not fields.
- **Tell, don't ask.** If you pull data out of an object to make a decision about that object, the decision belongs inside it. `if (order.getItems().isEmpty())` repeated in five places wants to be `order.isEmpty()`.

## Prefer holding an object to inheriting from one

This is the highest-value idea on the page, because the classic interview problems are built to reward it.

Some vocabulary first:

- **Inheritance** is `class Car extends Vehicle`. Car *is a* Vehicle and gets its behaviour automatically.
- **Composition** is `class Order { private DiscountPolicy discount; }`. Order *has a* DiscountPolicy and calls it.

Inheritance gives you exactly one way for things to differ. As soon as your problem has two, the number of classes explodes:

```diagram
   With inheritance, two things vary:      With composition, two things vary:

   Notification                            Notification
     ├── EmailUrgent                          ├── Channel   (email | sms | push)
     ├── EmailNormal                          └── Priority  (urgent | normal)
     ├── SmsUrgent
     ├── SmsNormal                          3 + 2 = 5 classes
     ├── PushUrgent                         adding WhatsApp = 1 more
     └── PushNormal
                                            Add a third thing (4 languages):
   3 × 2 = 6 classes                          inheritance → 24 classes
   adding WhatsApp = 2 more                   composition → 9
```

The rule interviewers listen for: **inherit only when the child really is a kind of the parent, and you expect the family to stay one level deep. Otherwise, hold a reference.**

```java
// is-a: a Car is a Vehicle. Fine — one axis, and a Car works
// anywhere a Vehicle is expected.
class Car extends Vehicle { }

// has-a: an Order is not a kind of DiscountPolicy. So hold one.
class Order {
    private final DiscountPolicy discount;      // can be swapped at runtime
    private final List<OrderLine> lines;

    Money total() { return discount.apply(subtotal()); }
}
```

:::trap The opening that costs marks
Asked to design a parking lot, many candidates start with `class Car extends Vehicle`, `class Bike extends Vehicle`, `class Truck extends Vehicle`. It isn't *wrong*, but it's the least interesting decision available, and if the three classes differ only by a size field you have written three classes to store one value.

Say this instead: *"Vehicle types only differ by the size of spot they need, so I'd put a `VehicleSize` field on `Vehicle` rather than make a subclass for each — unless their behaviour differs, in which case I'd subclass."*

One sentence, and it shows more judgement than the whole hierarchy.
:::

## Interfaces go where things genuinely vary

An **interface** is a list of method names with no code behind them. Several classes can implement it, and code that uses the interface doesn't care which one it got.

An interface earns its place when there is — now or clearly soon — **more than one implementation**. Not before. A `UserServiceInterface` with a single `UserServiceImpl` behind it is clutter, and experienced interviewers notice.

How to find the real ones, in order:

1. Reread the requirements looking for the words **"different"**, **"depending on"**, **"either… or"**, **"configurable"**, **"for now"**. Each one marks a place where things vary.
2. Ask what the interviewer is likely to add later. "Now support another payment method" is the most common follow-up there is — so payment varies.
3. Everything else stays an ordinary class until you have a reason.

```java
interface PricingStrategy {                 // varies: how the fee is worked out
    Money price(Duration parked, VehicleSize size);
}

interface PaymentMethod {                   // varies: how the money moves
    PaymentResult charge(Money amount);
}

// Not varying: there is only one way to be a ticket.
final class Ticket { /* ... */ }
```

## Two kinds of object: entities and values

This distinction takes one sentence to explain and immediately makes a design look considered.

| | Entity | Value object |
|---|---|---|
| Identity | Has an ID. Two entities with identical fields are still two different things | *Is* its fields. Two with identical fields are the same thing |
| Changes? | Usually changes over its life | Never changes once created |
| Examples | `User`, `Ticket`, `ParkingSpot`, `Order` | `Money`, `TimeSlot`, `Address`, `Coordinates` |
| Comparing | Compare IDs | Compare every field |

Two people called Ravi Sharma are two users, even with identical details — so `User` is an entity. ₹50 is ₹50 wherever it came from — so `Money` is a value.

```java
// A value object: cannot change, checks itself, compared by value.
record Money(long minorUnits, Currency currency) {
    Money {
        if (currency == null)
            throw new IllegalArgumentException("currency required");
    }
    Money plus(Money other) {
        if (!currency.equals(other.currency)) throw new CurrencyMismatchException();
        return new Money(minorUnits + other.minorUnits, currency);
    }
}
```

Two payoffs worth mentioning out loud. Value objects are **automatically safe to share between threads**, because nothing can change them. And they remove a whole family of bugs where a shared object is modified while someone else is using it. When the threading question arrives — and it will — "most of my model is immutable, so the only shared changing state is X" is a strong opening. See [Threads and races](concurrency-in-lld.html).

## Enums can hold behaviour

A small trick that reads as fluent, especially for pricing and for objects with states:

```java
enum VehicleSize {
    MOTORCYCLE(1), COMPACT(2), LARGE(3);

    private final int units;
    VehicleSize(int units) { this.units = units; }

    boolean fitsIn(SpotSize spot) { return units <= spot.units(); }
}
```

The alternative is a `switch` on the enum copied into six different files — which is exactly the problem the Open/Closed principle exists to prevent. See [SOLID](solid.html).

## Four questions to ask of every class you draw

Ten seconds each, and they catch most bad designs before you commit them to the board.

1. **What is its one job?** If you need the word "and" to answer, split it.
2. **What rule does it protect?** If there isn't one, it may just be a value object — fine, but say so.
3. **What does it depend on, and is that a concrete class or an interface?** Concrete is fine unless that thing really varies.
4. **If the interviewer adds a feature, does this class change, or does a new class appear?** "A new class appears" is the answer you want.

:::exercise Two minutes
Take this: `class Order { List<Item> items; String status; double total; void checkout() {...} }`.

Name three rules it should protect, one field that should be a value object, and one thing inside `checkout()` that varies.

(Rules: the total matches the lines; status only moves in legal steps; items aren't empty at checkout. Field: `total` should be `Money`. Varies: payment, and probably discounts.)
:::

## Check yourself

```recall
Q: What is an object for, in design terms?
A: Protecting a rule (an invariant) about its data: keep the field private and expose actions like withdraw that enforce the rule in one place, so no caller can bypass it.

Q: Why aren't getters and setters encapsulation?
A: A get/set pair is a public field with extra steps — the rule still has to be repeated by every caller. Expose actions (withdraw, deposit), not fields.

Q: What does "tell, don't ask" mean?
A: If you pull data out of an object to decide something about it, move the decision inside: order.isEmpty() instead of checking order.getItems().isEmpty() in five places.

Q: When should you inherit, and when compose?
A: Inherit only for a genuine is-a with a family that stays about one level deep. Otherwise hold a reference — inheritance allows one dimension of variation and multiplies classes when there are two.

Q: What is the better opening for parking-lot vehicles?
A: If vehicle types differ only by the spot size they need, give Vehicle a VehicleSize field instead of Car, Bike and Truck subclasses; subclass only if behaviour differs.

Q: When does an interface earn its place?
A: When there is, or will clearly be, more than one implementation. Look for "different", "depending on", "either/or", "configurable", "for now", and likely follow-ups such as another payment method.

Q: Entity versus value object?
A: An entity has an ID and changes over time; two with identical fields are still different (User, Order). A value object is its fields, never changes and compares by value (Money, TimeSlot) — and is safe to share between threads.

Q: Name the four questions to ask of every class.
A: What is its one job (no "and")? What rule does it protect? Does it depend on a concrete class or an interface — and does that thing really vary? Does a new feature change it or add a new class?
```

## What to carry forward

- An object protects a rule about its data — expose actions, not fields.
- Prefer holding an object to inheriting from one; inheritance handles only one dimension of variation.
- Interfaces go only where things genuinely vary, now or in a likely follow-up.
- Separate entities (identity, change) from value objects (immutable, compared by value).
- Enums can carry behaviour, replacing switches copied across files.
