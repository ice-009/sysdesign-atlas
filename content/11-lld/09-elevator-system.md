---
title: Design a Lift System
summary: The state-machine problem — two kinds of request, a lift that only moves in legal ways, a swappable rule for choosing which lift answers, and one thread per car.
difficulty: Medium
scope: LLD
tags: [lld-problem, state-machine, scheduling, concurrency]
prereqs: [parking-lot, design-patterns]
unlocks: Modelling objects whose behaviour depends on their current state, with the decision-making rule kept separate.
---

:::predict Guess first
1. A lift has requests for floors 9, 2 and 7, made in that order, and it is on floor 5 going up. Which floor should it visit first?
2. Someone presses "up" on floor 3. Should that call belong to a particular lift the moment it's pressed?
3. Button presses arrive on many threads. Does each lift's state need a lock?
:::

Parking lot tests breaking a problem into classes. This one tests **state and policy**: an object whose allowed actions depend on what it's currently doing, plus a decision with no single right answer. Interviewers like it because the obvious design — a boolean called `isMoving` and a list of floors — collapses the moment they add a requirement.

:::interview What's really being tested
Two things. First: do you model states properly, or accumulate booleans? Second: when asked "which lift answers this call?", do you say "the nearest one" and stop, or do you notice that this is a *policy* and put it behind an interface? The second one is the seniority tell.
:::

## 1 · Requirements (0–5)

**Ask first:** how many lifts and floors? both the buttons in the lobby and the buttons inside? do doors need timing? is this a simulation or real hardware?

Assume: a building with F floors and N lifts, both kinds of button, doors modelled roughly, one program.

**What it must do**
- Someone presses **up or down on a floor** (an outside call) or **a floor button inside a lift** (an inside request).
- The system picks a lift for each outside call, and each lift serves its own requests in a sensible order.
- Doors open on arrival, stay open a moment, then close.
- A moving lift keeps going in its current direction while it still has requests that way. This is the rule that makes it feel like a lift rather than a taxi.

**Qualities that shape the design**
- Illegal moves must be impossible — never moving with the doors open.
- The rule for choosing a lift must be swappable.
- Adding a lift must not change any existing class.

**Out of scope:** weight sensors, fire-service override, maintenance mode. Mention them as easy additions.

## 2 · Classes and states (5–12)

```diagram
   ElevatorSystem      elevators[], floors, dispatcher
   Elevator            id, currentFloor, direction, doorState, requests, state
   Request             targetFloor, source (INSIDE | OUTSIDE), direction?
   Door                OPEN | CLOSED
   Display / Button    one per floor and per car

   enum Direction  { UP, DOWN, IDLE }
   enum CarState   { IDLE, MOVING, DOORS_OPEN, OUT_OF_SERVICE }
```

The decision that matters, said out loud:

> "There are two kinds of request and they're genuinely different. An **inside** request means 'take *this* lift to floor 7' — it already belongs to one car. An **outside** request means 'someone on floor 3 wants to go up' — it belongs to no car yet, and choosing which one goes is the interesting decision. Treating them as the same thing is what makes this design collapse."

## 3 · The state machine (12–20)

A **state machine** is just an object that can be in one of a few named states, with rules about which state can follow which. Draw the moves — a table beats prose here, and it makes "doors open while moving" impossible by construction.

```diagram
        ┌──────────────────────── request arrives ─────────────────┐
        │                                                          ▼
   ┌────────┐   has a request  ┌────────┐   arrived at target ┌──────────────┐
   │  IDLE  │ ───────────────▶ │ MOVING │ ──────────────────▶ │  DOORS_OPEN  │
   └────────┘                  └────────┘                     └──────┬───────┘
        ▲                           ▲                                │
        │    nothing left to do     │       doors close after a beat  │
        └───────────────────────────┴────────────────────────────────┘

   Rules that must always hold:
     · MOVING          ⇒ doors are CLOSED
     · DOORS_OPEN      ⇒ the car is not moving
     · direction changes only when idle, or when nothing remains ahead
```

Two ways to build it, and you should say which you'd pick and why:

