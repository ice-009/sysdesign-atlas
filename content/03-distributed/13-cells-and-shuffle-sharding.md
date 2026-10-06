---
title: Cells & Shuffle Sharding
summary: Limiting how many customers one failure can reach — splitting a service into independent cells, giving each customer a random handful of workers, and why "blast radius" is a number you can design.
difficulty: Hard
scope: HLD
tags: [reliability, isolation, blast-radius, sharding]
prereqs: [multi-region, sharding, failure-modes, load-balancing]
unlocks: Designing services where a bad deploy, a poison request or one noisy customer affects a small, known fraction of users instead of everyone.
---

:::predict Guess first
1. A service runs on 8 identical servers behind one load balancer. One customer sends a request that crashes any server it reaches. How many customers are affected?
2. Now each customer is assigned 2 of the 8 servers at random. How many different pairs of servers are there?
3. Should the component that decides which cell a request goes to be simple, or clever?
:::

## The question behind this page

Most reliability work asks: *how do we make failures rarer?* This page asks a different question: **when something does fail, how many customers does it reach?**

That number — the **blast radius** — is usually "everyone" by default. One shared fleet, one shared database, one shared deploy. A bug, a bad config push, an overloaded node or a single customer sending something pathological takes down the whole service, because nothing separates customers from each other.

Two techniques turn blast radius into a number you choose:

- **Cells** — split the service into several complete, independent copies, each serving a slice of customers.
- **Shuffle sharding** — give each customer a random small set of workers, so no two customers share exactly the same set.

## Cells

A **cell** is a complete, independent instance of your service — its own load balancers, application servers, caches, queues and databases — serving only the customers assigned to it. A thin **cell router** in front sends each request to its customer's cell.

```diagram
                         ┌──────────────┐
   requests ───────────► │ cell router  │   thin: looks up customer → cell
                         └──┬────┬────┬─┘
             ┌──────────────┘    │    └──────────────┐
             ▼                   ▼                   ▼
      ┌────────────┐      ┌────────────┐      ┌────────────┐
      │  CELL 1    │      │  CELL 2    │      │  CELL 3    │
      │ app · cache│      │ app · cache│      │ app · cache│
      │ queue · DB │      │ queue · DB │      │ queue · DB │
      └────────────┘      └────────────┘      └────────────┘
      customers A–H       customers I–P       customers Q–Z

   Nothing is shared between cells. A failure inside cell 2
   reaches only cell 2's customers.
```

What this buys:

- **Bounded failures.** A database melting down, a memory leak, a poison request — each reaches one cell. With 20 cells, a cell-wide failure affects 5% of customers instead of 100%.
- **Safer deploys.** Roll out to one cell, watch it, then the next. Since [most outages are caused by change](../01-foundations/availability-slas.html), deploying cell by cell turns a fleet-wide incident into a one-cell incident.
- **A known unit of scale.** You load-test one cell to its limit once. Growing means adding cells, not discovering how a single giant system behaves at a size nobody has run.
- **Noisy-neighbour containment.** A customer that hammers the service hurts only its own cell's neighbours.

This is the same idea as watertight compartments in a ship's hull: a breach floods one compartment, not the vessel. AWS has used it across many services, and published its approach as the *cell-based architecture* guidance.

### The cell router must be boring

The router is the one component every request passes through, so it must be the most reliable thing in the system:

- **Do almost nothing.** Look up the customer's cell and forward. No business logic, no calls to other services on the request path.
- **Cache the mapping locally.** The customer-to-cell table changes rarely; every router instance should hold a copy and keep working if the system that manages the table is down.
- **Deploy it separately and rarely**, with even more caution than the cells.

A clever router undoes the whole design — it becomes the shared component whose failure reaches everyone.

### Choosing the partition key and the cell size

**The key** is whatever every request carries and that groups data which belongs together — usually customer, tenant or account ID. Requests that need data from many cells (a global search, an admin report) don't fit the model; serve them from a separate system fed asynchronously from all cells.

