---
title: Load Balancing
summary: L4 vs L7, the algorithms and when each actually matters, health checking, and why the load balancer itself isn't a single point of failure.
difficulty: Easy
scope: HLD
tags: [load-balancer, traffic, L4, L7]
prereqs: [scalability-basics, networking]
---

:::predict Guess first
1. A gRPC client opens one connection and sends thousands of requests down it. What happens if a layer-4 load balancer sits in front of your servers?
2. Every health check pings the shared database. The database hiccups for ten seconds. What does the load balancer do?
3. If the load balancer is in front of everything, what keeps it from being a single point of failure?
:::

## What it buys you

A load balancer sits between clients and a pool of servers and distributes requests. It gives you four things at once:

1. **Horizontal scale** — the pool can grow without clients knowing.
2. **Availability** — unhealthy servers are removed from rotation automatically.
3. **Zero-downtime deploys** — drain a server, update it, return it.
4. **A control point** — one place to handle HTTPS (**TLS termination**: the load balancer decrypts, so your servers deal in plain HTTP), cap abusive traffic, route requests, and watch what's happening.

It is the first component in nearly every design, and it is routinely drawn without anyone examining what it actually does. The interesting parts are below.

## L4 vs L7

The most important distinction, and a very common interview question. The numbers come from the network layer model: layer 4 is where connections live, layer 7 is where the actual HTTP request lives.

**Layer 4 (transport)** just forwards connections. It can see which machine and port the traffic is going to, but not what's inside it — it has no idea whether you asked for `/login` or `/checkout`. It picks a server when the connection opens, and everything on that connection goes to the same place.

**Layer 7 (application)** opens the envelope. It terminates the connection, reads the HTTP request, and can route on the URL path, a header, or a cookie — then makes its own separate connection to the chosen server.

| | L4 | L7 |
|---|---|---|
| Sees | IP, port | Full HTTP request |
| Routing on | Connection tuple | Path, host, header, cookie |
| TLS | Passthrough (or termination) | Terminates (required to read content) |
| Throughput | Very high, low CPU | Lower, more CPU |
| Latency added | ~µs | ~ms |
| Retries failed requests | No (connection-level) | Yes (request-level) |
| Examples | AWS NLB, IPVS, Maglev | AWS ALB, Nginx, Envoy, HAProxy |

**When L4 is right:** non-HTTP protocols, extreme throughput, when you need TLS to terminate at the application, or when you want the LB to be as dumb and fast as possible.

**When L7 is right:** almost all web traffic. You get path-based routing (`/api/*` → API fleet, `/static/*` → asset fleet), per-request load balancing (crucial with HTTP/2, see below), request-level retries, canary routing by header, and centralized TLS.

:::trap HTTP/2 breaks L4 balancing
With HTTP/1.1, many connections meant an L4 balancer spread load reasonably. With HTTP/2 and gRPC, a client opens **one long-lived connection** and multiplexes thousands of requests over it. An L4 balancer assigns that connection once — so all those requests hit one backend, and load becomes wildly uneven. This is a classic real-world gotcha: you need L7 (or a client-side/mesh balancer) to balance gRPC properly. Mentioning it is a strong depth signal.
:::

## Algorithms

These are easy to list; the useful part is knowing when the choice matters. The honest answer: **if your servers are identical and every request costs about the same, round robin is fine and the choice barely matters.** The algorithms earn their keep when one of those two assumptions breaks.

**Round robin** — rotate through servers. Simple, no state. Breaks when request costs vary widely (one request takes 5 ms, another takes 5 s) or servers are heterogeneous.

**Weighted round robin** — the same, but bigger servers get proportionally more. Use it when your machines aren't all the same size, or to move traffic gradually onto a new version (a **canary** — a small slice of real traffic sent to the new build first, so a bad release hurts 1% of users instead of everyone).

**Least connections** — send to the server with fewest active connections. Naturally adapts to varying request duration; a server stuck on slow requests stops receiving new ones. Good default for variable workloads.