```java
// A · Enum plus a table of legal moves. Fewer classes, quick to write.
enum CarState {
    IDLE, MOVING, DOORS_OPEN, OUT_OF_SERVICE;
    private static final Map<CarState, Set<CarState>> ALLOWED = Map.of(
        IDLE,           EnumSet.of(MOVING, DOORS_OPEN, OUT_OF_SERVICE),
        MOVING,         EnumSet.of(DOORS_OPEN, OUT_OF_SERVICE),
        DOORS_OPEN,     EnumSet.of(IDLE, MOVING, OUT_OF_SERVICE),
        OUT_OF_SERVICE, EnumSet.of(IDLE));

    void checkTransition(CarState to) {
        if (!ALLOWED.get(this).contains(to)) throw new IllegalTransitionException(this, to);
    }
}

// B · A class per state. Better once each state has real behaviour.
interface ElevatorState {
    ElevatorState step(Elevator e);
    ElevatorState onRequest(Elevator e, Request r);
}
class Moving implements ElevatorState {
    public ElevatorState step(Elevator e) {
        e.moveOneFloor();
        return e.shouldStopHere() ? new DoorsOpen() : this;
    }
    public ElevatorState onRequest(Elevator e, Request r) {
        e.addRequest(r);                 // just absorbed; no change of state
        return this;
    }
}
```

**Say this:** *"I'd start with the enum and the table — it's compact and the legal moves live in one place. If the per-state behaviour grows past a couple of branches, I'd promote each state to its own class."* That shows you know the pattern *and* when it's overkill.

## 4 · Choosing which lift (20–30)

Two separate decisions, and keeping them apart is most of the score:

**(a) Which lift answers an outside call?** — across all the lifts.
**(b) In what order does one lift serve its own list?** — inside a single lift.

```java
/** (a) Choosing between lifts. This is the interface they're looking for. */
interface DispatchStrategy {
    Optional<Elevator> selectFor(ExternalRequest r, List<Elevator> cars);
}

class NearestCarDispatch implements DispatchStrategy {
    public Optional<Elevator> selectFor(ExternalRequest r, List<Elevator> cars) {
        return cars.stream()
                .filter(Elevator::inService)
                .min(Comparator.comparingInt(c -> cost(c, r)));
    }

    /** Distance, with a penalty if the car is heading the wrong way. */
    private int cost(Elevator c, ExternalRequest r) {
        int distance = Math.abs(c.currentFloor() - r.floor());
        boolean sameWay = c.direction() == Direction.IDLE
                || (c.direction() == r.direction() && c.isApproaching(r.floor()));
        return sameWay ? distance : distance + PENALTY;
    }
}

class LeastLoadedDispatch implements DispatchStrategy { }   // fewest stops pending
class ZonedDispatch implements DispatchStrategy { }         // each car owns a floor range
```