**The size** is a real trade-off:

| Smaller cells | Larger cells |
|---|---|
| Smaller blast radius | Larger blast radius |
| More cells to deploy and operate | Fewer to run |
| Worse capacity efficiency — each needs its own headroom | Better pooling of spare capacity |
| Big customers may not fit in one | Big customers fit |

The largest customer has to fit in a cell. Very large tenants often get **dedicated cells**, with small customers packed together in shared ones.

### Moving customers between cells

Cells fill up unevenly, so you need a migration path: copy the customer's data to the new cell, keep it in sync, flip the router entry, then clean up. That's a live data migration, and it's the main ongoing cost of running cells. Build it early — the first time you need it is usually when a cell is already in trouble.

## Shuffle sharding

Cells divide customers into groups that never share anything. **Shuffle sharding** goes further with a probabilistic trick: give each customer a small random *combination* of workers, so that customers overlap partially but almost never completely.

Start with plain sharding. Eight workers, split into four shards of two; each customer goes to one shard. A poison request that crashes the workers it reaches takes out one shard — **a quarter of all customers**.

Now shuffle shard. Each customer gets 2 workers chosen from 8, and every customer gets a different pair where possible:

:::derive How many combinations there are
```
   Choosing 2 workers out of 8:

     C(8, 2)  =  8 × 7 / 2  =  28 possible pairs

   A poison customer crashes ITS two workers.

   Another customer is completely down only if it has
   exactly the same pair:  1 in 28.

   Most customers share at most ONE worker with the
   poison customer — and still have a healthy one.
   Clients retry against their other worker and carry on.

   Scale it up:
     C(100, 5)     ≈  75 million combinations
     C(2048, 4)    ≈  730 billion combinations
```
:::

That last line is a real system. **Amazon Route 53** arranges its capacity into 2,048 virtual name servers and gives every customer domain a shuffle shard of four. A flood of traffic aimed at one domain — say, a denial-of-service attack — hits that domain's four name servers. The chance that some other domain has the same four is tiny, so everyone else keeps resolving through at least some healthy servers.

```diagram
   Plain sharding (4 shards of 2)          Shuffle sharding (pairs from 8)

   shard 1: workers 1,2 ← poison here      poison customer: workers 3,7
   shard 2: workers 3,4                    customer X:      workers 3,5  ✓ (5 ok)
   shard 3: workers 5,6                    customer Y:      workers 1,7  ✓ (1 ok)
   shard 4: workers 7,8                    customer Z:      workers 2,6  ✓ (both ok)

   25% of customers fully down             ~1/28 fully down (only exact pair)
```

### What shuffle sharding needs to work

- **Clients must try their other workers.** The isolation only helps if a request that fails on one worker is retried on another from the same shard. A client that gives up after one failure gets none of the benefit.
- **The problem must be tied to the customer.** Shuffle sharding contains failures *caused by* a customer — poison requests, floods, pathological queries. A bug that crashes every worker regardless of input still crashes everything.
- **Assignment is deterministic.** Hash the customer ID to pick its combination, so every client and router agrees on the shard without a lookup service.

:::goat Cells and shuffle shards answer different questions
A **cell** asks: *if this whole stack fails, who is affected?* It contains failures that spread *within* infrastructure — a database falling over, a bad deploy, a cascading overload.

A **shuffle shard** asks: *if one customer is toxic, who suffers with it?* It contains failures that arrive *with* a particular customer's traffic.

The strongest designs use both: shuffle sharding inside each cell, cells across the fleet, and [availability zones or regions](multi-region.html) beneath that. Each layer turns "everyone" into a smaller, calculable fraction — and you can write that fraction into a design review instead of hoping.
:::

## Static stability

One more idea travels with cells: a system should keep working **without needing to change anything** when part of it fails. If a cell or zone dies, the survivors shouldn't need to call a control plane, launch new capacity or rewrite routing tables in order to carry on — because those are exactly the systems most likely to be struggling during a large incident.

