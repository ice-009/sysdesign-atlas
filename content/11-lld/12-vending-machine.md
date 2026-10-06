---
title: Design a Vending Machine
summary: The state-machine problem with money in it — choose, pay, dispense, give change — where the real test is never losing a coin, knowing before you sell whether you can make change, and keeping illegal moves impossible.
difficulty: Medium
scope: LLD
tags: [lld-problem, state-machine, money, strategy]
prereqs: [elevator-system, design-patterns]
unlocks: Handling money that's "in flight" safely, and the change-making question that catches out most candidates.
---

:::predict Guess first
1. A machine dispenses a drink and then discovers it can't make ₹7 change. What went wrong in the order of steps?
2. Coins are 1, 2 and 5, and the machine holds one ₹5, three ₹2s and no ₹1s. Change owed is ₹6. Does "biggest coin first" find it?
3. The motor jams after the customer paid. Where should their coins be at that moment?
:::

The [lift](elevator-system.html) taught states and policies. The vending machine adds the thing that makes interviewers lean forward: **money in the middle of a transaction**. Coins go in before the product comes out, the machine might not have the right change, and the motor might jam. A design that handles those three moments cleanly is a strong answer. One with a boolean called `isPaid` is not.

## 1 · Requirements (0–5)

**Ask first:** coins and notes only, or cards too? Choose first and then pay, or pay first? Does it give change? What happens when it can't?

Assume: coins and notes, choose first then pay, gives change, one customer at a time, an operator who restocks and empties the cash box.

**What it must do**
- Customer picks a product by its code (`B3`).
- Customer inserts money until the price is covered.
- Machine dispenses the product and returns change.
- Customer can cancel at any point before dispensing and get their money back.
- Operator can restock products, add change and collect cash — with sales paused.

**Qualities that shape the design**
- **Never lose money.** At the end of every session, either the customer has their product and exact change, or they have every coin back.
- **Never dispense without payment, never take payment without dispensing.**
- **Never get stuck.** Every state has a way out.

**Out of scope:** card payments (an extension), remote monitoring, product images.

## 2 · Classes (5–12)

```diagram
   VendingMachine     the façade customers and operators talk to
   Inventory          slot code → { Product, count }
   Product            code, name, Money price
   Coins              Denomination → count       (a small value type)
   CashBox            Coins: the machine's own money
   Escrow             Coins inserted this session, kept apart until the sale ends
   ChangeMaker        works out which coins to return            «interface»
   MachineState       Idle, Selected, Dispensing, OutOfService   «interface»

   enum Denomination { ONE(1), TWO(2), FIVE(5), TEN(10), TWENTY(20),
                       FIFTY(50), HUNDRED(100) }
```

Two decisions to say out loud:

**Escrow is separate from the cash box.** The coins a customer inserts are *theirs* until the sale completes. Keeping them apart makes cancel trivial — hand back exactly what's in escrow — and makes "never lose money" something you can check: `escrow + cashBox` before and after any operation must account for every coin.

**Money is whole rupees (or paise) in a `long`,** wrapped in a `Money` type. The reason is the same one [Splitwise](splitwise.html) gives: floating point drifts.

## 3 · The state machine (12–20)

Write the states and the legal moves down first. This table *is* the design.

```diagram
                select(code)               insert(money) [covered]
   ┌──────┐   ─────────────▶   ┌──────────┐ ───────────────────▶ ┌────────────┐
   │ IDLE │                    │ SELECTED │                      │ DISPENSING │
   └──────┘   ◀─────────────   └──────────┘                      └─────┬──────┘
      ▲  ▲       cancel()          │   ▲ insert(money)                 │
      │  │     (refund escrow)     └───┘ [not covered]                 │
      │  └─────────────────────────────────────────────────────────────┘
      │                product out, change returned  (or jam → refund)
      │
   ┌────────────────┐   operator: startService() from IDLE only
   │ OUT_OF_SERVICE │ ─── endService() ───▶ IDLE
   └────────────────┘

   Rules that must always hold:
     · DISPENSING is reached only when escrow ≥ price AND change can be made
     · insert() is refused in IDLE (nothing chosen) and in OUT_OF_SERVICE
     · OUT_OF_SERVICE is entered only from IDLE — never mid-sale
```

Each state behaves differently for the same button, which is exactly the case for the **state pattern** from [the patterns page](design-patterns.html): one class per state, each deciding what's allowed.