**(b) The order within one lift** is the classic **lift algorithm** (also called SCAN — it's the same algorithm used for disk head scheduling, which is a nice thing to name):

```java
class Elevator {
    private final TreeSet<Integer> up   = new TreeSet<>();   // stops above, ascending
    private final TreeSet<Integer> down = new TreeSet<>(reverseOrder());

    void addRequest(int floor) {
        (floor > currentFloor ? up : down).add(floor);
    }

    Optional<Integer> nextStop() {                            // finish this way, then turn
        if (direction == UP)   return firstOf(up).or(() -> firstOf(down));
        if (direction == DOWN) return firstOf(down).or(() -> firstOf(up));
        return firstOf(up).or(() -> firstOf(down));
    }
}
```

**Say this:** *"Serving requests in the order they arrived would make the lift bounce up and down. Going as far as needed in one direction, serving everything on the way, then reversing, is what real lifts do — and it caps the worst wait at roughly two full trips."*

:::tip Ask what you're optimising for
"Nearest lift" is only obviously right if the goal is *this* passenger's wait. Ask, or state your assumption: average wait, worst wait, throughput at peak, or energy.

Rush hour in an office tower is a different problem from a hospital at 3am — zoning and parking idle cars in the lobby beat nearest-car when the traffic is predictable. One sentence like that moves you from "solving a puzzle" to "designing a system".
:::

## 5 · Threads — one per lift (30–36)

Button presses arrive on many threads. Each lift's state must have exactly one writer.

```java
class ElevatorController implements Runnable {
    private final Elevator car;
    private final BlockingQueue<Request> inbox = new LinkedBlockingQueue<>();

    void submit(Request r) { inbox.offer(r); }     // any thread, never blocks

    public void run() {                            // exactly one thread per car
        while (running) {
            Request r = inbox.poll(TICK_MS, MILLISECONDS);
            if (r != null) car.addRequest(r.floor());
            car.step();                            // move a floor, or open, or close
        }
    }
}
```

**Say this:** *"A lift's own state is touched by one thread only, so it needs no locks — other threads just drop requests into its queue. The dispatcher is the one genuinely shared piece, and it only reads a snapshot of each car, so a slightly stale reading costs a slightly worse choice, never a broken lift."*

That last clause matters: **say what a race would actually cost.** Sometimes the honest answer is "a worse decision, not a wrong one", and noticing that is stronger than locking everything.

## 6 · Extensions (36–42)

**"Add express lifts that only serve floors 20–40."**
> "A set of servable floors on the lift, and the dispatcher filters on it. No new state and no change to the state machine — one filter in one strategy."

**"Handle the morning rush."**
> "Swap the dispatch strategy for a zoned one that sends idle cars back to the ground floor. Because the choice sits behind an interface, that's a new class plus a config switch — I could even pick it by time of day."

**"Fire alarm."**
> "A system-wide command that puts every car into 'return to ground': clear the queues, ignore new outside calls, travel to the ground floor, open the doors, go out of service. This is the one place I'd allow an override of normal rules, and I'd model it as a real state rather than a flag."

**"A lift breaks down mid-journey."**
> "It goes out of service. The requests from people inside it are lost — they get out at the current floor — but its *outside* calls can be handed to another lift. Which is exactly why outside requests must not belong to a car until the moment of dispatch. That earlier modelling choice pays off here."

:::goat What separates a good answer
A mediocre answer models one lift well. A good one separates **the car** (a state machine serving its own list) from **the system** (a dispatcher choosing between cars), and puts the second behind an interface.

Once that split exists, every follow-up — express lifts, rush hour, zoning, breakdowns — lands in exactly one place. Without it, each follow-up rewrites your main loop.
:::

:::exercise Fifteen-minute drill
Design a **vending machine**: same skeleton, states IDLE → SELECTING → PAYING → DISPENSING → IDLE, with a policy interface for change-making. Time yourself: classes, state table, policy interface, one walkthrough, one sentence on threads.
:::

## Check yourself

```recall
Q: What two things does the lift problem test?
A: Modelling states properly instead of accumulating booleans, and noticing that "which lift answers" is a policy that belongs behind an interface.

Q: Why must inside and outside requests be modelled differently?
A: An inside request already belongs to one car. An outside call belongs to no car until dispatch — so if a lift breaks down, its outside calls can be reassigned.

Q: What rules must the lift state machine guarantee?
A: Moving implies doors closed, doors open implies not moving, and direction changes only when idle or when nothing remains ahead.

Q: Enum-plus-table versus a class per state?
A: Start with an enum and a map of legal transitions — compact, with the rules in one place. Promote each state to its own class once per-state behaviour grows.

Q: What are the two separate scheduling decisions?
A: Which lift answers an outside call (a DispatchStrategy across cars — nearest with wrong-direction penalty, least loaded, zoned), and the order one lift serves its own stops.

Q: What is the lift (SCAN) algorithm?
A: Keep going in the current direction, serving every stop on the way, then reverse. Two sorted sets (up ascending, down descending) implement it; it avoids bouncing and bounds the worst wait to about two full trips.

Q: How are lift threads organised, and what does a dispatcher race cost?
A: One thread per car drains its queue, so each car's state has one writer and needs no locks. The dispatcher reads snapshots; a stale reading costs a slightly worse choice, never a broken lift.

Q: How do you handle a fire alarm?
A: A system-wide command into a real "return to ground" state: clear queues, ignore outside calls, go to the ground floor, open doors, go out of service.
```

## What to carry forward

- Separate the car (a state machine serving its own stops) from the system (a dispatcher choosing cars).
- Outside calls belong to no car until dispatch — that choice pays off on breakdowns.
- Make illegal moves impossible with a transition table; promote to state classes only when needed.
- SCAN orders one car's stops; dispatch policy sits behind an interface — ask what you're optimising.
- One thread per car means no locks; say what a race would actually cost.
