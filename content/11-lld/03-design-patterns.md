---
title: The Patterns Worth Knowing
summary: The ten design patterns that cover almost every LLD interview — what problem each one solves, the smallest useful example, and the phrase in the question that should make you reach for it.
difficulty: Medium
scope: LLD
tags: [patterns, oop, lld]
prereqs: [solid]
unlocks: Picking the right pattern because the requirement calls for it, rather than listing patterns from memory.
---

A **design pattern** is just a named solution to a problem that keeps coming up. The name matters mainly because it lets two engineers skip a paragraph of explanation.

There are twenty-three classic ones. In an SDE-2 interview you will use about six, recognise four more, and lose points for forcing in the rest. This page is that working set, organised by **the phrase in the requirements that should trigger it** — because that's how you have to recall them when the clock is running.

| If the requirement says… | Reach for | Because |
|---|---|---|
| "…different / depending on / configurable" | **Strategy** | Swap one piece of logic for another |
| "…create the right kind of X based on input" | **Factory** | One place knows which class to build |
| "…tell everyone when Y happens" | **Observer** | One event, many listeners, loosely joined |
| "…behaves differently while it's in state Z" | **State** | Only legal transitions, no boolean soup |
| "…optional extras that combine" | **Decorator** | Stack behaviour without a class per combination |
| "…there must be exactly one" | **Singleton** | (Careful — see below) |
| "…lots of optional settings" | **Builder** | Readable construction, validated once |
| "…also support this other provider" | **Adapter** | Translate someone else's interface into yours |
| "…undo / schedule / queue an action" | **Command** | Turn the action itself into an object |
| "…where does the data come from" | **Repository** | Hide storage behind a collection-like interface |

## Strategy — the one you'll use most

**The problem:** one step of your logic has several versions, and you don't want the caller choosing between them with an `if`.

**The idea:** put that step behind an interface. Each version becomes a class. The caller holds the interface and doesn't care which version it got.

```java
interface ParkingFeeStrategy {
    Money calculate(Duration parked, VehicleSize size);
}

class HourlyFee implements ParkingFeeStrategy {
    public Money calculate(Duration d, VehicleSize s) {
        long hours = Math.max(1, d.toHours());            // round up, minimum one
        return RATES.get(s).times(hours);
    }
}

class FlatDayFee implements ParkingFeeStrategy { /* ... */ }

class ExitTerminal {
    private final ParkingFeeStrategy pricing;             // handed in, not created here
    Money checkout(Ticket t) { return pricing.calculate(t.duration(), t.size()); }
}
```

**Say this:** *"Pricing is the requirement most likely to change, so it goes behind a strategy. A weekend surcharge becomes a new class rather than an edit."*

Strategy is the workhorse because nearly every LLD problem hides one. Pricing, matching, ranking, eviction, retrying, routing, scheduling, discounting, splitting a bill — all strategies. When you're stuck for something intelligent to say about future changes, ask yourself: *what is the policy in this system?* Then put it behind an interface.

## Factory — one place that knows how to build things

Two versions, and the difference is worth knowing:

- **Simple factory** — one method that maps an input to a concrete class. This is what you want about nine times out of ten.
- **Abstract factory** — builds a whole family of matching objects together (an entire `MacUiKit` versus a `WindowsUiKit`). Rarely justified. Mention it only if the problem really has families.

```java
class NotificationChannelFactory {
    private final Map<ChannelType, Supplier<Channel>> registry = Map.of(
        ChannelType.EMAIL, EmailChannel::new,
        ChannelType.SMS,   SmsChannel::new,
        ChannelType.PUSH,  PushChannel::new
    );

    Channel create(ChannelType type) {
        Supplier<Channel> s = registry.get(type);
        if (s == null) throw new UnsupportedChannelException(type);
        return s.get();
    }
}
```

**Say this:** *"The factory is the only place allowed to know every concrete channel. That stops that knowledge spreading through the codebase."*

## Observer — announce it, don't call everyone

**The problem:** when something happens, several unrelated things need to react, and the thing that happened shouldn't have to know about any of them.

```java
interface OrderListener { void onEvent(OrderEvent e); }

class Order {
    private final List<OrderListener> listeners = new CopyOnWriteArrayList<>();

    void addListener(OrderListener l) { listeners.add(l); }

    private void publish(OrderEvent e) {
        for (OrderListener l : listeners) l.onEvent(e);   // see the caveat below
    }
}

// Listeners: InventoryUpdater, EmailNotifier, AnalyticsLogger, LoyaltyPoints…
```

**Say this:** *"Placing an order publishes an event. Inventory, email and analytics each subscribe. Adding loyalty points later doesn't touch `Order` at all."*

:::trap Two follow-ups you will get
**"What if a listener throws an exception?"** One broken listener must not break the others or the publisher. Catch per listener, log it, carry on.

**"What if a listener is slow?"** Notifying them one by one makes the publisher as slow as the slowest listener. Hand the work to a thread pool or a queue instead.

Notice the link to the bigger picture: this is exactly why real systems put a message broker here. See [Message Queues](../building-blocks/message-queues.html).
:::

## State — when behaviour depends on what happened before

**The problem:** an object behaves differently depending on its current phase, and you're accumulating booleans (`isPaid`, `isShipped`, `isCancelled`) plus the tangle of `if`s that check every combination.

**The idea:** make each phase its own object, and let each one decide what's allowed.

