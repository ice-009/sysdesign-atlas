---
title: Class Diagrams, Fast
summary: The small slice of UML an LLD round actually uses — the box, the five lines between boxes, multiplicity — and how to draw one on a whiteboard in five minutes without it turning into a poster.
difficulty: Easy
scope: LLD
tags: [uml, class-diagram, lld, fundamentals]
prereqs: [oop-refresher]
unlocks: Sketching your classes and their relationships quickly enough that the diagram helps the conversation instead of eating it.
---

:::predict Guess first
1. How many boxes should a class diagram drawn in an interview have — 5, 10 or 30?
2. Should a class diagram show every getter and setter?
3. A Floor is created by its ParkingLot and can't exist without it. A Player outlives the Team. Would you draw these the same way?
:::

UML is a big standard with fourteen kinds of diagram. An interview uses one of them — the class diagram — and only about a fifth of that. This page is that fifth. Learn it once and every LLD answer gets easier to explain, because the interviewer can *see* your design instead of holding it in their head.

## Why draw at all

Because talking about six classes and how they connect is hard to follow, and a picture is not. The diagram does three jobs:

- **It shows the nouns.** Which classes exist and what each one is for.
- **It shows who knows whom.** Which object holds a reference to which — the thing that decides how data flows.
- **It shows where things vary.** Interfaces with several implementations are where your extension points live.

It is *not* documentation. Nobody wants every getter. A good interview diagram has six to ten boxes, a handful of lines, and is finished in five minutes.

## The box

A class is a box with up to three compartments: name, fields, methods.

```diagram
   ┌────────────────────────────┐
   │ ParkingLot                 │   ← name
   ├────────────────────────────┤
   │ - floors: List<Floor>      │   ← fields   (name: Type)
   │ - pricing: PricingPolicy   │
   ├────────────────────────────┤
   │ + park(v: Vehicle): Ticket │   ← methods  (name(params): ReturnType)
   │ + leave(t: Ticket): Money  │
   └────────────────────────────┘

   +  public      -  private      #  protected      ~  package
```

Four small conventions carry most of the meaning:

| Marking | Means | Example |
|---|---|---|
| `«interface»` above the name | An interface, not a class | `«interface» PricingPolicy` |
| *Italic* name (or `{abstract}`) | Abstract class | *`Vehicle`* |
| Underlined member | Static | `instance(): Logger` |
| `«enum»` above the name | Enumeration, values listed as fields | `«enum» SpotSize` |

On a whiteboard, nobody can do italics. Write `«abstract»` or `(abstract)` above the name instead — it says the same thing and nobody will mind.

**What to leave out:** getters, setters, constructors, `toString`, and any field that only exists to support another field. Show the fields that *define* the object and the methods that *do something*.

## The five lines

This is the part people get wrong, and it's small. There are five relationships worth knowing. Each has its own line.

```diagram
   Inheritance       Car ──────▷ Vehicle              "a Car is a Vehicle"
   (generalisation)  solid line, hollow triangle at the parent

   Implementation    HourlyPricing ┄┄┄┄▷ «interface» PricingPolicy
   (realisation)     dashed line, hollow triangle at the interface

   Association       Ticket ──────> Spot              "a Ticket knows its Spot"
                     solid line, open arrow toward the one being known

   Composition       ParkingLot ◆────── Floor         "a Floor dies with its Lot"
                     filled diamond at the owner

   Aggregation       Team ◇────── Player              "a Player outlives the Team"
                     hollow diamond at the whole

   Dependency        Gate ┄┄┄┄> PaymentGateway        "uses it, keeps no ref"
                     dashed line, open arrow
```

How to tell them apart, in words you can say out loud:

- **Inheritance:** *"is a"*. Use it rarely — [Objects, in Practice](oop-refresher.html) explains why holding an object usually beats inheriting from one.
- **Implementation:** *"can be used as"*. This is the line you'll draw most often, because interfaces are where things vary.
- **Association:** *"has a reference to, and keeps it"*. A field.
- **Composition:** *"owns, and the part dies with it"*. A `Floor` is created by the `ParkingLot` and has no life outside it.
- **Aggregation:** *"groups, but doesn't own"*. Delete the `Team` and the `Player` still exists.
- **Dependency:** *"uses for a moment"*. A method parameter or a local variable, not a field.

:::trap Don't spend your time on diamonds
Composition versus aggregation is the distinction interviewers care about least. If you're unsure, draw a plain association line and move on. Nobody has failed an interview over a hollow diamond. Plenty have run out of time drawing perfect ones.

The two lines that *do* matter are **inheritance vs implementation** (is this a parent class or an interface?) and **association vs dependency** (does it keep a reference, or just use one?). Those change the code.
:::

## Multiplicity: how many

Put a number at each end of an association to say how many objects sit on that side.

```diagram
   ParkingLot 1 ◆──────── 1..* Floor        one lot has one or more floors
   Floor      1 ◆──────── *    Spot         one floor has any number of spots
   Spot       1 ──────── 0..1  Vehicle      a spot holds no vehicle or one
   Ticket     * ──────── 1     Spot         many tickets over time, one spot each

   1      exactly one          0..1   optional
   *      zero or more         1..*   at least one
```

Read it from the far end: *"each Floor has any number of Spots; each Spot belongs to exactly one Floor."* Multiplicity is where a diagram catches real bugs. Writing `0..1` on `Spot → Vehicle` is the moment you notice that a spot can be empty — which is exactly the case your `park` method has to handle.

## A whole diagram, start to finish

The parking lot from [Design a Parking Lot](parking-lot.html), drawn the way you would on a whiteboard:

