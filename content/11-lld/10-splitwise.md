---
title: Design Splitwise
summary: The money problem — expenses, split rules that must add up exactly, who owes whom, and a small greedy algorithm for settling a group with the fewest payments.
difficulty: Medium
scope: LLD
tags: [lld-problem, strategy, money, algorithms]
prereqs: [parking-lot, oop-refresher]
unlocks: Modelling money correctly, and handling the rounding question that trips up most candidates.
---

:::predict Guess first
1. Split ₹100 equally between three people, in whole paise. Do the shares add up to ₹100?
2. A owes 40, B owes 20, C is owed 50 and D is owed 10. What is the fewest number of payments that settles the group?
3. Should a balance be recalculated from every expense each time, or kept as a running total?
:::

Splitwise looks trivial and isn't. The trap is using `double` for money. The interesting part is making the split add up to exactly the total. The bonus round is a small graph algorithm. It also has an obvious place where things vary, so it rewards everything from [SOLID](solid.html) and [the patterns](design-patterns.html).

## 1 · Requirements (0–5)

**Ask first:** groups, or just pairs of people? which split types? more than one currency? do you want settlement suggestions or just balances?

Assume: groups and one-off expenses, four split types, one currency, plus a "simplify debts" feature.

**What it must do**
- Someone adds an expense: amount, who paid, who shares it, and how it's split.
- Everyone's balance updates — who owes whom, and how much.
- View balances overall, per group, and per friend.
- Record a settlement (one person paying another back).
- Simplify a group's debts into the fewest payments.

**Qualities that shape the design**
- **Money is exact.** The split amounts must add up to the total, to the last paisa.
- Adding a new split type must not mean editing existing code.
- Balances are quick to read; the expense history is append-only so it can be audited.

**Out of scope:** login, notifications, real payment rails, currency conversion.

## 2 · Classes (5–12)

```diagram
   User        id, name, email
   Group       id, name, members[]
   Expense     id, description, Money amount, paidBy, splits[], createdAt, groupId?
   Split       user, Money amount            (resolved share, never a percentage)
   Settlement  from, to, Money amount, settledAt
   BalanceSheet  who owes whom, kept up to date

   enum SplitType { EQUAL, EXACT, PERCENTAGE, SHARES }
```

Two decisions worth narrating:

**Always `Money`, never `double`.** Store whole paise (or cents) in a `long`. Say why: `0.1 + 0.2` doesn't equal `0.3` in binary floating point, so pennies drift, and money bugs are unforgivable.

```java
record Money(long minor, Currency currency) implements Comparable<Money> {
    static Money of(long minor) { return new Money(minor, Currency.INR); }
    Money plus(Money o) {
        requireSame(o);
        return new Money(minor + o.minor, currency);
    }
    Money minus(Money o) {
        requireSame(o);
        return new Money(minor - o.minor, currency);
    }
    Money negate()       { return new Money(-minor, currency); }
}
```

**A `Split` stores an amount, not a percentage.** Percentages are what the *user typed*; the stored split is the money it worked out to. Otherwise every screen recalculates it and the rounding drifts between them.

## 3 · Splitting, and the leftover paisa (12–20)

The obvious place where things vary. The subtlety — and the thing that separates candidates — is what happens to the remainder.

```java
interface SplitStrategy {
    /** Must return splits that add up to exactly `total`. */
    List<Split> split(Money total, List<User> participants, SplitInput input);
}

class EqualSplit implements SplitStrategy {
    public List<Split> split(Money total, List<User> people, SplitInput in) {
        int n = people.size();
        long base = total.minor() / n;
        long leftover = total.minor() - base * n;      // 0 ≤ leftover < n

        List<Split> splits = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            long amount = base + (i < leftover ? 1 : 0);   // spread the spare paise
            splits.add(new Split(people.get(i), Money.of(amount)));
        }
        return splits;
    }
}
```

:::goat The rounding answer that wins this question
₹100 between three people is ₹33.33 each — which adds up to ₹99.99. Someone has to absorb the last paisa.

**Say this out loud:** *"I hand the remainder out deterministically — the first k people pay one extra paisa, where k is the remainder. That guarantees the parts add up to the total exactly, and it's repeatable rather than depending on floating-point rounding. In a real product I'd rotate who absorbs it, or give it to whoever paid."*

