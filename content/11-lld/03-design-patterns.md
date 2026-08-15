---
title: The Patterns Worth Knowing
summary: The ten design patterns that account for almost every LLD interview — each with the problem it solves, minimal code, and the interview prompt that should trigger it.
difficulty: Medium
scope: LLD
tags: [patterns, oop, lld]
prereqs: [solid]
unlocks: Reaching for the right pattern by recognising the requirement that calls for it, instead of listing patterns from memory.
---

There are twenty-three Gang of Four patterns. In an SDE-2 LLD round you will use about six, recognise four more, and be actively penalised for the rest. This page is the working set, organised by **the trigger phrase in the requirements** — because that's how you have to retrieve them under pressure.

| If the requirement says… | Reach for | Why |
|---|---|---|
| "…depending on the type / configurable / different rules" | **Strategy** | Swap an algorithm at runtime |
| "…create the right kind of X based on input" | **Factory** | One place that knows the mapping |
| "…notify / update everyone when Y happens" | **Observer** | One-to-many, decoupled |
| "…it behaves differently while it's in state Z" | **State** | Legal transitions, no boolean soup |
| "…optionally add toppings / features / wrapping" | **Decorator** | Compose behaviour without subclass explosion |
| "…there must be exactly one" | **Singleton** | (Carefully — see below) |
| "…many optional parameters" | **Builder** | Readable construction, validate at build |
| "…integrate with this third party / legacy thing" | **Adapter** | Translate an incompatible interface |
| "…undo / queue / schedule an action" | **Command** | Reify the action as an object |
| "…where does the data come from" | **Repository** | A collection-like façade over storage |

## Strategy — the one you'll use most

**Problem:** an algorithm varies, and you don't want a switch in the caller.

```java
interface ParkingFeeStrategy {
    Money calculate(Duration parked, VehicleSize size);
}

class HourlyFee implements ParkingFeeStrategy {
    public Money calculate(Duration d, VehicleSize s) {
        long hours = Math.max(1, d.toHours());            // round up, min 1
        return RATES.get(s).times(hours);
    }
}

class FlatDayFee implements ParkingFeeStrategy { /* ... */ }

class ExitTerminal {
    private final ParkingFeeStrategy pricing;             // injected
    Money checkout(Ticket t) { return pricing.calculate(t.duration(), t.size()); }
}
```

**Say this:** *"Pricing is the requirement most likely to change, so it goes behind a strategy. A weekend surcharge is a new class, not an edit."*

Strategy is the workhorse because almost every LLD problem hides one: pricing, matching, ranking, eviction, retry, routing, scheduling, discounting, splitting. When you're stuck for something intelligent to say about extensibility, ask yourself what the *policy* in this system is — and put it behind an interface.

## Factory — one place that knows how to build

Two forms, and the distinction is worth knowing:

- **Simple/static factory** — one method that maps input to a concrete class. This is what you want in an interview 90% of the time.
- **Abstract factory** — a family of related products built together (a whole `MacUiKit` vs `WindowsUiKit`). Rarely justified; mention only if the problem really has families.

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

**Say this:** *"The factory is the one place allowed to know every concrete channel — that keeps the `instanceof`-shaped knowledge from spreading."*

## Observer — fan-out without coupling

**Problem:** when something happens, N unrelated things must react, and the source shouldn't know about them.

```java
interface OrderListener { void onEvent(OrderEvent e); }

class Order {
    private final List<OrderListener> listeners = new CopyOnWriteArrayList<>();

    void addListener(OrderListener l) { listeners.add(l); }

    private void publish(OrderEvent e) {
        for (OrderListener l : listeners) l.onEvent(e);   // see the caveat
    }
}

// Listeners: InventoryUpdater, EmailNotifier, AnalyticsLogger, LoyaltyPoints…
```

**Say this:** *"Order placement publishes an event; inventory, email, and analytics each subscribe. Adding loyalty points later doesn't touch `Order`."*

:::trap The observer follow-up
Two questions come almost every time. **"What if a listener throws?"** — one bad listener must not break the others or the publisher: catch per listener, log, continue. **"What if a listener is slow?"** — synchronous notification makes the publisher as slow as its slowest subscriber; hand off to an executor or a queue. Note the direct line to HLD: this is exactly why real systems put a message broker here. See [Message Queues](../building-blocks/message-queues.html) and [Pub/Sub](../building-blocks/pub-sub.html).
:::

## State — behaviour that depends on lifecycle

**Problem:** an object behaves differently by phase, and you're growing a thicket of booleans.

```java
// The smell: isPaid, isShipped, isCancelled, and every combination checked by hand.

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
    public OrderState cancel(Order o) { throw new IllegalTransitionException("ship in transit"); }
}
```

