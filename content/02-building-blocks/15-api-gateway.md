---
title: API Gateway & Service Communication
summary: What belongs at the edge, REST vs gRPC vs GraphQL, the BFF pattern, and how services should talk to each other without creating a distributed monolith.
difficulty: Medium
scope: HLD
tags: [api, gateway, grpc, graphql, microservices]
prereqs: [load-balancing, rate-limiting]
---

:::predict Guess first
1. Which of these belong in an API gateway: TLS, authentication, rate limiting, business rules?
2. Public API, internal service calls, a mobile app with varied screens — would you use REST, gRPC or GraphQL for each?
3. A client asks for page 500 of results with OFFSET 10000. What does the database actually do?
:::

## The edge tier

An API gateway is a single entry point in front of many backend services. It exists because certain concerns are needed by *every* service, and implementing them N times is both wasteful and inconsistent.

```diagram
              ┌──────────────────────────────────┐
   clients ──►│         API GATEWAY              │
              │  TLS · authN · rate limit ·      │
              │  routing · aggregation · logging │
              └──┬──────────┬─────────┬──────────┘
                 ▼          ▼         ▼
              users      orders    catalog
```

**What belongs here:**
- **TLS termination** and certificate management, in one place.
- **Authentication** — check the caller's token once, then pass a verified "this is user 42" inward. Backend services trust that rather than each re-implementing token parsing. (Note this is authentication — *who are you* — not authorisation, *what may you do*, which usually stays with the service that owns the data.)
- **[Rate limiting](rate-limiting.html)** — reject abusive traffic before it costs you anything.
- **Routing** — send each path or hostname to the right service, and split traffic by weight for gradual rollouts.
- **Protocol translation** — public REST/JSON outside, gRPC inside.
- **Response aggregation** — one client call fanning out to several services.
- **Observability** — consistent request IDs, latency, and status codes across everything.

**What does *not* belong here:** business logic. The gateway is the most-shared and highest-risk component you own; every rule you put in it is a change that can break every service at once. The failure mode has a name — the "smart pipe" — and the symptom is that shipping a feature requires a gateway deploy.

:::trap The gateway as a single point of failure
Everything routes through it, so it must be highly available (multiple instances, health checks, autoscaled) *and* it must not amplify failures. Keep timeouts short, give each backend its own circuit breaker, and make sure one slow backend can't tie up every thread in the gateway — that's a **bulkhead**, named after a ship's compartments: separate connection pools per downstream, so one flooding doesn't sink the vessel. See [failure modes](../01-fundamentals/failure-modes.html). When asked "what if the gateway fails?", "it's replicated behind an anycast/L4 tier and it isolates each backend with its own pool and breaker" is the complete answer.
:::

## REST vs gRPC vs GraphQL

Pick by consumer and access pattern, and say why.

### REST / JSON over HTTP

Resources with standard verbs. Universally supported, cacheable by HTTP infrastructure, debuggable with `curl`, no code generation.

Weaknesses: **over-fetching** (the endpoint returns 40 fields, the client needs 3), **under-fetching** (rendering a screen requires 5 sequential calls), verbose JSON, and no schema enforcement unless you add OpenAPI.

**Use for:** public APIs, third-party integrations, anything where broad compatibility and cacheability matter most. Still the correct default for public surfaces.

### gRPC

You write down the shape of your messages once, in a schema file, and a tool generates matching client and server code in every language you use. Messages travel as compact binary (Protobuf) rather than text, over HTTP/2.

**Strengths:** compact binary payloads (often 3–10× smaller than JSON), a strict schema with generated types in every language, HTTP/2 multiplexing (many concurrent requests on one connection), native bidirectional streaming, and low latency.

**Weaknesses:** not human-readable, awkward from browsers (needs grpc-web and a proxy), harder to cache in standard HTTP infrastructure, and it requires the [L7 load balancing](load-balancing.html) discussion — a single multiplexed connection defeats L4 balancers.

**Use for:** **internal service-to-service communication.** This is the standard modern choice inside a datacenter, and saying "REST at the edge, gRPC internally" is a clean, defensible architecture statement.

### GraphQL

One endpoint; the client specifies exactly the shape it wants.

