---
title: Design an Alerting System
summary: The observer problem done properly — rules that watch numbers, an alert lifecycle that doesn't flap, notifications fanned out to email, SMS and chat without one slow channel holding up the rest, escalation when nobody answers, and no duplicate pages.
difficulty: Medium
scope: LLD
tags: [lld-problem, observer, state-machine, concurrency]
prereqs: [design-patterns, concurrency-in-lld]
unlocks: Using the observer pattern beyond the textbook — with the slow-listener, duplicate and storm problems it brings in real systems.
---

:::predict Guess first
1. CPU sits between 89% and 91% with an alert at 90%. How many notifications might that produce in an hour?
2. The SMS provider takes ten seconds per message. Should the chat message for the same alert wait for it?
3. A network switch dies and 50 hosts stop reporting. How many pages should the on-call engineer get?
:::

"Notify the right people when something goes wrong" sounds like a for-loop over subscribers. It's the textbook **observer pattern**, and that's where weak answers stop. The interesting parts are what happens *around* the loop: a condition that flickers on and off, a text-message provider that takes ten seconds, fifty servers failing in the same minute, and an engineer asleep at 3 a.m. who doesn't answer.

## 1 · Requirements (0–5)

**Ask first:** what's being watched — metrics, log events, health checks? Which channels? Is there an on-call rota and escalation? Do we design the storage for metrics too?