```java
interface OrderState {
    OrderState pay(Order o);
    OrderState cancel(Order o);
}

class Created implements OrderState {
    public OrderState pay(Order o)    { o.chargeCard(); return new Paid(); }
    public OrderState cancel(Order o) { return new Cancelled(); }
}

class Shipped implements OrderState {
    public OrderState pay(Order o)    { throw new IllegalTransitionException("already paid"); }
    public OrderState cancel(Order o) { throw new IllegalTransitionException("already in transit"); }
}
```

The payoff to name out loud: **illegal moves become impossible rather than merely unlikely**, and all the rules sit in one readable place. This is the pattern for lifts, orders, bookings, ATMs, vending machines and traffic lights — see [Elevator System](elevator-system.html).

There's a lighter version that is often the better answer in 40 minutes: an `enum` of states plus a `Map<State, Set<State>>` listing which moves are legal. Fewer classes, same guarantee. Say you'd start there and move to state classes when each state grows real behaviour.

## Decorator — wrap to add behaviour

**The problem:** optional extras that combine freely. Subclassing every combination explodes, as it did in [Objects, in practice](oop-refresher.html).

**The idea:** each extra *wraps* the thing it decorates and adds a little on top.

```java
interface Coffee { Money cost(); String description(); }

class Espresso implements Coffee { /* the base drink */ }

abstract class CoffeeAddOn implements Coffee {
    protected final Coffee inner;                      // the thing being wrapped
    protected CoffeeAddOn(Coffee inner) { this.inner = inner; }
}

class Milk extends CoffeeAddOn {
    public Money cost() { return inner.cost().plus(Money.of(50)); }
    public String description() { return inner.description() + " + milk"; }
}

Coffee order = new Milk(new Caramel(new Espresso()));   // composes instead of exploding
```

Two real examples worth mentioning: Java's `new BufferedInputStream(new FileInputStream(...))`, and web middleware chains (auth → logging → rate limit → handler), which are the same idea one level up.

## Singleton — know the objections or skip it

**The problem:** you want exactly one instance of something, reachable from anywhere.

```java
enum ConfigStore { INSTANCE;  /* thread-safe and concise */ }
```

The enum version is the one to write. The older double-checked-locking version is a classic quiz question — know that the field must be `volatile`, and that most codebases have moved on.

:::warn Say the downside before they do
Singleton is the pattern most likely to be used against you. It is global state that anything can change: it makes testing hard (no way to substitute a fake), it hides what a class actually depends on, and under threads it becomes a bottleneck.

The senior answer: *"I'd have one instance, but I'd create it at startup and pass it in, rather than a static `getInstance()`. Same single instance, still testable, no global state."*
:::

## Builder — construction with many options

**The problem:** a constructor with eight parameters, half optional, and callers writing `null, null, false, null`.

```java
Pizza p = new Pizza.Builder(Size.LARGE)
        .thinCrust()
        .addTopping(MUSHROOM)
        .addTopping(OLIVE)
        .extraCheese()
        .build();                      // all the checking happens here, once
```

The point to make: **the object is only ever handed out in a valid state.** `build()` verifies the rules, so a half-built pizza never escapes. It also lets the finished object be immutable, which the threading question will thank you for.

## Adapter, Command, Repository — the quick three

**Adapter** wraps something with the wrong interface so it fits yours. The trigger is always integration: *"we also need to support Stripe"* or *"there's this old library"*. `class StripeAdapter implements PaymentGateway { private final StripeClient stripe; ... }`. One class, one sentence, done.

**Command** turns an action into an object: `interface Command { void execute(); void undo(); }`. Trigger words: undo, redo, job queue, scheduling, macro, audit log. If a problem mentions undo, this is the answer and there isn't a close second.

**Repository** is a collection-shaped interface hiding where data actually lives: `interface SpotRepository { Optional<Spot> findFreeSpot(VehicleSize s); void save(Spot s); }`. In an interview it lets you say "I'll assume an in-memory implementation, with a database behind it in production" and move on without designing a schema nobody asked for.

## Using patterns without sounding like a catalogue

```viz
{
  "type": "compare",
  "caption": "Same knowledge, very different scores.",
  "left": {
    "title": "Sounds memorised",
    "items": [
      "\"I'll use the Strategy pattern here.\"",
      "Names five patterns in the first minute",
      "Adds an interface with one implementation",
      "Can't say what breaks without it"
    ]
  },
  "right": {
    "title": "Sounds experienced",
    "items": [
      "\"Pricing changes often, so it goes behind an interface.\"",
      "Names one when the requirement forces it",
      "Adds an interface where a second version is coming",
      "\"Otherwise every new rule edits the fee method.\""
    ]
  }
}
```

Three rules:

1. **Requirement first, pattern second.** Always state the pressure ("payment methods will grow") before the name ("so, strategy").
2. **One or two, used properly.** A design using strategy and observer well beats one that name-drops six.
3. **Be willing to not use one.** *"I could put a factory here, but there's only one implementation, so I'd keep it simple until there's a second."* That sentence shows judgement, which is the thing being graded.

:::exercise Trigger drill
Cover the table at the top and answer in five seconds each: (a) "users can undo their last move"; (b) "the fee is different at weekends"; (c) "when a ride is booked, tell the driver, the rider and analytics"; (d) "support our own SMS gateway and Twilio"; (e) "a lift behaves differently when it's already going up".

Answers: command · strategy · observer · adapter · state.
:::
