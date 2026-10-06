---
title: Design a Logging Framework
summary: Levels, named loggers that inherit settings, pluggable destinations and formats — and the two things that separate a toy from something you'd ship: logging must never slow the app down, and must never crash it.
difficulty: Medium
scope: LLD
tags: [lld-problem, strategy, decorator, singleton, concurrency]
prereqs: [design-patterns, concurrency-in-lld]
unlocks: Using strategy, decorator and a well-placed singleton together in one design, and building a component that sits on every hot path without hurting it.
---

:::predict Guess first
1. DEBUG is switched off in production. Does log.debug("cart " + cart) still cost anything?
2. The log disk is slow, or full. Should the request that wrote the log line wait for it, or fail?
3. The payment component should log at DEBUG and everything else at WARN. How could you avoid configuring every class separately?
:::

Every program you've written uses a logger. This question asks you to build one. It's popular because it's small enough to finish and it naturally pulls in three patterns, a hierarchy, and a real threading problem. It also rewards one practical insight: the cheapest log line is the one you decide not to write.

## 1 · Requirements (0–5)

**Ask first:** which levels? Where do logs go — console, files, a remote service? Can settings change while running? How much traffic — a few lines a second, or thousands?

Assume: four levels, several destinations at once, per-component settings that can change at runtime, and busy services writing thousands of lines a second.

**What it must do**
- `log.info("order placed", ...)` with levels DEBUG, INFO, WARN, ERROR.
- Set a minimum level globally and per component — DEBUG for payments, WARN for everything else.
- Send each line to one or more destinations: console, file, network.
- Format lines: timestamp, level, thread, component, message — as text or JSON.
- Rotate files when they get big.

**Qualities that shape the design**
- **Fast when filtered out.** A DEBUG call in production, where DEBUG is off, should cost almost nothing.
- **Never blocks the request** on slow disks or networks.
- **Never crashes the app.** A full disk is a logging problem, not an outage.
- **Thread-safe.** Lines from different threads never interleave mid-line.

**Out of scope:** searching logs, a log storage service (see [metrics & monitoring](../08-case-studies/metrics-monitoring.html) for the collection side).

## 2 · Classes (5–12)

```diagram
   Level         enum DEBUG < INFO < WARN < ERROR — ordered, so "at least WARN"
                 is a simple comparison
   LogRecord     time, level, loggerName, thread, message, error?, context{}
                 immutable
   Logger        name, level?, appenders[], parent     — what application code calls
   LogManager    hands out Loggers by name; holds the configuration
   Appender      where a record goes      «interface»  Console, File, Network, Async
   Layout        how a record becomes text  «interface»  Pattern, Json
   Filter        extra yes/no per appender  «interface»
```

Three patterns, each doing a specific job — name them as you draw:

- **Strategy:** `Layout`. The appender doesn't care whether it writes text or JSON.
- **Decorator:** `AsyncAppender` wraps any other appender and adds a queue, without the file appender knowing.
- **Singleton (carefully):** `LogManager`. There should be exactly one registry of loggers per process — but see section 7 before you reach for a static field.

## 3 · Levels and the logger tree (12–20)

Loggers are named by component, with dots: `com.shop.payment.refund`. Those names form a tree, and **a logger without its own level inherits its parent's**.

```diagram
   root                         level WARN       appenders: console
   └── com.shop                 (inherits WARN)
       ├── com.shop.payment     level DEBUG      appenders: + payment.log
       │   └── com.shop.payment.refund  (inherits DEBUG)
       └── com.shop.search      (inherits WARN)

   log("com.shop.payment.refund", DEBUG, ...)  → written to payment.log and console
   log("com.shop.search", INFO, ...)           → dropped: below WARN
```

That one rule gives you per-component control without configuring every class. And a record that passes is sent to its own logger's appenders **and then up to its parents'** — so a refund line appears in `payment.log` *and* on the console. (That upward flow is often called *additivity*, and can be switched off per logger.)

```java
class Logger {
    private final String name;
    private final Logger parent;
    private volatile Level level;                 // null = inherit
    private volatile boolean additive = true;     // also use parents' appenders
    private final List<Appender> appenders = new CopyOnWriteArrayList<>();

    Level effectiveLevel() {
        for (Logger l = this; l != null; l = l.parent)
            if (l.level != null) return l.level;
        return Level.INFO;
    }

    boolean isEnabled(Level at) { return at.compareTo(effectiveLevel()) >= 0; }

    void log(Level at, Supplier<String> message, Throwable error) {
        if (!isEnabled(at)) return;          // the cheap path: one comparison
        LogRecord r = new LogRecord(Instant.now(), at, name,
                                    Thread.currentThread().getName(),
                                    message.get(), error, Context.current());
        for (Logger l = this; l != null; l = l.parent) {
            for (Appender a : l.appenders) a.append(r);
            if (!l.additive) break;
        }
    }
}
```

