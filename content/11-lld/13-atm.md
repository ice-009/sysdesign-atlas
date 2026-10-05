---
title: Design an ATM
summary: Card, PIN, choose, dispense — a state machine that talks to a bank over an unreliable link, where the hard part is the moment the account has been debited and the cash hasn't come out yet.
difficulty: Medium
scope: LLD
tags: [lld-problem, state-machine, money, idempotency]
prereqs: [vending-machine, concurrency-in-lld]
unlocks: Designing a step that must happen on two systems at once — the bank's ledger and the cash in the drawer — without ever losing money on either side.
---

An ATM looks like the [vending machine](vending-machine.html) with a card slot. The difference is where the money lives. The vending machine holds the customer's coins in its own escrow. An ATM's money moves in a **bank ledger on another computer**, over a network that can drop at any moment, while the cash sits in the ATM's drawer. Keeping those two in agreement is the whole problem.

:::tip Practise the dispensing part on LeetCode
The note-counting piece of this design is **LC 2241 — Design an ATM Machine** (Medium): track how many of each note you hold, and withdraw by taking the largest notes first. Do it after reading section 5.
:::

## 1 · Requirements (0–5)

**Ask first:** which operations — withdraw only, or balance, deposit and statements too? One bank, or a network of banks? Do we design the bank side or just the machine?

Assume: withdraw, check balance, mini statement; the bank is a remote service we call; one customer at a time.

**What it must do**
- Read a card, ask for a PIN, allow three tries, then keep the card.
- Show the balance; print a short statement.
- Withdraw an amount, in the notes the machine holds.
- Return the card at the end, or after a timeout.

**Qualities that shape the design**
- **Money is never created or lost.** If the account is debited, the cash comes out — or the debit is reversed.
- **The PIN is never stored or logged** by the machine.
- **The machine survives a crash or a network drop** mid-transaction and sorts itself out when it comes back.

**Out of scope:** the bank's own systems, deposits (an extension), the screen layout.

## 2 · Classes (5–12)

```diagram
   ATM               coordinates one session at a time; holds the current state
   CardReader        read(), eject(), retain()
   Keypad, Screen    input and output
   CashDispenser     NoteType → count;  canDispense(amount), dispense(plan)
   ReceiptPrinter
   BankClient        the remote bank   «interface»
                       verifyPin(card, pinBlock)
                       authorise(txnId, account, amount)     ← places the debit
                       complete(txnId)  /  reverse(txnId)
   Journal           an append-only log on local disk of every step
   Session           card, account, attempts left, started at
   Transaction       Withdrawal, BalanceInquiry, MiniStatement   «abstract»
   AtmState          Idle, CardInserted, Authenticated, Dispensing, OutOfService
```

Two decisions to narrate:

**`BankClient` is an interface.** It's a remote system; in tests it's a fake. It also makes the boundary obvious — everything left of it is the machine, everything right of it is the bank.

