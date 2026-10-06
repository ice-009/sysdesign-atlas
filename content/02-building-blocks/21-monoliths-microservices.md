---
title: Monoliths and Microservices
summary: One deployable or many — what splitting a system into services really buys (independent teams, deploys and scaling), what it really costs (every call can fail, no shared transactions, far more to operate), where to draw the lines, and how to split a monolith safely.
difficulty: Medium
scope: HLD
tags: [architecture, microservices, monolith, service-boundaries]
prereqs: [api-gateway, pub-sub]
---

:::predict Guess first
1. What is the main reason companies split a monolith into microservices — traffic, or something else?
2. In a monolith, orders calling payments is a function call. What changes when they become separate services?
3. Three services share one database. Are they really microservices?
:::

A **monolith** is a system built and deployed as one unit: one codebase, one application you start, usually one database. **Microservices** split the same system into many small services, each deployed on its own, each owning its own data, talking to each other over the network.

Neither is "modern" or "legacy". They trade different costs, and the right choice depends mostly on **how many teams work on the system** — not on traffic.

## The two shapes

```diagram
   MONOLITH                                 MICROSERVICES

   ┌───────────────────────────┐        ┌────────┐   ┌────────┐   ┌────────┐
   │ orders │ payments │ users │        │ orders │──▶│payments│   │ users  │
   │────────┴──────────┴───────│        └───┬────┘   └───┬────┘   └───┬────┘
   │  one process, one deploy  │            │ own DB     │ own DB     │ own DB
   └─────────────┬─────────────┘           [db]         [db]         [db]
                 │                      calls over the network: HTTP, gRPC, events
            [ one database ]
   a call between parts is a           a call between parts is a network request
   function call
```

That last line is the heart of it. In a monolith, orders calling payments is a function call: it takes nanoseconds and never "partly fails". In microservices it's a network request that can be slow, time out, or succeed on the far side while you see an error.

## In between: the modular monolith

There's a middle option that is often the best one: **one deployable, with strict internal boundaries**. Code is split into modules — orders, payments, users — that only talk through defined interfaces and don't reach into each other's tables. You get most of the clarity of services without the network.

It also makes a later split cheap: a module with a clean interface and its own tables can become a service with relatively little change. Many teams that eventually need microservices start here on purpose.

## What splitting buys

- **Teams move independently.** Each team owns a service: its code, its deploys, its on-call. Twenty teams no longer queue behind one release train or break each other's tests. This is the main reason companies split, and it's an organisational benefit more than a technical one.
- **Independent deploys.** Ship a payments fix without redeploying search.
- **Independent scaling.** The image-resizing service gets 50 machines with GPUs; the settings service gets two small ones.
- **Contained failures** — *if* designed for it. A crash in recommendations doesn't take down checkout, as long as checkout treats recommendations as optional.
- **Different tools per job.** A search service on a search engine, a ledger on a relational database.

## What splitting costs

This is the part interviewers want to hear you say unprompted.

- **Every call can fail.** Timeouts, retries, circuit breakers and fallbacks become everyday code. A request that touches six services is only as reliable as all six together — see [Failure Modes](../01-fundamentals/failure-modes.html).
- **Latency adds up.** A chain of five calls at 20 ms each is 100 ms before any real work.
- **No shared transactions.** "Create the order and charge the card" can't be one database transaction across two services' databases. You need [sagas](../03-distributed/distributed-transactions.html) — steps with compensating actions — and you have to accept states like "order created, payment pending".
- **No joins.** A report needing orders *and* users can't join two databases; data is copied between services through events, and copies can lag.
- **Much more to run.** Deploy pipelines, monitoring, logging and on-call per service, plus service discovery, distributed tracing to follow one request across many services, and versioned APIs that can't break callers.
- **Harder to test end to end.** No single process to start and click through.

:::trap The distributed monolith
The worst outcome is getting all the costs and none of the benefits: services that **share a database**, or that **must be deployed together** because a change in one breaks another, or that make dozens of tiny calls to each other for every request.

That's a monolith with network calls inserted in the middle. If you find yourself drawing a shared database under three services, say so and fix the boundary — that one sentence shows you understand what services are *for*.
:::

## Where to draw the lines

Good boundaries follow **business capabilities**, not technical layers.

```diagram
   Good — by what the business does:
     orders, payments, inventory, shipping, accounts, search

   Bad — by technical layer:
     "database service", "validation service", "email-formatting service"

   Test for a good boundary:
     · it owns its data — nobody else reads its tables directly
     · most changes touch one service, not three
     · it can do its job if a neighbour is briefly down (maybe in a reduced way)
     · one team can own it end to end
```

**Each service owns its data.** Others get it through the service's API or through events it publishes — never by querying its tables. This is the rule that makes independent deploys possible: a service can change its schema without asking anyone.

**Chattiness is a smell.** If service A calls B ten times per request, they probably belong together, or B's API is shaped wrongly.

## How services talk

Two styles, usually both in one system:

