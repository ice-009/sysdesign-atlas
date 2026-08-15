---
title: Design Splitwise
summary: The money-modelling problem — expenses, split strategies that must sum exactly, the balance sheet, and simplifying debts with a greedy settlement algorithm.
difficulty: Medium
scope: LLD
tags: [lld-problem, strategy, money, algorithms]
prereqs: [parking-lot, oop-refresher]
unlocks: Modelling money and shared state correctly, and handling the rounding question that trips most candidates.
---

Splitwise is asked because it looks trivial and isn't. The trap is `double`, the interesting part is making splits sum to exactly the total, and the bonus round is a small graph algorithm. It also has a natural strategy axis, so it rewards everything from [SOLID](solid.html) and [Patterns](design-patterns.html).

## 1 · Requirements (0–5)

**Ask first:** groups or just pairs? split types needed? multi-currency? do we need settlement suggestions or just balances?

Assume: groups and one-off expenses, equal/exact/percentage/share splits, single currency, plus a "simplify debts" feature.

**Functional**
- A user adds an expense: amount, payer(s), participants, and a split type.
- Everyone's net balance updates — who owes whom, and how much.
- View balances overall, per group, and per friend.
- Record a settlement (a payment between two users).
- Simplify group debts into the fewest transactions.

**Non-functional**
- **Money is exact.** Split amounts must sum to the total, to the last minor unit.
- Adding a new split type must not edit existing code.
- Balance lookups are O(1)-ish; expense history is append-only and auditable.

**Out of scope:** auth, notifications, real payment rails, multi-currency FX.

## 2 · Entities (5–12)

```diagram
   User        id, name, email
   Group       id, name, members[]
   Expense     id, description, Money amount, paidBy, splits[], createdAt, groupId?
   Split       user, Money amount            (the resolved share, never a %)
   Settlement  from, to, Money amount, settledAt
   BalanceSheet  Map<UserPair, Money>        (derived, kept up to date)

   enum SplitType { EQUAL, EXACT, PERCENTAGE, SHARES }
```

The two decisions worth narrating:

**`Money`, always.** Minor units in a `long`, never `double`. Say why: `0.1 + 0.2 != 0.3` in binary floating point, and money bugs are the kind nobody forgives.

```java
record Money(long minor, Currency currency) implements Comparable<Money> {
    static Money of(long minor) { return new Money(minor, Currency.INR); }
    Money plus(Money o)  { requireSame(o); return new Money(minor + o.minor, currency); }
    Money minus(Money o) { requireSame(o); return new Money(minor - o.minor, currency); }
    Money negate()       { return new Money(-minor, currency); }
}
```

**A `Split` holds a resolved amount, not a percentage.** Percentages are *input*; the stored split is the computed money. Otherwise every read re-derives it, and rounding drifts between reads.

## 3 · The split strategy (12–20)

The obvious axis. The subtlety — the thing that separates candidates — is the **residual**.

```java
interface SplitStrategy {
    /** Must return splits summing exactly to `total`. */
    List<Split> split(Money total, List<User> participants, SplitInput input);
}

class EqualSplit implements SplitStrategy {
    public List<Split> split(Money total, List<User> people, SplitInput in) {
        int n = people.size();
        long base = total.minor() / n;
        long residual = total.minor() - base * n;      // 0 ≤ residual < n

        List<Split> splits = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            long amount = base + (i < residual ? 1 : 0);   // spread the extra paise
            splits.add(new Split(people.get(i), Money.of(amount)));
        }
        return splits;
    }
}
```

:::goat The rounding answer that wins the question
₹100 between 3 people is ₹33.33 each — which sums to ₹99.99. Someone must absorb the last paisa. **Say this out loud:** *"I distribute the residual deterministically — the first k participants pay one extra minor unit, where k is the remainder. That guarantees the splits sum to the total exactly, and it's reproducible rather than dependent on float rounding. In a real product I'd rotate who absorbs it, or give it to the payer."*

Most candidates never notice the residual. Noticing it, and having a rule, is the single highest-value sentence in this problem.
:::

The other strategies, each with its own validation:

```java
class ExactSplit implements SplitStrategy {          // validate: parts sum to total
    public List<Split> split(Money total, List<User> people, SplitInput in) {
        Money sum = in.amounts().stream().reduce(Money.zero(), Money::plus);
        if (!sum.equals(total)) throw new SplitMismatchException(total, sum);
        return zip(people, in.amounts());
    }
}

class PercentageSplit implements SplitStrategy {     // validate: percentages sum to 100
    // Compute each share by percentage, then hand the residual to the largest share
    // (largest-remainder method) so the total is exact.
}

class ShareSplit implements SplitStrategy {          // "Alice 2 shares, Bob 1 share"
    // amount_i = total × share_i / totalShares, residual by largest remainder.
}
```

**Validation belongs in the strategy**, not in the service — that's SRP in a form you can point at: *"the service doesn't know what makes a percentage split valid; the percentage strategy does."*

## 4 · Balances (20–28)

The core question: store balances, or derive them from expenses?

| | Derive on read | Maintain incrementally |
|---|---|---|
| Add expense | O(1) | O(participants) |
| Read balance | O(all expenses) | O(1) |
| Correctness | Always consistent | Can drift if a path forgets to update |
| Audit | Natural | Needs the ledger anyway |

