---
title: Design a Library Management System
summary: The entities-and-rules problem — a title versus its copies, loans with due dates, a fair queue for reserved books, fines that follow a swappable rule, and making sure one copy is never lent twice.
difficulty: Medium
scope: LLD
tags: [lld-problem, entities, strategy, concurrency]
prereqs: [parking-lot, uml-class-diagrams]
unlocks: Telling apart "the thing" and "one instance of the thing", which shows up in every inventory, booking and catalogue problem.
---

This one has no clever algorithm. It's a test of **modelling**: picking the right nouns, putting each rule where it belongs, and not tangling them. The single decision that separates good answers from weak ones comes in section 3 — a book and a copy of a book are different objects.

## 1 · Requirements (0–5)

**Ask first:** one branch or many? Are there different kinds of member? Reservations? Fines? E-books?

Assume: one branch, two kinds of member (student and staff), reservations and fines, physical books only.

**What it must do**
- Search the catalogue by title, author, subject or ISBN, and see how many copies are free.
- Lend a copy to a member, with a due date; take it back.
- Renew a loan, unless someone else is waiting for that book.
- Reserve a book when every copy is out; hold a copy for the first person waiting when one comes back.
- Charge a fine for late returns.
- Librarians add and remove copies, and can block a member.

**Qualities that shape the design**
- **One copy, one borrower.** A copy can never be on two loans at once.
- **Reservations are fair** — first come, first served.
- **The rules change.** Loan periods, limits and fine rates differ by member type and get revised.

**Out of scope:** payments for fines (we record them), branch transfers, digital lending.

## 2 · Classes (5–12)

```diagram
   Book            isbn, title, authors[], subjects[]   the title you search for
   BookCopy        barcode, book, status, shelf         one physical item
   Member          id, name, type, status, activeLoans[]
   Loan            copy, member, issuedOn, dueOn, returnedOn?
   Reservation     book, member, placedAt, status, holdUntil?
   Fine            loan, Money amount, paid
   Catalog         search over Books
   LibraryService  issue, giveBack, renew, reserve             the coordinator
   LoanPolicy      per member type: max loans, loan days, renewals   «interface»
   FinePolicy      what a late return costs                          «interface»

   enum CopyStatus { AVAILABLE, ON_LOAN, ON_HOLD, LOST, IN_REPAIR }
   enum MemberType { STUDENT, STAFF }
```

And the relationships, which is where the design really shows:

```diagram
   Book 1 ◆──── 1..* BookCopy          a title has copies; each copy has one title
   BookCopy 1 ──── 0..1 Loan (active)   at most one open loan per copy ← key rule
   Member 1 ──── * Loan                 a member has many loans over time
   Book 1 ──── * Reservation            the waiting queue is per BOOK, not per copy
```

## 3 · A book is not a copy (12–17)

The weak answer has one `Book` class with an `isAvailable` flag. It falls apart immediately: the library has four copies of *Clean Code*, two are out, one is being repaired. "Is it available?" has no single answer.

So split it:

- **`Book`** is the title. It's what members search for and reserve. It has no status.
- **`BookCopy`** is the item on the shelf, with a barcode. It's what gets lent. It has a status.

```diagram
                 issue                 return (no one waiting)
   AVAILABLE ──────────▶ ON_LOAN ──────────────────────────────▶ AVAILABLE
        ▲                    │
        │ hold expires,      │ return (someone waiting)
        │ queue empty        ▼
        └──────────────── ON_HOLD ──── picked up by that member ──▶ ON_LOAN

   Any state ──▶ LOST or IN_REPAIR  (librarian)       IN_REPAIR ──▶ AVAILABLE
```

**Say this:** *"Members reserve a title, not a copy — they don't care which copy of Clean Code they get. Copies carry the status. That's why reservations hang off `Book` and loans hang off `BookCopy`."* That one sentence is most of the modelling grade.

## 4 · Lending and returning (17–26)

All the checks live in one place, and each rule lives in the object that owns it.

```java
class LibraryService {
    private final LoanPolicy loans;
    private final FinePolicy fines;
    private final ReservationQueues queues;
    private final Notifier notifier;
    private final Clock clock;

    Loan issue(Member m, BookCopy copy) {
        m.requireActive();                                   // not blocked
        LoanRule rule = loans.ruleFor(m.type());
        if (m.activeLoans().size() >= rule.maxLoans())
            throw new LoanLimitException(m);
        if (m.unpaidFines().compareTo(rule.fineLimit()) > 0)
            throw new UnpaidFinesException(m);

        // AVAILABLE, or ON_HOLD for exactly this member; throws otherwise.
        copy.lendTo(m);
        queues.fulfil(copy.book(), m);           // their reservation is done
        Loan loan = new Loan(copy, m, today(), today().plusDays(rule.loanDays()));
        m.addLoan(loan);
        return loan;
    }

    Optional<Fine> giveBack(BookCopy copy) {
        Loan loan = copy.activeLoan().orElseThrow();
        loan.close(today());
        Optional<Fine> fine = fines.fineFor(loan).map(a -> new Fine(loan, a));
        fine.ifPresent(f -> loan.member().addFine(f));

        Optional<Reservation> next = queues.next(copy.book());
        if (next.isPresent()) {
            copy.holdFor(next.get().member(), today().plusDays(3));
            notifier.bookReady(next.get());
        } else {
            copy.markAvailable();
        }
        return fine;
    }
}
```