- **Request/response** (REST or gRPC) when the caller needs the answer now — "is this coupon valid?" The choice between REST, gRPC and GraphQL is covered in [API Gateway](api-gateway.html).
- **Events** when the caller is announcing something happened — "order placed" — and doesn't need to wait for whoever reacts. See [Pub/Sub & Event-Driven Architecture](pub-sub.html).

The supporting pieces that appear once you split:

| Piece | Job |
|---|---|
| [API gateway](api-gateway.html) | One front door for clients; auth, routing, quotas |
| Service discovery | How a service finds the current addresses of another |
| [Circuit breakers](../03-distributed/backpressure.html) | Stop calling a failing service; fail fast instead |
| [Sagas](../03-distributed/distributed-transactions.html) | Multi-service workflows with compensations |
| [Outbox pattern](../04-data/cdc-outbox.html) | Change your data and publish an event reliably, together |
| Distributed tracing | Follow one request across every service it touched |

## Splitting a monolith safely

Rewriting everything at once is the classic failure — the new system takes years and never catches up with the old one. The safe path is the **strangler fig** approach, named after a vine that slowly grows around a tree:

```diagram
   1. Put a routing proxy in front of the monolith.
        clients → [proxy] → monolith
   2. Build ONE capability as a new service — say, notifications.
   3. Route its traffic to the new service.
        clients → [proxy] ─┬─▶ notifications
                           └─▶ monolith (everything else)
   4. Move its data out; delete the old code.
   5. Repeat, one capability at a time.
```

Each step is small and reversible — if the new service misbehaves, route traffic back. Start with something at the edge with few dependencies (notifications, search), not the tangled core. The routing proxy is just a [reverse proxy](proxies.html) doing path-based routing.

## Which to choose

**Start with a monolith (ideally modular) when:**
- the team is small — one or a few teams;
- the product is new and the boundaries aren't clear yet (wrong boundaries are expensive to move once they're network APIs);
- you don't yet have strong deployment automation and monitoring.

**Split into services when:**
- many teams are slowing each other down in one codebase;
- parts of the system have very different scaling or reliability needs;
- you have the tooling to run many services — automated deploys, monitoring, tracing, on-call.

The common summary: **microservices solve an organisation-size problem**. A five-person team with twenty services has bought the costs without the problem they solve.

## In the interview

HLD designs usually show several services anyway. What scores is **saying why each is separate**:

> "I've split upload from feed because they scale completely differently — upload is CPU-heavy image work, feed is read-heavy and cached. Users and auth stay together; there's no reason to separate them at this size."

And when the problem is small — a URL shortener — don't invent ten services. One service with a clear internal structure, plus the boxes the scale actually demands, is the stronger answer.

:::exercise Draw the lines
A food-delivery company has one monolith with modules for restaurants, menus, orders, payments, drivers, live tracking and notifications. Eight teams work on it, and live tracking needs 20× more machines at dinner time than anything else.

1. Which two modules would you split out first, and why those?
2. Placing an order must reserve a driver and charge the card. Sketch the saga, including what happens if the charge fails after the driver is reserved.
3. The analytics team wants a nightly report joining orders, restaurants and drivers. With each service owning its data, where does that report get its data from?
4. Which of your new services must keep working when notifications is down — and how does that change how they call it?
:::

## Check yourself

```recall
Q: What is the main benefit of microservices, and what kind of problem does it solve?
A: Teams can build, deploy and run their services independently instead of queueing behind one release. It solves an organisation-size problem more than a traffic problem.

Q: Name four costs that come with splitting into services.
A: Every call can fail or be slow; latency adds up along call chains; there are no shared transactions or joins (you need sagas and copied data); and far more to operate — deploys, monitoring, tracing, versioned APIs.

Q: What is a modular monolith, and why is it often the best starting point?
A: One deployable with strict internal module boundaries and separate tables. You get most of the clarity without the network, and a clean module can later become a service cheaply.

Q: What is a "distributed monolith"?
A: Services that share a database, must deploy together, or chat constantly — all the costs of microservices and none of the benefits.

Q: Where should service boundaries go?
A: Along business capabilities (orders, payments, inventory), not technical layers. Each service owns its data, most changes touch one service, and one team can own it end to end.

Q: Why must each service own its data?
A: So it can change its schema without asking anyone. Others use its API or its events, never its tables — that's what makes independent deploys possible.

Q: How do you split a monolith safely?
A: The strangler fig: put a routing proxy in front, rebuild one capability as a service, route its traffic there, move its data, delete the old code, repeat — each step small and reversible.

Q: When should you not split into microservices?
A: With a small team, a new product whose boundaries aren't clear yet, or without automated deploys and monitoring.
```

## What to carry forward

- Microservices mainly solve team scaling; they cost failing calls, latency, lost transactions and operational load.
- A modular monolith is often the best start and makes later splits cheap.
- Draw boundaries by business capability, and let each service own its data.
- Avoid the distributed monolith: shared databases, lockstep deploys, chatty calls.
- Split gradually with the strangler fig, and say why each service in a design is separate.