**The answer to give:** *"Both — the expense list is the source of truth, and the balance sheet is a derived index maintained on write. It's the same read-model-over-an-event-log idea as [CDC and materialised views](../data/cdc-outbox.html), just in memory. I'd expose a `recompute()` that rebuilds balances from expenses, so drift is detectable and fixable."*

The representation, and the trick that halves it:

```java
class BalanceSheet {
    /** balances[a][b] > 0 means a owes b. Only one direction is stored. */
    private final Map<UserId, Map<UserId, Money>> balances = new ConcurrentHashMap<>();

    void record(UserId debtor, UserId creditor, Money amount) {
        if (debtor.equals(creditor)) return;
        // Net against any existing opposite-direction balance so we never hold both.
        adjust(debtor, creditor, amount);
        adjust(creditor, debtor, amount.negate());
    }

    Money netBalance(UserId of) {                 // sum of what they're owed minus owed
        return balances.getOrDefault(of, Map.of()).values()
                       .stream().reduce(Money.zero(), Money::plus).negate();
    }
}
```

**Say this:** *"I net on write: if Bob owes Alice ₹50 and Alice then owes Bob ₹30, I store one edge of ₹20, not two edges. It keeps reads trivial and makes 'who owes whom' unambiguous."*

The service that ties it together:

```java
class ExpenseService {
    private final Map<SplitType, SplitStrategy> strategies;
    private final ExpenseRepository expenses;
    private final BalanceSheet balances;

    Expense addExpense(AddExpenseCommand cmd) {
        SplitStrategy strategy = strategies.get(cmd.type());
        List<Split> splits = strategy.split(cmd.amount(), cmd.participants(), cmd.input());

        Expense expense = Expense.create(cmd, splits);
        expenses.save(expense);                                  // ledger first

        for (Split s : splits) {
            if (!s.user().equals(cmd.paidBy())) {
                balances.record(s.user(), cmd.paidBy(), s.amount());
            }
        }
        return expense;
    }
}
```

Note the order: **ledger first, derived state second.** If the process dies between them, the truth survives and `recompute()` fixes the index. That's the in-memory version of the [outbox pattern](../data/cdc-outbox.html), and saying so lands well.

## 5 · Simplify debts (28–36)

The bonus round, and it's a small, clean algorithm. Given net balances, minimise the number of transactions.

```diagram
   Net balances:   A: −40   B: −20   C: +50   D: +10
                   (negative = owes, positive = is owed; they always sum to 0)

   Greedy: repeatedly settle the largest debtor against the largest creditor.

     A(−40) → C(+50)   pay 40    →  A: 0    C: +10
     B(−20) → C(+10)   pay 10    →  C: 0    B: −10
     B(−10) → D(+10)   pay 10    →  B: 0    D: 0

   3 transactions instead of up to 6 pairwise ones.
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

        if (-d.amount() > amount) debtors.add(d.minus(amount));   // partially settled
        if (c.amount()  > amount) creditors.add(c.minus(amount));
    }
    return out;
}
```

Complexity: O(n log n). Be precise about what it guarantees: **greedy gives at most n−1 transactions and is not provably minimal** — the true minimum-transaction problem is NP-hard (it's a subset-sum flavour: you'd want to find groups whose balances net to zero and settle them internally). Saying that sentence — "greedy is a good heuristic; optimal is NP-hard" — is worth more than a fake proof of optimality.

:::warn Simplify has a product cost, not just an algorithmic one
Simplified debts create payments between people who never shared an expense — "why do I owe Dave? I've never met Dave." Real Splitwise makes it opt-in per group for exactly this reason. Naming a product consequence of an algorithmic choice is a senior move and takes one sentence.
:::

## 6 · Extensions and concurrency (36–43)

**"Multiple currencies."**
> "`Money` already carries a currency and refuses cross-currency arithmetic — that's the guardrail. I'd store each expense in its original currency plus the FX rate at creation time, and convert for display. Balances would be per-currency; netting across currencies needs an explicit user-visible conversion, not a silent one."

**"Edit or delete an expense."**
> "The ledger is append-only: an edit is a reversing entry plus a new expense, not a mutation. Balances are adjusted by the delta. That keeps history auditable and makes 'who changed what' answerable — the same reasoning as a WAL."

**"Two people add expenses to the same group simultaneously."**
> "The shared mutable state is the balance sheet. Per-pair updates through `ConcurrentHashMap.compute` are atomic, so the individual edges are safe. If I need a group-consistent snapshot for the simplify view, I'd take a read lock on the group or compute from the immutable expense list at a point in time — with the ledger as truth, a stale snapshot is never *wrong*, just slightly old."

**"Recurring expenses / receipt uploads / comments."**
> "None of them touch the split or balance logic — they're new entities hanging off `Expense`. That's the design working."

:::exercise Sanity check
Alice pays ₹1000 for dinner, split by shares: Alice 2, Bob 1, Carol 1. Compute the three splits with exact minor units, then the balance edges. (₹500/₹250/₹250 — clean. Now redo it with ₹1000 split three ways equally: 33334/33333/33333, and say who absorbs the extra paisa and why.)
:::