```java
interface MachineState {          // anything not overridden is refused
    default MachineState select(VendingMachine m, String code) {
        throw refused("select");
    }
    default MachineState insert(VendingMachine m, Denomination d) {
        throw refused("insert");
    }
    default MachineState cancel(VendingMachine m) {
        throw refused("cancel");
    }
}

class Idle implements MachineState {
    public MachineState select(VendingMachine m, String code) {
        Product p = m.inventory().available(code)
                     .orElseThrow(() -> new SoldOutException(code));
        m.choose(p);
        return new Selected();
    }
}

class Selected implements MachineState {
    public MachineState insert(VendingMachine m, Denomination d) {
        m.escrow().add(d);
        boolean covered = m.escrow().total().compareTo(m.chosen().price()) >= 0;
        if (!covered) return this;               // keep paying
        return m.tryToSell();            // DISPENSING, or IDLE with a refund
    }
    public MachineState cancel(VendingMachine m) {
        m.refundEscrow();
        return new Idle();
    }
    public MachineState select(VendingMachine m, String code) {
        // Changing your mind before paying in full is allowed.
        m.choose(m.inventory().available(code)
                   .orElseThrow(() -> new SoldOutException(code)));
        return this;
    }
}
```

The default methods throwing `refused(...)` are the point: **anything a state doesn't explicitly allow is illegal.** Pressing "insert" on an idle machine can't do something odd, because `Idle` never overrides `insert`.

:::tip Enum or classes?
For a machine with four states and a handful of buttons, the lighter version from the [lift](elevator-system.html) — an enum plus a table of legal moves — is a fine 40-minute answer. Say which you chose and why: *"Each state reacts differently to the same button, so I've given each its own class. If they were just labels, an enum and a table would do."*
:::

## 4 · Making change — the question behind the question (20–28)

Most candidates write `returnChange(amount)` and move on. The interviewer then asks: *"what if the machine doesn't have the coins?"* There are two separate traps here.

**Trap one — check before you sell, not after.** If you dispense first and then discover you can't make ₹7 change, the customer has lost money or you've given away stock. So `tryToSell()` works out the change *before* dispensing, from the cash box **plus** the coins in escrow (they're about to become the machine's):

```java
MachineState tryToSell() {
    Money change = escrow.total().minus(chosen.price());
    Coins available = cashBox.coins().plus(escrow.coins());

    Optional<Coins> coins = changeMaker.make(change, available);
    if (coins.isEmpty()) {
        refundEscrow();
        display("Exact change only");
        return new Idle();
    }
    plannedChange = coins.get();
    return new Dispensing();
}
```

**Trap two — the greedy method isn't always right.** "Give the biggest coin that fits, repeat" works for India's and the US's coins *when the machine has unlimited coins of each kind*. It fails in two cases:

```diagram
   1. Unusual denominations:  coins {1, 3, 4}, change 6
        greedy:  4 + 1 + 1   (3 coins)      best: 3 + 3   (2 coins)

   2. Limited stock:  coins {1, 2, 5}, change 6
                      the machine holds one 5, three 2s, no 1s
        greedy:  takes the 5, then needs a 1 → has none → "can't make change"
        but      2 + 2 + 2 works fine
```

The second case is the one that matters in a real machine, because stock *is* limited. So the honest answer is:

```java
interface ChangeMaker {
    /** Coins adding up to `amount` from `available`; empty if impossible. */
    Optional<Coins> make(Money amount, Coins available);
}

/** Greedy within stock: fast, usually right, may wrongly say "no". */
class GreedyChangeMaker implements ChangeMaker { ... }

/** Exact: searches combinations within stock. Tiny for vending-sized amounts. */
class BoundedChangeMaker implements ChangeMaker {
    public Optional<Coins> make(Money amount, Coins available) {
        // best[v] = fewest coins making v from what's in stock: the standard
        // bounded coin-change DP over amounts 0..amount. Amounts are at most
        // a few hundred, so this takes microseconds.
    }
}
```

:::goat The change-making answer that wins this question
*"I check that I can make change before I dispense, using the cash box plus the coins just inserted. Greedy works for standard coins with unlimited stock, but a real machine runs low — with no ₹1 coins, greedy fails on ₹6 even though three ₹2s would work. Amounts are tiny, so I'd use an exact bounded coin-change search behind a `ChangeMaker` interface. If even that finds nothing, I refund and show 'exact change only'."*

Spotting that stock limits break greedy is the single highest-value sentence in this problem.
:::

## 5 · Dispensing, and the jam (28–34)

The order of operations is what keeps money safe:

```java
class Dispensing implements MachineState {
    MachineState run(VendingMachine m) {
        String code = m.chosen().code();
        m.inventory().reserve(code);                 // 1. hold the item
        boolean out = m.motor().dispense(code);      // 2. the physical action
        if (!out) {                                  // 3a. jam or empty spiral
            m.inventory().release(code);
            m.refundEscrow();
            m.display("Sorry — refunded");
            return new Idle();
        }
        m.inventory().confirm(code);                 // 3b. it really came out
        m.cashBox().deposit(m.escrow().drain());     // 4. now the machine's
        m.cashBox().payOut(m.plannedChange());       // 5. change from the box
        return new Idle();
    }
}
```