**Strengths:** eliminates over- and under-fetching, so a mobile client on a slow network fetches one precisely-shaped payload instead of five round trips. Clients evolve without backend changes. Strong typing and introspection.

**Weaknesses, all real:**
- **Caching is hard.** Every query is a POST to the same URL, so HTTP caching doesn't apply. You need application-level caching keyed by query shape.
- **The N+1 problem.** A nested query naively issues one database call per parent item; you need batching (DataLoader-style) to make it viable. This is not optional — it's the defining operational hazard.
- **Unbounded query cost.** A client can request a deeply nested query that's expensive to serve. You need depth limits, complexity scoring, and persisted queries.

**Use for:** mobile and rich web clients with diverse data needs, and aggregation across many backend services.

### Comparison

| | REST | gRPC | GraphQL |
|---|---|---|---|
| Payload | JSON | Protobuf (binary) | JSON |
| Schema | Optional (OpenAPI) | Required | Required |
| Browser support | Native | Needs proxy | Native |
| HTTP caching | Excellent | Poor | Poor |
| Streaming | SSE / chunked | Native bidirectional | Subscriptions |
| Best for | Public APIs | Internal RPC | Client-driven aggregation |

## Backend for Frontend (BFF)

When a mobile app, a web app, and a partner API all need different shapes of the same data, a single general-purpose API serves all three badly.

The BFF pattern gives each client its own thin aggregation layer:

```diagram
   iOS app  ──► Mobile BFF  ─┐
   Web app  ──► Web BFF     ─┼──► users, orders, catalog, pricing
   Partner  ──► Public API  ─┘
```

Each BFF is owned by the team that owns its client, and it can aggregate, trim payloads, and change shape without coordinating with anyone else. The mobile BFF can return one compact response for a screen; the web BFF can return richer data.

**Cost:** duplicated aggregation logic across BFFs, and more services to run. Worth it when client needs genuinely diverge; unnecessary overhead when they don't.

## Service-to-service communication

**Synchronous (request/response).** Simple, immediately consistent, easy to debug — and it couples availability. Every synchronous dependency multiplies into your availability calculation (see [Availability](../01-fundamentals/availability-slas.html)). Use when the caller genuinely needs the result to respond.

**Asynchronous (events).** The caller publishes and moves on. Services are decoupled in both time and availability — the consumer can be down without breaking the producer. Costs eventual consistency and harder debugging. Use for side effects, notifications, and fanout. See [Message Queues](message-queues.html).

**The practical rule:** synchronous for queries the user is waiting on, asynchronous for everything triggered *by* an action but not required to complete it. Placing an order: synchronously reserve inventory and charge the card; asynchronously send the email, update analytics, notify the warehouse, and recompute recommendations.

## Essentials for any service call

Every remote call should have all four. Naming them unprompted is a strong signal:

1. **Timeout**, with [deadline propagation](../01-fundamentals/failure-modes.html) down the chain.
2. **Retry** with exponential backoff **and jitter**, at exactly one layer, with a budget.
3. **Circuit breaker** so a failing dependency stops consuming your resources.
4. **Idempotency key** for anything that mutates state — because retries mean duplicates.

Plus, at the fleet level: **service discovery** (services register in a registry — Consul, etcd, Kubernetes DNS — rather than hardcoding addresses, since instances come and go constantly).

## Service mesh

Rather than every service implementing retries, mTLS, circuit breaking, and tracing in its own language, a **sidecar proxy** (Envoy, via Istio/Linkerd) is deployed alongside each service and intercepts all traffic.

```diagram
   ┌──────────────────┐        ┌──────────────────┐
   │ Service A │ proxy│◄──────►│ proxy │ Service B│
   └──────────────────┘  mTLS  └──────────────────┘
              ▲                          ▲
              └──── control plane ───────┘
                 (policy, certs, config)
```

**Gains:** consistent behavior across polyglot services, mTLS everywhere without code changes, fine-grained traffic control (canaries, fault injection, retries) configured centrally, and uniform observability.

**Costs:** a proxy hop on every call (~1 ms), significant memory per pod, and a genuinely complex control plane to operate. For a handful of services this is a bad trade — libraries are simpler. It pays off at dozens-to-hundreds of services, especially across multiple languages.

The mature interview position: "A mesh solves real problems, but it's a large operational commitment. Below ~20 services I'd use a shared client library; above that, and especially with multiple languages, the mesh earns its cost."