Most candidates never notice the leftover exists. Noticing it, and having a rule, is the single highest-value sentence in this problem.
:::

The other strategies, each with its own validation:

```java
class ExactSplit implements SplitStrategy {          // check: the parts add up
    public List<Split> split(Money total, List<User> people, SplitInput in) {
        Money sum = in.amounts().stream().reduce(Money.zero(), Money::plus);
        if (!sum.equals(total)) throw new SplitMismatchException(total, sum);
        return zip(people, in.amounts());
    }
}

class PercentageSplit implements SplitStrategy {     // percentages sum to 100
    // Work out each share, then give the leftover to the largest share, so the
    // parts still add up exactly.
}

class ShareSplit implements SplitStrategy { }        // Alice 2 shares, Bob 1
```

**Validation belongs inside each strategy**, not in the service. That's "one job per class" in a form you can point at: *"the service doesn't know what makes a percentage split valid — the percentage strategy does."*

## 4 · Balances (20–28)

The real question: work balances out on demand from the expense list, or keep a running total?

| | Work it out each time | Keep it updated |
|---|---|---|
| Adding an expense | Instant | Touch each participant |
| Reading a balance | Walk every expense | Instant |
| Correctness | Always right | Can drift if some path forgets |
| Audit trail | Natural | Needs the expense list anyway |

**The answer to give:** *"Both. The expense list is the truth, and the balance sheet is a summary kept up to date as expenses arrive. I'd also expose a `recompute()` that rebuilds balances from the expenses, so any drift is detectable and fixable."*

Then the representation, and the trick that halves it:

```java
class BalanceSheet {
    /** A positive amount under (a, b) means a owes b.
        Only one direction is stored. */
    private final Map<UserId, Map<UserId, Money>> balances =
            new ConcurrentHashMap<>();

    void record(UserId debtor, UserId creditor, Money amount) {
        if (debtor.equals(creditor)) return;
        // Cancel against anything owed the other way, so we never hold both.
        adjust(debtor, creditor, amount);
        adjust(creditor, debtor, amount.negate());
    }
}
```

**Say this:** *"I cancel on write. If Bob owes Alice ₹50 and Alice then owes Bob ₹30, I store one debt of ₹20 rather than two facing each other. Reads stay trivial and 'who owes whom' has one answer."*

The service that ties it together:

```java
class ExpenseService {
    private final Map<SplitType, SplitStrategy> strategies;
    private final ExpenseRepository expenses;
    private final BalanceSheet balances;

    Expense addExpense(AddExpenseCommand cmd) {
        SplitStrategy strategy = strategies.get(cmd.type());
        List<Split> splits =
            strategy.split(cmd.amount(), cmd.participants(), cmd.input());

        Expense expense = Expense.create(cmd, splits);
        expenses.save(expense);                                  // the record first

        for (Split s : splits) {
            if (!s.user().equals(cmd.paidBy())) {
                balances.record(s.user(), cmd.paidBy(), s.amount());
            }
        }
        return expense;
    }
}
```

Note the order: **save the expense first, update the summary second.** If the process dies in between, the truth survives and `recompute()` fixes the summary. Reversing the order can leave a balance with no expense behind it.

## 5 · Simplifying debts (28–36)

The bonus round, and it's a clean little algorithm. Given everyone's net position, find the fewest payments that settle up.

```diagram
   Net positions:  A: −40   B: −20   C: +50   D: +10
                   (negative = owes, positive = is owed; they always add to 0)

   Greedy: repeatedly make the biggest debtor pay the biggest creditor.

     A(−40) → C(+50)   pays 40   →  A: 0    C: +10
     B(−20) → C(+10)   pays 10   →  C: 0    B: −10
     B(−10) → D(+10)   pays 10   →  B: 0    D: 0

   3 payments instead of up to 6 person-to-person ones.
```

```java
List<Settlement> simplify(Map<UserId, Money> netBalances) {
    PriorityQueue<Entry> debtors   = maxHeapOf(netBalances, m -> m.minor() < 0);
    PriorityQueue<Entry> creditors = maxHeapOf(netBalances, m -> m.minor() > 0);
    List<Settlement> out = new ArrayList<>();

    while (!debtors.isEmpty() && !creditors.isEmpty()) {
        Entry d = debtors.poll(), c = creditors.poll();
        long amount = Math.min(-d.amount(), c.amount());
        out.add(new Settlement(d.user(), c.user(), Money.of(amount)));

        if (-d.amount() > amount) debtors.add(d.minus(amount));   // partly settled
        if (c.amount()  > amount) creditors.add(c.minus(amount));
    }
    return out;
}
```

