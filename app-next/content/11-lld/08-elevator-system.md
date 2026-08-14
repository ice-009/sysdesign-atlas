---
title: Design an Elevator System
summary: The state-machine problem — request types, the scheduling policy behind an interface, one owning thread per car, and how to answer "which elevator do you send?" without hand-waving.
difficulty: Medium
tags: [lld-problem, state-machine, scheduling, concurrency]
prereqs: [parking-lot, design-patterns]
unlocks: Modelling lifecycle-driven systems with explicit states and a swappable scheduling policy.
---

Parking lot tests decomposition. Elevator tests **state and policy**: an object whose legal actions depend on what it's currently doing, plus a dispatch decision with no single right answer. Interviewers like it because the naive design (a boolean `isMoving` and a list of floors) falls apart the moment they add a requirement.

:::interview Why this question
Two things are being watched. First: do you model states explicitly, or accumulate booleans? Second: when asked "which elevator answers this call?", do you say "the nearest one" and stop, or do you recognise that dispatch is a *policy* and put it behind an interface? The second one is the seniority tell.
:::

## 1 · Requirements (0–5)

**Ask first:** how many elevators and floors? external (hall) and internal (car) buttons both? do we need door timing? is this simulation or real hardware control?

Assume: a building with F floors and N elevators, both button types, doors modelled coarsely, single process.

**Functional**
- A rider presses **up/down on a floor** (external call) or **a floor button inside a car** (internal request).
- The system picks an elevator for each external call and each car serves its requests in a sensible order.
- Doors open on arrival, stay open briefly, then close.
- A car in motion continues in its direction while it has requests that way (this is the rule that makes it feel like an elevator rather than a taxi).

**Non-functional**
- Illegal transitions must be impossible — no moving with the doors open.
- Dispatch policy is swappable (nearest-car today, load-balanced or energy-optimal later).
- Adding an elevator must not change any existing class.

**Out of scope:** weight sensors, fire-service override, maintenance mode (mention them as easy additions).

## 2 · Entities and states (5–12)

```diagram
   ElevatorSystem      elevators[], floors, dispatcher
   Elevator            id, currentFloor, direction, doorState, requests, state
   Request             targetFloor, source (INTERNAL | EXTERNAL), direction?
   Door                OPEN | CLOSING | CLOSED
   Display / Button    per floor and per car

   enum Direction  { UP, DOWN, IDLE }
   enum DoorState  { OPEN, CLOSED }
   enum CarState   { IDLE, MOVING, DOORS_OPEN, OUT_OF_SERVICE }
```

The critical modelling decision, stated out loud:

> "Two kinds of request, and they're genuinely different. An **internal** request is 'take *this* car to floor 7' — it's bound to a car. An **external** request is 'someone on floor 3 wants to go up' — it isn't bound to any car yet, and choosing which car serves it is the dispatch decision. Conflating them is the mistake that makes the design collapse."

## 3 · The state machine (12–20)

Draw the transitions. An explicit table is worth more than prose, and it makes the "doors open while moving" bug structurally impossible.

```diagram
        ┌──────────────────────────── request arrives ─────────────┐
        │                                                          ▼
   ┌────────┐   has request    ┌────────┐   reached target   ┌──────────────┐
   │  IDLE  │ ───────────────▶ │ MOVING │ ─────────────────▶ │  DOORS_OPEN  │
   └────────┘                  └────────┘                    └──────┬───────┘
        ▲                           ▲                                │
        │      no requests left     │        timeout, doors close    │
        └───────────────────────────┴────────────────────────────────┘

   Invariants:
     · MOVING ⇒ doors CLOSED
     · DOORS_OPEN ⇒ speed 0
     · direction changes only in IDLE or when the request set ahead is empty
```

Two implementations, and you should say which you'd choose and why:

```java
// A · Enum + transition table. Fewer classes, fast to write, good for 40 minutes.
enum CarState {
    IDLE, MOVING, DOORS_OPEN, OUT_OF_SERVICE;
    private static final Map<CarState, Set<CarState>> ALLOWED = Map.of(
        IDLE,       EnumSet.of(MOVING, DOORS_OPEN, OUT_OF_SERVICE),
        MOVING,     EnumSet.of(DOORS_OPEN, OUT_OF_SERVICE),
        DOORS_OPEN, EnumSet.of(IDLE, MOVING, OUT_OF_SERVICE),
        OUT_OF_SERVICE, EnumSet.of(IDLE));

    void checkTransition(CarState to) {
        if (!ALLOWED.get(this).contains(to)) throw new IllegalTransitionException(this, to);
    }
}

// B · State pattern. Better when each state has real behaviour.
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
        e.addRequest(r);                 // absorbed; no transition
        return this;
    }
}
```

**Say this:** *"I'd start with the enum plus transition table — it's compact and the legal-transition rule lives in one place. If per-state behaviour grows past a couple of branches, I'd promote each state to a class."* That answer shows you know the pattern *and* when it's overkill.

## 4 · The scheduling policy (20–30)

Two distinct decisions, and separating them is most of the score:

**(a) Which car serves an external call?** — the dispatcher, across cars.
**(b) In what order does one car serve its own requests?** — the car's internal scan.