## API design details that get noticed

- **Versioning** — `/v1/` in the path is blunt and clear; header-based versioning is cleaner and harder to debug. Whichever you pick, have a deprecation policy.
- **Pagination** — use **cursors**, not offsets. `OFFSET 10000` forces the database to scan and discard 10,000 rows, and results shift under concurrent inserts. A cursor (`after=<opaque_token>`) is O(1) and stable.
- **Idempotency keys** on all mutating endpoints — the client generates a UUID, the server stores the result and returns the same response on retry.
- **Consistent errors** — a machine-readable code plus a human message, and *never* leak internals in messages.
- **Field filtering / partial responses** — cheap way to get much of GraphQL's benefit in REST.
- **Never trust the client.** Validate everything server-side, including things the UI already validated.

:::exercise Decide what belongs at the edge
1. Auth, rate limiting, retries, circuit breaking, request transformation, response caching, service discovery, and observability. For each, argue whether it belongs in the gateway, in a service mesh sidecar, or in the service itself.
2. Your gateway adds 4 ms p50 and 60 ms p99. Where does the p99 come from, and is it acceptable?
3. A downstream service degrades to 8-second responses. Trace what happens to the gateway's connection pool, then design the protection.
4. Deadline propagation: a request arrives with a 500 ms budget and the gateway has already spent 80 ms. What does it pass downstream, and what does the downstream do when the budget is exhausted?
5. The gateway is now a single point of failure for everything. Enumerate the failure modes and the mitigation for each.
:::

:::paper Edge architecture
Netflix's engineering posts on Zuul — particularly the move from blocking to non-blocking and the adaptive concurrency limit work — are the best public material on gateway design under load.

The Envoy documentation on circuit breaking, outlier detection, and rate limiting is effectively a reference manual for what a gateway should do. For the underlying control theory, Netflix's `concurrency-limits` library and its README explain the Little's-Law-derived adaptive limiter.
:::

## Check yourself

```recall
Q: What belongs in an API gateway, and what doesn't?
A: Cross-cutting concerns: TLS, authentication, rate limiting, routing, protocol translation, aggregation, observability. Not business logic — that turns it into a "smart pipe" where every feature needs a gateway deploy.

Q: How do you keep the gateway from amplifying a backend failure?
A: Short timeouts, a circuit breaker per backend, and a separate connection pool per backend (a bulkhead) so one slow service can't tie up every gateway thread.

Q: Why "REST at the edge, gRPC inside"?
A: REST is universal, cacheable and debuggable — right for public APIs. gRPC has compact binary payloads, strict generated schemas and streaming over HTTP/2 — right for internal calls, though it needs L7 balancing.

Q: What does GraphQL fix, and what three hazards come with it?
A: It lets a client fetch exactly the shape it needs in one call. Hazards: HTTP caching doesn't apply, nested queries cause N+1 database calls without batching, and arbitrary query cost needs depth and complexity limits.

Q: What is the Backend-for-Frontend pattern?
A: A thin aggregation layer per client type — mobile, web, partners — owned by that client's team, shaping data for its screens. Worth it when client needs genuinely differ.

Q: Synchronous call or event: what's the practical rule?
A: Synchronous for what the user is waiting on (reserve stock, charge the card); events for side effects triggered by the action but not needed to finish it (email, analytics, warehouse).

Q: Name the four essentials every remote call needs.
A: A timeout with deadline propagation; retries with backoff and jitter at one layer, within a budget; a circuit breaker; and an idempotency key for anything that changes state.

Q: Why use cursors instead of offsets for pagination?
A: OFFSET 10000 makes the database scan and discard 10,000 rows, and results shift under concurrent inserts. A cursor resumes from a position: constant cost and stable.
```

## What to carry forward

- A gateway centralises cross-cutting edge concerns — and must stay free of business logic.
- Protect the gateway with timeouts, per-backend breakers and bulkheads; replicate it.
- REST for public APIs, gRPC inside, GraphQL for client-driven aggregation — with its caching, N+1 and cost hazards.
- Call synchronously only for what the user waits on; publish events for side effects.
- Every call needs a timeout, budgeted jittered retries, a breaker and idempotency; a service mesh earns its cost at dozens of services.