Cost: O(n log n). Be precise about what it guarantees. **Greedy gives at most n−1 payments and is not guaranteed to be the true minimum** — finding that is NP-hard, because you'd have to find every subgroup whose debts cancel out internally. Saying "greedy is a good heuristic, the optimal version is NP-hard" is worth far more than inventing a proof.

:::warn Simplifying has a human cost, not just an algorithmic one
Simplified debts create payments between people who never shared an expense — "why do I owe Dave? I've never met Dave." Real Splitwise makes this opt-in per group for exactly that reason.

Naming a product consequence of an algorithmic choice takes one sentence and reads as senior.
:::

## 6 · Extensions and threads (36–43)

**"Several currencies."**
> "`Money` already carries its currency and refuses to add two different ones — that's the guardrail. I'd store each expense in the currency it happened in, plus the exchange rate at the time, and convert only for display. Balances stay per-currency; combining them needs an explicit conversion the user can see, never a silent one."

**"Edit or delete an expense."**
> "The history is append-only: an edit becomes a reversing entry plus a new expense, not a change in place. Balances move by the difference. That keeps 'who changed what' answerable."

**"Two people add expenses to the same group at once."**
> "The shared changing data is the balance sheet. Per-pair updates through `ConcurrentHashMap.compute` are atomic, so individual debts are safe. If I need a consistent snapshot of a whole group for the simplify view, I'd take a read lock or compute it from the expense list at a point in time — with the expenses as the truth, a slightly stale snapshot is never *wrong*, just slightly old."

**"Recurring expenses, receipt photos, comments."**
> "None of them touch the splitting or balance logic — they're new classes hanging off `Expense`. That's the design doing its job."

:::exercise Sanity check
Alice pays ₹1000 for dinner, split by shares: Alice 2, Bob 1, Carol 1. Work out the three splits in exact paise, then the debts.

(₹500 / ₹250 / ₹250 — clean. Now redo it as an equal three-way split of ₹1000: 33334 / 33333 / 33333 paise, and say who takes the extra paisa and why.)
:::

## Check yourself

```recall
Q: How should Splitwise store money, and why?
A: As whole paise in a long inside a Money value with a currency — never double, because 0.1 + 0.2 isn't 0.3 in binary floating point and pennies drift.

Q: Why does a Split store an amount rather than a percentage?
A: The percentage is what the user typed; the stored split is the money it resolved to. Otherwise every screen recalculates and rounding drifts between them.

Q: How do you handle the leftover paisa in an equal split?
A: Give base = total ÷ n to everyone and one extra paisa to the first k people, where k is the remainder — the parts always add up exactly and the result is repeatable. Real products might rotate it.

Q: Where does split validation belong?
A: Inside each strategy — exact amounts must sum to the total, percentages to 100 — not in the service, which doesn't know what makes each split type valid.

Q: Recompute balances or keep them updated?
A: Both: the append-only expense list is the truth, the balance sheet is a summary updated on each expense, and recompute() rebuilds it to detect and fix drift. Save the expense before updating the summary.

Q: What does "cancel on write" mean for balances?
A: If Bob owes Alice ₹50 and then Alice owes Bob ₹30, store one debt of ₹20, so "who owes whom" has a single answer and reads stay trivial.

Q: How does greedy debt simplification work, and what does it guarantee?
A: Repeatedly have the biggest debtor pay the biggest creditor, using two heaps — O(n log n), at most n − 1 payments. It isn't always optimal; the true minimum is NP-hard.

Q: How do you edit an expense safely?
A: Keep history append-only: add a reversing entry plus a new expense, and move balances by the difference, so who changed what stays answerable.
```

## What to carry forward

- Money is exact: whole minor units in a value object, never double.
- Splits must add to the total — have a deterministic rule for the leftover paisa.
- Split types are strategies, each validating its own input.
- Expenses are the append-only truth; balances are a summary that can be rebuilt.
- Greedy simplification is a good heuristic (optimal is NP-hard) with a human cost — make it opt-in.