```java
/** (a) Cross-car dispatch. The axis of variation the interviewer is looking for. */
interface DispatchStrategy {
    Optional<Elevator> selectFor(ExternalRequest r, List<Elevator> cars);
}

class NearestCarDispatch implements DispatchStrategy {
    public Optional<Elevator> selectFor(ExternalRequest r, List<Elevator> cars) {
        return cars.stream()
                .filter(Elevator::inService)
                .min(Comparator.comparingInt(c -> cost(c, r)));
    }

    /** Distance, penalised when the car is heading the wrong way. */
    private int cost(Elevator c, ExternalRequest r) {
        int distance = Math.abs(c.currentFloor() - r.floor());
        boolean sameWay = c.direction() == Direction.IDLE
                || (c.direction() == r.direction() && c.isApproaching(r.floor()));
        return sameWay ? distance : distance + PENALTY;
    }
}

class LeastLoadedDispatch implements DispatchStrategy { }   // fewest pending stops
class ZonedDispatch implements DispatchStrategy { }         // cars own floor ranges
```

**(b) The per-car order** is the classic **elevator (SCAN) algorithm** — the same disk-scheduling algorithm, which is a nice thing to name:

```java
class Elevator {
    private final TreeSet<Integer> up   = new TreeSet<>();   // stops above, ascending
    private final TreeSet<Integer> down = new TreeSet<>(reverseOrder());

    void addRequest(int floor) {
        (floor > currentFloor ? up : down).add(floor);
    }

    Optional<Integer> nextStop() {                            // keep going, then reverse
        if (direction == UP)   return firstOf(up).or(() -> firstOf(down));
        if (direction == DOWN) return firstOf(down).or(() -> firstOf(up));
        return firstOf(up).or(() -> firstOf(down));
    }
}
```

**Say this:** *"Serving requests in arrival order would make the car yo-yo. SCAN — continue in the current direction, serve everything on the way, then reverse — is what real elevators do, and it bounds the worst-case wait at roughly two traversals."*

:::tip Name the metric you're optimising
"Nearest car" is only obviously right if the metric is *this rider's wait*. Ask, or state your assumption: average wait, worst-case wait, throughput at peak, or energy. Morning rush in an office tower is a different optimisation from a hospital at 3am — zoning and parking idle cars near the lobby beat nearest-car when traffic is predictable. One sentence like that reframes you from "answering a puzzle" to "designing a system".
:::

## 5 · Concurrency — one thread per car (30–36)

Requests arrive from buttons on many threads; each car's state must have exactly one writer.

```java
class ElevatorController implements Runnable {
    private final Elevator car;
    private final BlockingQueue<Request> inbox = new LinkedBlockingQueue<>();

    void submit(Request r) { inbox.offer(r); }     // any thread, non-blocking

    public void run() {                            // exactly one thread per car
        while (running) {
            Request r = inbox.poll(TICK_MS, MILLISECONDS);
            if (r != null) car.addRequest(r.floor());
            car.step();                            // move one floor / open / close
        }
    }
}
```

**Say this:** *"The car's internal state is confined to its own thread, so it needs no locks — external threads only hand off through a queue. The dispatcher is the one genuinely shared component, and it only reads car snapshots, so a stale read costs a slightly worse dispatch, never a corrupt state."*

That last clause matters: **name what a race actually costs.** Sometimes the honest answer is "a suboptimal decision, not an incorrect one", and recognising that is a stronger answer than locking everything.

## 6 · Extensions (36–42)

**"Add express elevators that only serve floors 20–40."**
> "A `Set<Integer> servableFloors` (or a floor-range predicate) on the elevator, and the dispatcher filters on it. No new state, no changes to the state machine — one filter in one strategy."

**"Handle peak morning traffic."**
> "Swap the dispatch strategy — a zoned or lobby-parking policy that returns idle cars to the ground floor. Because dispatch is behind an interface, that's a new implementation plus a config switch; I could even choose it by time of day with a composite strategy."

**"Fire alarm / emergency."**
> "A system-level command that puts every car into a `RETURN_TO_GROUND` mode: clear the request queues, ignore new external calls, run to the ground floor, open doors, enter `OUT_OF_SERVICE`. This is the one place I'd allow a state override, and I'd model it explicitly rather than as a boolean flag."

**"A car breaks down mid-journey."**
> "It transitions to `OUT_OF_SERVICE`. Its internal requests are lost — riders inside get out at the current floor — but its *external* requests can be reassigned, which is exactly why external requests must not be owned by a car until the moment of dispatch. That modelling choice pays off here."

:::goat What separates a good elevator answer
The mediocre answer models one elevator well. The good answer separates **the car** (a state machine that serves its own requests) from **the system** (a dispatcher choosing between cars), and puts the second one behind an interface. Once that split exists, every follow-up — express cars, peak traffic, zoning, breakdowns — lands in exactly one place. Without it, each follow-up rewrites your core loop.
:::

:::exercise Fifteen-minute drill
Design a **lift for a car park with a queue of vehicles**, or a **vending machine** — both are the same state-machine skeleton (IDLE → SELECTING → PAYING → DISPENSING → IDLE) with a policy interface. Time yourself: entities, state table, policy interface, one walkthrough, concurrency sentence.
:::