:::goat Make the filtered-out call free
Look at `Supplier<String> message`. Compare:

```java
// Builds the string every time, even with DEBUG off:
log.debug("cart " + cart.toString() + " total " + cart.total());

// Builds it only if DEBUG is on:
log.debug(() -> "cart " + cart + " total " + cart.total());
```

In production DEBUG is off, but the first line still builds a string — `toString()` on a big cart, on every request. The second checks the level first and never runs the lambda. **Say this:** *"The level check happens before any work, and messages are built lazily, so a disabled log line costs one comparison."* It's the detail that shows you've thought about loggers on a hot path.
:::

## 4 · Appenders and layouts (20–27)

```java
interface Appender {
    void append(LogRecord r);
    default void flush() {}
    default void close() {}
}

interface Layout {
    String format(LogRecord r);
}

// 2026-10-05T10:42:07Z INFO [http-3] com.shop.payment - charged
class PatternLayout implements Layout {
    public String format(LogRecord r) {
        String line = r.time() + " " + r.level() + " [" + r.thread() + "] "
                    + r.loggerName() + " - " + r.message();
        return r.error() == null ? line : line + "\n" + stackTrace(r.error());
    }
}

class JsonLayout implements Layout { ... }   // one JSON object per line

class FileAppender implements Appender {
    private final Layout layout;
    private final RollingFile file;          // rotation lives here (section 6)
    public synchronized void append(LogRecord r) {
        try {
            file.write(layout.format(r) + "\n");
        } catch (IOException e) {
            ErrorCounter.increment();           // never throw into the caller
        }
    }
}
```

The `catch` that swallows the error is deliberate and worth pointing at: **a logger must never break the code that called it.** It counts the failure and, at most, reports it once to standard error. An exception thrown from `log.info()` taking down a payment would be absurd.

`synchronized` on `append` keeps lines from two threads from interleaving mid-line. It's fine here because the async appender in the next section means only one background thread usually calls it.

## 5 · Never slow the request (27–34)

Writing to disk takes microseconds to milliseconds; sending over a network takes longer and sometimes hangs. If the request thread does that, logging becomes your latency. The fix is a queue:

```diagram
   request threads ──append()──▶ [ bounded queue: 10,000 records ]
     return at once                         │
                                            ▼
                                   one writer thread ──▶ FileAppender
                                   batches, writes, flushes
```

```java
class AsyncAppender implements Appender {      // decorator: wraps any appender
    private final Appender inner;
    private final BlockingQueue<LogRecord> queue =
        new ArrayBlockingQueue<>(10_000);
    private final AtomicLong dropped = new AtomicLong();

    public void append(LogRecord r) {
        if (queue.offer(r)) return;              // the normal case: instant
        boolean important = r.level().compareTo(Level.WARN) >= 0;
        // Important lines get a short wait — never a long one.
        if (important && offerWithin(r, Duration.ofMillis(5))) return;
        dropped.incrementAndGet();               // reported as "dropped N lines"
    }

    private void drain() {                             // runs on its own thread
        List<LogRecord> batch = new ArrayList<>(512);
        while (running) {
            batch.add(queue.take());
            queue.drainTo(batch, 511);
            for (LogRecord r : batch) inner.append(r);
            inner.flush();
            batch.clear();
        }
    }
}
```

The decision you must state is **what happens when the queue is full**, because there's no free option:

| Policy | Good | Bad |
|---|---|---|
| Block the caller | Nothing lost | A slow disk now slows every request |
| Drop new records | Requests stay fast | You lose lines, maybe the important ones |
| Drop DEBUG/INFO first, keep WARN+ | Usually the right trade | A little more code |

**Say this:** *"I'd never block the request thread. When the queue is full I drop low-level lines first and count what I dropped, so a 'dropped 1,204 lines' warning tells us it happened."* Bounded queues and an explicit full policy are [backpressure](../03-distributed/backpressure.html) at the scale of one process.

And on shutdown: a hook stops accepting records, drains the queue and flushes, so the last lines before a crash — the ones you most want — aren't lost.

## 6 · File rotation (34–37)