```diagram
                    ┌───────────────────┐
                    │ ParkingLot        │
                    │ + park(v): Ticket │
                    │ + leave(t): Money │
                    └──┬─────────────┬──┘
                  1 ◆  │             │ 1
                       │             ▼
                  1..* │       ┌────────────────────┐
              ┌────────┴───┐   │ «interface»        │
              │ Floor      │   │ PricingPolicy      │
              │ + findSpot │   │ + price(t): Money  │
              └────────┬───┘   └─────────△──────────┘
                  1 ◆  │          ┊      ┊      ┊
                     * │       Hourly FlatRate Weekend
              ┌────────┴───┐
              │ Spot       │ 1        0..1 ┌────────────┐
              │ id, size   │───────────────│ Vehicle    │ (abstract)
              └────────────┘               └─────△──────┘
                                           Car  Bike  Truck
```

Notice what it says without a word of explanation: the lot owns floors, floors own spots, a spot may hold one vehicle, vehicles come in kinds, and **pricing is swappable** — the dashed lines into the interface. That last fact is the one an interviewer most wants to hear, and the diagram makes it impossible to miss.

## Drawing one in five minutes

The order matters more than the notation.

1. **Nouns first.** Read the requirements, list the nouns. Most become boxes. Write only the names.
2. **Find what varies.** Anything that comes in several kinds — payment methods, pricing rules, vehicle types — becomes an interface or an abstract class with children underneath.
3. **Connect.** Draw who holds whom. Add multiplicity only where it's interesting (`0..1`, `1..*`).
4. **Then the methods.** Two or three per class, the ones that do the work. Fields only where they define the object.
5. **Stop.** If you're drawing a seventh relationship between the same two boxes, you're decorating.

**Say this as you draw:** *"These are my main nouns. `PricingPolicy` is an interface because pricing is the thing most likely to change — new rules plug in without touching `ParkingLot`. A floor can't exist without its lot, so I'm showing that as composition."* Narration is half the grade. The diagram is the thing you narrate over.

## When it's a text box, not a whiteboard

Online rounds often happen in a shared document. Don't fight ASCII art; use a compact text form that reads the same way:

```diagram
   ParkingLot  ◆→ Floor[1..*]  → PricingPolicy
   Floor       ◆→ Spot[*]
   Spot        → Vehicle[0..1]
   Vehicle     (abstract)  ◁ Car, Bike, Truck
   PricingPolicy (interface) ◁┄ Hourly, FlatRate, Weekend
```

One line per class, arrows for references, `◁` for "is a", `◁┄` for "implements". It takes a minute, it's unambiguous, and the interviewer can follow it as you type.

## The other diagram you might need

Occasionally an interviewer asks *"walk me through what happens when a car arrives."* That's a **sequence diagram**: objects across the top, time running down, arrows for calls.

```diagram
   Gate          ParkingLot        Floor          Spot
    │  park(car)     │               │              │
    │──────────────► │  findSpot()   │              │
    │                │─────────────► │  isFree()    │
    │                │               │────────────► │
    │                │  spot         │ ◄────────────│
    │   ticket       │ ◄─────────────│              │
    │ ◄──────────────│               │              │
```

You don't need the formal notation. Boxes across the top and arrows down the page are enough to show the order of calls — which is what the question is really testing.

:::exercise Draw it cold
Without looking back, draw a class diagram for a library: books, copies of a book, members, loans, and fines. Then check yourself:

1. Is `Book` (the title) separate from `BookCopy` (the physical item)? What multiplicity sits between them?
2. Does a `Loan` know its copy and its member? Which way do the lines go?
3. Is the fine rule an interface, so a different rule can be swapped in?

[Design a Library Management System](library-management.html) works the full answer.
:::

## Check yourself

```recall
Q: What three jobs does an interview class diagram do?
A: It shows the nouns (classes), who holds a reference to whom, and where things vary (interfaces with several implementations). It is not documentation — six to ten boxes, five minutes.

Q: How do you draw inheritance versus implementation?
A: Inheritance: solid line with a hollow triangle at the parent ("is a"). Implementation: dashed line with a hollow triangle at the interface ("can be used as") — the line you'll draw most.

Q: Association versus dependency?
A: Association (solid line, open arrow) means it keeps a reference — a field. Dependency (dashed line, open arrow) means it uses it briefly — a parameter or local variable.

Q: Composition versus aggregation — and how much should you care?
A: Composition (filled diamond): the part dies with the owner. Aggregation (hollow diamond): the part outlives the whole. It's the distinction interviewers care least about; a plain association is fine if unsure.

Q: Why is multiplicity worth writing?
A: It catches real cases: writing 0..1 on Spot → Vehicle is when you notice a spot can be empty — exactly what park() must handle. Use 1, 0..1, *, 1..*.

Q: What order do you draw a diagram in?
A: Nouns, then what varies (interfaces or abstract classes), then connections with interesting multiplicity, then two or three key methods per class — then stop.

Q: What do you do in a text-only online round?
A: Use one line per class: ParkingLot ◆→ Floor[1..*] → PricingPolicy, ◁ for "is a", ◁┄ for "implements". For "walk me through it", sketch a sequence diagram: objects across the top, calls down the page.
```

## What to carry forward

- An interview diagram has six to ten boxes, drawn in five minutes, and you narrate over it.
- The lines that change code: inheritance versus implementation, association versus dependency.
- Don't spend time on diamonds; do write multiplicity where it reveals a case such as 0..1.
- Leave out getters, setters and constructors — show defining fields and methods that do work.
- Dashed lines into an interface show the extension point; point at it out loud.