In practice: provision enough capacity in advance to absorb a failure, keep routing data cached locally, and treat control-plane changes (scaling, reconfiguring) as things that improve the situation later rather than things the data path depends on now.

:::trap "We have 20 cells, so we're 20× safer"
Only if nothing is shared. Common ways cells end up coupled:

- **A shared database, cache or queue** "just for metadata".
- **A global configuration push** that reaches every cell at once — the classic way a cell-based fleet still has a fleet-wide outage.
- **A shared dependency** — an auth service, a secrets store, a DNS provider — that every cell calls on the request path.
- **The router itself** doing too much.

Audit for these explicitly. Deploy configuration cell by cell, just like code. An isolation boundary that one config push can cross isn't a boundary.
:::

:::exercise Design the isolation
A multi-tenant analytics API serves 5,000 customers. The largest is 8% of traffic; most are tiny. Last quarter one customer's malformed query crashed every API server, and a bad config push took the whole service down for 40 minutes.

1. Design the cells: partition key, how many, and how you'd handle the 8% customer.
2. What does the router do and, just as importantly, what does it not do? How does it keep working if the mapping service is down?
3. Inside each cell, add shuffle sharding across 16 API servers with shards of 3. How many combinations are there, and what fraction of customers would the malformed query have taken down?
4. What must clients do for shuffle sharding to help?
5. Redesign the config rollout so a bad push can't take out more than one cell.
6. A customer outgrows its cell. Write the migration steps.
:::

:::paper Sources
AWS's whitepaper *Reducing the Scope of Impact with Cell-Based Architecture* (2023) is the most complete public guide to cells. Colm MacCárthaigh's Amazon Builders' Library article *Workload Isolation Using Shuffle-Sharding* explains the technique and the Route 53 design.

*Static Stability Using Availability Zones* (Becky Weiss and Mike Furr, Amazon Builders' Library) covers designing systems that keep working without control-plane changes during failures.
:::

## Check yourself

```recall
Q: What is blast radius, and what is it by default?
A: The share of customers a single failure reaches. With one shared fleet, database and deploy it is usually everyone.

Q: What is a cell, and what does it buy?
A: A complete, independent copy of the service serving a slice of customers behind a thin router. Failures, bad deploys and noisy neighbours stay inside one cell, and a load-tested cell becomes the unit of scale.

Q: Why must the cell router be boring?
A: Every request passes through it, so it must only look up customer → cell and forward — with the mapping cached locally, no request-path dependencies and rare, careful deploys. A clever router becomes the shared failure.

Q: What trade-offs come with cell size?
A: Smaller cells shrink blast radius but add operational load and waste headroom; larger cells pool capacity but widen impact. The largest customer must fit, so huge tenants get dedicated cells.

Q: How does shuffle sharding limit a poison customer?
A: Each customer gets a random combination of workers — 2 of 8 gives 28 pairs — so a poison customer takes down only its own workers, and another customer is fully affected only if it has the identical combination.

Q: How does Route 53 use shuffle sharding?
A: It has 2,048 virtual name servers and gives each domain four, so an attack on one domain hits its four servers while other domains almost always keep some healthy ones.

Q: What does shuffle sharding need to work?
A: Clients that retry against their other workers, failures that are tied to the customer's traffic, and deterministic assignment by hashing the customer ID.

Q: How do cell-based systems still have fleet-wide outages?
A: Through shared components — a "metadata" database, global config pushes, shared auth or DNS on the request path, or an overloaded router. Deploy config cell by cell too.
```

## What to carry forward

- **Design blast radius deliberately** — "everyone" is just the default.
- **Cells** are independent full stacks behind a thin, boring router; they contain infrastructure failures and bad deploys.
- **Shuffle sharding** gives each customer a random combination of workers, so toxic traffic hurts almost no one else.
- **Static stability**: survivors keep working without needing control-plane changes.
- **Anything shared crosses the boundary** — especially configuration pushes.