**The journal.** Every step of every transaction is written to local disk *before* it happens. Real ATMs keep exactly this (it's called the electronic journal) because it's how a crash gets sorted out afterwards.

## 3 · The state machine (12–18)

```diagram
   ┌──────┐  card in   ┌───────────────┐  PIN ok   ┌───────────────┐
   │ IDLE │ ─────────▶ │ CARD_INSERTED │ ────────▶ │ AUTHENTICATED │
   └──────┘            └───────┬───────┘           └───────┬───────┘
      ▲                        │ 3 wrong PINs:             │ withdraw
      │                        │ keep the card             ▼
      │                        │                    ┌────────────┐
      │                        │                    │ DISPENSING │
      │                        │                    └─────┬──────┘
      │                        ▼                          │
      └──────────────── eject card ◀──────────────────────┘
          done, cancel, or a timeout in any state also ejects the card
          balance and statement run inside AUTHENTICATED

   ┌────────────────┐  entered from IDLE only — cassettes empty,
   │ OUT_OF_SERVICE │  printer jammed, or bank unreachable
   └────────────────┘
```

Same tool as the vending machine: one class per state, and **anything a state doesn't allow is refused.** The rules that come straight out of the drawing:

- No operation runs before the PIN is verified.
- A timeout in any state ejects the card and returns to idle, so a walked-away customer never leaves a live session.
- The machine only goes out of service between customers.

```java
class CardInserted implements AtmState {
    public AtmState enterPin(Atm atm, PinBlock pin) {
        Session s = atm.session();
        if (atm.bank().verifyPin(s.card(), pin)) return new Authenticated();
        if (s.failedAttempt() >= 3) {
            atm.cardReader().retain();
            atm.journal().log(s, "card retained after 3 wrong PINs");
            return new Idle();
        }
        atm.screen().show("Wrong PIN — " + s.attemptsLeft() + " tries left");
        return this;
    }
}
```

Notice `PinBlock`, not `String`. The keypad encrypts the PIN in hardware and the machine passes the encrypted block straight to the bank. The ATM code never holds the digits, so it can't leak them — say this, because "where does the PIN go?" is a common follow-up.

## 4 · Withdrawing — two systems, one outcome (18–30)

This is the heart of the problem. Two things must both happen or neither: the bank debits the account, and the drawer pays out the cash. They're on different machines, and anything can fail between them.

```diagram
   1. can the dispenser pay ₹2,500?    no  → "choose another amount"
   2. txnId = new unique id;  journal: AUTHORISING txnId ₹2,500
   3. bank.authorise(txnId, ₹2,500)    no  → "insufficient funds"
   4. journal: AUTHORISED txnId
   5. dispenser.dispense(plan)         jam → bank.reverse(txnId): debit undone
   6. journal: DISPENSED txnId
   7. bank.complete(txnId);  journal: COMPLETE txnId

   A "no" at step 1 or 3 means nothing has happened yet.
```

The ordering carries the design:

- **Check the drawer first (step 1).** Asking the bank to debit an amount you can't pay out creates work you then have to undo.
- **Authorise before dispensing (steps 3 → 5).** Never hand out cash the bank hasn't agreed to.
- **Every bank call carries `txnId`.** If the network drops after the bank debited but before the reply arrived, the machine retries `authorise(txnId)` — and because the bank has already seen that id, it returns the same answer instead of debiting twice. That's [idempotency](../03-distributed/idempotency.html), and it's what makes retrying safe.
- **A failed dispense is reversed (step 5),** again by `txnId`, so a retried reversal can't refund twice either.

```java
class Withdrawal extends Transaction {
    void run(Atm atm, Money amount) {
        DispensePlan plan = atm.dispenser().plan(amount)
            .orElseThrow(() -> new CannotDispenseException(amount));     // step 1

        TxnId id = TxnId.random();
        atm.journal().log(id, AUTHORISING, amount);
        if (!atm.bank().authorise(id, session.account(), amount))        // step 3
            throw new InsufficientFundsException();
        atm.journal().log(id, AUTHORISED);

        try {
            atm.dispenser().dispense(plan);                              // step 5
        } catch (DispenseFault e) {
            atm.journal().log(id, DISPENSE_FAILED);
            atm.bank().reverse(id);
            atm.journal().log(id, REVERSED);
            throw new ServiceException(
                "Cash could not be dispensed — your account was not charged");
        }
        atm.journal().log(id, DISPENSED);
        atm.bank().complete(id);
        atm.journal().log(id, COMPLETE);
    }
}
```

:::goat The crash question
*"What if the power cuts out between the bank saying yes and the cash coming out?"*

**The answer:** *"That's what the journal is for. On restart, the machine reads it. Any transaction whose last entry is AUTHORISED with no DISPENSED after it gets reversed with its `txnId`. One that reached DISPENSED but not COMPLETE gets completed. Because every bank call is idempotent by `txnId`, replaying a step that already happened is harmless. And the dispenser counts notes physically, so if the journal and the cassette counts disagree, the ATM goes out of service for a person to check — it never guesses."*

This is the same idea as a [write-ahead log](../04-data/wal-and-durability.html) in a database, and naming that connection reads as senior.
:::

## 5 · Which notes (30–35)

The drawer holds a few cassettes — say ₹100, ₹200 and ₹500 notes, a counted stock of each. Dispensing ₹2,500 means choosing a mix.

```java
class CashDispenser {
    private final Map<NoteType, Integer> stock = new EnumMap<>(NoteType.class);

    /** Largest notes first, within what's in stock.
        Empty if that can't pay the amount exactly. */
    Optional<DispensePlan> plan(Money amount) {
        long left = amount.rupees();
        EnumMap<NoteType, Integer> take = new EnumMap<>(NoteType.class);
        for (NoteType n : NoteType.LARGEST_FIRST) {
            int use = (int) Math.min(left / n.value(), stock.get(n));
            if (use > 0) { take.put(n, use); left -= (long) use * n.value(); }
        }
        return left == 0 ? Optional.of(new DispensePlan(take)) : Optional.empty();
    }
}
```

This is exactly LC 2241's rule: largest first, and if that doesn't land exactly, refuse rather than search. It's a reasonable product choice — it keeps small notes in stock for small withdrawals. But know its limit, the same one the [vending machine](vending-machine.html) runs into. With no ₹100 notes left, a ₹600 request fails greedy (₹500, then ₹100 needed) even though three ₹200s would work. A real machine either tries a second combination or offers the amounts it *can* pay ("₹500 or ₹1,000?"). Mention both; implement the simple one.

## 6 · Threads and timers (35–39)

One customer at a time, but several things happen at once: the customer pressing keys, a timeout timer, and hardware events (card removed, cassette low).

> "All events go into one queue that a single thread processes in order — a key press, a timeout and a 'cassette empty' signal can't interleave in the middle of a state change. The bank call blocks that thread with its own timeout; if it expires, I treat it like a dropped network, retry with the same `txnId` a couple of times, then reverse and apologise."

One event thread is simpler and safer than locks here: the machine is a single physical device and nothing about it needs parallelism.

## 7 · Extensions (39–43)

**"Add cash deposits."**
> "A `Deposit` transaction. The note reader counts and checks the notes, they sit in a holding area the customer can still cancel from, and only after the customer confirms does the machine send `credit(txnId, amount)` and move the notes into the cassette — the same reserve-then-commit shape as withdrawal, run the other way."

**"Cardless withdrawal with a code from the banking app."**
> "Another way into `AUTHENTICATED`. The code is checked by the bank and is single-use. The rest of the state machine doesn't change."

**"Daily withdrawal limits."**
> "That's the bank's rule, enforced in `authorise`. The ATM shouldn't hold account rules; it would be wrong the moment the customer uses another machine."

**"The bank is unreachable."**
> "Withdrawals need the bank, so the machine goes out of service for them and says so. It shouldn't guess balances — an offline withdrawal is a loan nobody approved."

:::exercise Walk the failure
The customer asks for ₹2,000. The bank says yes. The dispenser jams after pushing out three ₹500 notes, then the power fails.

1. What does the journal say, and what should happen on restart?
2. The customer has ₹1,500 in hand. How does the machine know, and what should the bank finally record?
3. Why is "reverse the whole ₹2,000" wrong here — and what does that tell you about why the dispenser counts notes physically?

(The journal shows AUTHORISED but not DISPENSED. The cassette counters show three ₹500s gone, so the machine records a partial dispense and asks the bank to complete ₹1,500 and reverse ₹500, or flags it for a person. Blindly reversing everything would give the customer free money.)
:::