The payoff to name: **illegal transitions become impossible rather than merely unlikely**, and the transition table is readable in one place. This is the pattern for elevators, orders, bookings, ATMs, vending machines, and traffic lights — see [Elevator System](elevator-system.html).

A lighter alternative that's often the better answer for a 40-minute round: an `enum State` plus an explicit `Map<State, Set<State>> ALLOWED` transition table. Fewer classes, same guarantee. Say you'd start there and move to state objects when per-state behaviour grows.

## Decorator — stack behaviour at runtime

**Problem:** optional features combine, and subclassing every combination explodes.

```java
interface Coffee { Money cost(); String description(); }

class Espresso implements Coffee { /* base */ }

abstract class CoffeeAddOn implements Coffee {
    protected final Coffee inner;
    protected CoffeeAddOn(Coffee inner) { this.inner = inner; }
}

class Milk extends CoffeeAddOn {
    public Money cost() { return inner.cost().plus(Money.of(50)); }
    public String description() { return inner.description() + " + milk"; }
}

Coffee order = new Milk(new Caramel(new Espresso()));   // composes, not explodes
```

Real-world hooks worth mentioning: Java's `BufferedInputStream(new FileInputStream(...))`, and HTTP middleware chains (auth → logging → rate limit → handler) which are the same idea one level up.

## Singleton — know the caveats or skip it

**Problem:** exactly one instance, globally reachable.

```java
enum ConfigStore { INSTANCE;  /* thread-safe, serialization-safe, concise */ }
```

The enum form is the one to write. The double-checked-locking `volatile` version is a classic quiz question — know that `volatile` is required, and that most codebases have moved on.

:::warn Say the downside before they do
Singleton is the pattern most likely to be used *against* you. It's global mutable state: it makes testing hard (no way to substitute a fake), hides dependencies (the class's needs aren't in its constructor), and becomes a contention point under concurrency. The senior answer: *"I'd have one instance, but I'd create it at the composition root and inject it, rather than a static `getInstance()` — same single instance, no global state."*
:::

## Builder — construction with many options

**Problem:** a constructor with eight parameters, half of them optional, and callers passing `null, null, false, null`.

```java
Pizza p = new Pizza.Builder(Size.LARGE)
        .thinCrust()
        .addTopping(MUSHROOM)
        .addTopping(OLIVE)
        .extraCheese()
        .build();                      // validation happens here, once
```

The point to make: **the object is only ever handed out valid.** `build()` checks the invariants; there is no half-constructed pizza in circulation. It also lets the built object be immutable, which the concurrency follow-up will thank you for.

## Adapter, Command, Repository — the quick three

**Adapter** wraps an incompatible interface into the one your code expects. The interview trigger is always integration: *"we also need to support Stripe/this legacy SDK"*. `class StripeAdapter implements PaymentGateway { private final StripeClient stripe; ... }`. One class, one sentence, done.

**Command** turns an action into an object: `interface Command { void execute(); void undo(); }`. Trigger words: undo/redo, job queue, scheduling, macro, transaction log. If a problem mentions undo, this is the answer and there is no second-best.

**Repository** is a collection-shaped interface over persistence: `interface SpotRepository { Optional<Spot> findFreeSpot(VehicleSize s); void save(Spot s); }`. In an LLD round it lets you say "I'll assume an in-memory implementation, backed by a database in production" and move on without designing a schema you weren't asked for.

## How to use patterns without sounding like a catalogue

```viz
{
  "type": "compare",
  "caption": "Same knowledge, two very different scores.",
  "left": {
    "title": "Sounds memorised",
    "items": [
      "\"I'll use the Strategy pattern here.\"",
      "Names five patterns in the first minute",
      "Adds an interface with one implementation",
      "Can't say what would break without it"
    ]
  },
  "right": {
    "title": "Sounds experienced",
    "items": [
      "\"Pricing changes often, so it goes behind an interface — that's strategy.\"",
      "Names a pattern when the requirement forces it",
      "Adds an interface where a second impl is coming",
      "\"Without this, every new rule edits the fee switch.\""
    ]
  }
}
```

Three rules:

1. **Requirement first, pattern second.** Always state the pressure ("payment methods will grow") before the name ("so, strategy").
2. **One or two patterns, applied well.** A design using strategy and observer *correctly* beats one name-dropping six.
3. **Be willing to not use one.** *"I could put a factory here, but there's exactly one implementation, so I'd keep it concrete until there's a second."* That sentence signals judgement, which is the thing actually being graded.

:::exercise Trigger drill
Cover the table at the top and answer in five seconds each: (a) "users can undo their last move"; (b) "the fee is different on weekends"; (c) "when a ride is booked, notify the driver, the rider, and analytics"; (d) "we need to support both our own SMS gateway and Twilio"; (e) "a lift behaves differently when it's already moving up". Answers: command · strategy · observer · adapter · state.
:::