Look at where the rules sit:

- **Whether a copy can be lent** is `BookCopy`'s business — it knows its own status and who it's held for.
- **How many books a student may have** is the `LoanPolicy`'s, not hard-coded in the service.
- **What lateness costs** is the `FinePolicy`'s.

The service only coordinates. When a rule changes, you know which single class to open — that's [single responsibility](solid.html), shown rather than recited.

## 5 · Reservations — a fair queue (26–32)

One queue per title, oldest first.

```java
class ReservationQueues {
    private final Map<Isbn, Deque<Reservation>> waiting = new HashMap<>();

    Reservation reserve(Book b, Member m) {
        if (catalog.availableCopies(b) > 0) throw new NoNeedToReserveException(b);
        if (has(b, m)) throw new AlreadyReservedException(b, m);
        Reservation r = new Reservation(b, m, clock.instant());
        waiting.computeIfAbsent(b.isbn(), k -> new ArrayDeque<>()).addLast(r);
        return r;
    }

    Optional<Reservation> next(Book b) {
        Deque<Reservation> q = waiting.get(b.isbn());
        return q == null ? Optional.empty() : Optional.ofNullable(q.peekFirst());
    }

    boolean othersWaiting(Book b, Member m) { ... }   // used by renew()
}
```

Three rules that make it work:

- **Renewal is refused if anyone is waiting.** Otherwise one member can keep a popular book forever.
- **A held copy waits three days.** A daily job finds expired holds, cancels that reservation, and moves the copy to the next person in line — or back to the shelf if nobody is waiting.
- **Hold for the person, not the queue position.** `holdFor(member, until)` stores *who*, so the issue check in section 4 can say "this copy is on hold for someone else."

## 6 · Fines — a rule that will change (32–36)

```java
interface FinePolicy {
    Optional<Money> fineFor(Loan loan);
}

class PerDayFine implements FinePolicy {
    private final Map<MemberType, Money> dailyRate;
    private final int graceDays;
    private final Money cap;

    public Optional<Money> fineFor(Loan l) {
        long late = DAYS.between(l.dueOn(), l.returnedOn()) - graceDays;
        if (late <= 0) return Optional.empty();
        Money due = dailyRate.get(l.member().type()).times(late);
        return Optional.of(due.min(cap));
    }
}
```

An interface earns its place here because the change is real and named: libraries revise fines, waive them during exams, and charge differently for reference books. Each of those is a new `FinePolicy`, with nothing else touched.

## 7 · Search (36–39)

The catalogue answers "find books by…" and "how many copies are free?"

```java
class Catalog {
    private final Map<Isbn, Book> byIsbn = new HashMap<>();
    private final Map<String, Set<Book>> byWord = new HashMap<>();  // title words
    private final Map<String, Set<Book>> byAuthor = new HashMap<>();

    List<BookResult> search(String query) { ... }  // intersect word sets, rank
    int availableCopies(Book b) { ... }            // copies with AVAILABLE
}
```

The word map is a tiny **inverted index** — the same structure a search engine uses, at library scale. Say that at a large scale you'd hand search to a proper search engine and keep this class as the interface in front of it.

## 8 · Two librarians, one copy (39–42)

Two desks scan the same copy at the same moment. Both see AVAILABLE; both lend it. That's the race the "one copy, one borrower" rule exists to prevent.

> "The status change is a compare-and-set: `lendTo` moves AVAILABLE → ON_LOAN only if the status is still AVAILABLE, under a lock on that copy — or, in a database, `UPDATE copies SET status='ON_LOAN' WHERE barcode=? AND status='AVAILABLE'` and check that one row changed. Whoever loses gets 'already on loan'. I'd also put a unique constraint on 'open loan per copy' so even a bug can't create two."

Lock per copy, not per library: different copies never block each other. The full set of tools is on [Threads and races](concurrency-in-lld.html).

## 9 · Extensions

**"Several branches."**
> "`BookCopy` gets a `branch`. Search shows availability per branch. A reservation can name a pickup branch, and a returned copy may be sent there — a transfer is just another status, IN_TRANSIT."

**"E-books with a licence for five simultaneous loans."**
> "Model the licence as five copies with no shelf. Everything else — loans, due dates, the queue — already works."

**"Notify by email, SMS or app."**
> "`notifier.bookReady()` is an interface with one implementation per channel, and members choose. The library logic doesn't know how the message travels — the same split as the [alerting system](alerting-system.html)."

:::exercise Check the rules
1. A student has 3 books (the limit) and an unpaid fine of ₹40 (limit ₹50). Can they borrow a fourth? Which class refuses, and with what message?
2. *Clean Code* has two copies, both out. Asha reserves it, then Ravi. Copy 1 comes back. Walk the statuses of copy 1 and both reservations. Asha never collects it. What happens on day 4?
3. Bob tries to renew *Clean Code* while Ravi is waiting. Which method refuses, and what does it check?
:::