**Least response time** — least connections plus measured latency. Best at routing around a degraded ("gray failure") node, since a slow node is penalized automatically.

**Random with two choices (P2C)** — pick two servers at random and send to whichever is less busy. Surprisingly, that tiny amount of choice performs nearly as well as always picking the least busy server, without anyone needing to track the whole fleet. That makes it ideal when the balancing happens inside each client rather than in one central place.

**Hashing (IP hash / consistent hash)** — deterministic mapping from a key to a server. Needed when you have per-server state: a cache tier, a stateful WebSocket session, or sharded in-memory data. Use [consistent hashing](consistent-hashing.html) so adding a server doesn't remap everything.

:::goat The answer that scores
"For the stateless API tier I'd use least-connections — round robin is fine until request cost varies, and here it does. For the cache tier I need consistent hashing, because I want the same key to land on the same node so the cache is actually useful. Different tiers, different algorithms, for different reasons."
:::

## Health checks

The mechanism that turns a load balancer into an availability tool.

**Passive** — observe real traffic; eject a backend after N consecutive failures. Free, but only detects problems by failing user requests first.

**Active** — poll `/health` on an interval. Detects failure before users do; costs a little traffic.

Use both. Active for detection, passive for the failures active checks miss.

**Design your health endpoint carefully — this is where people get burned:**

- A **shallow** check (`return 200`) can't detect a broken process. It'll happily keep a node in rotation while it serves garbage.
- A **deep** check (verify DB, cache, downstream) detects real problems — but if the *shared* database hiccups, every node fails its check simultaneously and the LB removes your **entire fleet**. You've converted a degraded dependency into a total outage.

The standard resolution: deep checks that distinguish *my* problems from *shared* problems, plus a **minimum healthy threshold** — "never eject more than 50% of the pool." If everything looks unhealthy, the failure is probably in the checker, so keep serving.

Related: **connection draining.** On removal, stop sending *new* requests but let in-flight ones finish (typically 30 s). Without it, every deploy drops live requests.

## Who balances the balancer?

The obvious question, and the one the design has to answer.

A single LB instance is a single point of failure. Layered answers, in increasing sophistication:

1. **Active–passive pair with a floating IP.** Two instances, one virtual IP; on failure the standby claims the VIP (VRRP). Simple, wastes half your capacity, failover takes seconds.

2. **DNS round robin to multiple LBs.** Publish several A records. Free horizontal scale, but DNS caching means failover is slow (clients honor TTLs, sometimes badly) — DNS is a poor failure-detection mechanism.

3. **Anycast.** Announce the *same* IP address from many locations at once, and let the internet's own routing send each user to the nearest one. Failure removal is a route withdrawal — fast, and it happens in the network rather than in DNS. This is how large CDNs and Google/Cloudflare-scale load balancing actually work.

4. **ECMP + stateless L4 tier.** A router hashes flows across many identical L4 balancers, which forward to L7 balancers, which forward to servers. The L4 tier is stateless and horizontally scalable; losing one just rehashes its flows.

The complete answer: the load balancer is redundant via an active-passive pair with a floating IP, and at higher scale you move to anycast so failover happens in the routing layer rather than in DNS.

## Global load balancing

Distributing across *regions*, not servers. Three mechanisms:

- **GeoDNS** — resolve to the nearest region's IP based on resolver location. Cheap, universally supported, but coarse (it knows the resolver, not the user) and slow to fail over due to caching.
- **Anycast** — one IP everywhere, BGP picks. Fast failover, no DNS TTL problem. Harder to control precisely; long-lived TCP connections can break if routes flap mid-connection.
- **Application-level redirect** — a lightweight global endpoint returns the right regional URL. Total control, extra round trip.

You also need **health-aware routing** and **failover policy**: if `us-east` is down, does `us-west` have the capacity to absorb its traffic? If both regions run at 70%, the answer is no — the failover itself causes the second outage. Sizing for failover capacity (running each region at ≤50% if you want single-region failure tolerance) is the kind of detail that reads as operational experience.

## What else lives here

Because it's on every request path, the load balancer accumulates responsibilities:

- **TLS termination** — one place to manage certs; backends speak plain HTTP inside the trust boundary (or mTLS if you're doing zero-trust).
- **[Rate limiting](rate-limiting.html)** — cheapest place to shed abusive traffic, before it costs you anything.
- **Request routing** — path/host based, plus canary and blue-green by weight or header.
- **Compression, caching, request/response rewriting.**
- **Observability** — a single consistent source of latency, status codes, and traffic metrics.

When it does all of this and fronts many services, we usually call it an [API gateway](api-gateway.html) — same box, more responsibilities.

:::exercise Choose a balancing policy
1. Round robin, least connections, and power-of-two-choices. For each, describe a traffic pattern where it performs badly.
2. Your backends have p50 = 5 ms and p99 = 400 ms, and utilisation is 75%. Which policy do you expect to help most, and by roughly how much? Justify from the queueing curve.
3. Sticky sessions improve cache hit rate and worsen balance. Compute the crossover for a case where a cache hit saves 80 ms and imbalance costs 15 ms of queue wait.
4. A backend is up but responding in 12 seconds. What does each policy do? Which one makes it worse, and what mechanism fixes it?
:::

:::paper Balancing algorithms, measured
*The Power of Two Choices in Randomized Load Balancing* (Mitzenmacher, 1996) is the result behind least-of-two-random-choices: sampling two backends and picking the less loaded gives almost all the benefit of full least-connections at a fraction of the coordination.

*Maglev: A Fast and Reliable Software Network Load Balancer* (Eisenbud et al., NSDI 2016) is Google's L4 balancer and the source of Maglev hashing. For the queueing argument, see [queueing theory](../01-foundations/queueing-theory.html).
:::

## Check yourself

```recall
Q: Layer 4 versus layer 7 load balancing: what can each see and do?
A: L4 forwards connections and sees only IPs and ports — fast and cheap, one server per connection. L7 terminates the connection and reads the HTTP request, so it can route by path, header or cookie, retry individual requests and do canaries.

Q: Why does HTTP/2 or gRPC break layer-4 balancing?
A: The client multiplexes thousands of requests over one long-lived connection, which an L4 balancer assigns to a single backend once. You need L7 or client-side balancing to spread the requests.

Q: When does the balancing algorithm actually matter?
A: When servers differ in size or request costs vary widely. With identical servers and similar requests, round robin is fine; otherwise least connections, least response time or power-of-two-choices adapt to slow requests and slow nodes.

Q: Why does picking the less busy of two random servers work so well?
A: A tiny amount of choice gives nearly all the benefit of always picking the least loaded server, with no need to track the whole fleet — ideal when each client balances for itself.

Q: Shallow versus deep health checks: what's the risk of each, and the standard fix?
A: Shallow checks keep a broken process in rotation; deep checks that test a shared database can fail every node at once and empty the pool. Separate "my" failures from shared ones and never eject more than about half the pool.

Q: What is connection draining?
A: When a server is removed, stop sending it new requests but let in-flight ones finish (often about 30 s), so deploys don't drop live requests.

Q: Who balances the balancer? Name the escalating answers.
A: An active–passive pair sharing a floating IP; DNS round robin across several balancers (slow failover); anycast, where many sites announce one IP and routing picks the nearest; a stateless L4 tier behind router hashing (ECMP).

Q: Two regions each run at 70%. Can one absorb the other's traffic if it fails?
A: No — it would need 140% and the failover would cause a second outage. For single-region failure tolerance, run each region at 50% or less.
```

## What to carry forward

- A load balancer buys scale, availability, zero-downtime deploys and one control point for TLS, limits and routing.
- L4 is fast and blind; L7 reads requests — and is required to balance HTTP/2 and gRPC properly.
- The algorithm matters only when requests or servers vary; hashing is for tiers with per-server state.
- Health checks must separate a node's own failures from shared ones, with a floor on how many nodes can be ejected.
- Make the balancer itself redundant — floating IP, then anycast — and size regions to absorb each other's traffic.