A log file that grows forever fills the disk. Rotation:

```diagram
   app.log reaches 100 MB  (or midnight passes)
     close app.log
     rename app.log.2 → app.log.3,  app.log.1 → app.log.2,  app.log → app.log.1
     delete anything past app.log.7
     open a fresh app.log
```

Because only the single writer thread touches the file (thanks to the async appender), rotation needs no extra locking — it's just a step in the writer's loop. That's a nice payoff to point out: one design choice made a second problem easy.

## 7 · Configuration, and the singleton question (37–41)

There must be one `LogManager` per process, so every `getLogger("com.shop.payment")` returns the same object. The classic answer is a singleton:

```java
public final class LogManager {
    private static final LogManager INSTANCE = new LogManager();
    private final Map<String, Logger> loggers = new ConcurrentHashMap<>();

    public static Logger getLogger(String name) {
        return INSTANCE.loggerFor(name);
    }
}
```

Be ready to defend it, because [singletons draw objections](design-patterns.html): global state, hard to test. The honest answer: *"Logging is one of the few cases where a global is the right call — every class needs it, and threading a logger through every constructor is worse. I keep the singleton thin, and make the configuration replaceable so tests can install a fake appender."*

**Changing levels at runtime** without a restart: the configuration is an immutable object held in a `volatile` field. A change builds a new configuration and swaps the reference in one step. Threads see the old one or the new one, never half of each — and nothing on the logging path takes a lock to read it.

## 8 · Extensions

**"Attach the request id to every line, without passing it around."**
> "A per-thread context map (often called MDC): the web filter puts `requestId` into it at the start of a request and clears it at the end. `LogRecord` copies the map when created, so every line carries the id — and async appenders get the copy, not the live map."

**"Too many logs from one noisy component."**
> "A `Filter` on that logger: rate-limit to N lines a second, or sample 1 in 100 DEBUG lines. Filters stack in front of appenders without changing them."

**"Send everything to a central system."**
> "A `NetworkAppender` wrapped in an `AsyncAppender`, writing JSON lines. If the network is down, the queue fills and the full policy kicks in — the app never waits on the log collector."

:::exercise Trace a line
Configuration: root at WARN with a console appender; `com.shop.payment` at DEBUG with an async file appender.

1. `com.shop.payment.refund` logs DEBUG "refund started". Where does it go, and on which thread is the file written?
2. `com.shop.cart` logs INFO "cart viewed". What work happens, if any?
3. The disk fills up. What does the request thread notice? What does an operator notice?
4. Someone changes `com.shop.cart` to DEBUG at runtime. Why does no logging call need to lock to see the change?
:::

## Check yourself

```recall
Q: Name the four qualities that separate a shippable logger from a toy.
A: Nearly free when filtered out, never blocks the request, never crashes the app, and never interleaves lines from different threads.

Q: How do named loggers inherit settings?
A: Dotted names form a tree; a logger without its own level uses its nearest ancestor's. A passing record goes to its own appenders and then its parents' (additivity), which can be switched off.

Q: How do you make a disabled log call almost free?
A: Check the level before doing any work, and take the message as a lambda (Supplier) so the string is built only if the level is enabled — one comparison otherwise.

Q: Which three patterns appear in a logging framework?
A: Strategy for Layout (text or JSON), decorator for AsyncAppender wrapping any appender with a queue, and a deliberately thin singleton LogManager.

Q: How does the async appender keep requests fast, and what happens when its queue fills?
A: Requests offer records into a bounded queue and return; one writer thread batches and writes. When full, drop DEBUG and INFO first, give WARN+ a brief wait, and count drops — never block the caller.

Q: Why must an appender swallow its own I/O errors?
A: A logger must never break the code that called it; a full disk is a logging problem, not an outage. Count the failure and report it once.

Q: Why does file rotation need no extra locking?
A: With an async appender only the single writer thread touches the file, so rotation is just a step in its loop.

Q: How do you change log levels at runtime without locks?
A: Hold an immutable configuration in a volatile field and swap the reference on change; threads see the old or the new configuration, never half of each.
```

## What to carry forward

- The cheapest log line is the one you decide not to build: level check first, lazy messages.
- Loggers form a name tree that inherits levels and passes records up.
- Layouts are strategies, AsyncAppender is a decorator, LogManager is a justified thin singleton.
- Never block or crash the caller: bounded queue, explicit full policy, swallowed and counted errors.
- Immutable configuration in a volatile field gives lock-free runtime changes.