Two details worth naming:

- **The money moves last.** Escrow only becomes the machine's after the drop sensor confirms the product left. If the motor jams, nothing has been taken.
- **Reserve, then confirm.** Stock is held before the motor turns and decremented only once the item is out, so a jam can't make the count wrong.

## 6 · Threads (34–38)

One customer at a time means no races between customers. But there are still two actors: the customer and the operator (or a remote monitoring thread reading stock levels).

> "Every public method on `VendingMachine` runs under one lock, so a state transition is atomic — nobody can read the inventory halfway through a sale. The operator can only enter `OUT_OF_SERVICE` from `IDLE`, so restocking never interleaves with a sale. Reads for telemetry take a snapshot under the same lock, which is fine because they're rare."

A single lock is the right answer here. Finer locking would add risk and buy nothing — a vending machine serves one person every thirty seconds.

## 7 · Extensions (38–43)

**"Accept cards and UPI."**
> "Payment becomes a `PaymentMethod` strategy. Cash fills escrow coin by coin; a card puts an *authorisation hold* for the price, which plays the same role as escrow — it's captured after dispensing and released on a jam. The state machine doesn't change, because it only asks 'is the price covered?'"

**"Several slots hold the same product."**
> "`Inventory.available(code)` maps a product code to any non-empty slot. The customer picks a product, the machine picks a slot."

**"Happy-hour pricing."**
> "A `PricingPolicy` that `Product.price()` defers to. Selling logic never sees how the price was worked out."

**"A fleet of machines reporting stock to head office."**
> "Each machine emits events — sold, low stock, jammed, cash box nearly full — on its own schedule. The machine stays fully usable offline; reporting is a side effect, never on the sale path."

:::exercise Run the money through
A drink costs ₹35. The cash box holds one ₹10 and four ₹2 coins, nothing else. A customer selects the drink and inserts a ₹50 note.

1. How much change is owed, and which coins can make it? Does greedy find it?
2. Now the customer inserts ₹20 + ₹20 instead. What changes?
3. Write down `escrow` and `cashBox` after a successful sale, and after a jam. Check that no rupee appears or disappears.

(₹15 is owed. The box has ₹10 + four ₹2s = ₹18, and ₹15 needs an odd amount, which no mix of ₹10s and ₹2s can make. So this sale refunds with "exact change only". With 20 + 20, change is ₹5 — still impossible. A ₹5 coin in the box changes everything, which is why operators stock change.)
:::

## Check yourself

```recall
Q: What are the vending machine's three money rules?
A: Never lose money (product plus exact change, or every coin back), never dispense without payment or take payment without dispensing, and never get stuck — every state has a way out.

Q: Why keep inserted coins in escrow, separate from the cash box?
A: They're the customer's until the sale completes, so cancel just returns escrow — and escrow + cash box can be checked before and after every operation.

Q: How does the state pattern make illegal moves impossible here?
A: Default interface methods refuse every action; each state (Idle, Selected, Dispensing, OutOfService) overrides only what it allows — Idle never overrides insert.

Q: When must the machine check it can make change?
A: Before dispensing, using the cash box plus the coins in escrow. If it can't, refund and show "exact change only".

Q: When does greedy change-making fail?
A: With unusual denominations ({1,3,4} for 6: greedy gives 4+1+1, best is 3+3) and — the real-world case — limited stock: no ₹1s means greedy fails ₹6 even though 2+2+2 works.

Q: What change-making algorithm should a real machine use?
A: An exact bounded coin-change search within stock, behind a ChangeMaker interface. Amounts are a few hundred at most, so it takes microseconds.

Q: In what order does dispensing move stock and money?
A: Reserve the item, run the motor, and on a jam release it and refund. Only after the drop sensor confirms do you decrement stock, move escrow into the cash box and pay change.

Q: Why is one lock right for a vending machine?
A: It serves one person every thirty seconds; one lock makes each transition atomic, and the operator enters OUT_OF_SERVICE only from IDLE. Finer locking adds risk and buys nothing.
```

## What to carry forward

- Money in flight lives in escrow until the sale truly completes.
- States refuse by default; each allows only its legal moves.
- Check change before selling; greedy fails under limited stock, so search exactly.
- Money moves last: reserve, dispense, confirm, then settle.
- Cards fit as a payment strategy whose authorisation hold plays escrow's role.