Assume: numeric metrics arrive as samples; we design the rules, the alert lifecycle and notification — not metric storage (that's [metrics & monitoring](../08-case-studies/metrics-monitoring.html)).

**What it must do**
- Define rules: "CPU above 90% for 5 minutes", "error rate above 2%", "no heartbeat for 60 seconds".
- When a rule's condition holds, raise an alert; when it clears, resolve it.
- Notify subscribers through their channels — email, SMS, chat, phone — routed by severity and team.
- If a critical alert isn't acknowledged within 10 minutes, escalate to the next person.
- Silence alerts during planned maintenance.

**Qualities that shape the design**
- **Adding a channel or a rule type doesn't touch the engine.**
- **One slow channel never delays another.** SMS being slow must not hold up the chat message.
- **No duplicate pages, no missed pages.** Each state change notifies each subscriber once.
- **No storms.** Fifty servers failing together is one problem, not fifty phone calls.

## 2 · Classes (5–12)

```diagram
   Sample            metric, labels{host, service}, value, time
   AlertRule         decides if a condition holds            «interface»
                       ThresholdRule, RateRule, AbsenceRule
   Alert             rule, labels, state, since, firedAt?, ackedBy?
   AlertEngine       feeds samples to rules, moves alerts between states,
                     publishes events
   AlertEvent        FIRED | RESOLVED | ESCALATED | ACKNOWLEDGED, plus the alert
   AlertListener     anything that wants events  «interface»   ← the observer
   Router            listener: works out who should hear about an event
   Channel           delivers one message                      «interface»
                       EmailChannel, SmsChannel, ChatChannel, PhoneChannel
   EscalationPolicy  steps: primary at 0 min, secondary at 10, manager at 20
   Silence           label matcher + time window
```

## 3 · The observer, and its sharp edges (12–19)

The engine is the **subject**; anything interested is an **observer**. The engine doesn't know who's listening.

```java
interface AlertListener {
    void onEvent(AlertEvent e);
}

class AlertEngine {
    private final List<AlertListener> listeners = new CopyOnWriteArrayList<>();
    void subscribe(AlertListener l)   { listeners.add(l); }
    void unsubscribe(AlertListener l) { listeners.remove(l); }

    private void publish(AlertEvent e) {
        for (AlertListener l : listeners) {
            try {
                l.onEvent(e);
            } catch (RuntimeException ex) {   // one bad listener can't stop others
                log.warn("listener failed", ex);
            }
        }
    }
}
```

Router, audit log, dashboard, a metrics counter — each is a listener, added without changing the engine. That's the payoff, and it's real.

Now the parts the textbook skips. Name them, because they're what the interviewer is waiting for:

- **A slow listener blocks the subject.** `publish` calls listeners one by one on the engine's thread. If the router sends an SMS inline, rule evaluation stalls for ten seconds. → Listeners must return quickly; real work goes onto queues (section 5).
- **An exception in one listener skips the rest** — hence the `try/catch` per listener.
- **Forgotten listeners leak.** A listener that's never unsubscribed is kept alive forever by the engine's list.
- **Order isn't a contract.** If the audit log must record an event before it's delivered, that's a requirement to design for, not an accident of list order.

`CopyOnWriteArrayList` is chosen on purpose: listeners are added rarely and events are published constantly, so copying on the rare write is cheap and publishing never needs a lock.

## 4 · The alert lifecycle — and flapping (19–26)

A condition that's true for one sample isn't an incident. CPU spikes for a second all the time. So an alert has states:

```diagram
           condition true           true for ≥ 5 min
   ┌────┐ ───────────────▶ ┌─────────┐ ───────────────▶ ┌────────┐
   │ OK │                  │ PENDING │                  │ FIRING │ ──▶ notify FIRED
   └────┘ ◀─────────────── └─────────┘                  └───┬────┘
     ▲     condition false                                  │ condition false
     │                                                      ▼ for ≥ 2 min
     └─────────────────────────────────────────────── RESOLVED ──▶ notify RESOLVED
```

`PENDING` is what stops a one-second spike from paging anyone: the condition has to *hold* for the rule's duration.

There's a second trap: **flapping**. CPU sits at 89–91% and the alert fires, resolves, fires, resolves — a notification every minute. Two standard cures:

- **Different thresholds to fire and to clear** (called *hysteresis*): fire above 90%, resolve only below 80%. A value hovering at 90 can't flip it back and forth.
- **A minimum time in RESOLVED** before it can fire again.

```java
class ThresholdRule implements AlertRule {
    private final double fireAbove, clearBelow;     // e.g. 90 and 80
    private final Duration holdFor;                 // e.g. 5 minutes

    Verdict evaluate(Alert current, Window samples) {
        double v = samples.average();
        if (current.isActive())
            return v < clearBelow ? Verdict.CLEAR : Verdict.HOLD;
        return v > fireAbove ? Verdict.TRUE : Verdict.FALSE;
    }
}
```

**Say this:** *"Rules decide whether a condition holds; the lifecycle decides when that becomes a notification. Pending stops spikes, and separate fire and clear thresholds stop flapping."*

## 5 · Delivering — fan out without waiting (26–33)

The router turns an event into deliveries: *who* should hear, through *which* channels. Then each channel gets its own queue and its own worker threads.

```diagram
   AlertEngine ──event──▶ Router ─┬─▶ [email queue] ─▶ email workers ─▶ provider
                                  ├─▶ [sms queue]   ─▶ sms workers   ─▶ provider
                                  └─▶ [chat queue]  ─▶ chat workers  ─▶ provider
   the router only enqueues,                       ▲
   so it never waits             SMS is slow today; email and chat don't notice
```

```java
class Router implements AlertListener {
    private final Map<ChannelType, ExecutorService> lanes;  // a pool per channel
    private final SubscriptionStore subscriptions;
    private final SentLog sent;

    public void onEvent(AlertEvent e) {
        // who × which channel; only enqueues, so it returns at once
        for (Delivery d : subscriptions.deliveriesFor(e)) {
            lanes.get(d.channel().type()).submit(() -> deliver(d));
        }
    }

    private void deliver(Delivery d) {
        String key = String.join(":", d.alertId(), d.eventType(),
                                      d.recipient(), d.channel().type().name());
        if (!sent.markIfNew(key)) return;   // already sent: retry or duplicate
        retryWithBackoff(() -> d.channel().send(d.message()), 5);
    }
}
```

Three decisions to point at:

- **A lane per channel.** Slow SMS fills the SMS queue; email and chat don't notice. These are *bulkheads* — the same idea as watertight sections in a ship, from [backpressure](../03-distributed/backpressure.html).
- **Retries with backoff** for providers that fail now and then.
- **A delivery key.** Retrying, or a second copy of the engine raising the same event, can't send the same page twice: `markIfNew` records the key and refuses repeats. That's [idempotency](../03-distributed/idempotency.html) at the notification layer, where it matters most — a duplicate phone call at 3 a.m. is a real cost.

**Notify on changes, not on every check.** The engine evaluates every 30 seconds, but notifications go out only on FIRED and RESOLVED, plus an optional reminder every few hours while an alert stays firing.

## 6 · Escalation and acknowledgement (33–38)

A critical alert fires. The primary on-call gets a call. Nothing happens. After 10 minutes, the secondary gets one.

```java
class Escalator implements AlertListener {
    private final ScheduledExecutorService timers;
    private final Map<AlertId, ScheduledFuture<?>> pending =
        new ConcurrentHashMap<>();

    public void onEvent(AlertEvent e) {
        switch (e.type()) {
            case FIRED -> scheduleStep(e.alert(), 0);
            case ACKNOWLEDGED, RESOLVED -> {
                ScheduledFuture<?> f = pending.remove(e.alert().id());
                if (f != null) f.cancel(false);      // stop escalating
            }
        }
    }

    private void scheduleStep(Alert a, int step) {
        EscalationStep s = policyFor(a).step(step);
        if (s == null) return;                   // ran out of people
        pending.put(a.id(), timers.schedule(() -> {
            notify(s.who(), a);
            scheduleStep(a, step + 1);
        }, s.after().toMillis(), TimeUnit.MILLISECONDS));
    }
}
```

Escalation is just another listener — the engine doesn't know it exists. Acknowledging is idempotent: a second "ack" from the same person, or a click and an SMS reply arriving together, changes nothing.

## 7 · Storms and silences (38–41)

A network switch dies and fifty hosts stop reporting. Fifty alerts, fifty pages, and the actual cause buried in the noise.

- **Group** alerts that share labels — same service, same data centre — into one notification: *"50 hosts in rack 12 not reporting"*. Wait a short moment (say 30 seconds) after the first alert to collect the rest.
- **Inhibit**: if "data centre unreachable" is firing, suppress the per-host alerts it obviously explains.
- **Silence**: a label matcher plus a time window. "Anything with `service=search`, 02:00–04:00, planned upgrade." The router checks silences before delivering; the alert still exists and is visible, it just doesn't page.

## 8 · Threads, in one paragraph

> "Samples arrive on many threads. I shard rules by a hash of their labels so each alert is only ever updated by one evaluator thread — no locks on alert state. Publishing is on that thread too, so listeners must return quickly, which is why the router only enqueues. Delivery runs on per-channel pools, and escalation on a scheduled executor."

The general tools are in [Threads and races](concurrency-in-lld.html); the specific trick here is *one owner per alert*, which removes most locking.

## 9 · Extensions

**"Add WhatsApp."** — A new `Channel` class and a value in subscriptions. Nothing else.

**"Run two engines for availability."** — Both evaluate and both raise events; the delivery key in the sent log makes sure each page goes out once.

**"Alert on logs, not just metrics."** — A new `AlertRule` that counts matching log lines in a window. The lifecycle, routing and escalation are reused untouched.

:::exercise Follow one incident
Rule: error rate fire above 5%, clear below 2%, hold for 3 minutes. Subscribers: the payments team by chat for any severity; the on-call by phone for critical, escalating to the secondary after 10 minutes.

1. Error rate goes 1% → 6% for 1 minute → 1%. What notifications go out? (None — it never left PENDING.)
2. It goes to 7% and stays there for 20 minutes; nobody acknowledges. List every notification, with times.
3. It then drops to 4%. Is the alert resolved? Why not?
4. The phone provider times out on the first call and the call is retried. Why does the on-call get exactly one call?
:::

## Check yourself

```recall
Q: What are the four sharp edges of the textbook observer pattern?
A: A slow listener blocks the subject, an exception in one listener skips the rest, forgotten listeners leak, and listener order isn't a contract.

Q: Why does an alert have a PENDING state?
A: The condition must hold for the rule's duration before it fires, so a one-second spike never pages anyone.

Q: How do you stop an alert flapping?
A: Hysteresis — fire above 90% but resolve only below 80% — plus a minimum time in RESOLVED before it can fire again.

Q: Why give each channel its own queue and workers?
A: They're bulkheads: a slow SMS provider fills only the SMS queue while email and chat carry on. The router only enqueues, so it never waits.

Q: How do you guarantee no duplicate pages?
A: A delivery key — alert, event type, recipient, channel — recorded before sending; retries and a second engine instance find it already marked and skip.

Q: How does escalation work?
A: A listener schedules step 0 on FIRED, then each next person after a delay; ACKNOWLEDGED or RESOLVED cancels the pending timer. Acknowledging is idempotent.

Q: How do you handle alert storms?
A: Group alerts sharing labels into one notification after a short wait, inhibit symptoms a firing root-cause alert explains, and silence matching labels during planned maintenance.

Q: How do you avoid locks on alert state?
A: Shard rules by a hash of their labels so each alert has one evaluator thread; delivery runs on per-channel pools and escalation on a scheduled executor.
```

## What to carry forward

- Observer is the skeleton; slow listeners, failures, leaks and ordering are the real design.
- Rules decide whether a condition holds; the lifecycle (PENDING, hysteresis) decides when to notify.
- Fan out through a queue per channel — bulkheads — with retries and an idempotent delivery key.
- Notify on state changes, escalate on silence, and group, inhibit and silence to prevent storms.
- One owner thread per alert removes most locking.
